import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, type SgNode } from "@ast-grep/napi";
import type { Control, Inventorier, Inventory } from "../types";

const ROUTE_FILE = /(^|\/)app\/(.*\/)?route\.(ts|tsx|js|jsx|mjs)$/;
const CODE_FILE = /\.(ts|tsx|js|jsx|mjs)$/;
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/** Name shape of a call whose only purpose can be to block a request. */
const GUARD_NAME = /(auth|session|login|admin|permission|guard|protect|role|csrf)/i;
/** Words that mean "who is calling", used to tell auth checks from data checks. */
const IDENTITY = /(user|session|auth|token|account|principal|claims|identity|login|admin|role)/i;
const DENY_CALLS = new Set(["redirect", "permanentRedirect", "notFound", "forbidden", "unauthorized"]);

type Node = SgNode;

const isFn = (n: Node | null): boolean =>
  !!n && ["arrow_function", "function_expression", "function", "function_declaration"].includes(String(n.kind()));

const unwrapAwait = (n: Node | null): Node | null => {
  while (n && (n.kind() === "await_expression" || n.kind() === "parenthesized_expression")) {
    n = n.children().find((c) => c.isNamed()) ?? null;
  }
  return n;
};

/** `supabase.auth.getUser` and `client.auth.getUser` are the same guard: drop the local receiver name. */
const normalizeCallee = (callee: string): string => {
  const parts = callee.replace(/\?\./g, ".").split(".");
  return parts.length > 2 ? parts.slice(-2).join(".") : parts.join(".");
};

const lastSegment = (callee: string): string => callee.split(/[.?]+/).filter(Boolean).pop() ?? callee;

function boundNames(pattern: Node | null): string[] {
  if (!pattern) return [];
  const kinds = ["identifier", "shorthand_property_identifier_pattern"];
  const own = kinds.includes(String(pattern.kind())) ? [pattern.text()] : [];
  return [...own, ...pattern.findAll({ rule: { any: kinds.map((kind) => ({ kind })) } }).map((n) => n.text())];
}

/** Does this branch refuse the request: throw, redirect, or answer 401/403? */
function denies(branch: Node): boolean {
  const all = [branch, ...branch.findAll({ rule: { any: [{ kind: "throw_statement" }, { kind: "call_expression" }, { kind: "return_statement" }] } })];
  return all.some((n) => {
    const kind = n.kind();
    if (kind === "throw_statement") return true;
    if (kind === "call_expression") {
      const fn = n.field("function")?.text() ?? "";
      return DENY_CALLS.has(lastSegment(fn)) || /\bredirect$/.test(fn);
    }
    return kind === "return_statement" && /\b(401|403)\b/.test(n.text());
  });
}

function checksAndDenies(stmt: Node, vars: string[]): boolean {
  if (stmt.kind() !== "if_statement" || vars.length === 0) return false;
  const cond = stmt.field("condition");
  const consequence = stmt.field("consequence");
  if (!cond || !consequence) return false;
  const used = new Set(boundNames(cond));
  return vars.some((v) => used.has(v)) && denies(consequence);
}

/** Guards that run at the top of one handler body, in source order. */
export function guardsInBody(body: Node): string[] {
  const stmts = body.children().filter((c) => c.isNamed() && c.kind() !== "comment");
  const guards: string[] = [];
  const add = (g: string) => { if (!guards.includes(g)) guards.push(g); };

  stmts.forEach((stmt, i) => {
    if (stmt.kind() === "return_statement") return;
    let call: Node | null = null;
    let vars: string[] = [];
    if (stmt.kind() === "lexical_declaration") {
      const decl = stmt.children().find((c) => c.kind() === "variable_declarator");
      call = unwrapAwait(decl?.field("value") ?? null);
      vars = boundNames(decl?.field("name") ?? null);
    } else if (stmt.kind() === "expression_statement") {
      call = unwrapAwait(stmt.children().find((c) => c.isNamed()) ?? null);
    }
    if (!call || call.kind() !== "call_expression") return;
    const callee = call.field("function")?.text();
    if (!callee) return;

    const name = normalizeCallee(callee);
    if (vars.length) {
      // `const x = await helper()` is only a guard if a later `if` checks x (or something
      // derived from x) and refuses, and the call is about identity rather than data.
      const tracked = [...vars];
      const later = stmts.slice(i + 1);
      for (const s of later) {
        if (checksAndDenies(s, tracked) && (IDENTITY.test(callee) || vars.some((v) => IDENTITY.test(v)))) {
          add(name);
          break;
        }
        if (s.kind() === "lexical_declaration") {
          const d = s.children().find((c) => c.kind() === "variable_declarator");
          const used = new Set(boundNames(d?.field("value") ?? null));
          if (tracked.some((v) => used.has(v))) tracked.push(...boundNames(d?.field("name") ?? null));
        }
      }
    } else if (GUARD_NAME.test(callee)) {
      add(name);
    }
  });
  return guards;
}

interface Handler { name: string; body: Node | null; wrapperGuards: string[] }

function handlerFrom(exported: Node): Handler[] {
  const decl = exported.children().find((c) => c.isNamed() && c.kind() !== "decorator");
  if (!decl) return [];
  if (decl.kind() === "function_declaration") {
    const name = decl.field("name")?.text();
    return name ? [{ name, body: decl.field("body"), wrapperGuards: [] }] : [];
  }
  if (decl.kind() !== "lexical_declaration") return [];
  const out: Handler[] = [];
  for (const d of decl.children().filter((c) => c.kind() === "variable_declarator")) {
    const nameNode = d.field("name");
    if (!nameNode || nameNode.kind() !== "identifier") continue;
    let value = unwrapAwait(d.field("value"));
    const wrapperGuards: string[] = [];
    // export const POST = withAuth(async (req) => {...})
    while (value && value.kind() === "call_expression") {
      const callee = value.field("function")?.text() ?? "";
      if (GUARD_NAME.test(callee)) wrapperGuards.push(normalizeCallee(callee));
      value = value.field("arguments")?.children().find((c) => isFn(c) || c.kind() === "call_expression") ?? null;
    }
    out.push({ name: nameNode.text(), body: value && isFn(value) ? value.field("body") : null, wrapperGuards });
  }
  return out;
}

const hasUseServer = (root: Node): boolean =>
  root.children().some((c) => c.kind() === "expression_statement" && /^["']use server["']$/.test(c.text().replace(/;$/, "")));

export function inventoryNextFile(relPath: string, source: string): Inventory {
  const lang = relPath.endsWith("x") ? "Tsx" : relPath.endsWith(".ts") ? "TypeScript" : "JavaScript";
  let root: Node;
  try {
    root = parse(lang, source).root();
  } catch (e) {
    return { controls: [], unparsed: [{ file: relPath, reason: String(e) }] };
  }
  if (root.findAll({ rule: { kind: "ERROR" } }).length > 0) {
    return { controls: [], unparsed: [{ file: relPath, reason: "syntax error; guards not inventoried" }] };
  }

  const isRoute = ROUTE_FILE.test(relPath);
  const isAction = !isRoute && hasUseServer(root);
  if (!isRoute && !isAction) return { controls: [], unparsed: [] };

  const controls: Control[] = [];
  for (const exp of root.children().filter((c) => c.kind() === "export_statement")) {
    for (const h of handlerFrom(exp)) {
      if (isRoute && !HTTP_METHODS.has(h.name)) continue;
      const guards = [...h.wrapperGuards, ...(h.body ? guardsInBody(h.body) : [])];
      controls.push({
        kind: "route-auth",
        id: `${relPath}#${h.name}`,
        file: relPath,
        lang: lang === "JavaScript" ? "js" : "ts",
        framework: isRoute ? "next-route" : "next-action",
        guards,
      });
    }
  }
  return { controls, unparsed: [] };
}

export const nextRoutes: Inventorier = {
  name: "next-routes",
  handles: (p) => CODE_FILE.test(p),
  async scan(root, files) {
    const result: Inventory = { controls: [], unparsed: [] };
    for (const f of files.filter((p) => CODE_FILE.test(p))) {
      let source: string;
      try { source = readFileSync(join(root, f), "utf8"); } catch { continue; }
      if (!ROUTE_FILE.test(f) && !source.includes("use server")) continue;
      const r = inventoryNextFile(f, source);
      result.controls.push(...r.controls);
      result.unparsed.push(...r.unparsed);
    }
    return result;
  },
};
