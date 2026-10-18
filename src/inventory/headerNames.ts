import type { Control } from "../types";

/** The response headers pawl treats as security controls, in their canonical spelling. */
export const SECURITY_HEADERS = [
  "Content-Security-Policy",
  "Strict-Transport-Security",
  "X-Frame-Options",
  "X-Content-Type-Options",
  "Referrer-Policy",
  "Permissions-Policy",
  "Cross-Origin-Opener-Policy",
  "Cross-Origin-Resource-Policy",
  "Cross-Origin-Embedder-Policy",
] as const;

export const CORS_ORIGIN_HEADER = "Access-Control-Allow-Origin";

const BY_LOWER = new Map<string, string>([...SECURITY_HEADERS, CORS_ORIGIN_HEADER].map((h) => [h.toLowerCase(), h]));

/** "x-frame-options" -> "X-Frame-Options"; undefined if it is not a header we track. */
export const canonicalHeader = (name: string): string | undefined => BY_LOWER.get(name.trim().toLowerCase());

/** Cheap pre-filter so files that never mention headers or CORS are not parsed at all. */
export const HEADER_MARKER =
  /access-control|helmet|cors|x-frame|strict-transport|content-security|referrer-policy|x-content-type|permissions-policy|cross-origin-|talisman|secure_|x_frame|securitymiddleware|xframeoptions/i;

export type Origin = "none" | "allowlist" | "reflect" | "wildcard";
export const ORIGIN_RANK: Record<Origin, number> = { none: 0, allowlist: 1, reflect: 2, wildcard: 3 };

export interface HeaderFacts {
  file: string;
  lang: "ts" | "js" | "py";
  /** Security headers this file sets (canonical names). */
  headers: string[];
  /** The most permissive CORS origin rule found in this file, or null if it has none. */
  cors: Origin | null;
}

/**
 * Headers are tracked project-wide (is X-Frame-Options set anywhere?), so moving one
 * between files is not a regression. CORS is tracked per file, where it lives.
 */
export function controlsFromHeaderFacts(all: HeaderFacts[]): Control[] {
  const controls: Control[] = [];
  const seen = new Set<string>();
  for (const f of [...all].sort((a, b) => (a.file < b.file ? -1 : 1))) {
    for (const header of f.headers) {
      if (seen.has(header)) continue;
      seen.add(header);
      controls.push({ kind: "header", id: `header:${header}`, file: f.file, lang: f.lang, header });
    }
    if (f.cors) controls.push({ kind: "cors", id: `${f.file}#cors`, file: f.file, lang: f.lang, origin: f.cors });
  }
  return controls;
}

export const worstOrigin = (a: Origin | null, b: Origin | null): Origin | null =>
  !a ? b : !b ? a : ORIGIN_RANK[b] > ORIGIN_RANK[a] ? b : a;
