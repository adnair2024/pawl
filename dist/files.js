"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listFiles = listFiles;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const IGNORED_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", ".venv", "venv", "__pycache__", ".pawl"]);
/** All project files as POSIX-style paths relative to `root`. */
function listFiles(root) {
    const out = [];
    const walk = (dir) => {
        for (const entry of (0, node_fs_1.readdirSync)(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                if (!IGNORED_DIRS.has(entry.name))
                    walk((0, node_path_1.join)(dir, entry.name));
            }
            else if (entry.isFile()) {
                out.push((0, node_path_1.relative)(root, (0, node_path_1.join)(dir, entry.name)).split(node_path_1.sep).join("/"));
            }
        }
    };
    walk(root);
    return out.sort();
}
