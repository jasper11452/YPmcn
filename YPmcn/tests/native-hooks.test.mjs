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
  description: JSON.stringify({ title: "测试项目", platform: "小红书", price: { 图文: "5000元以内" } }),
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

async function requestApproval(params = distributionParams(), context = {}, toolCallId = "call-send") {
  const result = await guard("mcp__ypmcn__create_with_distributions", params, toolCallId, context);
  assert.equal(result?.block, undefined);
  assert.equal(result?.requireApproval?.title, "企微外发确认");
  assert.equal(result.requireApproval.severity, "warning");
  assert.equal(typeof result.requireApproval.onResolution, "function");
  return { result, params, toolCallId };
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
    assert.match(prompt.prependContext, /authoritative local orchestration state/);
    assert.match(prompt.prependContext, /"next_action":"validate_requirement"/);
    assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).schema_version, 13);

    for (const [toolName, params] of [
      ["read", { file_path: "/tmp/SKILL.md" }],
      ["AskUserQuestion", { questions: [{ header: "供给确认" }] }],
      ["mcp__ypmcn__validate_requirement", { payload: {} }],
      ["mcp__ypmcn__rank_mcns", { id: "any", platform: "xiaohongshu" }],
    ]) {
      assert.equal(await guard(toolName, params), undefined, toolName);
    }
  });

  it("allows every declared business Tool except that send receives native approval", async () => {
    for (const name of [...contract.requiredTools, ...contract.optionalTools]) {
      const result = await guard(`mcp__ypmcn__${name}`, name === "create_with_distributions" ? distributionParams() : {});
      if (name === "create_with_distributions") assert.ok(result.requireApproval);
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

  it("binds a native warning to the original pending call so approval can resume it directly", async () => {
    const { result, params, toolCallId } = await requestApproval(distributionParams({
      supplierIds: ["supplier-1", "supplier-2"],
      description: JSON.stringify({ title: "真实企微消息" }),
    }));
    assert.match(result.requireApproval.description, /2 家机构/);
    assert.match(result.requireApproval.description, /真实企微消息/);
    assert.ok(Array.from(result.requireApproval.description).length <= 256);

    await result.requireApproval.onResolution("allow-once");
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    const receipt = state.confirmations[state.latest_external_confirmation_id];
    assert.equal(receipt.status, "in_flight");
    assert.equal(receipt.tool_call_id, toolCallId);

    // If the host re-enters before_tool_call while resuming, the exact call is allowed without a second popup.
    assert.equal(await guard("mcp__ypmcn__create_with_distributions", params, toolCallId), undefined);
    await recordTool(
      "mcp__ypmcn__create_with_distributions",
      params,
      { success: true, data: { project_id: "project-1" }, error: null },
      {},
      toolCallId,
    );
    const consumed = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(consumed.confirmations[consumed.latest_external_confirmation_id].status, "consumed");
    assert.equal(consumed.workflow.phase, "waiting_mcn_return");
  });

  it("keeps long WeCom previews within the native approval description limit", async () => {
    const { result } = await requestApproval(distributionParams({
      description: JSON.stringify({ content: "长消息".repeat(300) }),
    }), {}, "call-long-preview");
    assert.equal(Array.from(result.requireApproval.description).length, 256);
    assert.match(result.requireApproval.description, /…$/);
  });

  it("does not authorize deny, timeout, or a changed request", async () => {
    for (const [index, decision] of ["deny", "timeout", "cancelled"].entries()) {
      const { result, params } = await requestApproval(
        distributionParams({ requirement_id: `requirement-${index}` }),
        {},
        `call-${index}`,
      );
      await result.requireApproval.onResolution(decision);
      const retry = await guard("mcp__ypmcn__create_with_distributions", params, `call-${index}-retry`);
      assert.ok(retry.requireApproval, decision);
    }

    const first = await requestApproval(distributionParams(), {}, "call-original");
    await first.result.requireApproval.onResolution("allow-once");
    const changed = await guard(
      "mcp__ypmcn__create_with_distributions",
      { ...first.params, supplierIds: ["supplier-other"] },
      "call-original",
    );
    assert.ok(changed.requireApproval);
  });

  it("requires a fresh approval after success or unknown result", async () => {
    for (const [index, eventResult] of [
      [0, { success: true, data: {}, error: null }],
      [1, undefined],
    ]) {
      const params = distributionParams({ requirement_id: `requirement-replay-${index}` });
      const prepared = await requestApproval(params, {}, `call-replay-${index}`);
      await prepared.result.requireApproval.onResolution("allow-once");
      if (eventResult) {
        await recordTool("mcp__ypmcn__create_with_distributions", params, eventResult, {}, `call-replay-${index}`);
      } else {
        await hooks.get("after_tool_call")({
          toolName: "mcp__ypmcn__create_with_distributions",
          params,
          toolCallId: `call-replay-${index}`,
          error: "connection lost",
        }, {});
      }
      assert.ok((await guard(
        "mcp__ypmcn__create_with_distributions",
        params,
        `call-replay-${index}-next`,
      )).requireApproval);
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
        question: "是否按以上供给建议开始MCN赛马？",
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

  it("isolates workflow and approval state by host session", async () => {
    const first = { sessionKey: "session-one" };
    const second = { sessionKey: "session-two" };
    await hooks.get("before_prompt_build")({ prompt: UNRESOLVED_BRIEF, messages: [] }, first);
    await hooks.get("before_prompt_build")({ prompt: UNRESOLVED_BRIEF, messages: [] }, second);
    const approval = await requestApproval(distributionParams(), first, "call-session-one");
    await approval.result.requireApproval.onResolution("allow-once");
    assert.ok(readFileSync(sessionStateFile("session-one"), "utf8"));
    assert.ok(readFileSync(sessionStateFile("session-two"), "utf8"));
    const secondState = JSON.parse(readFileSync(sessionStateFile("session-two"), "utf8"));
    assert.deepEqual(secondState.confirmations, {});
  });

  it("stores fingerprints and workflow metadata without persisting the message body", async () => {
    await requestApproval(distributionParams({
      description: JSON.stringify({ private_note: "should-not-be-stored" }),
    }));
    const persisted = readFileSync(stateFile, "utf8");
    assert.match(persisted, /"input_fingerprint": "[0-9a-f]{64}"/);
    assert.match(persisted, /"workflow"/);
    assert.doesNotMatch(persisted, /should-not-be-stored/);
  });

  it("still presents approval when provider arguments are incomplete because ordinary schema validation is not a Hook gate", async () => {
    const result = await guard("mcp__ypmcn__create_with_distributions", {}, "call-provider-validation");
    assert.ok(result.requireApproval);
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
