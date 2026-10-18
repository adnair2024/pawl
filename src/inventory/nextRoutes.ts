import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Control, Inventorier, Inventory } from "../types";
import { guardsInBody, isFn, parseJs, unwrapAwait, GUARD_NAME, normalizeCallee, type Node } from "./jsGuards";

const ROUTE_FILE = /(^|\/)app\/(.*\/)?route\.(ts|tsx|js|jsx|mjs)$/;
const CODE_FILE = /\.(ts|tsx|js|jsx|mjs)$/;
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

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
  const parsed = parseJs(relPath, source);
  if ("error" in parsed) return { controls: [], unparsed: [{ file: relPath, reason: parsed.error }] };
  const { root, lang } = parsed;

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
        lang,
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
