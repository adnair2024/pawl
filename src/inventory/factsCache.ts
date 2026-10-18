import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Entry<T> { mtimeMs: number; size: number; facts: T }

/**
 * Per-file parse results that survive between hook runs, so an edit only re-parses the
 * files that changed. Lives in the OS temp dir (never in the user's repo); any failure
 * just means a slower run. `name` must change whenever the shape of the cached facts does
 * (e.g. "fastapi-2"), otherwise old files on a user's machine would be read as the new shape.
 */
export class FactsCache<T> {
  private readonly path: string;
  private readonly data: Record<string, Entry<T>>;

  constructor(name: string, root: string) {
    this.path = join(tmpdir(), `pawl-${name}-${createHash("sha1").update(root).digest("hex").slice(0, 12)}.json`);
    try {
      this.data = JSON.parse(readFileSync(this.path, "utf8")) as Record<string, Entry<T>>;
    } catch {
      this.data = {};
    }
  }

  get(file: string, stat: { mtimeMs: number; size: number }, compute: () => T): T {
    const hit = this.data[file];
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.facts;
    const facts = compute();
    this.data[file] = { mtimeMs: stat.mtimeMs, size: stat.size, facts };
    return facts;
  }

  save(): void {
    try {
      writeFileSync(this.path, JSON.stringify(this.data));
    } catch {
      /* cache is an optimisation only */
    }
  }
}
