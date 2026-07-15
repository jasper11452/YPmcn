import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  createReferenceState,
  createToolDefinitions,
} from "../reference-mcp/state.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const serverPath = fileURLToPath(new URL("../reference-mcp/server.mjs", import.meta.url));
const targetProfile = JSON.parse(
  readFileSync(new URL("../spec/profiles/reference-mvp-v2.json", import.meta.url), "utf8"),
);
const workflowSchema = JSON.parse(
  readFileSync(
    new URL("../spec/profiles/reference-mvp-v2-workflow-state.schema.json", import.meta.url),
    "utf8",
  ),
);
const requirementDictionary = JSON.parse(
  readFileSync(new URL("../spec/requirement-dictionary.json", import.meta.url), "utf8"),
);
const START = Date.parse("2026-07-11T10:00:00+08:00");
const RAW_MESSAGES = [{ role: "client", content: "小红书 2 位创作者，预算 1,000 至 2,000 元" }];

function value(callResult) {
  assert.equal(callResult.simulated, true);
  return callResult.output;
}

function isRecord(candidate) {
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);
}

function canonicalJson(candidate) {
  if (Array.isArray(candidate)) return `[${candidate.map(canonicalJson).join(",")}]`;
  if (isRecord(candidate)) {
    return `{${Object.keys(candidate).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(candidate[key])}`).join(",")}}`;
  }
  return JSON.stringify(candidate);
}

function resolvePointer(document, pointer) {
  if (pointer === "") return document;
  return pointer.split("/").slice(1).reduce((valueAtPointer, token) => {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    return valueAtPointer[key];
  }, document);
}

function resolveReference(reference) {
  if (reference.startsWith("#")) {
    return resolvePointer(targetProfile, reference.slice(1));
  }
  const [path, pointer = ""] = reference.split("#");
  assert.equal(path, "schemas/workflow-state.schema.json", `unexpected test schema reference ${reference}`);
  return resolvePointer(workflowSchema, pointer);
}

function matchesType(candidate, type) {
  switch (type) {
    case "array": return Array.isArray(candidate);
    case "boolean": return typeof candidate === "boolean";
    case "integer": return Number.isInteger(candidate);
    case "null": return candidate === null;
    case "number": return typeof candidate === "number" && Number.isFinite(candidate);
    case "object": return isRecord(candidate);
    case "string": return typeof candidate === "string";
    default: return true;
  }
}

function schemaIssues(schema, candidate, path = "$") {
  if (schema.$ref) return schemaIssues(resolveReference(schema.$ref), candidate, path);

  const issues = [];
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length > 0 && !types.some((type) => matchesType(candidate, type))) {
    return [`${path} has the wrong type`];
  }
  if (Object.hasOwn(schema, "const") && canonicalJson(candidate) !== canonicalJson(schema.const)) {
    issues.push(`${path} does not match const`);
  }
  if (schema.enum && !schema.enum.some((entry) => canonicalJson(entry) === canonicalJson(candidate))) {
    issues.push(`${path} is not in enum`);
  }
  if (typeof candidate === "string") {
    if (schema.minLength !== undefined && candidate.length < schema.minLength) {
      issues.push(`${path} is too short`);
    }
    if (schema.pattern && !(new RegExp(schema.pattern).test(candidate))) {
      issues.push(`${path} does not match pattern`);
    }
    if (schema.format === "date-time" && !Number.isFinite(Date.parse(candidate))) {
      issues.push(`${path} is not a date-time`);
    }
  }
  if (typeof candidate === "number") {
    if (schema.minimum !== undefined && candidate < schema.minimum) issues.push(`${path} is below minimum`);
    if (schema.maximum !== undefined && candidate > schema.maximum) issues.push(`${path} is above maximum`);
  }
  if (Array.isArray(candidate)) {
    if (schema.minItems !== undefined && candidate.length < schema.minItems) issues.push(`${path} has too few items`);
    if (schema.uniqueItems && new Set(candidate.map(canonicalJson)).size !== candidate.length) {
      issues.push(`${path} has duplicate items`);
    }
    if (schema.items) {
      candidate.forEach((entry, index) => issues.push(...schemaIssues(schema.items, entry, `${path}[${index}]`)));
    }
  }
  if (isRecord(candidate)) {
    if (schema.minProperties !== undefined && Object.keys(candidate).length < schema.minProperties) {
      issues.push(`${path} has too few properties`);
    }
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(candidate, required)) issues.push(`${path}.${required} is required`);
    }
    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(candidate, key)) issues.push(...schemaIssues(childSchema, candidate[key], `${path}.${key}`));
    }
    for (const key of Object.keys(candidate)) {
      if (Object.hasOwn(schema.properties ?? {}, key)) continue;
      if (schema.additionalProperties === false) issues.push(`${path}.${key} is not declared`);
      if (isRecord(schema.additionalProperties)) {
        issues.push(...schemaIssues(schema.additionalProperties, candidate[key], `${path}.${key}`));
      }
    }
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((branch) => schemaIssues(branch, candidate, path).length === 0);
    if (matches.length !== 1) issues.push(`${path} does not match exactly one branch`);
  }
  return issues;
}

function assertNoSimulationMarker(candidate, path = "$") {
  if (Array.isArray(candidate)) {
    candidate.forEach((entry, index) => assertNoSimulationMarker(entry, `${path}[${index}]`));
    return;
  }
  if (!isRecord(candidate)) return;
  assert.equal(Object.hasOwn(candidate, "simulated"), false, `${path}.simulated must stay in the MCP wrapper`);
  assert.equal(
    Object.hasOwn(candidate, "productionEvidence"),
    false,
    `${path}.productionEvidence must stay in the MCP wrapper`,
  );
  for (const [key, entry] of Object.entries(candidate)) assertNoSimulationMarker(entry, `${path}.${key}`);
}

function assertContractOutput(name, output, expectedSuccess) {
  const contract = targetProfile.outputContracts[name];
  assert.ok(contract, name);
  const envelopeName = expectedSuccess ? contract.successEnvelope : contract.failureEnvelope;
  const envelope = targetProfile.outputEnvelopes[envelopeName];
  assert.deepEqual(schemaIssues(envelope, output), [], `${name} ${envelopeName} envelope`);

  if (expectedSuccess) {
    const payload = envelopeName === "standard" ? output.data : output;
    assert.deepEqual(schemaIssues(contract.successSchema, payload), [], `${name} success data`);
    assertNoSimulationMarker(payload);
  } else {
    assert.ok(contract.errorCodes.includes(output.error.code), `${name} returned undeclared ${output.error.code}`);
  }
}

async function callSuccess(state, name, args) {
  const output = value(await state.callTool(name, args));
  assert.equal(output.success, true, `${name}: ${output.error?.code ?? "expected success"}`);
  assertContractOutput(name, output, true);
  return output;
}

async function callFailure(state, name, args, expectedCode) {
  const output = value(await state.callTool(name, args));
  assert.equal(output.success, false, `${name} should fail`);
  assert.equal(output.error.code, expectedCode);
  assertContractOutput(name, output, false);
  return output;
}

function validRequirement(overrides = {}) {
  return {
    raw_messages_json: JSON.stringify([{ content: RAW_MESSAGES[0].content, role: "client" }]),
    raw_messages: structuredClone(RAW_MESSAGES),
    platform: "xhs",
    budget_min_cents: 100_000,
    budget_max_cents: 200_000,
    rebate_min_rate: 0.1,
    rebate_max_rate: 0.2,
    supplier_response_deadline_at: "2026-07-11T10:01:00+08:00",
    client_submission_deadline_at: "2026-07-11T11:00:00+08:00",
    content_publish_deadline_at: "2026-07-12T12:00:00+08:00",
    constraints: [{
      kind: "all",
      expressions: [
        {
          kind: "comparison",
          field: "platform",
          operator: "eq",
          value: "xhs",
          severity: "hard",
          missingPolicy: "reject",
        },
        {
          kind: "range",
          field: "budget_min_cents",
          lower: 100_000,
          upper: 200_000,
          lowerInclusive: true,
          upperInclusive: true,
          severity: "soft",
          missingPolicy: "need_review",
        },
      ],
    }],
    ...overrides,
  };
}

async function advanceToSelection(state) {
  const requirement = await callSuccess(state, "validate_requirement", validRequirement());
  const pool = await callSuccess(state, "search_creators", { requirement_id: requirement.data.id });
  const mcn = await callSuccess(state, "rank_mcns", { candidate_pool_id: pool.data.id });
  const selection = await callSuccess(state, "select_inquiry_form_fields", {
    mcn_recommendation_id: mcn.data.id,
  });
  return {
    requirement,
    pool,
    mcn,
    selection,
    requirementId: requirement.data.id,
    mcnRecommendationId: mcn.data.id,
  };
}

async function advanceToSent(state, now) {
  const chain = await advanceToSelection(state);
  const deadline = new Date(now + 60_000).toISOString();
  const distribution = await callSuccess(state, "create_with_distributions", {
    mcn_recommendation_id: chain.mcnRecommendationId,
    projectName: "reference-only",
    description: "offline reference distribution",
    deadline,
    remindAt: new Date(now + 30_000).toISOString(),
    usageScope: "project",
    supplierIds: ["supplier-1", "supplier-2"],
    columns: chain.selection.items,
    sendWechatNotification: true,
    preview_only: false,
  });
  return { ...chain, deadline, distribution };
}

async function advanceToRecovered(state, getNow, setNow) {
  const chain = await advanceToSent(state, getNow());
  const syncArgs = {
    mcn_recommendation_id: chain.mcnRecommendationId,
    requirement_id: chain.requirementId,
  };
  await callSuccess(state, "sync_mcn_inquiry_status", syncArgs);
  setNow(Date.parse(chain.deadline) + 1);
  await callSuccess(state, "sync_mcn_inquiry_status", syncArgs);
  const ingest = await callSuccess(state, "ingest_mcn_submissions", { ...syncArgs, trigger: "manual" });
  await callSuccess(state, "sync_mcn_inquiry_status", syncArgs);
  return { ...chain, syncArgs, ingest };
}

describe("network-free mvp-v2 reference MCP", () => {
  it("publishes every target tool directly from the approved profile", () => {
    const definitions = createToolDefinitions();
    assert.equal(definitions.length, 15);
    assert.deepEqual(
      definitions.map(({ name }) => name),
      [...targetProfile.requiredTools, ...targetProfile.optionalTools],
    );
    for (const definition of definitions) {
      assert.equal(definition.inputSchema.type, "object", definition.name);
      assert.equal(definition.inputSchema.additionalProperties, false, definition.name);
    }
  });

  it("returns a declared failure envelope for invalid input to every tool", async () => {
    const state = createReferenceState({ now: () => START });
    for (const name of [...targetProfile.requiredTools, ...targetProfile.optionalTools]) {
      await callFailure(state, name, {}, "INVALID_INPUT");
    }
  });

  it("returns schema-exact success data for all 15 tools without business simulation markers", async () => {
    let now = START;
    let networkCalls = 0;
    const state = createReferenceState({
      now: () => now,
      fetch: async () => {
        networkCalls += 1;
        throw new Error("reference MCP must not access the network");
      },
    });

    const chain = await advanceToSent(state, now);
    const syncArgs = {
      mcn_recommendation_id: chain.mcnRecommendationId,
      requirement_id: chain.requirementId,
    };
    const firstSync = await callSuccess(state, "sync_mcn_inquiry_status", syncArgs);
    const manual = await callSuccess(state, "manual_source_creators", {
      requirement_id: chain.requirementId,
      manual_results: [{
        platform: "xhs",
        platform_account_id: "manual-creator-1",
        profile_url: "https://example.invalid/manual-creator-1",
      }],
    });
    now = Date.parse(chain.deadline) + 1;
    await callSuccess(state, "sync_mcn_inquiry_status", syncArgs);
    const ingest = await callSuccess(state, "ingest_mcn_submissions", { ...syncArgs, trigger: "manual" });
    const finalSync = await callSuccess(state, "sync_mcn_inquiry_status", syncArgs);
    const ranking = await callSuccess(state, "rank_creators", {
      mcn_recommendation_id: chain.mcnRecommendationId,
      manual_batch_ids: [manual.data.manual_batch_id],
    });
    const batch = await callSuccess(state, "create_submission_batch", { run_id: ranking.data.run_id });
    const feedback = await callSuccess(state, "record_client_feedback", {
      run_id: ranking.data.run_id,
      feedback_items: [{ submission_id: batch.data.id, status: "accepted" }],
    });
    const runDetail = await callSuccess(state, "get_recommendation_run_detail", {
      run_id: ranking.data.run_id,
    });
    const creatorDetail = await callSuccess(state, "get_creator_detail", { creator_id: "creator-0001" });
    const audit = await callSuccess(state, "audit_manual_adjustment", {
      run_id: ranking.data.run_id,
      adjustments: [{
        action: "rerank",
        target_creator_id: "creator-0001",
        reason: "媒介已确认调整",
        before_rank: 2,
        after_rank: 1,
      }],
      operator_id: "operator-0001",
    });
    const workflow = await callSuccess(state, "get_workflow_state", { run_id: ranking.data.run_id });

    assert.deepEqual(
      Object.keys({
        validate_requirement: chain.requirement,
        search_creators: chain.pool,
        rank_mcns: chain.mcn,
        select_inquiry_form_fields: chain.selection,
        create_with_distributions: chain.distribution,
        sync_mcn_inquiry_status: finalSync,
        ingest_mcn_submissions: ingest,
        manual_source_creators: manual,
        rank_creators: ranking,
        create_submission_batch: batch,
        record_client_feedback: feedback,
        get_recommendation_run_detail: runDetail,
        get_creator_detail: creatorDetail,
        audit_manual_adjustment: audit,
        get_workflow_state: workflow,
      }),
      [...targetProfile.requiredTools, ...targetProfile.optionalTools],
    );
    assert.equal(firstSync.data.lifecycle_status, "waiting_return");
    assert.equal(finalSync.data.lifecycle_status, "recovered");
    assert.equal(feedback.data.updated_count, 1);
    assert.equal(networkCalls, 0);
  });

  it("replays canonical requirements and fails validity violations with formal codes", async () => {
    const valid = createReferenceState({ now: () => START });
    const accepted = await callSuccess(valid, "validate_requirement", validRequirement({
      submission_deadline_at: "2026-07-11T03:00:00Z",
      submission_deadline_raw: "2026-07-11t03:00:00z",
    }));
    assert.equal(accepted.data.dictionary_version, requirementDictionary.dictionaryVersion);
    assert.equal(accepted.data.dictionary_hash, requirementDictionary.dictionaryHash);
    const acceptedStateVersion = valid.snapshot().state_version;
    const replayed = await callSuccess(valid, "validate_requirement", validRequirement());
    assert.deepEqual(replayed, accepted);
    assert.equal(valid.snapshot().state_version, acceptedStateVersion);
    await callFailure(
      valid,
      "validate_requirement",
      validRequirement({ project_name: "different canonical requirement" }),
      "INVALID_INPUT",
    );

    const cases = [];
    const canonicalConflict = validRequirement({
      raw_messages_json: JSON.stringify([{ role: "client", content: "different" }]),
    });
    cases.push([canonicalConflict, "CANONICAL_INPUT_CONFLICT"]);

    const missingPlatform = validRequirement();
    delete missingPlatform.platform;
    cases.push([missingPlatform, "INVALID_INPUT"]);

    const dictionaryMismatch = validRequirement({
      requirements_json: {
        dictionary_version: "stale-version",
        dictionary_hash: requirementDictionary.dictionaryHash,
      },
    });
    cases.push([dictionaryMismatch, "DICTIONARY_REFERENCE_MISMATCH"]);

    const missingBudgetBound = validRequirement();
    delete missingBudgetBound.budget_max_cents;
    cases.push([missingBudgetBound, "VALUE_RANGE_INVALID"]);
    cases.push([validRequirement({ rebate_min_rate: 0.8, rebate_max_rate: 0.2 }), "VALUE_RANGE_INVALID"]);
    cases.push([validRequirement({ budget_min_cents: -1 }), "VALUE_RANGE_INVALID"]);

    const missingDeadline = validRequirement();
    delete missingDeadline.supplier_response_deadline_at;
    cases.push([missingDeadline, "DEADLINE_ORDER_INVALID"]);
    cases.push([
      validRequirement({ client_submission_deadline_at: "2026-07-11 11:00:00" }),
      "DEADLINE_ORDER_INVALID",
    ]);
    cases.push([
      validRequirement({ client_submission_deadline_at: "2026-07-10T11:00:00+08:00" }),
      "DEADLINE_ORDER_INVALID",
    ]);
    cases.push([
      validRequirement({ submission_deadline_at: "2026-07-13T11:00:00+08:00" }),
      "DEADLINE_ORDER_INVALID",
    ]);

    cases.push([
      validRequirement({
        constraints: [{
          kind: "comparison",
          field: "nickname",
          operator: "eq",
          value: "unapproved vocabulary",
          severity: "hard",
          missingPolicy: "reject",
        }],
      }),
      "CONSTRAINT_GRAMMAR_INVALID",
    ]);
    cases.push([
      validRequirement({ constraints: [{ kind: "all", expressions: {} }] }),
      "CONSTRAINT_GRAMMAR_INVALID",
    ]);
    cases.push([
      validRequirement({
        constraints: [{
          kind: "comparison",
          field: "platform",
          operator: "contains",
          value: "xhs",
          severity: "hard",
          missingPolicy: "reject",
        }],
      }),
      "CONSTRAINT_GRAMMAR_INVALID",
    ]);

    for (const [args, code] of cases) {
      const state = createReferenceState({ now: () => START });
      await callFailure(state, "validate_requirement", args, code);
      assert.equal(state.snapshot().phase, "requirement_draft");
      assert.equal(state.snapshot().state_version, 1);
    }
  });

  it("derives closed-world state, binds send identity, and enforces refresh/request/finalize", async () => {
    let now = START;
    const state = createReferenceState({ now: () => now });
    const chain = await advanceToSelection(state);
    const selectedState = await callSuccess(state, "get_workflow_state", {
      mcn_recommendation_id: chain.mcnRecommendationId,
    });
    assert.equal(selectedState.data.phase, "field_selection_ready");
    assert.deepEqual(selectedState.data.allowed_actions, ["create_with_distributions"]);
    assert.equal(selectedState.data.state_version, 5);
    assert.equal(selectedState.data.identifiers.selection_result_id, "selection-0001");

    const columns = structuredClone(chain.selection.items);
    chain.selection.items[0].name = "caller mutation";
    const deadline = new Date(now + 60_000).toISOString();
    const sendArgs = {
      mcn_recommendation_id: chain.mcnRecommendationId,
      projectName: "reference-only",
      description: "offline reference distribution",
      deadline,
      remindAt: new Date(now + 30_000).toISOString(),
      usageScope: "project",
      supplierIds: ["supplier-1", "supplier-2"],
      columns,
      sendWechatNotification: true,
      preview_only: false,
    };
    const distribution = await callSuccess(state, "create_with_distributions", sendArgs);
    assert.equal(distribution.data.selection_result_id, selectedState.data.identifiers.selection_result_id);
    assert.equal(distribution.data.send_operation_id, "send-0001");
    assert.equal(distribution.data.state_version, 6);

    const sentState = await callSuccess(state, "get_workflow_state", {
      requirement_id: chain.requirementId,
    });
    assert.equal(sentState.data.phase, "distribution_sync_pending");
    assert.deepEqual(sentState.data.allowed_actions, ["refresh_recovery"]);
    assert.equal(sentState.data.identifiers.selection_result_id, distribution.data.selection_result_id);
    assert.equal(sentState.data.identifiers.send_operation_id, distribution.data.send_operation_id);

    const syncArgs = {
      mcn_recommendation_id: chain.mcnRecommendationId,
      requirement_id: chain.requirementId,
    };
    const firstRefresh = await callSuccess(state, "sync_mcn_inquiry_status", syncArgs);
    assert.equal(firstRefresh.data.state_version, 7);
    assert.deepEqual(firstRefresh.data.allowed_actions, ["refresh_recovery"]);
    const repeatedWaitingRefresh = await callSuccess(state, "sync_mcn_inquiry_status", syncArgs);
    assert.deepEqual(repeatedWaitingRefresh, firstRefresh);

    now = Date.parse(deadline) + 1;
    const requestable = await callSuccess(state, "sync_mcn_inquiry_status", syncArgs);
    assert.equal(requestable.data.state_version, 8);
    assert.deepEqual(requestable.data.allowed_actions, ["request_recovery"]);
    await callFailure(state, "sync_mcn_inquiry_status", syncArgs, "INVALID_PHASE");

    const manualRequest = await callSuccess(state, "ingest_mcn_submissions", {
      ...syncArgs,
      trigger: "manual",
    });
    const scheduledReplay = await callSuccess(state, "ingest_mcn_submissions", {
      ...syncArgs,
      trigger: "scheduled",
    });
    assert.deepEqual(scheduledReplay, manualRequest);
    assert.equal(manualRequest.data.state_version, 9);
    assert.deepEqual(manualRequest.data.allowed_actions, ["finalize_recovery"]);
    assert.equal(state.snapshot().recoveryOperationCount, 1);

    const pendingState = await callSuccess(state, "get_workflow_state", {
      inquiry_batch_id: firstRefresh.data.inquiry_batch_id,
    });
    assert.equal(pendingState.data.phase, "recovery_sync_pending");
    assert.equal(
      pendingState.data.identifiers.recovery_operation_id,
      manualRequest.data.recovery_operation_id,
    );

    const finalized = await callSuccess(state, "sync_mcn_inquiry_status", syncArgs);
    assert.equal(finalized.data.state_version, 10);
    assert.deepEqual(finalized.data.allowed_actions, ["refresh_recovery", "rank_creators"]);
    const terminalRefresh = await callSuccess(state, "sync_mcn_inquiry_status", syncArgs);
    assert.deepEqual(terminalRefresh, finalized);
    await callFailure(
      state,
      "ingest_mcn_submissions",
      { ...syncArgs, trigger: "scheduled" },
      "RECOVERY_ALREADY_TERMINAL",
    );

    const corrupt = createReferenceState({
      now: () => START,
      initialState: {
        phase: "recovering",
        lifecycle_status: "closed",
        response_status: "completed",
        state_version: 7,
        identifiers: { requirement_id: "req-corrupt" },
      },
    });
    await callFailure(
      corrupt,
      "get_workflow_state",
      { requirement_id: "req-corrupt" },
      "STATE_COMBINATION_INVALID",
    );
  });

  it("keeps selection, recommendation, and submission artifacts frozen without offer promotion evidence", async () => {
    let now = START;
    const state = createReferenceState({ now: () => now });
    const chain = await advanceToRecovered(state, () => now, (next) => { now = next; });
    const manualInput = {
      requirement_id: chain.requirementId,
      manual_results: [{
        platform: "xhs",
        platform_account_id: "manual-creator-1",
        nickname: "before mutation",
        profile_url: "https://example.invalid/manual-creator-1",
      }],
    };
    const firstManual = await callSuccess(state, "manual_source_creators", manualInput);
    assert.equal(Object.hasOwn(firstManual.data, "promotion_event_ids"), false);
    manualInput.manual_results[0].nickname = "after mutation";

    const ranking = await callSuccess(state, "rank_creators", {
      mcn_recommendation_id: chain.mcnRecommendationId,
      manual_batch_ids: [firstManual.data.manual_batch_id],
    });
    assert.equal(ranking.data.ranked_count, 3);
    const firstDetail = await callSuccess(state, "get_recommendation_run_detail", {
      run_id: ranking.data.run_id,
    });
    const frozenDetail = structuredClone(firstDetail);
    firstDetail.data.recommendation_snapshot.ranked_count = 999;

    const secondManual = await callSuccess(state, "manual_source_creators", {
      requirement_id: chain.requirementId,
      manual_results: [
        {
          platform: "xhs",
          platform_account_id: "late-1",
          profile_url: "https://example.invalid/late-1",
        },
        {
          platform: "dy",
          platform_account_id: "late-2",
          profile_url: "https://example.invalid/late-2",
        },
      ],
    });
    assert.notEqual(secondManual.data.manual_batch_id, firstManual.data.manual_batch_id);

    const repeatedDetail = await callSuccess(state, "get_recommendation_run_detail", {
      run_id: ranking.data.run_id,
    });
    assert.deepEqual(repeatedDetail, frozenDetail);
    const batch = await callSuccess(state, "create_submission_batch", { run_id: ranking.data.run_id });
    assert.equal(batch.data.submitted_count, 3);

    const creator = await callSuccess(state, "get_creator_detail", {
      creator_id: "creator-0001",
      include_offers: true,
    });
    assert.equal(Object.hasOwn(creator.data, "offers"), false);
    assert.equal(JSON.stringify(state.snapshot()).includes(RAW_MESSAGES[0].content), false);
  });

  it("speaks JSON-RPC MCP 2024-11-05 over stdio and keeps simulation metadata outside business data", async (testContext) => {
    const child = spawn(process.execPath, [serverPath], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    testContext.after(() => child.kill("SIGTERM"));
    const lines = createInterface({ input: child.stdout });
    const responses = [];
    lines.on("line", (line) => responses.push(JSON.parse(line)));

    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
    const requirementArguments = validRequirement();
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "validate_requirement",
        arguments: requirementArguments,
      },
    })}\n`);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "validate_requirement",
        arguments: requirementArguments,
      },
    })}\n`);

    const deadline = Date.now() + 2_000;
    while (responses.length < 4 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(responses.length, 4);
    assert.equal(responses[0].result.protocolVersion, "2024-11-05");
    assert.equal(responses[1].result.tools.length, 15);
    assert.equal(responses[2].result._meta.simulated, true);
    assert.equal(responses[2].result._meta.productionEvidence, false);
    assert.equal(responses[2].result.structuredContent.success, true);
    assertNoSimulationMarker(responses[2].result.structuredContent.data);
    assert.deepEqual(responses[3].result.structuredContent, responses[2].result.structuredContent);
    assert.equal(responses[3].result._meta.simulated, true);

    child.stdin.end();
    await once(child, "exit");
  });
});
