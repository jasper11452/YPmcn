import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";

import { packPackageArchive } from "../scripts/prepare-package.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const pluginRoot = fileURLToPath(new URL("../YPmcn/", import.meta.url));
const stagingBase = fileURLToPath(new URL("../packages/.staging/", import.meta.url));
const stagedPluginRoot = fileURLToPath(
  new URL("../packages/.staging/ypmcn-media-assistant/", import.meta.url),
);
const VERSION = "3.4.7";
let archiveTempRoot;

function json(relativePath) {
  return JSON.parse(readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8"));
}

function stageIfImplemented() {
  const script = fileURLToPath(new URL("../scripts/prepare-package.mjs", import.meta.url));
  if (!existsSync(script)) return;
  const result = spawnSync(process.execPath, [script, "--stage-only"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

function dryRunFiles() {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: stagedPluginRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout)[0].files.map(({ path }) => path);
}

function readArchiveFile(archive, relativePath) {
  const result = spawnSync("tar", ["-xOf", archive, `package/${relativePath}`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

before(stageIfImplemented);
after(() => {
  rmSync(stagingBase, { recursive: true, force: true });
  if (archiveTempRoot) rmSync(archiveTempRoot, { recursive: true, force: true });
});

describe("3.4.7 release metadata", () => {
  it("uses one version across root, plugin, lockfiles, and manifests", () => {
    const rootPackage = json("package.json");
    const rootLock = json("package-lock.json");
    const pluginPackage = json("YPmcn/package.json");
    const pluginLock = json("YPmcn/package-lock.json");
    const openclawManifest = json("YPmcn/openclaw.plugin.json");
    const claudeManifest = json("YPmcn/.claude-plugin/plugin.json");
    const codexManifest = json("YPmcn/.codex-plugin/plugin.json");
    assert.deepEqual([
      rootPackage.version,
      rootLock.version,
      rootLock.packages[""].version,
      pluginPackage.version,
      pluginLock.version,
      pluginLock.packages[""].version,
      openclawManifest.version,
      claudeManifest.version,
      codexManifest.version,
    ], Array(9).fill(VERSION));
  });

  it("uses nested OpenClaw metadata and the v2 spec contract", () => {
    const pluginPackage = json("YPmcn/package.json");
    const manifest = json("YPmcn/openclaw.plugin.json");
    const bundleManifest = json("YPmcn/.codex-plugin/plugin.json");
    assert.deepEqual(pluginPackage.openclaw, {
      extensions: ["./dist/index.js"],
    });
    assert.equal(manifest.hooks, undefined);
    assert.equal(pluginPackage["openclaw.extensions"], undefined);
    assert.equal(manifest.contracts.profile, "mvp-v2");
    assert.equal(manifest.contracts.spec, "./spec/mcp.json");
    assert.equal(bundleManifest.name, "ypmcn-media-assistant");
    assert.equal(bundleManifest.skills, "./skills/");
    assert.equal(bundleManifest.mcpServers, "./.mcp.json");
  });

  it("packages the current development MCP profile for end-to-end testing", () => {
    const active = {
      mcpServers: {
        "ypmcn-mcp": {
          url: json("spec/mcp.json").providerContractBasis.endpoint,
          transport: "sse",
          connectionTimeoutMs: 30000,
        },
      },
    };
    assert.deepEqual(json("YPmcn/.mcp.json"), active);
    assert.deepEqual(json("YPmcn/mcp.json"), active);
    assert.deepEqual(json("packages/.staging/ypmcn-media-assistant/.mcp.json"), active);
    assert.deepEqual(json("packages/.staging/ypmcn-media-assistant/mcp.json"), active);
    assert.equal(active.mcpServers["ypmcn-mcp"].url, "https://mcp.eshypdata.com/sse");
    assert.equal("command" in active.mcpServers["ypmcn-mcp"], false);
  });

  it("keeps dependencies owned and exactly pinned", () => {
    const rootPackage = json("package.json");
    const pluginPackage = json("YPmcn/package.json");
    assert.equal(rootPackage.dependencies, undefined);
    assert.equal(pluginPackage.dependencies, undefined);
    assert.equal(pluginPackage.devDependencies.typescript, "5.9.3");
    assert.equal(pluginPackage.devDependencies.openclaw, "2026.4.14");
  });
});

describe("reproducible plugin package", () => {
  it("contains current specs, plugin dist, skills, and only the remote business MCP config", () => {
    const files = dryRunFiles();
    for (const required of (
      [
        ".codex-plugin/plugin.json",
        ".claude-plugin/plugin.json",
        ".mcp.json",
        "mcp.json",
        "dist/index.js",
        "openclaw.plugin.json",
        "spec/mcp.json",
        "spec/workflow.json",
        "skills/media-assistant/SKILL.md",
      ]
    )) {
      assert.ok(files.includes(required), required);
    }
    const mcp = json("spec/mcp.json");
    for (const tool of [...mcp.requiredTools, ...mcp.optionalTools]) {
      assert.ok(
        files.includes(`skills/media-assistant/references/tools/${tool}.json`),
        `packaged Tool format: ${tool}`,
      );
    }
    assert.equal(files.some((path) => path.startsWith("vector-mcp/")), false);
  });

  it("creates a real tgz with a discoverable Codex skill and remote MCP", () => {
    archiveTempRoot = mkdtempSync(join(tmpdir(), "ypmcn-release-test-"));
    const { archive, files } = packPackageArchive(stagedPluginRoot, archiveTempRoot);
    assert.equal(existsSync(archive), true);
    assert.ok(files.includes(".codex-plugin/plugin.json"));
    assert.ok(files.includes("skills/media-assistant/SKILL.md"));
    assert.equal(files.some((path) => path.startsWith("vector-mcp/")), false);

    const manifest = JSON.parse(readArchiveFile(archive, ".codex-plugin/plugin.json"));
    const mcp = JSON.parse(readArchiveFile(archive, ".mcp.json"));
    assert.equal(manifest.name, "ypmcn-media-assistant");
    assert.equal(manifest.skills, "./skills/");
    assert.equal(manifest.mcpServers, "./.mcp.json");
    assert.equal(mcp.mcpServers["ypmcn-mcp"].url, "https://mcp.eshypdata.com/sse");
    assert.equal("command" in mcp.mcpServers["ypmcn-mcp"], false);
  });

  it("does not trigger npm install in the OpenClaw plugin installer", () => {
    const stagedPackage = json("packages/.staging/ypmcn-media-assistant/package.json");
    assert.equal(stagedPackage.dependencies, undefined);
  });

  it("keeps the installable runtime free of blocked process execution patterns", () => {
    const runtime = readFileSync(new URL("../packages/.staging/ypmcn-media-assistant/dist/index.js", import.meta.url), "utf8");
    assert.doesNotMatch(runtime, /node:child_process|\b(?:exec|spawn|execFile)(?:Sync)?\s*\(/);
  });

  it("excludes legacy Python hooks and bytecode from the cross-platform archive", () => {
    const files = dryRunFiles();
    assert.equal(files.some((path) => /(?:\.py|\.pyc)$|__pycache__/.test(path)), false);
    assert.equal(files.some((path) => path.startsWith("hooks/")), false);
  });

  it("excludes source, tests, mocks, scripts, and secret files", () => {
    const files = dryRunFiles();
    const forbidden = [
      /^src\//,
      /^tests\//,
      /^scripts\//,
      /mock/i,
      /(?:^|\/)\.env(?:\.|$)/,
      /(?:secret|credential)/i,
      /^vector-mcp\//,
    ];
    for (const path of files) {
      assert.equal(forbidden.some((pattern) => pattern.test(path)), false, path);
    }
  });

  it("declares one offline verifier, a separate provider gate, and CI", () => {
    const rootPackage = json("package.json");
    const pluginPackage = json("YPmcn/package.json");
    assert.equal(rootPackage.scripts.verify, "node scripts/verify.mjs");
    assert.match(rootPackage.scripts["verify:provider"], /check-provider-contract/);
    assert.equal(rootPackage.scripts["pack:yp"], "node scripts/prepare-package.mjs");
    assert.equal(pluginPackage.scripts["pack:yp"], "node ../scripts/prepare-package.mjs");
    assert.equal(existsSync(new URL("../.github/workflows/verify.yml", import.meta.url)), true);
  });

  it("stages outside source and reserves packages/releases for archives", () => {
    assert.equal(existsSync(new URL("../YPmcn/spec", import.meta.url)), false);
    assert.equal(existsSync(new URL("../YPmcn/vector-mcp", import.meta.url)), false);
    assert.equal(existsSync(new URL("../packages/.staging/ypmcn-media-assistant/spec/mcp.json", import.meta.url)), true);
    assert.equal(existsSync(new URL("../packages/.staging/ypmcn-media-assistant/hooks", import.meta.url)), false);
  });

  it("loads the staged package-local Spec without a repository-relative copy", () => {
    const loaderUrl = pathToFileURL(`${stagedPluginRoot}/dist/contract/loader.js`).href;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `const { loadContractProfile } = await import(${JSON.stringify(loaderUrl)}); if (loadContractProfile("mvp-v2").profile !== "mvp-v2") process.exit(1);`,
      ],
      { cwd: stagedPluginRoot, encoding: "utf8" },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
});
