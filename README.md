# pawl

> A pawl is the part of a ratchet that stops it from slipping backward.

**pawl stops Claude Code from quietly weakening your app's security.**

When you build by prompting, the "fix it" loop tends to delete protections without anyone noticing: a route loses its login check during a refactor, a database migration turns row-level security off, CORS becomes `*`. pawl takes a snapshot of the protections your app already has, then warns Claude the moment an edit removes or loosens one, and **blocks the commit** unless you explicitly accept the change with a reason.

It is deterministic and runs entirely on your machine: no LLM calls, no telemetry, no network calls while it checks your code.

## Install

In Claude Code:

```
/plugin install pawl --marketplace adnair2024/pawl
```

(or `/plugin marketplace add adnair2024/pawl`, then `/plugin install pawl@pawl`).

**Requirements:** Node.js 20 or newer and git. On Windows, Claude Code runs hooks through Git Bash.
The first session after installing runs a one-time `npm install` inside the plugin folder (needs internet once); until it finishes, pawl tells you it could not start and skips its checks.

## Use it

1. In your project, run **`/pawl:init`**. pawl records what is protected today in `.pawl/baseline.json` and tells you what it found, including anything already risky (tables with row-level security off, CORS open to every website).
2. **Commit the `.pawl/` folder** so the baseline travels with your code.
3. Carry on building. From now on:
   - **After every edit** pawl re-checks the touched files and tells Claude if a protection got weaker.
   - **When Claude finishes** a turn, pawl checks the whole project and sends anything weaker back to Claude to fix.
   - **Before `git commit`** pawl blocks the commit if a protection is weaker than the baseline.
4. If you *want* a change that lowers protection, run **`/pawl:accept <control-id> <reason>`**. The reason is written to `.pawl/ledger.jsonl`, which is committed, so it shows up in code review.
5. **`/pawl:status`** shows what is tracked, what is currently weaker, and recently accepted changes.

Only you can accept: Claude is blocked from running `accept`, from re-running `init`, and from editing anything inside `.pawl/`.

## What it protects

| Area | What pawl notices |
|---|---|
| **Route and page auth** | A route or server action that stopped checking who is calling. Learns your own helper functions, not just a fixed list of names. |
| **Next.js middleware** | The middleware's auth check was removed, deleted, or its `matcher` was narrowed so some routes skip it. |
| **Supabase** (`supabase/migrations`) | Row-level security switched off, a policy dropped, a policy loosened to `true`, a new table with RLS off. |
| **CORS** | An allowed-origins list becoming `*`, or echoing back whichever website asks; a new file that does either. |
| **Security headers** | CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy and the Cross-Origin-* headers disappearing from the whole project. Library defaults count (`helmet()`, Talisman, Django's middleware). |

Frameworks: **Next.js (App Router), Express, FastAPI, Flask, Django**, plus Supabase.
Languages: TypeScript, JavaScript, Python, SQL.

Moving a protection somewhere else, renaming a variable, or reformatting a check is **not** flagged. Removing it, or making it weaker, is.

## What it does not do

pawl is a ratchet, not a scanner. It only guards controls that already exist; it does not find vulnerabilities in new code, and it does not replace a security review.

- It recognises protections by structure and by what your helper functions do. A custom check with an unusual shape, or a guard defined in a library pawl cannot read, may be missed.
- Not covered yet: other frameworks (Fastify, Koa, Hono, NestJS, Rails, Go, ...), the Next.js Pages Router, owner/tenant filters in database queries (the general "IDOR" problem), and the *values* of headers (removal is caught; weakening a CSP is not).
- Routes registered dynamically (in loops, by string) are not seen.
- A file pawl cannot parse is reported as "not checked" and **never treated as safe**. If a tracked file has a syntax error at commit time, the commit is blocked.
- The guard against Claude changing the baseline stops mistakes and well-meaning shortcuts. It is not tamper-proof against a determined workaround; review `.pawl/` changes in your commits like any other code.

## When something looks wrong

- **"pawl could not start"**: restart Claude Code so the first-run setup can finish (needs internet once).
- **"no baseline"**: run `/pawl:init` in the project root.
- **Blocked commit you did not expect**: read the message. It names the file, what changed, how to restore it, and the exact `/pawl:accept` line if the change was intended.
- **pawl itself crashes**: it fails open. You see a warning and your session continues; it never blocks your work because of its own bug.

## For contributors

```
npm install
npm test         # builds dist/ and runs the suite
npm run typecheck
claude plugin validate .
```

`dist/` is committed so the plugin installs straight from git. Run `npm run build` (or `npm test`) before committing source changes; CI fails if `dist/` is stale.

Design rules every change must keep:

- **Fail open on our own errors.** If pawl crashes, cannot parse something, or the baseline is missing, it prints a visible warning and exits 0. A broken security tool must never brick a session. An empty, corrupt or newer-version baseline is shown as an error, never as a pass.
- **Fail closed on a real regression at commit time** (exit 2, with a message Claude and a non-developer can act on).
- **Fast.** The post-edit hook must stay well under 300 ms on a typical project; only the stop and commit hooks may do a full scan. Readers load lazily and parse results are cached.
- **Structural, not regex.** Source is parsed (ast-grep for JS/TS/Python, the real Postgres parser for SQL). Anything unparseable is reported as unparsed, never as safe.
- **Never modify user code.** pawl reports; Claude or the user fixes.
- **Every regression type has a before/after fixture with the exact message asserted, and a no-false-positive fixture** (a refactor that keeps the protection must pass).
