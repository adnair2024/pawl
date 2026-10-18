"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isTracked = exports.inventoriers = void 0;
exports.scanFiles = scanFiles;
exports.expandFiles = expandFiles;
/**
 * Readers are loaded on first use. Every hook starts a fresh process, and each reader pulls in
 * a parser, so loading only the readers whose files were touched keeps hooks fast.
 * `handles` is duplicated here on purpose (it must not load the reader); a test keeps the
 * copies honest.
 */
function lazy(name, handles, load) {
    let real;
    const get = () => (real ??= load());
    return {
        name,
        handles,
        expand: async (root, files) => (await get()).expand?.(root, files) ?? files,
        scan: async (root, files) => (await get()).scan(root, files),
    };
}
/**
 * The compiled build can `require` a reader synchronously, which avoids booting Node's ESM
 * loader (tens of ms per hook). Running from TypeScript source (tests) cannot, so it imports.
 */
function load(sync, esm) {
    try {
        return Promise.resolve(sync());
    }
    catch {
        return esm();
    }
}
const JS = /\.(ts|tsx|js|jsx|mjs)$/;
const JS_AND_CJS = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const PY = /\.py$/;
exports.inventoriers = [
    lazy("next-routes", (p) => JS.test(p), () => load(() => require("./nextRoutes"), () => import("./nextRoutes.js")).then((m) => m.nextRoutes)),
    lazy("express-routes", (p) => JS_AND_CJS.test(p), () => load(() => require("./expressRoutes"), () => import("./expressRoutes.js")).then((m) => m.expressRoutes)),
    lazy("fastapi-routes", (p) => PY.test(p), () => load(() => require("./fastapiRoutes"), () => import("./fastapiRoutes.js")).then((m) => m.fastapiRoutes)),
    lazy("flask-routes", (p) => PY.test(p), () => load(() => require("./flaskRoutes"), () => import("./flaskRoutes.js")).then((m) => m.flaskRoutes)),
    lazy("django-views", (p) => PY.test(p), () => load(() => require("./djangoRoutes"), () => import("./djangoRoutes.js")).then((m) => m.djangoRoutes)),
    lazy("supabase-rls", (p) => /(^|\/)supabase\/migrations\/.*\.sql$/.test(p), () => load(() => require("./supabaseRls"), () => import("./supabaseRls.js")).then((m) => m.supabaseRls)),
    lazy("js-headers", (p) => (JS_AND_CJS.test(p) || /(^|\/)(vercel\.json|_headers)$/.test(p)) && !(0, files_1.isTestPath)(p), () => load(() => require("./jsHeaders"), () => import("./jsHeaders.js")).then((m) => m.jsHeaders)),
    lazy("py-headers", (p) => PY.test(p) && !(0, files_1.isTestPath)(p), () => load(() => require("./pyHeaders"), () => import("./pyHeaders.js")).then((m) => m.pyHeaders)),
    lazy("next-middleware", (p) => JS.test(p), () => load(() => require("./nextMiddleware"), () => import("./nextMiddleware.js")).then((m) => m.nextMiddleware)),
];
const files_1 = require("../files");
const isTracked = (relPath) => exports.inventoriers.some((i) => i.handles(relPath));
exports.isTracked = isTracked;
/** Inventory the given files (relative paths) with every inventorier that wants them. */
async function scanFiles(root, files) {
    const result = { controls: [], unparsed: [] };
    for (const inv of exports.inventoriers) {
        const mine = files.filter((f) => inv.handles(f));
        if (mine.length === 0)
            continue;
        let r;
        try {
            r = await inv.scan(root, mine);
        }
        catch (e) {
            // One reader failing must not hide what the others found. Say so, and keep going.
            (result.partial ??= []).push({ file: `(${inv.name})`, reason: `the ${inv.name} reader crashed and was skipped: ${String(e)}` });
            continue;
        }
        result.controls.push(...r.controls);
        result.unparsed.push(...r.unparsed);
        if (r.partial?.length)
            result.partial = [...(result.partial ?? []), ...r.partial];
    }
    return result;
}
/** Files to re-inventory when `files` change, including files whose controls depend on them. */
async function expandFiles(root, files) {
    // Only readers that care about a touched file get a say (and only they are loaded).
    let acc = files;
    for (const inv of exports.inventoriers) {
        if (!acc.some((f) => inv.handles(f)))
            continue;
        try {
            acc = (await inv.expand?.(root, acc)) ?? acc;
        }
        catch {
            /* a reader that cannot expand just checks the files it was given */
        }
    }
    return acc;
}
