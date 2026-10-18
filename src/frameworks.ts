import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Frameworks pawl reads today. Anything else found in a manifest is reported as not covered. */
const SUPPORTED_JS: Record<string, string> = { next: "Next.js", express: "Express" };
const UNSUPPORTED_JS: Record<string, string> = {
  fastify: "Fastify",
  koa: "Koa",
  hono: "Hono",
  "@nestjs/core": "NestJS",
  "@hapi/hapi": "Hapi",
};
const PYTHON: Record<string, string> = { fastapi: "FastAPI", flask: "Flask", django: "Django" };
/** Flip each to true as its reader lands. */
const PYTHON_SUPPORTED = false;

export interface Detected {
  supported: string[];
  unsupported: string[];
}

const read = (root: string, file: string): string => {
  try {
    return readFileSync(join(root, file), "utf8");
  } catch {
    return "";
  }
};

export function detectFrameworks(root: string): Detected {
  const out: Detected = { supported: [], unsupported: [] };
  let deps: string[] = [];
  try {
    const pkg = JSON.parse(read(root, "package.json") || "{}") as { dependencies?: object; devDependencies?: object };
    deps = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
  } catch {
    /* unreadable package.json: report nothing rather than guess */
  }
  for (const d of deps) {
    if (SUPPORTED_JS[d]) out.supported.push(SUPPORTED_JS[d]);
    else if (UNSUPPORTED_JS[d]) out.unsupported.push(UNSUPPORTED_JS[d]);
  }
  const py = (read(root, "requirements.txt") + read(root, "pyproject.toml") + read(root, "Pipfile")).toLowerCase();
  for (const [key, label] of Object.entries(PYTHON)) {
    if (new RegExp(`(^|[\\s"'\\[,])${key}([\\s"'=<>~!\\[,;]|$)`, "m").test(py)) (PYTHON_SUPPORTED ? out.supported : out.unsupported).push(label);
  }
  return out;
}
