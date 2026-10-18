export type Lang = "ts" | "js" | "py" | "sql";

export const BASELINE_VERSION = 1;

/** A security control that exists in the project today. Language-agnostic. */
export type Control =
  | {
      kind: "route-auth";
      id: string; // e.g. "app/api/users/route.ts#GET"
      file: string;
      lang: Lang;
      framework: string;
      /** Guards that run before the handler body. Empty means unprotected. */
      guards: string[];
    }
  | {
      kind: "rls-table";
      id: string; // e.g. "public.profiles"
      file: string;
      lang: "sql";
      rlsEnabled: boolean;
      policies: { name: string; command: string; permissive: boolean }[];
    }
  | {
      kind: "cors";
      id: string;
      file: string;
      lang: Lang;
      origin: "none" | "allowlist" | "wildcard" | "reflect";
    }
  | {
      kind: "header";
      id: string; // e.g. "next.config.js#Content-Security-Policy"
      file: string;
      lang: Lang;
      header: string;
    };

export interface Baseline {
  version: number;
  createdAt: string;
  controls: Control[];
  /** Things we could not parse. Reported, never treated as safe. */
  unparsed: { file: string; reason: string }[];
}

export interface Regression {
  controlId: string;
  file: string;
  kind: Control["kind"];
  summary: string;
  restore: string;
}

export interface Inventory {
  controls: Control[];
  unparsed: { file: string; reason: string }[];
}

/** One implementation per language/framework family. */
export interface Inventorier {
  name: string;
  /** Cheap filename test so hooks can re-inventory only touched files. */
  handles(relPath: string): boolean;
  scan(root: string, files: string[]): Promise<Inventory>;
}
