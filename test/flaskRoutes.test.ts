import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compare } from "../src/compare";
import { listFiles } from "../src/files";
import { expandFiles } from "../src/inventory";
import { factsForFile, flaskRoutes } from "../src/inventory/flaskRoutes";

const fx = (...p: string[]) => join(__dirname, "fixtures", ...p);
const scan = (root: string) => flaskRoutes.scan(root, listFiles(root));
const guardMap = (controls: { id: string; kind: string }[]) =>
  Object.fromEntries(controls.map((c) => [c.id, c.kind === "route-auth" ? (c as { guards: string[] }).guards : []]));

describe("flask route inventory", () => {
  it("learns guards from decorators, blueprint hooks, inline checks and project-defined decorators", async () => {
    const { controls, unparsed } = await scan(fx("flask-patterns"));
    expect(unparsed).toEqual([]);
    expect(guardMap(controls)).toEqual({
      "app.py#GET /": [],
      "app.py#GET /dashboard": ["login_required"],
      // @login_required sits above @app.route, so Flask never applies it
      "app.py#GET /oops": [],
      "app.py#GET /api/items": ["jwt_required"],
      "app.py#POST /api/items": ["jwt_required"],
      // jwt_required(optional=True) identifies a caller but lets anonymous ones through
      "app.py#GET /api/maybe": [],
      "app.py#GET /settings": ["inline:401"],
      // blueprint before_request that redirects to login, then the project's own admin_required (it aborts 403)
      "views/users.py#GET /": ["before_request:require_login"],
      "views/users.py#DELETE /<int:uid>": ["before_request:require_login", "admin_required"],
      "views/public.py#GET /ping": [],
      // api_key_required is defined in this project and never refuses anyone, so it is not a guard
      "views/public.py#GET /internal": [],
    });
  });

  it("flags a dropped before_request and a dropped decorator, with an exact message", async () => {
    const before = await scan(fx("flask-guard-removed", "before"));
    const after = await scan(fx("flask-guard-removed", "after"));
    expect(compare(before.controls, after.controls).map((r) => [r.controlId, r.summary])).toEqual([
      ["views/users.py#GET /", "views/users.py#GET / no longer runs the auth check before_request:require_login before its handler."],
      [
        "views/users.py#DELETE /<int:uid>",
        "views/users.py#DELETE /<int:uid> no longer runs the auth check before_request:require_login, admin_required before its handler.",
      ],
    ]);
  });

  it("does not flag renaming the view, switching to @app.get, or adding other decorators", async () => {
    const before = await scan(fx("flask-guard-moved", "before"));
    const after = await scan(fx("flask-guard-moved", "after"));
    expect(guardMap(after.controls)).toEqual({ "app.py#GET /a": ["login_required"] });
    expect(compare(before.controls, after.controls)).toEqual([]);
  });

  it("flags a decorator moved above @route, where it silently stops working", () => {
    const mk = (src: string) => {
      const f = factsForFile("app.py", `from flask import Flask\napp = Flask(__name__)\n${src}`);
      if ("error" in f) throw new Error("should parse");
      return f.routes[0]?.decorators;
    };
    expect(mk('@app.route("/x")\n@login_required\ndef x():\n    pass\n')).toEqual(["login_required"]);
    expect(mk('@login_required\n@app.route("/x")\ndef x():\n    pass\n')).toEqual([]);
  });

  it("re-reads every Flask file when one changes, so a decorator edit is caught", () => {
    expect(expandFiles(fx("flask-guard-removed", "before"), ["auth.py"])).toContain("views/users.py");
  });

  it("reports a syntax error as unparsed, never as safe", () => {
    expect(factsForFile("x.py", "from flask import Flask\n@app.route('/x'\ndef f():\n    pass\n")).toHaveProperty("error");
  });
});
