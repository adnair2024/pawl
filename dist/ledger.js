"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ledgerPath = void 0;
exports.appendLedger = appendLedger;
exports.readLedger = readLedger;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const ledgerPath = (root) => (0, node_path_1.join)(root, ".pawl", "ledger.jsonl");
exports.ledgerPath = ledgerPath;
function appendLedger(root, entry) {
    const path = (0, exports.ledgerPath)(root);
    (0, node_fs_1.mkdirSync)((0, node_path_1.dirname)(path), { recursive: true });
    (0, node_fs_1.appendFileSync)(path, JSON.stringify(entry) + "\n");
}
function readLedger(root, limit = 10) {
    try {
        const lines = (0, node_fs_1.readFileSync)((0, exports.ledgerPath)(root), "utf8").split("\n").filter(Boolean);
        return lines.slice(-limit).map((l) => JSON.parse(l));
    }
    catch {
        return [];
    }
}
