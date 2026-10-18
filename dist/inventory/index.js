"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isTracked = exports.inventoriers = void 0;
exports.scanFiles = scanFiles;
exports.expandFiles = expandFiles;
const djangoRoutes_1 = require("./djangoRoutes");
const expressRoutes_1 = require("./expressRoutes");
const fastapiRoutes_1 = require("./fastapiRoutes");
const flaskRoutes_1 = require("./flaskRoutes");
const nextRoutes_1 = require("./nextRoutes");
exports.inventoriers = [nextRoutes_1.nextRoutes, expressRoutes_1.expressRoutes, fastapiRoutes_1.fastapiRoutes, flaskRoutes_1.flaskRoutes, djangoRoutes_1.djangoRoutes];
const isTracked = (relPath) => exports.inventoriers.some((i) => i.handles(relPath));
exports.isTracked = isTracked;
/** Inventory the given files (relative paths) with every inventorier that wants them. */
async function scanFiles(root, files) {
    const result = { controls: [], unparsed: [] };
    for (const inv of exports.inventoriers) {
        const mine = files.filter((f) => inv.handles(f));
        if (mine.length === 0)
            continue;
        const r = await inv.scan(root, mine);
        result.controls.push(...r.controls);
        result.unparsed.push(...r.unparsed);
    }
    return result;
}
/** Files to re-inventory when `files` change, including files whose controls depend on them. */
function expandFiles(root, files) {
    return exports.inventoriers.reduce((acc, inv) => (inv.expand ? inv.expand(root, acc) : acc), files);
}
