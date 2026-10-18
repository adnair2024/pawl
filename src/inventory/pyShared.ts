import { parse, registerDynamicLanguage, type SgNode } from "@ast-grep/napi";
import python from "@ast-grep/lang-python";

/** Python parsing and guard-learning helpers shared by the FastAPI, Flask and Django readers. */
export type PyNode = SgNode;

let registered = false;

export function parsePy(source: string): { root: PyNode } | { error: string } {
  try {
    if (!registered) {
      registerDynamicLanguage({ python });
      registered = true;
    }
    const root = parse("python", source).root();
    // Besides ERROR nodes, the parser repairs some mistakes by inserting zero-width placeholders
    // (for example a missing `)`), so any node with no text means the file is not valid Python.
    const broken = root.findAll({ rule: { any: [{ kind: "ERROR" }, { regex: "^$" }] } }).some((n) => n.kind() !== "module");
    if (broken) return { error: "syntax error; guards not inventoried" };
    return { root };
  } catch (e) {
    return { error: String(e) };
  }
}

/** The text of a Python string literal without quotes or prefix, or null if it is not one. */
export function strOf(n: PyNode | null | undefined): string | null {
  if (!n || n.kind() !== "string") return null;
  return n.children().find((c) => c.kind() === "string_content")?.text() ?? "";
}

export const lastSegment = (dotted: string): string => dotted.split(".").filter(Boolean).pop() ?? dotted;

/** Positional arguments of a `call` node (keyword arguments excluded). */
export function positional(call: PyNode): PyNode[] {
  return (call.field("arguments")?.children() ?? []).filter((c) => c.isNamed() && c.kind() !== "keyword_argument" && c.kind() !== "comment");
}

export function keyword(call: PyNode, name: string): PyNode | null {
  for (const a of call.field("arguments")?.children() ?? []) {
    if (a.kind() === "keyword_argument" && a.field("name")?.text() === name) return a.field("value");
  }
  return null;
}

/** Text that means "this branch refuses the request". */
const DENY_TEXT = /\b(401|403)\b|HTTP_40[13]|UNAUTHORIZED|FORBIDDEN|Unauthorized|Forbidden|PermissionDenied|NotAuthenticated|AuthenticationFailed/;

/** Does this branch raise or return a 401/403-style refusal (or redirect to login)? */
export function denies(branch: PyNode): boolean {
  const exits = branch.findAll({ rule: { any: [{ kind: "raise_statement" }, { kind: "return_statement" }, { kind: "call" }] } });
  return exits.some((e) => {
    const t = e.text();
    if (e.kind() === "call") return /\b(unauthorized|handle_unauthorized)\(\)/.test(t) || /^(flask\.)?abort\(\s*(401|403)\b/.test(t) || (/^(redirect|HttpResponseRedirect|RedirectResponse)\(/.test(t) && /login|signin/i.test(t));
    return DENY_TEXT.test(t) || (/redirect\(/i.test(t) && /login|signin/i.test(t));
  });
}

/** Does this function body refuse unauthenticated callers somewhere? Used to learn project guards. */
export function bodyDenies(body: PyNode): boolean {
  // `credentials_exception = HTTPException(401)` followed by `raise credentials_exception` is common,
  // so the status code and the raise only need to appear somewhere in the same body.
  if (DENY_TEXT.test(body.text()) && body.find({ rule: { kind: "raise_statement" } }) !== null) return true;
  return denies(body);
}

/** `if not user: raise HTTPException(401)` at the top of a handler body. */
export function inlineGuards(body: PyNode | null | undefined): string[] {
  const out: string[] = [];
  for (const stmt of body?.children().filter((c) => c.isNamed() && c.kind() !== "comment") ?? []) {
    if (stmt.kind() === "return_statement") break;
    if (stmt.kind() !== "if_statement") continue;
    const branch = stmt.field("consequence");
    if (branch && denies(branch)) {
      const code = /\b(401|403)\b|HTTP_(401|403)/.exec(branch.text());
      const g = `inline:${code?.[1] ?? code?.[2] ?? "denied"}`;
      if (!out.includes(g)) out.push(g);
    }
  }
  return out;
}

export interface PyImport { local: string; module: string; level: number; name: string | null }

export function importsOf(root: PyNode): PyImport[] {
  const out: PyImport[] = [];
  const nameOf = (n: PyNode): { name: string; alias: string } => {
    if (n.kind() === "aliased_import") {
      const parts = n.children().filter((c) => c.isNamed());
      return { name: parts[0]?.text() ?? "", alias: parts[1]?.text() ?? "" };
    }
    return { name: n.text(), alias: n.text() };
  };
  for (const st of root.findAll({ rule: { kind: "import_from_statement" } })) {
    const kids = st.children().filter((c) => c.isNamed());
    const src = kids[0];
    if (!src) continue;
    const rel = src.kind() === "relative_import";
    const level = rel ? (src.children().find((c) => c.kind() === "import_prefix")?.text().length ?? 1) : 0;
    const module = (rel ? src.children().find((c) => c.kind() === "dotted_name")?.text() : src.text()) ?? "";
    for (const k of kids.slice(1)) {
      const { name, alias } = nameOf(k);
      if (name) out.push({ local: alias.split(".").pop() ?? alias, module, level, name });
    }
  }
  for (const st of root.findAll({ rule: { kind: "import_statement" } })) {
    for (const k of st.children().filter((c) => c.isNamed())) {
      const { name, alias } = nameOf(k);
      if (name) out.push({ local: alias, module: name, level: 0, name: null });
    }
  }
  return out;
}

/** Map a dotted module (with relative level) to a known project file. */
export function resolveModule(fromFile: string, module: string, level: number, known: Set<string>): string | null {
  const segs = module.split(".").filter(Boolean).join("/");
  const candidates = (base: string): string[] => (base ? [`${base}.py`, `${base}/__init__.py`] : ["__init__.py"]);
  if (level > 0) {
    const dirs = fromFile.split("/").slice(0, -1);
    const up = dirs.slice(0, Math.max(0, dirs.length - (level - 1))).join("/");
    return candidates([up, segs].filter(Boolean).join("/")).find((c) => known.has(c)) ?? null;
  }
  const wanted = candidates(segs);
  // Absolute imports can be rooted at the repo or at a source dir: match on the path tail.
  return [...known].find((f) => wanted.some((w) => f === w || f.endsWith(`/${w}`))) ?? null;
}

export interface DefLike { name: string; denies: boolean; deps: string[] }
export interface DefSource { file: string; imports: PyImport[]; defs: DefLike[] }

/**
 * Finds the project's own definition of a guard (dependency, decorator, permission class)
 * by name: in the same file first, then through the file's imports, then anywhere. Looking
 * through imports keeps two same-named helpers in different files apart.
 */
export class DefIndex {
  private readonly byFile = new Map<string, Map<string, DefLike[]>>();
  private readonly anywhere = new Map<string, { file: string; def: DefLike }[]>();
  private readonly sources = new Map<string, DefSource>();
  private readonly known: Set<string>;

  constructor(all: DefSource[]) {
    this.known = new Set(all.map((s) => s.file));
    for (const s of all) {
      this.sources.set(s.file, s);
      const m = new Map<string, DefLike[]>();
      for (const d of s.defs) {
        m.set(d.name, [...(m.get(d.name) ?? []), d]);
        this.anywhere.set(d.name, [...(this.anywhere.get(d.name) ?? []), { file: s.file, def: d }]);
      }
      this.byFile.set(s.file, m);
    }
  }

  lookup(base: string, file: string): { file: string; def: DefLike }[] {
    const local = this.byFile.get(file)?.get(base);
    if (local?.length) return local.map((def) => ({ file, def }));
    const imp = this.sources.get(file)?.imports.find((i) => i.local === base && i.name);
    const target = imp ? resolveModule(file, imp.module, imp.level, this.known) : null;
    const viaImport = target && imp?.name ? this.byFile.get(target)?.get(imp.name) : undefined;
    if (target && viaImport?.length) return viaImport.map((def) => ({ file: target, def }));
    return this.anywhere.get(base) ?? [];
  }
}

export interface RefSource { file: string; imports: PyImport[]; varNames: string[] }

/**
 * Resolve `include_router(x)` / `register_blueprint(x)` style references to the file and
 * variable they point at: a local variable, `from m import x`, or `m.x` after `from pkg import m`.
 */
export function resolveRef(
  src: RefSource,
  ref: { ident: string | null; obj: string | null; attr: string | null },
  known: Set<string>,
): { file: string; name: string } | null {
  if (ref.ident) {
    if (src.varNames.includes(ref.ident)) return { file: src.file, name: ref.ident };
    const imp = src.imports.find((i) => i.local === ref.ident && i.name);
    const file = imp ? resolveModule(src.file, imp.module, imp.level, known) : null;
    return file && imp?.name ? { file, name: imp.name } : null;
  }
  const imp = src.imports.find((i) => i.local === ref.obj);
  if (!imp || !ref.attr) return null;
  const file =
    (imp.name ? resolveModule(src.file, `${imp.module}.${imp.name}`.replace(/^\./, ""), imp.level, known) : null) ??
    resolveModule(src.file, imp.module, imp.level, known);
  return file ? { file, name: ref.attr } : null;
}
