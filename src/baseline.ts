import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BASELINE_VERSION, type Baseline } from "./types";

export const baselinePath = (root: string) => join(root, ".pawl", "baseline.json");

export type BaselineResult =
  | { ok: true; baseline: Baseline }
  | { ok: false; reason: "missing" | "corrupt" | "newer-version"; detail: string };

export function readBaseline(root: string): BaselineResult {
  const path = baselinePath(root);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { ok: false, reason: "missing", detail: `${path} not found. Run /pawl:init.` };
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: "corrupt", detail: `${path} is not valid JSON: ${String(e)}` };
  }
  const b = data as Partial<Baseline> | null;
  if (!b || typeof b.version !== "number" || !Array.isArray(b.controls)) {
    return { ok: false, reason: "corrupt", detail: `${path} has an unexpected shape.` };
  }
  if (b.version > BASELINE_VERSION) {
    return {
      ok: false,
      reason: "newer-version",
      detail: `${path} was written by a newer pawl (v${b.version}). Update the plugin.`,
    };
  }
  return { ok: true, baseline: b as Baseline };
}

export function writeBaseline(root: string, baseline: Baseline): void {
  const path = baselinePath(root);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(baseline, null, 2) + "\n");
  renameSync(tmp, path);
}
