import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    `【影响】确认后写入MCN排序${id ? `｜[YP_SUPPLY_PLAN_CONFIRMATION:${id}]` : ""}`,
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
    assert.deepEqual([...hooks.keys()].sort(), ["after_tool_call", "before_agent_reply", "before_prompt_build", "before_tool_call", "session_end"]);
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

  it("keeps a denied native clarification pending", async () => {
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
    const blocked = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params: { payload: requirementPayload() },
    }, {});
    assert.match(blocked.blockReason, /BLOCKED_REQUIREMENT_CLARIFICATION_REQUIRED/);
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
    assert.match(blocked.blockReason, /one direct/);
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
    assert.match(blocked.blockReason, /one direct/);
  });

  it("rejects a question that exposes internal terms or omits option guidance", async () => {
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
    assert.match(blocked.blockReason, /field names/);
    assert.match(blocked.blockReason, /descriptions/);
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
    assert.equal(state.blocked_tool_turn, undefined);
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

  it("requires a user popup after a Hook denial and resumes the selected safe path in the same turn", async () => {
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
    assert.match(retried.blockReason, /BLOCKED_PREVIOUS_HOOK_RESULT/);
    assert.match(retried.blockReason, /INVALID_INPUT/);

    const recoveryParams = {
      questions: [{
        header: "参数确认",
        question: "参数错误：get_workflow_state 缺少完整定位条件。请选择下一步。",
        options: [{ label: "使用 trace_id 重试" }, { label: "停止" }],
      }],
    };
    assert.equal(await hooks.get("before_tool_call")({ toolName: "AskUserQuestion", params: recoveryParams }, {}), undefined);
    await hooks.get("after_tool_call")({
      toolName: "AskUserQuestion",
      params: recoveryParams,
      result: `${recoveryParams.questions[0].question}: 使用 trace_id 重试`,
    }, {});
    assert.equal(await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__get_workflow_state",
      params: { trace_id: "demand-1" },
    }, {}), undefined);

    await hooks.get("before_prompt_build")({ prompt: "具体守卫优先", messages: [] }, {});
    await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__get_workflow_state",
      params: { demand_id: "demand-2" },
    }, {});
    const specific = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__create_with_distributions",
      params: distributionParams({ projectName: "具体守卫优先测试" }),
    }, {});
    assert.match(specific.blockReason, /BLOCKED_PREVIOUS_HOOK_RESULT.*INVALID_INPUT/);
    assert.doesNotMatch(specific.blockReason, /WORKFLOW_STATE_REFRESH_REQUIRED/);

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

  it("blocks every same-turn rewrite after a requirement denial", async () => {
    await hooks.get("before_prompt_build")({ prompt: "新需求", messages: [] }, {});
    const first = requirementPayload({ quantityTotal: 0, rebate: "[0.3,0.3]" });
    first.rawMessagesJson.originalBrief += "，返点30%";
    first.rawMessagesJson.atoms.push({
      sourceText: "返点30%", disposition: "mapped", targetField: "rebate", confidence: 1, inferred: false,
    });
    first.rawMessagesJson.coverageCheck = {
      atomCount: 5, mappedCount: 5, preservedCount: 0, unresolvedCount: 0,
    };
    const blocked = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params: { payload: first },
    }, {});
    assert.match(blocked.blockReason, /BLOCKED_REQUIREMENT_INCOMPLETE/);

    const rewritten = structuredClone(first);
    delete rewritten.rebate;
    rewritten.rawMessagesJson.atoms[4] = {
      sourceText: "返点30%", disposition: "preserved", preservedText: "返点30%", confidence: 1, inferred: false,
    };
    rewritten.rawMessagesJson.coverageCheck = {
      atomCount: 5, mappedCount: 4, preservedCount: 1, unresolvedCount: 0,
    };
    const downgrade = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params: { payload: rewritten },
    }, {});
    assert.match(downgrade.blockReason, /BLOCKED_PREVIOUS_HOOK_RESULT.*BLOCKED_REQUIREMENT_INCOMPLETE/);

    await hooks.get("before_prompt_build")({ prompt: "用户明确修正", messages: [] }, {});
    const nextTurn = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params: { payload: rewritten },
    }, {});
    assert.doesNotMatch(nextTurn.blockReason, /BLOCKED_REQUIREMENT_SEMANTIC_REWRITE/);
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
    const expectedBlockReasons = [
      /BLOCKED_REQUIREMENT_INCOMPLETE/,
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

  it("blocks unconfirmed natural-language account-type taxonomy mappings", async () => {
    for (const [targetField, value] of [
      ["talentTypeLabel", ["母婴", "亲子"]],
      ["contentTag", "母婴,亲子"],
    ]) {
      await hooks.get("before_prompt_build")({ prompt: `taxonomy ${targetField}`, messages: [] }, {});
      const payload = requirementPayload({ [targetField]: value });
      payload.rawMessagesJson.originalBrief += "，账号类型：母婴类、亲子相关";
      payload.rawMessagesJson.atoms.push({
        sourceText: "母婴类、亲子相关", disposition: "mapped", targetField, confidence: 1, inferred: false,
      });
      payload.rawMessagesJson.coverageCheck = {
        atomCount: 5, mappedCount: 5, preservedCount: 0, unresolvedCount: 0,
      };
      const blocked = await hooks.get("before_tool_call")({
        toolName: "mcp__ypmcn__validate_requirement",
        params: { payload },
      }, {});
      assert.match(blocked.blockReason, /BLOCKED_TAXONOMY_CONFIRMATION_REQUIRED/);
      assert.match(blocked.blockReason, new RegExp(targetField));
    }

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
      assert.deepEqual(
        Object.keys(stored).sort(),
        [...Object.keys(supplyPlan()), "fingerprint", "observed_at_ms", "expires_at_ms"].sort(),
      );
      assert.match(stored.fingerprint, /^[0-9a-f]{64}$/);
      assert.ok(stored.expires_at_ms > stored.observed_at_ms);
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
    const question = supplyPlanQuestion(id, { ...plan, demand_count: 999 });
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
          question: question.replace("需求人数=999", "需求人数=10"),
          options: [{ label: "确认供给方案" }, { label: "调整方案" }, { label: "稍后" }],
        }],
      },
    }, {});
    assert.equal(extraOption.block, true);
    assert.match(extraOption.blockReason, /BLOCKED_CONFIRMATION_MISMATCH/);
  });

  it("blocks an unbound supply confirmation popup before it can show reconstructed values", async () => {
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
    assert.match(blocked.blockReason, /exact current Provider plan.*reconstructed or approximate values/);
  });

  it("rejects a dense one-paragraph supply confirmation even when values are exact", async () => {
    const params = { id: "req-dense-plan-popup", platform: "xiaohongshu" };
    await recordSearch(params.id);
    const blocked = await hooks.get("before_tool_call")({ toolName: "mcp__ypmcn__rank_mcns", params }, {});
    const id = confirmationId(blocked);
    const plan = JSON.parse(readFileSync(stateFile, "utf8")).confirmations[id].safe_summary;
    const question = [
      `供给方案。[YP_SUPPLY_PLAN_CONFIRMATION:${id}]`,
      ...Object.entries(plan).map(([field, value]) => `${field}=${value}`),
    ].join("；");
    const formatBlocked = await hooks.get("before_tool_call")({
      toolName: "AskUserQuestion",
      params: { questions: [{ question, options: [{ label: "确认供给方案" }, { label: "调整方案" }] }] },
    }, {});
    assert.match(formatBlocked.blockReason, /BLOCKED_CONFIRMATION_FORMAT/);
    assert.match(formatBlocked.blockReason, /【分区】/);
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
    assert.match(blocked.blockReason, /供给倍数/);
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

  it("binds the supply confirmation immediately after search without probing rank_mcns", async () => {
    const params = { id: "req-supply-direct-popup", platform: "xiaohongshu" };
    await recordSearch(params.id);
    const stateAfterSearch = JSON.parse(readFileSync(stateFile, "utf8"));
    const pending = Object.entries(stateAfterSearch.confirmations).find(([, receipt]) =>
      receipt.kind === "supply_plan" && receipt.requirement_id === params.id && receipt.status === "pending"
    );
    assert.ok(pending, "search_creators should create the pending supply confirmation");
    assert.equal(pending[1].request_fingerprint, null);

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

    assert.equal(await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__rank_mcns",
      params,
      toolCallId: "call-rank-after-direct-popup",
    }, {}), undefined);
  });

  it("does not allow optional rank parameters from a search-bound confirmation", async () => {
    const params = { id: "req-supply-direct-popup-options", platform: "xiaohongshu" };
    await recordSearch(params.id);
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    const pending = Object.entries(state.confirmations).find(([, receipt]) =>
      receipt.kind === "supply_plan" && receipt.requirement_id === params.id
    );
    const askParams = {
      questions: [{
        header: "供给确认",
        question: supplyPlanQuestion(undefined, pending[1].safe_summary),
        options: [{ label: "确认供给方案" }, { label: "调整方案" }],
      }],
    };
    await hooks.get("before_tool_call")({ toolName: "AskUserQuestion", params: askParams }, {});
    await hooks.get("after_tool_call")({
      toolName: "AskUserQuestion",
      params: askParams,
      result: { status: "submitted", answers: [{ selected_labels: ["确认供给方案"] }] },
    }, {});
    const blocked = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__rank_mcns",
      params: { ...params, minimum_mcn_count: 8 },
    }, {});
    assert.match(blocked.blockReason, /BLOCKED_CONFIRMATION_MISMATCH/);
  });

  it("accepts YP Action flattened supply confirmation and raw JSON MCP success results", async () => {
    const params = { id: "req-supply-yp-action-shape", platform: "xiaohongshu" };
    await recordSearch(params.id);
    const blocked = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__rank_mcns", params, toolCallId: "call-rank-yp-action-1",
    }, {});
    const id = confirmationId(blocked);
    await answerSupplyPlanConfirmation(id, "确认供给方案", true);

    assert.equal(await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__rank_mcns", params, toolCallId: "call-rank-yp-action-2",
    }, {}), undefined);
    await hooks.get("after_tool_call")({
      toolName: "mcp__ypmcn__rank_mcns",
      params,
      toolCallId: "call-rank-yp-action-2",
      result: JSON.stringify({ success: true, data: { mcn_run_id: "mcn-run-yp-action" }, error: null }),
    }, {});

    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.confirmations[id].status, "consumed");
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

  it("blocks forged external summary values and non-exact send options before AskUserQuestion", async () => {
    const { id } = await requestConfirmation(distributionParams({ projectName: "真实外发项目" }));
    const summary = JSON.parse(readFileSync(stateFile, "utf8")).confirmations[id].safe_summary;
    const question = [
      `【外发对象】项目名=伪造项目｜机构数=${summary.supplier_count}`,
      `【外发内容】截止时间=${summary.deadline}｜表单字段=${JSON.stringify(summary.column_names)}`,
      `【固定模板】消息模板=${summary.message_template_id}`,
      `【影响】确认后真实企微外发｜[YP_CONFIRMATION:${id}]`,
    ].join("\n");
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
          question: question.replace("项目名=伪造项目", "项目名=真实外发项目"),
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

  it("reconciles an unknown send outcome before an exact retry", async () => {
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
    assert.equal(await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__create_with_distributions", params, toolCallId: "call-reconcile-send-2",
    }, {}), undefined);
  });

  it("reconciles an unknown rank outcome only for the same requirement", async () => {
    const requirementId = "req-rank-reconcile";
    const params = { id: requirementId, platform: "xiaohongshu" };
    await recordSearch(requirementId);
    const blocked = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__rank_mcns", params, toolCallId: "call-reconcile-rank-1",
    }, {});
    await answerSupplyPlanConfirmation(confirmationId(blocked));
    assert.equal(await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__rank_mcns", params, toolCallId: "call-reconcile-rank-2",
    }, {}), undefined);
    await hooks.get("after_tool_call")({
      toolName: "mcp__ypmcn__rank_mcns",
      params,
      toolCallId: "call-reconcile-rank-2",
      error: new Error("connection lost"),
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
      toolName: "mcp__ypmcn__rank_mcns", params, toolCallId: "call-reconcile-rank-3",
    }, {}), undefined);
  });

  it("expires stale local blockers and supply plans instead of reusing them", async () => {
    const requirementId = "req-expired-plan";
    await recordSearch(requirementId);
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    state.supply_plans[requirementId].expires_at_ms = Date.now() - 1;
    state.blocked_tool_turn = {
      code: "INVALID_INPUT",
      observed_at_ms: Date.now() - 10_000,
      expires_at_ms: Date.now() - 1,
    };
    writeFileSync(stateFile, JSON.stringify(state), "utf8");

    const blocked = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__rank_mcns",
      params: { id: requirementId, platform: "xiaohongshu" },
    }, {});
    assert.match(blocked.blockReason, /INTEGRATION_REQUIRED.*successful search_creators/);
    assert.doesNotMatch(blocked.blockReason, /BLOCKED_PREVIOUS_HOOK_RESULT/);
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
