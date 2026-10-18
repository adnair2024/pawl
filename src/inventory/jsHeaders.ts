import { statSync } from "node:fs";
import { join } from "node:path";
import { isTestPath, listFiles, readSource } from "../files";
import type { Inventorier, Inventory } from "../types";
import { FactsCache } from "./factsCache";
import { CORS_ORIGIN_HEADER, HEADER_MARKER, canonicalHeader, controlsFromHeaderFacts, worstOrigin, type HeaderFacts, type Origin } from "./headerNames";
import { parseJs, type Node } from "./jsGuards";

const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const VERCEL = /(^|\/)vercel\.json$/;
const NETLIFY_HEADERS = /(^|\/)_headers$/;

/** helmet() options (and sub-middleware) mapped to the header each one controls. */
const HELMET: Record<string, string> = {
  contentSecurityPolicy: "Content-Security-Policy",
  crossOriginOpenerPolicy: "Cross-Origin-Opener-Policy",
  crossOriginResourcePolicy: "Cross-Origin-Resource-Policy",
  referrerPolicy: "Referrer-Policy",
  hsts: "Strict-Transport-Security",
  strictTransportSecurity: "Strict-Transport-Security",
  noSniff: "X-Content-Type-Options",
  xContentTypeOptions: "X-Content-Type-Options",
  frameguard: "X-Frame-Options",
  xFrameOptions: "X-Frame-Options",
};
/** What helmet() turns on when called with no options. */
const HELMET_DEFAULTS = new Set(["contentSecurityPolicy", "crossOriginOpenerPolicy", "crossOriginResourcePolicy", "referrerPolicy", "hsts", "noSniff", "frameguard"]);

const SET_HEADER_METHODS = new Set(["setHeader", "header", "set", "append", "add"]);
/** An enclosing check that decides which origins get through, so echoing the origin is safe. */
const ALLOW_CHECK = /(includes|\.has\(|indexOf|\.some\(|\.find\(|\.test\(|===|==|allowed|whitelist|allowlist|origins)/i;
const REQUEST_ORIGIN = /\breq(?:uest)?\.headers(?:\.origin|\[\s*['"]origin['"]\s*\]|\.get\(\s*['"]origin['"]\s*\))|\breq(?:uest)?\.(?:get|header)\(\s*['"]origin['"]\s*\)/i;

const unquote = (t: string): string => t.replace(/^[`'"]|[`'"]$/g, "");
/** The text of a string literal without quotes, or null if the node is not one. */
const strText = (n: Node | null | undefined): string | null => (n && (n.kind() === "string" || n.kind() === "template_string") ? unquote(n.text()) : null);

/** Is this expression the request's Origin header, directly or through a local variable? */
function readsRequestOrigin(value: Node): boolean {
  if (REQUEST_ORIGIN.test(value.text())) return true;
  if (value.kind() !== "identifier") return false;
  const name = value.text();
  const scope = value.ancestors().find((a) => /function|arrow_function|method_definition|program/.test(String(a.kind())));
  return (scope?.findAll({ rule: { kind: "variable_declarator" } }) ?? []).some(
    (d) => d.field("name")?.text() === name && REQUEST_ORIGIN.test(d.field("value")?.text() ?? ""),
  );
}

/** Echoing the request origin is only dangerous when nothing checks it against a list first. */
function originOf(value: Node | null | undefined): Origin {
  if (!value) return "allowlist";
  const literal = strText(value);
  if (literal !== null) return literal === "*" ? "wildcard" : "allowlist";
  if (!readsRequestOrigin(value)) return "allowlist";
  const guarded = value.ancestors().some((a) => {
    const k = String(a.kind());
    if (/function|arrow_function|method_definition/.test(k)) return false;
    const cond = k === "if_statement" || k === "ternary_expression" ? a.field("condition") : k === "binary_expression" ? a : null;
    return !!cond && ALLOW_CHECK.test(cond.text());
  });
  return guarded ? "allowlist" : "reflect";
}

/** The `cors({ origin })` package: no options means any origin. */
function corsPackageOrigin(call: Node): Origin {
  const arg = call.field("arguments")?.children().find((c) => c.isNamed());
  if (!arg) return "wildcard";
  if (arg.kind() !== "object") return "allowlist";
  const pair = arg.children().find((p) => p.kind() === "pair" && unquote(p.field("key")?.text() ?? "") === "origin");
  const v = pair?.field("value");
  if (!pair || !v) return "wildcard";
  if (v.text() === "true") return "reflect";
  if (v.text() === "false") return "none";
  const literal = strText(v);
  if (literal !== null) return literal === "*" ? "wildcard" : "allowlist";
  if (v.kind() === "arrow_function" || v.kind() === "function_expression") {
    const checks = v.findAll({ rule: { any: [{ kind: "if_statement" }, { kind: "ternary_expression" }] } }).length > 0 || ALLOW_CHECK.test(v.text());
    return !checks && /\(\s*null\s*,\s*(true|\w+)\s*\)/.test(v.text()) ? "reflect" : "allowlist";
  }
  return "allowlist";
}

/** Names bound to `helmet` / `cors` by import or require, so unrelated functions with those names are ignored. */
function localNames(root: Node, pkg: string): Set<string> {
  const names = new Set<string>();
  for (const imp of root.findAll({ rule: { kind: "import_statement" } })) {
    if (unquote(imp.field("source")?.text() ?? "") !== pkg) continue;
    for (const id of imp.findAll({ rule: { kind: "identifier" } })) names.add(id.text());
  }
  for (const d of root.findAll({ rule: { kind: "variable_declarator" } })) {
    const call = d.field("value")?.find({ rule: { kind: "call_expression" } });
    if (call?.field("function")?.text() === "require" && unquote(call.field("arguments")?.children().find((c) => c.isNamed())?.text() ?? "") === pkg) {
      const id = d.field("name");
      if (id?.kind() === "identifier") names.add(id.text());
    }
  }
  return names;
}

export function factsForFile(file: string, source: string): HeaderFacts | { error: string } {
  const parsed = parseJs(file, source);
  if ("error" in parsed) return parsed;
  const { root, lang } = parsed;
  const headers = new Set<string>();
  let cors: Origin | null = null;
  const note = (name: string, value?: Node | null): void => {
    const canon = canonicalHeader(name);
    if (!canon) return;
    if (canon === CORS_ORIGIN_HEADER) cors = worstOrigin(cors, originOf(value));
    else headers.add(canon);
  };

  // res.setHeader("X-Frame-Options", ...), headers.set(...), res.header(...)
  for (const call of root.findAll({ rule: { kind: "call_expression" } })) {
    const fn = call.field("function");
    const method = fn?.kind() === "member_expression" ? fn.field("property")?.text() : undefined;
    if (!method || !SET_HEADER_METHODS.has(method)) continue;
    const args = call.field("arguments")?.children().filter((c) => c.isNamed()) ?? [];
    const header = strText(args[0]);
    if (header !== null) note(header, args[1]);
  }

  // { "X-Frame-Options": "DENY" } and Next's { key: "X-Frame-Options", value: "DENY" }
  for (const obj of root.findAll({ rule: { kind: "object" } })) {
    const pairs = obj.children().filter((p) => p.kind() === "pair");
    const get = (k: string) => pairs.find((p) => unquote(p.field("key")?.text() ?? "") === k)?.field("value");
    const keyName = strText(get("key"));
    if (keyName && canonicalHeader(keyName)) note(keyName, get("value"));
    for (const p of pairs) {
      const name = unquote(p.field("key")?.text() ?? "");
      if (name !== "key" && canonicalHeader(name)) note(name, p.field("value"));
    }
  }

  // cors() package
  for (const local of localNames(root, "cors")) {
    for (const call of root.findAll({ rule: { kind: "call_expression" } })) {
      if (call.field("function")?.text() === local) cors = worstOrigin(cors, corsPackageOrigin(call));
    }
  }

  // helmet(): a bundle of headers, each of which can be switched off with `false`
  for (const local of localNames(root, "helmet")) {
    for (const call of root.findAll({ rule: { kind: "call_expression" } })) {
      const callee = call.field("function")?.text() ?? "";
      if (callee === local) {
        const opts = call.field("arguments")?.children().find((c) => c.kind() === "object");
        const off = new Set((opts?.children() ?? []).filter((p) => p.kind() === "pair" && p.field("value")?.text() === "false").map((p) => unquote(p.field("key")?.text() ?? "")));
        for (const opt of HELMET_DEFAULTS) {
          const header = HELMET[opt];
          if (header && !off.has(opt) && ![...off].some((o) => HELMET[o] === header)) headers.add(header);
        }
      } else if (callee.startsWith(`${local}.`)) {
        const header = HELMET[callee.slice(local.length + 1)];
        if (header) headers.add(header);
      }
    }
  }
  return { file, lang, headers: [...headers].sort(), cors };
}

/** vercel.json "headers" and Netlify/Cloudflare "_headers": structured config, not code. */
function factsForConfig(file: string, source: string): HeaderFacts | { error: string } {
  const headers = new Set<string>();
  let cors: Origin | null = null;
  const note = (name: string, value: string): void => {
    const canon = canonicalHeader(name);
    if (!canon) return;
    if (canon === CORS_ORIGIN_HEADER) cors = worstOrigin(cors, value.trim() === "*" ? "wildcard" : "allowlist");
    else headers.add(canon);
  };
  if (NETLIFY_HEADERS.test(file)) {
    for (const line of source.split("\n")) {
      const m = /^\s+([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
      if (m?.[1]) note(m[1], m[2] ?? "");
    }
  } else {
    let json: unknown;
    try {
      json = JSON.parse(source);
    } catch (e) {
      return { error: `invalid JSON: ${String(e)}` };
    }
    const rules = (json as { headers?: { headers?: { key?: string; value?: string }[] }[] }).headers;
    for (const rule of Array.isArray(rules) ? rules : []) {
      for (const h of Array.isArray(rule.headers) ? rule.headers : []) if (typeof h.key === "string") note(h.key, String(h.value ?? ""));
    }
  }
  return { file, lang: "js", headers: [...headers].sort(), cors };
}

const wanted = (p: string): boolean => (CODE_FILE.test(p) || VERCEL.test(p) || NETLIFY_HEADERS.test(p)) && !isTestPath(p);
const mentions = (root: string, file: string): boolean => {
  try {
    return HEADER_MARKER.test(readSource(join(root, file)));
  } catch {
    return false;
  }
};

export const jsHeaders: Inventorier = {
  name: "js-headers",
  handles: wanted,
  expand(root, files) {
    // A header can move between files, so any edit near headers re-reads every file that sets them.
    if (!files.some((f) => wanted(f) && mentions(root, f))) return files;
    return [...new Set([...files, ...listFiles(root).filter((f) => wanted(f) && mentions(root, f))])];
  },
  async scan(root, files) {
    const cache = new FactsCache<HeaderFacts | { error: string }>("headers-js-1", root);
    const result: Inventory = { controls: [], unparsed: [] };
    const facts: HeaderFacts[] = [];
    for (const f of files.filter(wanted)) {
      let source: string;
      let st;
      try {
        st = statSync(join(root, f));
        source = readSource(join(root, f));
      } catch {
        continue;
      }
      if (!HEADER_MARKER.test(source)) continue;
      const entry = cache.get(f, st, () => (CODE_FILE.test(f) ? factsForFile(f, source) : factsForConfig(f, source)));
      if ("error" in entry) result.unparsed.push({ file: f, reason: entry.error });
      else facts.push(entry);
    }
    cache.save();
    result.controls = controlsFromHeaderFacts(facts);
    return result;
  },
};
