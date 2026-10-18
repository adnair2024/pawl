"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.expressRoutes = void 0;
exports.factsForFile = factsForFile;
exports.controlsFromFacts = controlsFromFacts;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const files_1 = require("../files");
const jsGuards_1 = require("./jsGuards");
const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete", "all", "head", "options"]);
/** Middleware names that exist to refuse unauthenticated or unauthorised requests. */
const MIDDLEWARE_GUARD = /(auth|session|login|admin|permission|guard|protect|role|token|jwt|passport|acl)/i;
/** Middleware that looks like a guard by name but only loads a session, it does not refuse anyone. */
const NOT_A_GUARD = /^(session|cookieSession|expressSession|cookieParser|passport\.initialize|passport\.session)$/;
const COMMON_RECEIVERS = ["app", "router", "api", "routes"];
const REQ_IDENTITY = /\breq(?:uest)?\.(user|session|auth|isAuthenticated|token)\b|\bres\.locals\.(user|session)\b/;
const REQ_CREDENTIAL = /\breq\.(headers|cookies)\b|\breq\.get\(\s*['"]authorization['"]/i;
const EXT = ["", ".ts", ".js", ".mjs", ".cjs", ".tsx", ".jsx", "/index.ts", "/index.js", "/index.mjs", "/index.cjs"];
const stripQuotes = (t) => t.replace(/^[`'"]|[`'"]$/g, "");
const isStringLike = (n) => ["string", "template_string"].includes(String(n.kind()));
const argsOf = (call) => call.field("arguments")?.children().filter((c) => c.isNamed() && c.kind() !== "comment") ?? [];
/** The guard a middleware argument stands for, or null if it is not an auth guard. */
function guardOf(arg) {
    const kind = arg.kind();
    if (kind === "identifier" || kind === "member_expression") {
        const t = arg.text();
        return MIDDLEWARE_GUARD.test(t) && !NOT_A_GUARD.test(t) ? (0, jsGuards_1.normalizeCallee)(t) : null;
    }
    if (kind === "call_expression") {
        const callee = arg.field("function")?.text() ?? "";
        if (!MIDDLEWARE_GUARD.test(callee) || NOT_A_GUARD.test(callee))
            return null;
        const first = argsOf(arg)[0];
        const name = (0, jsGuards_1.normalizeCallee)(callee);
        return first && isStringLike(first) ? `${name}(${stripQuotes(first.text())})` : name;
    }
    return null;
}
const guardsOfArgs = (args) => args.flatMap((a) => (a.kind() === "array" ? a.children().filter((c) => c.isNamed()) : [a])).flatMap((a) => guardOf(a) ?? []);
/** The first function body reachable from a handler argument (unwraps `asyncHandler(async () => ...)`). */
function bodyOf(arg, named) {
    let cur = arg ? (0, jsGuards_1.unwrapAwait)(arg) : null;
    for (let depth = 0; cur && depth < 4; depth++) {
        if ((0, jsGuards_1.isFn)(cur))
            return cur.field("body");
        if (cur.kind() === "identifier")
            return named.get(cur.text()) ?? null;
        if (cur.kind() === "call_expression")
            cur = argsOf(cur).find((a) => (0, jsGuards_1.isFn)(a) || a.kind() === "call_expression" || a.kind() === "identifier");
        else
            return null;
    }
    return null;
}
/** `if (!req.user) return res.status(401)...` and `const t = req.headers.authorization; if (!t) ...` */
function reqGuards(body) {
    const stmts = body.children().filter((c) => c.isNamed() && c.kind() !== "comment");
    const out = [];
    const credentialVars = [];
    for (const stmt of stmts) {
        if (stmt.kind() === "return_statement")
            break;
        if (stmt.kind() === "lexical_declaration") {
            const d = stmt.children().find((c) => c.kind() === "variable_declarator");
            if (d && REQ_CREDENTIAL.test(d.field("value")?.text() ?? ""))
                credentialVars.push(...(0, jsGuards_1.boundNames)(d.field("name")));
            continue;
        }
        if (stmt.kind() !== "if_statement")
            continue;
        const cond = stmt.field("condition");
        const branch = stmt.field("consequence");
        if (!cond || !branch || !(0, jsGuards_1.denies)(branch))
            continue;
        const m = REQ_IDENTITY.exec(cond.text());
        if (m)
            out.push(`inline:req.${m[1] ?? m[2]}`);
        else if (credentialVars.length && (0, jsGuards_1.checksAndDenies)(stmt, credentialVars))
            out.push("inline:credentials");
    }
    return out.filter((g, i) => out.indexOf(g) === i);
}
function importsOf(root) {
    const map = new Map();
    for (const imp of root.findAll({ rule: { kind: "import_statement" } })) {
        const spec = stripQuotes(imp.field("source")?.text() ?? "");
        if (!spec.startsWith("."))
            continue;
        const clause = imp.children().find((c) => c.kind() === "import_clause");
        for (const id of clause?.findAll({ rule: { kind: "identifier" } }) ?? [])
            map.set(id.text(), spec);
        const lone = clause?.children().find((c) => c.kind() === "identifier");
        if (lone)
            map.set(lone.text(), spec);
    }
    for (const d of root.findAll({ rule: { kind: "variable_declarator" } })) {
        const call = d.field("value")?.find({ rule: { kind: "call_expression" } });
        const callee = call?.field("function")?.text();
        const spec = call && callee === "require" ? stripQuotes(argsOf(call)[0]?.text() ?? "") : "";
        if (spec.startsWith("."))
            for (const n of (0, jsGuards_1.boundNames)(d.field("name")))
                map.set(n, spec);
    }
    return map;
}
function resolveSpec(fromFile, spec, known) {
    const base = node_path_1.posix.normalize(node_path_1.posix.join((0, node_path_1.dirname)(fromFile), spec));
    return EXT.map((e) => base + e).find((c) => known.has(c)) ?? null;
}
function routerVars(root) {
    const names = new Set(COMMON_RECEIVERS);
    for (const d of root.findAll({ rule: { kind: "variable_declarator" } })) {
        const v = (0, jsGuards_1.unwrapAwait)(d.field("value"));
        const callee = v?.kind() === "call_expression" ? v.field("function")?.text() : undefined;
        if (callee && /^(express|express\.Router|Router)$/.test(callee))
            for (const n of (0, jsGuards_1.boundNames)(d.field("name")))
                names.add(n);
    }
    return names;
}
function namedFunctions(root) {
    const map = new Map();
    for (const f of root.findAll({ rule: { kind: "function_declaration" } })) {
        const name = f.field("name")?.text();
        const body = f.field("body");
        if (name && body)
            map.set(name, body);
    }
    for (const d of root.findAll({ rule: { kind: "variable_declarator" } })) {
        const v = d.field("value");
        const name = d.field("name");
        if (v && name?.kind() === "identifier" && (0, jsGuards_1.isFn)(v) && v.field("body"))
            map.set(name.text(), v.field("body"));
    }
    return map;
}
/** Everything one file says about routes, router-wide guards, and where routers are mounted. */
function factsForFile(file, source) {
    const parsed = (0, jsGuards_1.parseJs)(file, source);
    if ("error" in parsed)
        return parsed;
    const { root, lang } = parsed;
    const receivers = routerVars(root);
    const imports = importsOf(root);
    const named = namedFunctions(root);
    const facts = { file, lang, routes: [], uses: [], mounts: [] };
    for (const call of root.findAll({ rule: { kind: "call_expression" } })) {
        const fn = call.field("function");
        if (!fn || fn.kind() !== "member_expression")
            continue;
        const method = fn.field("property")?.text() ?? "";
        const obj = fn.field("object");
        if (!obj)
            continue;
        const args = argsOf(call);
        const pos = call.range().start.index;
        if (method === "use" && obj.kind() === "identifier" && receivers.has(obj.text())) {
            const prefix = args[0] && isStringLike(args[0]) ? stripQuotes(args[0].text()) : null;
            const rest = prefix === null ? args : args.slice(1);
            const last = rest[rest.length - 1];
            let spec = null;
            let targetReceiver = null;
            if (last?.kind() === "identifier" && receivers.has(last.text()) && !COMMON_RECEIVERS.includes(last.text()))
                targetReceiver = last.text();
            else if (last?.kind() === "identifier" && imports.has(last.text()))
                spec = imports.get(last.text()) ?? null;
            else if (last?.kind() === "call_expression" && last.field("function")?.text() === "require") {
                const s = stripQuotes(argsOf(last)[0]?.text() ?? "");
                spec = s.startsWith(".") ? s : null;
            }
            if (targetReceiver || spec) {
                facts.mounts.push({
                    pos, receiver: obj.text(), prefix, guards: guardsOfArgs(rest.slice(0, -1)), file,
                    targetFile: targetReceiver ? file : null, targetReceiver, spec,
                    fallback: guardsOfArgs(rest),
                });
            }
            else {
                const guards = guardsOfArgs(rest);
                if (guards.length)
                    facts.uses.push({ pos, receiver: obj.text(), prefix, guards });
            }
            continue;
        }
        if (!ROUTE_METHODS.has(method))
            continue;
        let receiver = null;
        let path = null;
        let handlers = args;
        if (obj.kind() === "identifier" && receivers.has(obj.text())) {
            // `app.get("env")` with a single argument is Express's settings getter, not a route.
            if (args.length < 2 || !args[0])
                continue;
            receiver = obj.text();
            path = isStringLike(args[0]) ? stripQuotes(args[0].text()) : args[0].text();
            handlers = args.slice(1);
        }
        else {
            // app.route("/x").get(a).post(b)
            let cur = obj;
            while (cur && cur.kind() === "call_expression" && cur.field("function")?.kind() === "member_expression") {
                const f = cur.field("function");
                const m = f.field("property")?.text() ?? "";
                const o = f.field("object");
                if (m === "route" && o?.kind() === "identifier" && receivers.has(o.text())) {
                    const p = argsOf(cur)[0];
                    receiver = o.text();
                    path = p ? (isStringLike(p) ? stripQuotes(p.text()) : p.text()) : "";
                    break;
                }
                if (!ROUTE_METHODS.has(m))
                    break;
                cur = o;
            }
        }
        if (receiver === null || path === null || handlers.length === 0)
            continue;
        const handler = handlers[handlers.length - 1];
        const own = guardsOfArgs(handlers.slice(0, -1));
        const body = bodyOf(handler, named);
        if (body)
            own.push(...(0, jsGuards_1.guardsInBody)(body), ...reqGuards(body));
        facts.routes.push({ pos, receiver, method: method.toUpperCase(), path, own });
    }
    return facts;
}
const prefixCovers = (prefix, path) => !prefix || prefix === "/" || !path.startsWith("/") || path.startsWith(prefix);
/** Combine per-file facts into one control per route, with guards inherited through mounts. */
function controlsFromFacts(all) {
    const byFile = new Map(all.map((f) => [f.file, f]));
    const known = new Set(byFile.keys());
    const mountTarget = (m) => (m.spec && !m.targetReceiver ? resolveSpec(m.file, m.spec, known) : m.targetFile);
    // `use(x)` is a mount only if x is a local router or a file that defines routes; otherwise x is middleware.
    const isMount = (m) => m.targetReceiver !== null || (byFile.get(mountTarget(m) ?? "")?.routes.length ?? 0) > 0;
    const mounts = all.flatMap((f) => f.mounts).filter(isMount).map((m) => ({ ...m, targetFile: mountTarget(m) }));
    const usesByFile = new Map(all.map((f) => [
        f.file,
        [...f.uses, ...f.mounts.filter((m) => !isMount(m) && m.fallback.length).map((m) => ({ pos: m.pos, receiver: m.receiver, prefix: m.prefix, guards: m.fallback }))],
    ]));
    const activeUses = (file, receiver, pos, path) => (usesByFile.get(file) ?? []).filter((u) => u.receiver === receiver && u.pos < pos && prefixCovers(u.prefix, path)).flatMap((u) => u.guards);
    const inherited = (file, receiver, path, seen) => {
        const key = `${file}::${receiver}`;
        if (seen.has(key))
            return [];
        const incoming = mounts.filter((m) => m.targetFile === file && (m.targetReceiver === null || m.targetReceiver === receiver));
        if (incoming.length === 0)
            return [];
        // A router mounted twice is only protected if every mount protects it.
        const perMount = incoming.map((m) => [
            ...m.guards,
            ...activeUses(m.file, m.receiver, m.pos, m.prefix ?? path),
            ...inherited(m.file, m.receiver, m.prefix ?? path, new Set([...seen, key])),
        ]);
        return (perMount[0] ?? []).filter((g) => perMount.every((p) => p.includes(g)));
    };
    const controls = [];
    for (const f of all) {
        const used = new Map();
        for (const r of f.routes) {
            const guards = [...inherited(f.file, r.receiver, r.path, new Set()), ...activeUses(f.file, r.receiver, r.pos, r.path), ...r.own];
            const base = `${f.file}#${r.method} ${r.path}`;
            const n = (used.get(base) ?? 0) + 1;
            used.set(base, n);
            controls.push({
                kind: "route-auth",
                id: n === 1 ? base : `${base} #${n}`,
                file: f.file,
                lang: f.lang,
                framework: "express",
                guards: guards.filter((g, i) => guards.indexOf(g) === i),
            });
        }
    }
    return controls;
}
const mentionsExpress = (root, file) => {
    try {
        return (0, node_fs_1.readFileSync)((0, node_path_1.join)(root, file), "utf8").includes("express");
    }
    catch {
        return false;
    }
};
/** Parsed results survive between hook runs, so an edit only re-parses the files that changed. */
const cachePath = (root) => (0, node_path_1.join)((0, node_os_1.tmpdir)(), `pawl-express-${(0, node_crypto_1.createHash)("sha1").update(root).digest("hex").slice(0, 12)}.json`);
function loadCache(root) {
    try {
        return JSON.parse((0, node_fs_1.readFileSync)(cachePath(root), "utf8"));
    }
    catch {
        return {};
    }
}
exports.expressRoutes = {
    name: "express-routes",
    handles: (p) => CODE_FILE.test(p),
    expand(root, files) {
        // Mounting lives in a different file from the routes, so any Express edit re-reads them all.
        if (!files.some((f) => CODE_FILE.test(f) && mentionsExpress(root, f)))
            return files;
        const all = (0, files_1.listFiles)(root).filter((f) => CODE_FILE.test(f) && mentionsExpress(root, f));
        return [...new Set([...files, ...all])];
    },
    async scan(root, files) {
        const cache = loadCache(root);
        const next = {};
        const result = { controls: [], unparsed: [] };
        const facts = [];
        for (const f of files.filter((p) => CODE_FILE.test(p))) {
            let st;
            let source;
            try {
                st = (0, node_fs_1.statSync)((0, node_path_1.join)(root, f));
                source = (0, node_fs_1.readFileSync)((0, node_path_1.join)(root, f), "utf8");
            }
            catch {
                continue;
            }
            if (!source.includes("express"))
                continue;
            const hit = cache[f];
            const entry = hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size ? hit : { mtimeMs: st.mtimeMs, size: st.size, facts: factsForFile(f, source) };
            next[f] = entry;
            if ("error" in entry.facts)
                result.unparsed.push({ file: f, reason: entry.facts.error });
            else
                facts.push(entry.facts);
        }
        result.controls = controlsFromFacts(facts);
        try {
            (0, node_fs_1.writeFileSync)(cachePath(root), JSON.stringify({ ...cache, ...next }));
        }
        catch {
            /* cache is an optimisation only */
        }
        return result;
    },
};
