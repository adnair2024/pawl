import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compare } from "../src/compare";
import { listFiles } from "../src/files";
import { expandFiles, scanFiles } from "../src/inventory";
import { controlsFromFacts, expressRoutes, factsForFile } from "../src/inventory/expressRoutes";

const fx = (...p: string[]) => join(__dirname, "fixtures", ...p);
const scan = (root: string) => expressRoutes.scan(root, listFiles(root));
const guardMap = (controls: { id: string; kind: string }[]) =>
  Object.fromEntries(controls.map((c) => [c.id, c.kind === "route-auth" ? (c as { guards: string[] }).guards : []]));

describe("express route inventory", () => {
  it("learns guards from mounts, router-wide use, route middleware and inline checks", async () => {
    const { controls, unparsed } = await scan(fx("express-patterns"));
    expect(unparsed).toEqual([]);
    expect(guardMap(controls)).toEqual({
      // mounted with requireAuth + requireRole("admin") from another file
      "routes/admin.js#GET /stats": ["requireAuth", "requireRole(admin)"],
      // mounted before app.use(requireAuth), so not protected by it
      "routes/public.js#GET /health": [],
      "routes/items.ts#GET /items": [],
      "routes/items.ts#POST /items": ["requireAuth"],
      // mounted after app.use(requireAuth)
      "routes/posts.js#POST /": ["requireAuth"],
      "routes/posts.js#DELETE /:id": ["requireAuth", "requireRole(owner)"],
      "routes/posts.js#GET /mine": ["requireAuth", "inline:req.user"],
      "routes/posts.js#GET /search": ["requireAuth"],
      "server.js#GET /me": ["requireAuth"],
    });
  });

  it("does not mistake session middleware or app.get('setting') for auth", async () => {
    const { controls } = await scan(fx("express-patterns"));
    expect(controls.some((c) => c.id.includes("env"))).toBe(false);
    expect(controls.every((c) => c.kind !== "route-auth" || !c.guards.includes("session"))).toBe(true);
  });

  it("flags a guard dropped from a mount and one dropped from a single route, with exact messages", async () => {
    const before = await scan(fx("express-guard-removed", "before"));
    const after = await scan(fx("express-guard-removed", "after"));
    expect(guardMap(before.controls)).toEqual({
      "routes/admin.js#GET /users": ["requireAuth", "requireAdmin"],
      "routes/admin.js#GET /stats": ["requireAuth"],
    });
    expect(compare(before.controls, after.controls).map((r) => [r.controlId, r.summary])).toEqual([
      ["routes/admin.js#GET /users", "routes/admin.js#GET /users no longer runs the auth check requireAuth, requireAdmin before its handler."],
      ["routes/admin.js#GET /stats", "routes/admin.js#GET /stats no longer runs the auth check requireAuth before its handler."],
    ]);
  });

  it("does not flag moving guards into router.use or renaming the app variable", async () => {
    const before = await scan(fx("express-guard-moved", "before"));
    const after = await scan(fx("express-guard-moved", "after"));
    expect(guardMap(after.controls)).toEqual({ "server.js#GET /a": ["requireAuth"], "server.js#GET /b": ["requireAuth"] });
    expect(compare(before.controls, after.controls)).toEqual([]);
  });

  it("flags app.use(requireAuth) moved below the routes it used to protect", () => {
    const mk = (src: string) => factsForFile("s.js", src);
    const guarded = mk(`const express=require("express");const app=express();
app.use(requireAuth);
app.get("/x",(req,res)=>res.send(1));`);
    const moved = mk(`const express=require("express");const app=express();
app.get("/x",(req,res)=>res.send(1));
app.use(requireAuth);`);
    if ("error" in guarded || "error" in moved) throw new Error("fixture should parse");
    const g = controlsFromFacts([guarded]);
    const m = controlsFromFacts([moved]);
    expect(guardMap(g)).toEqual({ "s.js#GET /x": ["requireAuth"] });
    expect(guardMap(m)).toEqual({ "s.js#GET /x": [] });
    expect(compare(g, m).map((r) => r.controlId)).toEqual(["s.js#GET /x"]);
  });

  it("re-reads every Express file when one changes, so a mount edit is caught", async () => {
    const root = fx("express-guard-removed", "after");
    const expanded = expandFiles(root, ["server.js"]);
    expect(expanded).toContain("routes/admin.js");
    const inv = await scanFiles(root, expanded);
    expect(inv.controls.length).toBe(2);
  });

  it("reports a syntax error as unparsed, never as safe", async () => {
    const r = factsForFile("x.js", 'const express = require("express"); app.get("/x", (req, res) => {');
    expect(r).toHaveProperty("error");
  });
});
