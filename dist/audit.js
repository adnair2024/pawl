"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.auditPath = void 0;
exports.recordEdit = recordEdit;
exports.readAudit = readAudit;
exports.parseGitLog = parseGitLog;
exports.syncFromGit = syncFromGit;
exports.formatEntry = formatEntry;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const auditPath = (root) => (0, node_path_1.join)(root, ".pawl", "audit.jsonl");
exports.auditPath = auditPath;
const lineCount = (s) => (s ? s.split("\n").length : 0);
function append(root, entries) {
    if (entries.length === 0)
        return;
    const path = (0, exports.auditPath)(root);
    (0, node_fs_1.mkdirSync)((0, node_path_1.dirname)(path), { recursive: true });
    (0, node_fs_1.appendFileSync)(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}
/** Record an edit. Never throws: logging must not get in the way of the session. */
function recordEdit(root, tool, file, input, session) {
    try {
        let added;
        let removed;
        if (input.edits) {
            added = input.edits.reduce((n, e) => n + lineCount(e.new_string), 0);
            removed = input.edits.reduce((n, e) => n + lineCount(e.old_string), 0);
        }
        else if (input.content !== undefined) {
            added = lineCount(input.content);
            removed = null;
        }
        else {
            added = lineCount(input.new_string);
            removed = lineCount(input.old_string);
        }
        append(root, [{ ts: new Date().toISOString(), source: "hook", tool, file, added, removed, ...(session ? { session } : {}) }]);
    }
    catch {
        /* fail open */
    }
}
function readAudit(root) {
    let text;
    try {
        text = (0, node_fs_1.readFileSync)((0, exports.auditPath)(root), "utf8");
    }
    catch {
        return [];
    }
    const out = [];
    for (const line of text.split("\n")) {
        if (!line)
            continue;
        try {
            out.push(JSON.parse(line));
        }
        catch {
            /* a damaged line must not hide the rest */
        }
    }
    return out;
}
const REC = "\x1e";
const FIELD = "\x1f";
const CLAUDE_TRAILER = /claude|anthropic/i;
const num = (s) => (s === "-" ? null : Number(s));
const NUMSTAT = /^(\d+|-)\t(\d+|-)\t(.+)$/;
/** Parse `git log --numstat` output produced with the format used in `gitCommits`. */
function parseGitLog(raw) {
    const commits = [];
    for (const rec of raw.split(REC)) {
        const [commit, ts, author, subject, ...tail] = rec.trim().split(FIELD);
        if (!commit || !ts)
            continue;
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
function gitCommits(root, since) {
    const raw = (0, node_child_process_1.execFileSync)("git", ["log", "--reverse", "--numstat", ...(since ? [`--since=${since}`] : []), `--format=${REC}%H${FIELD}%aI${FIELD}%an${FIELD}%s${FIELD}%(trailers:key=Co-Authored-By,valueonly,separator=%x2c)`], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    return parseGitLog(raw);
}
/**
 * Append every commit in git history that is not in the audit log yet. Safe to run repeatedly.
 * `since` is anything git's `--since` accepts, such as "2026-01-01" or "2 weeks ago".
 */
function syncFromGit(root, since) {
    let commits;
    try {
        commits = gitCommits(root, since);
    }
    catch (e) {
        const msg = e instanceof Error && "stderr" in e ? String(e.stderr).trim() : String(e);
        return { ok: false, error: `could not read git history${msg ? ` (${msg})` : ""}. Is this a git repository with at least one commit?` };
    }
    const known = new Set(readAudit(root).flatMap((e) => (e.source === "git" ? [e.commit] : [])));
    const fresh = commits.filter((c) => !known.has(c.commit));
    append(root, fresh);
    return { ok: true, added: fresh.length, alreadyLogged: commits.length - fresh.length };
}
/** One short line per entry, newest last, written to be cheap to read. */
function formatEntry(e) {
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
