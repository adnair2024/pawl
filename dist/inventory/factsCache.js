"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FactsCache = void 0;
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
/** A short stable name for a project path. Not crypto: loading node:crypto costs more than a hook can spare. */
function hash(text) {
    let h1 = 5381;
    let h2 = 52711;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        h1 = (h1 * 33) ^ c;
        h2 = (h2 * 31) ^ c;
    }
    return ((h1 >>> 0).toString(16) + (h2 >>> 0).toString(16)).padStart(16, "0");
}
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
        this.path = (0, node_path_1.join)((0, node_os_1.tmpdir)(), `pawl-${name}-${hash(root)}.json`);
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
    async getAsync(file, stat, compute) {
        const hit = this.data[file];
        if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size)
            return hit.facts;
        const facts = await compute();
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
