import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** One edit Claude made, written by the PostToolUse hook. */
export interface EditEntry {
  ts: string;
  source: "hook";
  tool: string;
  file: string;
  /** Lines in the new text and lines in the replaced text. `removed` is null for a whole-file write. */
  added: number;
  removed: number | null;
  session?: string;
}

/** One commit found in git history by `pawl log sync`. */
export interface CommitEntry {
  ts: string;
  source: "git";
  commit: string;
  author: string;
  subject: string;
  /** True when the commit carries a Claude/Anthropic `Co-Authored-By` trailer. */
  claude: boolean;
  files: { path: string; added: number | null; removed: number | null }[];
}

export type AuditEntry = EditEntry | CommitEntry;

export interface EditInput {
  file_path?: string;
  old_string?: string;
  new_string?: string;
  content?: string;
  edits?: { old_string?: string; new_string?: string }[];
}

export const auditPath = (root: string) => join(root, ".pawl", "audit.jsonl");

const lineCount = (s: string | undefined): number => (s ? s.split("\n").length : 0);

function append(root: string, entries: AuditEntry[]): void {
  if (entries.length === 0) return;
  const path = auditPath(root);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

/** Record an edit. Never throws: logging must not get in the way of the session. */
export function recordEdit(root: string, tool: string, file: string, input: EditInput, session?: string): void {
  try {
    let added: number;
    let removed: number | null;
    if (input.edits) {
      added = input.edits.reduce((n, e) => n + lineCount(e.new_string), 0);
      removed = input.edits.reduce((n, e) => n + lineCount(e.old_string), 0);
    } else if (input.content !== undefined) {
      added = lineCount(input.content);
      removed = null;
    } else {
      added = lineCount(input.new_string);
      removed = lineCount(input.old_string);
    }
    append(root, [{ ts: new Date().toISOString(), source: "hook", tool, file, added, removed, ...(session ? { session } : {}) }]);
  } catch {
    /* fail open */
  }
}

export function readAudit(root: string): AuditEntry[] {
  let text: string;
  try {
    text = readFileSync(auditPath(root), "utf8");
  } catch {
    return [];
  }
  const out: AuditEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as AuditEntry);
    } catch {
      /* a damaged line must not hide the rest */
    }
  }
  return out;
}

const REC = "\x1e";
const FIELD = "\x1f";
const CLAUDE_TRAILER = /claude|anthropic/i;
const num = (s: string): number | null => (s === "-" ? null : Number(s));

const NUMSTAT = /^(\d+|-)\t(\d+|-)\t(.+)$/;

/** Parse `git log --numstat` output produced with the format used in `gitCommits`. */
export function parseGitLog(raw: string): CommitEntry[] {
  const commits: CommitEntry[] = [];
  for (const rec of raw.split(REC)) {
    const [commit, ts, author, subject, ...tail] = rec.trim().split(FIELD);
    if (!commit || !ts) continue;
    // The last field holds the trailers (which may span lines) followed by the numstat lines.
    const lines = tail.join(FIELD).split("\n");
    const files = lines.flatMap((l) => {
      const m = NUMSTAT.exec(l);
      return m ? [{ path: m[3] ?? "", added: num(m[1] ?? ""), removed: num(m[2] ?? "") }] : [];
    });
    const trailers = lines.filter((l) => !NUMSTAT.test(l)).join(" ");
    commits.push({ ts, source: "git", commit, author: author ?? "", subject: subject ?? "", claude: CLAUDE_TRAILER.test(trailers), files });
  }
  return commits;
}

function gitCommits(root: string, since?: string): CommitEntry[] {
  const raw = execFileSync(
    "git",
    ["log", "--reverse", "--numstat", ...(since ? [`--since=${since}`] : []), `--format=${REC}%H${FIELD}%aI${FIELD}%an${FIELD}%s${FIELD}%(trailers:key=Co-Authored-By,valueonly,separator=%x2c)`],
    { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
  );
  return parseGitLog(raw);
}

export type SyncResult = { ok: true; added: number; alreadyLogged: number } | { ok: false; error: string };

/**
 * Append every commit in git history that is not in the audit log yet. Safe to run repeatedly.
 * `since` is anything git's `--since` accepts, such as "2026-01-01" or "2 weeks ago".
 */
export function syncFromGit(root: string, since?: string): SyncResult {
  let commits: CommitEntry[];
  try {
    commits = gitCommits(root, since);
  } catch (e) {
    const msg = e instanceof Error && "stderr" in e ? String((e as { stderr: unknown }).stderr).trim() : String(e);
    return { ok: false, error: `could not read git history${msg ? ` (${msg})` : ""}. Is this a git repository with at least one commit?` };
  }
  const known = new Set(readAudit(root).flatMap((e) => (e.source === "git" ? [e.commit] : [])));
  const fresh = commits.filter((c) => !known.has(c.commit));
  append(root, fresh);
  return { ok: true, added: fresh.length, alreadyLogged: commits.length - fresh.length };
}

/** One short line per entry, newest last, written to be cheap to read. */
export function formatEntry(e: AuditEntry): string {
  const when = e.ts.slice(0, 16).replace("T", " ");
  if (e.source === "hook") {
    const delta = e.removed === null ? `+${e.added} (whole file)` : `+${e.added} -${e.removed}`;
    return `${when} ${e.tool} ${e.file} ${delta}`;
  }
  const added = e.files.reduce((n, f) => n + (f.added ?? 0), 0);
  const removed = e.files.reduce((n, f) => n + (f.removed ?? 0), 0);
  const who = e.claude ? " [claude]" : "";
  return `${when} commit ${e.commit.slice(0, 7)}${who} ${e.subject} (${e.files.length} files +${added} -${removed})`;
}
