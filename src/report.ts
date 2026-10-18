import type { Regression } from "./types";

export function formatRegression(r: Regression): string {
  return [
    `- File: ${r.file}`,
    `  Control: ${r.controlId} (${r.kind})`,
    `  What changed: ${r.summary}`,
    `  How to restore: ${r.restore}`,
  ].join("\n");
}

export function formatRegressions(rs: Regression[], intro: string): string {
  return [
    `pawl: ${intro}`,
    "pawl keeps a record of the security protections this app already had. These ones got weaker or went missing:",
    "",
    ...rs.map(formatRegression),
    "",
    "Restore the protection (preferred). Only accept the change if the user confirms it is intended.",
  ].join("\n");
}
