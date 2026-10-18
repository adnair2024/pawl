"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.baselineFile = void 0;
exports.guardReason = guardReason;
exports.unexplainedBaselineChanges = unexplainedBaselineChanges;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const baseline_1 = require("./baseline");
const compare_1 = require("./compare");
const ledger_1 = require("./ledger");
const ASK_USER = 'Ask the user to run it themselves: /pawl:accept <control-id> "<reason>" (or /pawl:init to re-snapshot). Do not work around this.';
/** Commands that only look at .pawl/ are fine. */
const READ_ONLY = /^\s*(cat|ls|find|stat|head|tail|less|grep|rg|wc|jq|diff|git\s+(diff|log|show|status|add|commit))\b/;
/**
 * Why Claude may not run this tool call, or null if it may.
 * Only the user may lower the baseline, so Claude is kept away from the accept path
 * and from the files that record it. This stops mistakes, not a determined bypass.
 */
function guardReason(tool, input) {
    if (input.file_path && /(^|[\\/])\.pawl([\\/]|$)/.test(input.file_path)) {
        return `pawl: .pawl/ holds the security baseline and accepted-change log; editing it by hand would hide weakened protections. ${ASK_USER}`;
    }
    const cmd = input.command;
    if (tool === "Bash" && cmd) {
        if (/\bcli\.js\b[^|;&\n]*\b(accept|init)\b|\bpawl\s+(accept|init)\b/.test(cmd)) {
            return `pawl: only the user may accept a weakened protection or re-snapshot the baseline. ${ASK_USER}`;
        }
        if (/\.pawl\b/.test(cmd) && !READ_ONLY.test(cmd)) {
            return `pawl: .pawl/ holds the security baseline and accepted-change log; changing it from the shell would hide weakened protections. ${ASK_USER}`;
        }
    }
    return null;
}
const gitShow = (root, path) => {
    try {
        return (0, node_child_process_1.execFileSync)("git", ["show", `HEAD:${path}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    }
    catch {
        return null; // no commit yet, file untracked, or git missing: nothing to compare
    }
};
const parseLedger = (text) => text.split("\n").filter(Boolean);
/**
 * Controls the working baseline lowered compared to the last commit without a new
 * ledger entry explaining why. Catches hand-edited baselines that skipped the hook.
 */
function unexplainedBaselineChanges(root) {
    const head = gitShow(root, ".pawl/baseline.json");
    if (!head)
        return [];
    let before;
    try {
        before = JSON.parse(head);
    }
    catch {
        return [];
    }
    const now = (0, baseline_1.readBaseline)(root);
    if (!now.ok)
        return [];
    let accepted = new Set();
    try {
        const old = new Set(parseLedger(gitShow(root, ".pawl/ledger.jsonl") ?? ""));
        accepted = new Set(parseLedger((0, node_fs_1.readFileSync)((0, ledger_1.ledgerPath)(root), "utf8"))
            .filter((l) => !old.has(l))
            .map((l) => JSON.parse(l).controlId));
    }
    catch {
        /* no ledger file: nothing was accepted */
    }
    return (0, compare_1.compare)(before.controls, now.baseline.controls)
        .map((r) => r.controlId)
        .filter((id) => !accepted.has(id));
}
const baselineFile = (root) => (0, node_path_1.join)(root, ".pawl", "baseline.json");
exports.baselineFile = baselineFile;
