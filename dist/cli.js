#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// Thin launcher: load the real program inside a try so a missing dependency (for example
// the native parser before first-run setup finishes) fails open instead of crashing a hook.
try {
    require("./main");
}
catch (err) {
    const message = `pawl could not start, so no checks ran: ${String(err)}. If this is a fresh install, restart Claude Code so setup can finish.`;
    if (process.argv[2] === "hook") {
        process.stdout.write(JSON.stringify({ systemMessage: message }) + "\n");
        process.exit(0);
    }
    console.error(message);
    process.exit(1);
}
