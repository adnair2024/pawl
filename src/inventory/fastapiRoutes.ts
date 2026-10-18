import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { listFiles } from "../files";
import type { Control, Inventorier, Inventory } from "../types";
import { FactsCache } from "./factsCache";
import { DefIndex, bodyDenies, importsOf, inlineGuards, keyword, lastSegment, parsePy, positional, resolveRef, strOf, type PyImport, type PyNode } from "./pyShared";

const PY_FILE = /\.py$/;
const HTTP = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);
/** Names that mean "this checks who is calling", for dependencies we cannot read (third-party, class instances). */
const GUARD_NAME = /(auth|current_user|get_user|verify|token|permission|require|role|admin|login|session|api_key|apikey|oauth|bearer|jwt|credential|security|guard|protect)/i;

interface Include {
  receiver: string;
  deps: string[];
  /** `include_router(router)` has ident; `include_router(users.router)` has obj + attr. */
  ident: string | null;
  obj: string | null;
  attr: string | null;
}
interface PyFacts {
  file: string;
  imports: PyImport[];
  defs: { name: string; denies: boolean; deps: string[] }[];
  classes: { name: string; denies: boolean }[];
  /** Variables built with `auto_error=False`: they identify a caller but never refuse one. */
  weak: string[];
  /** Auth middleware attached to an app or router. `denies` is null when only the class name is known. */
  middleware: { receiver: string; label: string; name: string; denies: boolean | null }[];
  vars: { name: string; deps: string[] }[];
  includes: Include[];
  routes: { receiver: string; method: string; path: string; deps: string[]; inline: string[] }[];
}

/** `get_user` -> "get_user"; `require_role("admin")` -> "require_role(admin)"; `auth.get_user` -> "get_user". */
function depLabel(arg: PyNode | undefined): string | null {
  if (!arg) return null;
  if (arg.kind() === "identifier") return arg.text();
  if (arg.kind() === "attribute") return lastSegment(arg.text());
  if (arg.kind() === "call") {
    const callee = lastSegment(arg.field("function")?.text() ?? "");
    const first = strOf(positional(arg)[0]);
    return callee ? (first ? `${callee}(${first})` : callee) : null;
  }
  return null;
}

/** Every `Depends(x)` / `Security(x)` inside `node`: parameters, Annotated types, dependencies=[...]. */
function dependsIn(node: PyNode | null | undefined): string[] {
  if (!node) return [];
  const out: string[] = [];
  for (const c of node.findAll({ rule: { kind: "call" } })) {
    const fn = lastSegment(c.field("function")?.text() ?? "");
    if (fn !== "Depends" && fn !== "Security") continue;
    const label = depLabel(positional(c)[0]);
    if (label) out.push(label);
  }
  return out;
}

export function factsForFile(file: string, source: string): PyFacts | { error: string } {
  const parsed = parsePy(source);
  if ("error" in parsed) return parsed;
  const { root } = parsed;
  const facts: PyFacts = { file, imports: importsOf(root), defs: [], classes: [], weak: [], middleware: [], vars: [], includes: [], routes: [] };

  for (const fn of root.findAll({ rule: { kind: "function_definition" } })) {
    const name = fn.field("name")?.text();
    const body = fn.field("body");
    if (name && body) facts.defs.push({ name, denies: bodyDenies(body), deps: dependsIn(fn.field("parameters")) });
  }

  for (const c of root.findAll({ rule: { kind: "class_definition" } })) {
    const name = c.field("name")?.text();
    const body = c.field("body");
    if (name && body) facts.classes.push({ name, denies: bodyDenies(body) });
  }

  for (const a of root.findAll({ rule: { kind: "assignment" } })) {
    const left = a.field("left");
    const right = a.field("right");
    if (left?.kind() !== "identifier" || right?.kind() !== "call") continue;
    if (keyword(right, "auto_error")?.text() === "False") facts.weak.push(left.text());
    if (!/^(FastAPI|APIRouter)$/.test(lastSegment(right.field("function")?.text() ?? ""))) continue;
    facts.vars.push({ name: left.text(), deps: dependsIn(keyword(right, "dependencies")) });
  }

  for (const call of root.findAll({ rule: { kind: "call" } })) {
    const fn = call.field("function");
    const verb = fn?.kind() === "attribute" ? fn.field("attribute")?.text() : undefined;
    const owner = fn?.field("object");
    if (verb === "add_middleware" && owner?.kind() === "identifier") {
      const cls = lastSegment(positional(call)[0]?.text() ?? "");
      if (cls) facts.middleware.push({ receiver: owner.text(), label: `middleware:${cls}`, name: cls, denies: null });
      continue;
    }
    if ((verb === "add_api_route" || verb === "add_api_websocket_route") && owner?.kind() === "identifier") {
      const path = strOf(positional(call)[0]);
      const endpoint = positional(call)[1];
      const methods = keyword(call, "methods")?.find({ rule: { kind: "string" } });
      const def = endpoint?.kind() === "identifier" ? facts.defs.find((d) => d.name === endpoint.text()) : undefined;
      if (path === null) continue;
      facts.routes.push({
        receiver: owner.text(),
        method: verb === "add_api_websocket_route" ? "WS" : (strOf(methods ?? null) ?? "GET").toUpperCase(),
        path,
        deps: [...dependsIn(keyword(call, "dependencies")), ...(def?.deps ?? [])],
        inline: [],
      });
      continue;
    }
    if (verb !== "include_router") continue;
    const recv = owner;
    const target = positional(call)[0];
    if (recv?.kind() !== "identifier" || !target) continue;
    const inc: Include = { receiver: recv.text(), deps: dependsIn(keyword(call, "dependencies")), ident: null, obj: null, attr: null };
    if (target.kind() === "identifier") inc.ident = target.text();
    else if (target.kind() === "attribute" && target.field("object")?.kind() === "identifier") {
      inc.obj = target.field("object")?.text() ?? null;
      inc.attr = target.field("attribute")?.text() ?? null;
    } else continue;
    facts.includes.push(inc);
  }

  for (const dd of root.findAll({ rule: { kind: "decorated_definition" } })) {
    const fn = dd.children().find((c) => c.kind() === "function_definition");
    if (!fn) continue;
    for (const dec of dd.children().filter((c) => c.kind() === "decorator")) {
      const call = dec.children().find((c) => c.kind() === "call");
      const callee = call?.field("function");
      if (!call || callee?.kind() !== "attribute" || callee.field("object")?.kind() !== "identifier") continue;
      const verb = callee.field("attribute")?.text() ?? "";
      if (verb === "middleware") {
        const body = fn.field("body");
        const name = fn.field("name")?.text();
        if (body && name) facts.middleware.push({ receiver: callee.field("object")?.text() ?? "", label: `middleware:${name}`, name, denies: bodyDenies(body) });
        continue;
      }
      if (!HTTP.has(verb) && verb !== "api_route" && verb !== "websocket") continue;
      const path = strOf(positional(call)[0]) ?? strOf(keyword(call, "path")) ?? "<dynamic>";
      facts.routes.push({
        receiver: callee.field("object")?.text() ?? "",
        method: verb === "api_route" ? "ANY" : verb === "websocket" ? "WS" : verb.toUpperCase(),
        path,
        deps: [...dependsIn(keyword(call, "dependencies")), ...dependsIn(fn.field("parameters"))],
        inline: inlineGuards(fn.field("body")),
      });
    }
  }
  return facts;
}

export function controlsFromFacts(all: PyFacts[]): Control[] {
  const known = new Set(all.map((f) => f.file));
  const byFile = new Map(all.map((f) => [f.file, f]));
  const index = new DefIndex(all);
  const weak = new Set(all.flatMap((f) => f.weak));
  const classDenies = new Map(all.flatMap((f) => f.classes.map((c) => [c.name, c.denies] as const)));
  const middlewareGuard = new Map<string, boolean>();
  for (const f of all) for (const m of f.middleware) middlewareGuard.set(m.label, m.denies ?? classDenies.get(m.name) ?? GUARD_NAME.test(m.name));

  /** A dependency guards if the project's own definition refuses callers (directly or via its own dependencies). */
  const isGuard = (label: string, file: string, depth = 0): boolean => {
    if (label.startsWith("middleware:")) return middlewareGuard.get(label) ?? false;
    const base = label.split("(")[0] ?? label;
    if (weak.has(base) || /optional/i.test(base)) return false;
    const found = index.lookup(base, file);
    if (found.length) return depth < 4 && found.every((d) => d.def.denies || d.def.deps.some((x) => isGuard(x, d.file, depth + 1)));
    return GUARD_NAME.test(base);
  };

  const edges = all.flatMap((f) =>
    f.includes.flatMap((inc) => {
      const t = resolveRef({ file: f.file, imports: f.imports, varNames: f.vars.map((v) => v.name) }, inc, known);
      return t ? [{ from: f.file, receiver: inc.receiver, deps: inc.deps, to: t }] : [];
    }),
  );
  const ownDeps = (file: string, name: string): string[] => [
    ...(byFile.get(file)?.vars.find((v) => v.name === name)?.deps ?? []),
    ...(byFile.get(file)?.middleware.filter((m) => m.receiver === name).map((m) => m.label) ?? []),
  ];

  const inherited = (file: string, name: string, seen: Set<string>): string[] => {
    const key = `${file}::${name}`;
    if (seen.has(key)) return [];
    const incoming = edges.filter((e) => e.to.file === file && e.to.name === name);
    if (incoming.length === 0) return [];
    // A router included in two places is only protected if every place protects it.
    const per = incoming.map((e) => [...e.deps.filter((d) => isGuard(d, e.from)), ...ownDeps(e.from, e.receiver).filter((d) => isGuard(d, e.from)), ...inherited(e.from, e.receiver, new Set([...seen, key]))]);
    return (per[0] ?? []).filter((g) => per.every((p) => p.includes(g)));
  };

  const controls: Control[] = [];
  for (const f of all) {
    const used = new Map<string, number>();
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

const mentionsFastapi = (root: string, file: string): boolean => {
  try {
    const src = readFileSync(join(root, file), "utf8");
    return src.includes("fastapi") || src.includes("starlette");
  } catch {
    return false;
  }
};

export const fastapiRoutes: Inventorier = {
  name: "fastapi-routes",
  handles: (p) => PY_FILE.test(p),
  expand(root, files) {
    // Dependencies and routers live in different files from the routes that use them.
    if (!files.some((f) => PY_FILE.test(f) && mentionsFastapi(root, f))) return files;
    return [...new Set([...files, ...listFiles(root).filter((f) => PY_FILE.test(f) && mentionsFastapi(root, f))])];
  },
  async scan(root, files) {
    const cache = new FactsCache<PyFacts | { error: string }>("fastapi-2", root);
    const result: Inventory = { controls: [], unparsed: [] };
    const facts: PyFacts[] = [];
    for (const f of files.filter((p) => PY_FILE.test(p))) {
      let source: string;
      let st;
      try {
        st = statSync(join(root, f));
        source = readFileSync(join(root, f), "utf8");
      } catch {
        continue;
      }
      if (!source.includes("fastapi") && !source.includes("starlette")) continue;
      const entry = cache.get(f, st, () => factsForFile(f, source));
      if ("error" in entry) result.unparsed.push({ file: f, reason: entry.error });
      else facts.push(entry);
    }
    cache.save();
    result.controls = controlsFromFacts(facts);
    return result;
  },
};
