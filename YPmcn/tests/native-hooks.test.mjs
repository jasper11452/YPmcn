import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";

import plugin, { buildRequirementRuntimeClock, createYpmcnPlugin, YPMCN_FAST_PATH } from "../dist/index.js";

const tempDir = mkdtempSync(join(tmpdir(), "ypmcn-native-hooks-"));
const stateFile = join(tempDir, "state", "confirmation_guard.json");
const templateFile = join(tempDir, "skills", "media-assistant", "assets", "wecom_inquiry_template.txt");
const hooks = new Map();
const UNRESOLVED_BRIEF = "品牌：阿里巴巴；项目：千问61儿童节；平台：小红书；档期：2026-07-30至2026-07-31；价格：4w以下；返点：30%以上；内容：类似于AI帮忙送儿童节礼物；账号类型：母婴类，亲子相关；数量：5个；提报截止：2026-07-20 11:00。";

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

const requirementQuestion = (_confirmed, pending) => `${pending}？`;

const requirementOption = (label, description = "选择后按此信息继续") => ({ label, description });

const supplyPlanQuestion = (id, plan) => {
  const manualTotal = plan.mcn_covered_creator_count + plan.recommended_manual_creator_count;
  const manualShare = manualTotal === 0 ? 0 : Number((plan.recommended_manual_creator_count / manualTotal * 100).toFixed(2));
  return [
    `【真实数据】需求人数=${plan.demand_count}｜候选达人=${plan.database_candidate_count}｜供给倍数=${plan.supply_demand_ratio}`,
    `【推荐方案】目标提报=${plan.target_submission_count}｜预计有效=${plan.estimated_valid_return_count}｜预计缺口=${plan.estimated_gap_count}｜推荐MCN=${plan.recommended_mcn_count}｜MCN覆盖达人=${plan.mcn_covered_creator_count}｜人工补充=${plan.recommended_manual_creator_count}｜MCN人工比例=${plan.mcn_manual_creator_ratio}｜建议手扒占比=${manualShare}%`,
    `【影响】确认后锁定供给方案并继续外发准备${id ? `｜[YP_SUPPLY_PLAN_CONFIRMATION:${id}]` : ""}`,
  ].join("\n");
};

before(() => {
  mkdirSync(dirname(templateFile), { recursive: true });
  copyFileSync(fileURLToPath(new URL("../skills/media-assistant/assets/wecom_inquiry_template.txt", import.meta.url)), templateFile);
  plugin.register({
    rootDir: tempDir,
    logger: { error() {} },
    on(name, handler) { hooks.set(name, handler); },
  });
});

beforeEach(async () => {
  await hooks.get("before_prompt_build")({ prompt: "test turn", messages: [] }, {});
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function confirmationId(result) {
  return /confirmation_id=([0-9a-f-]{36})/i.exec(result.blockReason)?.[1];
}

function pendingSupplyConfirmationId(requirementId) {
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  const entry = Object.entries(state.confirmations).find(([, receipt]) =>
    receipt.kind === "supply_plan" && receipt.requirement_id === requirementId && receipt.status === "pending"
  );
  assert.ok(entry, `expected pending supply confirmation for ${requirementId}`);
  return entry[0];
}

function clearSupplyConfirmations() {
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  for (const [id, receipt] of Object.entries(state.confirmations)) {
    if (receipt.kind === "supply_plan") delete state.confirmations[id];
  }
  delete state.latest_supply_plan_confirmation_id;
  writeFileSync(stateFile, JSON.stringify(state), "utf8");
}

async function requestConfirmation(params = distributionParams()) {
  const requirementId = `req-send-${createHash("sha256").update(params.projectName).digest("hex").slice(0, 12)}`;
  await recordWorkflowState(params.projectName, ["search_creators", "create_with_distributions"], requirementId);
  await recordSearch(requirementId);
  await recordSuccessfulRank({ id: requirementId, platform: "xiaohongshu" }, requirementId);
  const supplyConfirmationId = pendingSupplyConfirmationId(requirementId);
  await answerSupplyPlanConfirmation(supplyConfirmationId);
  await hooks.get("after_tool_call")({
    toolName: "mcp__ypmcn__select_inquiry_form_fields",
    params: {},
    result: { success: true, data: { description: "creator_name：达人名称" }, error: null },
  }, {});
  await recordWorkflowState(params.projectName, ["create_with_distributions"], requirementId);
  const blocked = await hooks.get("before_tool_call")({
    toolName: "mcp__ypmcn__create_with_distributions",
    params,
    toolCallId: "call-send-1",
  }, {});
  assert.equal(blocked.block, true);
  assert.match(blocked.blockReason, /YP_CONFIRMATION_REQUIRED/);
  return { id: confirmationId(blocked), params };
}

async function answerConfirmation(id, answer = "确认发送", flattened = false) {
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  const summary = state.confirmations[id].safe_summary;
  const params = {
    questions: [{
      question: [
        `【外发对象】项目名=${summary.project_name}｜机构数=${summary.supplier_count}`,
        `【外发内容】截止时间=${summary.deadline}｜表单字段=${JSON.stringify(summary.column_names)}`,
        `【固定模板】消息模板=${summary.message_template_id}`,
        `【影响】确认后真实企微外发｜[YP_CONFIRMATION:${id}]`,
      ].join("\n"),
      options: [{ label: "确认发送" }, { label: "需要修改" }],
    }],
  };
  assert.equal(await hooks.get("before_tool_call")({ toolName: "AskUserQuestion", params }, {}), undefined);
  await hooks.get("after_tool_call")({
    toolName: "AskUserQuestion",
    params,
    result: flattened
      ? `${params.questions[0].question}: ${answer}`
      : { status: "submitted", answers: [{ selected_labels: [answer] }] },
  }, {});
}

async function answerSupplyPlanConfirmation(id, answer = "确认供给方案", flattened = false) {
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  const plan = state.confirmations[id].safe_summary;
  const params = {
    questions: [{
      question: supplyPlanQuestion(id, plan),
      options: [{ label: "确认供给方案" }, { label: "调整方案" }],
    }],
  };
  assert.equal(await hooks.get("before_tool_call")({ toolName: "AskUserQuestion", params }, {}), undefined);
  await hooks.get("after_tool_call")({
    toolName: "AskUserQuestion",
    params,
    result: flattened
      ? `${params.questions[0].question}: ${answer}`
      : { status: "submitted", answers: [{ selected_labels: [answer] }] },
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

async function recordSuccessfulRank(params, suffix) {
  const toolCallId = `call-rank-${suffix}`;
  assert.equal(await hooks.get("before_tool_call")({
    toolName: "mcp__ypmcn__rank_mcns",
    params,
    toolCallId,
  }, {}), undefined);
  await hooks.get("after_tool_call")({
    toolName: "mcp__ypmcn__rank_mcns",
    params,
    toolCallId,
    result: {
      success: true,
      data: {
        mcn_run_id: `mcn-run-${suffix}`,
        suppliers: [{ supplier_id: "supplier-1" }, { supplier_id: "supplier-2" }],
      },
      error: null,
    },
  }, {});
}

async function recordWorkflowState(
  projectName,
  allowedActions = ["create_with_distributions"],
  requirementId,
  demandId = `demand-${projectName}`,
) {
  const params = { demand_id: demandId, demand_version: 1 };
  assert.equal(await hooks.get("before_tool_call")({
    toolName: "mcp__ypmcn__get_workflow_state",
    params,
  }, {}), undefined);
  await hooks.get("after_tool_call")({
    toolName: "mcp__ypmcn__get_workflow_state",
    params,
    result: {
      success: true,
      data: {
        workflow_state: {
          project_name: projectName,
          allowed_actions: allowedActions,
          ...(requirementId ? { requirement_id: requirementId } : {}),
        },
      },
      error: null,
    },
  }, {});
}

describe("YP Action native hook guard", () => {
  it("registers tool hooks without relying on session lifecycle", () => {
    assert.deepEqual([...hooks.keys()].sort(), ["after_tool_call", "before_agent_reply", "before_prompt_build", "before_tool_call", "session_end"]);
  });

  it("isolates guard state by host session key", async () => {
    const firstSession = { sessionKey: "session-one" };
    const secondSession = { sessionKey: "session-two" };
    await hooks.get("before_prompt_build")({ prompt: UNRESOLVED_BRIEF, messages: [] }, firstSession);

    const blocked = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params: { payload: requirementPayload() },
    }, firstSession);
    assert.match(blocked.blockReason, /BLOCKED_REQUIREMENT_CLARIFICATION_REQUIRED/);

    assert.equal(await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params: { payload: requirementPayload() },
    }, secondSession), undefined);

    const statePath = (key) => join(
      tempDir,
      "state",
      "sessions",
      createHash("sha256").update(key).digest("hex").slice(0, 24),
      "confirmation_guard.json",
    );
    assert.equal(JSON.parse(readFileSync(statePath("session-one"), "utf8")).prompt_requirement_gate.status, "pending");
    assert.equal(existsSync(statePath("session-two")), false);
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
    const result = await hooks.get("before_prompt_build")({ prompt: UNRESOLVED_BRIEF, messages: [] }, {});
    assert.equal(result.prependSystemContext, YPMCN_FAST_PATH);
    assert.match(result.prependContext, /YPmcn authoritative requirement clock/);
    assert.match(result.prependContext, /currentLocalDateTime: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    assert.match(result.prependContext, /timeZone: \S+/);
    assert.match(result.prependSystemContext, /first business call is validate_requirement/);
    assert.match(result.prependSystemContext, /50% becomes 0\.5/);
    assert.match(result.prependSystemContext, /quantityTotal is always a JSON integer/);
    assert.match(result.prependSystemContext, /数量5 or 5位达人 => quantityTotal=5, never "\[5,5\]"/);
    assert.match(result.prependSystemContext, /返点30%以上 must produce payload\.rebate="\[0\.3,1\]"/);
    assert.match(result.prependSystemContext, /disposition="mapped", targetField="rebate"/);
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
    assert.match(result.prependSystemContext, /Preview atom details, gate, and summary must be rendered from one in-memory atom list/);
    assert.match(result.prependSystemContext, /unresolvedCount counts missing_required plus semantic_ambiguity rows/);
    assert.match(result.prependSystemContext, /never claim mapped=N\/unresolved=0/);
    assert.match(result.prependSystemContext, /details\.deniedReason="plugin-before-tool-call" is a local Hook denial/);
    assert.match(result.prependSystemContext, /request did not reach MCP\/Provider/);
    assert.match(result.prependSystemContext, /Attribute a rejection to MCP\/Provider only when the result contains actual remote MCP response evidence/);
    assert.match(result.prependSystemContext, /one compact, self-contained question/);
    assert.match(result.prependSystemContext, /projectName, brandName, product, project total budget, and rebate are optional/);
    assert.match(result.prependSystemContext, /free-text constraint.*is not semantic ambiguity/);
    assert.match(result.prependSystemContext, /must not be moved only to rawMessagesJson to bypass ambiguity/);
    assert.match(result.prependSystemContext, /official price lacks an L1\/L2\/L3 tier/);
    assert.match(result.prependSystemContext, /__UNRESOLVED__/);
    assert.match(result.prependSystemContext, /schemaVersion="ypmcn-brief-v1"/);
    assert.match(result.prependSystemContext, /explicit supplemental Ask answer/);
    assert.match(result.prependSystemContext, /coverageCheck uses atomCount, mappedCount, preservedCount, and unresolvedCount/);
    assert.match(result.prependSystemContext, /requirement_ready.*search_creators/);
    assert.match(result.prependSystemContext, /candidate_pool_ready.*rank_mcns/);
    assert.match(result.prependSystemContext, /immediately call rank_mcns.*do not insert AskUserQuestion/);
    assert.match(result.prependSystemContext, /If search_creators or rank_mcns fails.*native AskUserQuestion/);
    assert.match(result.prependSystemContext, /notification_template/);
    assert.match(result.prependSystemContext, /export_csv/);
    assert.match(result.prependSystemContext, /successful WeCom distribution plus completed recovery/);
    assert.match(result.prependSystemContext, /sync -> ingest_mcn_submissions.*-> sync/);
    assert.match(result.prependSystemContext, /create_submission_batch\(\{run_id\}\)/);
    assert.match(result.prependSystemContext, /Omit optional and null fields/);
    assert.match(result.prependSystemContext, /generic tool failure.*details\.status="blocked".*gets no automatic retry/);
    assert.match(result.prependSystemContext, /INVALID_INPUT\/INTEGRATION_REQUIRED/);
    assert.match(result.prependSystemContext, /reinterpret one identifier as another lookup mode/);
    assert.match(result.prependSystemContext, /including timeout_seconds/);
    assert.match(result.prependSystemContext, /Never end a recoverable failure with a plain “blocked” paragraph/);
    assert.match(result.prependSystemContext, /title it “服务异常”/);
    assert.match(result.prependSystemContext, /“查询状态” and “停止”/);
    assert.match(result.prependSystemContext, /never ask the user to type “继续”/);
    assert.match(result.prependSystemContext, /Do not read mcporter or another Skill/);
  });

  it("accepts complete requirement clarification answers from native host result shapes", async () => {
    const questions = ["平台", "数量", "预算"].map((field) => ({
      header: `${field}选择`,
      question: requirementQuestion("其他信息无误", `${field}采用哪个选项`),
      multiSelect: false,
      options: field === "预算"
        ? ["项目总预算", "单人图文", "单人视频", "单人长视频"].map((label) => requirementOption(label))
        : [requirementOption(`${field}选项A`), requirementOption(`${field}选项B`)],
    }));
    const answerArray = questions.map((question) => ({ selected_labels: [question.options[0].label] }));
    const answerMap = Object.fromEntries(questions.map((question) => [question.question, question.options[0].label]));
    const resultShapes = [
      { status: "submitted", answers: answerArray },
      {
        status: "submitted",
        answers: questions.map((question, index) => index === 2
          ? { answer: "用户输入的自定义预算" }
          : { selected_labels: [question.options[0].label] }),
      },
      { status: "submitted", answers: answerMap },
      { result: { status: "submitted", answers: answerMap } },
      { structuredContent: { status: "submitted", answers: answerMap } },
      { content: [{ text: JSON.stringify({ status: "submitted", answers: answerMap }) }] },
      questions.map((question) => `${question.question}: ${question.options[0].label}`).join("\n"),
    ];

    for (const result of resultShapes) {
      await hooks.get("before_prompt_build")({ prompt: UNRESOLVED_BRIEF, messages: [] }, {});
      const params = { questions };
      assert.equal(await hooks.get("before_tool_call")({ toolName: "AskUserQuestion", params }, {}), undefined);
      await hooks.get("after_tool_call")({ toolName: "AskUserQuestion", params, result }, {});
      assert.equal(await hooks.get("before_tool_call")({
        toolName: "mcp__ypmcn__validate_requirement",
        params: { payload: requirementPayload() },
      }, {}), undefined);
    }
  });

  it("keeps an incomplete clarification pending with a repeatable recovery path", async () => {
    await hooks.get("before_prompt_build")({ prompt: UNRESOLVED_BRIEF, messages: [] }, {});
    const params = {
      questions: [{
        header: "达人数量",
        question: requirementQuestion("推广平台为小红书", "需要5位还是10位达人"),
        multiSelect: false,
        options: [requirementOption("5位达人"), requirementOption("10位达人")],
      }],
    };
    assert.equal(await hooks.get("before_tool_call")({ toolName: "AskUserQuestion", params }, {}), undefined);
    await hooks.get("after_tool_call")({
      toolName: "AskUserQuestion",
      params,
      result: { status: "submitted", answers: {} },
    }, {});
    const blocked = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params: { payload: requirementPayload() },
    }, {});
    assert.match(blocked.blockReason, /BLOCKED_REQUIREMENT_CLARIFICATION_REQUIRED/);
    assert.equal(await hooks.get("before_tool_call")({ toolName: "AskUserQuestion", params }, {}), undefined);
  });

  it("keeps business writes blocked after denied native clarification", async () => {
    await hooks.get("before_prompt_build")({ prompt: UNRESOLVED_BRIEF, messages: [] }, {});
    const params = {
      questions: [{
        header: "报价口径",
        question: requirementQuestion("平台和人数无误", "4万元是单达人报价吗"),
        multiSelect: false,
        options: [requirementOption("是单达人报价"), requirementOption("是项目总预算")],
      }],
    };
    assert.equal(await hooks.get("before_tool_call")({ toolName: "AskUserQuestion", params }, {}), undefined);
    await hooks.get("after_tool_call")({
      toolName: "AskUserQuestion",
      params,
      result: "User denied the operation.",
    }, {});
    const next = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params: { payload: requirementPayload() },
    }, {});
    assert.match(next?.blockReason ?? "", /BLOCKED_REQUIREMENT_CLARIFICATION_CANCELLED/);
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.prompt_requirement_gate.status, "cancelled");
  });

  it("rejects a dense one-paragraph requirement popup", async () => {
    await hooks.get("before_prompt_build")({ prompt: UNRESOLVED_BRIEF, messages: [] }, {});
    const blocked = await hooks.get("before_tool_call")({
      toolName: "AskUserQuestion",
      params: {
        questions: [{
          header: "需求确认",
          question: "已确认: brandName=悦普测试, product=YP Action, platform=xiaohongshu, projectStartStart=2026-07-30 00:00:00, projectStartEnd=2026-07-31 23:59:59。需确认: quantityTotal=1、submissionDeadlineAt=2026-07-20 18:00:00、creatorPriceTier=L1 [0,40000]。影响: 当前 gate=missing_required，三项全部确认前不得调用任何 Tool。",
          options: [{ label: "三项全部确认" }, { label: "需要修改" }],
        }],
      },
    }, {});
    assert.match(blocked.blockReason, /BLOCKED_REQUIREMENT_CONFIRMATION_MISMATCH/);
    assert.match(blocked.blockReason, /1-5 concise single-choice questions/);
  });

  it("rejects a source-formatted requirement popup that still becomes too long when host whitespace collapses", async () => {
    await hooks.get("before_prompt_build")({ prompt: UNRESOLVED_BRIEF, messages: [] }, {});
    const blocked = await hooks.get("before_tool_call")({
      toolName: "AskUserQuestion",
      params: {
        questions: [{
          header: "需求确认",
          question: [
            "【已确认】品牌=悦普测试、产品=YP Action、平台=xiaohongshu、档期=2026-07-30 00:00:00至2026-07-31 23:59:59、提报截止=2026-07-20 18:00:00、L1报价=[0,40000]",
            "【需确认】达人数量=1、提报截止时间、官方报价层级",
            "【影响】三项全部确认前不得调用任何业务工具，确认后才继续校验需求并写入数据库",
          ].join("\n"),
          options: [{ label: "三项全部确认" }, { label: "需要修改" }],
        }],
      },
    }, {});
    assert.match(blocked.blockReason, /BLOCKED_REQUIREMENT_CONFIRMATION_MISMATCH/);
    assert.match(blocked.blockReason, /1-5 concise single-choice questions/);
  });

  it("rejects a multiline clarification question", async () => {
    await hooks.get("before_prompt_build")({ prompt: UNRESOLVED_BRIEF, messages: [] }, {});
    const blocked = await hooks.get("before_tool_call")({
      toolName: "AskUserQuestion",
      params: {
        questions: [{
          header: "截止时间",
          question: "已确认：quantityTotal=1\n请确认：submissionDeadlineAt 是否正确？",
          multiSelect: false,
          options: [{ label: "按此截止" }, { label: "修改时间" }],
        }],
      },
    }, {});
    assert.match(blocked.blockReason, /BLOCKED_REQUIREMENT_CONFIRMATION_MISMATCH/);
    assert.match(blocked.blockReason, /1-5 concise single-choice questions/);
  });

  it("does not relabel a host-wrapped local Hook denial as an MCP backend failure", async () => {
    await hooks.get("before_prompt_build")({ prompt: UNRESOLVED_BRIEF, messages: [] }, {});
    const params = { payload: requirementPayload() };
    const blocked = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params,
    }, {});
    assert.match(blocked.blockReason, /BLOCKED_REQUIREMENT_CLARIFICATION_REQUIRED/);

    await hooks.get("after_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params,
      error: blocked.blockReason,
      result: {
        status: "error",
        tool: "ypmcn-mcp__validate_requirement",
        error: blocked.blockReason,
      },
    }, {});

    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.prompt_requirement_gate.status, "pending");
  });

  it("formats a deterministic local requirement clock", () => {
    const context = buildRequirementRuntimeClock(new Date("2026-07-17T06:30:45Z"), "Asia/Shanghai");
    assert.match(context, /currentLocalDateTime: 2026-07-17 14:30:45/);
    assert.match(context, /timeZone: Asia\/Shanghai/);
    assert.match(context, /明天\/tomorrow/);
  });

  it("keeps tool references aligned with fail-closed requirement and recovery gates", () => {
    const executionReference = readFileSync(new URL("../skills/media-assistant/references/execution-gates.md", import.meta.url), "utf8");
    const intakeReference = readFileSync(new URL("../skills/media-assistant/references/requirement-intake.md", import.meta.url), "utf8");
    assert.match(intakeReference, /不得传 `draft`/);
    assert.match(executionReference, /真实外发/);
    assert.match(executionReference, /全部回收/);
    assert.match(intakeReference, /省略 `id\/demandVersion`/);
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
      params: { command: "grep -n create_with_distributions references/execution-gates.md" },
      toolCallId: "call-doc-search",
    }, {});
    assert.equal(result, undefined);
  });

  it("validates every declared MCP call without requiring sessionKey", async () => {
    await hooks.get("after_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params: { payload: requirementPayload() },
      result: { success: true, data: { id: "req-1" }, error: null },
    }, {});
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

  it("keeps sanitized validate_requirement provenance across the next prompt turn", async () => {
    const requirementId = "7d632c900dc74f36aa538a5c8a44eedd";
    const structuredContent = {
      success: true,
      data: { id: requirementId },
      workflow_state: { phase: "requirement_ready" },
      allowed_actions: ["search_creators"],
      error: null,
    };

    await hooks.get("after_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params: { payload: requirementPayload() },
      result: {
        content: [{
          type: "text",
          text: "Requirement validated successfully.",
        }],
        details: {
          mcpServer: "ypmcn",
          mcpTool: "validate_requirement",
          structuredContent,
        },
      },
    }, {});

    const persisted = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(persisted.latest_requirement_id.value, requirementId);

    await hooks.get("before_prompt_build")({ prompt: "继续", messages: [] }, {});
    const allowed = await hooks.get("before_tool_call")({
      toolName: "ypmcn-mcp__search_creators",
      params: { id: requirementId },
      toolCallId: "call-search-provenance-sanitized",
    }, {});
    assert.equal(allowed, undefined);
  });

  it("records validate_requirement provenance from a later JSON content block", async () => {
    const requirementId = "multi-block-requirement-id";
    const scope = { sessionKey: "multi-block-result-session" };
    await hooks.get("after_tool_call")({
      toolName: "ypmcn-mcp__validate_requirement",
      params: { payload: requirementPayload() },
      result: {
        content: [
          { type: "text", text: "Requirement validated successfully." },
          {
            type: "text",
            text: `\`\`\`json\n${JSON.stringify({ success: true, data: { id: requirementId }, error: null })}\n\`\`\``,
          },
        ],
        details: { mcpServer: "ypmcn-mcp", mcpTool: "validate_requirement" },
      },
    }, scope);

    assert.equal(await hooks.get("before_tool_call")({
      toolName: "ypmcn-mcp__search_creators",
      params: { id: requirementId },
    }, scope), undefined);
  });

  it("preserves validate_requirement data.id from an OpenClaw-truncated success result", async () => {
    const requirementId = "1fc9ba46b660432f918a497b0dcd2da6";
    const scope = { sessionKey: "truncated-result-session" };
    const fullResult = JSON.stringify({
      success: true,
      trace_id: "trace-for-truncated-result",
      data: { id: requirementId, response_body: "x".repeat(9_000) },
      error: null,
    }, null, 2);
    const truncatedResult = `${fullResult.slice(0, 8_000)}\n…(truncated)…`;

    await hooks.get("after_tool_call")({
      toolName: "ypmcn-mcp__validate_requirement",
      params: { payload: requirementPayload() },
      result: {
        content: [{ type: "text", text: truncatedResult }],
        details: { mcpServer: "ypmcn-mcp", mcpTool: "validate_requirement" },
      },
    }, scope);

    const persistedPath = join(
      tempDir,
      "state",
      "sessions",
      createHash("sha256").update(scope.sessionKey).digest("hex").slice(0, 24),
      "confirmation_guard.json",
    );
    const persisted = JSON.parse(readFileSync(persistedPath, "utf8"));
    assert.equal(persisted.latest_requirement_id.value, requirementId);
    assert.equal(await hooks.get("before_tool_call")({
      toolName: "ypmcn-mcp__search_creators",
      params: { id: requirementId },
    }, scope), undefined);
  });

  it("does not trust a truncated success prefix when the host reports a Tool failure", async () => {
    const requirementId = "untrusted-truncated-requirement-id";
    const scope = { sessionKey: "truncated-failure-session" };
    const failedResult = JSON.stringify({
      success: true,
      data: { id: requirementId, response_body: "x".repeat(9_000) },
      error: null,
    }, null, 2);
    await hooks.get("after_tool_call")({
      toolName: "ypmcn-mcp__validate_requirement",
      params: { payload: requirementPayload() },
      result: { content: [{ type: "text", text: `${failedResult.slice(0, 8_000)}\n…(truncated)…` }] },
      error: "provider failed",
    }, scope);

    const persistedPath = join(
      tempDir,
      "state",
      "sessions",
      createHash("sha256").update(scope.sessionKey).digest("hex").slice(0, 24),
      "confirmation_guard.json",
    );
    let persisted;
    try {
      persisted = JSON.parse(readFileSync(persistedPath, "utf8"));
    } catch {
      persisted = {};
    }
    assert.equal(persisted.latest_requirement_id, undefined);
    const blocked = await hooks.get("before_tool_call")({
      toolName: "ypmcn-mcp__search_creators",
      params: { id: requirementId },
    }, scope);
    // Without completed validate_requirement in scope, search_creators is blocked by the normal guard (not a stale-chain block)
    assert.equal(blocked.block, true);
    assert.doesNotMatch(blocked.blockReason, /BLOCKED_PREVIOUS_HOOK_RESULT/);
  });

  it("allows a corrected call in the same turn immediately after a Hook denial", async () => {
    await hooks.get("before_prompt_build")({ prompt: "恢复状态", messages: [] }, {});
    const invalid = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__get_workflow_state",
      params: { demand_id: "demand-1" },
    }, {});
    assert.match(invalid.blockReason, /INVALID_INPUT/);

    const retried = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__get_workflow_state",
      params: { trace_id: "demand-1" },
    }, {});
    assert.equal(retried, undefined);

    // Same-turn corrected call to another tool is not blocked by the previous denial
    await hooks.get("before_prompt_build")({ prompt: "具体守卫优先", messages: [] }, {});
    await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__get_workflow_state",
      params: { demand_id: "demand-2" },
    }, {});
    const specific = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__create_with_distributions",
      params: distributionParams({ projectName: "具体守卫优先测试" }),
    }, {});
    assert.doesNotMatch(specific.blockReason, /BLOCKED_PREVIOUS_HOOK_RESULT/);
    assert.match(specific.blockReason, /WORKFLOW_STATE_REFRESH_REQUIRED/);

    await hooks.get("before_prompt_build")({ prompt: "用户明确重试", messages: [] }, {});
    assert.equal(await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__get_workflow_state",
      params: { trace_id: "trace-1" },
    }, {}), undefined);
  });

  it("requires trusted Tool provenance before get_creator_detail", async () => {
    const invented = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__get_creator_detail",
      params: { platform: "xiaohongshu", kwUid: "invented-creator-id" },
    }, {});
    assert.equal(invented.block, true);
    assert.match(invented.blockReason, /ID_PROVENANCE_REQUIRED/);

    await hooks.get("before_prompt_build")({ prompt: "trusted creator turn", messages: [] }, {});
    await hooks.get("after_tool_call")({
      toolName: "mcp__ypmcn__manual_source_creators",
      params: { requirement_id: "req-provenance" },
      result: { success: true, data: { creators: [{ kwUid: "trusted-creator-id" }] }, error: null },
    }, {});
    const trusted = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__get_creator_detail",
      params: { platform: "xiaohongshu", kwUid: "trusted-creator-id" },
    }, {});
    assert.equal(trusted, undefined);
  });

  it("requires trusted Tool provenance before sync_mcn_inquiry_status", async () => {
    const params = {
      requirement_id: "trusted-requirement-id",
      project_id: "trusted-project-id",
      mcn_id: "trusted-mcn-id",
    };
    const untrusted = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__sync_mcn_inquiry_status",
      params,
    }, {});
    assert.equal(untrusted.block, true);
    assert.match(untrusted.blockReason, /ID_PROVENANCE_REQUIRED.*requirement_id/);

    await hooks.get("before_prompt_build")({ prompt: "trusted sync turn", messages: [] }, {});
    await hooks.get("after_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params: { payload: requirementPayload() },
      result: { success: true, data: { id: params.requirement_id }, error: null },
    }, {});
    await hooks.get("after_tool_call")({
      toolName: "mcp__ypmcn__create_with_distributions",
      params: distributionParams(),
      result: {
        success: true,
        data: { project_id: params.project_id, distributions: [{ mcn_id: params.mcn_id }] },
        error: null,
      },
    }, {});
    const trusted = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__sync_mcn_inquiry_status",
      params,
    }, {});
    assert.equal(trusted, undefined);

    await hooks.get("after_tool_call")({
      toolName: "mcp__ypmcn__create_with_distributions",
      params: distributionParams({ projectName: "other-project" }),
      result: {
        success: true,
        data: { project_id: "other-project-id", distributions: [{ mcn_id: "other-mcn-id" }] },
        error: null,
      },
    }, {});
    const mixed = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__sync_mcn_inquiry_status",
      params: { ...params, project_id: "other-project-id" },
    }, {});
    assert.match(mixed.blockReason, /ID_PROVENANCE_MISMATCH/);
  });

  it("requires trusted provenance for inquiry and recommendation run IDs", async () => {
    const inquiryId = "trusted-inquiry-id";
    const runId = "90001";
    const untrustedInquiry = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__ingest_mcn_submissions",
      params: { inquiry_id: inquiryId, items: [{ kwUid: "creator-1" }] },
    }, {});
    assert.match(untrustedInquiry.blockReason, /ID_PROVENANCE_REQUIRED.*inquiry_id/);

    await hooks.get("before_prompt_build")({ prompt: "untrusted run turn", messages: [] }, {});
    const untrustedRun = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__get_recommendation_run_detail",
      params: { run_id: runId },
    }, {});
    assert.match(untrustedRun.blockReason, /ID_PROVENANCE_REQUIRED.*run_id/);

    await hooks.get("before_prompt_build")({ prompt: "trusted inquiry and run turn", messages: [] }, {});
    await hooks.get("after_tool_call")({
      toolName: "mcp__ypmcn__create_with_distributions",
      params: distributionParams(),
      result: { success: true, data: { inquiry_id: inquiryId }, error: null },
    }, {});
    await hooks.get("after_tool_call")({
      toolName: "mcp__ypmcn__rank_creators",
      params: { requirement_id: "req-run-provenance" },
      result: { success: true, data: { run_id: runId }, error: null },
    }, {});

    assert.equal(await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__ingest_mcn_submissions",
      params: { inquiry_id: inquiryId, items: [{ kwUid: "creator-1" }] },
    }, {}), undefined);
    for (const [toolName, params] of [
      ["create_submission_batch", { run_id: runId }],
      ["record_client_feedback", { run_id: runId, feedback_items: [{ status: "accepted" }] }],
      ["get_recommendation_run_detail", { run_id: runId }],
      ["audit_manual_adjustment", { run_id: runId, adjustments: [{}], operator_id: "operator-1" }],
    ]) {
      assert.equal(await hooks.get("before_tool_call")({
        toolName: `mcp__ypmcn__${toolName}`,
        params,
      }, {}), undefined, toolName);
    }
  });

  it("does not confuse a legitimate project name with a schema probe", async () => {
    const payload = requirementPayload({ projectName: "schema_probe新品" });
    const result = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params: { payload },
      toolCallId: "call-schema-probe",
    }, {});
    assert.equal(result, undefined);
  });

  it("blocks missing required requirement fields", async () => {
    for (const field of [
      "platform",
      "quantityTotal",
      "submissionDeadlineAt",
      "rawMessagesJson",
    ]) {
      await hooks.get("before_prompt_build")({ prompt: `missing ${field}`, messages: [] }, {});
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
      await hooks.get("before_prompt_build")({ prompt: "invalid requirement payload", messages: [] }, {});
      const blocked = await hooks.get("before_tool_call")({
        toolName: "mcp__ypmcn__validate_requirement",
        params: { payload },
        toolCallId: "call-ambiguous-requirement",
      }, {});
      assert.equal(blocked.block, true);
      assert.match(blocked.blockReason, /BLOCKED_REQUIREMENT_INCOMPLETE/);
    }
  });

  it("allows a same-turn correction after an invalid mapped field is denied", async () => {
    await hooks.get("before_prompt_build")({ prompt: "新需求", messages: [] }, {});
    const first = requirementPayload({ contentForm: "视频" });
    first.rawMessagesJson.originalBrief += "，内容形式：视频";
    first.rawMessagesJson.atoms.push({
      sourceText: "内容形式：视频", disposition: "mapped", targetField: "contentForm", confidence: 1, inferred: false,
    });
    first.rawMessagesJson.coverageCheck = {
      atomCount: 5, mappedCount: 5, preservedCount: 0, unresolvedCount: 0,
    };
    const blocked = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params: { payload: first },
    }, {});
    assert.match(blocked.blockReason, /BLOCKED_REQUIREMENT_INCOMPLETE.*contentForm.*not a real customer_demands field/);

    const corrected = structuredClone(first);
    delete corrected.contentForm;
    corrected.rawMessagesJson.atoms[4] = {
      sourceText: "内容形式：视频", disposition: "preserved", preservedText: "内容形式：视频", confidence: 1, inferred: false,
    };
    corrected.rawMessagesJson.coverageCheck = {
      atomCount: 5, mappedCount: 4, preservedCount: 1, unresolvedCount: 0,
    };
    const retried = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params: { payload: corrected },
    }, {});
    assert.equal(retried, undefined);
  });

  it("requires complete auditable brief atoms and matching zero-unresolved coverage", async () => {
    const validAudit = requirementPayload().rawMessagesJson;
    const invalidAudits = [
      { ...validAudit, schemaVersion: "legacy" },
      { ...validAudit, atoms: [{ ...validAudit.atoms[0], targetField: "inventedField" }], coverageCheck: { atomCount: 1, mappedCount: 1, preservedCount: 0, unresolvedCount: 0 } },
      { ...validAudit, atoms: [{ sourceText: "小红书", disposition: "preserved", confidence: 1, inferred: false }], coverageCheck: { atomCount: 1, mappedCount: 0, preservedCount: 1, unresolvedCount: 0 } },
      { ...validAudit, atoms: [{ sourceText: "小红书", preservedText: "抖音", disposition: "preserved", confidence: 1, inferred: false }], coverageCheck: { atomCount: 1, mappedCount: 0, preservedCount: 1, unresolvedCount: 0 } },
      { ...validAudit, coverageCheck: { ...validAudit.coverageCheck, unresolvedCount: 1 } },
    ];
    const expectedBlockReasons = [
      /BLOCKED_REQUIREMENT_INCOMPLETE/,
      /BLOCKED_REQUIREMENT_INCOMPLETE/,
      /BLOCKED_REQUIREMENT_INCOMPLETE/,
      /BLOCKED_REQUIREMENT_INCOMPLETE/,
      /BLOCKED_REQUIREMENT_AUDIT_CONFLICT/,
    ];
    for (const [index, rawMessagesJson] of invalidAudits.entries()) {
      await hooks.get("before_prompt_build")({ prompt: "invalid audit case", messages: [] }, {});
      const blocked = await hooks.get("before_tool_call")({
        toolName: "mcp__ypmcn__validate_requirement",
        params: { payload: requirementPayload({ rawMessagesJson }) },
      }, {});
      assert.equal(blocked.block, true);
      assert.match(blocked.blockReason, expectedBlockReasons[index], `invalid audit case ${index}`);
    }
  });

  it("accepts a mapped atom sourced from an explicit supplemental confirmation", async () => {
    const payload = requirementPayload();
    payload.rawMessagesJson.atoms.push({
      sourceText: "平台：小红书",
      disposition: "mapped",
      targetField: "platform",
      confidence: 1,
      inferred: false,
    });
    payload.rawMessagesJson.coverageCheck.atomCount += 1;
    payload.rawMessagesJson.coverageCheck.mappedCount += 1;

    const result = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params: { payload },
    }, {});
    assert.equal(result, undefined);
  });

  it("accepts explicit account taxonomy and rejects mapping it as content", async () => {
    const talentPayload = requirementPayload({ talentTypeLabel: ["母婴", "亲子"] });
    talentPayload.rawMessagesJson.originalBrief += "，账号类型：母婴类、亲子相关";
    talentPayload.rawMessagesJson.atoms.push({
      sourceText: "账号类型：母婴类、亲子相关", disposition: "mapped", targetField: "talentTypeLabel", confidence: 1, inferred: false,
    });
    talentPayload.rawMessagesJson.coverageCheck = { atomCount: 5, mappedCount: 5, preservedCount: 0, unresolvedCount: 0 };
    assert.equal(await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement", params: { payload: talentPayload },
    }, {}), undefined);

    await hooks.get("before_prompt_build")({ prompt: "taxonomy content mismatch", messages: [] }, {});
    const wrongContent = requirementPayload({ contentTag: "母婴,亲子" });
    wrongContent.rawMessagesJson.originalBrief += "，账号类型：母婴类、亲子相关";
    wrongContent.rawMessagesJson.atoms.push({
      sourceText: "账号类型：母婴类、亲子相关", disposition: "mapped", targetField: "contentTag", confidence: 1, inferred: false,
    });
    wrongContent.rawMessagesJson.coverageCheck = { atomCount: 5, mappedCount: 5, preservedCount: 0, unresolvedCount: 0 };
    const blocked = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement", params: { payload: wrongContent },
    }, {});
    assert.match(blocked.blockReason, /BLOCKED_TAXONOMY_CONFIRMATION_REQUIRED.*contentTag/);

    await hooks.get("before_prompt_build")({ prompt: "confirmed content topic", messages: [] }, {});
    const contentPayload = requirementPayload({ contentTag: "母婴,亲子" });
    contentPayload.rawMessagesJson.originalBrief += "，内容主题：母婴、亲子";
    contentPayload.rawMessagesJson.atoms.push({
      sourceText: "母婴、亲子", disposition: "mapped", targetField: "contentTag", confidence: 1, inferred: false,
    });
    contentPayload.rawMessagesJson.coverageCheck = {
      atomCount: 5, mappedCount: 5, preservedCount: 0, unresolvedCount: 0,
    };
    assert.equal(await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params: { payload: contentPayload },
    }, {}), undefined);
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

    await hooks.get("before_prompt_build")({ prompt: "invalid unit budget serialization", messages: [] }, {});
    const blockedInvalid = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params: { payload: requirementPayload({ kolOfficialPriceL1: "5000" }) },
      toolCallId: "call-invalid-unit-budget",
    }, {});
    assert.equal(blockedInvalid.block, true);
    assert.match(blockedInvalid.blockReason, /canonical non-negative range string/);

    for (const kolOfficialPriceL1 of ["[0,0]", "[5000,3000]", "[0, 5000]", [0, 5000]]) {
      await hooks.get("before_prompt_build")({ prompt: "invalid unit budget range", messages: [] }, {});
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
      await hooks.get("before_prompt_build")({ prompt: "invalid range serialization", messages: [] }, {});
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
      await hooks.get("before_prompt_build")({ prompt: "invalid requirement field", messages: [] }, {});
      const blocked = await hooks.get("before_tool_call")({
        toolName: "mcp__ypmcn__validate_requirement",
        params: { payload },
      }, {});
      assert.equal(blocked.block, true);
      assert.match(blocked.blockReason, /BLOCKED_REQUIREMENT_INCOMPLETE/);
    }
  });

  it("requires a successful search result for the same requirement", async () => {
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
      assert.deepEqual(
        Object.keys(stored).sort(),
        [...Object.keys(supplyPlan()), "fingerprint", "observed_at_ms", "expires_at_ms"].sort(),
      );
      assert.match(stored.fingerprint, /^[0-9a-f]{64}$/);
      assert.ok(stored.expires_at_ms > stored.observed_at_ms);
      const allowed = await hooks.get("before_tool_call")({
        toolName: "mcp__ypmcn__rank_mcns",
        params: { id: requirementId, platform: "xiaohongshu" },
      }, {});
      assert.equal(allowed, undefined);
    }
  });

  it("continues to rank after successful search while keeping malformed supply plans out of confirmation state", async () => {
    const invalidPlans = [
      supplyPlan({ estimated_gap_count: -1 }),
      supplyPlan({ recommended_manual_creator_count: -1, mcn_manual_creator_ratio: "18:-1" }),
      supplyPlan({ mcn_manual_creator_ratio: "9:1" }),
    ];
    for (let index = 0; index < invalidPlans.length; index += 1) {
      const requirementId = `req-invalid-plan-${index}`;
      await recordSearch(requirementId);
      await recordSearch(requirementId, invalidPlans[index]);
      const persisted = JSON.parse(readFileSync(stateFile, "utf8"));
      assert.equal(persisted.supply_plans[requirementId], undefined);
      const allowed = await hooks.get("before_tool_call")({
        toolName: "mcp__ypmcn__rank_mcns",
        params: { id: requirementId, platform: "xiaohongshu" },
      }, {});
      assert.equal(allowed, undefined);
    }

    const changedStrategyId = "req-provider-strategy-change";
    await hooks.get("before_prompt_build")({ prompt: "provider strategy changed", messages: [] }, {});
    await recordSearch(changedStrategyId, supplyPlan({ estimated_gap_count: 3 }));
    const allowed = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__rank_mcns", params: { id: changedStrategyId, platform: "xiaohongshu" },
    }, {});
    assert.equal(allowed, undefined);
  });

  it("hydrates reconstructed supply values from the bound receipt and still rejects non-exact options", async () => {
    const params = { id: "req-forged-plan-popup", platform: "xiaohongshu" };
    await recordSearch(params.id);
    const id = pendingSupplyConfirmationId(params.id);
    const plan = JSON.parse(readFileSync(stateFile, "utf8")).confirmations[id].safe_summary;
    const question = supplyPlanQuestion(id, { ...plan, demand_count: 999 });
    const forgedParams = {
      questions: [{ question, options: [{ label: "确认供给方案" }, { label: "调整方案" }] }],
    };
    const premature = await hooks.get("before_tool_call")({
      toolName: "AskUserQuestion",
      params: forgedParams,
    }, {});
    assert.match(premature.blockReason, /INVALID_PHASE.*rank_mcns/);

    await hooks.get("before_prompt_build")({ prompt: "按状态继续排名", messages: [] }, {});
    await recordSuccessfulRank(params, "forged-plan-popup");
    const forged = await hooks.get("before_tool_call")({
      toolName: "AskUserQuestion",
      params: forgedParams,
    }, {});
    assert.equal(forged, undefined);
    assert.equal(forgedParams.questions[0].question, supplyPlanQuestion(id, plan).replace("\n", " ").replace("\n", " "));

    const extraOption = await hooks.get("before_tool_call")({
      toolName: "AskUserQuestion",
      params: {
        questions: [{
          question: forgedParams.questions[0].question,
          options: [{ label: "确认供给方案" }, { label: "调整方案" }, { label: "稍后" }],
        }],
      },
    }, {});
    assert.equal(extraOption.block, true);
    assert.match(extraOption.blockReason, /BLOCKED_CONFIRMATION_MISMATCH/);
  });

  it("blocks an unbound supply confirmation popup before it can show reconstructed values", async () => {
    clearSupplyConfirmations();
    const blocked = await hooks.get("before_tool_call")({
      toolName: "AskUserQuestion",
      params: {
        questions: [{
          header: "供给确认",
          question: "【真实数据】候选达人=223｜【计算计划】目标提报=20｜【推荐组合】推荐MCN=4｜【影响】确认后排序",
          options: [{ label: "确认供给方案" }, { label: "调整方案" }],
        }],
      },
    }, {});
    assert.match(blocked.blockReason, /BLOCKED_CONFIRMATION_MISMATCH/);
    assert.match(blocked.blockReason, /exactly one current search_creators result/);
  });

  it("replaces a dense supply confirmation with the compact bound summary", async () => {
    const params = { id: "req-dense-plan-popup", platform: "xiaohongshu" };
    await recordSearch(params.id);
    await recordSuccessfulRank(params, "dense-plan-popup");
    const id = pendingSupplyConfirmationId(params.id);
    const plan = JSON.parse(readFileSync(stateFile, "utf8")).confirmations[id].safe_summary;
    const question = [
      `供给方案。[YP_SUPPLY_PLAN_CONFIRMATION:${id}]`,
      ...Object.entries(plan).map(([field, value]) => `${field}=${value}`),
    ].join("；");
    const askParams = { questions: [{ question, options: [{ label: "确认供给方案" }, { label: "调整方案" }] }] };
    const formatBlocked = await hooks.get("before_tool_call")({
      toolName: "AskUserQuestion",
      params: askParams,
    }, {});
    assert.equal(formatBlocked, undefined);
    assert.equal(askParams.questions[0].question, supplyPlanQuestion(id, plan).replace("\n", " ").replace("\n", " "));
  });

  it("fills omitted supply display fields from the receipt before accepting confirmation", async () => {
    const params = { id: "req-supply-incomplete", platform: "xiaohongshu" };
    await recordSearch(params.id);
    await recordSuccessfulRank(params, "supply-incomplete");
    const id = pendingSupplyConfirmationId(params.id);
    const askParams = {
      questions: [{
        question: `供需比 2:1。[YP_SUPPLY_PLAN_CONFIRMATION:${id}]`,
        options: [{ label: "确认供给方案" }, { label: "调整方案" }],
      }],
    };
    assert.equal(await hooks.get("before_tool_call")({ toolName: "AskUserQuestion", params: askParams }, {}), undefined);
    assert.match(askParams.questions[0].question, /【真实数据】.*【推荐方案】.*【影响】/);
    await hooks.get("after_tool_call")({
      toolName: "AskUserQuestion",
      params: askParams,
      result: { status: "submitted", answers: [{ selected_labels: ["确认供给方案"] }] },
    }, {});
    const confirmed = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(confirmed.confirmations[id].status, "approved");
  });

  it("binds visible hard-filter counts instead of a stale unfiltered provider plan", async () => {
    const requirementId = "req-filtered-supply-plan";
    const stalePlan = supplyPlan({
      demand_count: 5,
      database_candidate_count: 2561,
      supply_demand_ratio: 512.2,
      target_submission_count: 15,
      estimated_valid_return_count: 10,
      estimated_gap_count: 5,
      recommended_mcn_count: 5,
      mcn_covered_creator_count: 2561,
      recommended_manual_creator_count: 5,
      mcn_manual_creator_ratio: "2561:5",
    });
    await hooks.get("after_tool_call")({
      toolName: "mcp__ypmcn__search_creators",
      params: { id: requirementId },
      result: {
        success: true,
        data: {
          supply_plan: stalePlan,
          total_matched: 377,
          supply_assessment: { candidate_count: 377, quantity_total: 5, supply_multiplier: 75.4 },
          creators: [
            { candidate_id: 1, kw_uid: "creator-1", supplier_id: "supplier-1" },
            { candidate_id: 2, kw_uid: "creator-2", supplier_id: "supplier-1" },
            { candidate_id: 3, kw_uid: "creator-3", supplier_id: null },
          ],
        },
        error: null,
      },
    }, {});

    const persisted = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.deepEqual(
      {
        demand_count: persisted.supply_plans[requirementId].demand_count,
        database_candidate_count: persisted.supply_plans[requirementId].database_candidate_count,
        supply_demand_ratio: persisted.supply_plans[requirementId].supply_demand_ratio,
        mcn_covered_creator_count: persisted.supply_plans[requirementId].mcn_covered_creator_count,
        recommended_manual_creator_count: persisted.supply_plans[requirementId].recommended_manual_creator_count,
        mcn_manual_creator_ratio: persisted.supply_plans[requirementId].mcn_manual_creator_ratio,
      },
      {
        demand_count: 5,
        database_candidate_count: 377,
        supply_demand_ratio: 75.4,
        mcn_covered_creator_count: 2,
        recommended_manual_creator_count: 5,
        mcn_manual_creator_ratio: "2:5",
      },
    );
  });

  it("allows a ready requirement without optional project or industry fields", async () => {
    assert.equal(await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params: { payload: requirementPayload() },
      toolCallId: "call-ready-requirement",
    }, {}), undefined);
  });

  it("continues directly from successful search to one rank_mcns attempt", async () => {
    const params = { id: "req-supply-1", platform: "xiaohongshu" };
    await recordSearch(params.id);
    const allowed = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__rank_mcns", params, toolCallId: "call-rank-mcn-1",
    }, {});
    assert.equal(allowed, undefined);
    await hooks.get("after_tool_call")({
      toolName: "mcp__ypmcn__rank_mcns", params, toolCallId: "call-rank-mcn-1",
      result: { success: true, data: { mcn_run_id: "mcn-run-1" }, error: null },
    }, {});
    const replay = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__rank_mcns", params, toolCallId: "call-rank-mcn-2",
    }, {});
    assert.match(replay.blockReason, /INVALID_PHASE.*already been consumed/);
  });

  it("keeps the supply confirmation available after direct ranking for the pre-send gate", async () => {
    const params = { id: "req-supply-direct-popup", platform: "xiaohongshu" };
    await recordSearch(params.id);
    const stateAfterSearch = JSON.parse(readFileSync(stateFile, "utf8"));
    const pending = Object.entries(stateAfterSearch.confirmations).find(([, receipt]) =>
      receipt.kind === "supply_plan" && receipt.requirement_id === params.id && receipt.status === "pending"
    );
    assert.ok(pending, "search_creators should create the pending supply confirmation");
    assert.equal(pending[1].request_fingerprint, null);

    assert.equal(await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__rank_mcns",
      params,
      toolCallId: "call-rank-before-supply-popup",
    }, {}), undefined);
    await hooks.get("after_tool_call")({
      toolName: "mcp__ypmcn__rank_mcns",
      params,
      toolCallId: "call-rank-before-supply-popup",
      result: { success: true, data: { mcn_run_id: "mcn-run-before-supply-popup" }, error: null },
    }, {});

    const askParams = {
      questions: [{
        header: "供给确认",
        question: supplyPlanQuestion(undefined, pending[1].safe_summary),
        options: [{ label: "确认供给方案" }, { label: "调整方案" }],
      }],
    };
    assert.equal(await hooks.get("before_tool_call")({ toolName: "AskUserQuestion", params: askParams }, {}), undefined);
    assert.match(askParams.questions[0].question, /YP_SUPPLY_PLAN_CONFIRMATION/);
    await hooks.get("after_tool_call")({
      toolName: "AskUserQuestion",
      params: askParams,
      result: { status: "submitted", answers: [{ selected_labels: ["确认供给方案"] }] },
    }, {});
    const confirmed = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(confirmed.confirmations[pending[0]].status, "approved");
  });

  it("allows schema-valid rank parameters directly from a successful search", async () => {
    const params = { id: "req-supply-direct-popup-options", platform: "xiaohongshu" };
    await recordSearch(params.id);
    const allowed = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__rank_mcns",
      params: { ...params, minimum_mcn_count: 8 },
    }, {});
    assert.equal(allowed, undefined);
  });

  it("accepts YP Action flattened supply confirmation and raw JSON MCP success results", async () => {
    const params = { id: "req-supply-yp-action-shape", platform: "xiaohongshu" };
    await recordSearch(params.id);
    const id = pendingSupplyConfirmationId(params.id);
    assert.equal(await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__rank_mcns", params, toolCallId: "call-rank-yp-action-1",
    }, {}), undefined);
    await hooks.get("after_tool_call")({
      toolName: "mcp__ypmcn__rank_mcns",
      params,
      toolCallId: "call-rank-yp-action-1",
      result: JSON.stringify({ success: true, data: { mcn_run_id: "mcn-run-yp-action" }, error: null }),
    }, {});
    await answerSupplyPlanConfirmation(id, "确认供给方案", true);

    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.search_receipts[params.id].status, "consumed");
    assert.equal(state.confirmations[id].status, "approved");
  });

  it("does not let a changed rank request bypass an in-flight write", async () => {
    const params = { id: "req-supply-change", platform: "xiaohongshu", minimum_mcn_count: 8 };
    await recordSearch(params.id);
    assert.equal(await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__rank_mcns", params, toolCallId: "call-rank-change-1",
    }, {}), undefined);
    const changed = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__rank_mcns",
      params: { ...params, minimum_mcn_count: 10 },
      toolCallId: "call-rank-change-2",
    }, {});
    assert.match(changed.blockReason, /WRITE_RESULT_UNKNOWN.*get_workflow_state/);
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

  it("accepts the flattened YP Action external-send confirmation result", async () => {
    const params = distributionParams({ projectName: "YP Action 外发确认形状" });
    const { id } = await requestConfirmation(params);
    await answerConfirmation(id, "确认发送", true);
    assert.equal(await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__create_with_distributions",
      params,
      toolCallId: "call-send-yp-action-shape",
    }, {}), undefined);
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

    await hooks.get("before_prompt_build")({ prompt: "检查另一个项目的状态", messages: [] }, {});
    await recordWorkflowState("另一个项目");
    const mismatch = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__create_with_distributions", params, toolCallId: "call-state-mismatch",
    }, {});
    assert.equal(mismatch.block, true);
    assert.match(mismatch.blockReason, /BLOCKED_WORKFLOW_ACTION/);
  });

  it("does not let workflow permission skip the external preparation chain", async () => {
    const params = distributionParams({ projectName: "未完成外发链路" });
    await recordWorkflowState(params.projectName, ["create_with_distributions"], "req-unprepared-send");
    const blocked = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__create_with_distributions",
      params,
      toolCallId: "call-unprepared-send",
    }, {});
    assert.match(blocked.blockReason, /INVALID_PHASE.*rank_mcns/);
  });

  it("fails closed when two demands share the same project name", async () => {
    const params = distributionParams({ projectName: "同名项目" });
    await recordWorkflowState(params.projectName, ["create_with_distributions"], "req-same-name-1", "demand-same-name-1");
    await recordWorkflowState(params.projectName, ["create_with_distributions"], "req-same-name-2", "demand-same-name-2");
    const blocked = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__create_with_distributions",
      params,
      toolCallId: "call-ambiguous-project",
    }, {});
    assert.match(blocked.blockReason, /WORKFLOW_STATE_REFRESH_REQUIRED/);
  });

  it("hydrates external summary values and allows explicit cancel options", async () => {
    const { id } = await requestConfirmation(distributionParams({ projectName: "真实外发项目" }));
    const summary = JSON.parse(readFileSync(stateFile, "utf8")).confirmations[id].safe_summary;
    const question = [
      `【外发对象】项目名=伪造项目｜机构数=${summary.supplier_count}`,
      `【外发内容】截止时间=${summary.deadline}｜表单字段=${JSON.stringify(summary.column_names)}`,
      `【固定模板】消息模板=${summary.message_template_id}`,
      `【影响】确认后真实企微外发｜[YP_CONFIRMATION:${id}]`,
    ].join("\n");
    const forgedParams = { questions: [{ question, options: [{ label: "确认发送" }, { label: "需要修改" }] }] };
    const forged = await hooks.get("before_tool_call")({
      toolName: "AskUserQuestion",
      params: forgedParams,
    }, {});
    assert.equal(forged, undefined);
    assert.match(forgedParams.questions[0].question, /项目名=真实外发项目/);
    assert.doesNotMatch(forgedParams.questions[0].question, /项目名=伪造项目/);

    await hooks.get("before_prompt_build")({ prompt: "重新确认外发", messages: [] }, {});
    const second = await requestConfirmation(distributionParams({ projectName: "允许取消项目" }));
    const extraOption = await hooks.get("before_tool_call")({
      toolName: "AskUserQuestion",
      params: {
        questions: [{
          header: "外发确认",
          question: "请确认是否外发？",
          options: [{ label: "确认发送" }, { label: "需要修改" }, { label: "取消" }],
        }],
      },
    }, {});
    assert.ok(second.id);
    assert.equal(extraOption, undefined);
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

  it("keeps an unknown send outcome blocked after state refresh", async () => {
    const params = distributionParams({ projectName: "未知结果恢复测试" });
    const { id } = await requestConfirmation(params);
    await answerConfirmation(id);
    assert.equal(await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__create_with_distributions", params, toolCallId: "call-reconcile-send-1",
    }, {}), undefined);
    await hooks.get("after_tool_call")({
      toolName: "mcp__ypmcn__create_with_distributions",
      params,
      toolCallId: "call-reconcile-send-1",
      error: new Error("connection lost"),
    }, {});

    await recordWorkflowState(params.projectName, ["create_with_distributions"]);
    const retry = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__create_with_distributions", params, toolCallId: "call-reconcile-send-2",
    }, {});
    assert.match(retry.blockReason, /WRITE_RESULT_UNKNOWN/);
  });

  it("keeps an expired unknown send blocked even when parameters change", async () => {
    const params = distributionParams({ projectName: "未知结果持久测试" });
    const { id } = await requestConfirmation(params);
    await answerConfirmation(id);
    assert.equal(await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__create_with_distributions", params, toolCallId: "call-persistent-unknown-1",
    }, {}), undefined);
    await hooks.get("after_tool_call")({
      toolName: "mcp__ypmcn__create_with_distributions",
      params,
      toolCallId: "call-persistent-unknown-1",
      error: new Error("connection lost"),
    }, {});
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    state.confirmations[id].expires_at_ms = Date.now() - 1;
    writeFileSync(stateFile, JSON.stringify(state), "utf8");

    await recordWorkflowState(params.projectName, ["create_with_distributions"]);
    const changed = {
      ...params,
      supplierIds: ["supplier-1", "supplier-2"],
      prefillRowsBySupplier: { "supplier-1": [], "supplier-2": [] },
    };
    const retry = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__create_with_distributions", params: changed, toolCallId: "call-persistent-unknown-2",
    }, {});
    assert.match(retry.blockReason, /WRITE_RESULT_UNKNOWN.*changed parameters/);
    assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).confirmations[id].status, "unknown");
  });

  it("reconciles an unknown rank outcome only for the same requirement", async () => {
    const requirementId = "req-rank-reconcile";
    const params = { id: requirementId, platform: "xiaohongshu" };
    await recordSearch(requirementId);
    assert.equal(await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__rank_mcns", params, toolCallId: "call-reconcile-rank-1",
    }, {}), undefined);
    await hooks.get("after_tool_call")({
      toolName: "mcp__ypmcn__rank_mcns",
      params,
      toolCallId: "call-reconcile-rank-1",
      error: new Error("connection lost"),
    }, {});

    const recovery = {
      questions: [{
        header: "服务异常",
        question: "排名结果未知，请选择下一步？",
        options: [{ label: "查询状态" }, { label: "停止" }],
      }],
    };
    assert.equal(await hooks.get("before_tool_call")({ toolName: "AskUserQuestion", params: recovery }, {}), undefined);
    await hooks.get("after_tool_call")({
      toolName: "AskUserQuestion",
      params: recovery,
      result: { status: "submitted", answers: [{ selected_labels: ["查询状态"] }] },
    }, {});

    const stateParams = { demand_id: "demand-rank-reconcile", demand_version: 1 };
    assert.equal(await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__get_workflow_state", params: stateParams,
    }, {}), undefined);
    await hooks.get("after_tool_call")({
      toolName: "mcp__ypmcn__get_workflow_state",
      params: stateParams,
      result: {
        success: true,
        data: {
          workflow_state: {
            project_name: "排名恢复测试",
            requirement_id: requirementId,
            allowed_actions: ["rank_mcns"],
          },
        },
        error: null,
      },
    }, {});
    assert.equal(await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__rank_mcns", params, toolCallId: "call-reconcile-rank-2",
    }, {}), undefined);
  });

  it("expires stale search receipts instead of reusing them", async () => {
    const requirementId = "req-expired-plan";
    await recordSearch(requirementId);
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    state.supply_plans[requirementId].expires_at_ms = Date.now() - 1;
    state.search_receipts[requirementId].expires_at_ms = Date.now() - 1;
    writeFileSync(stateFile, JSON.stringify(state), "utf8");

    const blocked = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__rank_mcns",
      params: { id: requirementId, platform: "xiaohongshu" },
    }, {});
    assert.match(blocked.blockReason, /INTEGRATION_REQUIRED.*successful search_creators/);
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
