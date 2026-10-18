"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.nextMiddleware = void 0;
exports.compileMatcher = compileMatcher;
exports.factsForMiddleware = factsForMiddleware;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const files_1 = require("../files");
const expressRoutes_1 = require("./expressRoutes");
const jsGuards_1 = require("./jsGuards");
/** `middleware.ts` (or `proxy.ts` in newer Next.js), at the project root or under src/. */
const MIDDLEWARE_FILE = /^(src\/)?(middleware|proxy)\.(ts|js|mjs)$/;
const PAGE_OR_ROUTE = /^(src\/)?app\/(.*\/)?(page|route)\.(tsx|ts|jsx|js|mjs)$/;
const CODE_FILE = /\.(ts|tsx|js|jsx|mjs)$/;
/** Wrappers that are an auth check all by themselves. `clerkMiddleware` is not: it needs `auth.protect()` inside. */
const WRAPPER_GUARD = /^(auth|withAuth|authMiddleware|NextAuth)$/;
/** Calls whose job is to refuse the request. */
const PROTECT_CALL = /(^|\.)(protect|redirectToSignIn|redirectToLogin)$/;
const HELPER_NAME = /(session|auth|token|login|protect)/i;
const unquote = (t) => t.replace(/^[`'"]|[`'"]$/g, "");
/**
 * Compile a Next.js matcher (path-to-regexp style: `/admin/:path*`, `/((?!api).*)`) to a RegExp.
 * Returns null for anything we cannot read, so the caller can treat it as "unknown", not "safe".
 */
function compileMatcher(pattern) {
    // Patterns come from the repo being checked. Refuse ones that could run for a very long time:
    // very long ones, and nested quantifiers like (a+)+ or (.*)*.
    if (pattern.length > 300 || /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/.test(pattern))
        return null;
    let out = "";
    let i = 0;
    const group = () => {
        // At "(": copy the balanced group verbatim.
        let depth = 0;
        let j = i;
        for (; j < pattern.length; j++) {
            const c = pattern[j];
            if (c === "\\")
                j++;
            else if (c === "(")
                depth++;
            else if (c === ")" && --depth === 0)
                break;
        }
        if (depth !== 0)
            return null;
        const body = pattern.slice(i, j + 1);
        i = j + 1;
        return body;
    };
    while (i < pattern.length) {
        const c = pattern[i] ?? "";
        const slash = c === "/";
        const next = pattern[i + 1];
        // A "/" directly before a parameter or group belongs to it, so modifiers can make both optional.
        if (slash && (next === ":" || next === "(")) {
            i++;
            let core;
            if (pattern[i] === ":") {
                i++;
                while (/\w/.test(pattern[i] ?? ""))
                    i++;
                if (pattern[i] === "(") {
                    const g = group();
                    if (g === null)
                        return null;
                    core = g;
                }
                else
                    core = "([^/]+?)";
            }
            else {
                const g = group();
                if (g === null)
                    return null;
                core = g;
            }
            const mod = /[*+?]/.test(pattern[i] ?? "") ? pattern[i++] : "";
            const seg = `/${core}`;
            out += mod === "*" ? `(?:${seg}(?:/${core})*)?` : mod === "+" ? `${seg}(?:/${core})*` : mod === "?" ? `(?:${seg})?` : seg;
            continue;
        }
        if (c === ":") {
            i++;
            while (/\w/.test(pattern[i] ?? ""))
                i++;
            const mod = /[*+?]/.test(pattern[i] ?? "") ? pattern[i++] : "";
            out += `([^/]+?)${mod}`;
            continue;
        }
        if (c === "(") {
            const g = group();
            if (g === null)
                return null;
            const mod = /[*+?]/.test(pattern[i] ?? "") ? pattern[i++] : "";
            out += g + mod;
            continue;
        }
        if (c === "\\") {
            out += `\\${pattern[i + 1] ?? ""}`;
            i += 2;
            continue;
        }
        out += c.replace(/[.+*?^${}()|[\]\\]/g, "\\$&");
        i++;
    }
    try {
        return new RegExp(`^${out}/?$`, "i");
    }
    catch {
        return null;
    }
}
/** URL path for a page or route file, with a concrete sample for dynamic segments. */
function routeOf(file) {
    const dir = file.replace(/^(src\/)?app\//, "").split("/").slice(0, -1);
    const shown = [];
    const sample = [];
    for (const seg of dir) {
        if (/^\(.*\)$/.test(seg) || seg.startsWith("@"))
            continue; // route groups and parallel slots are not in the URL
        shown.push(seg);
        sample.push(/^\[\[\.\.\./.test(seg) ? "" : /^\[\.\.\./.test(seg) ? "x/y" : /^\[.*\]$/.test(seg) ? "x" : seg);
    }
    return { route: `/${shown.join("/")}`, sample: `/${sample.filter(Boolean).join("/")}` };
}
function matcherOf(root) {
    for (const exp of root.children().filter((c) => c.kind() === "export_statement")) {
        for (const d of exp.findAll({ rule: { kind: "variable_declarator" } })) {
            if (d.field("name")?.text() !== "config")
                continue;
            const obj = d.field("value");
            if (obj?.kind() !== "object")
                return "unknown";
            const pair = obj.children().find((p) => p.kind() === "pair" && unquote(p.field("key")?.text() ?? "") === "matcher");
            const v = pair?.field("value");
            if (!v)
                return "all";
            const patterns = [];
            const take = (n) => {
                if (n.kind() === "string" || (n.kind() === "template_string" && !n.text().includes("${"))) {
                    patterns.push(unquote(n.text()));
                    return true;
                }
                if (n.kind() === "object") {
                    const src = n.children().find((p) => p.kind() === "pair" && unquote(p.field("key")?.text() ?? "") === "source")?.field("value");
                    return !!src && take(src);
                }
                return false;
            };
            if (v.kind() === "array")
                return v.children().filter((c) => c.isNamed()).every(take) ? patterns : "unknown";
            return take(v) ? patterns : "unknown";
        }
    }
    return "all";
}
/** A project helper (e.g. Supabase's updateSession) refuses callers if its own body redirects or 401s on identity. */
function helperGuards(root, name, tried = new Set()) {
    if (tried.has(name))
        return false;
    tried.add(name);
    for (const f of (0, files_1.listFiles)(root).filter((p) => CODE_FILE.test(p) && !MIDDLEWARE_FILE.test(p))) {
        let src;
        try {
            src = (0, files_1.readSource)((0, node_path_1.join)(root, f));
        }
        catch {
            continue;
        }
        if (!new RegExp(`function\\s+${name}\\b|(?:const|let)\\s+${name}\\s*=`).test(src))
            continue;
        const parsed = (0, jsGuards_1.parseJs)(f, src);
        if ("error" in parsed)
            continue;
        for (const fn of parsed.root.findAll({ rule: { any: [{ kind: "function_declaration" }, { kind: "variable_declarator" }] } })) {
            const nm = fn.field("name")?.text();
            const body = fn.kind() === "function_declaration" ? fn.field("body") : (0, jsGuards_1.isFn)(fn.field("value")) ? fn.field("value")?.field("body") : null;
            if (nm === name && body)
                return (0, jsGuards_1.denies)(body) && jsGuards_1.IDENTITY.test(body.text());
        }
    }
    return false;
}
/** The function Next.js will call as middleware, however it is exported. */
function findHandler(root) {
    for (const exp of root.children().filter((c) => c.kind() === "export_statement")) {
        const text = exp.text();
        const isDefault = /^export\s+default\b/.test(text);
        const decl = exp.children().find((c) => c.isNamed() && c.kind() !== "decorator");
        // export { auth as middleware } from "@/auth"   /   export { default } from "next-auth/middleware"
        if (decl?.kind() === "export_clause") {
            const names = decl.findAll({ rule: { kind: "export_specifier" } });
            const spec = names.find((n) => /\b(middleware|proxy)\b$/.test(n.text()) || n.text() === "default");
            if (!spec)
                continue;
            const source = exp.field("source")?.text();
            const local = spec.children().find((c) => c.isNamed())?.text() ?? "";
            return { body: null, wrappers: [], reExport: source && local === "default" ? unquote(source) : local };
        }
        if (decl?.kind() === "function_declaration") {
            if (isDefault || /^(middleware|proxy)$/.test(decl.field("name")?.text() ?? ""))
                return { body: decl.field("body"), wrappers: [], reExport: null };
            continue;
        }
        if (decl?.kind() === "lexical_declaration") {
            for (const d of decl.children().filter((c) => c.kind() === "variable_declarator")) {
                if (!/^(middleware|proxy)$/.test(d.field("name")?.text() ?? ""))
                    continue;
                return unwrap(d.field("value"));
            }
            continue;
        }
        if (isDefault && decl)
            return unwrap(decl);
    }
    return null;
}
/** `auth((req) => {...})`, `withAuth(handler, opts)`, `clerkMiddleware(async (auth, req) => {...})` */
function unwrap(value) {
    let cur = (0, jsGuards_1.unwrapAwait)(value ?? null);
    const wrappers = [];
    for (let depth = 0; cur && depth < 4; depth++) {
        if ((0, jsGuards_1.isFn)(cur))
            return { body: cur.field("body"), wrappers, reExport: null };
        if (cur.kind() === "identifier")
            return { body: null, wrappers: [...wrappers, cur.text()], reExport: null };
        if (cur.kind() !== "call_expression")
            return null;
        const callee = cur.field("function")?.text() ?? "";
        wrappers.push(callee);
        const args = cur.field("arguments")?.children().filter((c) => c.isNamed()) ?? [];
        const inner = args.find((a) => (0, jsGuards_1.isFn)(a) || a.kind() === "call_expression");
        if (!inner)
            return { body: null, wrappers, reExport: null };
        cur = inner;
    }
    return null;
}
function factsForMiddleware(root, file, source, routes) {
    const parsed = (0, jsGuards_1.parseJs)(file, source);
    if ("error" in parsed)
        return parsed;
    const found = findHandler(parsed.root);
    if (!found)
        return { control: null };
    const guards = [];
    const add = (g) => {
        if (!guards.includes(g))
            guards.push(g);
    };
    for (const w of found.wrappers)
        if (WRAPPER_GUARD.test(w.split(".").pop() ?? ""))
            add((0, jsGuards_1.normalizeCallee)(w));
    if (found.reExport) {
        if (WRAPPER_GUARD.test(found.reExport) || /next-auth/.test(found.reExport))
            add(found.reExport);
    }
    if (found.body) {
        for (const g of (0, jsGuards_1.guardsInBody)(found.body))
            add(g);
        for (const g of (0, expressRoutes_1.reqGuards)(found.body))
            add(g);
        for (const call of found.body.findAll({ rule: { kind: "call_expression" } })) {
            const callee = call.field("function")?.text() ?? "";
            if (PROTECT_CALL.test(callee.replace(/\(\)/g, "")))
                add((0, jsGuards_1.normalizeCallee)(callee.replace(/\(\)/g, "")));
            else if (!callee.includes(".") && /^[a-z]\w*$/i.test(callee) && !/^(is|has|should|can|create)[A-Z]/.test(callee)) {
                // A helper such as updateSession(request): judged by its own body when we can find it, else by name.
                const known = helperGuards(root, callee);
                if (known || (HELPER_NAME.test(callee) && !hasDefinition(root, callee)))
                    add(callee);
            }
        }
    }
    const matcher = matcherOf(parsed.root);
    const regexes = matcher === "all" || matcher === "unknown" ? null : matcher.map(compileMatcher);
    const unreadable = matcher === "unknown" || (regexes?.some((r) => r === null) ?? false);
    const covered = routes.filter(({ sample }) => matcher === "all" || unreadable || (regexes ?? []).some((r) => r?.test(sample))).map((r) => r.route);
    const control = {
        kind: "middleware",
        id: `${file}#middleware`,
        file,
        lang: parsed.lang,
        guards,
        matcher: unreadable ? "unknown" : matcher,
        covered: [...new Set(covered)].sort(),
        routes: [...new Set(routes.map((r) => r.route))].sort(),
    };
    return { control, partial: unreadable ? "the matcher is not a plain list of patterns, so which routes it covers could not be checked" : undefined };
}
const hasDefinition = (root, name) => (0, files_1.listFiles)(root).some((f) => {
    if (!CODE_FILE.test(f) || MIDDLEWARE_FILE.test(f))
        return false;
    try {
        return new RegExp(`function\\s+${name}\\b|(?:const|let)\\s+${name}\\s*=`).test((0, files_1.readSource)((0, node_path_1.join)(root, f)));
    }
    catch {
        return false;
    }
});
exports.nextMiddleware = {
    name: "next-middleware",
    handles: (p) => MIDDLEWARE_FILE.test(p) || PAGE_OR_ROUTE.test(p) || CODE_FILE.test(p),
    expand(root, files) {
        // Which routes exist, and what helpers the middleware calls, both change what it covers.
        const mw = (0, files_1.listFiles)(root).filter((f) => MIDDLEWARE_FILE.test(f));
        if (mw.length === 0)
            return files;
        return files.some((f) => CODE_FILE.test(f)) ? [...new Set([...files, ...mw])] : files;
    },
    async scan(root, files) {
        const result = { controls: [], unparsed: [], partial: [] };
        const targets = files.filter((f) => MIDDLEWARE_FILE.test(f));
        if (targets.length === 0)
            return result;
        const routes = (0, files_1.listFiles)(root).filter((f) => PAGE_OR_ROUTE.test(f)).map(routeOf);
        for (const f of targets) {
            try {
                (0, node_fs_1.statSync)((0, node_path_1.join)(root, f));
            }
            catch {
                continue;
            }
            let source;
            try {
                source = (0, files_1.readSource)((0, node_path_1.join)(root, f));
            }
            catch {
                continue;
            }
            const r = factsForMiddleware(root, f, source, routes);
            if ("error" in r)
                result.unparsed.push({ file: f, reason: r.error });
            else {
                if (r.control)
                    result.controls.push(r.control);
                if (r.partial)
                    result.partial?.push({ file: f, reason: r.partial });
            }
        }
        return result;
    },
};
