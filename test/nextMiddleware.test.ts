import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compare } from "../src/compare";
import { listFiles } from "../src/files";
import { expandFiles } from "../src/inventory";
import { compileMatcher, factsForMiddleware, nextMiddleware } from "../src/inventory/nextMiddleware";

const fx = (...p: string[]) => join(__dirname, "fixtures", ...p);
const scan = (root: string) => nextMiddleware.scan(root, listFiles(root));
type Mw = { guards: string[]; covered: string[]; routes: string[]; matcher: unknown };
const only = async (root: string): Promise<Mw> => {
  const { controls } = await scan(root);
  expect(controls).toHaveLength(1);
  return controls[0] as unknown as Mw;
};
const guardsOf = (src: string): string[] => {
  const r = factsForMiddleware(fx("mw-narrowed", "before"), "middleware.ts", src, []);
  if ("error" in r) throw new Error(r.error);
  return (r.control as unknown as Mw | null)?.guards ?? ["<no middleware>"];
};

describe("next middleware matcher compiler", () => {
  const m = (pattern: string, ...paths: string[]) => paths.map((p) => compileMatcher(pattern)?.test(p));
  it("handles params, modifiers and regex groups like Next.js", () => {
    expect(m("/dashboard/:path*", "/dashboard", "/dashboard/a/b", "/dashboards", "/")).toEqual([true, true, false, false]);
    expect(m("/admin/:path+", "/admin", "/admin/users", "/admin/users/1")).toEqual([false, true, true]);
    expect(m("/blog/:slug", "/blog/hello", "/blog/hello/more", "/blog")).toEqual([true, false, false]);
    expect(m("/blog/:slug?", "/blog", "/blog/hello")).toEqual([true, true]);
    expect(m("/api/(.*)", "/api/users", "/api/a/b", "/api")).toEqual([true, true, false]);
    expect(m("/((?!api|_next/static|favicon.ico).*)", "/", "/dashboard", "/api/users", "/_next/static/x.js")).toEqual([true, true, false, false]);
    expect(m("/:locale(en|fr)/dashboard", "/en/dashboard", "/de/dashboard")).toEqual([true, false]);
    expect(m("/about", "/about", "/about/", "/about/us")).toEqual([true, true, false]);
  });
  it("returns null for patterns it cannot read instead of guessing", () => {
    expect(compileMatcher("/(unbalanced")).toBeNull();
  });
});

describe("next middleware inventory", () => {
  it("records guards and which existing routes the matcher covers", async () => {
    const mw = await only(fx("mw-narrowed", "before"));
    expect(mw.guards).toEqual(["cookies.get"]);
    expect(mw.routes).toEqual(["/", "/admin", "/admin/users/[id]", "/api/private", "/api/public", "/dashboard", "/dashboard/settings", "/login"]);
    expect(mw.covered).toEqual(["/admin", "/admin/users/[id]", "/api/private", "/dashboard", "/dashboard/settings"]);
  });

  it("flags a narrowed matcher, naming the routes that now skip the middleware", async () => {
    const before = await scan(fx("mw-narrowed", "before"));
    const after = await scan(fx("mw-narrowed", "after"));
    expect(compare(before.controls, after.controls).map((r) => [r.controlId, r.summary, r.restore])).toEqual([
      [
        "middleware.ts#middleware",
        "middleware.ts: its matcher no longer covers /admin, /admin/users/[id], /api/private, so requests to those routes skip the middleware.",
        'Widen config.matcher so it covers those routes again. If this is intended, run: /pawl:accept middleware.ts#middleware "<reason>"',
      ],
    ]);
  });

  it("flags the auth check removed from the middleware body", async () => {
    const before = await scan(fx("mw-guard-removed", "before"));
    const after = await scan(fx("mw-guard-removed", "after"));
    expect(compare(before.controls, after.controls).map((r) => r.summary)).toEqual([
      "middleware.ts: no longer runs the auth check cookies.get on incoming requests.",
    ]);
  });

  it("flags deleting the middleware, but not widening the matcher or restructuring the check", async () => {
    const moved = compare((await scan(fx("mw-moved", "before"))).controls, (await scan(fx("mw-moved", "after"))).controls);
    expect(moved).toEqual([]);
    const gone = compare((await scan(fx("mw-moved", "before"))).controls, []);
    expect(gone.map((r) => r.summary)).toEqual([
      "middleware.ts no longer exports a middleware function (or is gone), so requests are no longer checked before they reach your routes.",
    ]);
  });

  it("recognises Supabase's helper-based middleware by reading the helper, and not a helper that never refuses", async () => {
    expect((await only(fx("mw-supabase"))).guards).toEqual(["updateSession"]);
    expect((await only(fx("mw-supabase-open"))).guards).toEqual([]);
    // the negative-lookahead matcher still covers every real page route
    expect((await only(fx("mw-supabase"))).covered).toHaveLength(8);
  });

  it("recognises next-auth, Clerk, and other wrapper shapes", () => {
    expect(guardsOf('export { auth as middleware } from "@/auth";')).toEqual(["auth"]);
    expect(guardsOf('export { default } from "next-auth/middleware";')).toEqual(["next-auth/middleware"]);
    expect(guardsOf('export default auth((req) => { if (!req.auth) return Response.redirect("/login"); });')).toEqual(["auth", "inline:req.auth"]);
    expect(guardsOf('export default withAuth(function middleware(req) { return null; }, { callbacks: {} });')).toEqual(["withAuth"]);
    expect(guardsOf("export default clerkMiddleware(async (auth, req) => { if (isProtectedRoute(req)) await auth.protect(); });")).toEqual(["auth.protect"]);
    // clerkMiddleware alone only identifies the user; i18n middleware checks nobody
    expect(guardsOf("export default clerkMiddleware();")).toEqual([]);
    expect(guardsOf("export default createMiddleware(routing);")).toEqual([]);
    expect(guardsOf("export const handler = 1;")).toEqual(["<no middleware>"]);
  });

  it("covers every route when there is no matcher, and says when the matcher cannot be read", () => {
    const run = (src: string) => {
      const r = factsForMiddleware(fx("mw-narrowed", "before"), "middleware.ts", src, [{ route: "/a", sample: "/a" }]);
      if ("error" in r) throw new Error(r.error);
      return { mw: r.control as unknown as Mw, partial: r.partial };
    };
    expect(run("export function middleware() {}").mw.covered).toEqual(["/a"]);
    const dynamic = run("export function middleware() {}\nexport const config = { matcher: PATHS };");
    expect(dynamic.mw.covered).toEqual(["/a"]);
    expect(dynamic.mw.matcher).toBe("unknown");
    expect(dynamic.partial).toContain("could not be checked");
  });

  it("re-reads the middleware when a route or helper changes, and reports syntax errors as unparsed", () => {
    expect(expandFiles(fx("mw-narrowed", "before"), ["app/new/page.tsx"])).toContain("middleware.ts");
    expect(factsForMiddleware("/x", "middleware.ts", "export function middleware( {", [])).toHaveProperty("error");
  });
});
