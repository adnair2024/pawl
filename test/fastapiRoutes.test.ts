import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compare } from "../src/compare";
import { listFiles } from "../src/files";
import { expandFiles, scanFiles } from "../src/inventory";
import { factsForFile, fastapiRoutes } from "../src/inventory/fastapiRoutes";

const fx = (...p: string[]) => join(__dirname, "fixtures", ...p);
const scan = (root: string) => fastapiRoutes.scan(root, listFiles(root));
const guardMap = (controls: { id: string; kind: string }[]) =>
  Object.fromEntries(controls.map((c) => [c.id, c.kind === "route-auth" ? (c as { guards: string[] }).guards : []]));

describe("fastapi route inventory", () => {
  it("learns guards from include_router, router dependencies, decorators, parameters and inline checks", async () => {
    const { controls, unparsed } = await scan(fx("fastapi-patterns"));
    expect(unparsed).toEqual([]);
    expect(guardMap(controls)).toEqual({
      "app/main.py#GET /health": [],
      // add_api_route with dependencies=[...]
      "app/main.py#POST /export": ["get_current_user"],
      // same function name as the real guard, but the one this file imports never refuses anyone
      "app/legacy.py#GET /legacy": [],
      // auto_error=False schemes identify a caller but never refuse one
      "app/routers/public.py#GET /feed": [],
      "app/routers/public.py#GET /ping": [],
      // included with dependencies=[Depends(get_current_user)]; get_db is data, not a guard
      "app/routers/users.py#GET /": ["get_current_user"],
      "app/routers/users.py#DELETE /{uid}": ["get_current_user", "require_admin"],
      // get_current_active_user only wraps get_current_user, learned through the chain
      "app/routers/users.py#GET /me": ["get_current_user", "get_current_active_user"],
      // APIRouter(dependencies=[...]) plus Annotated[..., Depends(...)] and an inline 401
      "app/routers/items.py#GET /": ["get_current_user"],
      "app/routers/items.py#GET /mine": ["get_current_user", "get_current_active_user"],
      "app/routers/items.py#POST /": ["get_current_user", "inline:401"],
    });
  });

  it("treats auth middleware as a guard on every route of the app", async () => {
    const { controls } = await scan(fx("fastapi-middleware"));
    expect(guardMap(controls)).toEqual({
      "app/main.py#GET /a": ["middleware:require_login"],
      "app/main.py#POST /b": ["middleware:require_login"],
    });
  });

  it("flags a guard dropped from include_router and one dropped from a route, with exact messages", async () => {
    const before = await scan(fx("fastapi-guard-removed", "before"));
    const after = await scan(fx("fastapi-guard-removed", "after"));
    expect(compare(before.controls, after.controls).map((r) => [r.controlId, r.summary])).toEqual([
      ["app/routers/users.py#GET /", "app/routers/users.py#GET / no longer runs the auth check get_current_user before its handler."],
      ["app/routers/users.py#DELETE /{uid}", "app/routers/users.py#DELETE /{uid} no longer runs the auth check get_current_user, require_admin before its handler."],
    ]);
  });

  it("tells the user to add the Depends back, not to call a function", async () => {
    const before = await scan(fx("fastapi-guard-removed", "before"));
    const after = await scan(fx("fastapi-guard-removed", "after"));
    expect(compare(before.controls, after.controls)[0]?.restore).toBe(
      'Add Depends(get_current_user) back to the route, its router, or the include_router call. If this is intended, run: /pawl:accept app/routers/users.py#GET / "<reason>"',
    );
  });

  it("does not flag moving dependencies between decorator, parameter, router and include", async () => {
    const before = await scan(fx("fastapi-guard-moved", "before"));
    const after = await scan(fx("fastapi-guard-moved", "after"));
    expect(guardMap(after.controls)).toEqual({
      "app/main.py#GET /a": ["get_current_user"],
      "app/main.py#DELETE /b": ["get_current_user", "require_admin"],
    });
    expect(compare(before.controls, after.controls)).toEqual([]);
  });

  it("stops counting a dependency as a guard when its own check is removed", async () => {
    const root = fx("fastapi-guard-moved", "before");
    const gutted = (await scan(root)).controls;
    const facts = factsForFile("app/deps.py", "from fastapi import Depends\ndef get_current_user():\n    return {}\n");
    if ("error" in facts) throw new Error("should parse");
    // same route files, but the definition no longer refuses anyone
    const mainFacts = factsForFile("app/main.py", 'from fastapi import FastAPI, Depends\napp = FastAPI()\n@app.get("/a", dependencies=[Depends(get_current_user)])\ndef a():\n    return 1\n');
    if ("error" in mainFacts) throw new Error("should parse");
    const { controlsFromFacts } = await import("../src/inventory/fastapiRoutes");
    const weak = controlsFromFacts([facts, mainFacts]);
    expect(guardMap(weak)).toEqual({ "app/main.py#GET /a": [] });
    expect(compare(gutted, weak).map((r) => r.controlId)).toContain("app/main.py#GET /a");
  });

  it("re-reads every FastAPI file when one changes, so a dependency edit is caught", async () => {
    const root = fx("fastapi-guard-removed", "after");
    const expanded = expandFiles(root, ["app/deps.py"]);
    expect(expanded).toContain("app/routers/users.py");
    expect((await scanFiles(root, expanded)).controls.length).toBe(2);
  });

  it("reports a syntax error as unparsed, never as safe", () => {
    expect(factsForFile("x.py", "from fastapi import FastAPI\ndef broken(:\n")).toHaveProperty("error");
  });
});
