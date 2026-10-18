import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const IGNORED_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", ".venv", "venv", "__pycache__", ".pawl"]);

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
