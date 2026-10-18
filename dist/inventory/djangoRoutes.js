"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.djangoRoutes = void 0;
exports.factsForFile = factsForFile;
exports.controlsFromFacts = controlsFromFacts;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const files_1 = require("../files");
const factsCache_1 = require("./factsCache");
const pyShared_1 = require("./pyShared");
const PY_FILE = /\.py$/;
/** Decorator / mixin / middleware names that mean "check who is calling", for ones we cannot read. */
const GUARD_NAME = /(login|auth|permission|staff|admin|superuser|owner|protect|guard|require|access|verify|role|group)/i;
const KNOWN_MIXIN_GUARDS = new Set(["LoginRequiredMixin", "PermissionRequiredMixin", "UserPassesTestMixin"]);
const KNOWN_PERMISSIONS = new Set([
    "IsAuthenticated", "IsAdminUser", "IsAuthenticatedOrReadOnly", "DjangoModelPermissions",
    "DjangoModelPermissionsOrAnonReadOnly", "DjangoObjectPermissions",
]);
/** Built-in middleware that loads a session or user but refuses nobody. */
const PLAIN_MIDDLEWARE = /^(Security|Session|Common|Csrf(View)?|Authentication|Message|XFrameOptions|Locale|GZip|ConditionalGet|CorsMiddleware|WhiteNoise)\w*$/;
const GUARD_MIDDLEWARE = /(LoginRequired|RequireLogin|AuthRequired|Authoriz|Permission|Guard|Protect)/i;
function decoOf(expr) {
    if (!expr)
        return null;
    if (expr.kind() === "identifier")
        return { label: expr.text(), weak: false };
    if (expr.kind() === "attribute")
        return { label: (0, pyShared_1.lastSegment)(expr.text()), weak: false };
    if (expr.kind() !== "call")
        return null;
    const callee = (0, pyShared_1.lastSegment)(expr.field("function")?.text() ?? "");
    const arg = (0, pyShared_1.positional)(expr)[0];
    const inner = (0, pyShared_1.strOf)(arg) ?? (arg?.kind() === "identifier" ? arg.text() : arg?.kind() === "attribute" ? (0, pyShared_1.lastSegment)(arg.text()) : null);
    return callee ? { label: inner ? `${callee}(${inner})` : callee, weak: false } : null;
}
const namesIn = (list) => (list?.children() ?? [])
    .filter((c) => c.isNamed() && c.kind() !== "comment")
    .map((c) => (c.kind() === "string" ? (0, pyShared_1.lastSegment)((0, pyShared_1.strOf)(c) ?? "") : c.kind() === "identifier" ? c.text() : c.kind() === "attribute" ? (0, pyShared_1.lastSegment)(c.text()) : ""))
    .filter(Boolean);
/** Elements of `[A, B]`, `(A,)` or `A | B`. */
function permissionNames(value) {
    if (!value)
        return [];
    if (value.kind() === "list" || value.kind() === "tuple")
        return value.children().flatMap((c) => (c.isNamed() ? permissionNames(c) : []));
    if (value.kind() === "binary_operator")
        return value.children().flatMap((c) => (c.isNamed() ? permissionNames(c) : []));
    if (value.kind() === "identifier")
        return [value.text()];
    if (value.kind() === "attribute")
        return [(0, pyShared_1.lastSegment)(value.text())];
    if (value.kind() === "call")
        return [(0, pyShared_1.lastSegment)(value.field("function")?.text() ?? "")].filter(Boolean);
    return [];
}
function isPermissive(body) {
    const fn = body.findAll({ rule: { kind: "function_definition" } }).find((f) => f.field("name")?.text() === "has_permission");
    if (!fn)
        return false;
    const returns = fn.findAll({ rule: { kind: "return_statement" } });
    return returns.length > 0 && returns.every((r) => r.text().replace(/\s+/g, " ").trim() === "return True") && !fn.find({ rule: { kind: "raise_statement" } });
}
function factsForFile(file, source) {
    const parsed = (0, pyShared_1.parsePy)(source);
    if ("error" in parsed)
        return parsed;
    const { root } = parsed;
    const imports = (0, pyShared_1.importsOf)(root);
    const facts = { file, imports, defs: [], classes: [], views: [], restDefaults: null, middleware: null };
    for (const st of root.children()) {
        // Settings: REST_FRAMEWORK = {...} and MIDDLEWARE = [...]
        const assign = st.kind() === "expression_statement" ? st.children().find((c) => c.kind() === "assignment") : undefined;
        const target = assign?.field("left");
        const value = assign?.field("right");
        if (target?.kind() === "identifier" && value) {
            if (target.text() === "MIDDLEWARE")
                facts.middleware = namesIn(value);
            if (target.text() === "REST_FRAMEWORK" && value.kind() === "dictionary") {
                const pair = value.children().find((p) => p.kind() === "pair" && (0, pyShared_1.strOf)(p.field("key")) === "DEFAULT_PERMISSION_CLASSES");
                facts.restDefaults = pair ? namesIn(pair.field("value")) : [];
            }
        }
    }
    for (const st of root.children()) {
        const def = st.kind() === "decorated_definition" ? st.children().find((c) => c.kind() === "function_definition" || c.kind() === "class_definition") : st;
        if (!def || (def.kind() !== "function_definition" && def.kind() !== "class_definition"))
            continue;
        const name = def.field("name")?.text();
        const body = def.field("body");
        if (!name || !body)
            continue;
        const decos = st.kind() === "decorated_definition" ? st.children().filter((c) => c.kind() === "decorator") : [];
        const exprs = decos.map((d) => d.children().find((c) => c.isNamed() && c.kind() !== "comment")).filter((e) => !!e);
        if (def.kind() === "function_definition") {
            const decorators = exprs.map(decoOf).filter((d) => !!d);
            facts.defs.push({ name, denies: (0, pyShared_1.bodyDenies)(body), deps: decorators.map((d) => d.label) });
            const first = def.field("parameters")?.children().find((c) => c.isNamed())?.text();
            if (first !== "request" && first !== "req")
                continue;
            const drf = exprs.some((e) => e.kind() === "call" && (0, pyShared_1.lastSegment)(e.field("function")?.text() ?? "") === "api_view");
            const permDeco = exprs.find((e) => e.kind() === "call" && (0, pyShared_1.lastSegment)(e.field("function")?.text() ?? "") === "permission_classes");
            facts.views.push({
                kind: "function",
                name,
                drf,
                guards: decorators.map((d) => d.label).filter((l) => l !== "api_view" && !l.startsWith("permission_classes") && l !== "csrf_exempt"),
                permissionClasses: permDeco && permDeco.kind() === "call" ? permissionNames((0, pyShared_1.positional)(permDeco)[0]) : null,
                inline: (0, pyShared_1.inlineGuards)(body),
            });
            continue;
        }
        const bases = (def.field("superclasses")?.children() ?? []).filter((c) => c.isNamed() && c.kind() !== "keyword_argument").map((c) => (0, pyShared_1.lastSegment)(c.text()));
        facts.classes.push({ name, bases, denies: (0, pyShared_1.bodyDenies)(body), permissive: isPermissive(body) });
        if (name.endsWith("Mixin") || bases.includes("BasePermission"))
            continue;
        const viewBases = bases.filter((b) => /(View|ViewSet)$/.test(b) && !b.endsWith("Mixin"));
        if (viewBases.length === 0)
            continue;
        // A mixin only takes effect when it comes before the first real view base in the MRO.
        const firstView = bases.findIndex((b) => /(View|ViewSet)$/.test(b) && !b.endsWith("Mixin"));
        const mixins = bases.slice(0, firstView).filter((b) => b.endsWith("Mixin"));
        const decoGuards = exprs.flatMap((e) => {
            if (e.kind() !== "call" || (0, pyShared_1.lastSegment)(e.field("function")?.text() ?? "") !== "method_decorator")
                return [];
            const arg = (0, pyShared_1.positional)(e)[0];
            return arg?.kind() === "list" ? arg.children().filter((c) => c.isNamed()).map((c) => decoOf(c)?.label ?? "") : [decoOf(arg)?.label ?? ""];
        });
        let permissionClasses = null;
        for (const c of body.children()) {
            const a = c.kind() === "expression_statement" ? c.children().find((x) => x.kind() === "assignment") : undefined;
            if (a?.field("left")?.text() === "permission_classes")
                permissionClasses = permissionNames(a.field("right"));
        }
        const dispatch = body.findAll({ rule: { kind: "function_definition" } }).find((f) => f.field("name")?.text() === "dispatch");
        const drfImport = (b) => (imports.find((i) => i.local === b)?.module ?? "").startsWith("rest_framework");
        facts.views.push({
            kind: "class",
            name,
            drf: viewBases.some((b) => /(APIView|ViewSet)$/.test(b) || drfImport(b)),
            guards: [...mixins, ...decoGuards.filter(Boolean)],
            permissionClasses,
            inline: (0, pyShared_1.inlineGuards)(dispatch?.field("body")),
        });
    }
    return facts;
}
function controlsFromFacts(all) {
    const index = new pyShared_1.DefIndex(all);
    const classes = new Map(all.flatMap((f) => f.classes.map((c) => [c.name, c])));
    const isDecoratorGuard = (label, file, depth = 0) => {
        const base = label.split("(")[0] ?? label;
        const found = index.lookup(base, file);
        if (found.length)
            return depth < 4 && found.every((d) => d.def.denies || d.def.deps.some((x) => isDecoratorGuard(x, d.file, depth + 1)));
        return GUARD_NAME.test(base);
    };
    const isMixinGuard = (name, depth = 0) => {
        if (KNOWN_MIXIN_GUARDS.has(name))
            return true;
        const c = classes.get(name);
        if (c)
            return depth < 4 && (c.denies || c.bases.some((b) => isMixinGuard(b, depth + 1)));
        return name.endsWith("Mixin") && GUARD_NAME.test(name);
    };
    const isPermissionGuard = (name) => {
        if (name === "AllowAny")
            return false;
        const c = classes.get(name);
        if (c)
            return !c.permissive;
        return KNOWN_PERMISSIONS.has(name) || GUARD_NAME.test(name);
    };
    const isMiddlewareGuard = (name) => {
        const c = classes.get(name);
        if (c)
            return c.denies;
        return !PLAIN_MIDDLEWARE.test(name) && GUARD_MIDDLEWARE.test(name);
    };
    // Settings can be split across files (base/dev/prod): count a default only if every definition has it.
    const everywhere = (lists) => (lists[0] ?? []).filter((x) => lists.every((l) => l.includes(x)));
    const defaultPerms = everywhere(all.flatMap((f) => (f.restDefaults ? [f.restDefaults.filter(isPermissionGuard)] : [])));
    const middlewareGuards = everywhere(all.flatMap((f) => (f.middleware ? [f.middleware.filter(isMiddlewareGuard)] : []))).map((n) => `middleware:${n}`);
    const controls = [];
    const push = (id, file, framework, guards) => {
        controls.push({ kind: "route-auth", id, file, lang: "py", framework, guards: guards.filter((g, i) => guards.indexOf(g) === i) });
    };
    for (const f of all) {
        if (f.restDefaults)
            push(`${f.file}#REST_FRAMEWORK.DEFAULT_PERMISSION_CLASSES`, f.file, "django-settings", f.restDefaults.filter(isPermissionGuard));
        if (f.middleware)
            push(`${f.file}#MIDDLEWARE`, f.file, "django-settings", f.middleware.filter(isMiddlewareGuard).map((n) => `middleware:${n}`));
        for (const v of f.views) {
            const own = (v.permissionClasses ?? (v.drf ? defaultPerms : [])).filter(isPermissionGuard);
            const guards = [
                ...middlewareGuards,
                ...own,
                ...v.guards.filter((g) => (v.kind === "class" && !g.includes("(") && g.endsWith("Mixin") ? isMixinGuard(g) : isDecoratorGuard(g, f.file))),
                ...v.inline,
            ];
            push(`${f.file}#${v.name}`, f.file, "django", guards);
        }
    }
    return controls;
}
const mentionsDjango = (root, file) => {
    try {
        const src = (0, files_1.readSource)((0, node_path_1.join)(root, file));
        return src.includes("django") || src.includes("rest_framework");
    }
    catch {
        return false;
    }
};
exports.djangoRoutes = {
    name: "django-views",
    handles: (p) => PY_FILE.test(p),
    expand(root, files) {
        // Settings, mixins and permission classes live in different files from the views that use them.
        if (!files.some((f) => PY_FILE.test(f) && mentionsDjango(root, f)))
            return files;
        return [...new Set([...files, ...(0, files_1.listFiles)(root).filter((f) => PY_FILE.test(f) && mentionsDjango(root, f))])];
    },
    async scan(root, files) {
        const cache = new factsCache_1.FactsCache("django-1", root);
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
            if (!source.includes("django") && !source.includes("rest_framework"))
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
