import type { Inventorier, Inventory } from "../types";
import { djangoRoutes } from "./djangoRoutes";
import { expressRoutes } from "./expressRoutes";
import { fastapiRoutes } from "./fastapiRoutes";
import { flaskRoutes } from "./flaskRoutes";
import { supabaseRls } from "./supabaseRls";
import { nextRoutes } from "./nextRoutes";

export const inventoriers: Inventorier[] = [nextRoutes, expressRoutes, fastapiRoutes, flaskRoutes, djangoRoutes, supabaseRls];

export const isTracked = (relPath: string): boolean => inventoriers.some((i) => i.handles(relPath));

/** Inventory the given files (relative paths) with every inventorier that wants them. */
export async function scanFiles(root: string, files: string[]): Promise<Inventory> {
  const result: Inventory = { controls: [], unparsed: [] };
  for (const inv of inventoriers) {
    const mine = files.filter((f) => inv.handles(f));
    if (mine.length === 0) continue;
    const r = await inv.scan(root, mine);
    result.controls.push(...r.controls);
    result.unparsed.push(...r.unparsed);
    if (r.partial?.length) result.partial = [...(result.partial ?? []), ...r.partial];
  }
  return result;
}

/** Files to re-inventory when `files` change, including files whose controls depend on them. */
export function expandFiles(root: string, files: string[]): string[] {
  return inventoriers.reduce((acc, inv) => (inv.expand ? inv.expand(root, acc) : acc), files);
}
