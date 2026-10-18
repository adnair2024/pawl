import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compare } from "../src/compare";
import { listFiles } from "../src/files";
import { expandFiles } from "../src/inventory";
import { controlsFromSql, factsForSql, supabaseRls } from "../src/inventory/supabaseRls";

const fx = (...p: string[]) => join(__dirname, "fixtures", ...p);
const scan = (root: string) => supabaseRls.scan(root, listFiles(root));
const shape = (controls: { kind: string }[]) =>
  Object.fromEntries(
    controls.flatMap((c) =>
      c.kind === "rls-table" ? [[(c as { id: string }).id, { rls: (c as { rlsEnabled: boolean }).rlsEnabled, policies: (c as { policies: { name: string; open: boolean }[] }).policies.map((p) => `${p.name}${p.open ? " (OPEN)" : ""}`) }]] : [],
    ),
  );

describe("supabase rls inventory", () => {
  it("replays migrations into per-table RLS state, policies, and open policies", async () => {
    const { controls, unparsed, partial } = await scan(fx("rls-patterns"));
    expect(unparsed).toEqual([]);
    expect(shape(controls)).toEqual({
      "public.profiles": { rls: true, policies: ["own profile", "update own"] },
      // literally-true SELECT for everyone is open; the owner policy is not
      "public.posts": { rls: true, policies: ["owner write", "public read (OPEN)"] },
      // never enabled by SQL we can read (the DO block that might enable it is reported below)
      "public.audit": { rls: false, policies: [] },
      // true for service_role bypasses RLS anyway, and a restrictive true policy removes no restriction
      "public.secrets": { rls: true, policies: ["block anon", "service only"] },
      // created in a later migration, and its policy was tightened from true by ALTER POLICY
      "public.comments": { rls: true, policies: ["c_read"] },
    });
    expect(partial).toEqual([{ file: "supabase/migrations/20240102000000_more.sql", reason: "a DO block that may change row-level security was not analyzed" }]);
  });

  it("flags disabled RLS, a dropped policy, a loosened policy and a new table without RLS, with exact messages", async () => {
    const before = await scan(fx("rls-policy-removed", "before"));
    const after = await scan(fx("rls-policy-removed", "after"));
    expect(compare(before.controls, after.controls).map((r) => [r.controlId, r.summary])).toEqual([
      ["public.profiles", "Row-level security (per-user data access rules) is now off for public.profiles."],
      ["public.posts", "Policy owner write was dropped from public.posts."],
      ["public.comments", "Policy c_read on public.comments now allows everyone (its condition is literally true)."],
      [
        "public.invoices",
        "New table public.invoices has row-level security (per-user data access rules) off, so anyone with your public API key can read and change every row.",
      ],
    ]);
  });

  it("gives SQL-specific restore advice", async () => {
    const before = await scan(fx("rls-policy-removed", "before"));
    const after = await scan(fx("rls-policy-removed", "after"));
    expect(compare(before.controls, after.controls)[0]?.restore).toBe(
      'Re-enable it with ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY. If this is intended, run: /pawl:accept public.profiles "<reason>"',
    );
  });

  it("does not flag moving RLS to a later migration, recreating a policy, or adding stricter ones", async () => {
    const before = await scan(fx("rls-moved", "before"));
    const after = await scan(fx("rls-moved", "after"));
    expect(shape(after.controls)["public.tags"]).toEqual({ rls: true, policies: [] });
    expect(compare(before.controls, after.controls)).toEqual([]);
  });

  it("follows rename, set schema, drop table and if-not-exists", async () => {
    const f = await factsForSql(
      "supabase/migrations/1.sql",
      `create table public.a (id int); alter table public.a enable row level security;
       create table if not exists public.a (id int);
       alter table public.a rename to b;
       create table public.c (id int); alter table public.c set schema private;
       create table public.d (id int); drop table public.d;`,
    );
    if ("error" in f) throw new Error(f.error);
    expect(shape(controlsFromSql([f]))).toEqual({ "public.b": { rls: true, policies: [] } });
  });

  it("re-reads every migration when one changes", async () => {
    const expanded = await expandFiles(fx("rls-policy-removed", "after"), ["supabase/migrations/20240201000000_oops.sql"]);
    expect(expanded).toContain("supabase/migrations/20240101000000_init.sql");
  });

  it("reports a SQL syntax error as unparsed, never as safe", async () => {
    expect(await factsForSql("supabase/migrations/1.sql", "create table (")).toHaveProperty("error");
    for (const ok of ["", "-- placeholder\n", "/* nothing */"]) {
      expect(await factsForSql("supabase/migrations/1.sql", ok)).toEqual({ file: "supabase/migrations/1.sql", ops: [], partial: [] });
    }
  });
});
