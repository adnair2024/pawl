import { parse, type SgNode } from "@ast-grep/napi";

/** Guard-learning helpers shared by every JS/TS framework reader. */

/** Parse a JS/TS file; null means it could not be parsed and must be reported, never trusted. */
export function parseJs(relPath: string, source: string): { root: Node; lang: "ts" | "js" } | { error: string } {
  const lang = /\.(tsx|jsx)$/.test(relPath) ? "Tsx" : relPath.endsWith(".ts") ? "TypeScript" : "JavaScript";
  try {
    const root = parse(lang, source).root();
    if (root.findAll({ rule: { kind: "ERROR" } }).length > 0) return { error: "syntax error; guards not inventoried" };
    return { root, lang: lang === "JavaScript" ? "js" : "ts" };
  } catch (e) {
    return { error: String(e) };
  }
}

/** Name shape of a call whose only purpose can be to block a request. */
export const GUARD_NAME = /(auth|session|login|admin|permission|guard|protect|role|csrf)/i;
/** Words that mean "who is calling", used to tell auth checks from data checks. */
export const IDENTITY = /(user|session|auth|token|account|principal|claims|identity|login|admin|role)/i;
export const DENY_CALLS = new Set(["redirect", "permanentRedirect", "notFound", "forbidden", "unauthorized"]);

export type Node = SgNode;

export const isFn = (n: Node | null): boolean =>
  !!n && ["arrow_function", "function_expression", "function", "function_declaration"].includes(String(n.kind()));

export const unwrapAwait = (n: Node | null): Node | null => {
  while (n && (n.kind() === "await_expression" || n.kind() === "parenthesized_expression")) {
    n = n.children().find((c) => c.isNamed()) ?? null;
  }
  return n;
};

/** `supabase.auth.getUser` and `client.auth.getUser` are the same guard: drop the local receiver name. */
export const normalizeCallee = (callee: string): string => {
  const parts = callee.replace(/\?\./g, ".").split(".");
  return parts.length > 2 ? parts.slice(-2).join(".") : parts.join(".");
};

export const lastSegment = (callee: string): string => callee.split(/[.?]+/).filter(Boolean).pop() ?? callee;

export function boundNames(pattern: Node | null): string[] {
  if (!pattern) return [];
  const kinds = ["identifier", "shorthand_property_identifier_pattern"];
  const own = kinds.includes(String(pattern.kind())) ? [pattern.text()] : [];
  return [...own, ...pattern.findAll({ rule: { any: kinds.map((kind) => ({ kind })) } }).map((n) => n.text())];
}

/** Does this branch refuse the request: throw, redirect, or answer 401/403? */
export function denies(branch: Node): boolean {
  const all = [branch, ...branch.findAll({ rule: { any: [{ kind: "throw_statement" }, { kind: "call_expression" }, { kind: "return_statement" }] } })];
  return all.some((n) => {
    const kind = n.kind();
    if (kind === "throw_statement") return true;
    if (kind === "call_expression") {
      const fn = n.field("function")?.text() ?? "";
      if (/\.(status|sendStatus)\(\s*(401|403)\b/.test(n.text())) return true; // Express: res.status(401)...
      if (fn === "next" && (n.field("arguments")?.children().filter((c) => c.isNamed()).length ?? 0) > 0) return true; // next(err)
      return DENY_CALLS.has(lastSegment(fn)) || /\bredirect$/.test(fn);
    }
    return kind === "return_statement" && /\b(401|403)\b/.test(n.text());
  });
}

export function checksAndDenies(stmt: Node, vars: string[]): boolean {
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

