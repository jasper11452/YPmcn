import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import plugin, { YPMCN_FAST_PATH } from "../dist/index.js";

const tempDir = mkdtempSync(join(tmpdir(), "ypmcn-native-hooks-"));
const stateFile = join(tempDir, "state", "confirmation_guard.json");
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

before(() => {
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
  await hooks.get("after_tool_call")({
    toolName: "AskUserQuestion",
    params: {
      questions: [{
        question: `即将向 1 家机构发送询价。[YP_CONFIRMATION:${id}]`,
        options: [{ label: "确认发送" }, { label: "需要修改" }],
      }],
    },
    result: { status: "submitted", answers: [{ selected_labels: [answer] }] },
  }, {});
}

async function answerSupplyPlanConfirmation(id, answer = "确认供给方案") {
  await hooks.get("after_tool_call")({
    toolName: "AskUserQuestion",
    params: {
      questions: [{
        question: `供需比 2:1，建议机构 8 家、手扒 2 人。[YP_SUPPLY_PLAN_CONFIRMATION:${id}]`,
        options: [{ label: "确认供给方案" }, { label: "调整方案" }],
      }],
    },
    result: { status: "submitted", answers: [{ selected_labels: [answer] }] },
  }, {});
}

describe("YP Action native hook guard", () => {
  it("registers tool hooks without relying on session lifecycle", () => {
    assert.deepEqual([...hooks.keys()].sort(), ["after_tool_call", "before_prompt_build", "before_tool_call", "session_end"]);
  });

  it("injects the standard brief fast path before prompt construction", async () => {
    const result = await hooks.get("before_prompt_build")({ prompt: "小红书达人需求", messages: [] }, {});
    assert.equal(result.prependSystemContext, YPMCN_FAST_PATH);
    assert.match(result.prependSystemContext, /first business call is validate_requirement/);
    assert.match(result.prependSystemContext, /divided by 100/);
    assert.match(result.prependSystemContext, /YYYY-MM-DD HH:mm:ss/);
    assert.match(result.prependSystemContext, /requirement_ready.*search_creators/);
    assert.match(result.prependSystemContext, /candidate_pool_ready.*rank_mcns/);
    assert.match(result.prependSystemContext, /supply_demand_ratio/);
    assert.match(result.prependSystemContext, /successful WeCom distribution plus completed recovery/);
    assert.match(result.prependSystemContext, /sync -> ingest_mcn_submissions.*-> sync/);
    assert.match(result.prependSystemContext, /create_submission_batch\(\{run_id\}\)/);
    assert.match(result.prependSystemContext, /Omit optional and null fields/);
    assert.match(result.prependSystemContext, /generic tool failure gets no automatic retry/);
    assert.match(result.prependSystemContext, /including timeout_seconds/);
    assert.match(result.prependSystemContext, /Do not read mcporter or another Skill/);
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

  it("blocks incomplete or ambiguous requirement writes", async () => {
    for (const payload of [
      { projectName: "", status: "ready" },
      { projectName: "测试", status: "draft" },
    ]) {
      const blocked = await hooks.get("before_tool_call")({
        toolName: "mcp__ypmcn__validate_requirement",
        params: { payload },
        toolCallId: "call-incomplete-requirement",
      }, {});
      assert.equal(blocked.block, true);
      assert.match(blocked.blockReason, /BLOCKED_REQUIREMENT_INCOMPLETE/);
    }
  });

  it("requires a popup supply-plan confirmation before rank_mcns", async () => {
    const params = { id: "req-supply-1", platform: "xiaohongshu" };
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
    assert.match(replay.blockReason, /YP_CONFIRMATION_REQUIRED/);
  });

  it("invalidates confirmation when request parameters change", async () => {
    const { id, params } = await requestConfirmation(distributionParams({ projectName: "变更测试" }));
    await answerConfirmation(id);
    const changed = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__create_with_distributions",
      params: { ...params, supplierIds: ["supplier-1", "supplier-2"] },
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
