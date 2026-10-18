import { readFileSync } from "node:fs";
import { readBaseline, writeBaseline } from "./baseline";
import { accept, check, findRoot, init, ratchet, toRelative } from "./check";
import { guardReason, unexplainedBaselineChanges } from "./guard";
import { isTracked } from "./inventory";
import { detectFrameworks } from "./frameworks";
import { readLedger } from "./ledger";
import { formatRegressions } from "./report";

interface HookInput {
  cwd?: string;
  prompt?: string;
  stop_hook_active?: boolean;
  tool_name?: string;
  tool_input?: { file_path?: string; command?: string };
}

function readHookInput(): HookInput {
  try {
    return JSON.parse(readFileSync(0, "utf8")) as HookInput;
  } catch {
    return {};
  }
}

/** A warning the user sees, without blocking anything. */
const warn = (message: string): void => {
  process.stdout.write(JSON.stringify({ systemMessage: `pawl: ${message}` }) + "\n");
};

const COMMIT = /\bgit\b[^|;&\n]*\bcommit\b/;

const ACCEPT_PROMPT = /^\s*\/pawl:accept(?:\s+(\S+))?(?:\s+([\s\S]*?))?\s*$/;

/**
 * `/pawl:accept` is handled here, on the raw text the user typed, so quotes, `$` and
 * backticks in the reason never pass through a shell. Only a real user prompt reaches this
 * hook, which is what makes accepting a human-only action.
 */
async function acceptPrompt(root: string, prompt: string): Promise<number> {
  const m = ACCEPT_PROMPT.exec(prompt);
  if (!m) return 0;
  const [, id, reason] = m;
  const r = id && reason ? await accept(root, id, reason) : null;
  const message = r
    ? r.ok
      ? `accepted ${r.controlId}. The baseline was lowered and the reason was logged.`
      : `nothing accepted. ${r.error}`
    : 'nothing accepted. Usage: /pawl:accept <control-id> <reason>';
  process.stdout.write(
    JSON.stringify({
      systemMessage: `pawl: ${message}`,
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: `pawl accept result: ${message}` },
    }) + "\n",
  );
  return 0;
}

async function hook(kind: string): Promise<number> {
  const input = readHookInput();
  const root = findRoot(input.cwd ?? process.cwd());
  if (kind === "prompt") return acceptPrompt(root, input.prompt ?? "");
  const file = input.tool_input?.file_path ? toRelative(root, input.tool_input.file_path) : undefined;

  if (kind === "guard") {
    const reason = guardReason(input.tool_name, input.tool_input ?? {});
    if (reason) process.stderr.write(reason + "\n");
    return reason ? 2 : 0;
  }
  if (kind === "post-tool" && (!file || file.startsWith("..") || !isTracked(file))) return 0;
  if (kind === "pre-commit" && !COMMIT.test(input.tool_input?.command ?? "")) return 0;
  if (kind === "stop" && input.stop_hook_active) return 0;

  const loaded = readBaseline(root);
  if (!loaded.ok) {
    warn(`not checking this project (${loaded.reason}). ${loaded.detail}`);
    return 0;
  }

  const result = await check(root, loaded.baseline, kind === "post-tool" && file ? [file] : undefined);
  const regressions = kind === "post-tool" ? result.regressions.filter((r) => !r.summary.includes("syntax error")) : result.regressions;

  if (kind === "pre-commit") {
    const lowered = unexplainedBaselineChanges(root);
    if (lowered.length) {
      process.stderr.write(
        `pawl: commit blocked. The security baseline (.pawl/baseline.json) was lowered for ${lowered.join(", ")} without an accepted reason.\n` +
          'Restore .pawl/ with `git checkout .pawl`, or ask the user to run /pawl:accept <control-id> "<reason>".\n',
      );
      return 2;
    }
  }

  if (regressions.length === 0) {
    if (kind === "stop") writeBaseline(root, ratchet(loaded.baseline, result.current.controls, new Set()));
    return 0;
  }

  if (kind === "post-tool") {
    const additionalContext = formatRegressions(regressions, "this edit weakened a security protection.");
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext } }) + "\n");
    return 0;
  }
  const intro = kind === "stop" ? "security protections are weaker than the baseline." : "commit blocked, a security protection was weakened.";
  process.stderr.write(formatRegressions(regressions, intro) + "\n");
  return 2;
}

async function status(root: string): Promise<void> {
  const loaded = readBaseline(root);
  if (!loaded.ok) {
    console.log(`pawl: ${loaded.detail}`);
    return;
  }
  const { baseline } = loaded;
  const counts = new Map<string, number>();
  for (const c of baseline.controls) counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
  console.log(`Tracked controls: ${baseline.controls.length}`);
  for (const [k, n] of counts) console.log(`  ${k}: ${n}`);
  const headerNames = baseline.controls.flatMap((c) => (c.kind === "header" ? [c.header] : []));
  if (headerNames.length) console.log(`Security headers: ${headerNames.join(", ")}`);
  const openCors = baseline.controls.filter((c) => c.kind === "cors" && (c.origin === "wildcard" || c.origin === "reflect"));
  if (openCors.length) console.log(`CORS open to any website: ${openCors.map((c) => c.file).join(", ")}`);
  const rlsOff = baseline.controls.filter((c) => c.kind === "rls-table" && !c.rlsEnabled);
  if (rlsOff.length) console.log(`Tables with row-level security off: ${rlsOff.map((c) => c.id).join(", ")}`);
  const unprotected = baseline.controls.filter((c) => c.kind === "route-auth" && c.guards.length === 0);
  if (unprotected.length) console.log(`Routes with no auth check: ${unprotected.map((c) => c.id).join(", ")}`);
  const { regressions, unparsed } = await check(root, baseline);
  console.log(regressions.length ? `\nPending regressions (${regressions.length}):` : "\nNo pending regressions.");
  console.log(regressions.map((r) => `- ${r.controlId}: ${r.summary}`).join("\n"));
  if (unparsed.length) console.log(`\nCould not parse: ${unparsed.map((u) => u.file).join(", ")}`);
  const ledger = readLedger(root, 5);
  if (ledger.length) console.log("\nRecent accepted changes:\n" + ledger.map((l) => `- ${l.timestamp} ${l.controlId}: ${l.reason}`).join("\n"));
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const root = findRoot(process.cwd());
  switch (cmd) {
    case "hook":
      return hook(rest[0] ?? "");
    case "init": {
      const b = await init(root);
      console.log(`pawl: baseline written to .pawl/baseline.json with ${b.controls.length} controls.`);
      const found = detectFrameworks(root);
      const perFramework = new Map<string, number>();
      for (const c of b.controls) if (c.kind === "route-auth") perFramework.set(c.framework, (perFramework.get(c.framework) ?? 0) + 1);
      if (perFramework.size) console.log(`Routes by framework: ${[...perFramework].map(([f, n]) => `${f} ${n}`).join(", ")}`);
      if (found.supported.length && b.controls.length === 0) {
        console.log(`Warning: ${found.supported.join(", ")} detected but no controls were found. Check that routes live where pawl looks (Next.js: app/**/route.ts; Express, FastAPI, Flask and Django: files that import the framework).`);
      }
      if (found.unsupported.length) {
        console.log(`Not covered yet: ${found.unsupported.join(", ")}. pawl cannot see or protect routes written with these.`);
      }
      const open = b.controls.filter((c) => c.kind === "rls-table" && !c.rlsEnabled).map((c) => c.id);
      if (open.length) {
        console.log(`Warning: row-level security (per-user data access rules) is OFF for ${open.length} table(s): ${open.join(", ")}. Anyone with your public API key can read and change every row in them. pawl records this as the starting point and will not block it, but you probably want to turn it on.`);
      }
      const openCors = b.controls.filter((c) => c.kind === "cors" && (c.origin === "wildcard" || c.origin === "reflect"));
      if (openCors.length) {
        console.log(`Warning: CORS (which websites may call your API) lets ANY website through in: ${openCors.map((c) => `${c.file} (${c.kind === "cors" ? c.origin : ""})`).join(", ")}. pawl records this as the starting point and will not block it, but if the API uses cookies or logins you probably want an explicit list of origins.`);
      }
      const headerNames = b.controls.flatMap((c) => (c.kind === "header" ? [c.header] : []));
      if (headerNames.length) console.log(`Security headers found: ${headerNames.join(", ")}`);
      for (const p of b.partial ?? []) console.log(`Not fully analyzed: ${p.file} (${p.reason}). pawl cannot confirm what it does to row-level security.`);
      if (b.unparsed.length) console.log(`Could not parse (not treated as safe): ${b.unparsed.map((u) => u.file).join(", ")}`);
      return 0;
    }
    case "status":
      await status(root);
      return 0;
    case "accept": {
      const [id, ...reason] = rest;
      if (!id) {
        console.error('usage: pawl accept <control-id> "<reason>"');
        return 1;
      }
      const r = await accept(root, id, reason.join(" "));
      console.log(r.ok ? `pawl: accepted ${r.controlId}; baseline updated and logged.` : `pawl: ${r.error}`);
      return r.ok ? 0 : 1;
    }
    default:
      console.error("usage: pawl <init|status|accept|hook>");
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    // Fail open: a bug in pawl must never stop the user's session.
    if (process.argv[2] === "hook") {
      warn(`internal error, skipping this check: ${String(err)}`);
      process.exit(0);
    }
    console.error(`pawl: ${String(err)}`);
    process.exit(1);
  },
);
