import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compare } from "../src/compare";
import { listFiles } from "../src/files";
import { expandFiles } from "../src/inventory";
import { factsForFile, jsHeaders } from "../src/inventory/jsHeaders";

const fx = (...p: string[]) => join(__dirname, "fixtures", ...p);
const scan = (root: string) => jsHeaders.scan(root, listFiles(root));
const summary = (controls: { kind: string }[]) =>
  Object.fromEntries(
    controls.map((c) => {
      const x = c as { kind: string; id: string; file: string; origin?: string };
      return [x.id, x.kind === "cors" ? x.origin : x.file];
    }),
  );

describe("js security headers and CORS", () => {
  it("reads headers from Next config, middleware, helmet, setHeader and vercel.json, and CORS per file", async () => {
    const { controls, unparsed } = await scan(fx("headers-js-patterns"));
    expect(unparsed).toEqual([]);
    expect(summary(controls)).toEqual({
      "app/api/echo/route.ts#cors": "reflect",
      "app/api/open/route.ts#cors": "wildcard",
      "api.js#cors": "wildcard",
      "header:Permissions-Policy": "api.js",
      "header:Content-Security-Policy": "next.config.js",
      "header:Strict-Transport-Security": "next.config.js",
      "header:X-Frame-Options": "next.config.js",
      // middleware.ts only echoes origins that pass an allowlist check
      "middleware.ts#cors": "allowlist",
      "header:Referrer-Policy": "middleware.ts",
      "header:X-Content-Type-Options": "middleware.ts",
      "server.js#cors": "allowlist",
      // helmet({ contentSecurityPolicy: false, hsts: false }) still sets the rest
      "header:Cross-Origin-Opener-Policy": "server.js",
      "header:Cross-Origin-Resource-Policy": "server.js",
      "header:Cross-Origin-Embedder-Policy": "vercel.json",
    });
  });

  it("flags removed headers, helmet gone, CORS widened, and a new reflecting rule, with exact messages", async () => {
    const before = await scan(fx("headers-js-removed", "before"));
    const after = await scan(fx("headers-js-removed", "after"));
    expect(compare(before.controls, after.controls).map((r) => [r.controlId, r.summary])).toEqual([
      ["header:Content-Security-Policy", "The Content-Security-Policy security header is no longer set anywhere in the project (it used to be set in next.config.js)."],
      ["header:Cross-Origin-Opener-Policy", "The Cross-Origin-Opener-Policy security header is no longer set anywhere in the project (it used to be set in server.js)."],
      ["header:Cross-Origin-Resource-Policy", "The Cross-Origin-Resource-Policy security header is no longer set anywhere in the project (it used to be set in server.js)."],
      ["header:Referrer-Policy", "The Referrer-Policy security header is no longer set anywhere in the project (it used to be set in server.js)."],
      ["header:Strict-Transport-Security", "The Strict-Transport-Security security header is no longer set anywhere in the project (it used to be set in server.js)."],
      ["header:X-Content-Type-Options", "The X-Content-Type-Options security header is no longer set anywhere in the project (it used to be set in server.js)."],
      ["server.js#cors", "CORS (which websites may call your API) went from allowlist to wildcard."],
      ["extra.js#cors", "extra.js has a new CORS rule (which websites may call your API) that is echoing back whichever website asks."],
    ]);
  });

  it("does not flag moving headers between files, changing a header value, or a stricter origin check", async () => {
    const before = await scan(fx("headers-js-moved", "before"));
    const after = await scan(fx("headers-js-moved", "after"));
    expect(compare(before.controls, after.controls)).toEqual([]);
  });

  it("tells reflecting the request origin apart from checking it first", () => {
    const origin = (src: string) => {
      const f = factsForFile("a.js", src);
      if ("error" in f) throw new Error(f.error);
      return f.cors;
    };
    const set = (v: string) => `res.setHeader("Access-Control-Allow-Origin", ${v});`;
    expect(origin(set("req.headers.origin"))).toBe("reflect");
    expect(origin(`const o = req.headers.origin;\n${set("o")}`)).toBe("reflect");
    expect(origin(`const o = req.headers.origin;\nif (ALLOWED.includes(o)) ${set("o")}`)).toBe("allowlist");
    expect(origin(set('"*"'))).toBe("wildcard");
    expect(origin(set("process.env.APP_ORIGIN"))).toBe("allowlist");
  });

  it("understands the options of the cors package", () => {
    const origin = (opts: string) => {
      const f = factsForFile("a.js", `const cors = require("cors");\napp.use(cors(${opts}));`);
      if ("error" in f) throw new Error(f.error);
      return f.cors;
    };
    expect(origin("")).toBe("wildcard");
    expect(origin("{ origin: '*' }")).toBe("wildcard");
    expect(origin("{ origin: true }")).toBe("reflect");
    expect(origin("{ origin: false }")).toBe("none");
    expect(origin("{ credentials: true }")).toBe("wildcard");
    expect(origin("{ origin: (o, cb) => cb(null, true) }")).toBe("reflect");
    expect(origin("{ origin: (o, cb) => (ok.includes(o) ? cb(null, true) : cb(new Error())) }")).toBe("allowlist");
    expect(origin("{ origin: [/\\.example\\.com$/] }")).toBe("allowlist");
  });

  it("only treats helmet as helmet when it is imported", () => {
    const f = factsForFile("a.js", "function helmet() { return 1; }\nhelmet();\n");
    expect("error" in f ? [] : f.headers).toEqual([]);
  });

  it("re-reads every header-setting file when one changes, but ignores test code", () => {
    expect(expandFiles(fx("headers-js-moved", "after"), ["middleware.ts"])).toContain("server.js");
  });

  it("reports a syntax error and invalid vercel.json as unparsed, never as safe", () => {
    expect(factsForFile("a.js", "res.setHeader('X-Frame-Options', ")).toHaveProperty("error");
  });
});
