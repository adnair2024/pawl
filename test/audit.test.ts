import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { parseGitLog } from "../src/audit";

const ROOT = join(__dirname, "..");
const CLI = join(ROOT, "dist", "cli.js");
const dirs: string[] = [];
beforeAll(() => { execFileSync(process.execPath, [join(ROOT, "node_modules/typescript/bin/tsc")], { cwd: ROOT }); }, 60_000);
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const run = (cwd: string, args: string[], stdin = "") =>
  spawnSync(process.execPath, ["--liftoff-only", CLI, ...args], { cwd, input: stdin, encoding: "utf8" });
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
const auditLines = (d: string) =>
  readFileSync(join(d, ".pawl", "audit.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "pawl-audit-"));
  dirs.push(d);
  git(d, "init", "-q");
  return d;
}

describe("audit log", () => {
  it("post-tool logs every edit, even to files pawl does not track", () => {
    const d = repo();
    const input = JSON.stringify({
      cwd: d,
      session_id: "s1",
      tool_name: "Edit",
      tool_input: { file_path: join(d, "notes.md"), old_string: "a", new_string: "a\nb\nc" },
    });
    expect(run(d, ["hook", "post-tool"], input).status).toBe(0);
    const [e] = auditLines(d);
    expect(e).toMatchObject({ source: "hook", tool: "Edit", file: "notes.md", added: 3, removed: 1, session: "s1" });
  });

  it("counts a whole-file write as no removed lines and ignores edits outside the project or to the log itself", () => {
    const d = repo();
    const post = (file_path: string, extra: object) =>
      run(d, ["hook", "post-tool"], JSON.stringify({ cwd: d, tool_name: "Write", tool_input: { file_path, ...extra } }));
    post(join(d, "a.ts"), { content: "x\ny" });
    post("/elsewhere/b.ts", { content: "x" });
    post(join(d, ".pawl", "audit.jsonl"), { content: "x" });
    const lines = auditLines(d);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ file: "a.ts", added: 2, removed: null });
  });

  it("sync records commits once, flags Claude co-authored ones, and is safe to repeat", () => {
    const d = repo();
    writeFileSync(join(d, "a.txt"), "1\n2\n");
    git(d, "add", "."); git(d, "commit", "-q", "-m", "first");
    writeFileSync(join(d, "a.txt"), "1\n");
    writeFileSync(join(d, "b.txt"), "x\n");
    git(d, "add", "."); git(d, "commit", "-q", "-m", "second", "-m", "Co-Authored-By: Claude <noreply@anthropic.com>");

    const first = run(d, ["log", "sync"]);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("logged 2 new commit(s)");
    const [one, two] = auditLines(d);
    expect(one).toMatchObject({ source: "git", subject: "first", claude: false, files: [{ path: "a.txt", added: 2, removed: 0 }] });
    expect(two).toMatchObject({ subject: "second", claude: true });
    expect(two.files.map((f: { path: string }) => f.path).sort()).toEqual(["a.txt", "b.txt"]);

    writeFileSync(join(d, "c.txt"), "z\n");
    git(d, "add", "."); git(d, "commit", "-q", "-m", "third");
    const again = run(d, ["log", "sync"]);
    expect(again.stdout).toContain("logged 1 new commit(s) from git (2 already");
    expect(auditLines(d)).toHaveLength(3);
  });

  it("sync --since skips older commits and rejects bad usage", () => {
    const d = repo();
    const commit = (name: string, date: string) => {
      writeFileSync(join(d, name), "x\n");
      git(d, "add", ".");
      execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", name], {
        cwd: d,
        env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      });
    };
    commit("old", "2020-01-01T00:00:00Z");
    commit("new", "2026-06-01T00:00:00Z");

    const r = run(d, ["log", "sync", "--since", "2026-01-01"]);
    expect(r.stdout).toContain("logged 1 new commit(s)");
    expect(auditLines(d).map((e) => e.subject)).toEqual(["new"]);

    expect(run(d, ["log", "sync", "--since"]).status).toBe(1);
    expect(run(d, ["log", "sync", "junk"]).status).toBe(1);
  });

  it("sync fails with a clear message outside a git repo, and log prints compact lines", () => {
    const d = mkdtempSync(join(tmpdir(), "pawl-audit-"));
    dirs.push(d);
    const r = run(d, ["log", "sync"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("could not read git history");

    expect(run(d, ["log"]).stdout).toContain("audit log is empty");
    mkdirSync(join(d, ".pawl"));
    writeFileSync(join(d, ".pawl", "audit.jsonl"), 'not json\n{"ts":"2026-01-02T03:04:05Z","source":"hook","tool":"Edit","file":"x.ts","added":1,"removed":2}\n');
    expect(run(d, ["log"]).stdout.trim()).toBe("2026-01-02 03:04 Edit x.ts +1 -2");
  });

  it("parseGitLog reads numstat with binary files and multi-line trailers", () => {
    const raw = "\x1eabc\x1f2026-01-01T00:00:00Z\x1fAnn\x1fsubj\x1fClaude <a@b>\nOther <c@d>\n\n1\t2\tf.ts\n-\t-\timg.png\n";
    const [c] = parseGitLog(raw);
    expect(c).toMatchObject({ commit: "abc", claude: true, files: [{ path: "f.ts", added: 1, removed: 2 }, { path: "img.png", added: null, removed: null }] });
  });
});
