import { readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { listFiles } from "../files";
import type { Control, Inventorier, Inventory } from "../types";
import { FactsCache } from "./factsCache";

const MIGRATION = /(^|\/)supabase\/migrations\/.*\.sql$/;
/** Roles that bypass row-level security anyway, so a `true` policy for them opens nothing. */
const ADMIN_ROLES = new Set(["service_role", "postgres", "supabase_admin"]);
/** Part of a DO block / function we cannot follow, and which may touch RLS. */
const MENTIONS_RLS = /row\s+level\s+security|create\s+policy|alter\s+policy|drop\s+policy/i;

type Expr = "true" | "expr" | "none";
type Op =
  | { t: "create"; table: string; ifNotExists: boolean }
  | { t: "rls"; table: string; enabled: boolean }
  | { t: "policy"; table: string; name: string; mode: "create" | "alter"; command?: string; restrictive?: boolean; roles?: string[]; using?: Expr; check?: Expr }
  | { t: "dropPolicy"; table: string; name: string }
  | { t: "dropTable"; table: string }
  | { t: "rename"; table: string; to: string }
  | { t: "setSchema"; table: string; schema: string };
interface SqlFacts { file: string; ops: Op[]; partial: string[] }

type Json = { [k: string]: unknown };
const obj = (v: unknown): Json | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const key = (rel: unknown): string | undefined => {
  const r = obj(rel);
  const name = str(r?.relname);
  return name ? `${str(r?.schemaname) ?? "public"}.${name}` : undefined;
};

/** pg's AST drops default values: `true` is {boolval:{boolval:true}}, `false` is {boolval:{}}. */
function exprKind(e: unknown): Expr {
  if (!e) return "none";
  const c = obj(obj(e)?.A_Const);
  return obj(c?.boolval)?.boolval === true ? "true" : "expr";
}

const rolesOf = (roles: unknown): string[] => {
  const out = list(roles).map((r) => {
    const spec = obj(obj(r)?.RoleSpec);
    return spec?.roletype === "ROLESPEC_CSTRING" ? (str(spec.rolename) ?? "") : "public";
  });
  return out.length ? out : ["public"];
};

const names = (items: unknown): string[] => list(items).map((i) => str(obj(obj(i)?.String)?.sval) ?? "");

/** Statements that do not affect row-level security are skipped, not misread. */
export async function factsForSql(file: string, sql: string): Promise<SqlFacts | { error: string }> {
  let result;
  try {
    // Loaded here, not at the top, so runs that hit the cache never pay for the WASM parser.
    const pg = require("libpg-query") as typeof import("libpg-query");
    await pg.loadModule();
    result = await pg.parse(sql);
  } catch (e) {
    const message = String(e instanceof Error ? e.message : e);
    // An empty or comment-only migration is valid; it just has no statements.
    if (/query cannot be empty/i.test(message)) return { file, ops: [], partial: [] };
    return { error: message };
  }
  const facts: SqlFacts = { file, ops: [], partial: [] };
  for (const raw of result.stmts ?? []) {
    const node = obj(raw.stmt) ?? {};
    const kind = Object.keys(node)[0];
    const s = obj(node[kind ?? ""]);
    if (!kind || !s) continue;

    if (kind === "CreateStmt") {
      if (obj(s.relation)?.relpersistence === "t") continue; // temp tables are not part of the API
      const table = key(s.relation);
      if (table) facts.ops.push({ t: "create", table, ifNotExists: s.if_not_exists === true });
    } else if (kind === "AlterTableStmt" && s.objtype === "OBJECT_TABLE") {
      const table = key(s.relation);
      for (const c of list(s.cmds)) {
        const sub = obj(obj(c)?.AlterTableCmd)?.subtype;
        if (table && sub === "AT_EnableRowSecurity") facts.ops.push({ t: "rls", table, enabled: true });
        if (table && sub === "AT_DisableRowSecurity") facts.ops.push({ t: "rls", table, enabled: false });
      }
    } else if (kind === "CreatePolicyStmt" || kind === "AlterPolicyStmt") {
      const table = key(s.table);
      const name = str(s.policy_name);
      if (!table || !name) continue;
      const create = kind === "CreatePolicyStmt";
      facts.ops.push({
        t: "policy", table, name, mode: create ? "create" : "alter",
        command: create ? (str(s.cmd_name) ?? "all") : undefined,
        restrictive: create ? s.permissive !== true : undefined,
        roles: create || s.roles ? rolesOf(s.roles) : undefined,
        using: create || s.qual ? exprKind(s.qual) : undefined,
        check: create || s.with_check ? exprKind(s.with_check) : undefined,
      });
    } else if (kind === "DropStmt") {
      for (const o of list(s.objects)) {
        const parts = names(obj(obj(o)?.List)?.items);
        if (s.removeType === "OBJECT_POLICY" && parts.length >= 2) {
          const name = parts[parts.length - 1] ?? "";
          const table = `${parts.length === 3 ? parts[0] : "public"}.${parts[parts.length - 2]}`;
          facts.ops.push({ t: "dropPolicy", table, name });
        } else if (s.removeType === "OBJECT_TABLE" && parts.length >= 1) {
          facts.ops.push({ t: "dropTable", table: `${parts.length === 2 ? parts[0] : "public"}.${parts[parts.length - 1]}` });
        }
      }
    } else if (kind === "RenameStmt" && s.renameType === "OBJECT_TABLE") {
      const table = key(s.relation);
      if (table && str(s.newname)) facts.ops.push({ t: "rename", table, to: str(s.newname) as string });
    } else if (kind === "AlterObjectSchemaStmt" && s.objectType === "OBJECT_TABLE") {
      const table = key(s.relation);
      if (table && str(s.newschema)) facts.ops.push({ t: "setSchema", table, schema: str(s.newschema) as string });
    } else if (kind === "DoStmt") {
      const start = raw.stmt_location ?? 0;
      const text = sql.slice(start, raw.stmt_len ? start + raw.stmt_len : undefined);
      if (MENTIONS_RLS.test(text)) facts.partial.push("a DO block that may change row-level security was not analyzed");
    }
  }
  return facts;
}

interface Policy { command: string; restrictive: boolean; roles: string[]; using: Expr; check: Expr }
interface TableState { file: string; rls: boolean; policies: Map<string, Policy> }

const isOpen = (p: Policy): boolean =>
  !p.restrictive && (p.using === "true" || p.check === "true") && p.roles.some((r) => !ADMIN_ROLES.has(r));

/** Replay one migrations folder in order, the way Postgres would. */
function replay(files: SqlFacts[]): Map<string, TableState> {
  const tables = new Map<string, TableState>();
  const ensure = (table: string, file: string): TableState => {
    let t = tables.get(table);
    if (!t) tables.set(table, (t = { file, rls: false, policies: new Map() }));
    return t;
  };
  for (const f of files) {
    for (const op of f.ops) {
      switch (op.t) {
        case "create":
          if (!(op.ifNotExists && tables.has(op.table))) tables.set(op.table, { file: f.file, rls: false, policies: new Map() });
          break;
        case "rls":
          ensure(op.table, f.file).rls = op.enabled;
          break;
        case "policy": {
          const t = ensure(op.table, f.file);
          const old = t.policies.get(op.name);
          if (op.mode === "alter" && !old) break;
          t.policies.set(op.name, {
            command: op.command ?? old?.command ?? "all",
            restrictive: op.restrictive ?? old?.restrictive ?? false,
            roles: op.roles ?? old?.roles ?? ["public"],
            using: op.using ?? old?.using ?? "none",
            check: op.check ?? old?.check ?? "none",
          });
          break;
        }
        case "dropPolicy":
          tables.get(op.table)?.policies.delete(op.name);
          break;
        case "dropTable":
          tables.delete(op.table);
          break;
        case "rename": {
          const t = tables.get(op.table);
          if (t) {
            tables.delete(op.table);
            tables.set(`${op.table.split(".")[0]}.${op.to}`, t);
          }
          break;
        }
        case "setSchema": {
          const t = tables.get(op.table);
          if (t) {
            tables.delete(op.table);
            tables.set(`${op.schema}.${op.table.split(".")[1]}`, t);
          }
          break;
        }
      }
    }
  }
  return tables;
}

export function controlsFromSql(all: SqlFacts[]): Control[] {
  const byDir = new Map<string, SqlFacts[]>();
  for (const f of all) {
    const dir = f.file.slice(0, f.file.lastIndexOf("/migrations/"));
    byDir.set(dir, [...(byDir.get(dir) ?? []), f]);
  }
  const controls: Control[] = [];
  for (const [dir, files] of byDir) {
    files.sort((a, b) => (posix.basename(a.file) < posix.basename(b.file) ? -1 : 1));
    for (const [table, state] of replay(files)) {
      // Only the `public` schema is exposed through Supabase's API by default.
      if (!table.startsWith("public.")) continue;
      controls.push({
        kind: "rls-table",
        id: dir === "supabase" ? table : `${dir}:${table}`,
        file: state.file,
        lang: "sql",
        rlsEnabled: state.rls,
        policies: [...state.policies]
          .map(([name, p]) => ({ name, command: p.command, open: isOpen(p) }))
          .sort((a, b) => (a.name < b.name ? -1 : 1)),
      });
    }
  }
  return controls;
}

export const supabaseRls: Inventorier = {
  name: "supabase-rls",
  handles: (p) => MIGRATION.test(p),
  expand(root, files) {
    // Every migration builds on the ones before it, so any edit replays the whole folder.
    if (!files.some((f) => MIGRATION.test(f))) return files;
    return [...new Set([...files, ...listFiles(root).filter((f) => MIGRATION.test(f))])];
  },
  async scan(root, files) {
    const cache = new FactsCache<SqlFacts | { error: string }>("rls-1", root);
    const result: Inventory = { controls: [], unparsed: [], partial: [] };
    const facts: SqlFacts[] = [];
    for (const f of files.filter((p) => MIGRATION.test(p))) {
      let sql: string;
      let st;
      try {
        st = statSync(join(root, f));
        sql = readFileSync(join(root, f), "utf8");
      } catch {
        continue;
      }
      const entry = await cache.getAsync(f, st, () => factsForSql(f, sql));
      if ("error" in entry) {
        result.unparsed.push({ file: f, reason: entry.error });
        continue;
      }
      facts.push(entry);
      for (const reason of entry.partial) result.partial?.push({ file: f, reason });
    }
    cache.save();
    result.controls = controlsFromSql(facts);
    return result;
  },
};
