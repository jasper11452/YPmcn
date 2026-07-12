import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const specRoot = join(repoRoot, "spec");

function json(relativePath) {
  return JSON.parse(readFileSync(join(specRoot, relativePath), "utf8"));
}

function canonicalizeJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function collectExternalSchemaRefs(value, refs = []) {
  if (Array.isArray(value)) {
    for (const entry of value) collectExternalSchemaRefs(entry, refs);
  } else if (value !== null && typeof value === "object") {
    if (typeof value.$ref === "string" && value.$ref.startsWith("schemas/")) {
      refs.push(value.$ref);
    }
    for (const child of Object.values(value)) collectExternalSchemaRefs(child, refs);
  }
  return refs;
}

function resolveJsonPointer(document, pointer) {
  if (!pointer) return document;
  return pointer
    .replace(/^\//, "")
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce((node, segment) => node?.[segment], document);
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
      "requirements",
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

  it("locks mvp-v2 business tools to one Host namespace while tools/list stays bare", () => {
    const mcp = json("mcp.json");
    const toolNames = [...mcp.requiredTools, ...mcp.optionalTools];
    const identity = mcp.serverIdentity;
    const pattern = new RegExp(identity.hostQualifiedToolName.pattern);

    assert.equal(identity.canonicalNamespace, "ypmcn");
    assert.equal(identity.hostQualifiedToolName.format, "mcp__ypmcn__<contract-tool>");
    assert.equal(
      identity.hostQualifiedToolName.pattern,
      `^mcp__ypmcn__(?:${toolNames.join("|")})$`,
    );
    assert.equal(identity.hostQualifiedToolName.bareHookEvent, "not-a-business-tool");
    assert.deepEqual(identity.excludedNamespaces, ["vector-mcp"]);
    assert.equal(identity.providerToolsList.toolNameFormat, "bare-contract-tool");
    assert.equal(identity.providerToolsList.namespace, "not-applicable");

    for (const name of toolNames) {
      assert.match(`mcp__ypmcn__${name}`, pattern);
      assert.doesNotMatch(name, pattern);
      assert.doesNotMatch(`mcp__foreign__${name}`, pattern);
      assert.doesNotMatch(`mcp__vector-mcp__${name}`, pattern);
    }
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

  it("resolves every generated JSON Schema reference inside the repository", () => {
    const requirements = json("requirements.json");
    const database = json("database.json");
    const mcp = json("mcp.json");
    const workflow = json("workflow.json");
    const references = [
      ...Object.values(requirements.schemas),
    ];

    for (const reference of references) {
      const relativePath = reference.path;
      assert.match(relativePath, /^schemas\/[a-z0-9-]+\.schema\.json$/);
      const absolutePath = join(specRoot, relativePath);
      assert.equal(existsSync(absolutePath), true, reference);
      const schema = JSON.parse(readFileSync(absolutePath, "utf8"));
      assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
      assert.match(schema.$id, /^https:\/\/ypmcn\.local\/schemas\//);
      assert.equal(typeof schema.title, "string");
      assert.ok(schema.title.length > 0);
      assert.equal(
        createHash("sha256").update(canonicalizeJson(schema), "utf8").digest("hex"),
        reference.hash,
        relativePath,
      );
    }

    const registeredPaths = new Set(references.map(({ path }) => path));
    for (const reference of [
      ...Object.values(database.entities).map(({ recordSchema }) => recordSchema),
      workflow.stateAuthority.schema,
    ]) {
      const [relativePath] = reference.split("#", 1);
      assert.equal(registeredPaths.has(relativePath), true, reference);
    }

    for (const reference of collectExternalSchemaRefs(mcp)) {
      const [relativePath, fragment = ""] = reference.split("#", 2);
      assert.equal(registeredPaths.has(relativePath), true, reference);
      const schema = json(relativePath);
      assert.notEqual(resolveJsonPointer(schema, fragment), undefined, reference);
    }
  });

  it("pins the customer-content-free requirement dictionary by canonical hash", () => {
    const requirements = json("requirements.json");
    const dictionary = json(requirements.dictionary.path);
    const reproducedHash = createHash("sha256")
      .update(canonicalizeJson(dictionary.definitions), "utf8")
      .digest("hex");

    assert.equal(dictionary.contentPolicy.containsCustomerContent, false);
    assert.equal(dictionary.dictionaryHash, reproducedHash);
    assert.equal(requirements.dictionary.version, dictionary.dictionaryVersion);
    assert.equal(requirements.dictionary.hash, dictionary.dictionaryHash);
    assert.equal(requirements.dictionary.customerContentAllowed, false);
  });

  it("requires one output contract per tool and only catalogued errors", () => {
    const mcp = json("mcp.json");
    const errors = json("errors.json");
    const toolNames = [...mcp.requiredTools, ...mcp.optionalTools];
    const knownCodes = new Set(errors.codes);

    assert.deepEqual(Object.keys(mcp.outputContracts), toolNames);
    for (const name of toolNames) {
      const output = mcp.outputContracts[name];
      assert.equal(output.successEnvelope, mcp.tools[name].outputEnvelope, name);
      assert.equal(output.failureEnvelope, "standard", name);
      assert.equal(typeof output.successSchema, "object", name);
      assert.ok(output.errorCodes.length > 0, name);
      for (const code of output.errorCodes) {
        assert.equal(knownCodes.has(code), true, `${name}:${code}`);
      }
    }
  });

  it("keeps the approved finding registry one-to-one with authoritative Spec paths", () => {
    const proposal = readFileSync(
      join(repoRoot, "changes", "CHG-2026-007-contract-closure.md"),
      "utf8",
    );
    const rows = proposal
      .split("\n")
      .filter((line) => /^\| `[A-Z0-9_]+` \| P[01] \|/.test(line));
    const findings = rows.map((line) => line.split("|")[1].trim());
    const definitions = rows.map((line) => line.split("|")[3].trim());

    assert.equal(rows.length, 7);
    assert.equal(new Set(findings).size, rows.length);
    assert.equal(new Set(definitions).size, rows.length);
    for (const definition of definitions) {
      const match = definition.match(/`spec\/([^#`]+)(?:#[^`]*)?`/);
      assert.ok(match, definition);
      assert.equal(existsSync(join(specRoot, match[1])), true, definition);
    }
  });

  it("points the published plugin manifest at the staged current MCP Spec", () => {
    const pluginManifest = JSON.parse(
      readFileSync(join(repoRoot, "YPmcn", "openclaw.plugin.json"), "utf8"),
    );
    assert.equal(pluginManifest.contracts.profile, "mvp-v2");
    assert.equal(pluginManifest.contracts.spec, "./spec/mcp.json");
  });
});
