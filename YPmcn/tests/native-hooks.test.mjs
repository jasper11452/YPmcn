import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import plugin, { createYpmcnPlugin, YPMCN_FAST_PATH } from "../dist/index.js";

const tempDir = mkdtempSync(join(tmpdir(), "ypmcn-native-hooks-"));
const stateFile = join(tempDir, "state", "confirmation_guard.json");
const hooks = new Map();
const UNRESOLVED_BRIEF = "找5位小红书达人，单达人预算口径待确认，明天提报。";
const contract = JSON.parse(readFileSync(new URL("../../spec/mcp.json", import.meta.url), "utf8"));

const distributionParams = (overrides = {}) => {
  const description = overrides.description ??
    "您好，现招募小红书达人参与测试项目。\n图文报价：5000元以内\n请协助推荐合适人选，谢谢。";
  return {
    requirement_id: "requirement-1",
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

async function guard(toolName, params = {}, toolCallId, context = {}) {
  return hooks.get("before_tool_call")({ toolName, params, toolCallId }, context);
}

async function recordMcnRecipients(params, context = {}, recipientNames) {
  if (!Array.isArray(params.supplierIds) || params.supplierIds.length === 0) return;
  const names = recipientNames ?? params.supplierIds.map((_, index) => `测试MCN ${index + 1}`);
  await recordTool(
    "mcp__ypmcn__rank_mcns",
    { id: params.requirement_id, platform: "xiaohongshu" },
    {
      success: true,
      data: {
        inquiry_id: "inquiry-recipient-directory",
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
  context = {},
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

async function recordTool(toolName, params, result, context = {}, toolCallId) {
  await hooks.get("after_tool_call")({ toolName, params, result, toolCallId }, context);
}

const highRiskSupply = (overrides = {}) => ({
  demand_count: 5,
  eligible_creator_count: 6,
  supply_ratio: 1.2,
  hard_shortfall_count: 0,
  buffer_shortfall_count: 4,
  supply_risk_level: "high_risk",
  suggested_expansion_count: 4,
  mcn_covered_creator_count: 6,
  mcn_manual_creator_ratio: "6:4",
  recommended_action: "mcn_and_manual",
  ...overrides,
});

const supplyQuestion = {
  questions: [{
    header: "供给确认",
    question: "需求达人数量：5\n当前符合条件达人数量：6\n供需比：6/5（1.2:1）\n硬缺口：0\n风险缓冲缺口：4\n建议手动拓展达人数量：4\nMCN 覆盖达人数量：6\n建议提报比例（MCN达人:拓展达人）：6:4\n\n请选择执行方案。",
    options: ["启动达人拓展并开始MCN排序", "仅开始MCN排序", "调整达人拓展数量"],
  }],
};

async function recordHighRiskSupply() {
  await recordTool(
    "mcp__ypmcn__validate_requirement",
    { payload: { platform: "xiaohongshu", quantityTotal: 5 } },
    { success: true, data: { id: "requirement-local" }, error: null },
  );
  await recordTool(
    "mcp__ypmcn__search_creators",
    { id: "requirement-local" },
    { success: true, data: highRiskSupply(), error: null },
  );
}

async function answerSupply(answer) {
  await recordTool("AskUserQuestion", supplyQuestion, {
    status: "submitted",
    answers: [{ selected_labels: [answer] }],
  });
}

async function recordRankForManual(inquiryId = "inquiry-manual-1", overrides = {}) {
  await recordTool(
    "mcp__ypmcn__rank_mcns",
    { id: "requirement-local", platform: "xiaohongshu", minimum_mcn_count: 7 },
    { success: true, data: { inquiry_id: inquiryId, suppliers: [], ...overrides }, error: null },
  );
}

describe("YP Action native hooks", () => {
  it("registers the expected runtime hooks", () => {
    assert.deepEqual(
      [...hooks.keys()].sort(),
      ["after_tool_call", "before_prompt_build", "before_tool_call", "session_end"],
    );
  });

  it("injects the local JSON orchestration state without turning ordinary tools into gates", async () => {
    const prompt = await hooks.get("before_prompt_build")({ prompt: UNRESOLVED_BRIEF, messages: [] }, {});
    assert.equal(prompt.prependSystemContext, YPMCN_FAST_PATH);
    assert.match(YPMCN_FAST_PATH, /buffer_shortfall_count/);
    assert.match(YPMCN_FAST_PATH, /Never derive risk locally/);
    assert.match(YPMCN_FAST_PATH, /启动达人拓展并开始MCN排序/);
    assert.match(YPMCN_FAST_PATH, /rank_mcns[^]*inquiry_id[^]*manual_source_creators/);
    assert.match(YPMCN_FAST_PATH, /does not prove that every supplier is unsendable/);
    assert.match(YPMCN_FAST_PATH, /Never retry the remaining suppliers as another multi-supplier batch/);
    assert.match(YPMCN_FAST_PATH, /only supplier IDs explicitly reported as sent/);
    assert.doesNotMatch(YPMCN_FAST_PATH, /max\(quantityTotal-actual count,0\)/);
    assert.match(prompt.prependContext, /authoritative local orchestration state/);
    assert.match(prompt.prependContext, /"next_action":"validate_requirement"/);
    assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).schema_version, 15);

    for (const [toolName, params] of [
      ["read", { file_path: "/tmp/SKILL.md" }],
      ["AskUserQuestion", { questions: [{ header: "供给确认" }] }],
      ["mcp__ypmcn__validate_requirement", { payload: {} }],
      ["mcp__ypmcn__rank_mcns", { id: "any", platform: "xiaohongshu" }],
    ]) {
      assert.equal(await guard(toolName, params), undefined, toolName);
    }
  });

  it("allows every declared business Tool except that send requires AskUserQuestion confirmation", async () => {
    for (const name of [...contract.requiredTools, ...contract.optionalTools]) {
      const params = name === "create_with_distributions" ? distributionParams() : {};
      if (name === "create_with_distributions") await recordMcnRecipients(params);
      const result = await guard(`mcp__ypmcn__${name}`, params);
      if (name === "create_with_distributions") askInputFrom(result);
      else assert.equal(result, undefined, name);
    }
  });

  it("blocks only provider send bypasses through shell", async () => {
    const blocked = await guard("bash", {
      command: "curl -X POST https://provider.invalid/api/projects/create-with-distributions",
    });
    assert.equal(blocked?.block, true);
    assert.match(blocked.blockReason, /INTEGRATION_REQUIRED/);
    assert.equal(await guard("bash", { command: "rg create_with_distributions YPmcn/README.md" }), undefined);
  });

  it("binds a multiline AskUserQuestion warning to the exact send parameters", async () => {
    const prepared = await requestConfirmation(distributionParams({
      supplierIds: ["supplier-1", "supplier-2"],
      columns: [
        { key: "platform", name: "平台（xiaohongshu / douyin）" },
        { key: "kwUid", name: "达人 ID" },
      ],
      description: "您好，想邀请贵司参与真实企微消息项目。\n请协助推荐合适达人。",
    }), {}, "call-send", ["星图文化", "青禾传媒"]);
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

    await answerExternalConfirmation(prepared);
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    receipt = state.confirmations[state.latest_external_confirmation_id];
    assert.equal(receipt.status, "approved");

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

    await recordTool(
      "mcp__ypmcn__create_with_distributions",
      prepared.params,
      {
        success: true,
        data: {
          project_id: "project-1",
          created: [
            { supplier_id: "supplier-1", notification_status: "sent" },
            { supplier_id: "supplier-2", notification_status: "sent" },
          ],
        },
        error: null,
      },
      {},
      executionToolCallId,
    );
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.confirmations[state.latest_external_confirmation_id].status, "consumed");
    assert.equal(state.workflow.phase, "waiting_mcn_return");
    assert.equal(state.workflow.distribution_outcome_status, "all_sent");
    assert.equal(state.workflow.sent_supplier_count, 2);
    assert.equal(state.workflow.unbound_supplier_count, 0);
  });

  it("keeps partial group-binding outcomes explicit and rejects generic send success", async () => {
    const partial = await requestConfirmation(distributionParams({
      supplierIds: ["supplier-1", "supplier-2"],
    }), {}, "call-partial-binding", ["星图文化", "青禾传媒"]);
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
      {},
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
      distributionParams({ requirement_id: "requirement-ambiguous-send" }),
      {},
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
      { success: true, data: { project_id: "project-ambiguous" }, error: null },
      {},
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
    const prepared = await requestConfirmation(distributionParams({ supplierIds }), {}, "call-five-suppliers", [
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
      {},
      initialExecutionId,
    );

    let state = JSON.parse(readFileSync(stateFile, "utf8"));
    const continuation = state.confirmations[state.latest_external_confirmation_id];
    assert.equal(continuation.confirmation_mode, "individual_fallback_continuation");
    assert.equal(continuation.status, "approved");
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
      assert.equal(await guard(
        "mcp__ypmcn__create_with_distributions",
        retryParams,
        retryExecutionId,
      ), undefined);
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
        {},
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
      {},
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
      {},
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
      assert.equal(await guard(
        "mcp__ypmcn__create_with_distributions",
        params,
        executionId,
      ), undefined);
      await recordTool(
        "mcp__ypmcn__create_with_distributions",
        params,
        individualResults[index],
        {},
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
    const prepared = await requestConfirmation(distributionParams(), {}, "call-truncated-popup");
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

  it("matches a global preflight receipt when AskUserQuestion gains session context", async () => {
    const prepared = await requestConfirmation(distributionParams(), {}, "call-global-preflight");
    await recordTool("AskUserQuestion", prepared.askInput, {
      content: [{
        type: "text",
        text: `${prepared.askInput.questions[0].question}: 确认发送`,
      }],
    }, { sessionKey: "session-context-arrived-late" });

    const globalState = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(globalState.confirmations[globalState.latest_external_confirmation_id].status, "approved");
    assert.equal(await guard(
      "mcp__ypmcn__create_with_distributions",
      prepared.params,
      "call-global-preflight-execute",
    ), undefined);
  });

  it("keeps the full multiline WeCom message in the scrollable AskUserQuestion body", async () => {
    const message = `您好，现有以下合作需求：\n${"长消息".repeat(300)}\n以上为完整消息结尾。`;
    const prepared = await requestConfirmation(distributionParams({
      description: message,
    }), {}, "call-long-preview");
    const question = prepared.askInput.questions[0].question;
    assert.ok(Array.from(question).length > 256);
    assert.ok(question.includes(message));
    assert.doesNotMatch(question, /消息结尾。…/);
  });

  it("resolves available MCN names and allows recipients without names", async () => {
    const params = distributionParams({ supplierIds: ["supplier-1", "supplier-2"] });
    await recordTool(
      "mcp__ypmcn__rank_mcns",
      { id: params.requirement_id, platform: "xiaohongshu" },
      {
        success: true,
        data: {
          inquiry_id: "inquiry-recipient-names",
          recommendations: [
            { supplier: { id: "supplier-1", name: "星图文化" } },
            { mcnId: "supplier-2", mcnName: "青禾传媒" },
          ],
        },
        error: null,
      },
    );

    const confirmation = await guard("mcp__ypmcn__create_with_distributions", params, "call-shaped-result");
    assert.match(askInputFrom(confirmation).questions[0].question, /1\. 星图文化\n2\. 青禾传媒/);

    const unknownRecipient = await guard(
      "mcp__ypmcn__create_with_distributions",
      { ...params, supplierIds: ["supplier-1", "supplier-unverified"] },
      "call-unverified-recipient",
    );
    assert.equal(unknownRecipient.block, true);
    assert.match(askInputFrom(unknownRecipient).questions[0].question, /1\. 星图文化\n2\. 名称未提供/);

    const staleRequirement = await guard(
      "mcp__ypmcn__create_with_distributions",
      { ...params, requirement_id: "requirement-other" },
      "call-stale-requirement",
    );
    assert.equal(staleRequirement.block, true);
  });

  it("keeps a rejected AskUserQuestion send unsent and allows a revised confirmation", async () => {
    const prepared = await requestConfirmation(distributionParams({
      supplierIds: ["supplier-1", "supplier-2"],
    }), {}, "call-reject-and-edit", ["星图文化", "青禾传媒"]);
    await answerExternalConfirmation(prepared, "取消发送");

    const deniedState = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(deniedState.confirmations[deniedState.latest_external_confirmation_id].status, "denied");

    const revised = await guard(
      "mcp__ypmcn__create_with_distributions",
      {
        ...prepared.params,
        supplierIds: ["supplier-2"],
        description: "您好，这是修改后的企微消息。",
      },
      "call-revised-send",
    );
    const revisedQuestion = askInputFrom(revised).questions[0].question;
    assert.match(revisedQuestion, /发送对象（1 家）\n1\. 青禾传媒/);
    assert.match(revisedQuestion, /修改后的企微消息/);
  });

  it("does not authorize cancellation, host denial, tool error, a modified popup, or changed parameters", async () => {
    const cancelled = await requestConfirmation(distributionParams({ requirement_id: "requirement-cancel" }));
    await answerExternalConfirmation(cancelled, "取消发送");
    askInputFrom(await guard(
      "mcp__ypmcn__create_with_distributions",
      cancelled.params,
      "call-cancel-retry",
    ));

    rmSync(join(tempDir, "state"), { recursive: true, force: true });
    const denied = await requestConfirmation(distributionParams({ requirement_id: "requirement-denied" }));
    await recordTool("AskUserQuestion", denied.askInput, {
      content: [{ type: "text", text: "User denied the operation." }],
    });
    let state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.confirmations[state.latest_external_confirmation_id].status, "denied");

    rmSync(join(tempDir, "state"), { recursive: true, force: true });
    const failedTool = await requestConfirmation(distributionParams({ requirement_id: "requirement-tool-error" }));
    await recordTool("AskUserQuestion", failedTool.askInput, {
      isError: true,
      answers: [{ selected_labels: ["确认发送"] }],
    });
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.confirmations[state.latest_external_confirmation_id].status, "denied");

    rmSync(join(tempDir, "state"), { recursive: true, force: true });
    const modifiedPopup = await requestConfirmation(distributionParams({ requirement_id: "requirement-modified" }));
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
    }), {}, "call-original", ["星图文化", "青禾传媒"]);
    await answerExternalConfirmation(first);
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
    askInputFrom(await guard(
      "mcp__ypmcn__create_with_distributions",
      first.params,
      "call-stale-original",
    ));
  });

  it("requires a fresh AskUserQuestion confirmation after success or unknown result", async () => {
    for (const [index, eventResult] of [
      [0, { success: true, data: {}, error: null }],
      [1, undefined],
    ]) {
      const params = distributionParams({ requirement_id: `requirement-replay-${index}` });
      const prepared = await requestConfirmation(params, {}, `call-replay-${index}`);
      await answerExternalConfirmation(prepared);
      const executionId = `call-replay-${index}-execute`;
      assert.equal(await guard("mcp__ypmcn__create_with_distributions", params, executionId), undefined);
      if (eventResult) {
        await recordTool("mcp__ypmcn__create_with_distributions", params, eventResult, {}, executionId);
      } else {
        await hooks.get("after_tool_call")({
          toolName: "mcp__ypmcn__create_with_distributions",
          params,
          toolCallId: executionId,
          error: "connection lost",
        }, {});
      }
      askInputFrom(await guard(
        "mcp__ypmcn__create_with_distributions",
        params,
        `call-replay-${index}-next`,
      ));
      rmSync(join(tempDir, "state"), { recursive: true, force: true });
    }
  });

  it("creates the inquiry with rank_mcns before starting a verified manual task", async () => {
    const validateInput = { payload: { platform: "xiaohongshu", quantityTotal: 5 } };
    await recordTool(
      "mcp__ypmcn__validate_requirement",
      validateInput,
      { success: true, data: { id: "requirement-local" }, error: null },
    );
    let state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.deepEqual(
      [state.workflow.phase, state.workflow.next_action, state.workflow.requirement_id],
      ["requirement_ready", "search_creators", "requirement-local"],
    );

    await recordTool(
      "mcp__ypmcn__search_creators",
      { id: "requirement-local" },
      { success: true, data: highRiskSupply(), error: null },
    );
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.next_action, "confirm_search_results");
    assert.equal(state.workflow.waiting_for, "user");
    assert.equal(state.workflow.matched_creator_count, 6);
    assert.equal(state.workflow.supply_risk_level, "high_risk");
    assert.equal(state.workflow.buffer_shortfall_count, 4);
    assert.equal(state.workflow.suggested_expansion_count, 4);
    assert.equal(state.workflow.mcn_covered_creator_count, 6);
    assert.equal(state.workflow.mcn_manual_creator_ratio, "6:4");
    assert.equal(state.workflow.supply_plan_status, "valid");

    await answerSupply("启动达人拓展并开始MCN排序");
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.next_action, "rank_mcns");
    assert.equal(state.workflow.pending_manual_target_count, 4);
    assert.equal(state.workflow.waiting_for, null);

    await recordRankForManual();
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.phase, "mcn_planning");
    assert.equal(state.workflow.mcn_race_size, 7);
    assert.equal(state.workflow.rank_mcn_inquiry_id, "inquiry-manual-1");
    assert.equal(state.workflow.rank_mcn_inquiry_evidence_status, "valid");
    assert.equal(state.workflow.next_action, "manual_source_creators");
    assert.equal(state.workflow.waiting_for, null);

    await recordTool(
      "mcp__ypmcn__manual_source_creators",
      { requirement_id: "requirement-local", target_count: 4 },
      {
        success: true,
        data: {
          task_id: "manual-task-1",
          requirement_id: "requirement-local",
          inquiry_id: "inquiry-manual-1",
          target_count: 4,
          status: "started",
          operation: "created",
          started_at: "2026-07-20T12:00:00+08:00",
          accepted_count: 0,
        },
        error: null,
      },
    );
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.next_action, "confirm_mcn_selection");
    assert.equal(state.workflow.manual_sourcing_status, "started");
    assert.equal(state.workflow.manual_sourcing_operation, "created");
    assert.equal(state.workflow.manual_sourcing_target_count, 4);
    assert.equal(state.workflow.manual_sourcing_task_id, "manual-task-1");
    assert.equal(state.workflow.manual_sourcing_inquiry_id, "inquiry-manual-1");
    assert.equal(state.workflow.pending_manual_target_count, undefined);
    assert.notEqual(state.workflow.next_action, "create_with_distributions");
    assert.ok(state.workflow_events.length >= 5);
  });

  it("does not start manual sourcing without one persisted rank_mcns inquiry_id", async () => {
    for (const [rankInput, rankData] of [
      [
        { id: "requirement-local", platform: "xiaohongshu", minimum_mcn_count: 7 },
        { suppliers: [] },
      ],
      [
        {
          id: "requirement-local", platform: "xiaohongshu", minimum_mcn_count: 7,
          write_mcn_recommendation_items: false,
        },
        { inquiry_id: "inquiry-not-persisted", suppliers: [] },
      ],
    ]) {
      rmSync(join(tempDir, "state"), { recursive: true, force: true });
      await recordHighRiskSupply();
      await answerSupply("启动达人拓展并开始MCN排序");
      await recordTool(
        "mcp__ypmcn__rank_mcns",
        rankInput,
        { success: true, data: rankData, error: null },
      );
      const state = JSON.parse(readFileSync(stateFile, "utf8"));
      assert.equal(state.workflow.last_tool_status, "failed");
      assert.equal(state.workflow.rank_mcn_inquiry_evidence_status, "invalid");
      assert.equal(state.workflow.next_action, "recover_rank_mcns");
      assert.equal(state.workflow.pending_manual_target_count, 4);
    }
  });

  it("fails closed when high-risk supply evidence recommends zero manual additions", async () => {
    await recordTool(
      "mcp__ypmcn__validate_requirement",
      { payload: { platform: "xiaohongshu", quantityTotal: 5 } },
      { success: true, data: { id: "requirement-local" }, error: null },
    );
    await recordTool(
      "mcp__ypmcn__search_creators",
      { id: "requirement-local" },
      { success: true, data: highRiskSupply({ suggested_expansion_count: 0 }), error: null },
    );
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.phase, "candidate_pool_ready");
    assert.equal(state.workflow.supply_plan_status, "invalid");
    assert.equal(state.workflow.next_action, "recover_search_supply_plan");
    assert.equal(state.workflow.suggested_expansion_count, undefined);
  });

  it("fails closed when the MCN-to-manual creator ratio contradicts the recommended counts", async () => {
    await recordTool(
      "mcp__ypmcn__validate_requirement",
      { payload: { platform: "xiaohongshu", quantityTotal: 5 } },
      { success: true, data: { id: "requirement-local" }, error: null },
    );
    await recordTool(
      "mcp__ypmcn__search_creators",
      { id: "requirement-local" },
      { success: true, data: highRiskSupply({ mcn_manual_creator_ratio: "5:4" }), error: null },
    );
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.supply_plan_status, "invalid");
    assert.equal(state.workflow.next_action, "recover_search_supply_plan");
    assert.equal(state.workflow.mcn_manual_creator_ratio, undefined);
  });

  it("does not treat success=true without matching task evidence as a started task", async () => {
    await recordHighRiskSupply();
    await answerSupply("启动达人拓展并开始MCN排序");
    await recordRankForManual();
    await recordTool(
      "mcp__ypmcn__manual_source_creators",
      { requirement_id: "requirement-local", target_count: 4 },
      { success: true, data: { message: "started" }, error: null },
    );
    let state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.last_tool_status, "failed");
    assert.equal(state.workflow.manual_sourcing_evidence_status, "invalid");
    assert.equal(state.workflow.next_action, "recover_manual_source_creators");
    assert.equal(state.workflow.manual_sourcing_task_id, undefined);

    rmSync(join(tempDir, "state"), { recursive: true, force: true });
    await recordHighRiskSupply();
    await answerSupply("启动达人拓展并开始MCN排序");
    await recordRankForManual();
    await recordTool(
      "mcp__ypmcn__manual_source_creators",
      { requirement_id: "requirement-local", target_count: 4 },
      {
        success: true,
        data: {
          task_id: "manual-task-mismatch",
          requirement_id: "requirement-local",
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
    await answerSupply("启动达人拓展并开始MCN排序");
    await recordRankForManual();
    await hooks.get("after_tool_call")({
      toolName: "mcp__ypmcn__manual_source_creators",
      params: { requirement_id: "requirement-local", target_count: 4 },
      error: "connection lost",
    }, {});
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.next_action, "recover_manual_source_creators");
    assert.equal(state.workflow.manual_sourcing_evidence_status, "unavailable");
    assert.equal(state.workflow.pending_manual_target_count, 4);
  });

  it("maps MCN-only and one adjusted positive target without guessing", async () => {
    await recordHighRiskSupply();
    await answerSupply("仅开始MCN排序");
    let state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.next_action, "rank_mcns");
    assert.equal(state.workflow.pending_manual_target_count, undefined);

    rmSync(join(tempDir, "state"), { recursive: true, force: true });
    await recordHighRiskSupply();
    await answerSupply("调整达人拓展数量");
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.next_action, "confirm_manual_target_count");
    assert.equal(state.workflow.waiting_for, "user");

    const targetQuestion = {
      questions: [{
        header: "达人拓展数量",
        question: "请输入本次达人拓展新增数量（正整数）？",
        options: ["达人拓展新增 4 位", "取消调整"],
      }],
    };
    await recordTool("AskUserQuestion", targetQuestion, {
      status: "submitted",
      answers: [{ value: "7" }],
    });
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.next_action, "rank_mcns");
    assert.equal(state.workflow.pending_manual_target_count, 7);

    await recordTool("AskUserQuestion", targetQuestion, {
      status: "submitted",
      answers: [{ value: "4 或 6" }],
    });
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.next_action, "confirm_manual_target_count");
    assert.equal(state.workflow.pending_manual_target_count, undefined);

    await recordTool("AskUserQuestion", targetQuestion, { status: "cancelled" });
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.next_action, "confirm_manual_target_count");
    assert.equal(state.workflow.pending_manual_target_count, undefined);
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

  it("opens only a callback URL returned by select_inquiry_form_fields", async () => {
    const localHooks = new Map();
    const openedUrls = [];
    createYpmcnPlugin({
      openUrl(url) { openedUrls.push(url); },
    }).register({
      rootDir: tempDir,
      logger: { error() {} },
      on(name, handler) { localHooks.set(name, handler); },
    });

    for (const event of [
      {
        toolName: "mcp__ypmcn__select_inquiry_form_fields",
        params: { url: "https://agenta.eshypdata.com/demand-field-selector" },
        result: {
          success: true,
          data: {
            url: "https://agenta.eshypdata.com/demand-field-selector?callback=selection-1&platform=xiaohongshu",
          },
          error: null,
        },
      },
      {
        toolName: "mcp__ypmcn__select_inquiry_form_fields",
        params: { url: "https://agenta.eshypdata.com/demand-field-selector" },
        error: "connection lost",
      },
    ]) {
      await localHooks.get("after_tool_call")(event, {});
    }

    assert.deepEqual(openedUrls, [
      "https://agenta.eshypdata.com/demand-field-selector?callback=selection-1&platform=xiaohongshu",
    ]);

    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.phase, "inquiry_fields_ready");
    assert.equal(state.workflow.next_action, "confirm_inquiry_fields");
    assert.equal(state.workflow.waiting_for, "user");
  });

  it("does not alter Tool handling when the host cannot open the field selector", async () => {
    const localHooks = new Map();
    const errors = [];
    createYpmcnPlugin({
      openUrl() { throw new Error("browser unavailable"); },
    }).register({
      rootDir: tempDir,
      logger: { error(message) { errors.push(message); } },
      on(name, handler) { localHooks.set(name, handler); },
    });

    assert.equal(await localHooks.get("after_tool_call")({
      toolName: "mcp__ypmcn__select_inquiry_form_fields",
      params: { url: "https://agenta.eshypdata.com/demand-field-selector" },
      result: {
        success: true,
        content: [{
          type: "text",
          text: "请打开 https://agenta.eshypdata.com/demand-field-selector?callback=selection-2",
        }],
      },
    }, {}), undefined);
    assert.deepEqual(errors, ["failed to open inquiry field selector: browser unavailable"]);
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

  it("fails open for ordinary tools and closed for external send when the guard itself throws", async () => {
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
    assert.deepEqual(result, { block: true, blockReason: "YPmcn guard unavailable: guard exploded" });
    assert.equal(errors.length, 2);
  });
});
