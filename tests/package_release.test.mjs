import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { before, describe, it } from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const pluginRoot = fileURLToPath(new URL("../YPmcn/", import.meta.url));
const stagedPluginRoot = fileURLToPath(
  new URL("../packages/.staging/ypmcn-media-assistant/", import.meta.url),
);
const VERSION = "3.0.0";

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

before(stageIfImplemented);

describe("3.0.0 release metadata", () => {
  it("uses one version across root, plugin, lockfiles, and manifests", () => {
    const rootPackage = json("package.json");
    const rootLock = json("package-lock.json");
    const pluginPackage = json("YPmcn/package.json");
    const pluginLock = json("YPmcn/package-lock.json");
    const openclawManifest = json("YPmcn/openclaw.plugin.json");
    const claudeManifest = json("YPmcn/.claude-plugin/plugin.json");
    assert.deepEqual([
      rootPackage.version,
      rootLock.version,
      rootLock.packages[""].version,
      pluginPackage.version,
      pluginLock.version,
      pluginLock.packages[""].version,
      openclawManifest.version,
      claudeManifest.version,
    ], Array(8).fill(VERSION));
  });

  it("uses nested OpenClaw metadata and the v2 spec contract", () => {
    const pluginPackage = json("YPmcn/package.json");
    const manifest = json("YPmcn/openclaw.plugin.json");
    assert.deepEqual(pluginPackage.openclaw, {
      hooks: "./dist/index.js",
      extensions: ["./dist/index.js"],
    });
    assert.equal(pluginPackage["openclaw.hooks"], undefined);
    assert.equal(pluginPackage["openclaw.extensions"], undefined);
    assert.equal(manifest.contracts.profile, "mvp-v2");
    assert.equal(manifest.contracts.spec, "./spec/mcp.json");
  });

  it("keeps dependencies owned and exactly pinned", () => {
    const rootPackage = json("package.json");
    const pluginPackage = json("YPmcn/package.json");
    const vectorPackage = json("vector-mcp/package.json");
    assert.deepEqual(rootPackage.dependencies, { mysql2: "3.22.6" });
    assert.equal(pluginPackage.dependencies.mysql2, "3.22.6");
    assert.equal(pluginPackage.devDependencies.typescript, "5.9.3");
    assert.equal(pluginPackage.devDependencies.openclaw, "2026.6.11");
    assert.equal(vectorPackage.dependencies.mysql2, "3.22.6");
    assert.equal(vectorPackage.devDependencies.typescript, "5.9.3");
  });
});

describe("reproducible plugin package", () => {
  it("contains current specs, plugin dist, skills, and freshly staged vector dist", () => {
    const files = dryRunFiles();
    for (const required of (
      [
        "dist/index.js",
        "spec/mcp.json",
        "spec/workflow.json",
        "skills/media-assistant/SKILL.md",
        "vector-mcp/dist/server.js",
      ]
    )) {
      assert.ok(files.includes(required), required);
    }
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
      /vector-mcp\/dist\/.*\.test\./,
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
