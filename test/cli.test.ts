import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const CLI = join(ROOT, "dist", "cli.js");
const DEMO = join(__dirname, "fixtures", "demo-app");
const dirs: string[] = [];
beforeAll(() => { execFileSync(process.execPath, [join(ROOT, "node_modules/typescript/bin/tsc")], { cwd: ROOT }); }, 60_000);
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function project(): string {
  const d = mkdtempSync(join(tmpdir(), "pawl-"));
  dirs.push(d);
  cpSync(DEMO, d, { recursive: true });
  mkdirSync(join(d, ".git"));
  return d;
}
const run = (cwd: string, args: string[], stdin = "") =>
  spawnSync(process.execPath, [CLI, ...args], { cwd, input: stdin, encoding: "utf8" });
const hookIn = (cwd: string, tool_input: object, extra: object = {}) => JSON.stringify({ cwd, tool_input, ...extra });
const stripGuard = (d: string) =>
  writeFileSync(join(d, "app/api/posts/route.ts"), 'export async function POST() { return Response.json({ ok: true }); }\n');

describe("cli", () => {
  it("init records the demo controls", () => {
    const d = project();
    expect(run(d, ["init"]).stdout).toContain("3 controls");
  });

  it("post-tool warns (exit 0) with context when a guard is removed", () => {
    const d = project();
    run(d, ["init"]);
    stripGuard(d);
    const r = run(d, ["hook", "post-tool"], hookIn(d, { file_path: join(d, "app/api/posts/route.ts") }));
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.additionalContext).toContain("app/api/posts/route.ts#POST");
    expect(out.hookSpecificOutput.additionalContext).toContain("How to restore");
  });

  it("stop feeds the regression back once, then lets go if stop_hook_active", () => {
    const d = project();
    run(d, ["init"]);
    stripGuard(d);
    expect(run(d, ["hook", "stop"], hookIn(d, {})).status).toBe(2);
    expect(run(d, ["hook", "stop"], hookIn(d, {}, { stop_hook_active: true })).status).toBe(0);
  });

  it("pre-commit blocks a git commit with exit 2 and ignores other commands", () => {
    const d = project();
    run(d, ["init"]);
    stripGuard(d);
    const commit = run(d, ["hook", "pre-commit"], hookIn(d, { command: 'git commit -m "x"' }));
    expect(commit.status).toBe(2);
    expect(commit.stderr).toContain("app/api/posts/route.ts#POST");
    expect(run(d, ["hook", "pre-commit"], hookIn(d, { command: "ls" })).status).toBe(0);
  });

  it("accept lowers the baseline, logs the reason, and unblocks the commit", () => {
    const d = project();
    run(d, ["init"]);
    stripGuard(d);
    expect(run(d, ["accept", "app/api/posts/route.ts#POST"]).status).toBe(1); // reason required
    expect(run(d, ["accept", "app/api/posts/route.ts#POST", "public", "endpoint"]).status).toBe(0);
    expect(run(d, ["hook", "pre-commit"], hookIn(d, { command: "git commit -m x" })).status).toBe(0);
    expect(run(d, ["status"]).stdout).toContain("public endpoint");
  });

  it("fails open with a visible warning when the baseline is missing or corrupt", () => {
    const d = project();
    const missing = run(d, ["hook", "stop"], hookIn(d, {}));
    expect(missing.status).toBe(0);
    expect(JSON.parse(missing.stdout).systemMessage).toContain("missing");
    mkdirSync(join(d, ".pawl"));
    writeFileSync(join(d, ".pawl/baseline.json"), "{nope");
    const corrupt = run(d, ["hook", "pre-commit"], hookIn(d, { command: "git commit -m x" }));
    expect(corrupt.status).toBe(0);
    expect(JSON.parse(corrupt.stdout).systemMessage).toContain("corrupt");
  });

  it("blocks a commit when a tracked file has a syntax error", () => {
    const d = project();
    run(d, ["init"]);
    writeFileSync(join(d, "app/api/posts/route.ts"), "export async function POST( {");
    const r = run(d, ["hook", "pre-commit"], hookIn(d, { command: "git commit -m x" }));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("syntax error");
  });

  describe("guard", () => {
    const guard = (d: string, tool_name: string, tool_input: object) =>
      run(d, ["hook", "guard"], JSON.stringify({ cwd: d, tool_name, tool_input }));

    it("blocks Claude from accepting, re-initialising, or editing .pawl/", () => {
      const d = project();
      run(d, ["init"]);
      for (const command of [
        'node /x/dist/cli.js accept app/a#GET "fine"',
        "node dist/cli.js init",
        "echo '{}' > .pawl/baseline.json",
        "rm -rf .pawl",
        "sed -i s/a/b/ .pawl/ledger.jsonl",
      ]) {
        const r = guard(d, "Bash", { command });
        expect(r.status, command).toBe(2);
        expect(r.stderr).toContain("/pawl:accept");
      }
      expect(guard(d, "Write", { file_path: join(d, ".pawl/baseline.json") }).status).toBe(2);
      expect(guard(d, "Edit", { file_path: ".pawl/ledger.jsonl" }).status).toBe(2);
    });

    it("lets normal work and read-only looks at .pawl/ through", () => {
      const d = project();
      for (const command of ["npm test", "cat .pawl/baseline.json", "git add .pawl", "git diff .pawl/"]) {
        expect(guard(d, "Bash", { command }).status, command).toBe(0);
      }
      expect(guard(d, "Edit", { file_path: join(d, "app/api/posts/route.ts") }).status).toBe(0);
    });
  });

  it("blocks a commit when the baseline was hand-lowered, but not after /pawl:accept", () => {
    const d = project();
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: d });
    rmSync(join(d, ".git"), { recursive: true });
    git("init", "-q");
    run(d, ["init"]);
    git("add", "-A");
    git("commit", "-qm", "base");

    const path = join(d, ".pawl/baseline.json");
    const b = JSON.parse(readFileSync(path, "utf8"));
    b.controls = b.controls.filter((c: { id: string }) => c.id !== "app/api/posts/route.ts#POST");
    writeFileSync(path, JSON.stringify(b));
    const blocked = run(d, ["hook", "pre-commit"], hookIn(d, { command: "git commit -m x" }));
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toContain("app/api/posts/route.ts#POST");

    git("checkout", ".pawl");
    stripGuard(d);
    run(d, ["accept", "app/api/posts/route.ts#POST", "public"]);
    expect(run(d, ["hook", "pre-commit"], hookIn(d, { command: "git commit -m x" })).status).toBe(0);
  });

  describe("prompt hook", () => {
    const prompt = (d: string, text: string) => run(d, ["hook", "prompt"], JSON.stringify({ cwd: d, prompt: text }));

    it("accepts with a reason full of quotes, $ and backticks, untouched", () => {
      const d = project();
      run(d, ["init"]);
      stripGuard(d);
      const reason = `it's "public" on purpose: $HOME \`x\` $(whoami)`;
      const r = prompt(d, `/pawl:accept app/api/posts/route.ts#POST ${reason}`);
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain("accepted app/api/posts/route.ts#POST");
      expect(readFileSync(join(d, ".pawl/ledger.jsonl"), "utf8")).toContain(JSON.stringify(reason).slice(1, -1));
    });

    it("explains usage when the id or reason is missing, and ignores other prompts", () => {
      const d = project();
      run(d, ["init"]);
      expect(JSON.parse(prompt(d, "/pawl:accept").stdout).systemMessage).toContain("Usage");
      expect(JSON.parse(prompt(d, "/pawl:accept app/api/posts/route.ts#POST").stdout).systemMessage).toContain("Usage");
      expect(prompt(d, "please add a login page").stdout).toBe("");
    });
  });

  it("init says which frameworks are covered and warns about ones that are not", () => {
    const d = project();
    writeFileSync(join(d, "package.json"), JSON.stringify({ dependencies: { next: "15", fastify: "5" } }));
    writeFileSync(join(d, "requirements.txt"), "flask==3.0\nrequests\n");
    const out = run(d, ["init"]).stdout;
    expect(out).toContain("Routes by framework: next-route 3");
    expect(out).toContain("Not covered yet: Fastify, Flask");
    writeFileSync(join(d, "package.json"), JSON.stringify({ dependencies: { express: "5" } }));
    rmSync(join(d, "app"), { recursive: true });
    expect(run(d, ["init"]).stdout).toContain("Express detected but no controls were found");
  });
});
