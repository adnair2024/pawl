"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pyHeaders = void 0;
exports.factsForFile = factsForFile;
exports.controlsFromFacts = controlsFromFacts;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const files_1 = require("../files");
const factsCache_1 = require("./factsCache");
const headerNames_1 = require("./headerNames");
const pyShared_1 = require("./pyShared");
const PY_FILE = /\.py$/;
const REQUEST_ORIGIN = /request\.(headers|META)[\s\S]{0,40}?(origin|HTTP_ORIGIN)/i;
const ALLOW_CHECK = /(\bin\b|==|allowed|whitelist|allowlist|origins|\.match\(|\bre\.)/i;
const MATCH_ALL = /^\^?\.[*+]\$?$/;
/** What flask_talisman.Talisman(app) sets by default, and the keyword that switches each off. */
const TALISMAN = [
    ["content_security_policy", "Content-Security-Policy"],
    ["strict_transport_security", "Strict-Transport-Security"],
    ["frame_options", "X-Frame-Options"],
    ["x_content_type_options", "X-Content-Type-Options"],
    ["referrer_policy", "Referrer-Policy"],
];
const list = (n) => (n && (n.kind() === "list" || n.kind() === "tuple" || n.kind() === "set") ? n.children().filter((c) => c.isNamed() && c.kind() !== "comment") : []);
const strings = (n) => list(n).flatMap((c) => (0, pyShared_1.strOf)(c) ?? []);
const isTrue = (n) => n?.kind() === "true";
const isOff = (n) => n?.kind() === "none" || n?.kind() === "false";
/** Is this expression the request's Origin header, directly or through a local variable? */
function readsRequestOrigin(value) {
    if (REQUEST_ORIGIN.test(value.text()))
        return true;
    if (value.kind() !== "identifier")
        return false;
    const scope = value.ancestors().find((a) => String(a.kind()) === "function_definition" || String(a.kind()) === "module");
    return (scope?.findAll({ rule: { kind: "assignment" } }) ?? []).some((a) => a.field("left")?.text() === value.text() && REQUEST_ORIGIN.test(a.field("right")?.text() ?? ""));
}
function originOfValue(value) {
    if (!value)
        return "allowlist";
    const literal = (0, pyShared_1.strOf)(value);
    if (literal !== null)
        return literal === "*" ? "wildcard" : "allowlist";
    if (!readsRequestOrigin(value))
        return "allowlist";
    const guarded = value.ancestors().some((a) => {
        if (String(a.kind()) === "function_definition")
            return false;
        const cond = String(a.kind()) === "if_statement" || String(a.kind()) === "conditional_expression" ? (a.field("condition") ?? a.children().find((c) => c.isNamed() && c !== a.children()[0])) : null;
        return !!cond && ALLOW_CHECK.test(cond.text());
    });
    return guarded ? "allowlist" : "reflect";
}
/** Starlette/FastAPI CORSMiddleware keywords. Nothing configured means no cross-origin access. */
function starletteOrigin(call) {
    const origins = strings((0, pyShared_1.keyword)(call, "allow_origins"));
    const regex = (0, pyShared_1.strOf)((0, pyShared_1.keyword)(call, "allow_origin_regex"));
    let out = "none";
    if (origins.includes("*"))
        out = "wildcard";
    else if (origins.length)
        out = "allowlist";
    if (regex !== null)
        out = (0, headerNames_1.worstOrigin)(out, MATCH_ALL.test(regex) ? "reflect" : "allowlist") ?? out;
    return out;
}
/** flask_cors: no origins means any origin. */
function flaskCorsOrigin(call) {
    const origins = (0, pyShared_1.keyword)(call, "origins");
    const resources = (0, pyShared_1.keyword)(call, "resources");
    const all = (n) => ((0, pyShared_1.strOf)(n ?? null) !== null ? [(0, pyShared_1.strOf)(n ?? null)] : strings(n));
    if (origins) {
        const v = all(origins);
        return v.length === 0 ? "allowlist" : v.includes("*") ? "wildcard" : "allowlist";
    }
    if (resources?.kind() === "dictionary") {
        const found = resources.findAll({ rule: { kind: "pair" } }).filter((p) => (0, pyShared_1.strOf)(p.field("key")) === "origins");
        if (found.length)
            return found.some((p) => all(p.field("value")).includes("*")) ? "wildcard" : "allowlist";
    }
    if (resources)
        return "allowlist"; // a variable we cannot read: assume the author listed origins
    return "wildcard";
}
const importsPackage = (root, pkg) => root.findAll({ rule: { any: [{ kind: "import_from_statement" }, { kind: "import_statement" }] } }).some((s) => s.text().includes(pkg));
function djangoSettings(root) {
    const s = { middleware: null, hstsSeconds: null, nosniff: null, referrer: null, xFrame: null, csp: false };
    let cors = null;
    let found = false;
    for (const st of root.children()) {
        const a = st.kind() === "expression_statement" ? st.children().find((c) => c.kind() === "assignment") : undefined;
        const name = a?.field("left")?.kind() === "identifier" ? a.field("left")?.text() : undefined;
        const v = a?.field("right");
        if (!name || !v)
            continue;
        found = true;
        if (name === "MIDDLEWARE")
            s.middleware = strings(v);
        else if (name === "SECURE_HSTS_SECONDS")
            s.hstsSeconds = v.kind() === "integer" ? Number(v.text()) : null;
        else if (name === "SECURE_CONTENT_TYPE_NOSNIFF")
            s.nosniff = isTrue(v) ? true : v.kind() === "false" ? false : null;
        else if (name === "SECURE_REFERRER_POLICY")
            s.referrer = isOff(v) ? "none" : "set";
        else if (name === "X_FRAME_OPTIONS")
            s.xFrame = isOff(v) ? "none" : "set";
        else if (name === "SECURE_CSP" || name === "SECURE_CSP_REPORT_ONLY")
            s.csp = v.kind() === "dictionary";
        else if (name === "CORS_ALLOW_ALL_ORIGINS" || name === "CORS_ORIGIN_ALLOW_ALL") {
            if (isTrue(v))
                cors = (0, headerNames_1.worstOrigin)(cors, "wildcard");
        }
        else if (name === "CORS_ALLOWED_ORIGIN_REGEXES" || name === "CORS_ORIGIN_REGEX_WHITELIST")
            cors = (0, headerNames_1.worstOrigin)(cors, strings(v).some((r) => MATCH_ALL.test(r)) ? "reflect" : strings(v).length ? "allowlist" : null);
        else if (name === "CORS_ALLOWED_ORIGINS" || name === "CORS_ORIGIN_WHITELIST")
            cors = (0, headerNames_1.worstOrigin)(cors, strings(v).length ? "allowlist" : null);
    }
    const relevant = s.middleware || s.hstsSeconds !== null || s.nosniff !== null || s.referrer || s.xFrame || s.csp;
    return { settings: found && relevant ? s : null, cors };
}
function factsForFile(file, source) {
    const parsed = (0, pyShared_1.parsePy)(source);
    if ("error" in parsed)
        return parsed;
    const { root } = parsed;
    const headers = new Set();
    let cors = null;
    const note = (name, value) => {
        const canon = (0, headerNames_1.canonicalHeader)(name);
        if (!canon)
            return;
        if (canon === headerNames_1.CORS_ORIGIN_HEADER)
            cors = (0, headerNames_1.worstOrigin)(cors, originOfValue(value));
        else
            headers.add(canon);
    };
    // response.headers["X-Frame-Options"] = "DENY"
    for (const a of root.findAll({ rule: { kind: "assignment" } })) {
        const left = a.field("left");
        if (left?.kind() !== "subscript")
            continue;
        const index = left.children().filter((c) => c.isNamed())[1];
        const name = (0, pyShared_1.strOf)(index);
        if (name !== null)
            note(name, a.field("right"));
    }
    // {"X-Frame-Options": "DENY"}, e.g. headers={...} or headers.update({...})
    for (const pair of root.findAll({ rule: { kind: "pair" } })) {
        const name = (0, pyShared_1.strOf)(pair.field("key"));
        if (name !== null)
            note(name, pair.field("value"));
    }
    // headers.setdefault("X-Frame-Options", "DENY"), resp.headers.add(...), set_header(...)
    for (const call of root.findAll({ rule: { kind: "call" } })) {
        const fn = call.field("function");
        const method = fn?.kind() === "attribute" ? fn.field("attribute")?.text() : undefined;
        if (method && ["setdefault", "append", "add", "add_header", "set_header"].includes(method)) {
            const name = (0, pyShared_1.strOf)((0, pyShared_1.positional)(call)[0]);
            if (name !== null)
                note(name, (0, pyShared_1.positional)(call)[1]);
        }
    }
    // Starlette / FastAPI
    for (const call of root.findAll({ rule: { kind: "call" } })) {
        const first = (0, pyShared_1.positional)(call)[0];
        if (first && (0, pyShared_1.lastSegment)(first.text()) === "CORSMiddleware")
            cors = (0, headerNames_1.worstOrigin)(cors, starletteOrigin(call));
    }
    // Flask-CORS and Talisman
    if (importsPackage(root, "flask_cors")) {
        for (const call of root.findAll({ rule: { kind: "call" } })) {
            const callee = (0, pyShared_1.lastSegment)(call.field("function")?.text() ?? "");
            if (callee === "CORS" || callee === "cross_origin")
                cors = (0, headerNames_1.worstOrigin)(cors, flaskCorsOrigin(call));
        }
    }
    if (importsPackage(root, "flask_talisman")) {
        for (const call of root.findAll({ rule: { kind: "call" } })) {
            if ((0, pyShared_1.lastSegment)(call.field("function")?.text() ?? "") !== "Talisman")
                continue;
            for (const [kw, header] of TALISMAN)
                if (!isOff((0, pyShared_1.keyword)(call, kw)))
                    headers.add(header);
        }
    }
    const dj = djangoSettings(root);
    cors = (0, headerNames_1.worstOrigin)(cors, dj.cors);
    return { file, lang: "py", headers: [...headers].sort(), cors, django: dj.settings };
}
/** Which headers Django's built-in middleware sends, given every settings file in the project. */
function djangoHeaders(all) {
    const files = all.filter((f) => f.django);
    const middleware = files.flatMap((f) => f.django?.middleware ?? []).map((m) => (0, pyShared_1.lastSegment)(m));
    const home = (pick) => (files.find((f) => f.django && pick(f.django)) ?? files[0])?.file ?? "";
    const out = [];
    const settings = files.map((f) => f.django);
    const security = middleware.includes("SecurityMiddleware");
    const explicitly = (pick) => settings.some(pick);
    if (security && explicitly((d) => (d.hstsSeconds ?? 0) > 0))
        out.push({ header: "Strict-Transport-Security", file: home((d) => (d.hstsSeconds ?? 0) > 0) });
    // Django sends nosniff and a referrer policy by default; only an explicit opt-out (with no opt-in elsewhere) removes them.
    if (security && (explicitly((d) => d.nosniff === true) || !explicitly((d) => d.nosniff === false)))
        out.push({ header: "X-Content-Type-Options", file: home((d) => d.middleware !== null) });
    if (security && (explicitly((d) => d.referrer === "set") || !explicitly((d) => d.referrer === "none")))
        out.push({ header: "Referrer-Policy", file: home((d) => d.middleware !== null) });
    if (middleware.includes("XFrameOptionsMiddleware") && (explicitly((d) => d.xFrame === "set") || !explicitly((d) => d.xFrame === "none"))) {
        out.push({ header: "X-Frame-Options", file: home((d) => d.middleware !== null) });
    }
    if (middleware.includes("CSPMiddleware") || middleware.includes("ContentSecurityPolicyMiddleware") || explicitly((d) => d.csp)) {
        out.push({ header: "Content-Security-Policy", file: home((d) => d.middleware !== null) });
    }
    return out;
}
function controlsFromFacts(all) {
    const extra = djangoHeaders(all).map((h) => ({ file: h.file, lang: "py", headers: [h.header], cors: null }));
    return (0, headerNames_1.controlsFromHeaderFacts)([...all, ...extra]);
}
const wanted = (p) => PY_FILE.test(p) && !(0, files_1.isTestPath)(p);
const mentions = (root, file) => {
    try {
        return headerNames_1.HEADER_MARKER.test((0, files_1.readSource)((0, node_path_1.join)(root, file)));
    }
    catch {
        return false;
    }
};
exports.pyHeaders = {
    name: "py-headers",
    handles: wanted,
    expand(root, files) {
        // Django spreads these settings over several files, so any edit near them re-reads them all.
        if (!files.some((f) => wanted(f) && mentions(root, f)))
            return files;
        return [...new Set([...files, ...(0, files_1.listFiles)(root).filter((f) => wanted(f) && mentions(root, f))])];
    },
    async scan(root, files) {
        const cache = new factsCache_1.FactsCache("headers-py-1", root);
        const result = { controls: [], unparsed: [] };
        const facts = [];
        for (const f of files.filter(wanted)) {
            let source;
            let st;
            try {
                st = (0, node_fs_1.statSync)((0, node_path_1.join)(root, f));
                source = (0, files_1.readSource)((0, node_path_1.join)(root, f));
            }
            catch {
                continue;
            }
            if (!headerNames_1.HEADER_MARKER.test(source))
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
