import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";

import plugin, { createYpmcnPlugin, YPMCN_FAST_PATH } from "../dist/index.js";

const tempDir = mkdtempSync(join(tmpdir(), "ypmcn-native-hooks-"));
const stateFile = join(tempDir, "state", "confirmation_guard.json");
const templateFile = join(tempDir, "skills", "media-assistant", "assets", "wecom_inquiry_template.txt");
const hooks = new Map();
const UNRESOLVED_BRIEF = "找5位小红书达人，单达人预算口径待确认，明天提报。";
const contract = JSON.parse(readFileSync(new URL("../../spec/mcp.json", import.meta.url), "utf8"));

const distributionParams = (overrides = {}) => ({
  projectName: "测试项目",
  deadline: "2099-07-17T18:00:00+08:00",
  columns: [{ field_key: "creator_name", field_name: "达人名称" }],
  supplierIds: ["supplier-1"],
  prefillRows: [],
  prefillRowsBySupplier: { "supplier-1": [] },
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

beforeEach(() => {
  rmSync(join(tempDir, "state"), { recursive: true, force: true });
});

after(() => rmSync(tempDir, { recursive: true, force: true }));

function confirmationId(result) {
  return /confirmation_id=([0-9a-f-]{36})/i.exec(result?.blockReason ?? "")?.[1];
}

function sessionStateFile(sessionKey) {
  const hash = createHash("sha256").update(sessionKey).digest("hex").slice(0, 24);
  return join(tempDir, "state", "sessions", hash, "confirmation_guard.json");
}

async function guard(toolName, params = {}, toolCallId, context = {}) {
  return hooks.get("before_tool_call")({ toolName, params, toolCallId }, context);
}

async function requestConfirmation(params = distributionParams(), context = {}, toolCallId = "call-send-prepare") {
  const blocked = await guard("mcp__ypmcn__create_with_distributions", params, toolCallId, context);
  assert.equal(blocked?.block, true);
  assert.match(blocked.blockReason, /YP_CONFIRMATION_REQUIRED/);
  const id = confirmationId(blocked);
  assert.ok(id);
  return { id, params, blocked };
}

async function answerConfirmation(id, context = {}, answer = "确认发送", flattened = false) {
  const params = {
    questions: [{
      header: "外发确认",
      question: `是否确认本次企微外发？ [YP_CONFIRMATION:${id}]`,
      options: [{ label: "确认发送" }, { label: "需要修改" }, { label: "取消" }],
    }],
  };
  assert.equal(await guard("AskUserQuestion", params, undefined, context), undefined);
  await hooks.get("after_tool_call")({
    toolName: "AskUserQuestion",
    params,
    result: flattened
      ? `${params.questions[0].question}: ${answer}`
      : { status: "submitted", answers: [{ selected_labels: [answer] }] },
  }, context);
  return params;
}

describe("YP Action native external-send hook", () => {
  it("registers the expected runtime hooks", () => {
    assert.deepEqual(
      [...hooks.keys()].sort(),
      ["after_tool_call", "before_prompt_build", "before_tool_call", "session_end"],
    );
  });

  it("keeps standard-Brief guidance without turning it into a global Tool gate", async () => {
    const prompt = await hooks.get("before_prompt_build")({ prompt: UNRESOLVED_BRIEF, messages: [] }, {});
    assert.equal(prompt.prependSystemContext, YPMCN_FAST_PATH);
    assert.match(prompt.prependContext, /YPmcn authoritative requirement clock/);

    for (const [toolName, params] of [
      ["read", { file_path: "/tmp/SKILL.md" }],
      ["resources_read", { uri: "skill://media-assistant" }],
      ["ypmcn-mcp__prompts_get", { name: "media-assistant" }],
      ["web_search", { query: "test" }],
      ["mcp__ypmcn__validate_requirement", { payload: {} }],
    ]) {
      assert.equal(await guard(toolName, params), undefined, `${toolName} should not be gated`);
    }
  });

  it("allows every declared business Tool except the external-send Tool", async () => {
    const tools = [...contract.requiredTools, ...contract.optionalTools]
      .filter((name) => name !== "create_with_distributions");
    for (const name of tools) {
      assert.equal(await guard(`mcp__ypmcn__${name}`, {}), undefined, name);
    }
  });

  it("does not validate ordinary AskUserQuestion or supply-plan questions", async () => {
    assert.equal(await guard("AskUserQuestion", {
      questions: [{ header: "参数确认", question: "请选择平台？", options: ["小红书", "抖音"] }],
    }), undefined);
    assert.equal(await guard("AskUserQuestion", {
      questions: [{ header: "供给确认", question: "是否采用当前方案？", options: ["确认供给方案", "调整方案"] }],
    }), undefined);
    assert.equal(await guard("AskUserQuestion", {
      questions: [{ header: "草稿操作", question: "是否发送内部草稿？", options: ["确认发送", "取消"] }],
    }), undefined);
    assert.equal(existsSync(stateFile), false);
  });

  it("blocks only a provider send attempted through shell while allowing read-only shell use", async () => {
    const blocked = await guard("bash", {
      command: "curl -X POST https://provider.invalid/api/projects/create-with-distributions",
    });
    assert.equal(blocked?.block, true);
    assert.match(blocked.blockReason, /INTEGRATION_REQUIRED/);

    assert.equal(await guard("bash", {
      command: "rg create_with_distributions YPmcn/skills/media-assistant/SKILL.md",
    }), undefined);
  });

  it("requires one explicit confirmation without workflow, rank, supply, or ID prerequisites", async () => {
    const { id, params } = await requestConfirmation();
    await answerConfirmation(id);
    assert.equal(await guard("mcp__ypmcn__create_with_distributions", params, "call-send-1"), undefined);
  });

  it("binds the visible confirmation to the stored safe summary", async () => {
    const params = distributionParams({ projectName: "真实项目", supplierIds: ["a", "b"] });
    const { id } = await requestConfirmation(params);
    const ask = {
      questions: [{
        header: "外发确认",
        question: `伪造项目 [YP_CONFIRMATION:${id}]`,
        options: [{ label: "确认发送" }, { label: "需要修改" }],
      }],
    };
    assert.equal(await guard("AskUserQuestion", ask), undefined);
    assert.match(ask.questions[0].question, /项目名=真实项目/);
    assert.match(ask.questions[0].question, /机构数=2/);
    assert.doesNotMatch(ask.questions[0].question, /伪造项目/);
  });

  it("allows the confirmed request once and asks again before replay", async () => {
    const { id, params } = await requestConfirmation(distributionParams({ projectName: "一次性确认" }));
    await answerConfirmation(id);
    assert.equal(await guard("mcp__ypmcn__create_with_distributions", params, "call-once-1"), undefined);
    await hooks.get("after_tool_call")({
      toolName: "mcp__ypmcn__create_with_distributions",
      params,
      toolCallId: "call-once-1",
      result: { success: true, data: { project_id: "project-1" }, error: null },
    }, {});

    const replay = await guard("mcp__ypmcn__create_with_distributions", params, "call-once-2");
    assert.match(replay.blockReason, /YP_CONFIRMATION_REQUIRED/);
    assert.notEqual(confirmationId(replay), id);
  });

  it("requires a separate confirmation when any send parameter changes", async () => {
    const { id, params } = await requestConfirmation(distributionParams({ projectName: "参数绑定" }));
    const changed = { ...params, supplierIds: ["supplier-2"] };
    const blocked = await guard("mcp__ypmcn__create_with_distributions", changed, "call-changed");
    assert.match(blocked.blockReason, /YP_CONFIRMATION_REQUIRED/);
    assert.notEqual(confirmationId(blocked), id);
  });

  it("does not authorize modification, cancellation, or ambiguous host results", async () => {
    for (const [index, answer] of ["需要修改", "取消", "确认发送 / 需要修改"].entries()) {
      const { id, params } = await requestConfirmation(distributionParams({ projectName: `拒绝-${index}` }));
      await answerConfirmation(id, {}, answer);
      const blocked = await guard("mcp__ypmcn__create_with_distributions", params, `call-denied-${index}`);
      assert.match(blocked.blockReason, /YP_CONFIRMATION_REQUIRED/);
    }
  });

  it("accepts the flattened YP Action confirmation result", async () => {
    const { id, params } = await requestConfirmation(distributionParams({ projectName: "扁平确认" }));
    await answerConfirmation(id, {}, "确认发送", true);
    assert.equal(await guard("mcp__ypmcn__create_with_distributions", params, "call-flat"), undefined);
  });

  it("requires a fresh confirmation after an unknown send result instead of permanently blocking", async () => {
    const { id, params } = await requestConfirmation(distributionParams({ projectName: "未知结果" }));
    await answerConfirmation(id);
    assert.equal(await guard("mcp__ypmcn__create_with_distributions", params, "call-unknown-1"), undefined);
    await hooks.get("after_tool_call")({
      toolName: "mcp__ypmcn__create_with_distributions",
      params,
      toolCallId: "call-unknown-1",
      error: new Error("connection lost"),
    }, {});

    const retry = await guard("mcp__ypmcn__create_with_distributions", params, "call-unknown-2");
    assert.match(retry.blockReason, /YP_CONFIRMATION_REQUIRED/);
    assert.notEqual(confirmationId(retry), id);
  });

  it("isolates confirmations by host session", async () => {
    const first = { sessionKey: "session-one" };
    const second = { sessionKey: "session-two" };
    const params = distributionParams({ projectName: "会话隔离" });
    const { id } = await requestConfirmation(params, first);
    await answerConfirmation(id, first);
    assert.equal(await guard("mcp__ypmcn__create_with_distributions", params, "call-session-1", first), undefined);

    const blocked = await guard("mcp__ypmcn__create_with_distributions", params, "call-session-2", second);
    assert.match(blocked.blockReason, /YP_CONFIRMATION_REQUIRED/);
    assert.notEqual(confirmationId(blocked), id);
    assert.ok(readFileSync(sessionStateFile("session-one"), "utf8"));
    assert.ok(readFileSync(sessionStateFile("session-two"), "utf8"));
  });

  it("stores only fingerprints and the user-facing send summary", async () => {
    await requestConfirmation(distributionParams({
      projectName: "状态脱敏",
      prefillRows: [{ private_note: "should-not-be-stored" }],
    }));
    const persisted = readFileSync(stateFile, "utf8");
    assert.match(persisted, /"input_fingerprint": "[0-9a-f]{64}"/);
    assert.match(persisted, /"safe_summary"/);
    assert.doesNotMatch(persisted, /should-not-be-stored/);
  });

  it("expires stale unknown receipts and permits a newly confirmed attempt", async () => {
    const { id, params } = await requestConfirmation(distributionParams({ projectName: "过期状态" }));
    await answerConfirmation(id);
    assert.equal(await guard("mcp__ypmcn__create_with_distributions", params, "call-expire-1"), undefined);
    await hooks.get("after_tool_call")({
      toolName: "mcp__ypmcn__create_with_distributions",
      params,
      toolCallId: "call-expire-1",
      error: new Error("connection lost"),
    }, {});
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    state.confirmations[id].expires_at_ms = Date.now() - 1;
    writeFileSync(stateFile, JSON.stringify(state), "utf8");

    const retry = await guard("mcp__ypmcn__create_with_distributions", params, "call-expire-2");
    assert.match(retry.blockReason, /YP_CONFIRMATION_REQUIRED/);
    assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).confirmations[id], undefined);
  });

  it("still requests confirmation when provider arguments are incomplete", async () => {
    const blocked = await guard("mcp__ypmcn__create_with_distributions", {}, "call-provider-validation");
    assert.match(blocked.blockReason, /YP_CONFIRMATION_REQUIRED/);
    assert.doesNotMatch(blocked.blockReason, /BLOCKED_INVALID|INVALID_INPUT|SCHEMA_MISMATCH/);
  });

  it("fails closed only for the external confirmation when its fixed template is unavailable", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "ypmcn-no-template-"));
    const localHooks = new Map();
    try {
      createYpmcnPlugin().register({
        rootDir,
        logger: { error() {} },
        on(name, handler) { localHooks.set(name, handler); },
      });
      assert.equal(await localHooks.get("before_tool_call")({ toolName: "read", params: {} }, {}), undefined);
      const blocked = await localHooks.get("before_tool_call")({
        toolName: "mcp__ypmcn__create_with_distributions",
        params: distributionParams(),
      }, {});
      assert.match(blocked.blockReason, /INTEGRATION_REQUIRED.*template/);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
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
    assert.deepEqual(errors, [
      "before_tool_call guard failed: guard exploded",
      "before_tool_call guard failed: guard exploded",
    ]);
  });
});
