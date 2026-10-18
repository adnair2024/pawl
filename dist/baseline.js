"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.baselinePath = void 0;
exports.readBaseline = readBaseline;
exports.writeBaseline = writeBaseline;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const types_1 = require("./types");
const baselinePath = (root) => (0, node_path_1.join)(root, ".pawl", "baseline.json");
exports.baselinePath = baselinePath;
function readBaseline(root) {
    const path = (0, exports.baselinePath)(root);
    let raw;
    try {
        raw = (0, node_fs_1.readFileSync)(path, "utf8");
    }
    catch {
        return { ok: false, reason: "missing", detail: `${path} not found. Run /pawl:init.` };
    }
    let data;
    try {
        data = JSON.parse(raw);
    }
    catch (e) {
        return { ok: false, reason: "corrupt", detail: `${path} is not valid JSON: ${String(e)}` };
    }
    const b = data;
    if (!b || typeof b.version !== "number" || !Array.isArray(b.controls)) {
        return { ok: false, reason: "corrupt", detail: `${path} has an unexpected shape.` };
    }
    if (b.version > types_1.BASELINE_VERSION) {
        return {
            ok: false,
            reason: "newer-version",
            detail: `${path} was written by a newer pawl (v${b.version}). Update the plugin.`,
        };
    }
    return { ok: true, baseline: b };
}
function writeBaseline(root, baseline) {
    const path = (0, exports.baselinePath)(root);
    (0, node_fs_1.mkdirSync)((0, node_path_1.dirname)(path), { recursive: true });
    const tmp = `${path}.tmp`;
    (0, node_fs_1.writeFileSync)(tmp, JSON.stringify(baseline, null, 2) + "\n");
    (0, node_fs_1.renameSync)(tmp, path);
}
