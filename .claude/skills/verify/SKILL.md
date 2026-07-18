---
name: verify
description: Verify the YPmcn plugin through the bundled OpenClaw CLI.
---

# YPmcn runtime verification

1. Build the plugin with `npm --workspace YPmcn run build`.
2. Create an isolated `OPENCLAW_STATE_DIR` and `openclaw.json` that loads `YPmcn/` as plugin path and `YPmcn/skills/` as an extra skill directory.
3. Use `/Applications/YP Action.app/Contents/Resources/cfmind/openclaw.mjs` unless `OPENCLAW_CLI` is set.
4. Run `plugins inspect ypmcn-media-assistant --json`; require `loaded`, `imported=true`, five typed hooks, and no diagnostics.
5. Run `skills check --json`; require `media-assistant` in `eligible`.
6. Probe `plugins inspect ypmcn-missing --json`; require a nonzero exit and `Plugin not found`.

Keep the state directory temporary and delete it after capture. This flow is read-only and does not call the remote business MCP.
