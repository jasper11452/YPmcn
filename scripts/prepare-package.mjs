#!/usr/bin/env node

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const npm = "npm";

import { verifyRepository } from "./verify.mjs";
import { mcpConfig } from "./set-mcp-profile.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const pluginRoot = fileURLToPath(new URL("../YPmcn/", import.meta.url));
const specRoot = fileURLToPath(new URL("../spec/", import.meta.url));
const stagingBase = fileURLToPath(new URL("../packages/.staging/", import.meta.url));
const stagingRoot = join(stagingBase, "ypmcn-media-assistant");
const releaseRoot = fileURLToPath(new URL("../packages/releases/", import.meta.url));
const pluginAssets = [
  ".codex-plugin",
  ".claude-plugin",
  ".npmignore",
  "README.md",
  "dist",
  ".mcp.json",
  "mcp.json",
  "openclaw.plugin.json",
  "package.json",
  "skills",
  "state",
];

function assertOfflineInstallablePackage(packageRoot) {
  const manifestPath = join(packageRoot, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const runtimeDependencies = Object.keys(manifest.dependencies ?? {});
  if (runtimeDependencies.length > 0) {
    throw new Error(
      `release package must not require npm install; bundle or remove dependencies: ${runtimeDependencies.join(", ")}`,
    );
  }
}

function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
    env: process.env,
    shell: process.platform === "win32" && command === npm,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${String(result.status)}`);
  }
  return options.capture ? result.stdout : undefined;
}

export function stagePackageAssets() {
  rmSync(stagingBase, { recursive: true, force: true });
  rmSync(join(pluginRoot, "spec"), { recursive: true, force: true });
  rmSync(join(pluginRoot, "vector-mcp"), { recursive: true, force: true });
  run(npm, ["run", "build"], pluginRoot);
  mkdirSync(stagingRoot, { recursive: true });
  for (const asset of pluginAssets) {
    cpSync(join(pluginRoot, asset), join(stagingRoot, asset), { recursive: true });
  }
  const packagedMcpConfig = `${JSON.stringify(mcpConfig("development"), null, 2)}\n`;
  writeFileSync(join(stagingRoot, ".mcp.json"), packagedMcpConfig);
  writeFileSync(join(stagingRoot, "mcp.json"), packagedMcpConfig);
  cpSync(specRoot, join(stagingRoot, "spec"), { recursive: true });
  assertOfflineInstallablePackage(stagingRoot);
  return stagingRoot;
}

export function packPackageArchive(packageRoot, destination) {
  mkdirSync(destination, { recursive: true });
  const output = run(
    "npm",
    ["pack", "--pack-destination", destination, "--json", "--ignore-scripts"],
    packageRoot,
    { capture: true },
  );
  const packed = JSON.parse(output)[0];
  if (!packed?.filename) {
    throw new Error("npm pack did not report an archive filename");
  }
  return {
    archive: join(destination, packed.filename),
    files: (packed.files ?? []).map(({ path }) => path),
  };
}

export function preparePackage({ verify = true } = {}) {
  if (verify) verifyRepository();
  stagePackageAssets();
  try {
    const { archive } = packPackageArchive(stagingRoot, releaseRoot);
    run(process.execPath, ["scripts/scan-secrets.mjs", archive], repoRoot);
    process.stdout.write(`${archive}\n`);
    return archive;
  } finally {
    rmSync(stagingBase, { recursive: true, force: true });
  }
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
    if (stageOnly) process.stdout.write(`${stagePackageAssets()}\n`);
    else preparePackage();
  } catch (error) {
    process.stderr.write(`[prepare-package] FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
