"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fastapiRoutes = void 0;
exports.factsForFile = factsForFile;
exports.controlsFromFacts = controlsFromFacts;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const files_1 = require("../files");
const factsCache_1 = require("./factsCache");
const pyShared_1 = require("./pyShared");
const PY_FILE = /\.py$/;
const HTTP = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);
/** Names that mean "this checks who is calling", for dependencies we cannot read (third-party, class instances). */
const GUARD_NAME = /(auth|current_user|get_user|verify|token|permission|require|role|admin|login|session|api_key|apikey|oauth|bearer|jwt|credential|security|guard|protect)/i;
/** `get_user` -> "get_user"; `require_role("admin")` -> "require_role(admin)"; `auth.get_user` -> "get_user". */
function depLabel(arg) {
    if (!arg)
        return null;
    if (arg.kind() === "identifier")
        return arg.text();
    if (arg.kind() === "attribute")
        return (0, pyShared_1.lastSegment)(arg.text());
    if (arg.kind() === "call") {
        const callee = (0, pyShared_1.lastSegment)(arg.field("function")?.text() ?? "");
        const first = (0, pyShared_1.strOf)((0, pyShared_1.positional)(arg)[0]);
        return callee ? (first ? `${callee}(${first})` : callee) : null;
    }
    return null;
}
/** Every `Depends(x)` / `Security(x)` inside `node`: parameters, Annotated types, dependencies=[...]. */
function dependsIn(node) {
    if (!node)
        return [];
    const out = [];
    for (const c of node.findAll({ rule: { kind: "call" } })) {
        const fn = (0, pyShared_1.lastSegment)(c.field("function")?.text() ?? "");
        if (fn !== "Depends" && fn !== "Security")
            continue;
        const label = depLabel((0, pyShared_1.positional)(c)[0]);
        if (label)
            out.push(label);
    }
    return out;
}
function factsForFile(file, source) {
    const parsed = (0, pyShared_1.parsePy)(source);
    if ("error" in parsed)
        return parsed;
    const { root } = parsed;
    const facts = { file, imports: (0, pyShared_1.importsOf)(root), defs: [], classes: [], weak: [], middleware: [], vars: [], includes: [], routes: [] };
    for (const fn of root.findAll({ rule: { kind: "function_definition" } })) {
        const name = fn.field("name")?.text();
        const body = fn.field("body");
        if (name && body)
            facts.defs.push({ name, denies: (0, pyShared_1.bodyDenies)(body), deps: dependsIn(fn.field("parameters")) });
    }
    for (const c of root.findAll({ rule: { kind: "class_definition" } })) {
        const name = c.field("name")?.text();
        const body = c.field("body");
        if (name && body)
            facts.classes.push({ name, denies: (0, pyShared_1.bodyDenies)(body) });
    }
    for (const a of root.findAll({ rule: { kind: "assignment" } })) {
        const left = a.field("left");
        const right = a.field("right");
        if (left?.kind() !== "identifier" || right?.kind() !== "call")
            continue;
        if ((0, pyShared_1.keyword)(right, "auto_error")?.text() === "False")
            facts.weak.push(left.text());
        if (!/^(FastAPI|APIRouter)$/.test((0, pyShared_1.lastSegment)(right.field("function")?.text() ?? "")))
            continue;
        facts.vars.push({ name: left.text(), deps: dependsIn((0, pyShared_1.keyword)(right, "dependencies")) });
    }
    for (const call of root.findAll({ rule: { kind: "call" } })) {
        const fn = call.field("function");
        const verb = fn?.kind() === "attribute" ? fn.field("attribute")?.text() : undefined;
        const owner = fn?.field("object");
        if (verb === "add_middleware" && owner?.kind() === "identifier") {
            const cls = (0, pyShared_1.lastSegment)((0, pyShared_1.positional)(call)[0]?.text() ?? "");
            if (cls)
                facts.middleware.push({ receiver: owner.text(), label: `middleware:${cls}`, name: cls, denies: null });
            continue;
        }
        if ((verb === "add_api_route" || verb === "add_api_websocket_route") && owner?.kind() === "identifier") {
            const path = (0, pyShared_1.strOf)((0, pyShared_1.positional)(call)[0]);
            const endpoint = (0, pyShared_1.positional)(call)[1];
            const methods = (0, pyShared_1.keyword)(call, "methods")?.find({ rule: { kind: "string" } });
            const def = endpoint?.kind() === "identifier" ? facts.defs.find((d) => d.name === endpoint.text()) : undefined;
            if (path === null)
                continue;
            facts.routes.push({
                receiver: owner.text(),
                method: verb === "add_api_websocket_route" ? "WS" : ((0, pyShared_1.strOf)(methods ?? null) ?? "GET").toUpperCase(),
                path,
                deps: [...dependsIn((0, pyShared_1.keyword)(call, "dependencies")), ...(def?.deps ?? [])],
                inline: [],
            });
            continue;
        }
        if (verb !== "include_router")
            continue;
        const recv = owner;
        const target = (0, pyShared_1.positional)(call)[0];
        if (recv?.kind() !== "identifier" || !target)
            continue;
        const inc = { receiver: recv.text(), deps: dependsIn((0, pyShared_1.keyword)(call, "dependencies")), ident: null, obj: null, attr: null };
        if (target.kind() === "identifier")
            inc.ident = target.text();
        else if (target.kind() === "attribute" && target.field("object")?.kind() === "identifier") {
            inc.obj = target.field("object")?.text() ?? null;
            inc.attr = target.field("attribute")?.text() ?? null;
        }
        else
            continue;
        facts.includes.push(inc);
    }
    for (const dd of root.findAll({ rule: { kind: "decorated_definition" } })) {
        const fn = dd.children().find((c) => c.kind() === "function_definition");
        if (!fn)
            continue;
        for (const dec of dd.children().filter((c) => c.kind() === "decorator")) {
            const call = dec.children().find((c) => c.kind() === "call");
            const callee = call?.field("function");
            if (!call || callee?.kind() !== "attribute" || callee.field("object")?.kind() !== "identifier")
                continue;
            const verb = callee.field("attribute")?.text() ?? "";
            if (verb === "middleware") {
                const body = fn.field("body");
                const name = fn.field("name")?.text();
                if (body && name)
                    facts.middleware.push({ receiver: callee.field("object")?.text() ?? "", label: `middleware:${name}`, name, denies: (0, pyShared_1.bodyDenies)(body) });
                continue;
            }
            if (!HTTP.has(verb) && verb !== "api_route" && verb !== "websocket")
                continue;
            const path = (0, pyShared_1.strOf)((0, pyShared_1.positional)(call)[0]) ?? (0, pyShared_1.strOf)((0, pyShared_1.keyword)(call, "path")) ?? "<dynamic>";
            facts.routes.push({
                receiver: callee.field("object")?.text() ?? "",
                method: verb === "api_route" ? "ANY" : verb === "websocket" ? "WS" : verb.toUpperCase(),
                path,
                deps: [...dependsIn((0, pyShared_1.keyword)(call, "dependencies")), ...dependsIn(fn.field("parameters"))],
                inline: (0, pyShared_1.inlineGuards)(fn.field("body")),
            });
        }
    }
    return facts;
}
function controlsFromFacts(all) {
    const known = new Set(all.map((f) => f.file));
    const byFile = new Map(all.map((f) => [f.file, f]));
    const index = new pyShared_1.DefIndex(all);
    const weak = new Set(all.flatMap((f) => f.weak));
    const classDenies = new Map(all.flatMap((f) => f.classes.map((c) => [c.name, c.denies])));
    const middlewareGuard = new Map();
    for (const f of all)
        for (const m of f.middleware)
            middlewareGuard.set(m.label, m.denies ?? classDenies.get(m.name) ?? GUARD_NAME.test(m.name));
    /** A dependency guards if the project's own definition refuses callers (directly or via its own dependencies). */
    const isGuard = (label, file, depth = 0) => {
        if (label.startsWith("middleware:"))
            return middlewareGuard.get(label) ?? false;
        const base = label.split("(")[0] ?? label;
        if (weak.has(base) || /optional/i.test(base))
            return false;
        const found = index.lookup(base, file);
        if (found.length)
            return depth < 4 && found.every((d) => d.def.denies || d.def.deps.some((x) => isGuard(x, d.file, depth + 1)));
        return GUARD_NAME.test(base);
    };
    const edges = all.flatMap((f) => f.includes.flatMap((inc) => {
        const t = (0, pyShared_1.resolveRef)({ file: f.file, imports: f.imports, varNames: f.vars.map((v) => v.name) }, inc, known);
        return t ? [{ from: f.file, receiver: inc.receiver, deps: inc.deps, to: t }] : [];
    }));
    const ownDeps = (file, name) => [
        ...(byFile.get(file)?.vars.find((v) => v.name === name)?.deps ?? []),
        ...(byFile.get(file)?.middleware.filter((m) => m.receiver === name).map((m) => m.label) ?? []),
    ];
    const inherited = (file, name, seen) => {
        const key = `${file}::${name}`;
        if (seen.has(key))
            return [];
        const incoming = edges.filter((e) => e.to.file === file && e.to.name === name);
        if (incoming.length === 0)
            return [];
        // A router included in two places is only protected if every place protects it.
        const per = incoming.map((e) => [...e.deps.filter((d) => isGuard(d, e.from)), ...ownDeps(e.from, e.receiver).filter((d) => isGuard(d, e.from)), ...inherited(e.from, e.receiver, new Set([...seen, key]))]);
        return (per[0] ?? []).filter((g) => per.every((p) => p.includes(g)));
    };
    const controls = [];
    for (const f of all) {
        const used = new Map();
        for (const r of f.routes) {
            const guards = [
                ...inherited(f.file, r.receiver, new Set()),
                ...ownDeps(f.file, r.receiver).filter((d) => isGuard(d, f.file)),
                ...r.deps.filter((d) => isGuard(d, f.file)),
                ...r.inline,
            ];
            const base = `${f.file}#${r.method} ${r.path}`;
            const n = (used.get(base) ?? 0) + 1;
            used.set(base, n);
            controls.push({
                kind: "route-auth",
                id: n === 1 ? base : `${base} #${n}`,
                file: f.file,
                lang: "py",
                framework: "fastapi",
                guards: guards.filter((g, i) => guards.indexOf(g) === i),
            });
        }
    }
    return controls;
}
const mentionsFastapi = (root, file) => {
    try {
        const src = (0, files_1.readSource)((0, node_path_1.join)(root, file));
        return src.includes("fastapi") || src.includes("starlette");
    }
    catch {
        return false;
    }
};
exports.fastapiRoutes = {
    name: "fastapi-routes",
    handles: (p) => PY_FILE.test(p),
    expand(root, files) {
        // Dependencies and routers live in different files from the routes that use them.
        if (!files.some((f) => PY_FILE.test(f) && mentionsFastapi(root, f)))
            return files;
        return [...new Set([...files, ...(0, files_1.listFiles)(root).filter((f) => PY_FILE.test(f) && mentionsFastapi(root, f))])];
    },
    async scan(root, files) {
        const cache = new factsCache_1.FactsCache("fastapi-2", root);
        const result = { controls: [], unparsed: [] };
        const facts = [];
        for (const f of files.filter((p) => PY_FILE.test(p))) {
            let source;
            let st;
            try {
                st = (0, node_fs_1.statSync)((0, node_path_1.join)(root, f));
                source = (0, files_1.readSource)((0, node_path_1.join)(root, f));
            }
            catch {
                continue;
            }
            if (!source.includes("fastapi") && !source.includes("starlette"))
                continue;
            const entry = cache.get(f, st, () => factsForFile(f, source));
            if ("error" in entry)
                result.unparsed.push({ file: f, reason: entry.error });
            else
                facts.push(entry);
        }
        cache.save();
        result.controls = controlsFromFacts(facts);
        return result;
    },
};
