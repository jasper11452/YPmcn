#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { checkProviderUrl } from "./check-provider-contract.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const pluginRoot = fileURLToPath(new URL("../YPmcn/", import.meta.url));
const skillRoot = fileURLToPath(new URL("../YPmcn/skills/", import.meta.url));
const bundledCli = "/Applications/YP Action.app/Contents/Resources/cfmind/openclaw.mjs";
const cli = process.env.OPENCLAW_CLI || bundledCli;
const stateDir = mkdtempSync(join(tmpdir(), "ypmcn-openclaw-smoke-"));
const configPath = join(stateDir, "openclaw.json");
const packageJson = JSON.parse(readFileSync(new URL("../YPmcn/package.json", import.meta.url), "utf8"));
const sourceMcpConfig = JSON.parse(readFileSync(new URL("../YPmcn/mcp.json", import.meta.url), "utf8"));
const expectedOpenClawVersion = packageJson.devDependencies.openclaw;
const sourceMcp = sourceMcpConfig.mcpServers["ypmcn-mcp"];
const mcpUrl = process.env.YPMCN_MCP_URL || sourceMcp.url;

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${args.join(" ")} exited ${String(result.status)}\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

try {
  writeFileSync(configPath, `${JSON.stringify({
    gateway: { mode: "local" },
    plugins: {
      load: { paths: [pluginRoot] },
      entries: { "ypmcn-media-assistant": { enabled: true } },
    },
    skills: { load: { extraDirs: [skillRoot] } },
  }, null, 2)}\n`);

  const runtimeVersion = run(["--version"]);
  assert.match(runtimeVersion, new RegExp(`OpenClaw ${expectedOpenClawVersion.replaceAll(".", "\\.")}(?:\\s|$)`));

  run(["mcp", "set", "ypmcn-mcp", JSON.stringify({ ...sourceMcp, url: mcpUrl })]);
  const configuredMcp = JSON.parse(run(["mcp", "list", "--json"]));
  assert.equal(configuredMcp["ypmcn-mcp"]?.url, mcpUrl);
  assert.equal(configuredMcp["ypmcn-mcp"]?.transport, "sse");

  const providerReport = await checkProviderUrl(mcpUrl);
  assert.equal(providerReport.status, "PASS", JSON.stringify(providerReport));

  const inspected = JSON.parse(run(["plugins", "inspect", "ypmcn-media-assistant", "--json"]));
  assert.equal(inspected.plugin.id, "ypmcn-media-assistant");
  assert.equal(inspected.plugin.imported, true);
  assert.equal(inspected.plugin.status, "loaded");
  assert.deepEqual(inspected.diagnostics, []);
  assert.equal(inspected.plugin.hookCount, 4, `expected 4 native hooks: ${JSON.stringify(inspected.typedHooks)}`);
  const hookNames = inspected.typedHooks.map((hook) => hook.event ?? hook.name ?? hook.hookName).sort();
  assert.deepEqual(hookNames, ["after_tool_call", "before_prompt_build", "before_tool_call", "session_end"], JSON.stringify(inspected.typedHooks));

  const skills = JSON.parse(run(["skills", "check", "--json"]));
  const serialized = JSON.stringify(skills);
  assert.ok(skills.eligible?.includes("media-assistant"), `media-assistant skill was not eligible: ${serialized}`);
  process.stdout.write(`[smoke:openclaw] PASS plugin=loaded skill=media-assistant mcp=${mcpUrl} openclaw=${expectedOpenClawVersion} cli=${cli}\n`);
} catch (error) {
  process.stderr.write(`[smoke:openclaw] FAIL ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  rmSync(stateDir, { recursive: true, force: true });
}
