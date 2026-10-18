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
            // No CORS rule at all means same-origin only, which is stricter, so it is not a loss.
            if (before.kind !== "cors")
                out.push(removed(before));
            continue;
        }
        if (after.kind !== before.kind)
            continue;
        const r = weaker(before, after);
        if (r)
            out.push(r);
    }
    const known = new Set(baseline.map((c) => c.id));
    // A CORS rule in a file that had none, letting any website call the API.
    for (const c of current) {
        if (c.kind !== "cors" || known.has(c.id) || ORIGIN_RANK[c.origin] < ORIGIN_RANK.reflect || (scope && !scope.has(c.file)))
            continue;
        out.push({
            controlId: c.id,
            file: c.file,
            kind: c.kind,
            summary: `${c.file} has a new CORS rule (which websites may call your API) that is ${c.origin === "wildcard" ? "open to every website" : "echoing back whichever website asks"}.`,
            restore: `Use an explicit list of allowed origins instead. ${accept(c.id)}`,
        });
    }
    // A table that did not exist at baseline and has row-level security off is exposed from day one.
    for (const c of current) {
        if (c.kind !== "rls-table" || c.rlsEnabled || known.has(c.id) || (scope && !scope.has(c.file)))
            continue;
        out.push({
            controlId: c.id,
            file: c.file,
            kind: c.kind,
            summary: `New table ${tableOf(c.id)} has row-level security (per-user data access rules) off, so anyone with your public API key can read and change every row.`,
            restore: `Add ALTER TABLE ${tableOf(c.id)} ENABLE ROW LEVEL SECURITY; and a policy for who may access it. ${accept(c.id)}`,
        });
    }
    return out;
}
/** Control ids for tables in a nested Supabase project look like "apps/web/supabase:public.users". */
const tableOf = (id) => id.split(":").pop() ?? id;
const accept = (id) => `If this is intended, run: /pawl:accept ${id} "<reason>"`;
/** How to put a lost guard back, in the terms of the framework the route is written in. */
function restoreGuard(framework, guard) {
    if (framework === "fastapi")
        return `Add Depends(${guard.split("(")[0]}) back to the route, its router, or the include_router call.`;
    if (framework === "flask")
        return `Put @${guard.split("(")[0]} back below the @route decorator (above it does nothing), or restore the before_request hook.`;
    if (framework === "django")
        return `Restore ${guard} on the view (decorator, mixin placed before the View base, or permission_classes).`;
    if (framework === "django-settings")
        return `Put ${guard} back in the setting.`;
    if (framework === "express")
        return `Put the ${guard} middleware back on the route, its router, or where the router is mounted.`;
    return `Call ${guard} at the top of the handler again.`;
}
function removed(c) {
    if (c.kind === "middleware") {
        return {
            controlId: c.id,
            file: c.file,
            kind: c.kind,
            summary: `${c.file} no longer exports a middleware function (or is gone), so requests are no longer checked before they reach your routes.`,
            restore: `Restore ${c.file} and its exported middleware function. ${accept(c.id)}`,
        };
    }
    if (c.kind === "header") {
        return {
            controlId: c.id,
            file: c.file,
            kind: c.kind,
            summary: `The ${c.header} security header is no longer set anywhere in the project (it used to be set in ${c.file}).`,
            restore: `Set ${c.header} again where the app sends responses (framework config, middleware, or a library like helmet). ${accept(c.id)}`,
        };
    }
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
                summary: b.framework === "django-settings"
                    ? `${b.id} no longer includes ${lost.join(", ")}, the rule that applies to every view that does not set its own.`
                    : `${b.id} no longer runs the auth check ${lost.join(", ")} before its handler.`,
                restore: `${restoreGuard(b.framework, lost[0] ?? "the check")} ${accept(b.id)}`,
            };
        }
        case "rls-table": {
            const x = a;
            if (b.rlsEnabled && !x.rlsEnabled) {
                return {
                    ...base,
                    summary: `Row-level security (per-user data access rules) is now off for ${b.id}.`,
                    restore: `Re-enable it with ALTER TABLE ${tableOf(b.id)} ENABLE ROW LEVEL SECURITY. ${accept(b.id)}`,
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
            const loosened = x.policies.filter((p) => b.policies.some((o) => o.name === p.name && !o.open && p.open));
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
        case "middleware": {
            const x = a;
            const lost = b.guards.filter((g) => !x.guards.includes(g));
            // Coverage only matters when the middleware actually checks something.
            const nowCovered = new Set(x.covered);
            const stillExist = new Set(x.routes);
            const uncovered = b.guards.length ? b.covered.filter((r) => stillExist.has(r) && !nowCovered.has(r)) : [];
            if (lost.length === 0 && uncovered.length === 0)
                return null;
            const parts = [
                ...(lost.length ? [`no longer runs the auth check ${lost.join(", ")} on incoming requests`] : []),
                ...(uncovered.length
                    ? [`its matcher no longer covers ${uncovered.slice(0, 5).join(", ")}${uncovered.length > 5 ? ` and ${uncovered.length - 5} more` : ""}, so requests to ${uncovered.length === 1 ? "that route skip" : "those routes skip"} the middleware`]
                    : []),
            ];
            return {
                ...base,
                summary: `${b.file}: ${parts.join(", and ")}.`,
                restore: `${lost.length ? `Put the ${lost[0]} check back in the middleware. ` : ""}${uncovered.length ? "Widen config.matcher so it covers those routes again. " : ""}${accept(b.id)}`,
            };
        }
        case "header":
            return null; // presence is checked via removal above
    }
}
