import { statSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { listFiles, readSource } from "../files";
import type { Control, Inventorier, Inventory } from "../types";
import { FactsCache } from "./factsCache";
import { boundNames, checksAndDenies, denies, guardsInBody, isFn, normalizeCallee, parseJs, unwrapAwait, type Node } from "./jsGuards";

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

interface Use { pos: number; receiver: string; prefix: string | null; guards: string[] }
interface Mount { pos: number; receiver: string; prefix: string | null; guards: string[]; file: string; targetFile: string | null; targetReceiver: string | null; spec: string | null; fallback: string[] }
interface RawRoute { pos: number; receiver: string; method: string; path: string; own: string[] }
interface FileFacts { file: string; lang: "ts" | "js"; routes: RawRoute[]; uses: Use[]; mounts: Mount[] }

const stripQuotes = (t: string): string => t.replace(/^[`'"]|[`'"]$/g, "");
const isStringLike = (n: Node): boolean => ["string", "template_string"].includes(String(n.kind()));
const argsOf = (call: Node): Node[] => call.field("arguments")?.children().filter((c) => c.isNamed() && c.kind() !== "comment") ?? [];

/** The guard a middleware argument stands for, or null if it is not an auth guard. */
function guardOf(arg: Node): string | null {
  const kind = arg.kind();
  if (kind === "identifier" || kind === "member_expression") {
    const t = arg.text();
    return MIDDLEWARE_GUARD.test(t) && !NOT_A_GUARD.test(t) ? normalizeCallee(t) : null;
  }
  if (kind === "call_expression") {
    const callee = arg.field("function")?.text() ?? "";
    if (!MIDDLEWARE_GUARD.test(callee) || NOT_A_GUARD.test(callee)) return null;
    const first = argsOf(arg)[0];
    const name = normalizeCallee(callee);
    return first && isStringLike(first) ? `${name}(${stripQuotes(first.text())})` : name;
  }
  return null;
}

const guardsOfArgs = (args: Node[]): string[] =>
  args.flatMap((a) => (a.kind() === "array" ? a.children().filter((c) => c.isNamed()) : [a])).flatMap((a) => guardOf(a) ?? []);

/** The first function body reachable from a handler argument (unwraps `asyncHandler(async () => ...)`). */
function bodyOf(arg: Node | undefined, named: Map<string, Node>): Node | null {
  let cur: Node | null | undefined = arg ? unwrapAwait(arg) : null;
  for (let depth = 0; cur && depth < 4; depth++) {
    if (isFn(cur)) return cur.field("body");
    if (cur.kind() === "identifier") return named.get(cur.text()) ?? null;
    if (cur.kind() === "call_expression") cur = argsOf(cur).find((a) => isFn(a) || a.kind() === "call_expression" || a.kind() === "identifier");
    else return null;
  }
  return null;
}

/** `if (!req.user) return res.status(401)...` and `const t = req.headers.authorization; if (!t) ...` */
export function reqGuards(body: Node): string[] {
  const stmts = body.children().filter((c) => c.isNamed() && c.kind() !== "comment");
  const out: string[] = [];
  const credentialVars: string[] = [];
  for (const stmt of stmts) {
    if (stmt.kind() === "return_statement") break;
    if (stmt.kind() === "lexical_declaration") {
      const d = stmt.children().find((c) => c.kind() === "variable_declarator");
      if (d && REQ_CREDENTIAL.test(d.field("value")?.text() ?? "")) credentialVars.push(...boundNames(d.field("name")));
      continue;
    }
    if (stmt.kind() !== "if_statement") continue;
    const cond = stmt.field("condition");
    const branch = stmt.field("consequence");
    if (!cond || !branch || !denies(branch)) continue;
    const m = REQ_IDENTITY.exec(cond.text());
    if (m) out.push(`inline:req.${m[1] ?? m[2]}`);
    else if (credentialVars.length && checksAndDenies(stmt, credentialVars)) out.push("inline:credentials");
  }
  return out.filter((g, i) => out.indexOf(g) === i);
}

function importsOf(root: Node): Map<string, string> {
  const map = new Map<string, string>();
  for (const imp of root.findAll({ rule: { kind: "import_statement" } })) {
    const spec = stripQuotes(imp.field("source")?.text() ?? "");
    if (!spec.startsWith(".")) continue;
    const clause = imp.children().find((c) => c.kind() === "import_clause");
    for (const id of clause?.findAll({ rule: { kind: "identifier" } }) ?? []) map.set(id.text(), spec);
    const lone = clause?.children().find((c) => c.kind() === "identifier");
    if (lone) map.set(lone.text(), spec);
  }
  for (const d of root.findAll({ rule: { kind: "variable_declarator" } })) {
    const call = d.field("value")?.find({ rule: { kind: "call_expression" } });
    const callee = call?.field("function")?.text();
    const spec = call && callee === "require" ? stripQuotes(argsOf(call)[0]?.text() ?? "") : "";
    if (spec.startsWith(".")) for (const n of boundNames(d.field("name"))) map.set(n, spec);
  }
  return map;
}

function resolveSpec(fromFile: string, spec: string, known: Set<string>): string | null {
  const base = posix.normalize(posix.join(dirname(fromFile), spec));
  return EXT.map((e) => base + e).find((c) => known.has(c)) ?? null;
}

function routerVars(root: Node): Set<string> {
  const names = new Set(COMMON_RECEIVERS);
  for (const d of root.findAll({ rule: { kind: "variable_declarator" } })) {
    const v = unwrapAwait(d.field("value"));
    const callee = v?.kind() === "call_expression" ? v.field("function")?.text() : undefined;
    if (callee && /^(express|express\.Router|Router)$/.test(callee)) for (const n of boundNames(d.field("name"))) names.add(n);
  }
  return names;
}

function namedFunctions(root: Node): Map<string, Node> {
  const map = new Map<string, Node>();
  for (const f of root.findAll({ rule: { kind: "function_declaration" } })) {
    const name = f.field("name")?.text();
    const body = f.field("body");
    if (name && body) map.set(name, body);
  }
  for (const d of root.findAll({ rule: { kind: "variable_declarator" } })) {
    const v = d.field("value");
    const name = d.field("name");
    if (v && name?.kind() === "identifier" && isFn(v) && v.field("body")) map.set(name.text(), v.field("body") as Node);
  }
  return map;
}

/** Everything one file says about routes, router-wide guards, and where routers are mounted. */
export function factsForFile(file: string, source: string): FileFacts | { error: string } {
  const parsed = parseJs(file, source);
  if ("error" in parsed) return parsed;
  const { root, lang } = parsed;
  const receivers = routerVars(root);
  const imports = importsOf(root);
  const named = namedFunctions(root);
  const facts: FileFacts = { file, lang, routes: [], uses: [], mounts: [] };

  for (const call of root.findAll({ rule: { kind: "call_expression" } })) {
    const fn = call.field("function");
    if (!fn || fn.kind() !== "member_expression") continue;
    const method = fn.field("property")?.text() ?? "";
    const obj = fn.field("object");
    if (!obj) continue;
    const args = argsOf(call);
    const pos = call.range().start.index;

    if (method === "use" && obj.kind() === "identifier" && receivers.has(obj.text())) {
      const prefix = args[0] && isStringLike(args[0]) ? stripQuotes(args[0].text()) : null;
      const rest = prefix === null ? args : args.slice(1);
      const last = rest[rest.length - 1];
      let spec: string | null = null;
      let targetReceiver: string | null = null;
      if (last?.kind() === "identifier" && receivers.has(last.text()) && !COMMON_RECEIVERS.includes(last.text())) targetReceiver = last.text();
      else if (last?.kind() === "identifier" && imports.has(last.text())) spec = imports.get(last.text()) ?? null;
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
      } else {
        const guards = guardsOfArgs(rest);
        if (guards.length) facts.uses.push({ pos, receiver: obj.text(), prefix, guards });
      }
      continue;
    }

    if (!ROUTE_METHODS.has(method)) continue;
    let receiver: string | null = null;
    let path: string | null = null;
    let handlers: Node[] = args;
    if (obj.kind() === "identifier" && receivers.has(obj.text())) {
      // `app.get("env")` with a single argument is Express's settings getter, not a route.
      if (args.length < 2 || !args[0]) continue;
      receiver = obj.text();
      path = isStringLike(args[0]) ? stripQuotes(args[0].text()) : args[0].text();
      handlers = args.slice(1);
    } else {
      // app.route("/x").get(a).post(b)
      let cur: Node | null = obj;
      while (cur && cur.kind() === "call_expression" && cur.field("function")?.kind() === "member_expression") {
        const f: Node = cur.field("function") as Node;
        const m = f.field("property")?.text() ?? "";
        const o: Node | null = f.field("object");
        if (m === "route" && o?.kind() === "identifier" && receivers.has(o.text())) {
          const p = argsOf(cur)[0];
          receiver = o.text();
          path = p ? (isStringLike(p) ? stripQuotes(p.text()) : p.text()) : "";
          break;
        }
        if (!ROUTE_METHODS.has(m)) break;
        cur = o;
      }
    }
    if (receiver === null || path === null || handlers.length === 0) continue;
    const handler = handlers[handlers.length - 1];
    const own = guardsOfArgs(handlers.slice(0, -1));
    const body = bodyOf(handler, named);
    if (body) own.push(...guardsInBody(body), ...reqGuards(body));
    facts.routes.push({ pos, receiver, method: method.toUpperCase(), path, own });
  }
  return facts;
}

const prefixCovers = (prefix: string | null, path: string): boolean =>
  !prefix || prefix === "/" || !path.startsWith("/") || path.startsWith(prefix);

/** Combine per-file facts into one control per route, with guards inherited through mounts. */
export function controlsFromFacts(all: FileFacts[]): Control[] {
  const byFile = new Map(all.map((f) => [f.file, f]));
  const known = new Set(byFile.keys());
  const mountTarget = (m: Mount): string | null => (m.spec && !m.targetReceiver ? resolveSpec(m.file, m.spec, known) : m.targetFile);
  // `use(x)` is a mount only if x is a local router or a file that defines routes; otherwise x is middleware.
  const isMount = (m: Mount): boolean => m.targetReceiver !== null || (byFile.get(mountTarget(m) ?? "")?.routes.length ?? 0) > 0;
  const mounts = all.flatMap((f) => f.mounts).filter(isMount).map((m) => ({ ...m, targetFile: mountTarget(m) }));
  const usesByFile = new Map(
    all.map((f) => [
      f.file,
      [...f.uses, ...f.mounts.filter((m) => !isMount(m) && m.fallback.length).map((m) => ({ pos: m.pos, receiver: m.receiver, prefix: m.prefix, guards: m.fallback }))],
    ]),
  );
  const activeUses = (file: string, receiver: string, pos: number, path: string): string[] =>
    (usesByFile.get(file) ?? []).filter((u) => u.receiver === receiver && u.pos < pos && prefixCovers(u.prefix, path)).flatMap((u) => u.guards);

  const inherited = (file: string, receiver: string, path: string, seen: Set<string>): string[] => {
    const key = `${file}::${receiver}`;
    if (seen.has(key)) return [];
    const incoming = mounts.filter((m) => m.targetFile === file && (m.targetReceiver === null || m.targetReceiver === receiver));
    if (incoming.length === 0) return [];
    // A router mounted twice is only protected if every mount protects it.
    const perMount = incoming.map((m) => [
      ...m.guards,
      ...activeUses(m.file, m.receiver, m.pos, m.prefix ?? path),
      ...inherited(m.file, m.receiver, m.prefix ?? path, new Set([...seen, key])),
    ]);
    return (perMount[0] ?? []).filter((g) => perMount.every((p) => p.includes(g)));
  };

  const controls: Control[] = [];
  for (const f of all) {
    const used = new Map<string, number>();
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

const mentionsExpress = (root: string, file: string): boolean => {
  try {
    return readSource(join(root, file)).includes("express");
  } catch {
    return false;
  }
};

export const expressRoutes: Inventorier = {
  name: "express-routes",
  handles: (p) => CODE_FILE.test(p),
  expand(root, files) {
    // Mounting lives in a different file from the routes, so any Express edit re-reads them all.
    if (!files.some((f) => CODE_FILE.test(f) && mentionsExpress(root, f))) return files;
    const all = listFiles(root).filter((f) => CODE_FILE.test(f) && mentionsExpress(root, f));
    return [...new Set([...files, ...all])];
  },
  async scan(root, files) {
    const cache = new FactsCache<FileFacts | { error: string }>("express-1", root);
    const result: Inventory = { controls: [], unparsed: [] };
    const facts: FileFacts[] = [];
    for (const f of files.filter((p) => CODE_FILE.test(p))) {
      let st;
      let source: string;
      try {
        st = statSync(join(root, f));
        source = readSource(join(root, f));
      } catch {
        continue;
      }
      if (!source.includes("express")) continue;
      const entry = cache.get(f, st, () => factsForFile(f, source));
      if ("error" in entry) result.unparsed.push({ file: f, reason: entry.error });
      else facts.push(entry);
    }
    cache.save();
    result.controls = controlsFromFacts(facts);
    return result;
  },
};
