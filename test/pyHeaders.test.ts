import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compare } from "../src/compare";
import { listFiles } from "../src/files";
import { factsForFile, pyHeaders } from "../src/inventory/pyHeaders";

const fx = (...p: string[]) => join(__dirname, "fixtures", ...p);
const scan = (root: string) => pyHeaders.scan(root, listFiles(root));
const summary = (controls: { kind: string }[]) =>
  Object.fromEntries(
    controls.map((c) => {
      const x = c as { kind: string; id: string; file: string; origin?: string };
      return [x.id, x.kind === "cors" ? x.origin : x.file];
    }),
  );
const cors = (src: string) => {
  const f = factsForFile("app.py", src);
  if ("error" in f) throw new Error(f.error);
  return f.cors;
};
const headers = (src: string) => {
  const f = factsForFile("app.py", src);
  if ("error" in f) throw new Error(f.error);
  return f.headers;
};

describe("python security headers and CORS", () => {
  it("reads FastAPI middleware, Flask-CORS and Talisman, Django settings and manual CORS", async () => {
    const { controls, unparsed } = await scan(fx("headers-py-patterns"));
    expect(unparsed).toEqual([]);
    expect(summary(controls)).toEqual({
      "dj_open/settings.py#cors": "wildcard",
      "django_proj/prod.py#cors": "allowlist",
      // SecurityMiddleware + SECURE_HSTS_SECONDS (set in a different settings file)
      "header:Strict-Transport-Security": "django_proj/prod.py",
      // Django sends these by default once SecurityMiddleware / XFrameOptionsMiddleware are installed
      "header:Referrer-Policy": "django_proj/settings.py",
      "header:X-Content-Type-Options": "django_proj/settings.py",
      "header:X-Frame-Options": "django_proj/settings.py",
      "django_proj/views.py#cors": "reflect",
      // Talisman(content_security_policy=None) drops CSP, so this one is the FastAPI middleware
      "header:Content-Security-Policy": "fastapi_app/main.py",
      "fastapi_app/main.py#cors": "allowlist",
      "flask_app/app.py#cors": "wildcard",
    });
  });

  it("flags Django middleware/HSTS removed, Talisman removed, and CORS widened, with exact messages", async () => {
    const before = await scan(fx("headers-py-removed", "before"));
    const after = await scan(fx("headers-py-removed", "after"));
    expect(compare(before.controls, after.controls).map((r) => [r.controlId, r.summary])).toEqual([
      ["header:Content-Security-Policy", "The Content-Security-Policy security header is no longer set anywhere in the project (it used to be set in flask_app.py)."],
      ["header:Strict-Transport-Security", "The Strict-Transport-Security security header is no longer set anywhere in the project (it used to be set in flask_app.py)."],
      ["header:X-Frame-Options", "The X-Frame-Options security header is no longer set anywhere in the project (it used to be set in flask_app.py)."],
      ["main.py#cors", "CORS (which websites may call your API) went from allowlist to wildcard."],
    ]);
  });

  it("does not flag moving headers into an after_request hook or rewriting Flask-CORS options", async () => {
    const before = await scan(fx("headers-py-moved", "before"));
    const after = await scan(fx("headers-py-moved", "after"));
    expect(compare(before.controls, after.controls)).toEqual([]);
  });

  it("reads Starlette CORSMiddleware options", () => {
    const mw = (kw: string) => cors(`app.add_middleware(CORSMiddleware, ${kw})`);
    expect(mw('allow_origins=["*"]')).toBe("wildcard");
    expect(mw('allow_origins=["https://a.com"]')).toBe("allowlist");
    expect(mw('allow_origin_regex=".*"')).toBe("reflect");
    expect(mw('allow_origin_regex=r"https://.*\\.example\\.com"')).toBe("allowlist");
    expect(mw("allow_credentials=True")).toBe("none");
  });

  it("reads Flask-CORS options, including cross_origin and resources", () => {
    const f = (call: string) => cors(`from flask_cors import CORS, cross_origin\n${call}`);
    expect(f("CORS(app)")).toBe("wildcard");
    expect(f('CORS(app, origins="*")')).toBe("wildcard");
    expect(f('CORS(app, origins=["https://a.com"])')).toBe("allowlist");
    expect(f('CORS(app, resources={r"/api/*": {"origins": "*"}})')).toBe("wildcard");
    expect(f("@cross_origin()\ndef v():\n    pass")).toBe("wildcard");
    expect(f('@cross_origin(origins=["https://a.com"])\ndef v():\n    pass')).toBe("allowlist");
  });

  it("tells reflecting the request origin apart from checking it first", () => {
    const set = (v: string) => `resp["Access-Control-Allow-Origin"] = ${v}`;
    expect(cors(`def v(request, resp):\n    ${set('request.headers.get("Origin")')}`)).toBe("reflect");
    expect(cors(`def v(request, resp):\n    o = request.headers.get("Origin")\n    ${set("o")}`)).toBe("reflect");
    expect(cors(`def v(request, resp):\n    o = request.headers.get("Origin")\n    if o in ALLOWED:\n        ${set("o")}`)).toBe("allowlist");
    expect(cors(`def v(resp):\n    ${set('"*"')}`)).toBe("wildcard");
  });

  it("knows which Talisman features are switched off", () => {
    const t = (kw: string) => headers(`from flask_talisman import Talisman\nTalisman(app${kw})`);
    expect(t("")).toEqual(["Content-Security-Policy", "Referrer-Policy", "Strict-Transport-Security", "X-Content-Type-Options", "X-Frame-Options"]);
    expect(t(", frame_options=None, x_content_type_options=False")).not.toContain("X-Frame-Options");
    expect(t(", frame_options=None, x_content_type_options=False")).not.toContain("X-Content-Type-Options");
  });

  it("ignores header names that only appear in test code or comments", async () => {
    expect(headers('# response.headers["X-Frame-Options"] = "DENY"\nx = 1\n')).toEqual([]);
  });

  it("reports a syntax error as unparsed, never as safe", () => {
    expect(factsForFile("app.py", 'response.headers["X-Frame-Options" = "DENY"\n')).toHaveProperty("error");
  });
});
