import { describe, expect, it } from "vitest";
import { compare } from "../src/compare";
import type { Control } from "../src/types";

const route = (guards: string[], lang: "ts" | "py" = "ts"): Control => ({
  kind: "route-auth",
  id: "r#GET",
  file: "r.ts",
  lang,
  framework: "next",
  guards,
});

describe("compare", () => {
  it("flags a removed guard", () => {
    const r = compare([route(["auth"])], [route([])]);
    expect(r).toHaveLength(1);
    expect(r[0]?.summary).toContain("auth");
  });
  it("flags a removed control", () => {
    expect(compare([route(["auth"])], [])).toHaveLength(1);
  });
  it("passes when a guard moves but is kept", () => {
    expect(compare([route(["auth"])], [route(["auth"])])).toEqual([]);
  });
  it("passes when a guard is added", () => {
    expect(compare([route(["auth"])], [route(["auth", "csrf"])])).toEqual([]);
  });
  it("flags CORS widening to wildcard but not tightening", () => {
    const cors = (origin: "allowlist" | "wildcard"): Control => ({
      kind: "cors", id: "c", file: "c.py", lang: "py", origin,
    });
    expect(compare([cors("allowlist")], [cors("wildcard")])).toHaveLength(1);
    expect(compare([cors("wildcard")], [cors("allowlist")])).toEqual([]);
  });
  it("ignores files out of scope", () => {
    expect(compare([route(["auth"])], [], new Set(["other.ts"]))).toEqual([]);
  });
});
