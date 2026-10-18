import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expandFiles, inventoriers, scanFiles } from "../src/inventory";
import { djangoRoutes } from "../src/inventory/djangoRoutes";
import { expressRoutes } from "../src/inventory/expressRoutes";
import { fastapiRoutes } from "../src/inventory/fastapiRoutes";
import { flaskRoutes } from "../src/inventory/flaskRoutes";
import { jsHeaders } from "../src/inventory/jsHeaders";
import { nextMiddleware } from "../src/inventory/nextMiddleware";
import { nextRoutes } from "../src/inventory/nextRoutes";
import { pyHeaders } from "../src/inventory/pyHeaders";
import { supabaseRls } from "../src/inventory/supabaseRls";

// The lazy wrappers repeat each reader's `handles` so it can answer without loading the reader.
// If the two ever disagree a file would be silently skipped, so compare them on many paths.
const real = [nextRoutes, expressRoutes, fastapiRoutes, flaskRoutes, djangoRoutes, supabaseRls, jsHeaders, pyHeaders, nextMiddleware];
const paths = [
  "app/api/x/route.ts", "src/app/page.tsx", "lib/a.js", "server.mjs", "server.cjs", "types.d.ts", "comp.jsx",
  "a.py", "pkg/__init__.py", "tests/test_a.py", "test_a.py", "a_test.py", "conftest.py", "app/tests/x.ts", "x.test.ts", "x.spec.js",
  "supabase/migrations/1_init.sql", "apps/web/supabase/migrations/2.sql", "supabase/seed.sql", "db/schema.sql",
  "vercel.json", "public/_headers", "package.json", "README.md", "middleware.ts", "src/middleware.ts", "proxy.ts",
  "fixtures/a.js", "app/fixtures/b.py", "a.json", ".pawl/baseline.json",
];

describe("lazy inventorier wrappers", () => {
  it("agree with the real readers about which files they handle", () => {
    expect(inventoriers.map((i) => i.name)).toEqual(real.map((r) => r.name));
    inventoriers.forEach((lazy, i) => {
      for (const p of paths) expect(lazy.handles(p), `${lazy.name} on ${p}`).toBe(real[i]?.handles(p));
    });
  });
});

describe("fail-open behaviour of the reader registry", () => {
  const crashing = {
    name: "crashing-reader",
    handles: (p: string) => p.endsWith(".zzz"),
    expand: () => {
      throw new Error("expand blew up");
    },
    scan: async () => {
      throw new Error("scan blew up");
    },
  };

  it("reports a crashed reader as not analyzed and keeps going", async () => {
    inventoriers.push(crashing);
    try {
      const result = await scanFiles("/nonexistent", ["a.zzz"]);
      expect(result.controls).toEqual([]);
      expect(result.partial).toEqual([{ file: "(crashing-reader)", reason: expect.stringContaining("crashed and was skipped: Error: scan blew up") }]);
      expect(await expandFiles("/nonexistent", ["a.zzz"])).toEqual(["a.zzz"]);
    } finally {
      inventoriers.pop();
    }
  });
});

describe("large and ignored files", () => {
  it("skips generated bundles and does not walk build folders", async () => {
    const d = mkdtempSync(join(tmpdir(), "pawl-big-"));
    try {
      mkdirSync(join(d, "app/api/ok"), { recursive: true });
      mkdirSync(join(d, "app/api/bundle"), { recursive: true });
      mkdirSync(join(d, ".turbo"), { recursive: true });
      writeFileSync(join(d, "app/api/ok/route.ts"), "export async function GET() { return Response.json({}); }\n");
      // a 3 MB minified bundle that happens to sit in a route folder
      writeFileSync(join(d, "app/api/bundle/route.ts"), `export async function GET() { return Response.json({}); }\n${"/*x*/".repeat(600_000)}`);
      writeFileSync(join(d, ".turbo/route.ts"), "export async function GET() {}\n");
      const { listFiles } = await import("../src/files");
      expect(listFiles(d)).not.toContain(".turbo/route.ts");
      const result = await scanFiles(d, listFiles(d));
      expect(result.controls.map((c) => c.id)).toEqual(["app/api/ok/route.ts#GET"]);
      expect(result.unparsed).toEqual([]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
