"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatRegression = formatRegression;
exports.formatRegressions = formatRegressions;
function formatRegression(r) {
    return [
        `- File: ${r.file}`,
        `  Control: ${r.controlId} (${r.kind})`,
        `  What changed: ${r.summary}`,
        `  How to restore: ${r.restore}`,
    ].join("\n");
}
function formatRegressions(rs, intro) {
    return [
        `pawl: ${intro}`,
        "pawl keeps a record of the security protections this app already had. These ones got weaker or went missing:",
        "",
        ...rs.map(formatRegression),
        "",
        "Restore the protection (preferred). Only accept the change if the user confirms it is intended.",
    ].join("\n");
}
