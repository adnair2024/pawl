"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.worstOrigin = exports.ORIGIN_RANK = exports.HEADER_MARKER = exports.canonicalHeader = exports.CORS_ORIGIN_HEADER = exports.SECURITY_HEADERS = void 0;
exports.controlsFromHeaderFacts = controlsFromHeaderFacts;
/** The response headers pawl treats as security controls, in their canonical spelling. */
exports.SECURITY_HEADERS = [
    "Content-Security-Policy",
    "Strict-Transport-Security",
    "X-Frame-Options",
    "X-Content-Type-Options",
    "Referrer-Policy",
    "Permissions-Policy",
    "Cross-Origin-Opener-Policy",
    "Cross-Origin-Resource-Policy",
    "Cross-Origin-Embedder-Policy",
];
exports.CORS_ORIGIN_HEADER = "Access-Control-Allow-Origin";
const BY_LOWER = new Map([...exports.SECURITY_HEADERS, exports.CORS_ORIGIN_HEADER].map((h) => [h.toLowerCase(), h]));
/** "x-frame-options" -> "X-Frame-Options"; undefined if it is not a header we track. */
const canonicalHeader = (name) => BY_LOWER.get(name.trim().toLowerCase());
exports.canonicalHeader = canonicalHeader;
/** Cheap pre-filter so files that never mention headers or CORS are not parsed at all. */
exports.HEADER_MARKER = /access-control|helmet|cors|x-frame|strict-transport|content-security|referrer-policy|x-content-type|permissions-policy|cross-origin-|talisman|secure_|x_frame|securitymiddleware|xframeoptions/i;
exports.ORIGIN_RANK = { none: 0, allowlist: 1, reflect: 2, wildcard: 3 };
/**
 * Headers are tracked project-wide (is X-Frame-Options set anywhere?), so moving one
 * between files is not a regression. CORS is tracked per file, where it lives.
 */
function controlsFromHeaderFacts(all) {
    const controls = [];
    const seen = new Set();
    for (const f of [...all].sort((a, b) => (a.file < b.file ? -1 : 1))) {
        for (const header of f.headers) {
            if (seen.has(header))
                continue;
            seen.add(header);
            controls.push({ kind: "header", id: `header:${header}`, file: f.file, lang: f.lang, header });
        }
        if (f.cors)
            controls.push({ kind: "cors", id: `${f.file}#cors`, file: f.file, lang: f.lang, origin: f.cors });
    }
    return controls;
}
const worstOrigin = (a, b) => !a ? b : !b ? a : exports.ORIGIN_RANK[b] > exports.ORIGIN_RANK[a] ? b : a;
exports.worstOrigin = worstOrigin;
