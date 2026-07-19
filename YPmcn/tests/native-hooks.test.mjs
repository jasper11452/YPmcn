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

const distributionParams = (overrides = {}) => ({
  requirement_id: "requirement-1",
  columns: [{ field_key: "creator_name", field_name: "达人名称" }],
  supplierIds: ["supplier-1"],
  description: "您好，现招募小红书达人参与测试项目。\n图文报价：5000元以内\n请协助推荐合适人选，谢谢。",
  ...overrides,
});

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
    assert.match(YPMCN_FAST_PATH, /需求达人数量：<quantityTotal>\n当前符合条件达人数量：<actual count>\n供需比：/);
    assert.match(YPMCN_FAST_PATH, /Never replace these details with “以上”/);
    assert.match(prompt.prependContext, /authoritative local orchestration state/);
    assert.match(prompt.prependContext, /"next_action":"validate_requirement"/);
    assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).schema_version, 14);

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
        { field: "platform", label: "平台（xiaohongshu / douyin）" },
        { field: "kwUid", label: "达人 ID" },
      ],
      description: "您好，想邀请贵司参与真实企微消息项目。\n请协助推荐合适达人。",
    }), {}, "call-send", ["星图文化", "青禾传媒"]);
    const question = prepared.askInput.questions[0].question;
    assert.match(question, /^⚠️ 不可逆企微外发\n\n/);
    assert.match(question, /确认后将立即向 2 家机构/);
    assert.match(question, /发送对象（2 家）\n1\. 星图文化\n2\. 青禾传媒/);
    assert.match(question, /回填字段\n- 平台（xiaohongshu \/ douyin）\n- 达人 ID/);
    assert.match(question, /企微消息正文\n────────\n您好[^]*\n请协助推荐合适达人。\n────────/);
    assert.match(question, /是否确认立即发送？$/);

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
      { success: true, data: { project_id: "project-1" }, error: null },
      {},
      executionToolCallId,
    );
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.confirmations[state.latest_external_confirmation_id].status, "consumed");
    assert.equal(state.workflow.phase, "waiting_mcn_return");
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

  it("records successful local transitions and popup commands without blocking ordinary calls", async () => {
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
      { success: true, data: { candidate_count: 12, suggested_expansion_count: 3 }, error: null },
    );
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.next_action, "confirm_search_results");
    assert.equal(state.workflow.waiting_for, "user");
    assert.equal(state.workflow.matched_creator_count, 12);

    const question = {
      questions: [{
        header: "供给确认",
        question: "需求达人数量：5\n当前符合条件达人数量：12\n供需比：12/5（2.4:1）\n建议拓展达人数量：3\n\n是否按此供给建议开始MCN赛马？",
        options: ["确认并开始MCN赛马", "调整拓展数量"],
      }],
    };
    await recordTool("AskUserQuestion", question, {
      status: "submitted",
      answers: [{ selected_labels: ["确认并开始MCN赛马"] }],
    });
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.next_action, "rank_mcns");
    assert.equal(state.workflow.waiting_for, null);

    await recordTool(
      "mcp__ypmcn__rank_mcns",
      { id: "requirement-local", platform: "xiaohongshu", minimum_mcn_count: 7 },
      { success: true, data: { suppliers: [] }, error: null },
    );
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.workflow.phase, "mcn_planning");
    assert.equal(state.workflow.mcn_race_size, 7);
    assert.equal(state.workflow.next_action, "confirm_mcn_selection");
    assert.ok(state.workflow_events.length >= 4);
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

  it("opens the hosted field selector after select_inquiry_form_fields succeeds or fails", async () => {
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
        params: {},
        result: { success: true, data: { description: "creator_name：达人名称" }, error: null },
      },
      {
        toolName: "mcp__ypmcn__select_inquiry_form_fields",
        params: {},
        error: "connection lost",
      },
    ]) {
      await localHooks.get("after_tool_call")(event, {});
    }

    assert.deepEqual(openedUrls, [
      "https://agenta.eshypdata.com/demand-field-selector",
      "https://agenta.eshypdata.com/demand-field-selector",
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
      params: {},
      result: { success: false, error: { code: "TIMEOUT" } },
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
