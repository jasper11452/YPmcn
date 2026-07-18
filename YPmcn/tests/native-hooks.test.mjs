import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import plugin, { buildRequirementRuntimeClock, createYpmcnPlugin, YPMCN_FAST_PATH } from "../dist/index.js";

const tempDir = mkdtempSync(join(tmpdir(), "ypmcn-native-hooks-"));
const stateFile = join(tempDir, "state", "confirmation_guard.json");
const templateFile = join(tempDir, "skills", "media-assistant", "assets", "wecom_inquiry_template.txt");
const hooks = new Map();

const distributionParams = (overrides = {}) => ({
  projectName: "测试项目",
  deadline: "2099-07-17T18:00:00+08:00",
  columns: [{ field_key: "creator_name", field_name: "达人名称" }],
  supplierIds: ["supplier-1"],
  prefillRows: [],
  prefillRowsBySupplier: { "supplier-1": [] },
  ...overrides,
});

const requirementPayload = (overrides = {}) => ({
  status: "ready",
  platform: "xiaohongshu",
  quantityTotal: 10,
  submissionDeadlineAt: "2099-07-17 12:00:00",
  rawMessagesJson: {
    schemaVersion: "ypmcn-brief-v1",
    originalBrief: "小红书，10位达人，单达人L1预算5000元，2099年7月17日12点前",
    atoms: [
      { sourceText: "小红书", disposition: "mapped", targetField: "platform", confidence: 1, inferred: false },
      { sourceText: "10位达人", disposition: "mapped", targetField: "quantityTotal", confidence: 1, inferred: false },
      { sourceText: "单达人L1预算5000元", disposition: "mapped", targetField: "kolOfficialPriceL1", confidence: 1, inferred: false },
      { sourceText: "2099年7月17日12点前", disposition: "mapped", targetField: "submissionDeadlineAt", confidence: 1, inferred: false },
    ],
    coverageCheck: { atomCount: 4, mappedCount: 4, preservedCount: 0, unresolvedCount: 0 },
  },
  kolOfficialPriceL1: "[5000,5000]",
  ...overrides,
});

const supplyPlan = (overrides = {}) => ({
  demand_count: 10,
  database_candidate_count: 20,
  supply_demand_ratio: 2,
  target_submission_count: 20,
  estimated_valid_return_count: 18,
  estimated_gap_count: 2,
  recommended_mcn_count: 8,
  mcn_covered_creator_count: 18,
  recommended_manual_creator_count: 2,
  mcn_manual_creator_ratio: "18:2",
  ...overrides,
});

before(() => {
  mkdirSync(dirname(templateFile), { recursive: true });
  copyFileSync(fileURLToPath(new URL("../skills/media-assistant/assets/wecom_inquiry_template.txt", import.meta.url)), templateFile);
  plugin.register({
    rootDir: tempDir,
    logger: { error() {} },
    on(name, handler) { hooks.set(name, handler); },
  });
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function confirmationId(result) {
  return /confirmation_id=([0-9a-f-]{36})/i.exec(result.blockReason)?.[1];
}

async function requestConfirmation(params = distributionParams()) {
  await recordWorkflowState(params.projectName);
  const blocked = await hooks.get("before_tool_call")({
    toolName: "mcp__ypmcn__create_with_distributions",
    params,
    toolCallId: "call-send-1",
  }, {});
  assert.equal(blocked.block, true);
  assert.match(blocked.blockReason, /YP_CONFIRMATION_REQUIRED/);
  return { id: confirmationId(blocked), params };
}

async function answerConfirmation(id, answer = "确认发送") {
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  const summary = state.confirmations[id].safe_summary;
  const params = {
    questions: [{
      question: [
        `外发确认。[YP_CONFIRMATION:${id}]`,
        `project_name=${summary.project_name}`,
        `supplier_count=${summary.supplier_count}`,
        `deadline=${summary.deadline}`,
        `column_names=${JSON.stringify(summary.column_names)}`,
        `message_template_id=${summary.message_template_id}`,
        `message_template_sha256=${summary.message_template_sha256}`,
      ].join("；"),
      options: [{ label: "确认发送" }, { label: "需要修改" }],
    }],
  };
  assert.equal(await hooks.get("before_tool_call")({ toolName: "AskUserQuestion", params }, {}), undefined);
  await hooks.get("after_tool_call")({
    toolName: "AskUserQuestion",
    params,
    result: { status: "submitted", answers: [{ selected_labels: [answer] }] },
  }, {});
}

async function answerSupplyPlanConfirmation(id, answer = "确认供给方案") {
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  const plan = state.confirmations[id].safe_summary;
  const params = {
    questions: [{
      question: [
        `供给方案。[YP_SUPPLY_PLAN_CONFIRMATION:${id}]`,
        ...Object.entries(plan).map(([field, value]) => `${field}=${value}`),
      ].join("；"),
      options: [{ label: "确认供给方案" }, { label: "调整方案" }],
    }],
  };
  assert.equal(await hooks.get("before_tool_call")({ toolName: "AskUserQuestion", params }, {}), undefined);
  await hooks.get("after_tool_call")({
    toolName: "AskUserQuestion",
    params,
    result: { status: "submitted", answers: [{ selected_labels: [answer] }] },
  }, {});
}

async function recordSearch(requirementId, plan = supplyPlan(), shape = "nested") {
  const result = shape === "root"
    ? { success: true, ...plan, error: null }
    : shape === "data"
      ? { success: true, data: { ...plan }, error: null }
      : { success: true, data: { supply_plan: plan }, error: null };
  await hooks.get("after_tool_call")({
    toolName: "mcp__ypmcn__search_creators",
    params: { id: requirementId },
    result,
  }, {});
}

async function recordWorkflowState(projectName, allowedActions = ["create_with_distributions"]) {
  const params = { demand_id: `demand-${projectName}`, demand_version: 1 };
  assert.equal(await hooks.get("before_tool_call")({
    toolName: "mcp__ypmcn__get_workflow_state",
    params,
  }, {}), undefined);
  await hooks.get("after_tool_call")({
    toolName: "mcp__ypmcn__get_workflow_state",
    params,
    result: {
      success: true,
      data: { workflow_state: { project_name: projectName, allowed_actions: allowedActions } },
      error: null,
    },
  }, {});
}

describe("YP Action native hook guard", () => {
  it("registers tool hooks without relying on session lifecycle", () => {
    assert.deepEqual([...hooks.keys()].sort(), ["after_tool_call", "before_prompt_build", "before_tool_call", "session_end"]);
  });

  it("fails closed when the before-tool guard itself throws", async () => {
    const failingHooks = new Map();
    const errors = [];
    createYpmcnPlugin({
      beforeTool() { throw new Error("guard exploded"); },
    }).register({
      rootDir: tempDir,
      logger: { error(message) { errors.push(message); } },
      on(name, handler) { failingHooks.set(name, handler); },
    });
    const result = await failingHooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params: { payload: requirementPayload() },
    }, {});
    assert.deepEqual(result, {
      block: true,
      blockReason: "YPmcn guard unavailable: guard exploded",
    });
    assert.deepEqual(errors, ["before_tool_call guard failed: guard exploded"]);
  });

  it("injects the standard brief fast path before prompt construction", async () => {
    const result = await hooks.get("before_prompt_build")({ prompt: "小红书达人需求", messages: [] }, {});
    assert.equal(result.prependSystemContext, YPMCN_FAST_PATH);
    assert.match(result.prependContext, /YPmcn authoritative requirement clock/);
    assert.match(result.prependContext, /currentLocalDateTime: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    assert.match(result.prependContext, /timeZone: \S+/);
    assert.match(result.prependSystemContext, /first business call is validate_requirement/);
    assert.match(result.prependSystemContext, /50% becomes 0\.5/);
    assert.match(result.prependSystemContext, /"\[min,max\]"/);
    assert.match(result.prependSystemContext, /YYYY-MM-DD HH:mm:ss/);
    assert.match(result.prependSystemContext, /missing_required/);
    assert.match(result.prependSystemContext, /semantic_ambiguity/);
    assert.match(result.prependSystemContext, /Missing optional fields never block/);
    assert.match(result.prependSystemContext, /one valid kolOfficialPriceL1\/L2\/L3/);
    assert.match(result.prependSystemContext, /no concrete candidate value usable for that field/);
    assert.match(result.prependSystemContext, /bare clock time such as 15:00.*does not mean today/);
    assert.match(result.prependSystemContext, /一批\/some\/尽量多 without a number are missing quantity/);
    assert.match(result.prependSystemContext, /never short-circuits diagnostics/);
    assert.match(result.prependSystemContext, /one compact, self-contained question/);
    assert.match(result.prependSystemContext, /projectName, brandName, product, project total budget, and rebate are optional/);
    assert.match(result.prependSystemContext, /free-text constraint.*is not semantic ambiguity/);
    assert.match(result.prependSystemContext, /must not be moved only to rawMessagesJson to bypass ambiguity/);
    assert.match(result.prependSystemContext, /official price lacks an L1\/L2\/L3 tier/);
    assert.match(result.prependSystemContext, /__UNRESOLVED__/);
    assert.match(result.prependSystemContext, /schemaVersion="ypmcn-brief-v1"/);
    assert.match(result.prependSystemContext, /sourceText copied as an exact originalBrief substring/);
    assert.match(result.prependSystemContext, /coverageCheck uses atomCount, mappedCount, preservedCount, and unresolvedCount/);
    assert.match(result.prependSystemContext, /requirement_ready.*search_creators/);
    assert.match(result.prependSystemContext, /candidate_pool_ready.*rank_mcns/);
    assert.match(result.prependSystemContext, /supply_demand_ratio/);
    assert.match(result.prependSystemContext, /recommended_manual_creator_count=max/);
    assert.match(result.prependSystemContext, /Institution count and creator count must never be divided/);
    assert.match(result.prependSystemContext, /notification_template/);
    assert.match(result.prependSystemContext, /export_csv/);
    assert.match(result.prependSystemContext, /successful WeCom distribution plus completed recovery/);
    assert.match(result.prependSystemContext, /sync -> ingest_mcn_submissions.*-> sync/);
    assert.match(result.prependSystemContext, /create_submission_batch\(\{run_id\}\)/);
    assert.match(result.prependSystemContext, /Omit optional and null fields/);
    assert.match(result.prependSystemContext, /generic tool failure gets no automatic retry/);
    assert.match(result.prependSystemContext, /including timeout_seconds/);
    assert.match(result.prependSystemContext, /Do not read mcporter or another Skill/);
  });

  it("formats a deterministic local requirement clock", () => {
    const context = buildRequirementRuntimeClock(new Date("2026-07-17T06:30:45Z"), "Asia/Shanghai");
    assert.match(context, /currentLocalDateTime: 2026-07-17 14:30:45/);
    assert.match(context, /timeZone: Asia\/Shanghai/);
    assert.match(context, /明天\/tomorrow/);
  });

  it("keeps tool references aligned with fail-closed requirement and recovery gates", () => {
    const validateReference = readFileSync(new URL("../skills/media-assistant/references/tools/validate_requirement.md", import.meta.url), "utf8");
    const rankReference = readFileSync(new URL("../skills/media-assistant/references/tools/rank_creators.md", import.meta.url), "utf8");
    const intakeReference = readFileSync(new URL("../skills/media-assistant/references/requirement-intake.md", import.meta.url), "utf8");
    assert.doesNotMatch(validateReference, /待澄清才写 `draft`|待澄清项时才传 `status: "draft"`/);
    assert.match(validateReference, /不得传 `status: "draft"`/);
    assert.match(rankReference, /企微外发已成功/);
    assert.match(rankReference, /回收完成/);
    assert.doesNotMatch(rankReference, /不强制这些证据一定来自 MCN 回收/);
    assert.match(intakeReference, /省略 `demandVersion`/);
    assert.doesNotMatch(intakeReference, /将 `demandVersion` 递增后再调用/);
  });

  it("blocks a provider write attempted through shell", async () => {
    const result = await hooks.get("before_tool_call")({
      toolName: "Bash",
      params: { command: "curl -X POST https://api/create-with-distributions" },
      toolCallId: "call-1",
    }, {});
    assert.equal(result.block, true);
    assert.match(result.blockReason, /INTEGRATION_REQUIRED/);

    const powershell = await hooks.get("before_tool_call")({
      toolName: "PowerShell",
      params: { command: "Invoke-RestMethod -Method Post https://api/create-with-distributions" },
      toolCallId: "call-1b",
    }, {});
    assert.equal(powershell.block, true);
    assert.match(powershell.blockReason, /INTEGRATION_REQUIRED/);
  });

  it("allows read-only reference searches that mention a provider tool", async () => {
    const result = await hooks.get("before_tool_call")({
      toolName: "exec",
      params: { command: "grep -n create_with_distributions references/phase-tool-matrix.md" },
      toolCallId: "call-doc-search",
    }, {});
    assert.equal(result, undefined);
  });

  it("validates every declared MCP call without requiring sessionKey", async () => {
    const valid = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__search_creators",
      params: { id: "req-1" },
      toolCallId: "call-search",
    }, {});
    assert.equal(valid, undefined);

    const invalid = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__search_creators",
      params: {},
      toolCallId: "call-search-invalid",
    }, {});
    assert.equal(invalid.block, true);
    assert.match(invalid.blockReason, /INVALID_INPUT/);
  });

  it("blocks validate_requirement schema probes because the tool always writes", async () => {
    const blocked = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params: { payload: { projectName: "__SCHEMA_CHECK__", status: "draft" } },
      toolCallId: "call-schema-probe",
    }, {});
    assert.equal(blocked.block, true);
    assert.match(blocked.blockReason, /BLOCKED_NO_DRY_RUN/);
  });

  it("blocks missing required requirement fields", async () => {
    for (const field of [
      "platform",
      "quantityTotal",
      "submissionDeadlineAt",
      "rawMessagesJson",
    ]) {
      const payload = requirementPayload();
      delete payload[field];
      const blocked = await hooks.get("before_tool_call")({
        toolName: "mcp__ypmcn__validate_requirement",
        params: { payload },
        toolCallId: "call-incomplete-requirement",
      }, {});
      assert.equal(blocked.block, true);
      assert.match(blocked.blockReason, /BLOCKED_REQUIREMENT_INCOMPLETE/);
      assert.match(blocked.blockReason, new RegExp(field));
    }
  });

  it("blocks draft, serialized JSON, and unresolved placeholders", async () => {
    for (const payload of [
      requirementPayload({ status: "draft" }),
      requirementPayload({ rawMessagesJson: "{\"role\":\"client\"}" }),
      requirementPayload({ note: "__UNRESOLVED__" }),
    ]) {
      const blocked = await hooks.get("before_tool_call")({
        toolName: "mcp__ypmcn__validate_requirement",
        params: { payload },
        toolCallId: "call-ambiguous-requirement",
      }, {});
      assert.equal(blocked.block, true);
      assert.match(blocked.blockReason, /BLOCKED_REQUIREMENT_INCOMPLETE/);
    }
  });

  it("requires complete auditable brief atoms and matching zero-unresolved coverage", async () => {
    const validAudit = requirementPayload().rawMessagesJson;
    const invalidAudits = [
      { ...validAudit, schemaVersion: "legacy" },
      { ...validAudit, atoms: [{ ...validAudit.atoms[0], sourceText: "原文中不存在" }] },
      { ...validAudit, atoms: [{ ...validAudit.atoms[0], targetField: "inventedField" }], coverageCheck: { atomCount: 1, mappedCount: 1, preservedCount: 0, unresolvedCount: 0 } },
      { ...validAudit, atoms: [{ sourceText: "小红书", disposition: "preserved", confidence: 1, inferred: false }], coverageCheck: { atomCount: 1, mappedCount: 0, preservedCount: 1, unresolvedCount: 0 } },
      { ...validAudit, atoms: [{ sourceText: "小红书", preservedText: "抖音", disposition: "preserved", confidence: 1, inferred: false }], coverageCheck: { atomCount: 1, mappedCount: 0, preservedCount: 1, unresolvedCount: 0 } },
      { ...validAudit, coverageCheck: { ...validAudit.coverageCheck, unresolvedCount: 1 } },
    ];
    for (const rawMessagesJson of invalidAudits) {
      const blocked = await hooks.get("before_tool_call")({
        toolName: "mcp__ypmcn__validate_requirement",
        params: { payload: requirementPayload({ rawMessagesJson }) },
      }, {});
      assert.equal(blocked.block, true);
      assert.match(blocked.blockReason, /BLOCKED_REQUIREMENT_INCOMPLETE/);
    }
  });

  it("requires one canonical positive-upper-bound single-creator budget range", async () => {
    const missing = requirementPayload();
    delete missing.kolOfficialPriceL1;
    const blockedMissing = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params: { payload: missing },
      toolCallId: "call-missing-unit-budget",
    }, {});
    assert.equal(blockedMissing.block, true);
    assert.match(blockedMissing.blockReason, /kolOfficialPriceL1\/L2\/L3 is business-required/);

    const blockedInvalid = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params: { payload: requirementPayload({ kolOfficialPriceL1: "5000" }) },
      toolCallId: "call-invalid-unit-budget",
    }, {});
    assert.equal(blockedInvalid.block, true);
    assert.match(blockedInvalid.blockReason, /canonical non-negative range string/);

    for (const kolOfficialPriceL1 of ["[0,0]", "[5000,3000]", "[0, 5000]", [0, 5000]]) {
      const blockedRange = await hooks.get("before_tool_call")({
        toolName: "mcp__ypmcn__validate_requirement",
        params: { payload: requirementPayload({ kolOfficialPriceL1 }) },
      }, {});
      assert.equal(blockedRange.block, true);
      assert.match(blockedRange.blockReason, /range|positive upper bound/);
    }
  });

  it("validates all mapped range fields and unit-interval rates", async () => {
    const allowed = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params: { payload: requirementPayload({ followercount: "[10000,30000]", femaleRate: "[0,0.5]" }) },
    }, {});
    assert.equal(allowed, undefined);

    const blocked = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params: { payload: requirementPayload({ femaleRate: "[0,50]" }) },
    }, {});
    assert.equal(blocked.block, true);
    assert.match(blocked.blockReason, /between 0 and 1/);
  });

  it("keeps range serialization on customer_demands fields until backend mapping", async () => {
    for (const overrides of [
      { femaleRate: [0, 0.5] },
      { femaleRate: "0-0.5" },
      { femaleRate: "[0, 0.5]" },
      { femaleRateMin: 0, femaleRateMax: 0.5 },
    ]) {
      const blocked = await hooks.get("before_tool_call")({
        toolName: "mcp__ypmcn__validate_requirement",
        params: { payload: requirementPayload(overrides) },
      }, {});
      assert.equal(blocked.block, true);
      assert.match(blocked.blockReason, /canonical non-negative range string|real customer_demands field/);
    }
  });

  it("rejects invented, Provider-managed, and wrongly typed customer_demands fields", async () => {
    for (const payload of [
      requirementPayload({ businessIndustry: "美妆" }),
      requirementPayload({ id: "a".repeat(32) }),
      requirementPayload({ hasOrganization: true }),
      requirementPayload({ clickMedium: 1.5 }),
      requirementPayload({ contentFeatureLabel: "种草" }),
      requirementPayload({ projectStartStart: "2099/07/01" }),
    ]) {
      const blocked = await hooks.get("before_tool_call")({
        toolName: "mcp__ypmcn__validate_requirement",
        params: { payload },
      }, {});
      assert.equal(blocked.block, true);
      assert.match(blocked.blockReason, /BLOCKED_REQUIREMENT_INCOMPLETE/);
    }
  });

  it("requires a valid provider supply plan for the same requirement", async () => {
    const blocked = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__rank_mcns",
      params: { id: "req-without-provider-plan", platform: "xiaohongshu" },
    }, {});
    assert.equal(blocked.block, true);
    assert.match(blocked.blockReason, /INTEGRATION_REQUIRED.*successful search_creators/);
  });

  it("records only validated supply values and their fingerprint from supported response shapes", async () => {
    for (const shape of ["nested", "data", "root"]) {
      const requirementId = `req-plan-shape-${shape}`;
      await recordSearch(requirementId, supplyPlan(), shape);
      const persisted = JSON.parse(readFileSync(stateFile, "utf8"));
      const stored = persisted.supply_plans[requirementId];
      assert.deepEqual(Object.keys(stored).sort(), [...Object.keys(supplyPlan()), "fingerprint"].sort());
      assert.match(stored.fingerprint, /^[0-9a-f]{64}$/);
      const blocked = await hooks.get("before_tool_call")({
        toolName: "mcp__ypmcn__rank_mcns",
        params: { id: requirementId, platform: "xiaohongshu" },
      }, {});
      assert.match(blocked.blockReason, /YP_SUPPLY_PLAN_CONFIRMATION_REQUIRED/);
    }
  });

  it("rejects invalid provider formulas and invalidates an older plan for the requirement", async () => {
    const invalidPlans = [
      supplyPlan({ supply_demand_ratio: 999 }),
      supplyPlan({ estimated_gap_count: 3 }),
      supplyPlan({ recommended_manual_creator_count: 3, mcn_manual_creator_ratio: "18:3" }),
      supplyPlan({ mcn_manual_creator_ratio: "9:1" }),
    ];
    for (let index = 0; index < invalidPlans.length; index += 1) {
      const requirementId = `req-invalid-plan-${index}`;
      await recordSearch(requirementId);
      await recordSearch(requirementId, invalidPlans[index]);
      const blocked = await hooks.get("before_tool_call")({
        toolName: "mcp__ypmcn__rank_mcns",
        params: { id: requirementId, platform: "xiaohongshu" },
      }, {});
      assert.match(blocked.blockReason, /INTEGRATION_REQUIRED/);
    }
  });

  it("blocks a forged supply value or non-exact options before AskUserQuestion", async () => {
    const params = { id: "req-forged-plan-popup", platform: "xiaohongshu" };
    await recordSearch(params.id);
    const blocked = await hooks.get("before_tool_call")({ toolName: "mcp__ypmcn__rank_mcns", params }, {});
    const id = confirmationId(blocked);
    const plan = JSON.parse(readFileSync(stateFile, "utf8")).confirmations[id].safe_summary;
    const question = [
      `供给方案。[YP_SUPPLY_PLAN_CONFIRMATION:${id}]`,
      ...Object.entries({ ...plan, demand_count: 999 }).map(([field, value]) => `${field}=${value}`),
    ].join("；");
    const forged = await hooks.get("before_tool_call")({
      toolName: "AskUserQuestion",
      params: { questions: [{ question, options: [{ label: "确认供给方案" }, { label: "调整方案" }] }] },
    }, {});
    assert.equal(forged.block, true);
    assert.match(forged.blockReason, /BLOCKED_CONFIRMATION_MISMATCH/);

    const extraOption = await hooks.get("before_tool_call")({
      toolName: "AskUserQuestion",
      params: {
        questions: [{
          question: question.replace("demand_count=999", "demand_count=10"),
          options: [{ label: "确认供给方案" }, { label: "调整方案" }, { label: "稍后" }],
        }],
      },
    }, {});
    assert.equal(extraOption.block, true);
    assert.match(extraOption.blockReason, /BLOCKED_CONFIRMATION_MISMATCH/);
  });

  it("does not accept a supply confirmation that omits fixed calculation fields", async () => {
    const params = { id: "req-supply-incomplete", platform: "xiaohongshu" };
    await recordSearch(params.id);
    const blocked = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__rank_mcns", params, toolCallId: "call-rank-mcn-incomplete-1",
    }, {});
    const id = confirmationId(blocked);
    await hooks.get("after_tool_call")({
      toolName: "AskUserQuestion",
      params: {
        questions: [{
          question: `供需比 2:1。[YP_SUPPLY_PLAN_CONFIRMATION:${id}]`,
          options: [{ label: "确认供给方案" }, { label: "调整方案" }],
        }],
      },
      result: { status: "submitted", answers: [{ selected_labels: ["确认供给方案"] }] },
    }, {});
    const retried = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__rank_mcns", params, toolCallId: "call-rank-mcn-incomplete-2",
    }, {});
    assert.equal(retried.block, true);
    assert.match(retried.blockReason, /YP_SUPPLY_PLAN_CONFIRMATION_REQUIRED/);
  });

  it("allows a ready requirement without optional project or industry fields", async () => {
    assert.equal(await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params: { payload: requirementPayload() },
      toolCallId: "call-ready-requirement",
    }, {}), undefined);
  });

  it("requires a popup supply-plan confirmation before rank_mcns", async () => {
    const params = { id: "req-supply-1", platform: "xiaohongshu" };
    await recordSearch(params.id);
    const blocked = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__rank_mcns", params, toolCallId: "call-rank-mcn-1",
    }, {});
    assert.equal(blocked.block, true);
    assert.match(blocked.blockReason, /YP_SUPPLY_PLAN_CONFIRMATION_REQUIRED/);
    assert.match(blocked.blockReason, /supply_demand_ratio/);
    const id = confirmationId(blocked);
    await answerSupplyPlanConfirmation(id);
    assert.equal(await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__rank_mcns", params, toolCallId: "call-rank-mcn-2",
    }, {}), undefined);
    await hooks.get("after_tool_call")({
      toolName: "mcp__ypmcn__rank_mcns", params, toolCallId: "call-rank-mcn-2",
      result: { success: true, data: { mcn_run_id: "mcn-run-1" }, error: null },
    }, {});
    const replay = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__rank_mcns", params, toolCallId: "call-rank-mcn-3",
    }, {});
    assert.match(replay.blockReason, /YP_SUPPLY_PLAN_CONFIRMATION_REQUIRED/);
  });

  it("invalidates supply-plan confirmation when rank parameters change", async () => {
    const params = { id: "req-supply-change", platform: "xiaohongshu", minimum_mcn_count: 8 };
    await recordSearch(params.id);
    const blocked = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__rank_mcns", params, toolCallId: "call-rank-change-1",
    }, {});
    await answerSupplyPlanConfirmation(confirmationId(blocked));
    const changed = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__rank_mcns",
      params: { ...params, minimum_mcn_count: 10 },
      toolCallId: "call-rank-change-2",
    }, {});
    assert.match(changed.blockReason, /YP_SUPPLY_PLAN_CONFIRMATION_REQUIRED/);
  });

  it("requires a self-contained Ask confirmation and allows one unchanged send", async () => {
    const { id, params } = await requestConfirmation();
    assert.ok(id);
    await answerConfirmation(id);

    const allowed = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__create_with_distributions",
      params,
      toolCallId: "call-send-2",
    }, {});
    assert.equal(allowed, undefined);

    await hooks.get("after_tool_call")({
      toolName: "mcp__ypmcn__create_with_distributions",
      params,
      toolCallId: "call-send-2",
      result: { success: true, data: { project_id: "project-1" }, error: null },
    }, {});

    const replay = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__create_with_distributions",
      params,
      toolCallId: "call-send-3",
    }, {});
    assert.equal(replay.block, true);
    assert.match(replay.blockReason, /WORKFLOW_STATE_REFRESH_REQUIRED/);
  });

  it("requires a fresh authoritative workflow state for the same project before external send", async () => {
    const params = distributionParams({ projectName: "状态门禁项目" });
    const missing = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__create_with_distributions", params, toolCallId: "call-state-missing",
    }, {});
    assert.equal(missing.block, true);
    assert.match(missing.blockReason, /WORKFLOW_STATE_REFRESH_REQUIRED/);

    await recordWorkflowState(params.projectName, ["rank_creators"]);
    const disallowed = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__create_with_distributions", params, toolCallId: "call-state-disallowed",
    }, {});
    assert.equal(disallowed.block, true);
    assert.match(disallowed.blockReason, /BLOCKED_WORKFLOW_ACTION/);

    await recordWorkflowState("另一个项目");
    const mismatch = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__create_with_distributions", params, toolCallId: "call-state-mismatch",
    }, {});
    assert.equal(mismatch.block, true);
    assert.match(mismatch.blockReason, /WORKFLOW_STATE_REFRESH_REQUIRED/);
  });

  it("blocks forged external summary values and non-exact send options before AskUserQuestion", async () => {
    const { id } = await requestConfirmation(distributionParams({ projectName: "真实外发项目" }));
    const summary = JSON.parse(readFileSync(stateFile, "utf8")).confirmations[id].safe_summary;
    const question = [
      `外发确认。[YP_CONFIRMATION:${id}]`,
      "project_name=伪造项目",
      `supplier_count=${summary.supplier_count}`,
      `deadline=${summary.deadline}`,
      `column_names=${JSON.stringify(summary.column_names)}`,
      `message_template_id=${summary.message_template_id}`,
      `message_template_sha256=${summary.message_template_sha256}`,
    ].join("；");
    const forged = await hooks.get("before_tool_call")({
      toolName: "AskUserQuestion",
      params: { questions: [{ question, options: [{ label: "确认发送" }, { label: "需要修改" }] }] },
    }, {});
    assert.equal(forged.block, true);
    assert.match(forged.blockReason, /BLOCKED_CONFIRMATION_MISMATCH/);

    const extraOption = await hooks.get("before_tool_call")({
      toolName: "AskUserQuestion",
      params: {
        questions: [{
          question: question.replace("project_name=伪造项目", "project_name=真实外发项目"),
          options: [{ label: "确认发送" }, { label: "需要修改" }, { label: "取消" }],
        }],
      },
    }, {});
    assert.equal(extraOption.block, true);
    assert.match(extraOption.blockReason, /BLOCKED_CONFIRMATION_MISMATCH/);
  });

  it("invalidates confirmation when request parameters change", async () => {
    const { id, params } = await requestConfirmation(distributionParams({ projectName: "变更测试" }));
    await answerConfirmation(id);
    const changed = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__create_with_distributions",
      params: {
        ...params,
        supplierIds: ["supplier-1", "supplier-2"],
        prefillRowsBySupplier: { "supplier-1": [], "supplier-2": [] },
      },
      toolCallId: "call-changed",
    }, {});
    assert.equal(changed.block, true);
    assert.match(changed.blockReason, /YP_CONFIRMATION_REQUIRED/);
  });

  it("does not authorize modification, rejection, or timeout answers", async () => {
    for (const answer of ["需要修改", "自定义：只发另一家"]) {
      const params = distributionParams({ projectName: `拒绝-${answer}` });
      const { id } = await requestConfirmation(params);
      await answerConfirmation(id, answer);
      const result = await hooks.get("before_tool_call")({
        toolName: "mcp__ypmcn__create_with_distributions",
        params,
        toolCallId: `call-${answer}`,
      }, {});
      assert.equal(result.block, true);
      assert.match(result.blockReason, /YP_CONFIRMATION_REQUIRED/);
    }
  });

  it("does not authorize when an echoed question contains both option labels", async () => {
    const params = distributionParams({ projectName: "回显选项测试" });
    const { id } = await requestConfirmation(params);
    await hooks.get("after_tool_call")({
      toolName: "AskUserQuestion",
      params: { question: `[YP_CONFIRMATION:${id}]`, options: ["确认发送", "需要修改"] },
      result: { status: "submitted", question: "确认发送 / 需要修改", answers: [] },
    }, {});
    const blocked = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__create_with_distributions", params, toolCallId: "call-echoed",
    }, {});
    assert.match(blocked.blockReason, /YP_CONFIRMATION_REQUIRED/);
  });

  it("binds external distribution to confirmed columns and every supplier", async () => {
    for (const params of [
      distributionParams({ columns: [] }),
      distributionParams({ prefillRowsBySupplier: {} }),
    ]) {
      const blocked = await hooks.get("before_tool_call")({
        toolName: "mcp__ypmcn__create_with_distributions",
        params,
        toolCallId: "call-invalid-field-binding",
      }, {});
      assert.equal(blocked.block, true);
      assert.match(blocked.blockReason, /BLOCKED_EMPTY_COLUMNS|BLOCKED_INVALID_PREFILL_BINDING/);
    }
  });

  it("requires an explicit timezone on the external deadline", async () => {
    const blocked = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__create_with_distributions",
      params: distributionParams({ deadline: "2030-01-01T12:00:00" }),
      toolCallId: "call-no-timezone",
    }, {});
    assert.match(blocked.blockReason, /BLOCKED_INVALID_DEADLINE/);
  });

  it("blocks blind retry after an unknown send outcome", async () => {
    const params = distributionParams({ projectName: "未知结果测试" });
    const { id } = await requestConfirmation(params);
    await answerConfirmation(id);
    assert.equal(await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__create_with_distributions", params, toolCallId: "call-unknown-1",
    }, {}), undefined);
    await hooks.get("after_tool_call")({
      toolName: "mcp__ypmcn__create_with_distributions",
      params,
      toolCallId: "call-unknown-1",
      error: new Error("connection lost"),
    }, {});
    const retry = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__create_with_distributions", params, toolCallId: "call-unknown-2",
    }, {});
    assert.equal(retry.block, true);
    assert.match(retry.blockReason, /WRITE_RESULT_UNKNOWN.*get_workflow_state/);
  });

  it("stores only confirmation metadata and safe summaries", async () => {
    const secret = "不能写入状态文件的消息正文";
    await requestConfirmation(distributionParams({ description: secret }));
    const persisted = readFileSync(stateFile, "utf8");
    assert.doesNotMatch(persisted, new RegExp(secret));
    assert.match(persisted, /request_fingerprint/);
    assert.match(persisted, /supplier_count/);
  });

  it("treats session_end as optional TTL cleanup", async () => {
    await hooks.get("session_end")({}, {});
    assert.doesNotThrow(() => JSON.parse(readFileSync(stateFile, "utf8")));
  });
});
