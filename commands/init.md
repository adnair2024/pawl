---
description: Snapshot this project's security controls into .pawl/baseline.json
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" init`

The output above is the result of the snapshot. Explain in one or two plain sentences what was recorded, and remind the user to commit `.pawl/`.
