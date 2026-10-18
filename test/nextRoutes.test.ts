import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compare } from "../src/compare";
import { listFiles } from "../src/files";
import { inventoryNextFile, nextRoutes } from "../src/inventory/nextRoutes";

const fx = (...p: string[]) => join(__dirname, "fixtures", ...p);
const scan = async (root: string) => nextRoutes.scan(root, listFiles(root));

describe("next route inventory", () => {
  it("flags a removed auth guard with an exact message", async () => {
    const before = await scan(fx("next-guard-removed", "before"));
    const after = await scan(fx("next-guard-removed", "after"));
    expect(before.controls).toMatchObject([{ id: "app/api/users/route.ts#GET", guards: ["auth.getUser"] }]);
    expect(compare(before.controls, after.controls)).toEqual([
      {
        controlId: "app/api/users/route.ts#GET",
        file: "app/api/users/route.ts",
        kind: "route-auth",
        summary: "app/api/users/route.ts#GET no longer runs the auth check auth.getUser before its handler.",
        restore:
          'Call auth.getUser at the top of the handler again. If this is intended, run: /pawl:accept app/api/users/route.ts#GET "<reason>"',
      },
    ]);
  });

  it("does not flag a refactor that keeps the guard", async () => {
    const before = await scan(fx("next-guard-moved", "before"));
    const after = await scan(fx("next-guard-moved", "after"));
    expect(after.controls[0]?.kind === "route-auth" && after.controls[0].guards).toEqual(["auth.getUser"]);
    expect(compare(before.controls, after.controls)).toEqual([]);
  });

  it("learns guards from several handler styles", async () => {
    const { controls, unparsed } = await scan(fx("next-patterns"));
    const guards = Object.fromEntries(controls.map((c) => [c.id, c.kind === "route-auth" ? c.guards : []]));
    expect(unparsed).toEqual([]);
    expect(guards).toEqual({
      "app/actions/post.ts#createPost": ["getSession"],
      "app/actions/post.ts#publicPing": [],
      "app/api/admin/route.ts#POST": ["auth", "requireAdmin"],
      "app/api/open/route.ts#GET": [],
      "app/api/posts/route.ts#DELETE": [],
      "app/api/posts/route.ts#GET": ["withAuth"],
    });
  });

  it("reports a syntax error as unparsed, never as safe", () => {
    const r = inventoryNextFile("app/api/x/route.ts", "export async function GET( { return ");
    expect(r.controls).toEqual([]);
    expect(r.unparsed).toHaveLength(1);
  });

  it("counts the same auth check written in one line, and ignores lookalike checks on data", () => {
    const guards = (body: string): string[] => {
      const r = inventoryNextFile("app/api/x/route.ts", `export async function GET(req) {\n${body}\n  return Response.json({});\n}`);
      const c = r.controls[0];
      return c && c.kind === "route-auth" ? c.guards : ["<none>"];
    };
    // the inlined form Claude produced when asked to "simplify" a route
    expect(guards('  if (!(await auth())?.user) return Response.json({}, { status: 401 });')).toEqual(["auth"]);
    expect(guards('  if (!(await supabase.auth.getUser()).data.user) return NextResponse.json({}, { status: 401 });')).toEqual(["auth.getUser"]);
    expect(guards('  const session = (await auth()) ?? redirect("/login");')).toEqual(["auth"]);
    expect(guards('  const session = await auth();\n  if (!session?.user) return Response.json({}, { status: 401 });')).toEqual(["auth"]);
    // checks that are about the data or the input, not who is calling
    expect(guards('  if (!isValid(body)) return Response.json({}, { status: 400 });')).toEqual([]);
    expect(guards('  if (rows.length === 0) throw new Error("empty");')).toEqual([]);
    expect(guards('  if (!process.env.API_URL) throw new Error("missing");')).toEqual([]);
  });
});
