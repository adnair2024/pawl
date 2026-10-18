"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toRelative = void 0;
exports.findRoot = findRoot;
exports.scanAll = scanAll;
exports.check = check;
exports.init = init;
exports.ratchet = ratchet;
exports.accept = accept;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const baseline_1 = require("./baseline");
const compare_1 = require("./compare");
const files_1 = require("./files");
const inventory_1 = require("./inventory");
const ledger_1 = require("./ledger");
const types_1 = require("./types");
/** Nearest ancestor holding `.pawl` or `.git`; falls back to `start`. */
function findRoot(start) {
    let dir = (0, node_path_1.resolve)(start);
    for (;;) {
        if ((0, node_fs_1.existsSync)((0, node_path_1.join)(dir, ".pawl")) || (0, node_fs_1.existsSync)((0, node_path_1.join)(dir, ".git")))
            return dir;
        const parent = (0, node_path_1.dirname)(dir);
        if (parent === dir)
            return (0, node_path_1.resolve)(start);
        dir = parent;
    }
}
const toRelative = (root, file) => (0, node_path_1.relative)(root, (0, node_path_1.resolve)(root, file)).split(node_path_1.sep).join("/");
exports.toRelative = toRelative;
async function scanAll(root) {
    return (0, inventory_1.scanFiles)(root, (0, files_1.listFiles)(root));
}
/**
 * Compare `baseline` to the project as it is now. With `files`, only those files are
 * re-inventoried and only their controls are compared (the fast path).
 */
async function check(root, baseline, files) {
    const targets = files ? await (0, inventory_1.expandFiles)(root, files) : undefined;
    const current = targets ? await (0, inventory_1.scanFiles)(root, targets) : await scanAll(root);
    const scope = targets ? new Set(targets) : undefined;
    const broken = new Set(current.unparsed.map((u) => u.file));
    // A file we cannot read is never "safe": report it separately from a removed control.
    const readable = baseline.controls.filter((c) => !broken.has(c.file));
    const regressions = (0, compare_1.compare)(readable, current.controls, scope);
    for (const c of baseline.controls.filter((c) => broken.has(c.file))) {
        if (scope && !scope.has(c.file))
            continue;
        regressions.push({
            controlId: c.id,
            file: c.file,
            kind: c.kind,
            summary: `${c.file} has a syntax error, so pawl cannot confirm ${c.id} is still protected.`,
            restore: "Fix the syntax error in the file, then pawl can re-check it.",
        });
    }
    // Plain comparison: localeCompare loads the ICU collator, ~40ms we cannot spend in a hook.
    regressions.sort((a, b) => (a.controlId < b.controlId ? -1 : a.controlId > b.controlId ? 1 : 0));
    return { regressions, unparsed: current.unparsed, current };
}
async function init(root) {
    const inv = await scanAll(root);
    const baseline = {
        version: types_1.BASELINE_VERSION,
        createdAt: new Date().toISOString(),
        controls: inv.controls,
        unparsed: inv.unparsed,
        ...(inv.partial?.length ? { partial: inv.partial } : {}),
    };
    (0, baseline_1.writeBaseline)(root, baseline);
    return baseline;
}
/**
 * Move the baseline forward only: add new controls and adopt controls that are the same
 * or stronger. Anything regressed or missing stays as it was.
 */
function ratchet(baseline, current, regressed) {
    const now = new Map(current.map((c) => [c.id, c]));
    const known = new Set(baseline.controls.map((c) => c.id));
    const controls = baseline.controls.map((c) => (regressed.has(c.id) ? c : (now.get(c.id) ?? c)));
    for (const c of current)
        if (!known.has(c.id))
            controls.push(c);
    return { ...baseline, controls };
}
/** The only way to lower the baseline: record why, then adopt the current state. */
async function accept(root, controlId, reason) {
    if (!reason.trim())
        return { ok: false, error: "A reason is required." };
    const loaded = (0, baseline_1.readBaseline)(root);
    if (!loaded.ok)
        return { ok: false, error: loaded.detail };
    const { baseline } = loaded;
    const before = baseline.controls.find((c) => c.id === controlId) ?? null;
    // A control the baseline never had (a brand-new table without RLS) is found by a full check.
    const { regressions, current } = await check(root, baseline, before ? [before.file] : undefined);
    if (!regressions.some((r) => r.controlId === controlId)) {
        return { ok: false, error: before ? `"${controlId}" has not regressed, so there is nothing to accept.` : `No control with id "${controlId}" in the baseline or the project.` };
    }
    const after = current.controls.find((c) => c.id === controlId) ?? null;
    (0, ledger_1.appendLedger)(root, { timestamp: new Date().toISOString(), controlId, before, after, reason: reason.trim() });
    const controls = baseline.controls.filter((c) => c.id !== controlId);
    if (after)
        controls.push(after);
    (0, baseline_1.writeBaseline)(root, { ...baseline, controls });
    return { ok: true, controlId };
}
