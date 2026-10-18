import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build", ".venv", "venv", "__pycache__", ".pawl",
  // caches, build output and tool folders that never hold the app's own source
  "coverage", ".turbo", ".vercel", ".output", ".nuxt", ".svelte-kit", ".cache", ".parcel-cache", "out",
  ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache", "site-packages", ".idea", ".vscode",
]);

/** All project files as POSIX-style paths relative to `root`. */
export function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        out.push(relative(root, join(dir, entry.name)).split(sep).join("/"));
      }
    }
  };
  walk(root);
  return out.sort();
}

/** Test and fixture code mentions headers without sending them; it must not count as protection. */
export const isTestPath = (p: string): boolean =>
  /(^|\/)(tests?|__tests__|spec|e2e|cypress|fixtures)\//.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || /(^|\/)test_[^/]*\.py$|_test\.py$|(^|\/)conftest\.py$/.test(p);


/** Source files bigger than this are bundles or generated output, not hand-written app code. */
export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

/** Read a source file as text, refusing huge ones so a minified bundle cannot stall a hook. Throws if refused. */
export function readSource(path: string): string {
  if (statSync(path).size > MAX_SOURCE_BYTES) throw new Error(`${path} is larger than ${MAX_SOURCE_BYTES} bytes; skipped`);
  return readFileSync(path, "utf8");
}
