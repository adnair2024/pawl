import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compare } from "../src/compare";
import { listFiles } from "../src/files";
import { expandFiles } from "../src/inventory";
import { djangoRoutes, factsForFile } from "../src/inventory/djangoRoutes";

const fx = (...p: string[]) => join(__dirname, "fixtures", ...p);
const scan = (root: string) => djangoRoutes.scan(root, listFiles(root));
const guardMap = (controls: { id: string; kind: string }[]) =>
  Object.fromEntries(controls.map((c) => [c.id, c.kind === "route-auth" ? (c as { guards: string[] }).guards : []]));

describe("django view inventory", () => {
  it("learns guards from decorators, mixins, DRF permission classes, defaults and settings", async () => {
    const { controls, unparsed } = await scan(fx("django-patterns"));
    expect(unparsed).toEqual([]);
    expect(guardMap(controls)).toEqual({
      "settings.py#REST_FRAMEWORK.DEFAULT_PERMISSION_CLASSES": ["IsAuthenticated"],
      // AuthenticationMiddleware only loads request.user, it refuses nobody
      "settings.py#MIDDLEWARE": [],
      "shop/views.py#home": [],
      "shop/views.py#profile": ["login_required"],
      "shop/views.py#edit": ["permission_required(shop.change_item)"],
      "shop/views.py#secret": ["inline:denied"],
      "shop/views.py#Dash": ["LoginRequiredMixin"],
      // LoginRequiredMixin listed after View never runs, so it protects nothing
      "shop/views.py#Wrong": [],
      // project mixin built on UserPassesTestMixin
      "shop/views.py#Reports": ["StaffRequiredMixin"],
      // DRF views with no permission_classes inherit the project default
      "shop/views.py#api_default": ["IsAuthenticated"],
      "shop/views.py#api_open": [],
      "shop/views.py#api_owned": ["IsAuthenticated", "IsOwner"],
      "shop/views.py#Orders": ["IsAuthenticated"],
      // AlwaysYes.has_permission just returns True
      "shop/views.py#OpenThing": [],
      "shop/views.py#Defaulted": ["IsAuthenticated"],
    });
  });

  it("flags a loosened default, a dropped decorator and a dropped mixin, with exact messages", async () => {
    const before = await scan(fx("django-guard-removed", "before"));
    const after = await scan(fx("django-guard-removed", "after"));
    expect(compare(before.controls, after.controls).map((r) => [r.controlId, r.summary])).toEqual([
      [
        "settings.py#REST_FRAMEWORK.DEFAULT_PERMISSION_CLASSES",
        "settings.py#REST_FRAMEWORK.DEFAULT_PERMISSION_CLASSES no longer includes IsAuthenticated, the rule that applies to every view that does not set its own.",
      ],
      ["shop/views.py#profile", "shop/views.py#profile no longer runs the auth check login_required before its handler."],
      ["shop/views.py#Dash", "shop/views.py#Dash no longer runs the auth check LoginRequiredMixin before its handler."],
      ["shop/views.py#Defaulted", "shop/views.py#Defaulted no longer runs the auth check IsAuthenticated before its handler."],
    ]);
  });

  it("does not flag adding decorators, changing signatures, or relying on the same default", async () => {
    const before = await scan(fx("django-guard-moved", "before"));
    const after = await scan(fx("django-guard-moved", "after"));
    expect(compare(before.controls, after.controls)).toEqual([]);
  });

  it("re-reads every Django file when one changes, so a settings edit is caught", async () => {
    expect(await expandFiles(fx("django-guard-removed", "before"), ["settings.py"])).toContain("shop/views.py");
  });

  it("reports a syntax error as unparsed, never as safe", () => {
    expect(factsForFile("shop/views.py", "from django.views import View\nclass A(View:\n    pass\n")).toHaveProperty("error");
  });
});
