import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { listFiles } from "../files";
import type { Control, Inventorier, Inventory } from "../types";
import { FactsCache } from "./factsCache";
import { DefIndex, bodyDenies, importsOf, inlineGuards, keyword, lastSegment, parsePy, positional, resolveRef, strOf, type PyImport, type PyNode } from "./pyShared";

const PY_FILE = /\.py$/;
const VERBS = new Set(["get", "post", "put", "patch", "delete"]);
/** Decorator names that mean "check who is calling", for decorators we cannot read (extensions). */
const GUARD_NAME = /(login|auth|jwt|token|permission|role|admin|protect|access|session|guard|verify|require)/i;

interface Registration { receiver: string; ident: string | null; obj: string | null; attr: string | null }
interface FlaskFacts {
  file: string;
  imports: PyImport[];
  /** `deps` of a plain function are its non-route decorators (used by add_url_rule). */
  defs: { name: string; denies: boolean; deps: string[] }[];
  vars: { name: string; kind: "app" | "blueprint" }[];
  /** before_request functions that refuse callers. `appWide` for `before_app_request`. */
  scope: { receiver: string; label: string; appWide: boolean }[];
  registers: Registration[];
  routes: { receiver: string; method: string; path: string; decorators: string[]; inline: string[] }[];
}

interface Deco { label: string; weak: boolean }

/** `login_required` -> "login_required"; `roles_required("admin")` -> "roles_required(admin)"; `jwt_required(optional=True)` -> weak. */
function decoOf(expr: PyNode): Deco | null {
  if (expr.kind() === "identifier") return { label: expr.text(), weak: false };
  if (expr.kind() === "attribute") return { label: lastSegment(expr.text()), weak: false };
  if (expr.kind() !== "call") return null;
  const callee = lastSegment(expr.field("function")?.text() ?? "");
  if (!callee) return null;
  const first = strOf(positional(expr)[0]);
  return { label: first ? `${callee}(${first})` : callee, weak: keyword(expr, "optional")?.text() === "True" };
}

const methodsOf = (call: PyNode): string[] => {
  const list = keyword(call, "methods");
  const found = (list?.findAll({ rule: { kind: "string" } }) ?? []).map((n) => (strOf(n) ?? "").toUpperCase()).filter(Boolean);
  return found.length ? found : ["GET"];
};

export function factsForFile(file: string, source: string): FlaskFacts | { error: string } {
  const parsed = parsePy(source);
  if ("error" in parsed) return parsed;
  const { root } = parsed;
  const facts: FlaskFacts = { file, imports: importsOf(root), defs: [], vars: [], scope: [], registers: [], routes: [] };

  for (const a of root.findAll({ rule: { kind: "assignment" } })) {
    const left = a.field("left");
    const right = a.field("right");
    if (left?.kind() !== "identifier" || right?.kind() !== "call") continue;
    const ctor = lastSegment(right.field("function")?.text() ?? "");
    if (ctor === "Flask") facts.vars.push({ name: left.text(), kind: "app" });
    else if (ctor === "Blueprint") facts.vars.push({ name: left.text(), kind: "blueprint" });
  }

  for (const dd of root.findAll({ rule: { kind: "decorated_definition" } })) {
    const fn = dd.children().find((c) => c.kind() === "function_definition");
    const name = fn?.field("name")?.text();
    const body = fn?.field("body");
    if (!fn || !name || !body) continue;
    const decorators = dd.children().filter((c) => c.kind() === "decorator");
    const inline = inlineGuards(body);
    const below: Deco[] = [];

    // Decorators only protect a route when they sit below it: those above wrap the function
    // after Flask has already registered the undecorated one.
    decorators.forEach((dec, i) => {
      const expr = dec.children().find((c) => c.isNamed() && c.kind() !== "comment");
      const callee = expr?.kind() === "call" ? expr.field("function") : null;
      const verb = callee?.kind() === "attribute" ? callee.field("attribute")?.text() ?? "" : "";
      const recv = callee?.field("object");
      if (expr?.kind() === "call" && recv?.kind() === "identifier") {
        if (verb === "route" || VERBS.has(verb)) {
          const path = strOf(positional(expr)[0]) ?? strOf(keyword(expr, "rule")) ?? "<dynamic>";
          const methods = verb === "route" ? methodsOf(expr) : [verb.toUpperCase()];
          const guards = decorators
            .slice(i + 1)
            .map((d) => decoOf(d.children().find((c) => c.isNamed() && c.kind() !== "comment") as PyNode))
            .filter((d): d is Deco => !!d && !d.weak)
            .map((d) => d.label);
          for (const method of methods) facts.routes.push({ receiver: recv.text(), method, path, decorators: guards, inline });
        }
      }
    });

    for (const dec of decorators) {
      const expr = dec.children().find((c) => c.isNamed() && c.kind() !== "comment");
      if (expr?.kind() !== "attribute") continue;
      const verb = expr.field("attribute")?.text();
      const recv = expr.field("object");
      if ((verb === "before_request" || verb === "before_app_request") && recv?.kind() === "identifier" && bodyDenies(body)) {
        facts.scope.push({ receiver: recv.text(), label: `before_request:${name}`, appWide: verb === "before_app_request" });
      }
    }
    for (const dec of decorators) {
      const d = decoOf(dec.children().find((c) => c.isNamed() && c.kind() !== "comment") as PyNode);
      if (d && !d.weak) below.push(d);
    }
    facts.defs.push({ name, denies: bodyDenies(body), deps: below.map((d) => d.label) });
  }

  for (const fn of root.findAll({ rule: { kind: "function_definition" } })) {
    const name = fn.field("name")?.text();
    const body = fn.field("body");
    if (name && body && !facts.defs.some((d) => d.name === name)) facts.defs.push({ name, denies: bodyDenies(body), deps: [] });
  }

  for (const call of root.findAll({ rule: { kind: "call" } })) {
    const fn = call.field("function");
    if (fn?.kind() !== "attribute") continue;
    const verb = fn.field("attribute")?.text();
    const recv = fn.field("object");
    if (recv?.kind() !== "identifier") continue;
    const arg = positional(call)[0];
    if (verb === "register_blueprint" && arg) {
      if (arg.kind() === "identifier") facts.registers.push({ receiver: recv.text(), ident: arg.text(), obj: null, attr: null });
      else if (arg.kind() === "attribute" && arg.field("object")?.kind() === "identifier") {
        facts.registers.push({ receiver: recv.text(), ident: null, obj: arg.field("object")?.text() ?? null, attr: arg.field("attribute")?.text() ?? null });
      }
    }
    if (verb === "add_url_rule") {
      const path = strOf(positional(call)[0]);
      const view = keyword(call, "view_func") ?? positional(call)[2];
      const def = view?.kind() === "identifier" ? facts.defs.find((d) => d.name === view.text()) : undefined;
      if (path === null || !def) continue;
      for (const method of methodsOf(call)) facts.routes.push({ receiver: recv.text(), method, path, decorators: def.deps, inline: [] });
    }
  }
  return facts;
}

export function controlsFromFacts(all: FlaskFacts[]): Control[] {
  const known = new Set(all.map((f) => f.file));
  const byFile = new Map(all.map((f) => [f.file, f]));
  const index = new DefIndex(all);

  const isGuard = (label: string, file: string, depth = 0): boolean => {
    const base = label.split("(")[0] ?? label;
    const found = index.lookup(base, file);
    if (found.length) return depth < 4 && found.every((d) => d.def.denies || d.def.deps.some((x) => isGuard(x, d.file, depth + 1)));
    return GUARD_NAME.test(base);
  };

  const kindOf = (file: string, name: string): "app" | "blueprint" | undefined => byFile.get(file)?.vars.find((v) => v.name === name)?.kind;
  // app.before_request and before_app_request run for every request, blueprints included.
  const appWide = all.flatMap((f) => f.scope.filter((s) => s.appWide || kindOf(f.file, s.receiver) === "app").map((s) => s.label));
  const scoped = (file: string, name: string): string[] =>
    (byFile.get(file)?.scope ?? []).filter((s) => s.receiver === name && !s.appWide && kindOf(file, name) !== "app").map((s) => s.label);

  const edges = all.flatMap((f) =>
    f.registers.flatMap((r) => {
      const t = resolveRef({ file: f.file, imports: f.imports, varNames: f.vars.map((v) => v.name) }, r, known);
      return t ? [{ from: f.file, receiver: r.receiver, to: t }] : [];
    }),
  );
  // A blueprint nested inside another inherits the parent's before_request guards.
  const inherited = (file: string, name: string, seen: Set<string>): string[] => {
    const key = `${file}::${name}`;
    if (seen.has(key)) return [];
    const incoming = edges.filter((e) => e.to.file === file && e.to.name === name);
    const per = incoming.map((e) => [...scoped(e.from, e.receiver), ...inherited(e.from, e.receiver, new Set([...seen, key]))]);
    return (per[0] ?? []).filter((g) => per.every((p) => p.includes(g)));
  };

  const controls: Control[] = [];
  for (const f of all) {
    const used = new Map<string, number>();
    for (const r of f.routes) {
      const guards = [
        ...appWide,
        ...inherited(f.file, r.receiver, new Set()),
        ...scoped(f.file, r.receiver),
        ...r.decorators.filter((d) => isGuard(d, f.file)),
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
        framework: "flask",
        guards: guards.filter((g, i) => guards.indexOf(g) === i),
      });
    }
  }
  return controls;
}

const mentionsFlask = (root: string, file: string): boolean => {
  try {
    return readFileSync(join(root, file), "utf8").toLowerCase().includes("flask");
  } catch {
    return false;
  }
};

export const flaskRoutes: Inventorier = {
  name: "flask-routes",
  handles: (p) => PY_FILE.test(p),
  expand(root, files) {
    // Decorators, blueprints and before_request hooks live in different files from the routes.
    if (!files.some((f) => PY_FILE.test(f) && mentionsFlask(root, f))) return files;
    return [...new Set([...files, ...listFiles(root).filter((f) => PY_FILE.test(f) && mentionsFlask(root, f))])];
  },
  async scan(root, files) {
    const cache = new FactsCache<FlaskFacts | { error: string }>("flask-1", root);
    const result: Inventory = { controls: [], unparsed: [] };
    const facts: FlaskFacts[] = [];
    for (const f of files.filter((p) => PY_FILE.test(p))) {
      let source: string;
      let st;
      try {
        st = statSync(join(root, f));
        source = readFileSync(join(root, f), "utf8");
      } catch {
        continue;
      }
      if (!source.toLowerCase().includes("flask")) continue;
      const entry = cache.get(f, st, () => factsForFile(f, source));
      if ("error" in entry) result.unparsed.push({ file: f, reason: entry.error });
      else facts.push(entry);
    }
    cache.save();
    result.controls = controlsFromFacts(facts);
    return result;
  },
};
