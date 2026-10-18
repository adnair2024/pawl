---
name: pawl
description: How to respond when pawl reports a weakened security control (removed auth check, loosened policy, wider CORS). Use whenever a message starts with "pawl:".
---

pawl keeps a baseline of the security protections the app already had and tells you when an edit weakens one.

When you see a pawl message:

1. Treat it as a real problem. Do not dismiss it because the code still runs.
2. Restore the protection using the "How to restore" line, unless the user's request clearly required removing it.
3. Never run `pawl accept` or `pawl init`, and never edit anything in `.pawl/` (pawl blocks this). Accepting lowers the baseline and only the user may decide that. If removal seems intended, ask the user and give them the exact `/pawl:accept <control-id> "<reason>"` line to run.
4. Explain to the user in plain words what was protected and why it matters (for example: "this page no longer checks that someone is logged in").
5. If pawl says a file has a syntax error, fix that first, since pawl cannot check what it cannot read.
