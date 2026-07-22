import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import plugin, { createYpmcnPlugin, YPMCN_FAST_PATH } from "../dist/index.js";

const tempDir = mkdtempSync(join(tmpdir(), "ypmcn-native-hooks-"));
const DEFAULT_SESSION_KEY = "ypmcn-native-hooks-default";
const DEFAULT_CONTEXT = { sessionKey: DEFAULT_SESSION_KEY };
const defaultSessionHash = createHash("sha256").update(DEFAULT_SESSION_KEY).digest("hex").slice(0, 24);
const stateFile = join(tempDir, "state", "sessions", defaultSessionHash, "confirmation_guard.json");
const hooks = new Map();
const UNRESOLVED_BRIEF = "找5位小红书达人，单达人预算口径待确认，明天提报。";
const contract = JSON.parse(readFileSync(new URL("../../spec/mcp.json", import.meta.url), "utf8"));
const requirementId = (value) => Number(value).toString(16).padStart(32, "0");
const manualCreatorResult = (suffix = "1") => ({
  success: true,
  data: {
    excel_file_path: `/tmp/manual-creators-${suffix}.xlsx`,
    creators: [{
      platform: "xiaohongshu",
      xiaohongshuId: `xhs-${suffix}`,
      nickname: `拓展达人${suffix}`,
      contentTag: "美妆",
      kwUserUrl: `https://example.test/creator/${suffix}`,
    }],
  },
  error: null,
});

const distributionParams = (overrides = {}) => {
  const description = overrides.description ??
    "您好，现招募小红书达人参与测试项目。\n图文报价：5000元以内\n请协助推荐合适人选，谢谢。";
  return {
    requirement_id: requirementId(1),
    columns: [{ key: "creator_name", name: "达人名称" }],
    supplierIds: ["supplier-1"],
    description,
    wechat_notification_message: description,
    ...overrides,
  };
};

before(() => {
  plugin.register({
    rootDir: tempDir,
    logger: { error() {} },
    on(name, handler) { hooks.set(name, handler); },
  });
});

beforeEach(() => {
  rmSync(join(tempDir, "state"), { recursive: true, force: true });
});

after(() => rmSync(tempDir, { recursive: true, force: true }));

function sessionStateFile(sessionKey) {
  const hash = createHash("sha256").update(sessionKey).digest("hex").slice(0, 24);
  return join(tempDir, "state", "sessions", hash, "confirmation_guard.json");
}

async function guard(toolName, params = {}, toolCallId, context = DEFAULT_CONTEXT) {
  return hooks.get("before_tool_call")({ toolName, params, toolCallId }, context);
}

async function recordMcnRecipients(params, context = DEFAULT_CONTEXT, recipientNames) {
  if (!Array.isArray(params.supplierIds) || params.supplierIds.length === 0) return;
  const names = recipientNames ?? params.supplierIds.map((_, index) => `测试MCN ${index + 1}`);
  await recordTool(
    "mcp__ypmcn__validate_requirement",
    { payload: { platform: "xiaohongshu", quantityTotal: 1 } },
    { success: true, data: { id: params.requirement_id }, error: null },
    context,
  );
  await recordTool(
    "mcp__ypmcn__rank_mcns",
    { id: params.requirement_id, platform: "xiaohongshu" },
    {
      success: true,
      data: {
        inquiry_id: "inquiry-recipient-directory",
        demand_count: 1,
        selected_supplier_ids: params.supplierIds,
        selected_mcn_count: params.supplierIds.length,
        coverage_scope: "selected_institutions_deduplicated_union",
        selected_mcn_covered_creator_count: 30,
        selected_mcn_coverage_multiplier: 30,
        selected_mcn_risk_level: "safe",
        manual_sourcing_gap_count: null,
        mcns: params.supplierIds.map((supplierId, index) => ({
          supplier_id: supplierId,
          supplier_name: names[index],
        })),
      },
      error: null,
    },
    context,
  );
}

function askInputFrom(result) {
  assert.equal(result?.block, true);
  assert.match(result.blockReason, /EXTERNAL_SEND_CONFIRMATION_REQUIRED/);
  assert.equal(result.requireApproval, undefined);
  const match = /<AskUserQuestionInput>\n([^\n]+)\n<\/AskUserQuestionInput>/.exec(result.blockReason);
  assert.ok(match, "blocked send must include exact AskUserQuestion arguments");
  const askInput = JSON.parse(match[1]);
  assert.equal(askInput.questions.length, 1);
  assert.equal(askInput.questions[0].header, "企微外发确认");
  assert.deepEqual(askInput.questions[0].options.map(({ label }) => label), ["确认发送", "取消发送"]);
  return askInput;
}

async function requestConfirmation(
  params = distributionParams(),
  context = DEFAULT_CONTEXT,
  toolCallId = "call-send",
  recipientNames,
) {
  await recordMcnRecipients(params, context, recipientNames);
  const result = await guard("mcp__ypmcn__create_with_distributions", params, toolCallId, context);
  return { result, askInput: askInputFrom(result), params, toolCallId, context };
}

async function answerExternalConfirmation(prepared, answer = "确认发送") {
  const question = prepared.askInput.questions[0].question;
  await recordTool("AskUserQuestion", prepared.askInput, {
    content: [{ type: "text", text: `${question}: ${answer}` }],
  }, prepared.context);
}

async function confirmPendingSend(params, toolCallId, context = DEFAULT_CONTEXT) {
  const result = await guard("mcp__ypmcn__create_with_distributions", params, toolCallId, context);
  const prepared = { askInput: askInputFrom(result), params, toolCallId, context };
  await answerExternalConfirmation(prepared);
  assert.equal(
    await guard("mcp__ypmcn__create_with_distributions", params, toolCallId, context),
    undefined,
  );
  return prepared;
}

async function recordTool(toolName, params, result, context = DEFAULT_CONTEXT, toolCallId) {
  await hooks.get("after_tool_call")({ toolName, params, result, toolCallId }, context);
}

async function recordFreshRequirement(requirementId, context = DEFAULT_CONTEXT) {
  await recordTool(
    "mcp__ypmcn__validate_requirement",
    { payload: { platform: "xiaohongshu", quantityTotal: 1 } },
    { success: true, data: { id: requirementId }, error: null },
    context,
  );
}

const preRaceSupply = (overrides = {}) => {
  const candidateCount = overrides.candidate_count ?? 6;
  const quantityTotal = overrides.quantity_total ?? 5;
  const risk = candidateCount < quantityTotal * 20
    ? "high_risk"
    : candidateCount < quantityTotal * 30
      ? "medium_risk"
      : "low_risk";
  return {
    total_matched: overrides.total_matched ?? candidateCount,
    supply_assessment: {
      candidate_count: candidateCount,
      quantity_total: quantityTotal,
      supply_multiplier: overrides.supply_multiplier ?? candidateCount / quantityTotal,
      supply_risk_level: overrides.supply_risk_level ?? risk,
      recommended_action: overrides.recommended_action ?? "continue",
    },
  };
};

const supplyQuestion = {
  questions: [{
    header: "供给确认",
    question: "需求达人数量：5\n刊例资源达人数量：6\n刊例资源倍率：1.2 倍\n赛前风险：高危\n强烈建议先扩充机构或预拓展达人到至少 20 倍。\n\n请选择执行方案。",
    options: ["先扩充机构或预拓展达人", "仍继续MCN赛马"],
  }],
};

const postRaceQuestion = {
  questions: [{
    header: "赛后补量",
    question: "需求达人数量：5\n已选机构数量：2\n已选机构：测试MCN 1、测试MCN 2\n预估机构达人覆盖量：96\n供需倍数：19.2 倍\n赛后风险：高危\n建议手动拓展达人数量：4\n机构承接达人与手动拓展达人比例：5:4\n\n请选择执行方案。",
    options: ["一键发起拓展达人补量", "追加机构后重新计算", "暂不补量，继续询价"],
  }],
};

async function recordHighRiskSupply() {
  await recordTool(
    "mcp__ypmcn__validate_requirement",
    { payload: { platform: "xiaohongshu", quantityTotal: 5 } },
    { success: true, data: { id: requirementId(2) }, error: null },
  );
  await recordTool(
    "mcp__ypmcn__search_creators",
    { id: requirementId(2) },
    { success: true, data: preRaceSupply(), error: null },
  );
}

async function answerSupply(answer) {
  await recordTool("AskUserQuestion", supplyQuestion, {
    status: "submitted",
    answers: [{ selected_labels: [answer] }],
  });
}

async function answerPostRace(answer) {
  await recordTool("AskUserQuestion", postRaceQuestion, {
    status: "submitted",
    answers: [{ selected_labels: [answer] }],
  });
}

async function recordRankForManual(inquiryId = "inquiry-manual-1", overrides = {}) {
  await recordTool(
    "mcp__ypmcn__rank_mcns",
    { id: requirementId(2), platform: "xiaohongshu", minimum_mcn_count: 7 },
    {
      success: true,
      data: {
        inquiry_id: inquiryId,
        demand_count: 5,
        selected_supplier_ids: ["supplier-1", "supplier-2"],
        selected_mcn_count: 2,
        coverage_scope: "selected_institutions_deduplicated_union",
        selected_mcn_covered_creator_count: 96,
        selected_mcn_coverage_multiplier: 19.2,
        selected_mcn_risk_level: "high_risk",
        manual_sourcing_gap_count: 4,
        suppliers: [
          { supplier_id: "supplier-1", supplier_name: "测试MCN 1" },
          { supplier_id: "supplier-2", supplier_name: "测试MCN 2" },
        ],
        ...overrides,
      },
      error: null,
    },
  );
}

describe("YP Action native hooks", () => {
  it("registers the expected runtime hooks", () => {
    assert.deepEqual(
      [...hooks.keys()].sort(),
      ["after_tool_call", "before_prompt_build", "before_tool_call", "session_end"],
    );
  });

  it("injects the local JSON orchestration state and the fresh-ID manual flow", async () => {
    const prompt = await hooks.get("before_prompt_build")({ prompt: UNRESOLVED_BRIEF, messages: [] }, DEFAULT_CONTEXT);
    assert.equal(prompt.prependSystemContext, YPMCN_FAST_PATH);
    assert.match(YPMCN_FAST_PATH, /validate_requirement -> manual_source_creators/);
    assert.match(YPMCN_FAST_PATH, /Manual sourcing may start from any current workflow phase/);
    assert.match(YPMCN_FAST_PATH, /fresh 32-character data\.id primary key[^]*immediately following manual call/);
    assert.match(YPMCN_FAST_PATH, /Do not check whether that requirement was searched before/);
    assert.match(YPMCN_FAST_PATH, /manual_source_creators\(\{requirement_id,size\}\)/);
    assert.match(YPMCN_FAST_PATH, /Immediately render every returned row as one Markdown table/);
    assert.match(YPMCN_FAST_PATH, /workflow\.manual_sourcing_display_marker/);
    assert.match(YPMCN_FAST_PATH, /omit inquiry_id when no prior verified create_with_distributions result returned one/);
    assert.match(YPMCN_FAST_PATH, /Every AskUserQuestion question must contain line breaks/);
    assert.match(YPMCN_FAST_PATH, /机构回填确认/);
    assert.match(YPMCN_FAST_PATH, /age1Rate\.\.age6Rate are direct JSON numbers/);
    assert.match(YPMCN_FAST_PATH, /Xiaohongshu bands are <18, 18–23, 24–29, 30–39, 40–49, and 50\+/);
    assert.match(YPMCN_FAST_PATH, /Douyin bands are <18, 18–23, 24–30, 31–40, 41–50, and 50\+/);
    assert.match(YPMCN_FAST_PATH, /hasOrganization, hasOrder30day, and hasSocial30day are direct JSON booleans/);
    assert.match(YPMCN_FAST_PATH, /skills\/media-assistant\/references\/reference_schema\.json/);
    assert.match(YPMCN_FAST_PATH, /Only a native AskUserQuestion call may request conversational user input/);
    assert.match(YPMCN_FAST_PATH, /must never ask “是否继续”, “要怎么推进”/);
    assert.match(YPMCN_FAST_PATH, /fact summary exposes a decision[^]*same assistant turn/);
    assert.match(YPMCN_FAST_PATH, /submitted AskUserQuestion answer is an executable command/);
    assert.match(YPMCN_FAST_PATH, /Before any nonterminal workflow stop or pause that still requires a human decision/);
    assert.match(YPMCN_FAST_PATH, /host-provided custom-input entry/);
    assert.match(YPMCN_FAST_PATH, /waiting_for="user" means invoke the named native AskUserQuestion gate immediately/);
    assert.match(YPMCN_FAST_PATH, /valid search_creators result continues immediately to rank_mcns/);
    assert.match(YPMCN_FAST_PATH, /manual count and ratio even when the manual count is 0/);
    assert.match(YPMCN_FAST_PATH, /webpage is exclusively user-operated/);
    assert.match(YPMCN_FAST_PATH, /never click, infer, preselect, or submit fields on the user's behalf/);
    assert.match(YPMCN_FAST_PATH, /Do not open another selector while waiting or after success, cancellation, timeout, or invalid callback/);
    assert.match(YPMCN_FAST_PATH, /Never interpret sync_mcn_inquiry_status as WeCom send evidence/);
    assert.match(YPMCN_FAST_PATH, /only from a successful create_with_distributions response containing explicit per-supplier sent details/);
    assert.match(YPMCN_FAST_PATH, /confirm_mcn_selection -> header “MCN确认”/);
    assert.match(YPMCN_FAST_PATH, /never print these as a prose menu/);
    assert.match(YPMCN_FAST_PATH, /including “启动拓展”[^]*manual_source_creators path/);
    assert.match(YPMCN_FAST_PATH, /Brief with both supported platforms is not a platform ambiguity/);
    assert.doesNotMatch(YPMCN_FAST_PATH, /schema\/CSV|customer_demands (?:reference )?CSV/);
    assert.doesNotMatch(YPMCN_FAST_PATH, /max\(quantityTotal-actual count,0\)/);
    assert.match(prompt.prependContext, /authoritative local orchestration state/);
    assert.match(prompt.prependContext, /"next_action":"validate_requirement"/);
    assert.match(prompt.prependContext, /waiting_for=user requires an immediate native AskUserQuestion gate/);
    assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).schema_version, 20);

    for (const [toolName, params] of [
      ["read", { file_path: "/tmp/SKILL.md" }],
      ["AskUserQuestion", {
        questions: [{ header: "供给确认", question: "请核对供给信息：\n请选择下一步。" }],
      }],
      ["mcp__ypmcn__validate_requirement", {
        payload: { rawMessagesJson: { originalBrief: UNRESOLVED_BRIEF } },
      }],
      ["mcp__ypmcn__rank_mcns", { id: "any", platform: "xiaohongshu" }],
    ]) {
      assert.equal(await guard(toolName, params), undefined, toolName);
    }
  });

  it("allows declared business Tools while guarding manual freshness and send confirmation", async () => {
    await hooks.get("before_prompt_build")({ prompt: UNRESOLVED_BRIEF, messages: [] }, DEFAULT_CONTEXT);
    for (const name of [...contract.requiredTools, ...contract.optionalTools]) {
      if ([
        "select_inquiry_form_fields", "sync_mcn_inquiry_status", "rank_creators", "create_submission_batch",
      ].includes(name)) continue;
      let params = name === "create_with_distributions" ? distributionParams() : {};
      if (name === "create_with_distributions") await recordMcnRecipients(params);
      if (name === "validate_requirement") {
        params = { payload: {
          rawMessagesJson: { originalBrief: UNRESOLVED_BRIEF },
        } };
      }
      if (name === "search_creators") {
        params = { id: requirementId(9) };
        await recordFreshRequirement(params.id);
      }
      if (name === "manual_source_creators") {
        params = { requirement_id: requirementId(10), size: "1" };
        await recordFreshRequirement(params.requirement_id);
      }
      const result = await guard(`mcp__ypmcn__${name}`, params);
      if (name === "create_with_distributions") askInputFrom(result);
      else assert.equal(result, undefined, name);
    }
  });

  it("warns without blocking when consecutive rank calls use the same requirement ID", async () => {
    const localHooks = new Map();
    const warnings = [];
    createYpmcnPlugin().register({
      rootDir: tempDir,
      logger: {
        error() {},
        warn(message) { warnings.push(message); },
      },
      on(name, handler) { localHooks.set(name, handler); },
    });
    const rankParams = (requirement_id) => ({
      requirement_id,
      inquiry_id: "31",
    });

    const activeRequirement = requirementId(31);
    await recordFreshRequirement(activeRequirement);
    const sendParams = { requirement_id: activeRequirement, supplierIds: ["supplier-31"] };
    const preparedSend = await requestConfirmation(
      sendParams,
      DEFAULT_CONTEXT,
      "call-rank-warning-send",
      ["测试MCN 31"],
    );
    await answerExternalConfirmation(preparedSend);
    const sendExecutionId = "call-rank-warning-send-execute";
    assert.equal(await guard(
      "mcp__ypmcn__create_with_distributions",
      sendParams,
      sendExecutionId,
    ), undefined);
    await recordTool(
      "mcp__ypmcn__create_with_distributions",
      sendParams,
      {
        success: true,
        data: {
          project_id: "project-31",
          inquiry_id: "31",
          created: [{ supplier_id: "supplier-31", notification_status: "sent" }],
        },
        error: null,
      }, DEFAULT_CONTEXT, sendExecutionId,
    );
    assert.equal(await guard("mcp__ypmcn__sync_mcn_inquiry_status", {
      requirement_id: activeRequirement,
      project_id: "project-31",
      supplierIds: ["supplier-31"],
    }, "call-valid-sync-lineage"), undefined);
    let syncState = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(syncState.workflow.sync_call_order_status, "authorized_after_wecom_send");
    assert.equal(syncState.workflow.sync_after_wecom_send, true);
    await recordTool(
      "mcp__ypmcn__sync_mcn_inquiry_status",
      { requirement_id: activeRequirement, project_id: "project-31", supplierIds: ["supplier-31"] },
      { success: true, data: { inquiry_id: 31 }, error: null },
    );
    syncState = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(syncState.workflow.sync_call_order_status, "completed_after_wecom_send");
    assert.equal(syncState.workflow.sync_after_wecom_send, true);
    await recordTool(
      "mcp__ypmcn__ingest_mcn_submissions",
      { inquiry_ids: ["31"] },
      { success: true, data: { ingested: 1 }, error: null },
    );

    for (let index = 0; index < 2; index += 1) {
      assert.equal(await localHooks.get("before_tool_call")({
        toolName: "mcp__ypmcn__rank_creators",
        params: rankParams(activeRequirement),
      }, DEFAULT_CONTEXT), undefined);
    }

    assert.deepEqual(warnings, ["已根据需求进行排序，请注意"]);
    const persisted = readFileSync(stateFile, "utf8");
    assert.match(persisted, /"last_rank_creators_requirement_id_sha256": "[0-9a-f]{64}"/);
    assert.doesNotMatch(persisted, /requirement-repeat/);
  });

  it("requires and consumes the immediately preceding fresh requirement ID for every manual call", async () => {
    const withoutParse = await guard(
      "mcp__ypmcn__manual_source_creators",
      { requirement_id: "1784689136279241", size: "3" },
    );
    assert.equal(withoutParse?.block, true);
    assert.match(withoutParse.blockReason, /INVALID_INPUT.*data\.id/);

    await recordFreshRequirement(requirementId(11));
    const mismatched = await guard(
      "mcp__ypmcn__manual_source_creators",
      { requirement_id: requirementId(12), size: "3" },
    );
    assert.equal(mismatched?.block, true);
    assert.match(mismatched.blockReason, /immediately preceding successful validate_requirement/);
    const expiredAfterMismatch = await guard(
      "mcp__ypmcn__manual_source_creators",
      { requirement_id: requirementId(11), size: "3" },
    );
    assert.equal(expiredAfterMismatch?.block, true);

    await recordFreshRequirement(requirementId(13));
    assert.equal(await guard(
      "mcp__ypmcn__manual_source_creators",
      { requirement_id: requirementId(13), size: "3" },
    ), undefined);
    const replay = await guard(
      "mcp__ypmcn__manual_source_creators",
      { requirement_id: requirementId(13), size: "3" },
    );
    assert.equal(replay?.block, true);

    await recordFreshRequirement(requirementId(14));
    await recordTool(
      "mcp__ypmcn__get_creator_detail",
      { creator_id: "creator-1" },
      { success: true, data: {}, error: null },
    );
    const intervened = await guard(
      "mcp__ypmcn__manual_source_creators",
      { requirement_id: requirementId(14), size: "3" },
    );
    assert.equal(intervened?.block, true);

    await recordTool(
      "mcp__ypmcn__record_client_feedback",
      {},
      { success: true, data: {}, error: null },
    );
    let state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.phase, "feedback_routing");
    await recordFreshRequirement(requirementId(15));
    assert.equal(await guard(
      "mcp__ypmcn__manual_source_creators",
      { requirement_id: requirementId(15), size: "3" },
    ), undefined);

    state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.manual_sourcing_requirement_receipt.status, "consumed");
    assert.equal(state.manual_sourcing_requirement_receipt.requirement_id, undefined);
    assert.notEqual(
      state.manual_sourcing_requirement_receipt.requirement_id_sha256,
      requirementId(15),
    );
  });

  it("rejects demand_id values without consuming a correctable primary-key receipt", async () => {
    const freshId = requirementId(40);
    await recordFreshRequirement(freshId);
    const badSearchEvent = {
      toolName: "mcp__ypmcn__search_creators",
      params: { id: "1784689136279241" },
      toolCallId: "call-bad-search-id",
    };
    const badSearch = await hooks.get("before_tool_call")(badSearchEvent, DEFAULT_CONTEXT);
    assert.equal(badSearch.errorCode, "INVALID_INPUT");
    assert.match(badSearch.blockReason, /data\.demand_id/);
    await hooks.get("after_tool_call")({ ...badSearchEvent, error: badSearch.blockReason }, DEFAULT_CONTEXT);
    let state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.search_requirement_receipt.status, "fresh");
    assert.equal(await guard("mcp__ypmcn__search_creators", { id: freshId }, "call-correct-search-id"), undefined);

    const manualId = requirementId(41);
    await recordFreshRequirement(manualId);
    const badManualEvent = {
      toolName: "mcp__ypmcn__manual_source_creators",
      params: { requirement_id: "1784689136279241", size: "3" },
      toolCallId: "call-bad-manual-id",
    };
    const badManual = await hooks.get("before_tool_call")(badManualEvent, DEFAULT_CONTEXT);
    assert.equal(badManual.errorCode, "INVALID_INPUT");
    await hooks.get("after_tool_call")({ ...badManualEvent, error: badManual.blockReason }, DEFAULT_CONTEXT);
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.manual_sourcing_requirement_receipt.status, "fresh");
    assert.equal(await guard(
      "mcp__ypmcn__manual_source_creators",
      { requirement_id: manualId, size: "3" },
      "call-correct-manual-id",
    ), undefined);
  });

  it("uses the plugin-owned one-time receipt when before_tool_call omits session context", async () => {
    const freshId = "8cb51faafd0b4e01b54cb4dbee1aa64f";
    await recordFreshRequirement(freshId, DEFAULT_CONTEXT);
    const event = {
      toolName: "mcp__ypmcn__manual_source_creators",
      params: { requirement_id: freshId, size: "10" },
      toolCallId: "call-asymmetric-manual",
    };
    assert.equal(await hooks.get("before_tool_call")(event, {}), undefined);
    const replay = await hooks.get("before_tool_call")({ ...event, toolCallId: "call-asymmetric-replay" }, {});
    assert.equal(replay.errorCode, "INVALID_PHASE");

    const globalState = JSON.parse(readFileSync(join(tempDir, "state", "confirmation_guard.json"), "utf8"));
    assert.equal(globalState.manual_sourcing_requirement_receipt.status, "consumed");
  });

  it("blocks only provider send bypasses through shell", async () => {
    const blocked = await guard("bash", {
      command: "curl -X POST https://provider.invalid/api/projects/create-with-distributions",
    });
    assert.equal(blocked?.block, true);
    assert.match(blocked.blockReason, /INTEGRATION_REQUIRED/);
    assert.equal(await guard("bash", { command: "rg create_with_distributions YPmcn/README.md" }), undefined);
  });

  it("requires multiline non-option text in every AskUserQuestion prompt", async () => {
    const singleLine = await guard("AskUserQuestion", {
      questions: [{
        header: "测试确认",
        question: "请选择下一步？",
        options: ["继续", "停止"],
      }],
    });
    assert.equal(singleLine.errorCode, "INVALID_INPUT");
    assert.match(singleLine.blockReason, /multiline prompt text/);

    assert.equal(await guard("AskUserQuestion", {
      questions: [{
        header: "测试确认",
        question: "请核对以下信息：\n请选择下一步？",
        options: ["继续", "停止"],
      }],
    }), undefined);
  });

  it("binds a multiline AskUserQuestion warning to the exact send parameters", async () => {
    const prepared = await requestConfirmation(distributionParams({
      supplierIds: ["supplier-1", "supplier-2"],
      columns: [
        { key: "platform", name: "平台（xiaohongshu / douyin）" },
        { key: "kwUid", name: "达人 ID" },
      ],
      description: "您好，想邀请贵司参与真实企微消息项目。\n请协助推荐合适达人。",
    }), DEFAULT_CONTEXT, "call-send", ["星图文化", "青禾传媒"]);
    const question = prepared.askInput.questions[0].question;
    assert.match(question, /^⚠️ 不可逆企微外发\n\n/);
    assert.match(question, /确认后将立即向 2 家机构/);
    assert.match(question, /企微群聊绑定校验；仅向已绑定的机构发送，未绑定的机构不会发送并会在结果中列出/);
    assert.match(question, /发送对象（2 家）\n1\. 星图文化\n2\. 青禾传媒/);
    assert.match(question, /回填字段\n- 平台（xiaohongshu \/ douyin）\n- 达人 ID/);
    assert.match(question, /企微消息正文\n────────\n您好[^]*\n请协助推荐合适达人。\n────────/);
    assert.match(question, /是否确认立即发送？$/);
    assert.match(
      prepared.askInput.questions[0].options[0].description,
      /仅向已绑定机构发送并返回未绑定名单/,
    );

    let state = JSON.parse(readFileSync(stateFile, "utf8"));
    let receipt = state.confirmations[state.latest_external_confirmation_id];
    assert.equal(receipt.status, "pending");
    assert.equal(receipt.confirmation_mode, "ask_user_question");
    assert.equal(state.workflow.wecom_confirmation_status, "popup_required");
    assert.equal(state.workflow.wecom_confirmation_user_prompted, false);
    assert.equal(state.workflow.wecom_confirmation_user_approved, false);

    await answerExternalConfirmation(prepared);
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    receipt = state.confirmations[state.latest_external_confirmation_id];
    assert.equal(receipt.status, "approved");
    assert.equal(state.workflow.wecom_confirmation_status, "approved");
    assert.equal(state.workflow.wecom_confirmation_user_prompted, true);
    assert.equal(state.workflow.wecom_confirmation_user_approved, true);

    const executionToolCallId = "call-send-execute";
    assert.equal(await guard(
      "mcp__ypmcn__create_with_distributions",
      prepared.params,
      executionToolCallId,
    ), undefined);
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    receipt = state.confirmations[state.latest_external_confirmation_id];
    assert.equal(receipt.status, "in_flight");
    assert.equal(receipt.tool_call_id, executionToolCallId);
    assert.equal(state.workflow.wecom_confirmation_status, "in_flight");

    await recordTool(
      "mcp__ypmcn__create_with_distributions",
      prepared.params,
      {
        success: true,
        data: {
          project_id: "project-1",
          created: [
            { supplier_id: "supplier--1", notification_status: "sent" },
            { supplier_id: "supplier--2", notification_status: "sent" },
          ],
        },
        error: null,
      },
      DEFAULT_CONTEXT,
      executionToolCallId,
    );
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.confirmations[state.latest_external_confirmation_id].status, "consumed");
    assert.equal(state.workflow.wecom_confirmation_status, "consumed");
    assert.equal(state.workflow.wecom_confirmation_user_prompted, true);
    assert.equal(state.workflow.wecom_confirmation_user_approved, true);
    assert.equal(state.workflow.phase, "waiting_mcn_return");
    assert.equal(state.workflow.distribution_outcome_status, "all_sent");
    assert.equal(state.workflow.sent_supplier_count, 2);
    assert.equal(state.workflow.unbound_supplier_count, 0);
    assert.equal(state.workflow.distribution_send_evidence_status, "valid");
    assert.equal(state.workflow.distribution_send_evidence_tool, "create_with_distributions");
    assert.equal(state.workflow.distribution_sent_detail_count, 2);
  });

  it("refuses to record a successful send result without a matching final popup confirmation", async () => {
    const params = distributionParams({ requirement_id: requirementId(91) });
    await recordTool(
      "mcp__ypmcn__create_with_distributions",
      params,
      {
        success: true,
        data: {
          project_id: "project-unconfirmed",
          created: [{ supplier_id: "supplier-1", notification_status: "sent" }],
        },
        error: null,
      },
      DEFAULT_CONTEXT,
      "call-unconfirmed-send",
    );
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.last_tool_status, "failed");
    assert.equal(state.workflow.wecom_confirmation_status, "missing");
    assert.equal(state.workflow.wecom_confirmation_user_prompted, false);
    assert.equal(state.workflow.wecom_confirmation_user_approved, false);
    assert.equal(state.workflow.distribution_outcome_error, "missing_matching_user_confirmation_receipt");
    assert.equal(state.workflow.sent_supplier_count, undefined);
    assert.equal(state.workflow.distribution_send_evidence_status, "invalid");
  });

  it("never treats sync output as WeCom send evidence or advances without send details", async () => {
    const activeRequirement = requirementId(90);
    await recordFreshRequirement(activeRequirement);
    const blocked = await guard("mcp__ypmcn__sync_mcn_inquiry_status", {
      requirement_id: activeRequirement,
      project_id: "project-fake-sync",
      supplierIds: ["supplier-fake-sync"],
    }, "call-fake-sync-preflight");
    assert.equal(blocked.errorCode, "INVALID_PHASE");
    assert.match(blocked.blockReason, /prior successful create_with_distributions[^]*Sync output is never WeCom send evidence/);
    await recordTool(
      "mcp__ypmcn__sync_mcn_inquiry_status",
      {
        requirement_id: activeRequirement,
        project_id: "project-fake-sync",
        supplierIds: ["supplier-fake-sync"],
      },
      {
        success: true,
        data: {
          inquiry_id: "inquiry-fake-sync",
          sent_supplier_ids: ["supplier-fake-sync"],
          notification_status: "sent",
        },
        error: null,
      },
    );
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.last_tool_status, "failed");
    assert.equal(state.workflow.sync_call_order_status, "blocked_missing_matching_wecom_send");
    assert.equal(state.workflow.sync_after_wecom_send, false);
    assert.equal(state.workflow.next_action, "recover_sync_mcn_inquiry_status");
    assert.equal(
      state.workflow.inquiry_sync_evidence_error,
      "missing_matching_create_with_distributions_send_details",
    );
    assert.equal(state.workflow.sent_supplier_count, undefined);
    assert.equal(state.workflow.distribution_supplier_statuses, undefined);
    assert.equal(state.workflow.distribution_send_evidence_status, undefined);
    assert.equal(state.workflow.sync_inquiry_ids, undefined);
  });

  it("keeps partial group-binding outcomes explicit and rejects generic send success", async () => {
    const partial = await requestConfirmation(distributionParams({
      supplierIds: ["supplier-1", "supplier-2"],
    }), DEFAULT_CONTEXT, "call-partial-binding", ["星图文化", "青禾传媒"]);
    await answerExternalConfirmation(partial);
    const partialExecutionId = "call-partial-binding-execute";
    assert.equal(await guard(
      "mcp__ypmcn__create_with_distributions",
      partial.params,
      partialExecutionId,
    ), undefined);
    await recordTool(
      "mcp__ypmcn__create_with_distributions",
      partial.params,
      {
        success: true,
        data: {
          project_id: "project-partial",
          created: [
            { supplier_id: "supplier-1", notification_status: "sent" },
            {
              supplier_id: "supplier-2",
              notification_status: "skipped",
              notification_error: "供应商未绑定企业微信群聊",
            },
          ],
        },
        error: null,
      },
      DEFAULT_CONTEXT,
      partialExecutionId,
    );
    let state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.phase, "waiting_mcn_return");
    assert.equal(state.workflow.next_action, "sync_mcn_inquiry_status");
    assert.equal(state.workflow.distribution_outcome_status, "partial");
    assert.equal(state.workflow.sent_supplier_count, 1);
    assert.equal(state.workflow.unbound_supplier_count, 1);

    rmSync(join(tempDir, "state"), { recursive: true, force: true });
    const ambiguous = await requestConfirmation(
      distributionParams({ requirement_id: requirementId(20) }),
      DEFAULT_CONTEXT,
      "call-ambiguous-send",
    );
    await answerExternalConfirmation(ambiguous);
    const ambiguousExecutionId = "call-ambiguous-send-execute";
    assert.equal(await guard(
      "mcp__ypmcn__create_with_distributions",
      ambiguous.params,
      ambiguousExecutionId,
    ), undefined);
    await recordTool(
      "mcp__ypmcn__create_with_distributions",
      ambiguous.params,
      {
        success: true,
        data: {
          project_id: "project-ambiguous",
          sent_supplier_ids: ambiguous.params.supplierIds,
        },
        error: null,
      },
      DEFAULT_CONTEXT,
      ambiguousExecutionId,
    );
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.last_tool_status, "failed");
    assert.equal(state.workflow.next_action, "recover_create_with_distributions");
    assert.equal(state.workflow.distribution_outcome_status, "incomplete");
    assert.equal(state.workflow.sent_supplier_count, undefined);
  });

  it("treats a batch group-mapping rejection as partial and sends the remaining MCNs individually", async () => {
    const supplierIds = [
      "supplier-1", "supplier-2", "supplier-3", "supplier-4", "supplier-5",
    ];
    const prepared = await requestConfirmation(distributionParams({ supplierIds }), DEFAULT_CONTEXT, "call-five-suppliers", [
      "星图文化", "青禾传媒", "未绑定机构", "光合传媒", "远山文化",
    ]);
    await answerExternalConfirmation(prepared);
    const initialExecutionId = "call-five-suppliers-execute";
    assert.equal(await guard(
      "mcp__ypmcn__create_with_distributions",
      prepared.params,
      initialExecutionId,
    ), undefined);
    await recordTool(
      "mcp__ypmcn__create_with_distributions",
      prepared.params,
      {
        success: false,
        data: {
          unbound_suppliers: [{
            supplier_name: "未绑定机构",
          }],
        },
        error: "供应商未绑定企业微信群聊，项目事务未创建",
      },
      DEFAULT_CONTEXT,
      initialExecutionId,
    );

    let state = JSON.parse(readFileSync(stateFile, "utf8"));
    const continuation = state.confirmations[state.latest_external_confirmation_id];
    assert.equal(continuation.confirmation_mode, "ask_user_question");
    assert.equal(continuation.status, "pending");
    assert.equal(state.workflow.wecom_confirmation_status, "popup_required");
    assert.equal(state.workflow.distribution_outcome_status, "fallback_in_progress");
    assert.equal(state.workflow.next_action, "fallback_send_next_individual_mcn");
    assert.equal(state.workflow.waiting_for, null);
    assert.equal(state.workflow.requested_supplier_count, 5);
    assert.equal(state.workflow.unbound_supplier_count, 1);
    assert.deepEqual(
      state.workflow.distribution_supplier_statuses.map(({ status }) => status),
      ["pending", "pending", "unbound", "pending", "pending"],
    );
    const persistedContinuation = readFileSync(stateFile, "utf8");
    assert.doesNotMatch(persistedContinuation, /supplier-[1-5]/);
    assert.doesNotMatch(persistedContinuation, /现招募小红书达人/);

    for (const supplierId of supplierIds.filter((id) => id !== "supplier-3")) {
      const retryParams = { ...prepared.params, supplierIds: [supplierId] };
      const retryExecutionId = `call-individual-${supplierId}`;
      await confirmPendingSend(retryParams, retryExecutionId);
      await recordTool(
        "mcp__ypmcn__create_with_distributions",
        retryParams,
        {
          success: true,
          data: {
            project_id: `project-${supplierId}`,
            created: [{ supplier_id: supplierId, notification_status: "sent" }],
          },
          error: null,
        },
        DEFAULT_CONTEXT,
        retryExecutionId,
      );
    }
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.confirmations[state.latest_external_confirmation_id].status, "consumed");
    assert.equal(state.workflow.phase, "waiting_mcn_return");
    assert.equal(state.workflow.next_action, "sync_sent_mcn_inquiry_status_individually");
    assert.equal(state.workflow.distribution_outcome_status, "partial_individual");
    assert.equal(state.workflow.requested_supplier_count, 5);
    assert.equal(state.workflow.sent_supplier_count, 4);
    assert.equal(state.workflow.unbound_supplier_count, 1);
  });

  it("falls back from a definite no-write batch failure to individual sends and records each MCN outcome", async () => {
    const supplierIds = ["supplier-1", "supplier-2", "supplier-3"];
    const prepared = await requestConfirmation(
      distributionParams({ supplierIds }),
      DEFAULT_CONTEXT,
      "call-batch-fallback",
      ["星图文化", "青禾传媒", "远山文化"],
    );
    await answerExternalConfirmation(prepared);
    const batchExecutionId = "call-batch-fallback-execute";
    assert.equal(await guard(
      "mcp__ypmcn__create_with_distributions",
      prepared.params,
      batchExecutionId,
    ), undefined);
    await recordTool(
      "mcp__ypmcn__create_with_distributions",
      prepared.params,
      { success: false, data: null, error: "批量发送失败，事务未创建" },
      DEFAULT_CONTEXT,
      batchExecutionId,
    );

    let state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.distribution_outcome_status, "fallback_in_progress");
    assert.equal(state.workflow.next_action, "fallback_send_next_individual_mcn");
    assert.deepEqual(
      state.workflow.distribution_supplier_statuses.map(({ status }) => status),
      ["pending", "pending", "pending"],
    );
    assert.doesNotMatch(readFileSync(stateFile, "utf8"), /supplier-[1-3]/);

    const individualResults = [
      {
        success: true,
        data: {
          project_id: "project-supplier-1",
          created: [{ supplier_id: "supplier-1", notification_status: "sent" }],
        },
        error: null,
      },
      { success: false, data: null, error: "单个机构发送失败，事务未创建" },
      {
        success: true,
        data: {
          created: [{
            supplier_id: "supplier-3",
            notification_status: "skipped",
            notification_error: "供应商未绑定企业微信群聊",
          }],
        },
        error: null,
      },
    ];
    for (let index = 0; index < supplierIds.length; index += 1) {
      const params = { ...prepared.params, supplierIds: [supplierIds[index]] };
      const executionId = `call-individual-fallback-${index + 1}`;
      await confirmPendingSend(params, executionId);
      await recordTool(
        "mcp__ypmcn__create_with_distributions",
        params,
        individualResults[index],
        DEFAULT_CONTEXT,
        executionId,
      );
    }

    state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.distribution_outcome_status, "partial_individual");
    assert.equal(state.workflow.next_action, "sync_sent_mcn_inquiry_status_individually");
    assert.equal(state.workflow.sent_supplier_count, 1);
    assert.equal(state.workflow.failed_supplier_count, 1);
    assert.equal(state.workflow.unbound_supplier_count, 1);
    assert.equal(state.workflow.unknown_supplier_count, 0);
    assert.deepEqual(
      state.workflow.distribution_supplier_statuses.map(({ status }) => status),
      ["sent", "failed", "unbound"],
    );
    assert.equal(state.workflow.distribution_supplier_statuses[0].project_id, "project-supplier-1");
    const duplicate = await guard(
      "mcp__ypmcn__create_with_distributions",
      { ...prepared.params, supplierIds: ["supplier-1"] },
      "call-individual-fallback-duplicate",
    );
    assert.equal(duplicate.block, true);
    assert.match(duplicate.blockReason, /状态已记录为 sent，禁止重复发送/);
  });

  it("accepts an exact echoed confirmation when the host depth-truncates popup params", async () => {
    const prepared = await requestConfirmation(distributionParams(), DEFAULT_CONTEXT, "call-truncated-popup");
    const truncatedInput = structuredClone(prepared.askInput);
    truncatedInput.questions[0].options = ["[truncated-depth]", "[truncated-depth]"];
    const question = prepared.askInput.questions[0].question;

    await recordTool("AskUserQuestion", truncatedInput, {
      content: [{ type: "text", text: `${question}: 确认发送` }],
    });

    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.confirmations[state.latest_external_confirmation_id].status, "approved");
    assert.equal(await guard(
      "mcp__ypmcn__create_with_distributions",
      prepared.params,
      "call-truncated-popup-execute",
    ), undefined);
  });

  it("keeps the confirmation gate usable when the host omits session context", async () => {
    const params = distributionParams();
    const blocked = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__create_with_distributions",
      params,
      toolCallId: "call-unscoped-send",
    }, {});
    const askInput = askInputFrom(blocked);
    await recordTool("AskUserQuestion", askInput, {
      content: [{ type: "text", text: `${askInput.questions[0].question}: 确认发送` }],
    }, {});
    assert.equal(await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__create_with_distributions",
      params,
      toolCallId: "call-unscoped-send-execute",
    }, {}), undefined);
  });

  it("uses one exact local receipt when before_tool_call loses session context after approval", async () => {
    const prepared = await requestConfirmation(
      distributionParams(),
      DEFAULT_CONTEXT,
      "call-sessionless-handoff-popup",
    );
    await answerExternalConfirmation(prepared);
    const executionToolCallId = "call-sessionless-handoff-execute";
    assert.equal(await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__create_with_distributions",
      params: prepared.params,
      toolCallId: executionToolCallId,
    }, {}), undefined);

    await hooks.get("after_tool_call")({
      toolName: "mcp__ypmcn__create_with_distributions",
      params: prepared.params,
      toolCallId: executionToolCallId,
      result: {
        success: true,
        data: {
          project_id: "project-sessionless-handoff",
          created: [{ supplier_id: "supplier-1", notification_status: "sent" }],
        },
        error: null,
      },
    }, {});

    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.confirmations[state.latest_external_confirmation_id].status, "consumed");
    assert.equal(state.workflow.distribution_send_evidence_status, "valid");
    assert.equal(state.workflow.project_id, "project-sessionless-handoff");
  });

  it("fails closed when missing session context makes matching approvals ambiguous", async () => {
    const params = distributionParams();
    const first = await requestConfirmation(params, { sessionKey: "ambiguous-send-a" }, "call-ambiguous-a");
    await answerExternalConfirmation(first);
    const second = await requestConfirmation(params, { sessionKey: "ambiguous-send-b" }, "call-ambiguous-b");
    await answerExternalConfirmation(second);

    const blocked = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__create_with_distributions",
      params,
      toolCallId: "call-ambiguous-execute",
    }, {});
    assert.equal(blocked.block, true);
    assert.equal(blocked.errorCode, "INTEGRATION_REQUIRED");
    assert.match(blocked.blockReason, /multiple matching local confirmation receipts/);
  });

  it("keeps the full multiline WeCom message in the scrollable AskUserQuestion body", async () => {
    const message = `您好，现有以下合作需求：\n${"长消息".repeat(300)}\n以上为完整消息结尾。`;
    const prepared = await requestConfirmation(distributionParams({
      description: message,
    }), DEFAULT_CONTEXT, "call-long-preview");
    const question = prepared.askInput.questions[0].question;
    assert.ok(Array.from(question).length > 256);
    assert.ok(question.includes(message));
    assert.doesNotMatch(question, /消息结尾。…/);
  });

  it("resolves available MCN names and allows recipients without names", async () => {
    const params = distributionParams({ supplierIds: ["supplier-1", "supplier-2"] });
    await recordMcnRecipients(params, DEFAULT_CONTEXT, ["星图文化", "青禾传媒"]);

    const confirmation = await guard("mcp__ypmcn__create_with_distributions", params, "call-shaped-result");
    assert.match(askInputFrom(confirmation).questions[0].question, /1\. 星图文化\n2\. 青禾传媒/);

    const unknownParams = { ...params, supplierIds: ["supplier-1", "supplier-unverified"] };
    await recordMcnRecipients(unknownParams, DEFAULT_CONTEXT, ["星图文化", undefined]);
    const unknownRecipient = await guard(
      "mcp__ypmcn__create_with_distributions",
      unknownParams,
      "call-unverified-recipient",
    );
    assert.equal(unknownRecipient.block, true);
    assert.match(askInputFrom(unknownRecipient).questions[0].question, /1\. 星图文化\n2\. 名称未提供/);

    const staleRequirement = await guard(
      "mcp__ypmcn__create_with_distributions",
      { ...params, requirement_id: requirementId(21) },
      "call-stale-requirement",
    );
    assert.equal(staleRequirement.block, true);
  });

  it("keeps a rejected AskUserQuestion send unsent and allows a revised confirmation", async () => {
    const prepared = await requestConfirmation(distributionParams({
      supplierIds: ["supplier-1", "supplier-2"],
    }), DEFAULT_CONTEXT, "call-reject-and-edit", ["星图文化", "青禾传媒"]);
    await answerExternalConfirmation(prepared, "取消发送");

    const deniedState = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(deniedState.confirmations[deniedState.latest_external_confirmation_id].status, "denied");

    const revisedParams = {
      ...prepared.params,
      supplierIds: ["supplier-2"],
      description: "您好，这是修改后的企微消息。",
    };
    await recordMcnRecipients(revisedParams, DEFAULT_CONTEXT, ["青禾传媒"]);
    const revised = await guard(
      "mcp__ypmcn__create_with_distributions",
      revisedParams,
      "call-revised-send",
    );
    const revisedQuestion = askInputFrom(revised).questions[0].question;
    assert.match(revisedQuestion, /发送对象（1 家）\n1\. 青禾传媒/);
    assert.match(revisedQuestion, /修改后的企微消息/);
  });

  it("does not authorize cancellation, host denial, tool error, a modified popup, or changed parameters", async () => {
    const cancelled = await requestConfirmation(distributionParams({ requirement_id: requirementId(22) }));
    await answerExternalConfirmation(cancelled, "取消发送");
    askInputFrom(await guard(
      "mcp__ypmcn__create_with_distributions",
      cancelled.params,
      "call-cancel-retry",
    ));

    rmSync(join(tempDir, "state"), { recursive: true, force: true });
    const denied = await requestConfirmation(distributionParams({ requirement_id: requirementId(23) }));
    await recordTool("AskUserQuestion", denied.askInput, {
      content: [{ type: "text", text: "User denied the operation." }],
    });
    let state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.confirmations[state.latest_external_confirmation_id].status, "denied");

    rmSync(join(tempDir, "state"), { recursive: true, force: true });
    const failedTool = await requestConfirmation(distributionParams({ requirement_id: requirementId(24) }));
    await recordTool("AskUserQuestion", failedTool.askInput, {
      isError: true,
      answers: [{ selected_labels: ["确认发送"] }],
    });
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.confirmations[state.latest_external_confirmation_id].status, "denied");

    rmSync(join(tempDir, "state"), { recursive: true, force: true });
    const modifiedPopup = await requestConfirmation(distributionParams({ requirement_id: requirementId(25) }));
    const changedAskInput = structuredClone(modifiedPopup.askInput);
    changedAskInput.questions[0].question += "\n额外内容";
    await recordTool("AskUserQuestion", changedAskInput, {
      content: [{ type: "text", text: `${changedAskInput.questions[0].question}: 确认发送` }],
    });
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.confirmations[state.latest_external_confirmation_id].status, "pending");
    askInputFrom(await guard(
      "mcp__ypmcn__create_with_distributions",
      modifiedPopup.params,
      "call-modified-retry",
    ));

    rmSync(join(tempDir, "state"), { recursive: true, force: true });
    const first = await requestConfirmation(distributionParams({
      supplierIds: ["supplier-1", "supplier-2"],
    }), DEFAULT_CONTEXT, "call-original", ["星图文化", "青禾传媒"]);
    await answerExternalConfirmation(first);
    await recordMcnRecipients(
      { ...first.params, supplierIds: ["supplier-2"] },
      DEFAULT_CONTEXT,
      ["青禾传媒"],
    );
    const changed = await guard(
      "mcp__ypmcn__create_with_distributions",
      { ...first.params, supplierIds: ["supplier-2"] },
      "call-changed",
    );
    const changedQuestion = askInputFrom(changed).questions[0].question;
    assert.match(changedQuestion, /发送对象（1 家）\n1\. 青禾传媒/);
    assert.doesNotMatch(changedQuestion, /1\. 星图文化/);
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.ok(Object.values(state.confirmations).some((item) =>
      item.status === "denied" && item.resolution === "superseded"
    ));
    const staleOriginal = await guard(
      "mcp__ypmcn__create_with_distributions",
      first.params,
      "call-stale-original",
    );
    assert.equal(staleOriginal?.block, true);
    assert.match(staleOriginal.blockReason, /机构集合.*不一致/);
  });

  it("requires a fresh AskUserQuestion confirmation after success or unknown result", async () => {
    for (const [index, eventResult] of [
      [0, { success: true, data: {}, error: null }],
      [1, undefined],
    ]) {
      const params = distributionParams({ requirement_id: `requirement-replay-${index}` });
      const prepared = await requestConfirmation(params, DEFAULT_CONTEXT, `call-replay-${index}`);
      await answerExternalConfirmation(prepared);
      const executionId = `call-replay-${index}-execute`;
      assert.equal(await guard("mcp__ypmcn__create_with_distributions", params, executionId), undefined);
      if (eventResult) {
        await recordTool("mcp__ypmcn__create_with_distributions", params, eventResult, DEFAULT_CONTEXT, executionId);
      } else {
        await hooks.get("after_tool_call")({
          toolName: "mcp__ypmcn__create_with_distributions",
          params,
          toolCallId: executionId,
          error: "connection lost",
        }, DEFAULT_CONTEXT);
      }
      askInputFrom(await guard(
        "mcp__ypmcn__create_with_distributions",
        params,
        `call-replay-${index}-next`,
      ));
      rmSync(join(tempDir, "state"), { recursive: true, force: true });
    }
  });

  it("keeps the exact post-race manual quantity but completes the MCN branch before sourcing", async () => {
    const validateInput = { payload: { platform: "xiaohongshu", quantityTotal: 5 } };
    await recordTool(
      "mcp__ypmcn__validate_requirement",
      validateInput,
      { success: true, data: { id: requirementId(2) }, error: null },
    );
    let state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.deepEqual(
      [state.workflow.phase, state.workflow.next_action, state.workflow.requirement_id],
      ["requirement_ready", "search_creators", requirementId(2)],
    );

    await recordTool(
      "mcp__ypmcn__search_creators",
      { id: requirementId(2) },
      { success: true, data: preRaceSupply(), error: null },
    );
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.next_action, "rank_mcns");
    assert.equal(state.workflow.waiting_for, null);
    assert.equal(state.workflow.pre_race_rate_card_creator_count, 6);
    assert.equal(state.workflow.pre_race_rate_card_multiplier, 1.2);
    assert.equal(state.workflow.pre_race_risk_level, "high_risk");
    assert.equal(state.workflow.pre_race_supply_status, "valid");
    assert.equal(state.workflow.pending_manual_target_count, undefined);
    assert.equal(state.workflow.post_race_manual_sourcing_gap_count, undefined);

    await answerSupply("仍继续MCN赛马");
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.next_action, "rank_mcns");
    assert.equal(state.workflow.pending_manual_target_count, undefined);
    assert.equal(state.workflow.waiting_for, null);

    await recordRankForManual();
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.phase, "mcn_planning");
    assert.equal(state.workflow.mcn_race_size, 7);
    assert.equal(state.workflow.rank_mcn_inquiry_id, "inquiry-manual-1");
    assert.equal(state.workflow.rank_mcn_inquiry_evidence_status, "valid");
    assert.equal(state.workflow.post_race_selected_mcn_covered_creator_count, 96);
    assert.equal(state.workflow.post_race_selected_mcn_coverage_multiplier, 19.2);
    assert.equal(state.workflow.post_race_risk_level, "high_risk");
    assert.equal(state.workflow.post_race_manual_sourcing_gap_count, 4);
    assert.equal(state.workflow.post_race_institution_manual_creator_ratio, "5:4");
    assert.equal(state.workflow.next_action, "confirm_post_race_manual_sourcing");
    assert.equal(state.workflow.pending_manual_target_count, undefined);
    assert.equal(state.workflow.waiting_for, "user");

    await answerPostRace("一键发起拓展达人补量");
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.next_action, "confirm_mcn_selection");
    assert.equal(state.workflow.pending_manual_target_count, 4);
    assert.equal(state.workflow.manual_sourcing_after_mcn_flow, true);
    assert.equal(state.workflow.waiting_for, "user");
    const blockedEarlyManual = await guard("mcp__ypmcn__manual_source_creators", {
      requirement_id: requirementId(2), size: "4",
    });
    assert.equal(blockedEarlyManual.errorCode, "INVALID_PHASE");
    assert.match(blockedEarlyManual.blockReason, /Complete rank_mcns[^]*field selection[^]*WeCom distribution[^]*sync/);
    assert.ok(state.workflow_events.length >= 4);
  });

  it("parses current search supply evidence and rejects the retired legacy-only shape", async () => {
    for (const [candidateCount, expectedRisk] of [[500, "safe"], [63, "high_risk"]]) {
      rmSync(join(tempDir, "state"), { recursive: true, force: true });
      await recordTool(
        "mcp__ypmcn__validate_requirement",
        { payload: { platform: "xiaohongshu", quantityTotal: 10 } },
        { success: true, data: { id: requirementId(candidateCount) }, error: null },
      );
      await recordTool(
        "mcp__ypmcn__search_creators",
        { id: requirementId(candidateCount) },
        {
          success: true,
          data: preRaceSupply({ candidate_count: candidateCount, quantity_total: 10 }),
          error: null,
        },
      );
      const state = JSON.parse(readFileSync(stateFile, "utf8"));
      assert.equal(state.workflow.pre_race_supply_status, "valid");
      assert.equal(state.workflow.pre_race_rate_card_creator_count, candidateCount);
      assert.equal(state.workflow.pre_race_risk_level, expectedRisk);
      assert.equal(state.workflow.pre_race_supply_contract, "supply-assessment-v2");
    }

    rmSync(join(tempDir, "state"), { recursive: true, force: true });
    await recordTool(
      "mcp__ypmcn__validate_requirement",
      { payload: { platform: "xiaohongshu", quantityTotal: 10 } },
      { success: true, data: { id: requirementId(50) }, error: null },
    );
    await recordTool(
      "mcp__ypmcn__search_creators",
      { id: requirementId(50) },
      { success: true, data: { demand_count: 10, eligible_creator_count: 300, supply_ratio: 30 }, error: null },
    );
    let state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.pre_race_supply_status, "invalid");
    assert.equal(state.workflow.pre_race_supply_contract, undefined);
    assert.equal(state.workflow.next_action, "recover_search_supply_plan");

    rmSync(join(tempDir, "state"), { recursive: true, force: true });
    await recordTool(
      "mcp__ypmcn__validate_requirement",
      { payload: { platform: "xiaohongshu", quantityTotal: 10 } },
      { success: true, data: { id: requirementId(51) }, error: null },
    );
    await recordTool(
      "mcp__ypmcn__search_creators",
      { id: requirementId(51) },
      {
        success: true,
        data: {
          ...preRaceSupply({ candidate_count: 500, quantity_total: 10 }),
          demand_count: 10,
          eligible_creator_count: 63,
          supply_ratio: 6.3,
        },
        error: null,
      },
    );
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.pre_race_supply_status, "valid");
    assert.equal(state.workflow.pre_race_supply_contract, "supply-assessment-v2");
    assert.equal(state.workflow.pre_race_rate_card_creator_count, 500);
  });

  it("routes an explicit continuation to manual sourcing after validation", async () => {
    await hooks.get("before_prompt_build")({
      prompt: "继续",
      messages: [{ role: "assistant", content: "需要我继续走拓展达人流程吗？" }],
    }, DEFAULT_CONTEXT);
    let state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.post_validation_intent, "manual");
    assert.deepEqual(state.workflow.post_validation_actions, ["manual_source_creators"]);
    await recordFreshRequirement(requirementId(60));
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.next_action, "manual_source_creators");
    assert.deepEqual(state.workflow.post_validation_actions, ["manual_source_creators"]);
  });

  it("treats start-expansion chat wording as an executable manual-sourcing command", async () => {
    await recordHighRiskSupply();
    let state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.next_action, "rank_mcns");
    assert.equal(state.workflow.waiting_for, null);

    await hooks.get("before_prompt_build")({
      prompt: "启动拓展",
      messages: [{ role: "assistant", content: "你想怎么推进？放宽条件还是直接走拓展达人？" }],
    }, DEFAULT_CONTEXT);
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.post_validation_intent, "manual");
    assert.deepEqual(state.workflow.post_validation_actions, ["manual_source_creators"]);
    assert.equal(state.workflow.next_action, "validate_requirement");
    assert.equal(state.workflow.waiting_for, null);
  });

  it("does not create a manual target without complete selected-supplier rank evidence", async () => {
    for (const [rankInput, rankData] of [
      [
        { id: requirementId(2), platform: "xiaohongshu", minimum_mcn_count: 7 },
        { suppliers: [] },
      ],
      [
        {
          id: requirementId(2), platform: "xiaohongshu", minimum_mcn_count: 7,
          write_mcn_recommendation_items: false,
        },
        { inquiry_id: "inquiry-not-persisted", suppliers: [] },
      ],
      [
        { id: requirementId(2), platform: "xiaohongshu", minimum_mcn_count: 7 },
        {
          inquiry_id: "inquiry-incomplete",
          demand_count: 5,
          selected_supplier_ids: ["supplier-1"],
        },
      ],
      [
        { id: requirementId(2), platform: "xiaohongshu", minimum_mcn_count: 7 },
        {
          inquiry_id: "inquiry-conflict-1",
          demand_count: 5,
          selected_supplier_ids: ["supplier-1"],
          selected_mcn_count: 1,
          coverage_scope: "selected_institutions_deduplicated_union",
          selected_mcn_covered_creator_count: 100,
          selected_mcn_coverage_multiplier: 20,
          selected_mcn_risk_level: "medium_risk",
          manual_sourcing_gap_count: null,
          conflicting_evidence: {
            inquiry_id: "inquiry-conflict-2",
            demand_count: 5,
            selected_supplier_ids: ["supplier-2"],
            selected_mcn_count: 1,
            coverage_scope: "selected_institutions_deduplicated_union",
            selected_mcn_covered_creator_count: 150,
            selected_mcn_coverage_multiplier: 30,
            selected_mcn_risk_level: "safe",
            manual_sourcing_gap_count: null,
          },
        },
      ],
    ]) {
      rmSync(join(tempDir, "state"), { recursive: true, force: true });
      await recordHighRiskSupply();
      await answerSupply("仍继续MCN赛马");
      await recordTool(
        "mcp__ypmcn__rank_mcns",
        rankInput,
        { success: true, data: rankData, error: null },
      );
      const state = JSON.parse(readFileSync(stateFile, "utf8"));
      assert.equal(state.workflow.last_tool_status, "failed");
      assert.equal(state.workflow.rank_mcn_inquiry_evidence_status, "invalid");
      assert.equal(state.workflow.next_action, "recover_rank_mcns");
      assert.equal(state.workflow.pending_manual_target_count, undefined);
      assert.equal(state.workflow.post_race_manual_sourcing_gap_count, undefined);
    }
  });

  it("classifies exact 20x and 30x pre-race boundaries without creating a target", async () => {
    for (const [coverage, expectedRisk] of [
      [99, "high_risk"], [100, "medium_risk"], [149, "medium_risk"], [150, "safe"],
    ]) {
      rmSync(join(tempDir, "state"), { recursive: true, force: true });
      await recordTool(
        "mcp__ypmcn__validate_requirement",
        { payload: { platform: "xiaohongshu", quantityTotal: 5 } },
        { success: true, data: { id: requirementId(2) }, error: null },
      );
      await recordTool(
        "mcp__ypmcn__search_creators",
        { id: requirementId(2) },
        { success: true, data: preRaceSupply({
          candidate_count: coverage,
          supply_multiplier: coverage / 5,
        }), error: null },
      );
      const state = JSON.parse(readFileSync(stateFile, "utf8"));
      assert.equal(state.workflow.pre_race_risk_level, expectedRisk, String(coverage));
      assert.equal(state.workflow.pending_manual_target_count, undefined, String(coverage));
    }
  });

  it("classifies post-race boundaries and always emits an explicit manual count and ratio", async () => {
    for (const [coverage, expectedRisk, expectedGap, expectedAction] of [
      [99, "high_risk", 1, "confirm_post_race_manual_sourcing"],
      [100, "medium_risk", 0, "confirm_post_race_manual_sourcing"],
      [149, "medium_risk", 0, "confirm_post_race_manual_sourcing"],
      [150, "safe", 0, "confirm_post_race_manual_sourcing"],
    ]) {
      rmSync(join(tempDir, "state"), { recursive: true, force: true });
      await recordHighRiskSupply();
      await answerSupply("仍继续MCN赛马");
      await recordRankForManual("inquiry-boundary", {
        selected_mcn_covered_creator_count: coverage,
        selected_mcn_coverage_multiplier: coverage / 5,
        selected_mcn_risk_level: expectedRisk,
        manual_sourcing_gap_count: expectedGap,
      });
      const state = JSON.parse(readFileSync(stateFile, "utf8"));
      assert.equal(state.workflow.post_race_risk_level, expectedRisk, String(coverage));
      assert.equal(state.workflow.post_race_manual_sourcing_gap_count, expectedGap, String(coverage));
      assert.equal(
        state.workflow.post_race_institution_manual_creator_ratio,
        `5:${expectedGap}`,
        String(coverage),
      );
      assert.equal(state.workflow.next_action, expectedAction, String(coverage));
      assert.equal(state.workflow.pending_manual_target_count, undefined, String(coverage));
    }
  });

  it("does not treat success=true without matching task evidence as a started task", async () => {
    await recordHighRiskSupply();
    await answerSupply("仍继续MCN赛马");
    await recordRankForManual();
    await answerPostRace("一键发起拓展达人补量");
    await recordTool(
      "mcp__ypmcn__manual_source_creators",
      { requirement_id: requirementId(2), target_count: 4 },
      { success: true, data: { message: "started" }, error: null },
    );
    let state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.last_tool_status, "failed");
    assert.equal(state.workflow.manual_sourcing_evidence_status, "invalid");
    assert.equal(state.workflow.next_action, "recover_manual_source_creators");
    assert.equal(state.workflow.manual_sourcing_task_id, undefined);

    rmSync(join(tempDir, "state"), { recursive: true, force: true });
    await recordHighRiskSupply();
    await answerSupply("仍继续MCN赛马");
    await recordRankForManual();
    await answerPostRace("一键发起拓展达人补量");
    await recordTool(
      "mcp__ypmcn__manual_source_creators",
      { requirement_id: requirementId(2), target_count: 4 },
      {
        success: true,
        data: {
          task_id: "manual-task-mismatch",
          requirement_id: requirementId(2),
          inquiry_id: "inquiry-manual-1",
          target_count: 5,
          status: "running",
          operation: "reused",
          started_at: "2026-07-20T12:00:00+08:00",
          accepted_count: 2,
        },
        error: null,
      },
    );
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.next_action, "recover_manual_source_creators");
    assert.equal(state.workflow.manual_sourcing_evidence_status, "invalid");

    rmSync(join(tempDir, "state"), { recursive: true, force: true });
    await recordHighRiskSupply();
    await answerSupply("仍继续MCN赛马");
    await recordRankForManual();
    await answerPostRace("一键发起拓展达人补量");
    await hooks.get("after_tool_call")({
      toolName: "mcp__ypmcn__manual_source_creators",
      params: { requirement_id: requirementId(2), target_count: 4 },
      error: "connection lost",
    }, DEFAULT_CONTEXT);
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.next_action, "reconcile_manual_source_creators");
    assert.equal(state.workflow.manual_sourcing_evidence_status, "unavailable");
    assert.equal(state.workflow.last_tool_status, "unknown");
    assert.equal(state.workflow.waiting_for, "provider");
    assert.equal(state.workflow.pending_manual_target_count, 4);
  });

  it("skips pre-race confirmation and maps post-race recalculate, skip, or zero-manual confirmation", async () => {
    await recordHighRiskSupply();
    let state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.next_action, "rank_mcns");
    assert.equal(state.workflow.waiting_for, null);
    assert.equal(state.workflow.pending_manual_target_count, undefined);

    rmSync(join(tempDir, "state"), { recursive: true, force: true });
    await recordHighRiskSupply();
    await answerSupply("仍继续MCN赛马");
    await recordRankForManual();
    await answerPostRace("追加机构后重新计算");
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.next_action, "revise_mcn_selection");
    assert.equal(state.workflow.waiting_for, "user");
    assert.equal(state.workflow.pending_manual_target_count, undefined);

    rmSync(join(tempDir, "state"), { recursive: true, force: true });
    await recordHighRiskSupply();
    await answerSupply("仍继续MCN赛马");
    await recordRankForManual();
    await answerPostRace("暂不补量，继续询价");
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.next_action, "confirm_mcn_selection");
    assert.equal(state.workflow.pending_manual_target_count, undefined);

    rmSync(join(tempDir, "state"), { recursive: true, force: true });
    await recordHighRiskSupply();
    await recordRankForManual("inquiry-safe", {
      selected_mcn_covered_creator_count: 150,
      selected_mcn_coverage_multiplier: 30,
      selected_mcn_risk_level: "safe",
      manual_sourcing_gap_count: null,
    });
    await recordTool("AskUserQuestion", {
      questions: [{
        header: "赛后补量",
        question: "机构供给充足，是否继续？",
        options: ["确认机构方案，继续询价", "追加机构后重新计算"],
      }],
    }, {
      status: "submitted",
      answers: [{ selected_labels: ["确认机构方案，继续询价"] }],
    });
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.next_action, "confirm_post_race_manual_sourcing");
    assert.equal(state.workflow.post_race_confirmation_error, "missing_required_summary_metrics");

    await recordTool("AskUserQuestion", {
      questions: [{
        header: "赛后补量",
        question: "需求达人数量：5\n已选机构数量：2\n预估机构达人覆盖量：150\n供需倍数：30 倍\n建议手动拓展达人数量：0\n机构承接达人与手动拓展达人比例：5:0\n\n请选择执行方案。",
        options: ["确认机构方案，继续询价", "追加机构后重新计算"],
      }],
    }, {
      status: "submitted",
      answers: [{ selected_labels: ["确认机构方案，继续询价"] }],
    });
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.post_race_manual_sourcing_gap_count, 0);
    assert.equal(state.workflow.post_race_institution_manual_creator_ratio, "5:0");
    assert.equal(state.workflow.next_action, "confirm_mcn_selection");
    assert.equal(state.workflow.pending_manual_target_count, undefined);
  });

  it("rejects a distribution supplier set that differs from the post-race coverage set", async () => {
    await recordHighRiskSupply();
    await answerSupply("仍继续MCN赛马");
    await recordRankForManual();
    await answerPostRace("暂不补量，继续询价");
    const mismatched = await guard(
      "mcp__ypmcn__create_with_distributions",
      distributionParams({ requirement_id: requirementId(2), supplierIds: ["supplier-1"] }),
      "call-selection-mismatch",
    );
    assert.equal(mismatched?.block, true);
    assert.match(mismatched.blockReason, /机构集合.*不一致/);

    const matched = await guard(
      "mcp__ypmcn__create_with_distributions",
      distributionParams({
        requirement_id: requirementId(2),
        supplierIds: ["supplier-2", "supplier-1"],
      }),
      "call-selection-match",
    );
    askInputFrom(matched);
  });

  it("keeps failed Tool results from advancing the local phase", async () => {
    await recordTool(
      "mcp__ypmcn__validate_requirement",
      { payload: {} },
      { success: false, error: { code: "INVALID_INPUT" } },
    );
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.phase, "requirement_draft");
    assert.equal(state.workflow.next_action, "recover_validate_requirement");
  });

  it("does not mark a terminal feedback result as waiting for conversational input", async () => {
    await recordTool(
      "mcp__ypmcn__record_client_feedback",
      { requirement_id: requirementId(4), action: "accept" },
      { success: true, data: { recorded: true }, error: null },
    );
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.phase, "feedback_routing");
    assert.equal(state.workflow.next_action, null);
    assert.equal(state.workflow.waiting_for, null);
  });

  it("records returned manual creators, requires their list display, and continues to ranking", async () => {
    await hooks.get("before_prompt_build")({ prompt: "启动拓展", messages: [] }, DEFAULT_CONTEXT);
    await recordFreshRequirement(requirementId(3));
    let state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.phase, "requirement_ready");
    assert.equal(state.workflow.next_action, "manual_source_creators");

    const manualParams = { requirement_id: requirementId(3), size: "8" };
    assert.equal(await guard("mcp__ypmcn__manual_source_creators", manualParams), undefined);
    await recordTool(
      "mcp__ypmcn__manual_source_creators",
      manualParams,
      manualCreatorResult("3"),
    );
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.phase, "candidate_pool_enriched");
    assert.equal(state.workflow.next_action, "rank_creators");
    assert.match(state.workflow.manual_sourcing_excel_file_sha256, /^[0-9a-f]{64}$/);
    assert.equal(state.workflow.manual_sourcing_inquiry_ids, undefined);
    assert.equal(state.workflow.manual_sourcing_size, "8");
    assert.equal(state.workflow.manual_sourcing_creator_data_received, true);
    assert.equal(state.workflow.manual_sourcing_creator_data_status, "received");
    assert.equal(state.workflow.manual_sourcing_creator_count, 1);
    assert.equal(state.workflow.manual_sourcing_creator_list_displayed, false);
    assert.equal(state.workflow.manual_sourcing_creator_list_display_status, "required");

    const marker = state.workflow.manual_sourcing_display_marker;
    await hooks.get("before_prompt_build")({
      prompt: "继续",
      messages: [{
        role: "assistant",
        content: `| 平台 | 达人ID | 达人昵称 | 内容标签 | 主页链接 |\n| --- | --- | --- | --- | --- |\n| 小红书 | xhs-3 | 拓展达人3 | 美妆 | https://example.test/creator/3 |\n<!-- ${marker} -->`,
      }],
    }, DEFAULT_CONTEXT);
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.manual_sourcing_creator_list_displayed, true);
    assert.equal(state.workflow.manual_sourcing_creator_list_display_status, "displayed");
  });

  it("requires human confirmation of MCN return completion before combined ranking", async () => {
    const activeRequirement = requirementId(59);
    await recordFreshRequirement(activeRequirement);
    let state = JSON.parse(readFileSync(stateFile, "utf8"));
    Object.assign(state.workflow, {
      manual_sourcing_after_mcn_flow: true,
      mcn_flow_completed: true,
      distribution_send_evidence_status: "valid",
      distribution_send_evidence_tool: "create_with_distributions",
      sync_after_wecom_send: true,
      sync_inquiry_ids: ["inquiry-59"],
    });
    state.wecom_send_inquiry_id_history = ["inquiry-59", "inquiry-older"];
    writeFileSync(stateFile, JSON.stringify(state, null, 2));

    const manualParams = { requirement_id: activeRequirement, size: "2" };
    assert.equal(await guard("mcp__ypmcn__manual_source_creators", manualParams), undefined);
    await recordTool("mcp__ypmcn__manual_source_creators", manualParams, manualCreatorResult("59"));
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.manual_sourcing_has_prior_wecom_send, true);
    assert.equal(state.workflow.next_action, "confirm_mcn_return_completed");
    assert.equal(state.workflow.waiting_for, "user");

    const rankParams = { requirement_id: activeRequirement, inquiry_id: "inquiry-59" };
    assert.equal((await guard("mcp__ypmcn__rank_creators", rankParams)).errorCode, "INVALID_PHASE");
    const returnQuestion = {
      questions: [{
        header: "机构回填确认",
        question: "请人工核对机构达人是否已完成回填。",
        options: ["确认已完成回填", "尚未完成，继续等待"],
      }],
    };
    await recordTool("AskUserQuestion", returnQuestion, {
      status: "submitted",
      answers: [{ selected_labels: ["确认已完成回填"] }],
    });
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.manual_sourcing_mcn_return_confirmation_status, "confirmed");
    assert.equal(state.workflow.next_action, "rank_creators");
    assert.equal(state.workflow.waiting_for, null);
    assert.equal((await guard("mcp__ypmcn__rank_creators", {
      requirement_id: activeRequirement,
      inquiry_id: "inquiry-older",
    })).errorCode, "INVALID_INPUT");
    assert.equal(await guard("mcp__ypmcn__rank_creators", rankParams), undefined);
  });

  it("blocks out-of-order direct-flow calls and mismatched lineage", async () => {
    const earlyRank = await guard("mcp__ypmcn__rank_creators", {
      requirement_id: requirementId(60),
      inquiry_ids: ["invented"],
      columns: [{ key: "kwUid", name: "达人 ID" }],
    });
    assert.equal(earlyRank.errorCode, "INVALID_PHASE");

    const earlyExport = await guard("mcp__ypmcn__create_submission_batch", {
      requirement_id: requirementId(60), size: "1", number: "1",
    });
    assert.equal(earlyExport.errorCode, "INVALID_PHASE");
    assert.equal((await guard("mcp__ypmcn__select_inquiry_form_fields", {
      platform: "weibo",
    })).errorCode, "INVALID_INPUT");

    const activeRequirement = requirementId(61);
    await recordFreshRequirement(activeRequirement);
    const manualParams = { requirement_id: activeRequirement, size: "3" };
    assert.equal(await guard("mcp__ypmcn__manual_source_creators", manualParams), undefined);
    await recordTool(
      "mcp__ypmcn__manual_source_creators",
      manualParams,
      manualCreatorResult("61"),
    );

    assert.equal(await guard("mcp__ypmcn__rank_creators", {
      requirement_id: activeRequirement,
    }), undefined);

    const wrongRank = await guard("mcp__ypmcn__rank_creators", {
      requirement_id: activeRequirement,
      inquiry_ids: ["61", "invented"],
      columns: [{ key: "kwUid", name: "达人 ID" }],
    });
    assert.equal(wrongRank.errorCode, "INVALID_INPUT");
  });

  it("requires business evidence and records unknown writes without advancing", async () => {
    await recordTool(
      "mcp__ypmcn__select_inquiry_form_fields",
      { platform: "xiaohongshu" },
      { success: true, data: {}, error: null },
    );
    let state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.phase, "requirement_draft");
    assert.equal(state.workflow.field_selection_evidence_status, "invalid");
    assert.equal(state.workflow.transition_seq, 1);
    assert.equal(state.workflow.field_selection_attempted, true);
    const repeatedSelector = await guard("mcp__ypmcn__select_inquiry_form_fields", {
      platform: "xiaohongshu",
    }, "call-repeat-invalid-selector");
    assert.equal(repeatedSelector.errorCode, "INVALID_PHASE");
    assert.match(repeatedSelector.blockReason, /already opened[^]*never select fields for the user or reopen/);

    rmSync(join(tempDir, "state"), { recursive: true, force: true });
    const activeRequirement = requirementId(62);
    await recordFreshRequirement(activeRequirement);
    const manualParams = { requirement_id: activeRequirement, size: "2" };
    assert.equal(await guard("mcp__ypmcn__manual_source_creators", manualParams), undefined);
    await recordTool(
      "mcp__ypmcn__manual_source_creators",
      manualParams,
      { success: true, data: { inquiry_ids: ["71", "72"] }, error: null },
    );
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.phase, "requirement_ready");
    assert.equal(state.workflow.manual_sourcing_evidence_status, "invalid");
    assert.equal(state.workflow.manual_sourcing_evidence_error, "missing_or_conflicting_creator_rows");

    rmSync(join(tempDir, "state"), { recursive: true, force: true });
    await recordFreshRequirement(activeRequirement);
    await hooks.get("after_tool_call")({
      toolName: "mcp__ypmcn__manual_source_creators",
      params: manualParams,
      error: "connection lost",
    }, DEFAULT_CONTEXT);
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.phase, "requirement_ready");
    assert.equal(state.workflow.last_tool_status, "unknown");
    assert.equal(state.workflow.next_action, "reconcile_manual_source_creators");
    assert.equal(state.workflow.waiting_for, "provider");
    assert.equal(state.workflow_events.at(-1).status, "unknown");
  });

  it("uses callback-returned fields without reopening the selector", async () => {
    const localHooks = new Map();
    const openedUrls = [];
    createYpmcnPlugin({
      openUrl(url) { openedUrls.push(url); },
    }).register({
      rootDir: tempDir,
      logger: { error() {}, warn() {} },
      on(name, handler) { localHooks.set(name, handler); },
    });

    await localHooks.get("after_tool_call")({
      toolName: "mcp__ypmcn__select_inquiry_form_fields",
      params: { platform: "xiaohongshu" },
      result: {
        success: true,
        data: {
          fields: [
            { key: "kwUid", name: "达人 ID" },
            { field_key: "nickname", field_name: "达人昵称", type: "string" },
          ],
          callback_url: "https://agenta.eshypdata.com/demand-field-selector?callback=selection-1&platform=xiaohongshu",
        },
        error: null,
      },
    }, DEFAULT_CONTEXT);

    assert.deepEqual(openedUrls, []);
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.phase, "inquiry_fields_ready");
    assert.equal(state.workflow.next_action, "validate_requirement");
    assert.equal(state.workflow.field_selection_attempted, true);
    const repeatedSelector = await guard("mcp__ypmcn__select_inquiry_form_fields", {
      platform: "xiaohongshu",
    }, "call-repeat-success-selector");
    assert.equal(repeatedSelector.errorCode, "INVALID_PHASE");
  });

  it("isolates workflow and AskUserQuestion confirmation state by host session", async () => {
    const first = { sessionKey: "session-one" };
    const second = { sessionKey: "session-two" };
    await hooks.get("before_prompt_build")({ prompt: UNRESOLVED_BRIEF, messages: [] }, first);
    await hooks.get("before_prompt_build")({ prompt: UNRESOLVED_BRIEF, messages: [] }, second);
    const confirmation = await requestConfirmation(distributionParams(), first, "call-session-one");
    await answerExternalConfirmation(confirmation);
    assert.ok(readFileSync(sessionStateFile("session-one"), "utf8"));
    assert.ok(readFileSync(sessionStateFile("session-two"), "utf8"));
    const secondState = JSON.parse(readFileSync(sessionStateFile("session-two"), "utf8"));
    assert.deepEqual(secondState.confirmations, {});
  });

  it("migrates v18 state to v20 without rewriting a completed workflow phase", async () => {
    mkdirSync(join(tempDir, "state", "sessions", defaultSessionHash), { recursive: true });
    writeFileSync(stateFile, JSON.stringify({
      schema_version: 18,
      confirmations: {},
      workflow: {
        phase: "recommendation_ready",
        next_action: null,
        waiting_for: null,
        transition_seq: 7,
        updated_at_ms: 1,
      },
      workflow_events: [],
      manual_sourcing_requirement_receipt: { status: "fresh" },
      search_requirement_receipt: { status: "fresh" },
    }));
    await hooks.get("before_prompt_build")({ prompt: "查看状态", messages: [] }, DEFAULT_CONTEXT);
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.schema_version, 20);
    assert.equal(state.workflow.phase, "recommendation_ready");
    assert.equal(state.workflow.next_action, null);
    assert.equal(state.manual_sourcing_requirement_receipt, undefined);
    assert.equal(state.search_requirement_receipt, undefined);
  });

  it("stores fingerprints and workflow metadata without persisting the message body", async () => {
    await requestConfirmation(distributionParams({
      description: "您好，这是一条 should-not-be-stored 的私密企微消息。",
    }));
    const persisted = readFileSync(stateFile, "utf8");
    assert.match(persisted, /"input_fingerprint": "[0-9a-f]{64}"/);
    assert.match(persisted, /"workflow"/);
    assert.doesNotMatch(persisted, /supplier-1/);
    assert.doesNotMatch(persisted, /should-not-be-stored/);
  });

  it("still requests confirmation when provider arguments are incomplete because schema validation is not a Hook gate", async () => {
    const result = await guard("mcp__ypmcn__create_with_distributions", {}, "call-provider-validation");
    askInputFrom(result);
  });

  it("recognizes OpenCode-style MCP tool names and session aliases", async () => {
    const opencodeContext = { sessionID: "opencode-session" };
    await hooks.get("before_prompt_build")({
      prompt: UNRESOLVED_BRIEF,
      messages: [],
      sessionID: "opencode-session",
    }, opencodeContext);

    await hooks.get("after_tool_call")({
      toolName: "ypmcn-mcp_select_inquiry_form_fields",
      params: { platform: "xiaohongshu" },
      result: {
        success: true,
        data: {
          fields: [{ key: "kwUid", name: "达人 ID" }],
        },
        error: null,
      },
      callID: "call-opencode-fields",
      sessionID: "opencode-session",
    }, opencodeContext);

    let state = JSON.parse(readFileSync(sessionStateFile("opencode-session"), "utf8"));
    assert.equal(state.workflow.phase, "inquiry_fields_ready");
    assert.equal(state.workflow.next_action, "validate_requirement");

    const requirement = requirementId(50);
    await hooks.get("after_tool_call")({
      toolName: "ypmcn-mcp_validate_requirement",
      params: {
        payload: {
          platform: "xiaohongshu",
          quantityTotal: 1,
          rawMessagesJson: { originalBrief: UNRESOLVED_BRIEF },
        },
      },
      result: { success: true, data: { id: requirement }, error: null },
      callID: "call-opencode-validate",
      sessionID: "opencode-session",
    }, opencodeContext);

    assert.equal(await hooks.get("before_tool_call")({
      toolName: "ypmcn-mcp_search_creators",
      params: { id: requirement },
      callID: "call-opencode-search",
      sessionID: "opencode-session",
    }, opencodeContext), undefined);
  });

  it("binds preflight denials and confirmations with callID aliases", async () => {
    const opencodeContext = { sessionID: "opencode-callid" };
    await hooks.get("before_prompt_build")({
      prompt: UNRESOLVED_BRIEF,
      messages: [],
      sessionID: "opencode-callid",
    }, opencodeContext);

    const freshId = requirementId(51);
    await hooks.get("after_tool_call")({
      toolName: "ypmcn-mcp_validate_requirement",
      params: {
        payload: {
          platform: "xiaohongshu",
          quantityTotal: 1,
          rawMessagesJson: { originalBrief: UNRESOLVED_BRIEF },
        },
      },
      result: { success: true, data: { id: freshId }, error: null },
      callID: "call-opencode-validate-fresh",
      sessionID: "opencode-callid",
    }, opencodeContext);

    const deniedEvent = {
      toolName: "ypmcn-mcp_search_creators",
      params: { id: "1784689136279241" },
      callID: "call-opencode-bad-search",
      sessionID: "opencode-callid",
    };
    const denied = await hooks.get("before_tool_call")(deniedEvent, opencodeContext);
    assert.equal(denied.errorCode, "INVALID_INPUT");
    await hooks.get("after_tool_call")({ ...deniedEvent, error: denied.blockReason }, opencodeContext);

    const corrected = await hooks.get("before_tool_call")({
      toolName: "ypmcn-mcp_search_creators",
      params: { id: freshId },
      callID: "call-opencode-good-search",
      sessionID: "opencode-callid",
    }, opencodeContext);
    assert.equal(corrected, undefined);
  });

  it("fails open for ordinary tools and closed for all guarded requirement or external-send calls", async () => {
    const localHooks = new Map();
    const errors = [];
    createYpmcnPlugin({ beforeTool() { throw new Error("guard exploded"); } }).register({
      rootDir: tempDir,
      logger: { error(message) { errors.push(message); } },
      on(name, handler) { localHooks.set(name, handler); },
    });
    assert.equal(await localHooks.get("before_tool_call")({ toolName: "read", params: {} }, {}), undefined);
    const result = await localHooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__create_with_distributions",
      params: distributionParams(),
    }, {});
    assert.equal(result.errorCode, "INTEGRATION_REQUIRED");
    assert.match(result.blockReason, /YPmcn guard unavailable: guard exploded/);
    const manual = await localHooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__manual_source_creators",
      params: { requirement_id: requirementId(30), size: "1" },
    }, {});
    assert.equal(manual.errorCode, "INTEGRATION_REQUIRED");
    assert.match(manual.blockReason, /YPmcn guard unavailable: guard exploded/);
    const validate = await localHooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params: { payload: {} },
    }, {});
    assert.equal(validate.errorCode, "INTEGRATION_REQUIRED");
    const search = await localHooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__search_creators",
      params: { id: requirementId(31) },
    }, {});
    assert.equal(search.errorCode, "INTEGRATION_REQUIRED");
    assert.equal(errors.length, 5);
  });
});
