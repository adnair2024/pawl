"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.lastSegment = exports.normalizeCallee = exports.unwrapAwait = exports.isFn = exports.DENY_CALLS = exports.IDENTITY = exports.GUARD_NAME = void 0;
exports.parseJs = parseJs;
exports.boundNames = boundNames;
exports.denies = denies;
exports.checksAndDenies = checksAndDenies;
exports.guardsInBody = guardsInBody;
const napi_1 = require("@ast-grep/napi");
/** Guard-learning helpers shared by every JS/TS framework reader. */
/** Parse a JS/TS file; null means it could not be parsed and must be reported, never trusted. */
function parseJs(relPath, source) {
    const lang = /\.(tsx|jsx)$/.test(relPath) ? "Tsx" : relPath.endsWith(".ts") ? "TypeScript" : "JavaScript";
    try {
        const root = (0, napi_1.parse)(lang, source).root();
        if (root.findAll({ rule: { kind: "ERROR" } }).length > 0)
            return { error: "syntax error; guards not inventoried" };
        return { root, lang: lang === "JavaScript" ? "js" : "ts" };
    }
    catch (e) {
        return { error: String(e) };
    }
}
/** Name shape of a call whose only purpose can be to block a request. */
exports.GUARD_NAME = /(auth|session|login|admin|permission|guard|protect|role|csrf)/i;
/** Words that mean "who is calling", used to tell auth checks from data checks. */
exports.IDENTITY = /(user|session|auth|token|account|principal|claims|identity|login|admin|role)/i;
exports.DENY_CALLS = new Set(["redirect", "permanentRedirect", "notFound", "forbidden", "unauthorized"]);
const isFn = (n) => !!n && ["arrow_function", "function_expression", "function", "function_declaration"].includes(String(n.kind()));
exports.isFn = isFn;
const unwrapAwait = (n) => {
    while (n && (n.kind() === "await_expression" || n.kind() === "parenthesized_expression")) {
        n = n.children().find((c) => c.isNamed()) ?? null;
    }
    return n;
};
exports.unwrapAwait = unwrapAwait;
/** `supabase.auth.getUser` and `client.auth.getUser` are the same guard: drop the local receiver name. */
const normalizeCallee = (callee) => {
    const parts = callee.replace(/\?\./g, ".").split(".");
    return parts.length > 2 ? parts.slice(-2).join(".") : parts.join(".");
};
exports.normalizeCallee = normalizeCallee;
const lastSegment = (callee) => callee.split(/[.?]+/).filter(Boolean).pop() ?? callee;
exports.lastSegment = lastSegment;
function boundNames(pattern) {
    if (!pattern)
        return [];
    const kinds = ["identifier", "shorthand_property_identifier_pattern"];
    const own = kinds.includes(String(pattern.kind())) ? [pattern.text()] : [];
    return [...own, ...pattern.findAll({ rule: { any: kinds.map((kind) => ({ kind })) } }).map((n) => n.text())];
}
/** Does this branch refuse the request: throw, redirect, or answer 401/403? */
function denies(branch) {
    const all = [branch, ...branch.findAll({ rule: { any: [{ kind: "throw_statement" }, { kind: "call_expression" }, { kind: "return_statement" }] } })];
    return all.some((n) => {
        const kind = n.kind();
        if (kind === "throw_statement")
            return true;
        if (kind === "call_expression") {
            const fn = n.field("function")?.text() ?? "";
            if (/\.(status|sendStatus)\(\s*(401|403)\b/.test(n.text()))
                return true; // Express: res.status(401)...
            if (fn === "next" && (n.field("arguments")?.children().filter((c) => c.isNamed()).length ?? 0) > 0)
                return true; // next(err)
            return exports.DENY_CALLS.has((0, exports.lastSegment)(fn)) || /\bredirect$/.test(fn);
        }
        return kind === "return_statement" && /\b(401|403)\b/.test(n.text());
    });
}
function checksAndDenies(stmt, vars) {
    if (stmt.kind() !== "if_statement" || vars.length === 0)
        return false;
    const cond = stmt.field("condition");
    const consequence = stmt.field("consequence");
    if (!cond || !consequence)
        return false;
    const used = new Set(boundNames(cond));
    return vars.some((v) => used.has(v)) && denies(consequence);
}
/** Guards that run at the top of one handler body, in source order. */
function guardsInBody(body) {
    const stmts = body.children().filter((c) => c.isNamed() && c.kind() !== "comment");
    const guards = [];
    const add = (g) => { if (!guards.includes(g))
        guards.push(g); };
    // The check can also be written in one line, with the identity call inside the condition:
    //   if (!(await auth())?.user) return Response.json(..., { status: 401 })
    //   const session = (await auth()) ?? redirect("/login")
    for (const stmt of stmts) {
        if (stmt.kind() === "return_statement")
            break;
        const refuses = stmt.kind() === "if_statement"
            ? (() => {
                const consequence = stmt.field("consequence");
                return !!consequence && denies(consequence);
            })()
            : /(\?\?|\|\|)\s*(await\s+)?(redirect|permanentRedirect|notFound|unauthorized|forbidden)\(/.test(stmt.text());
        if (!refuses)
            continue;
        const scope = stmt.kind() === "if_statement" ? stmt.field("condition") : stmt;
        for (const call of scope?.findAll({ rule: { kind: "call_expression" } }) ?? []) {
            const callee = call.field("function")?.text() ?? "";
            if (!exports.DENY_CALLS.has((0, exports.lastSegment)(callee)) && (exports.IDENTITY.test(callee) || exports.GUARD_NAME.test(callee)))
                add((0, exports.normalizeCallee)(callee));
        }
    }
    stmts.forEach((stmt, i) => {
        if (stmt.kind() === "return_statement")
            return;
        let call = null;
        let vars = [];
        if (stmt.kind() === "lexical_declaration") {
            const decl = stmt.children().find((c) => c.kind() === "variable_declarator");
            call = (0, exports.unwrapAwait)(decl?.field("value") ?? null);
            vars = boundNames(decl?.field("name") ?? null);
        }
        else if (stmt.kind() === "expression_statement") {
            call = (0, exports.unwrapAwait)(stmt.children().find((c) => c.isNamed()) ?? null);
        }
        if (!call || call.kind() !== "call_expression")
            return;
        const callee = call.field("function")?.text();
        if (!callee)
            return;
        const name = (0, exports.normalizeCallee)(callee);
        if (vars.length) {
            // `const x = await helper()` is only a guard if a later `if` checks x (or something
            // derived from x) and refuses, and the call is about identity rather than data.
            const tracked = [...vars];
            const later = stmts.slice(i + 1);
            for (const s of later) {
                if (checksAndDenies(s, tracked) && (exports.IDENTITY.test(callee) || vars.some((v) => exports.IDENTITY.test(v)))) {
                    add(name);
                    break;
                }
                if (s.kind() === "lexical_declaration") {
                    const d = s.children().find((c) => c.kind() === "variable_declarator");
                    const used = new Set(boundNames(d?.field("value") ?? null));
                    if (tracked.some((v) => used.has(v)))
                        tracked.push(...boundNames(d?.field("name") ?? null));
                }
            }
        }
        else if (exports.GUARD_NAME.test(callee)) {
            add(name);
        }
    });
    return guards;
}
