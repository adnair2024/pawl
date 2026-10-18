"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_SOURCE_BYTES = exports.isTestPath = void 0;
exports.listFiles = listFiles;
exports.readSource = readSource;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const IGNORED_DIRS = new Set([
    "node_modules", ".git", ".next", "dist", "build", ".venv", "venv", "__pycache__", ".pawl",
    // caches, build output and tool folders that never hold the app's own source
    "coverage", ".turbo", ".vercel", ".output", ".nuxt", ".svelte-kit", ".cache", ".parcel-cache", "out",
    ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache", "site-packages", ".idea", ".vscode",
]);
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
/** Source files bigger than this are bundles or generated output, not hand-written app code. */
exports.MAX_SOURCE_BYTES = 2 * 1024 * 1024;
/** Read a source file as text, refusing huge ones so a minified bundle cannot stall a hook. Throws if refused. */
function readSource(path) {
    if ((0, node_fs_1.statSync)(path).size > exports.MAX_SOURCE_BYTES)
        throw new Error(`${path} is larger than ${exports.MAX_SOURCE_BYTES} bytes; skipped`);
    return (0, node_fs_1.readFileSync)(path, "utf8");
}
