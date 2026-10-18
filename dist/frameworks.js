"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectFrameworks = detectFrameworks;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
/** Frameworks pawl reads today. Anything else found in a manifest is reported as not covered. */
const SUPPORTED_JS = { next: "Next.js", express: "Express" };
const UNSUPPORTED_JS = {
    fastify: "Fastify",
    koa: "Koa",
    hono: "Hono",
    "@nestjs/core": "NestJS",
    "@hapi/hapi": "Hapi",
};
const PYTHON = {
    fastapi: { label: "FastAPI", supported: true },
    flask: { label: "Flask", supported: true },
    django: { label: "Django", supported: true },
};
const read = (root, file) => {
    try {
        return (0, node_fs_1.readFileSync)((0, node_path_1.join)(root, file), "utf8");
    }
    catch {
        return "";
    }
};
function detectFrameworks(root) {
    const out = { supported: [], unsupported: [] };
    let deps = [];
    try {
        const pkg = JSON.parse(read(root, "package.json") || "{}");
        deps = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
    }
    catch {
        /* unreadable package.json: report nothing rather than guess */
    }
    for (const d of deps) {
        if (SUPPORTED_JS[d])
            out.supported.push(SUPPORTED_JS[d]);
        else if (UNSUPPORTED_JS[d])
            out.unsupported.push(UNSUPPORTED_JS[d]);
    }
    const py = (read(root, "requirements.txt") + read(root, "pyproject.toml") + read(root, "Pipfile")).toLowerCase();
    for (const [key, { label, supported }] of Object.entries(PYTHON)) {
        if (new RegExp(`(^|[\\s"'\\[,])${key}([\\s"'=<>~!\\[,;]|$)`, "m").test(py))
            (supported ? out.supported : out.unsupported).push(label);
    }
    return out;
}
