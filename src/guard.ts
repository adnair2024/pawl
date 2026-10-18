import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readBaseline } from "./baseline";
import { compare } from "./compare";
import { ledgerPath, type LedgerEntry } from "./ledger";
import type { Baseline } from "./types";

const ASK_USER =
  'Ask the user to run it themselves: /pawl:accept <control-id> "<reason>" (or /pawl:init to re-snapshot). Do not work around this.';

/** A single command that only looks at files, never changes them. */
const READ_ONLY = /^\s*(cat|ls|head|tail|less|grep|rg|wc|jq|diff|stat|file|git\s+(diff|log|show|status|add|commit|ls-files|check-ignore)|find\b(?!.*(-delete|-exec|-fprint|-ok)))\b/;

/** Split a shell line into its simple commands so one safe `cat` cannot excuse a dangerous neighbour. */
const segments = (cmd: string): string[] => cmd.split(/&&|\|\||[;|\n]/).map((x) => x.trim()).filter(Boolean);

/**
 * Why Claude may not run this tool call, or null if it may.
 * Only the user may lower the baseline, so Claude is kept away from the accept path
 * and from the files that record it. This stops mistakes, not a determined bypass.
 */
export function guardReason(tool: string | undefined, input: { file_path?: string; command?: string }): string | null {
  if (input.file_path && /(^|[\\/])\.pawl([\\/]|$)/.test(input.file_path)) {
    return `pawl: .pawl/ holds the security baseline and accepted-change log; editing it by hand would hide weakened protections. ${ASK_USER}`;
  }
  const cmd = input.command;
  if (tool === "Bash" && cmd) {
    if (/\bcli\.js\b[^|;&\n]*\b(accept|init)\b|\bpawl\s+(accept|init)\b/.test(cmd)) {
      return `pawl: only the user may accept a weakened protection or re-snapshot the baseline. ${ASK_USER}`;
    }
    // Any segment that touches .pawl must be a plain read, with no redirect into it.
    const risky = segments(cmd).some((seg) => /\.pawl\b/.test(seg) && (!READ_ONLY.test(seg) || />/.test(seg.replace(/2>&1|2>\/dev\/null/g, ""))));
    if (risky) {
      return `pawl: .pawl/ holds the security baseline and accepted-change log; changing it from the shell would hide weakened protections. ${ASK_USER}`;
    }
  }
  return null;
}

const gitShow = (root: string, path: string): string | null => {
  try {
    return execFileSync("git", ["show", `HEAD:${path}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null; // no commit yet, file untracked, or git missing: nothing to compare
  }
};

const parseLedger = (text: string): string[] => text.split("\n").filter(Boolean);

/**
 * Controls the working baseline lowered compared to the last commit without a new
 * ledger entry explaining why. Catches hand-edited baselines that skipped the hook.
 */
export function unexplainedBaselineChanges(root: string): string[] {
  const head = gitShow(root, ".pawl/baseline.json");
  if (!head) return [];
  let before: Baseline;
  try {
    before = JSON.parse(head) as Baseline;
  } catch {
    return [];
  }
  const now = readBaseline(root);
  if (!now.ok) return [];

  let accepted = new Set<string>();
  try {
    const old = new Set(parseLedger(gitShow(root, ".pawl/ledger.jsonl") ?? ""));
    accepted = new Set(
      parseLedger(readFileSync(ledgerPath(root), "utf8"))
        .filter((l) => !old.has(l))
        .map((l) => (JSON.parse(l) as LedgerEntry).controlId),
    );
  } catch {
    /* no ledger file: nothing was accepted */
  }
  return compare(before.controls, now.baseline.controls)
    .map((r) => r.controlId)
    .filter((id) => !accepted.has(id));
}

export const baselineFile = (root: string) => join(root, ".pawl", "baseline.json");
