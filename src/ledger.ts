import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Control } from "./types";

export interface LedgerEntry {
  timestamp: string;
  controlId: string;
  before: Control | null;
  after: Control | null;
  reason: string;
}

export const ledgerPath = (root: string) => join(root, ".pawl", "ledger.jsonl");

export function appendLedger(root: string, entry: LedgerEntry): void {
  const path = ledgerPath(root);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + "\n");
}

export function readLedger(root: string, limit = 10): LedgerEntry[] {
  try {
    const lines = readFileSync(ledgerPath(root), "utf8").split("\n").filter(Boolean);
    return lines.slice(-limit).map((l) => JSON.parse(l) as LedgerEntry);
  } catch {
    return [];
  }
}
