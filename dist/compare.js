"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.compare = compare;
const ORIGIN_RANK = { none: 0, allowlist: 1, reflect: 2, wildcard: 3 };
/**
 * Compare a baseline against the current inventory. Only reports controls
 * that got weaker or disappeared; new or strengthened controls are fine.
 * `scope` limits the check to files that were re-inventoried (PostToolUse).
 */
function compare(baseline, current, scope) {
    const now = new Map(current.map((c) => [c.id, c]));
    const out = [];
    for (const before of baseline) {
        if (scope && !scope.has(before.file))
            continue;
        const after = now.get(before.id);
        if (!after) {
            out.push(removed(before));
            continue;
        }
        if (after.kind !== before.kind)
            continue;
        const r = weaker(before, after);
        if (r)
            out.push(r);
    }
    return out;
}
const accept = (id) => `If this is intended, run: /pawl:accept ${id} "<reason>"`;
function removed(c) {
    return {
        controlId: c.id,
        file: c.file,
        kind: c.kind,
        summary: `${c.id} existed at baseline but is gone from ${c.file}.`,
        restore: `Put the ${c.kind} control back. ${accept(c.id)}`,
    };
}
function weaker(b, a) {
    const base = { controlId: b.id, file: a.file, kind: b.kind };
    switch (b.kind) {
        case "route-auth": {
            const x = a;
            const lost = b.guards.filter((g) => !x.guards.includes(g));
            if (lost.length === 0)
                return null;
            return {
                ...base,
                summary: `${b.id} no longer runs the auth check ${lost.join(", ")} before its handler.`,
                restore: `Call ${lost[0]} at the top of the handler again. ${accept(b.id)}`,
            };
        }
        case "rls-table": {
            const x = a;
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
            const x = a;
            if (ORIGIN_RANK[x.origin] <= ORIGIN_RANK[b.origin])
                return null;
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
