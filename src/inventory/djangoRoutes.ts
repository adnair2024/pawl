import { statSync } from "node:fs";
import { join } from "node:path";
import { listFiles, readSource } from "../files";
import type { Control, Inventorier, Inventory } from "../types";
import { FactsCache } from "./factsCache";
import { DefIndex, bodyDenies, importsOf, inlineGuards, keyword, lastSegment, parsePy, positional, strOf, type PyImport, type PyNode } from "./pyShared";

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

interface Deco { label: string; weak: boolean }
interface ViewFacts {
  kind: "function" | "class";
  name: string;
  drf: boolean;
  /** Decorators, mixin bases and class decorators in effect, as labels. */
  guards: string[];
  /** `permission_classes` set on the view, or null if it relies on the project default. */
  permissionClasses: string[] | null;
  inline: string[];
}
interface DjangoFacts {
  file: string;
  imports: PyImport[];
  /** Plain functions: `deps` are their decorators (so a custom decorator can be judged by its own body). */
  defs: { name: string; denies: boolean; deps: string[] }[];
  classes: { name: string; bases: string[]; denies: boolean; permissive: boolean }[];
  views: ViewFacts[];
  restDefaults: string[] | null;
  middleware: string[] | null;
}

function decoOf(expr: PyNode | undefined): Deco | null {
  if (!expr) return null;
  if (expr.kind() === "identifier") return { label: expr.text(), weak: false };
  if (expr.kind() === "attribute") return { label: lastSegment(expr.text()), weak: false };
  if (expr.kind() !== "call") return null;
  const callee = lastSegment(expr.field("function")?.text() ?? "");
  const arg = positional(expr)[0];
  const inner = strOf(arg) ?? (arg?.kind() === "identifier" ? arg.text() : arg?.kind() === "attribute" ? lastSegment(arg.text()) : null);
  return callee ? { label: inner ? `${callee}(${inner})` : callee, weak: false } : null;
}

const namesIn = (list: PyNode | null | undefined): string[] =>
  (list?.children() ?? [])
    .filter((c) => c.isNamed() && c.kind() !== "comment")
    .map((c) => (c.kind() === "string" ? lastSegment(strOf(c) ?? "") : c.kind() === "identifier" ? c.text() : c.kind() === "attribute" ? lastSegment(c.text()) : ""))
    .filter(Boolean);

/** Elements of `[A, B]`, `(A,)` or `A | B`. */
function permissionNames(value: PyNode | null | undefined): string[] {
  if (!value) return [];
  if (value.kind() === "list" || value.kind() === "tuple") return value.children().flatMap((c) => (c.isNamed() ? permissionNames(c) : []));
  if (value.kind() === "binary_operator") return value.children().flatMap((c) => (c.isNamed() ? permissionNames(c) : []));
  if (value.kind() === "identifier") return [value.text()];
  if (value.kind() === "attribute") return [lastSegment(value.text())];
  if (value.kind() === "call") return [lastSegment(value.field("function")?.text() ?? "")].filter(Boolean);
  return [];
}

function isPermissive(body: PyNode): boolean {
  const fn = body.findAll({ rule: { kind: "function_definition" } }).find((f) => f.field("name")?.text() === "has_permission");
  if (!fn) return false;
  const returns = fn.findAll({ rule: { kind: "return_statement" } });
  return returns.length > 0 && returns.every((r) => r.text().replace(/\s+/g, " ").trim() === "return True") && !fn.find({ rule: { kind: "raise_statement" } });
}

export function factsForFile(file: string, source: string): DjangoFacts | { error: string } {
  const parsed = parsePy(source);
  if ("error" in parsed) return parsed;
  const { root } = parsed;
  const imports = importsOf(root);
  const facts: DjangoFacts = { file, imports, defs: [], classes: [], views: [], restDefaults: null, middleware: null };

  for (const st of root.children()) {
    // Settings: REST_FRAMEWORK = {...} and MIDDLEWARE = [...]
    const assign = st.kind() === "expression_statement" ? st.children().find((c) => c.kind() === "assignment") : undefined;
    const target = assign?.field("left");
    const value = assign?.field("right");
    if (target?.kind() === "identifier" && value) {
      if (target.text() === "MIDDLEWARE") facts.middleware = namesIn(value);
      if (target.text() === "REST_FRAMEWORK" && value.kind() === "dictionary") {
        const pair = value.children().find((p) => p.kind() === "pair" && strOf(p.field("key")) === "DEFAULT_PERMISSION_CLASSES");
        facts.restDefaults = pair ? namesIn(pair.field("value")) : [];
      }
    }
  }

  for (const st of root.children()) {
    const def = st.kind() === "decorated_definition" ? st.children().find((c) => c.kind() === "function_definition" || c.kind() === "class_definition") : st;
    if (!def || (def.kind() !== "function_definition" && def.kind() !== "class_definition")) continue;
    const name = def.field("name")?.text();
    const body = def.field("body");
    if (!name || !body) continue;
    const decos = st.kind() === "decorated_definition" ? st.children().filter((c) => c.kind() === "decorator") : [];
    const exprs = decos.map((d) => d.children().find((c) => c.isNamed() && c.kind() !== "comment")).filter((e): e is PyNode => !!e);

    if (def.kind() === "function_definition") {
      const decorators = exprs.map(decoOf).filter((d): d is Deco => !!d);
      facts.defs.push({ name, denies: bodyDenies(body), deps: decorators.map((d) => d.label) });
      const first = def.field("parameters")?.children().find((c) => c.isNamed())?.text();
      if (first !== "request" && first !== "req") continue;
      const drf = exprs.some((e) => e.kind() === "call" && lastSegment(e.field("function")?.text() ?? "") === "api_view");
      const permDeco = exprs.find((e) => e.kind() === "call" && lastSegment(e.field("function")?.text() ?? "") === "permission_classes");
      facts.views.push({
        kind: "function",
        name,
        drf,
        guards: decorators.map((d) => d.label).filter((l) => l !== "api_view" && !l.startsWith("permission_classes") && l !== "csrf_exempt"),
        permissionClasses: permDeco && permDeco.kind() === "call" ? permissionNames(positional(permDeco)[0]) : null,
        inline: inlineGuards(body),
      });
      continue;
    }

    const bases = (def.field("superclasses")?.children() ?? []).filter((c) => c.isNamed() && c.kind() !== "keyword_argument").map((c) => lastSegment(c.text()));
    facts.classes.push({ name, bases, denies: bodyDenies(body), permissive: isPermissive(body) });
    if (name.endsWith("Mixin") || bases.includes("BasePermission")) continue;
    const viewBases = bases.filter((b) => /(View|ViewSet)$/.test(b) && !b.endsWith("Mixin"));
    if (viewBases.length === 0) continue;

    // A mixin only takes effect when it comes before the first real view base in the MRO.
    const firstView = bases.findIndex((b) => /(View|ViewSet)$/.test(b) && !b.endsWith("Mixin"));
    const mixins = bases.slice(0, firstView).filter((b) => b.endsWith("Mixin"));
    const decoGuards = exprs.flatMap((e) => {
      if (e.kind() !== "call" || lastSegment(e.field("function")?.text() ?? "") !== "method_decorator") return [];
      const arg = positional(e)[0];
      return arg?.kind() === "list" ? arg.children().filter((c) => c.isNamed()).map((c) => decoOf(c)?.label ?? "") : [decoOf(arg)?.label ?? ""];
    });
    let permissionClasses: string[] | null = null;
    for (const c of body.children()) {
      const a = c.kind() === "expression_statement" ? c.children().find((x) => x.kind() === "assignment") : undefined;
      if (a?.field("left")?.text() === "permission_classes") permissionClasses = permissionNames(a.field("right"));
    }
    const dispatch = body.findAll({ rule: { kind: "function_definition" } }).find((f) => f.field("name")?.text() === "dispatch");
    const drfImport = (b: string) => (imports.find((i) => i.local === b)?.module ?? "").startsWith("rest_framework");
    facts.views.push({
      kind: "class",
      name,
      drf: viewBases.some((b) => /(APIView|ViewSet)$/.test(b) || drfImport(b)),
      guards: [...mixins, ...decoGuards.filter(Boolean)],
      permissionClasses,
      inline: inlineGuards(dispatch?.field("body")),
    });
  }
  return facts;
}

export function controlsFromFacts(all: DjangoFacts[]): Control[] {
  const index = new DefIndex(all);
  const classes = new Map(all.flatMap((f) => f.classes.map((c) => [c.name, c] as const)));

  const isDecoratorGuard = (label: string, file: string, depth = 0): boolean => {
    const base = label.split("(")[0] ?? label;
    const found = index.lookup(base, file);
    if (found.length) return depth < 4 && found.every((d) => d.def.denies || d.def.deps.some((x) => isDecoratorGuard(x, d.file, depth + 1)));
    return GUARD_NAME.test(base);
  };
  const isMixinGuard = (name: string, depth = 0): boolean => {
    if (KNOWN_MIXIN_GUARDS.has(name)) return true;
    const c = classes.get(name);
    if (c) return depth < 4 && (c.denies || c.bases.some((b) => isMixinGuard(b, depth + 1)));
    return name.endsWith("Mixin") && GUARD_NAME.test(name);
  };
  const isPermissionGuard = (name: string): boolean => {
    if (name === "AllowAny") return false;
    const c = classes.get(name);
    if (c) return !c.permissive;
    return KNOWN_PERMISSIONS.has(name) || GUARD_NAME.test(name);
  };
  const isMiddlewareGuard = (name: string): boolean => {
    const c = classes.get(name);
    if (c) return c.denies;
    return !PLAIN_MIDDLEWARE.test(name) && GUARD_MIDDLEWARE.test(name);
  };

  // Settings can be split across files (base/dev/prod): count a default only if every definition has it.
  const everywhere = (lists: string[][]): string[] => (lists[0] ?? []).filter((x) => lists.every((l) => l.includes(x)));
  const defaultPerms = everywhere(all.flatMap((f) => (f.restDefaults ? [f.restDefaults.filter(isPermissionGuard)] : [])));
  const middlewareGuards = everywhere(all.flatMap((f) => (f.middleware ? [f.middleware.filter(isMiddlewareGuard)] : []))).map((n) => `middleware:${n}`);

  const controls: Control[] = [];
  const push = (id: string, file: string, framework: string, guards: string[]): void => {
    controls.push({ kind: "route-auth", id, file, lang: "py", framework, guards: guards.filter((g, i) => guards.indexOf(g) === i) });
  };

  for (const f of all) {
    if (f.restDefaults) push(`${f.file}#REST_FRAMEWORK.DEFAULT_PERMISSION_CLASSES`, f.file, "django-settings", f.restDefaults.filter(isPermissionGuard));
    if (f.middleware) push(`${f.file}#MIDDLEWARE`, f.file, "django-settings", f.middleware.filter(isMiddlewareGuard).map((n) => `middleware:${n}`));
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

const mentionsDjango = (root: string, file: string): boolean => {
  try {
    const src = readSource(join(root, file));
    return src.includes("django") || src.includes("rest_framework");
  } catch {
    return false;
  }
};

export const djangoRoutes: Inventorier = {
  name: "django-views",
  handles: (p) => PY_FILE.test(p),
  expand(root, files) {
    // Settings, mixins and permission classes live in different files from the views that use them.
    if (!files.some((f) => PY_FILE.test(f) && mentionsDjango(root, f))) return files;
    return [...new Set([...files, ...listFiles(root).filter((f) => PY_FILE.test(f) && mentionsDjango(root, f))])];
  },
  async scan(root, files) {
    const cache = new FactsCache<DjangoFacts | { error: string }>("django-1", root);
    const result: Inventory = { controls: [], unparsed: [] };
    const facts: DjangoFacts[] = [];
    for (const f of files.filter((p) => PY_FILE.test(p))) {
      let source: string;
      let st;
      try {
        st = statSync(join(root, f));
        source = readSource(join(root, f));
      } catch {
        continue;
      }
      if (!source.includes("django") && !source.includes("rest_framework")) continue;
      const entry = cache.get(f, st, () => factsForFile(f, source));
      if ("error" in entry) result.unparsed.push({ file: f, reason: entry.error });
      else facts.push(entry);
    }
    cache.save();
    result.controls = controlsFromFacts(facts);
    return result;
  },
};
