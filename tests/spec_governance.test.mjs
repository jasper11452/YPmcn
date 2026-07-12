import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const specRoot = join(repoRoot, "spec");

function json(relativePath) {
  return JSON.parse(readFileSync(join(specRoot, relativePath), "utf8"));
}

describe("Spec governance", () => {
  it("uses one root manifest for every required contract domain", () => {
    const manifest = json("manifest.json");
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.profile, "mvp-v2");
    assert.equal(manifest.status, "approved");
    assert.deepEqual(Object.keys(manifest.contracts).sort(), [
      "algorithms",
      "database",
      "errors",
      "hooks",
      "mcp",
      "skills",
      "workflow",
    ]);

    for (const relativePath of Object.values(manifest.contracts)) {
      assert.equal(relativePath.startsWith("/") || relativePath.includes(".."), false);
      assert.equal(existsSync(join(specRoot, relativePath)), true, relativePath);
      assert.equal(json(relativePath).profile, manifest.profile, relativePath);
    }
  });

  it("keeps the deployable package from becoming a second tracked Spec source", () => {
    assert.equal(existsSync(join(repoRoot, "YPmcn", "spec")), false);
  });

  it("keeps Skill tool access aligned with the MCP contract", () => {
    const mcp = json("mcp.json");
    const skills = json("skills.json");
    const mediaAssistant = skills.skills["media-assistant"];
    assert.deepEqual(mediaAssistant.allowedTools, [
      ...mcp.requiredTools,
      ...mcp.optionalTools,
    ]);
    assert.equal(mediaAssistant.toolPolicy.contract, "mcp.json");
    assert.equal(
      existsSync(join(repoRoot, mediaAssistant.implementation)),
      true,
      mediaAssistant.implementation,
    );
  });

  it("keeps Hook events aligned with the runtime registration surface", () => {
    const hooks = json("hooks.json");
    const source = readFileSync(join(repoRoot, hooks.implementation), "utf8");
    const registeredEvents = [
      ...source.matchAll(/api\.on\(\s*"([^"]+)"/g),
    ].map((match) => match[1]);
    assert.deepEqual(registeredEvents.sort(), Object.keys(hooks.events).sort());
  });

  it("blocks inferred algorithm contracts until an approved definition exists", () => {
    const algorithms = json("algorithms.json");
    assert.equal(algorithms.readinessStatus, "external-unverified");
    assert.deepEqual(algorithms.definitions, {});
    assert.equal(
      algorithms.governance.changePolicy,
      "blocked_until_approved_definition_exists",
    );
    assert.equal(algorithms.governance.implementationMustNotDefineContract, true);
  });

  it("points the published plugin manifest at the staged current MCP Spec", () => {
    const pluginManifest = JSON.parse(
      readFileSync(join(repoRoot, "YPmcn", "openclaw.plugin.json"), "utf8"),
    );
    assert.equal(pluginManifest.contracts.profile, "mvp-v2");
    assert.equal(pluginManifest.contracts.spec, "./spec/mcp.json");
  });
});
