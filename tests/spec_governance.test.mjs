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
    assert.deepEqual(mediaAssistant.toolPolicy.primarySequence, [
      "select_inquiry_form_fields",
      "validate_requirement",
      "manual_source_creators",
      "rank_creators",
      "create_submission_batch",
    ]);
    assert.equal(
      mediaAssistant.toolPolicy.phasePolicy.manual_source_creators,
      "direct-before-search-or-after-complete-mcn-flow-and-fresh-requirement-validation",
    );
    assert.deepEqual(mediaAssistant.toolPolicy.interactionPolicy.fieldSelection, {
      resultSource: "actual fields returned by the select_inquiry_form_fields webpage callback",
      reopenSelectorAfterToolResult: false,
    });
    assert.deepEqual(mediaAssistant.toolPolicy.interactionPolicy.requirementClarification, {
      maxQuestions: 5,
      minOptionsPerQuestion: 2,
      maxOptionsPerQuestion: 6,
      exposeInternalPriceFieldNames: false,
      contentFormImpliesDuration: false,
    });
    assert.deepEqual(mediaAssistant.toolPolicy.interactionPolicy.humanInTheLoop, {
      conversationInputSurface: "native-AskUserQuestion-only",
      askBeforeHumanDecisionPause: true,
      hostProvidedCustomInputPerPopup: true,
      toolOwnedInteractiveSurface: "select_inquiry_form_fields webpage callback without a redundant chat confirmation",
      askTriggers: [
        "unresolved_required_or_semantically_ambiguous_business_value",
        "evidence_bound_business_branch",
        "irreversible_external_send",
        "human_confirmation_of_mcn_return_completion",
        "non_deterministic_safe_recovery_choice",
      ],
      prohibitedPauses: [
        "plain_text_question_or_next_step_menu",
        "permission_to_run_a_deterministic_next_action",
        "acknowledgement_only_after_a_submitted_answer",
        "optional_explicit_or_uniquely_derivable_value",
        "multi_platform_processing_order",
      ],
      batchRequirementQuestions: true,
      multilineNonOptionPromptRequired: true,
      postRankMaxUnicodeCharactersPerLine: 40,
      nonterminalOutputMode: "tool-calls-only",
      finalTextPolicy: "concise declarative result only at an allowed stop; no questions, offers, or invitations to continue",
      allowedStops: [
        "next_action_null_terminal",
        "waiting_for_provider",
        "terminal_failure_without_safe_recovery",
        "ask_cancelled_denied_closed_or_timed_out",
      ],
      forbiddenStops: [
        "non_null_next_action_with_waiting_for_null_or_assistant",
        "waiting_for_user_before_AskUserQuestion",
        "submitted_answer_before_selected_action_executes",
        "unfinished_explicit_platform_or_requirement_unit",
      ],
      submittedAnswer: "execute_the_selected_safe_action_in_the_same_assistant_turn",
      externalSendContinuation: "consume_the_latest_unexpired_approved_receipt_once_for_the_next_create_with_distributions_call_without_rechecking_parameter_equality",
      cancelBehavior: "stop_without_a_following_business_write_and_wait_for_a_new_user_message_before_deciding_whether_to_reopen_AskUserQuestion",
      continueMessageRequired: false,
    });
    assert.deepEqual(mediaAssistant.toolPolicy.interactionPolicy.multiPlatform, {
      askExecutionOrder: false,
      defaultExecutionOrder: "first appearance in the exact original Brief",
      clarification: "collect all unresolved values in one AskUserQuestion popup and ask one question per shared value instead of duplicating it per platform",
      completion: "process every explicit platform without asking whether to continue the remaining platform",
      samePlatformSplit: "inherit shared fields into each independent requirement and split only on differing field combinations",
      localUnitLifecycle: "active -> suspended -> resumed or completed, with per-unit next_action and event history independent of Provider workflow state",
    });
    assert.deepEqual(mediaAssistant.toolPolicy.interactionPolicy.manualSourcingResultTable, {
      format: "markdown-table",
      columns: [
        { label: "平台", source: "platform" },
        {
          label: "达人ID",
          sourceByPlatform: {
            douyin: "douyinId",
            xiaohongshu: "xiaohongshuId",
          },
        },
        { label: "达人昵称", source: "nickname" },
        { label: "内容标签", source: "contentTag" },
        { label: "主页链接", source: "kwUserUrl" },
      ],
      missingValue: "-",
      exposeInquiryIds: false,
    });
    assert.deepEqual(mediaAssistant.toolPolicy.interactionPolicy.rankCreatorsRepeatNotice, {
      when: "the current requirement_id equals the immediately previous rank_creators call requirement_id",
      message: "已根据需求进行排序，请注意",
      blocksToolCall: false,
    });
    assert.deepEqual(mediaAssistant.toolPolicy.preconditions.manual_source_creators, [
      "validate_requirement_succeeded_immediately_before_this_call",
      "requirement_id_equals_the_fresh_32_character_data_id_returned_by_that_validation",
      "same_session_context_is_available_to_the_before_tool_hook",
      "fresh_requirement_id_receipt_is_consumed_by_this_call",
      "size_is_a_positive_integer_decimal_string",
      "if_search_started_the_full_mcn_send_and_sync_flow_is_complete",
    ]);
    assert.deepEqual(mediaAssistant.toolPolicy.preconditions.search_creators, [
      "id_is_the_32_character_data_id_from_the_latest_same_session_successful_validation",
      "numeric_data_demand_id_and_demand_version_are_rejected_without_revalidation",
      "missing_before_tool_session_context_never_uses_global_state_as_authorization",
    ]);
    assert.ok(
      mediaAssistant.toolPolicy.preconditions.create_submission_batch.includes(
        "current_production_provider_contract_matches_the_approved_submission_input",
      ),
    );
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
    assert.deepEqual(hooks.boundaries.rankCreatorsRepeatNotice, {
      comparison: "current rank_creators.requirement_id equals the immediately previous rank_creators call in the same state scope",
      message: "已根据需求进行排序，请注意",
      mayBlock: false,
      storesRawRequirementId: false,
    });
    assert.equal(hooks.boundaries.fieldSelectionCallback.reopenSelectorAfterToolResult, false);
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
    assert.match(database.toolDatabaseEffects.rank_mcns.targetInquiryBehavior, /inquiry_id.*distribution/);
    assert.match(database.toolDatabaseEffects.manual_source_creators.targetWriteBoundary, /requirement_id.*size.*excel_file_path/);
    assert.ok(database.knownGaps.some(({ id, severity }) =>
      id === "submission-target-input-not-deployed" && severity === "high"
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
    const supplyDecision = algorithms.definitions.mcnSupplyMultiplierDecision;
    assert.equal(supplyDecision.status, "approved-provider-unverified");
    assert.deepEqual(supplyDecision.creatorIdentity, ["platform", "kwUid"]);
    assert.equal(supplyDecision.preRace.exactManualTargetAllowed, false);
    assert.equal(
      supplyDecision.postRace.exactManualTarget,
      "max(demand_count * 20 - selected_mcn_covered_creator_count, 0)",
    );
    assert.equal(
      supplyDecision.postRace.institutionManualCreatorRatio,
      "demand_count:exact_manual_target; always render, including N:0",
    );
    assert.deepEqual(supplyDecision.riskBands, [
      { risk: "high_risk", condition: "coverage_count < demand_count * 20" },
      { risk: "medium_risk", condition: "demand_count * 20 <= coverage_count < demand_count * 30" },
      { risk: "safe", condition: "coverage_count >= demand_count * 30" },
    ]);
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
    assert.match(mcp.outputContracts.rank_creators.evidenceBasis, /filtering, deduplication/);
    assert.match(
      mcp.outputContracts.select_inquiry_form_fields.evidenceBasis,
      /数据库字段名：字段备注/,
    );
    assert.deepEqual(mcp.outputContracts.search_creators.successSchema.properties.data.required, [
      "total_matched", "supply_assessment",
    ]);
    assert.equal("compatibility" in mcp.outputContracts.search_creators, false);
    assert.deepEqual(mcp.outputContracts.rank_mcns.successSchema.properties.data.required, [
      "inquiry_id", "demand_count", "selected_supplier_ids", "selected_mcn_count",
      "coverage_scope", "selected_mcn_covered_creator_count",
      "selected_mcn_coverage_multiplier", "selected_mcn_risk_level",
      "manual_sourcing_gap_count",
    ]);
    assert.deepEqual(mcp.outputContracts.manual_source_creators.successSchema, {
      type: "object", additionalProperties: true,
    });
    assert.deepEqual(mcp.tools.manual_source_creators.required, ["requirement_id", "size"]);
    assert.equal(mcp.tools.manual_source_creators.properties.size.type, "string");
    assert.deepEqual(mcp.tools.create_submission_batch.required, ["requirement_id", "size", "number"]);
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
