import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import plugin from "../dist/index.js";

const pluginRoot = new URL("..", import.meta.url).pathname;
const tempDir = mkdtempSync(join(tmpdir(), "ypmcn-native-hooks-"));
const stateFile = join(tempDir, "session_guard.json");
const hooks = new Map();

function writeSession(phase, runId = "run-native-1") {
  writeFileSync(stateFile, JSON.stringify({
    schema_version: 1,
    sessions: {
      "native-session": {
        phase,
        ids: { requirement_id: "req-native-1", run_id: runId },
        confirmations: { supplyConfirmed: true, mcnConfirmed: true, messageConfirmed: true },
        field_selection: { selected: true, fieldNames: ["creator_name"] },
        sync: { first_sync_done: true, latest_lifecycle: "recovered" },
        _updated_at_ms: Date.now(),
      },
    },
  }), "utf8");
}

before(() => {
  process.env.YPMCN_STATE_FILE = stateFile;
  plugin.register({
    rootDir: pluginRoot,
    logger: { error() {} },
    on(name, handler) { hooks.set(name, handler); },
  });
});

after(() => {
  delete process.env.YPMCN_STATE_FILE;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("OpenClaw native hook bridge", () => {
  it("registers the supported tool and session hooks", () => {
    assert.deepEqual([...hooks.keys()].sort(), ["after_tool_call", "before_tool_call", "session_end"]);
  });

  it("blocks a provider write attempted through shell", async () => {
    const result = await hooks.get("before_tool_call")({
      toolName: "Bash",
      params: { command: "curl -X POST https://api/create-with-distributions" },
      toolCallId: "call-1",
    }, { sessionKey: "native-session" });
    assert.equal(result.block, true);
    assert.match(result.blockReason, /INTEGRATION_REQUIRED/);
  });

  it("allows provider-authoritative planning without host session context", async () => {
    const planningCalls = [
      {
        toolName: "mcp__ypmcn__validate_requirement",
        params: { payload: { projectName: "demo", status: "ready" } },
        toolCallId: "call-stateless-validate",
      },
      {
        toolName: "mcp__ypmcn__search_creators",
        params: { id: "req-stateless-1" },
        toolCallId: "call-stateless-search",
      },
      {
        toolName: "mcp__ypmcn__rank_mcns",
        params: { id: "req-stateless-1", platform: "xiaohongshu" },
        toolCallId: "call-stateless-rank",
      },
    ];

    for (const event of planningCalls) {
      const result = await hooks.get("before_tool_call")(event, {});
      assert.equal(result, undefined);
    }

    const highRiskResult = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__create_submission_batch",
      params: { run_id: "run-stateless-1" },
      toolCallId: "call-stateless-submit",
    }, {});
    assert.match(highRiskResult.blockReason, /INVALID_INPUT/);
  });

  it("guards manual adjustment audits as recommendation-stage writes", async () => {
    const auditEvent = (params = {}, toolCallId = "call-audit") => ({
      toolName: "mcp__ypmcn__audit_manual_adjustment",
      params: {
        run_id: "run-native-1",
        adjustments: [{ reason: "客户明确要求调整顺序" }],
        operator_id: "operator-native-1",
        ...params,
      },
      toolCallId,
    });

    let result = await hooks.get("before_tool_call")(auditEvent(), {});
    assert.match(result.blockReason, /INVALID_INPUT/);

    rmSync(stateFile, { force: true });
    result = await hooks.get("before_tool_call")(auditEvent(), { sessionKey: "native-session" });
    assert.match(result.blockReason, /INTEGRATION_REQUIRED/);

    writeSession("recovered");
    result = await hooks.get("before_tool_call")(auditEvent(), { sessionKey: "native-session" });
    assert.match(result.blockReason, /RECOVERY_ALREADY_TERMINAL/);

    writeSession("submission_batch_ready");
    result = await hooks.get("before_tool_call")(auditEvent(), { sessionKey: "native-session" });
    assert.match(result.blockReason, /BLOCKED_PHASE_MISMATCH/);

    writeSession("recommendation_ready");
    result = await hooks.get("before_tool_call")(auditEvent({ run_id: "wrong-run" }), { sessionKey: "native-session" });
    assert.match(result.blockReason, /BLOCKED_SEMANTIC_ID_MISMATCH/);

    result = await hooks.get("before_tool_call")(auditEvent({ adjustments: [] }), { sessionKey: "native-session" });
    assert.match(result.blockReason, /INVALID_INPUT/);

    result = await hooks.get("before_tool_call")(auditEvent({ adjustments: [{}] }), { sessionKey: "native-session" });
    assert.match(result.blockReason, /INVALID_INPUT/);

    result = await hooks.get("before_tool_call")(auditEvent({ operator_id: "" }), { sessionKey: "native-session" });
    assert.match(result.blockReason, /INVALID_INPUT/);

    result = await hooks.get("before_tool_call")(auditEvent({}, ""), { sessionKey: "native-session" });
    assert.match(result.blockReason, /INVALID_INPUT/);

    result = await hooks.get("before_tool_call")(auditEvent(), { sessionKey: "native-session" });
    assert.equal(result, undefined);

    await hooks.get("after_tool_call")({
      ...auditEvent(),
      result: { success: true, data: { audit_id: "audit-native-1" } },
    }, { sessionKey: "native-session" });
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.sessions["native-session"].phase, "recommendation_ready");
  });

  it("projects a successful MCP result and cleans the ended session", async () => {
    await hooks.get("after_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params: { payload: { raw: "brief" } },
      toolCallId: "call-2",
      result: { success: true, data: { id: "req-native-1" } },
    }, { sessionKey: "native-session" });

    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.sessions["native-session"].phase, "requirement_ready");
    assert.equal(state.sessions["native-session"].ids.requirement_id, "req-native-1");

    await hooks.get("session_end")({
      sessionId: "native-session-id",
      sessionKey: "native-session",
      messageCount: 1,
    }, { sessionKey: "native-session" });
    const cleaned = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(cleaned.sessions["native-session"], undefined);
  });

  it("uses the actual mcn_run_id returned by rank_mcns", async () => {
    writeSession("search_completed");
    await hooks.get("after_tool_call")({
      toolName: "mcp__ypmcn__rank_mcns",
      params: { id: "req-native-1", platform: "xiaohongshu" },
      toolCallId: "call-rank-mcns",
      result: { success: true, data: { mcn_run_id: "mcn-run-native-1", mcns: [] } },
    }, { sessionKey: "native-session" });

    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.sessions["native-session"].phase, "mcn_planning");
    assert.equal(state.sessions["native-session"].ids.mcn_run_id, "mcn-run-native-1");
    assert.equal(state.sessions["native-session"].lastResultIssue, undefined);
  });
});
