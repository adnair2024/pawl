import type { Control, Regression } from "./types";

type Of<K extends Control["kind"]> = Extract<Control, { kind: K }>;

const ORIGIN_RANK = { none: 0, allowlist: 1, reflect: 2, wildcard: 3 } as const;

/**
 * Compare a baseline against the current inventory. Only reports controls
 * that got weaker or disappeared; new or strengthened controls are fine.
 * `scope` limits the check to files that were re-inventoried (PostToolUse).
 */
export function compare(
  baseline: Control[],
  current: Control[],
  scope?: Set<string>,
): Regression[] {
  const now = new Map(current.map((c) => [c.id, c]));
  const out: Regression[] = [];
  for (const before of baseline) {
    if (scope && !scope.has(before.file)) continue;
    const after = now.get(before.id);
    if (!after) {
      out.push(removed(before));
      continue;
    }
    if (after.kind !== before.kind) continue;
    const r = weaker(before, after);
    if (r) out.push(r);
  }
  return out;
}

const accept = (id: string) => `If this is intended, run: /pawl:accept ${id} "<reason>"`;

/** How to put a lost guard back, in the terms of the framework the route is written in. */
function restoreGuard(framework: string, guard: string): string {
  if (framework === "fastapi") return `Add Depends(${guard.split("(")[0]}) back to the route, its router, or the include_router call.`;
  if (framework === "flask") return `Put @${guard.split("(")[0]} back below the @route decorator (above it does nothing), or restore the before_request hook.`;
  if (framework === "django") return `Restore ${guard} on the view (decorator, mixin placed before the View base, or permission_classes).`;
  if (framework === "django-settings") return `Put ${guard} back in the setting.`;
  if (framework === "express") return `Put the ${guard} middleware back on the route, its router, or where the router is mounted.`;
  return `Call ${guard} at the top of the handler again.`;
}

function removed(c: Control): Regression {
  return {
    controlId: c.id,
    file: c.file,
    kind: c.kind,
    summary: `${c.id} existed at baseline but is gone from ${c.file}.`,
    restore: `Put the ${c.kind} control back. ${accept(c.id)}`,
  };
}

function weaker(b: Control, a: Control): Regression | null {
  const base = { controlId: b.id, file: a.file, kind: b.kind };
  switch (b.kind) {
    case "route-auth": {
      const x = a as Of<"route-auth">;
      const lost = b.guards.filter((g) => !x.guards.includes(g));
      if (lost.length === 0) return null;
      return {
        ...base,
        summary:
          b.framework === "django-settings"
            ? `${b.id} no longer includes ${lost.join(", ")}, the rule that applies to every view that does not set its own.`
            : `${b.id} no longer runs the auth check ${lost.join(", ")} before its handler.`,
        restore: `${restoreGuard(b.framework, lost[0] ?? "the check")} ${accept(b.id)}`,
      };
    }
    case "rls-table": {
      const x = a as Of<"rls-table">;
      if (b.rlsEnabled && !x.rlsEnabled) {
        return {
          ...base,
          summary: `Row-level security (per-user data access rules) is now off for ${b.id}.`,
          restore: `Re-enable it with ALTER TABLE ${b.id} ENABLE ROW LEVEL SECURITY. ${accept(b.id)}`,
        };
      }
      const names = new Set(x.policies.map((p) => p.name));
      const dropped = b.policies.filter((p) => !names.has(p.name));
      if (dropped.length) {
        return {
          ...base,
          summary: `Policy ${dropped.map((p) => p.name).join(", ")} was dropped from ${b.id}.`,
          restore: `Recreate the dropped policy. ${accept(b.id)}`,
        };
      }
      const loosened = x.policies.filter((p) => b.policies.some((o) => o.name === p.name && !o.permissive && p.permissive));
      if (loosened.length) {
        return {
          ...base,
          summary: `Policy ${loosened[0]?.name} on ${b.id} now allows everyone (its condition is literally true).`,
          restore: `Restore the original USING / WITH CHECK condition. ${accept(b.id)}`,
        };
      }
      return null;
    }
    case "cors": {
      const x = a as Of<"cors">;
      if (ORIGIN_RANK[x.origin] <= ORIGIN_RANK[b.origin]) return null;
      return {
        ...base,
        summary: `CORS (which websites may call your API) went from ${b.origin} to ${x.origin}.`,
        restore: `Go back to an explicit list of allowed origins. ${accept(b.id)}`,
      };
    }
    case "header":
      return null; // presence is checked via removal above
  }
}
