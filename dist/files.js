"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isTestPath = void 0;
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
/** Test and fixture code mentions headers without sending them; it must not count as protection. */
const isTestPath = (p) => /(^|\/)(tests?|__tests__|spec|e2e|cypress|fixtures)\//.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || /(^|\/)test_[^/]*\.py$|_test\.py$|(^|\/)conftest\.py$/.test(p);
exports.isTestPath = isTestPath;
