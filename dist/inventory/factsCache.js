"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FactsCache = void 0;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
/**
 * Per-file parse results that survive between hook runs, so an edit only re-parses the
 * files that changed. Lives in the OS temp dir (never in the user's repo); any failure
 * just means a slower run. `name` must change whenever the shape of the cached facts does
 * (e.g. "fastapi-2"), otherwise old files on a user's machine would be read as the new shape.
 */
class FactsCache {
    path;
    data;
    constructor(name, root) {
        this.path = (0, node_path_1.join)((0, node_os_1.tmpdir)(), `pawl-${name}-${(0, node_crypto_1.createHash)("sha1").update(root).digest("hex").slice(0, 12)}.json`);
        try {
            this.data = JSON.parse((0, node_fs_1.readFileSync)(this.path, "utf8"));
        }
        catch {
            this.data = {};
        }
    }
    get(file, stat, compute) {
        const hit = this.data[file];
        if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size)
            return hit.facts;
        const facts = compute();
        this.data[file] = { mtimeMs: stat.mtimeMs, size: stat.size, facts };
        return facts;
    }
    save() {
        try {
            (0, node_fs_1.writeFileSync)(this.path, JSON.stringify(this.data));
        }
        catch {
            /* cache is an optimisation only */
        }
    }
}
exports.FactsCache = FactsCache;
