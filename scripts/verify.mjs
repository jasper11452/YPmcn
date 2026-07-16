#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const pluginRoot = fileURLToPath(new URL("../YPmcn/", import.meta.url));
const vectorRoot = fileURLToPath(new URL("../vector-mcp/", import.meta.url));

function runStage({ name, command, args, cwd = repoRoot, env }) {
  process.stderr.write(`[verify] ${name}\n`);
  const result = spawnSync(command, args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${name} failed with exit code ${String(result.status)}`);
  }
}

export function verifyRepository() {
  const stages = [
    {
      name: "Spec governance",
      command: process.execPath,
      args: ["--test", "tests/spec_governance.test.mjs"],
    },
    {
      name: "human documentation sync",
      command: process.execPath,
      args: ["--test", "tests/human_docs.test.mjs"],
    },
    {
      name: "root workspace installation",
      command: process.execPath,
      args: ["--test", "tests/root_workspace_install.test.mjs"],
    },
    {
      name: "secret scanner tests",
      command: process.execPath,
      args: ["--test", "tests/secret_scan.test.mjs"],
    },
    {
      name: "tracked secret scan",
      command: process.execPath,
      args: ["scripts/scan-secrets.mjs", "--tracked"],
    },
    {
      name: "OpenClaw plugin contracts",
      command: "npm",
      args: ["test"],
      cwd: pluginRoot,
    },
    {
      name: "provider comparator",
      command: process.execPath,
      args: ["--test", "tests/provider_contract.test.mjs"],
    },
    {
      name: "Python hooks",
      command: "uv",
      args: ["run", "--no-project", "python", "-B", "tests/test_hooks.py"],
      env: { PYTHONDONTWRITEBYTECODE: "1" },
    },
    {
      name: "Skill and operator documentation",
      command: "uv",
      args: ["run", "--no-project", "python", "-B", "-m", "unittest", "-v", "tests/test_skill_package.py"],
      env: { PYTHONDONTWRITEBYTECODE: "1" },
    },
    {
      name: "vector MCP source build and reliability",
      command: "npm",
      args: ["test"],
      cwd: vectorRoot,
    },
    {
      name: "release metadata and package contents",
      command: process.execPath,
      args: ["--test", "tests/package_release.test.mjs"],
    },
  ];
  for (const stage of stages) runStage(stage);
  process.stderr.write("[verify] PASS\n");
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  try {
    verifyRepository();
  } catch (error) {
    process.stderr.write(`[verify] FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
