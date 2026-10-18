"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DefIndex = exports.lastSegment = void 0;
exports.parsePy = parsePy;
exports.strOf = strOf;
exports.positional = positional;
exports.keyword = keyword;
exports.denies = denies;
exports.bodyDenies = bodyDenies;
exports.inlineGuards = inlineGuards;
exports.importsOf = importsOf;
exports.resolveModule = resolveModule;
exports.resolveRef = resolveRef;
const napi_1 = require("@ast-grep/napi");
let registered = false;
function parsePy(source) {
    try {
        if (!registered) {
            // Loaded on first parse so runs that only touch other languages skip the grammar.
            (0, napi_1.registerDynamicLanguage)({ python: require("@ast-grep/lang-python") });
            registered = true;
        }
        const root = (0, napi_1.parse)("python", source).root();
        // Besides ERROR nodes, the parser repairs some mistakes by inserting zero-width placeholders
        // (for example a missing `)`), so any node with no text means the file is not valid Python.
        const broken = root.findAll({ rule: { any: [{ kind: "ERROR" }, { regex: "^$" }] } }).some((n) => n.kind() !== "module");
        if (broken)
            return { error: "syntax error; guards not inventoried" };
        return { root };
    }
    catch (e) {
        return { error: String(e) };
    }
}
/** The text of a Python string literal without quotes or prefix, or null if it is not one. */
function strOf(n) {
    if (!n || n.kind() !== "string")
        return null;
    return n.children().find((c) => c.kind() === "string_content")?.text() ?? "";
}
const lastSegment = (dotted) => dotted.split(".").filter(Boolean).pop() ?? dotted;
exports.lastSegment = lastSegment;
/** Positional arguments of a `call` node (keyword arguments excluded). */
function positional(call) {
    return (call.field("arguments")?.children() ?? []).filter((c) => c.isNamed() && c.kind() !== "keyword_argument" && c.kind() !== "comment");
}
function keyword(call, name) {
    for (const a of call.field("arguments")?.children() ?? []) {
        if (a.kind() === "keyword_argument" && a.field("name")?.text() === name)
            return a.field("value");
    }
    return null;
}
/** Text that means "this branch refuses the request". */
const DENY_TEXT = /\b(401|403)\b|HTTP_40[13]|UNAUTHORIZED|FORBIDDEN|Unauthorized|Forbidden|PermissionDenied|NotAuthenticated|AuthenticationFailed/;
/** Does this branch raise or return a 401/403-style refusal (or redirect to login)? */
function denies(branch) {
    const exits = branch.findAll({ rule: { any: [{ kind: "raise_statement" }, { kind: "return_statement" }, { kind: "call" }] } });
    return exits.some((e) => {
        const t = e.text();
        if (e.kind() === "call")
            return /\b(unauthorized|handle_unauthorized)\(\)/.test(t) || /^(flask\.)?abort\(\s*(401|403)\b/.test(t) || (/^(redirect|HttpResponseRedirect|RedirectResponse)\(/.test(t) && /login|signin/i.test(t));
        return DENY_TEXT.test(t) || (/redirect\(/i.test(t) && /login|signin/i.test(t));
    });
}
/** Does this function body refuse unauthenticated callers somewhere? Used to learn project guards. */
function bodyDenies(body) {
    // `credentials_exception = HTTPException(401)` followed by `raise credentials_exception` is common,
    // so the status code and the raise only need to appear somewhere in the same body.
    if (DENY_TEXT.test(body.text()) && body.find({ rule: { kind: "raise_statement" } }) !== null)
        return true;
    return denies(body);
}
/** `if not user: raise HTTPException(401)` at the top of a handler body. */
function inlineGuards(body) {
    const out = [];
    for (const stmt of body?.children().filter((c) => c.isNamed() && c.kind() !== "comment") ?? []) {
        if (stmt.kind() === "return_statement")
            break;
        if (stmt.kind() !== "if_statement")
            continue;
        const branch = stmt.field("consequence");
        if (branch && denies(branch)) {
            const code = /\b(401|403)\b|HTTP_(401|403)/.exec(branch.text());
            const g = `inline:${code?.[1] ?? code?.[2] ?? "denied"}`;
            if (!out.includes(g))
                out.push(g);
        }
    }
    return out;
}
function importsOf(root) {
    const out = [];
    const nameOf = (n) => {
        if (n.kind() === "aliased_import") {
            const parts = n.children().filter((c) => c.isNamed());
            return { name: parts[0]?.text() ?? "", alias: parts[1]?.text() ?? "" };
        }
        return { name: n.text(), alias: n.text() };
    };
    for (const st of root.findAll({ rule: { kind: "import_from_statement" } })) {
        const kids = st.children().filter((c) => c.isNamed());
        const src = kids[0];
        if (!src)
            continue;
        const rel = src.kind() === "relative_import";
        const level = rel ? (src.children().find((c) => c.kind() === "import_prefix")?.text().length ?? 1) : 0;
        const module = (rel ? src.children().find((c) => c.kind() === "dotted_name")?.text() : src.text()) ?? "";
        for (const k of kids.slice(1)) {
            const { name, alias } = nameOf(k);
            if (name)
                out.push({ local: alias.split(".").pop() ?? alias, module, level, name });
        }
    }
    for (const st of root.findAll({ rule: { kind: "import_statement" } })) {
        for (const k of st.children().filter((c) => c.isNamed())) {
            const { name, alias } = nameOf(k);
            if (name)
                out.push({ local: alias, module: name, level: 0, name: null });
        }
    }
    return out;
}
/** Map a dotted module (with relative level) to a known project file. */
function resolveModule(fromFile, module, level, known) {
    const segs = module.split(".").filter(Boolean).join("/");
    const candidates = (base) => (base ? [`${base}.py`, `${base}/__init__.py`] : ["__init__.py"]);
    if (level > 0) {
        const dirs = fromFile.split("/").slice(0, -1);
        const up = dirs.slice(0, Math.max(0, dirs.length - (level - 1))).join("/");
        return candidates([up, segs].filter(Boolean).join("/")).find((c) => known.has(c)) ?? null;
    }
    const wanted = candidates(segs);
    // Absolute imports can be rooted at the repo or at a source dir: match on the path tail.
    return [...known].find((f) => wanted.some((w) => f === w || f.endsWith(`/${w}`))) ?? null;
}
/**
 * Finds the project's own definition of a guard (dependency, decorator, permission class)
 * by name: in the same file first, then through the file's imports, then anywhere. Looking
 * through imports keeps two same-named helpers in different files apart.
 */
class DefIndex {
    byFile = new Map();
    anywhere = new Map();
    sources = new Map();
    known;
    constructor(all) {
        this.known = new Set(all.map((s) => s.file));
        for (const s of all) {
            this.sources.set(s.file, s);
            const m = new Map();
            for (const d of s.defs) {
                m.set(d.name, [...(m.get(d.name) ?? []), d]);
                this.anywhere.set(d.name, [...(this.anywhere.get(d.name) ?? []), { file: s.file, def: d }]);
            }
            this.byFile.set(s.file, m);
        }
    }
    lookup(base, file) {
        const local = this.byFile.get(file)?.get(base);
        if (local?.length)
            return local.map((def) => ({ file, def }));
        const imp = this.sources.get(file)?.imports.find((i) => i.local === base && i.name);
        const target = imp ? resolveModule(file, imp.module, imp.level, this.known) : null;
        const viaImport = target && imp?.name ? this.byFile.get(target)?.get(imp.name) : undefined;
        if (target && viaImport?.length)
            return viaImport.map((def) => ({ file: target, def }));
        return this.anywhere.get(base) ?? [];
    }
}
exports.DefIndex = DefIndex;
/**
 * Resolve `include_router(x)` / `register_blueprint(x)` style references to the file and
 * variable they point at: a local variable, `from m import x`, or `m.x` after `from pkg import m`.
 */
function resolveRef(src, ref, known) {
    if (ref.ident) {
        if (src.varNames.includes(ref.ident))
            return { file: src.file, name: ref.ident };
        const imp = src.imports.find((i) => i.local === ref.ident && i.name);
        const file = imp ? resolveModule(src.file, imp.module, imp.level, known) : null;
        return file && imp?.name ? { file, name: imp.name } : null;
    }
    const imp = src.imports.find((i) => i.local === ref.obj);
    if (!imp || !ref.attr)
        return null;
    const file = (imp.name ? resolveModule(src.file, `${imp.module}.${imp.name}`.replace(/^\./, ""), imp.level, known) : null) ??
        resolveModule(src.file, imp.module, imp.level, known);
    return file ? { file, name: ref.attr } : null;
}
