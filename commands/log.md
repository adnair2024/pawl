---
description: Show the audit log of changes made to this project, or sync it from git history
argument-hint: [count | sync]
allowed-tools: Bash(node:*)
---

Run `node --liftoff-only "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" log $ARGUMENTS` and show the user the result.

With no argument it prints the 20 most recent entries; a number prints that many. `sync` adds any git commits that are not in the log yet; `sync --since "2 weeks ago"` (or `--since 2026-01-01`) limits it to recent history. Use the log to see what changed recently instead of re-reading files.
