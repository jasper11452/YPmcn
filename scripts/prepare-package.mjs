#!/usr/bin/env node

import { cpSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyRepository } from "./verify.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const pluginRoot = fileURLToPath(new URL("../YPmcn/", import.meta.url));
const vectorRoot = fileURLToPath(new URL("../vector-mcp/", import.meta.url));
const vectorDist = fileURLToPath(new URL("../vector-mcp/dist/", import.meta.url));
const stagedVectorRoot = fileURLToPath(new URL("../YPmcn/vector-mcp/", import.meta.url));
const stagedVectorDist = fileURLToPath(new URL("../YPmcn/vector-mcp/dist/", import.meta.url));

function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${String(result.status)}`);
  }
  return options.capture ? result.stdout : undefined;
}

export function stagePackageAssets() {
  rmSync(stagedVectorRoot, { recursive: true, force: true });
  run("npm", ["run", "build"], pluginRoot);
  run("npm", ["run", "build"], vectorRoot);
  mkdirSync(stagedVectorRoot, { recursive: true });
  cpSync(vectorDist, stagedVectorDist, { recursive: true });
}

export function preparePackage({ verify = true } = {}) {
  if (verify) verifyRepository();
  stagePackageAssets();
  const output = run(
    "npm",
    ["pack", "--pack-destination", repoRoot, "--json", "--ignore-scripts"],
    pluginRoot,
    { capture: true },
  );
  const packed = JSON.parse(output)[0];
  const archive = join(repoRoot, packed.filename);
  run(process.execPath, ["scripts/scan-secrets.mjs", archive], repoRoot);
  process.stdout.write(`${archive}\n`);
  return archive;
}

function parseArgs(args) {
  if (args.length === 0) return { stageOnly: false };
  if (args.length === 1 && args[0] === "--stage-only") return { stageOnly: true };
  throw new Error("Usage: node scripts/prepare-package.mjs [--stage-only]");
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  try {
    const { stageOnly } = parseArgs(process.argv.slice(2));
    if (stageOnly) stagePackageAssets();
    else preparePackage();
  } catch (error) {
    process.stderr.write(`[prepare-package] FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
