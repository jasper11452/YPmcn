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
    assert.deepEqual(mediaAssistant.toolPolicy.preconditions.manual_source_creators, [
      "provider_supply_evidence_is_complete_and_high_risk_with_positive_suggested_expansion",
      "submitted_supply_command_binds_requirement_id_and_one_positive_target_count",
      "rank_mcns_succeeded_for_the_same_requirement_and_returned_inquiry_id",
      "no_distribution_has_been_sent",
    ]);
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

  it("pins the observed database authority, identities, ownership, and recommendation path", () => {
    const database = json("database.json");

    assert.equal(database.businessDataAuthority.systemOfRecord, "mysql");
    assert.equal(database.businessDataAuthority.vectorIndex.publicToolAvailable, false);
    assert.deepEqual(database.businessDataAuthority.vectorIndex.internalConsumers, [
      "search_creators",
      "rank_creators",
    ]);
    assert.equal(database.observedTables.core_supplier.rowCountObserved, 280);
    assert.equal(database.mvpEntityBaseline.supplierAuthority.legacyEmptyTable, "mcn_agencies");
    assert.deepEqual(database.mvpEntityBaseline.creatorBusinessIdentity, [
      "platform",
      "kwUid",
    ]);
    assert.equal(
      database.mvpEntityBaseline.ownershipPolicy,
      "observed-development-runtime",
    );
    assert.deepEqual(database.mvpEntityBaseline.businessMcpWriterOwnership.customer_demands, ["validate_requirement", "record_client_feedback"]);
    assert.deepEqual(database.mvpEntityBaseline.businessMcpWriterOwnership.mcn_inquiries, ["sync_mcn_inquiry_status"]);
    assert.deepEqual(database.mvpEntityBaseline.businessMcpWriterOwnership.mcn_inquiry_status_syncs, ["sync_mcn_inquiry_status"]);
    assert.match(database.toolDatabaseEffects.sync_mcn_inquiry_status.currentLimitation, /not yet deployed/);
    assert.deepEqual(database.toolDatabaseEffects.rank_mcns.targetWrites, ["mcn_inquiries"]);
    assert.match(database.toolDatabaseEffects.rank_mcns.targetInquiryBehavior, /inquiry_id.*manual_source_creators/);
    assert.match(database.toolDatabaseEffects.manual_source_creators.targetWriteBoundary, /persist.*durable manual-sourcing task/);
    assert.ok(database.knownGaps.some(({ id, severity }) =>
      id === "manual-sourcing-task-store-unverified" && severity === "high"
    ));
    assert.equal(database.toolDatabaseEffects.audit_manual_adjustment.writes.includes("audit_events"), false);
  });

  it("keeps vector query and operations out of the public business surface", () => {
    const mcp = json("mcp.json");
    const businessTools = [...mcp.requiredTools, ...mcp.optionalTools];

    assert.deepEqual(mcp.vectorCapabilityBoundary.publicBusinessVectorTools, []);
    assert.equal(mcp.vectorCapabilityBoundary.excludedNamespace, "vector-mcp");
    assert.deepEqual(mcp.serverIdentity.excludedNamespaces, ["vector-mcp"]);
    assert.deepEqual(mcp.vectorCapabilityBoundary.operationsTools, [
      "sync_creator_tag_vectors",
      "health_check_vector_store",
    ]);
    assert.equal(new Set(businessTools).size, 15);
    assert.equal(businessTools.includes("search_creator_tag_vectors"), false);
    assert.equal("search_creator_tag_vectors" in mcp.tools, false);
    for (const name of mcp.vectorCapabilityBoundary.operationsTools) {
      assert.equal(businessTools.includes(name), false, name);
      assert.equal(name in mcp.tools, false, name);
    }
    assert.deepEqual(mcp.vectorCapabilityBoundary.internalConsumers, [
      "search_creators",
      "rank_creators",
    ]);
  });

  it("pins named-vector fields and retrieval semantics without production defaults", () => {
    const algorithms = json("algorithms.json");
    const retrieval = algorithms.vectorGovernance.creatorVectorRetrieval;
    const prohibitedEmbeddingFields = [
      "id", "platform", "kwUid", "source_snapshot_date", "nickname", "url",
      "agency", "gender", "age", "region", "follower_metrics",
      "engagement_metrics", "cpe", "cpm", "prices", "rebate",
      "numeric_only_json",
    ];

    assert.equal(algorithms.readinessStatus, "external-unverified");
    assert.deepEqual(algorithms.definitions, {});
    assert.equal(retrieval.status, "shadow");
    assert.deepEqual(retrieval.internalConsumers, ["search_creators", "rank_creators"]);
    assert.equal(retrieval.authoritativeSource, "mysql");
    assert.equal(retrieval.derivedIndex, "qdrant");
    assert.equal(retrieval.returnVerification, "rehydrate-and-revalidate-current-mysql-record");
    assert.deepEqual(retrieval.namedVectors.content.includeFields, [
      "creator_type", "content_types", "content_tags", "persona", "clean_description",
    ]);
    assert.deepEqual(retrieval.namedVectors.commercial.includeFields, [
      "parsed_brands", "parsed_categories", "parsed_scenarios", "parsed_benefits",
      "parsed_ingredients", "parsed_ip",
    ]);
    for (const vector of Object.values(retrieval.namedVectors)) {
      assert.deepEqual(vector.excludeFields, prohibitedEmbeddingFields);
      assert.deepEqual(
        vector.includeFields.filter((field) => vector.excludeFields.includes(field)),
        [],
      );
    }
    assert.deepEqual(retrieval.hardConstraints, [
      "platform", "region", "follower_range", "price_range", "compliance",
    ]);
    assert.deepEqual(retrieval.softFeatures, [
      "content_similarity", "commercial_similarity", "content_tags",
    ]);
    assert.equal(retrieval.softFeaturesMayOverrideHardConstraints, false);
    assert.deepEqual(retrieval.rankingPolicy, {
      missingAware: true,
      coverageAware: true,
      zeroIsObservedValue: true,
      missingIsWorstValue: false,
      cpePrimaryWeightAllowed: false,
      explanationRequired: true,
    });
    assert.deepEqual(Object.keys(retrieval.parameters).sort(), [
      "candidateLimit", "dimensions", "distanceMetric", "embeddingModel",
      "embeddingModelVersion", "embeddingProvider", "normalization",
      "rankingWeights", "rerankerModel", "rerankerModelVersion",
      "rerankerProvider", "retrievalTopK", "rrfParameters", "thresholds",
    ]);
    for (const parameter of Object.values(retrieval.parameters)) {
      assert.ok(["pending-evaluation", "disabled"].includes(parameter.status));
      assert.equal(parameter.value, null);
    }
    assert.equal(
      algorithms.governance.changePolicy,
      "approved-baseline-parameters-require-frozen-sample-evaluation",
    );
    assert.equal(algorithms.governance.implementationMustNotDefineContract, true);
  });

  it("requires MySQL-revalidated provenance and explicit vector degradation semantics", () => {
    const manifest = json("manifest.json");
    const mcp = json("mcp.json");
    const database = json("database.json");
    const workflow = json("workflow.json");
    const errors = json("errors.json");
    const vectorCodes = [
      "VECTOR_CONFIGURATION_INVALID",
      "EMBEDDING_UNAVAILABLE",
      "RERANKER_UNAVAILABLE",
      "VECTOR_STORE_UNAVAILABLE",
      "VECTOR_INDEX_STALE",
      "SQL_ONLY_DEGRADED",
    ];

    assert.equal(manifest.contractBaseline, "mvp-v3-vector-baseline");
    assert.deepEqual(mcp.vectorCapabilityBoundary.internalConsumers, [
      "search_creators",
      "rank_creators",
    ]);
    assert.equal(
      mcp.vectorCapabilityBoundary.search_creators.hardConstraintsAuthoritativeSource,
      "mysql",
    );
    assert.match(
      mcp.vectorCapabilityBoundary.search_creators.resultFieldAuthority.creatorPrices,
      /xhs_creator_accounts.*dy_creator_accounts/,
    );
    assert.match(
      mcp.vectorCapabilityBoundary.search_creators.resultFieldAuthority.creatorSupplierRebate,
      /creator_supply_offers/,
    );
    assert.match(
      database.runtimeDatabaseCompatibility.searchCreatorsFieldAuthority.priceSource.rule,
      /platform creator table/,
    );
    assert.match(
      database.runtimeDatabaseCompatibility.searchCreatorsFieldAuthority.rebateSource.rule,
      /must never be reported as an actual supplier rebate/,
    );
    assert.equal(mcp.vectorCapabilityBoundary.rank_creators.provenanceRequired, true);
    for (const toolName of ["search_creators", "rank_creators"]) {
      const output = mcp.outputContracts[toolName];
      assert.equal(output.advertisedOutputSchema, false);
      assert.equal(output.successSchema.additionalProperties, true);
    }
    assert.deepEqual(workflow.vectorDegradationPolicy, {
      mode: "explicit-sql-only",
      preserveBusinessWorkflow: true,
      requiredResultFields: ["retrieval_mode", "degraded_reason", "provenance"],
      retrievalMode: "sql-only",
      allowedReasons: [
        "vector_configuration_invalid",
        "embedding_unavailable",
        "reranker_unavailable",
        "vector_store_unavailable",
        "vector_index_stale",
      ],
      staleHitPolicy: "exclude-and-revalidate-from-mysql",
      prohibitedSubstitutes: ["fake-qdrant", "local-json-as-production-result"],
    });
    for (const code of vectorCodes) {
      assert.ok(errors.codes.includes(code), code);
      assert.equal(errors.errors.filter((entry) => entry.code === code).length, 1, code);
    }
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

  it("keeps workflow phases identical to the registered workflow-state schema", () => {
    const workflow = json("workflow.json");
    const schema = json("schemas/workflow-state.schema.json");
    assert.deepEqual(schema.properties.phase.enum, workflow.phases);
    assert.ok(workflow.stateAuthority.derivationOrder.includes("feedback-routing"));
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

  it("keeps outputs unadvertised while declaring approved continuation evidence", () => {
    const mcp = json("mcp.json");
    const errors = json("errors.json");
    const toolNames = [...mcp.requiredTools, ...mcp.optionalTools];
    const knownCodes = new Set(errors.codes);

    assert.deepEqual(Object.keys(mcp.outputContracts), toolNames);
    for (const name of toolNames) {
      const output = mcp.outputContracts[name];
      assert.equal(output.successEnvelope, mcp.tools[name].outputEnvelope, name);
      assert.equal(output.failureEnvelope, "observed-runtime", name);
      assert.equal(output.advertisedOutputSchema, false, name);
      assert.equal(output.successSchema.additionalProperties, true, name);
      assert.equal(typeof output.evidenceBasis, "string", name);
      assert.equal(Array.isArray(output.errorCodes), true, name);
      for (const code of output.errorCodes) {
        assert.equal(knownCodes.has(code), true, `${name}:${code}`);
      }
    }
    assert.match(mcp.outputContracts.rank_creators.evidenceBasis, /run_id/);
    assert.match(
      mcp.outputContracts.select_inquiry_form_fields.evidenceBasis,
      /数据库字段名：字段备注/,
    );
    assert.deepEqual(mcp.outputContracts.search_creators.successSchema.properties.data.required, [
      "demand_count", "eligible_creator_count", "supply_ratio", "hard_shortfall_count",
      "buffer_shortfall_count", "supply_risk_level", "suggested_expansion_count",
      "mcn_covered_creator_count", "mcn_manual_creator_ratio", "recommended_action",
    ]);
    assert.deepEqual(mcp.outputContracts.manual_source_creators.successSchema.properties.data.required, [
      "task_id", "requirement_id", "inquiry_id", "target_count", "status", "operation", "started_at", "accepted_count",
    ]);
    assert.deepEqual(mcp.tools.manual_source_creators.required, ["requirement_id", "target_count"]);
    assert.equal(mcp.tools.manual_source_creators.properties.target_count.minimum, 1);
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
