"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.nextRoutes = void 0;
exports.inventoryNextFile = inventoryNextFile;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const jsGuards_1 = require("./jsGuards");
const ROUTE_FILE = /(^|\/)app\/(.*\/)?route\.(ts|tsx|js|jsx|mjs)$/;
const CODE_FILE = /\.(ts|tsx|js|jsx|mjs)$/;
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
function handlerFrom(exported) {
    const decl = exported.children().find((c) => c.isNamed() && c.kind() !== "decorator");
    if (!decl)
        return [];
    if (decl.kind() === "function_declaration") {
        const name = decl.field("name")?.text();
        return name ? [{ name, body: decl.field("body"), wrapperGuards: [] }] : [];
    }
    if (decl.kind() !== "lexical_declaration")
        return [];
    const out = [];
    for (const d of decl.children().filter((c) => c.kind() === "variable_declarator")) {
        const nameNode = d.field("name");
        if (!nameNode || nameNode.kind() !== "identifier")
            continue;
        let value = (0, jsGuards_1.unwrapAwait)(d.field("value"));
        const wrapperGuards = [];
        // export const POST = withAuth(async (req) => {...})
        while (value && value.kind() === "call_expression") {
            const callee = value.field("function")?.text() ?? "";
            if (jsGuards_1.GUARD_NAME.test(callee))
                wrapperGuards.push((0, jsGuards_1.normalizeCallee)(callee));
            value = value.field("arguments")?.children().find((c) => (0, jsGuards_1.isFn)(c) || c.kind() === "call_expression") ?? null;
        }
        out.push({ name: nameNode.text(), body: value && (0, jsGuards_1.isFn)(value) ? value.field("body") : null, wrapperGuards });
    }
    return out;
}
const hasUseServer = (root) => root.children().some((c) => c.kind() === "expression_statement" && /^["']use server["']$/.test(c.text().replace(/;$/, "")));
function inventoryNextFile(relPath, source) {
    const parsed = (0, jsGuards_1.parseJs)(relPath, source);
    if ("error" in parsed)
        return { controls: [], unparsed: [{ file: relPath, reason: parsed.error }] };
    const { root, lang } = parsed;
    const isRoute = ROUTE_FILE.test(relPath);
    const isAction = !isRoute && hasUseServer(root);
    if (!isRoute && !isAction)
        return { controls: [], unparsed: [] };
    const controls = [];
    for (const exp of root.children().filter((c) => c.kind() === "export_statement")) {
        for (const h of handlerFrom(exp)) {
            if (isRoute && !HTTP_METHODS.has(h.name))
                continue;
            const guards = [...h.wrapperGuards, ...(h.body ? (0, jsGuards_1.guardsInBody)(h.body) : [])];
            controls.push({
                kind: "route-auth",
                id: `${relPath}#${h.name}`,
                file: relPath,
                lang,
                framework: isRoute ? "next-route" : "next-action",
                guards,
            });
        }
    }
    return { controls, unparsed: [] };
}
exports.nextRoutes = {
    name: "next-routes",
    handles: (p) => CODE_FILE.test(p),
    async scan(root, files) {
        const result = { controls: [], unparsed: [] };
        for (const f of files.filter((p) => CODE_FILE.test(p))) {
            let source;
            try {
                source = (0, node_fs_1.readFileSync)((0, node_path_1.join)(root, f), "utf8");
            }
            catch {
                continue;
            }
            if (!ROUTE_FILE.test(f) && !source.includes("use server"))
                continue;
            const r = inventoryNextFile(f, source);
            result.controls.push(...r.controls);
            result.unparsed.push(...r.unparsed);
        }
        return result;
    },
};
