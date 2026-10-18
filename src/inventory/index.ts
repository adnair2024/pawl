import type { Inventorier, Inventory } from "../types";

/**
 * Readers are loaded on first use. Every hook starts a fresh process, and each reader pulls in
 * a parser, so loading only the readers whose files were touched keeps hooks fast.
 * `handles` is duplicated here on purpose (it must not load the reader); a test keeps the
 * copies honest.
 */
function lazy(name: string, handles: (p: string) => boolean, load: () => Promise<Inventorier>): Inventorier {
  let real: Promise<Inventorier> | undefined;
  const get = (): Promise<Inventorier> => (real ??= load());
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
function load<M>(sync: () => M, esm: () => Promise<M>): Promise<M> {
  try {
    return Promise.resolve(sync());
  } catch {
    return esm();
  }
}

const JS = /\.(ts|tsx|js|jsx|mjs)$/;
const JS_AND_CJS = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const PY = /\.py$/;

export const inventoriers: Inventorier[] = [
  lazy("next-routes", (p) => JS.test(p), () => load(() => require("./nextRoutes") as typeof import("./nextRoutes"), () => import("./nextRoutes.js")).then((m) => m.nextRoutes)),
  lazy("express-routes", (p) => JS_AND_CJS.test(p), () => load(() => require("./expressRoutes") as typeof import("./expressRoutes"), () => import("./expressRoutes.js")).then((m) => m.expressRoutes)),
  lazy("fastapi-routes", (p) => PY.test(p), () => load(() => require("./fastapiRoutes") as typeof import("./fastapiRoutes"), () => import("./fastapiRoutes.js")).then((m) => m.fastapiRoutes)),
  lazy("flask-routes", (p) => PY.test(p), () => load(() => require("./flaskRoutes") as typeof import("./flaskRoutes"), () => import("./flaskRoutes.js")).then((m) => m.flaskRoutes)),
  lazy("django-views", (p) => PY.test(p), () => load(() => require("./djangoRoutes") as typeof import("./djangoRoutes"), () => import("./djangoRoutes.js")).then((m) => m.djangoRoutes)),
  lazy("supabase-rls", (p) => /(^|\/)supabase\/migrations\/.*\.sql$/.test(p), () => load(() => require("./supabaseRls") as typeof import("./supabaseRls"), () => import("./supabaseRls.js")).then((m) => m.supabaseRls)),
  lazy("js-headers", (p) => (JS_AND_CJS.test(p) || /(^|\/)(vercel\.json|_headers)$/.test(p)) && !isTestPath(p), () => load(() => require("./jsHeaders") as typeof import("./jsHeaders"), () => import("./jsHeaders.js")).then((m) => m.jsHeaders)),
  lazy("py-headers", (p) => PY.test(p) && !isTestPath(p), () => load(() => require("./pyHeaders") as typeof import("./pyHeaders"), () => import("./pyHeaders.js")).then((m) => m.pyHeaders)),
  lazy("next-middleware", (p) => JS.test(p), () => load(() => require("./nextMiddleware") as typeof import("./nextMiddleware"), () => import("./nextMiddleware.js")).then((m) => m.nextMiddleware)),
];

import { isTestPath } from "../files";

export const isTracked = (relPath: string): boolean => inventoriers.some((i) => i.handles(relPath));

/** Inventory the given files (relative paths) with every inventorier that wants them. */
export async function scanFiles(root: string, files: string[]): Promise<Inventory> {
  const result: Inventory = { controls: [], unparsed: [] };
  for (const inv of inventoriers) {
    const mine = files.filter((f) => inv.handles(f));
    if (mine.length === 0) continue;
    let r: Inventory;
    try {
      r = await inv.scan(root, mine);
    } catch (e) {
      // One reader failing must not hide what the others found. Say so, and keep going.
      (result.partial ??= []).push({ file: `(${inv.name})`, reason: `the ${inv.name} reader crashed and was skipped: ${String(e)}` });
      continue;
    }
    result.controls.push(...r.controls);
    result.unparsed.push(...r.unparsed);
    if (r.partial?.length) result.partial = [...(result.partial ?? []), ...r.partial];
  }
  return result;
}

/** Files to re-inventory when `files` change, including files whose controls depend on them. */
export async function expandFiles(root: string, files: string[]): Promise<string[]> {
  // Only readers that care about a touched file get a say (and only they are loaded).
  let acc = files;
  for (const inv of inventoriers) {
    if (!acc.some((f) => inv.handles(f))) continue;
    try {
      acc = (await inv.expand?.(root, acc)) ?? acc;
    } catch {
      /* a reader that cannot expand just checks the files it was given */
    }
  }
  return acc;
}
