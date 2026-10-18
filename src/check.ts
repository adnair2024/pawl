import { existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { readBaseline, writeBaseline } from "./baseline";
import { compare } from "./compare";
import { listFiles } from "./files";
import { expandFiles, scanFiles } from "./inventory";
import { appendLedger } from "./ledger";
import { BASELINE_VERSION, type Baseline, type Control, type Inventory, type Regression } from "./types";

/** Nearest ancestor holding `.pawl` or `.git`; falls back to `start`. */
export function findRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".pawl")) || existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

export const toRelative = (root: string, file: string): string => relative(root, resolve(root, file)).split(sep).join("/");

export async function scanAll(root: string): Promise<Inventory> {
  return scanFiles(root, listFiles(root));
}

export interface CheckResult {
  regressions: Regression[];
  unparsed: { file: string; reason: string }[];
  current: Inventory;
}

/**
 * Compare `baseline` to the project as it is now. With `files`, only those files are
 * re-inventoried and only their controls are compared (the fast path).
 */
export async function check(root: string, baseline: Baseline, files?: string[]): Promise<CheckResult> {
  const targets = files ? expandFiles(root, files) : undefined;
  const current = targets ? await scanFiles(root, targets) : await scanAll(root);
  const scope = targets ? new Set(targets) : undefined;
  const broken = new Set(current.unparsed.map((u) => u.file));

  // A file we cannot read is never "safe": report it separately from a removed control.
  const readable = baseline.controls.filter((c) => !broken.has(c.file));
  const regressions = compare(readable, current.controls, scope);
  for (const c of baseline.controls.filter((c) => broken.has(c.file))) {
    if (scope && !scope.has(c.file)) continue;
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

export async function init(root: string): Promise<Baseline> {
  const inv = await scanAll(root);
  const baseline: Baseline = {
    version: BASELINE_VERSION,
    createdAt: new Date().toISOString(),
    controls: inv.controls,
    unparsed: inv.unparsed,
    ...(inv.partial?.length ? { partial: inv.partial } : {}),
  };
  writeBaseline(root, baseline);
  return baseline;
}

/**
 * Move the baseline forward only: add new controls and adopt controls that are the same
 * or stronger. Anything regressed or missing stays as it was.
 */
export function ratchet(baseline: Baseline, current: Control[], regressed: Set<string>): Baseline {
  const now = new Map(current.map((c) => [c.id, c]));
  const known = new Set(baseline.controls.map((c) => c.id));
  const controls = baseline.controls.map((c) => (regressed.has(c.id) ? c : (now.get(c.id) ?? c)));
  for (const c of current) if (!known.has(c.id)) controls.push(c);
  return { ...baseline, controls };
}

export type AcceptResult = { ok: true; controlId: string } | { ok: false; error: string };

/** The only way to lower the baseline: record why, then adopt the current state. */
export async function accept(root: string, controlId: string, reason: string): Promise<AcceptResult> {
  if (!reason.trim()) return { ok: false, error: "A reason is required." };
  const loaded = readBaseline(root);
  if (!loaded.ok) return { ok: false, error: loaded.detail };
  const { baseline } = loaded;
  const before = baseline.controls.find((c) => c.id === controlId) ?? null;

  // A control the baseline never had (a brand-new table without RLS) is found by a full check.
  const { regressions, current } = await check(root, baseline, before ? [before.file] : undefined);
  if (!regressions.some((r) => r.controlId === controlId)) {
    return { ok: false, error: before ? `"${controlId}" has not regressed, so there is nothing to accept.` : `No control with id "${controlId}" in the baseline or the project.` };
  }
  const after = current.controls.find((c) => c.id === controlId) ?? null;
  appendLedger(root, { timestamp: new Date().toISOString(), controlId, before, after, reason: reason.trim() });
  const controls = baseline.controls.filter((c) => c.id !== controlId);
  if (after) controls.push(after);
  writeBaseline(root, { ...baseline, controls });
  return { ok: true, controlId };
}
