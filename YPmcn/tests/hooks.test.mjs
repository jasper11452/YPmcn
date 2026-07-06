import assert from "node:assert/strict";
import { describe, it } from "node:test";
import plugin, {
  responseContractGuard,
  rewriteInvalidToolResult,
  runBeforeToolCallGuards,
} from "../dist/index.js";

function initialValidateParams(overrides = {}) {
  return {
    raw_messages: [
      {
        role: "client",
        content: "小红书找 10 个美妆博主，预算 5 万，返点最低 25%",
      },
    ],
    ...overrides,
  };
}

function collectBeforeToolCallHandlers() {
  const handlers = [];
  plugin.register({
    on(event, handler) {
      if (event === "before_tool_call") {
        handlers.push(handler);
      }
    },
  });
  return handlers;
}

function collectRegisteredEvents() {
  const events = [];
  plugin.register({
    on(event, handler) {
      events.push({ event, handler });
    },
  });
  return events;
}

function collectRegisteredTools() {
  return collectRegisteredToolRegistrations().map(({ tool }) => tool);
}

function collectRegisteredToolRegistrations() {
  const registrations = [];
  plugin.register({
    on() {},
    registerTool(tool, options) {
      registrations.push({ tool, options });
    },
  });
  return registrations;
}

function registeredHandler(eventName) {
  const entry = collectRegisteredEvents().find(({ event }) => event === eventName);
  assert.ok(entry, `missing registered handler for ${eventName}`);
  return entry.handler;
}

async function runRegisteredHandlers(ctx) {
  for (const handler of collectBeforeToolCallHandlers()) {
    const result = await handler(ctx);
    if (result?.block || result?.requireApproval) return result;
  }
  return undefined;
}

describe("YPmcn OpenClaw hook layering", () => {
  it("allows validate_requirement with the actual runtime schema", async () => {
    const result = await runBeforeToolCallGuards({
      toolName: "validate_requirement",
      params: initialValidateParams({
        project_context: { project_name: "夏季投放" },
        existing_demand_id: null,
        existing_demand_version: null,
      }),
    });

    assert.equal(result?.block, undefined);
  });

  it("blocks fields that the actual validate_requirement schema does not expose", async () => {
    const result = await runBeforeToolCallGuards({
      toolName: "validate_requirement",
      params: initialValidateParams({
        trace_id: "trace-001",
        idempotency_key: "idem-001",
        parsed_requirement: {},
      }),
    });

    assert.equal(result?.block, true);
    assert.match(result.blockReason, /trace_id/);
    assert.match(result.blockReason, /idempotency_key/);
    assert.match(result.blockReason, /parsed_requirement/);
  });

  it("blocks validate_requirement when raw_messages is missing", async () => {
    const result = await runBeforeToolCallGuards({
      toolName: "validate_requirement",
      params: {},
    });

    assert.equal(result?.block, true);
    assert.match(result.blockReason, /raw_messages/);
  });

  it("blocks rank_creators when allowed_actions and platform state contradict each other", async () => {
    const result = await runBeforeToolCallGuards({
      toolName: "rank_creators",
      params: {},
      sessionState: {
        workflow_state: {
          phase: "mcn_planning",
          allowed_actions: ["rank_creators"],
          pending_gate: null,
          platform_states: {
            xhs: { mcn_phase: "waiting_return", risk_level: null },
          },
        },
      },
    });

    assert.equal(result?.block, true);
    assert.match(result.blockReason, /mcn_phase=waiting_return|allowed_actions 与 platform_states 矛盾/);
  });

  it("asks for approval instead of requiring fields absent from the runtime schema", async () => {
    const result = await runBeforeToolCallGuards({
      toolName: "search_creators",
      params: { demand_id: "demand-1", demand_version: 1 },
      sessionState: {
        workflow_state: {
          phase: "requirement_ready",
          allowed_actions: ["search_creators"],
          pending_gate: {
            gate: "confirm_ready",
            gate_id: "gate-001",
            reason: "需求已校验，需要确认继续筛选",
            required_fields: ["gate_id", "confirmation_type", "operator_id"],
          },
          platform_states: {
            xhs: { mcn_phase: "not_started", risk_level: null },
          },
        },
      },
    });

    assert.equal(result?.block, undefined);
    assert.equal(result?.requireApproval?.title, "YPmcn 需要确认：confirm_ready");
  });

  it("uses medium_risk_confirmed from the actual rank_mcns schema", async () => {
    const result = await runBeforeToolCallGuards({
      toolName: "rank_mcns",
      params: {
        demand_id: "demand-1",
        demand_version: 1,
        platform: "xhs",
        medium_risk_confirmed: true,
      },
      sessionState: {
        workflow_state: {
          phase: "mcn_planning",
          allowed_actions: ["rank_mcns"],
          pending_gate: {
            gate: "confirm_medium_risk",
            gate_id: "gate-medium",
            reason: "供给倍率中风险",
            required_fields: ["medium_risk_confirmed"],
          },
          platform_states: {},
        },
      },
    });

    assert.equal(result, undefined);
  });

  it("blocks medium-risk continuation until medium_risk_confirmed is true", async () => {
    const result = await runBeforeToolCallGuards({
      toolName: "rank_mcns",
      params: { demand_id: "demand-1", demand_version: 1, platform: "xhs" },
      sessionState: {
        workflow_state: {
          phase: "mcn_planning",
          allowed_actions: ["rank_mcns"],
          pending_gate: {
            gate: "confirm_medium_risk",
            gate_id: "gate-medium",
            reason: "供给倍率中风险",
            required_fields: ["medium_risk_confirmed"],
          },
          platform_states: {},
        },
      },
    });

    assert.equal(result?.block, true);
    assert.match(result.blockReason, /medium_risk_confirmed/);
  });

  it("uses allow_need_confirm_with_risk from the actual submission schema", async () => {
    const result = await runBeforeToolCallGuards({
      toolName: "create_submission_batch",
      params: { run_id: "run-1", allow_need_confirm_with_risk: true },
      sessionState: {
        workflow_state: {
          phase: "recommendation_ready",
          allowed_actions: ["create_submission_batch"],
          pending_gate: {
            gate: "confirm_risky_submission",
            gate_id: "gate-risky",
            reason: "提报名单含待确认账号",
            required_fields: ["allow_need_confirm_with_risk"],
          },
          platform_states: { xhs: { mcn_phase: "ingested", risk_level: null } },
        },
      },
    });

    assert.equal(result, undefined);
  });

  it("blocks high-risk platform from ranking creators before recovery", async () => {
    const result = await runBeforeToolCallGuards({
      toolName: "rank_creators",
      params: {},
      sessionState: {
        workflow_state: {
          phase: "mcn_planning",
          allowed_actions: ["rank_creators"],
          pending_gate: null,
          platform_states: {
            xhs: { mcn_phase: "ranked", risk_level: "high_risk" },
          },
        },
      },
    });

    assert.equal(result?.block, true);
    assert.match(result.blockReason, /high_risk/);
  });

  it("requires one-time approval before ranking the candidate pool", async () => {
    const result = await runBeforeToolCallGuards({
      toolName: "rank_creators",
      params: { demand_id: "demand-1", demand_version: 1, platform: "xhs" },
      sessionState: {
        project_distribution_completed: true,
        workflow_state: {
          phase: "mcn_planning",
          allowed_actions: ["rank_creators"],
          pending_gate: null,
          platform_states: {
            xhs: { mcn_phase: "ingested", risk_level: null },
          },
        },
      },
    });

    assert.equal(result?.block, undefined);
    assert.equal(result?.requireApproval?.title, "确认对候选池进行达人精排");
    assert.equal(result?.requireApproval?.timeoutBehavior, "deny");
    assert.deepEqual(result?.requireApproval?.allowedDecisions, ["allow-once", "deny"]);
  });

  it("blocks rank_creators before create_with_distributions sends inquiries", async () => {
    const result = await runBeforeToolCallGuards({
      toolName: "rank_creators",
      params: { demand_id: "demand-1", demand_version: 1, platform: "xhs" },
      sessionState: {
        workflow_state: {
          phase: "mcn_planning",
          allowed_actions: ["rank_creators"],
          pending_gate: null,
          platform_states: {
            xhs: { mcn_phase: "ingested", risk_level: null },
          },
        },
      },
    });

    assert.equal(result?.block, true);
    assert.match(result.blockReason, /create_with_distributions|企微询价/);
  });

  it("allows clarify validate_requirement even when stale clarify gate exists", async () => {
    const result = await runBeforeToolCallGuards({
      toolName: "validate_requirement",
      params: initialValidateParams(),
      sessionState: {
        workflow_state: {
          phase: "requirement_draft",
          allowed_actions: ["validate_requirement"],
          pending_gate: {
            gate: "clarify_requirement",
            gate_id: "gate-clarify",
            reason: "需要补充需求",
            required_fields: ["raw_messages"],
          },
          platform_states: {},
        },
      },
    });

    assert.equal(result?.block, undefined);
  });

  it("blocks validate_requirement when parsed_requirement is sent", async () => {
    const result = await runBeforeToolCallGuards({
      toolName: "validate_requirement",
      params: initialValidateParams({ parsed_requirement: {} }),
    });

    assert.equal(result?.block, true);
    assert.match(result.blockReason, /parsed_requirement/);
  });

  it("registered activate hook uses the same dispatcher behavior", async () => {
    const result = await runRegisteredHandlers({
      toolName: "validate_requirement",
      params: initialValidateParams(),
    });

    assert.equal(result?.block, undefined);
  });

  it("registered before hook normalizes MCP-prefixed YPmcn tool names", async () => {
    const handler = registeredHandler("before_tool_call");
    const result = await handler(
      {
        toolName: "12221__validate_requirement",
        params: initialValidateParams({ trace_id: "not-a-request-field" }),
      },
      { sessionKey: "test:prefixed-before" },
    );

    assert.equal(result?.block, true);
    assert.match(result.blockReason, /trace_id/);
  });

  it("blocks shell create_with_distributions invocations and requires the YP Action tool", async () => {
    const before = registeredHandler("before_tool_call");
    const result = await before(
      {
        toolName: "exec",
        toolCallId: "distribution-approval-1",
        params: {
          command: "uv run create_with_distributions --remind-at 2099-07-06T18:00:00+08:00 --supplier media-1",
        },
      },
      { sessionKey: "distribution-approval-session", agentId: "main" },
    );

    assert.equal(result?.block, true);
    assert.match(result.blockReason, /不要通过 Bash|create_with_distributions/);
  });

  it("blocks curl create-with-distributions API calls before approval fallback can fail", async () => {
    const result = await registeredHandler("before_tool_call")(
      {
        toolName: "exec",
        toolCallId: "distribution-curl-1",
        params: {
          command: String.raw`curl -s -X POST "https://mcp.eshypdata.com/api/projects/create-with-distributions/" -H "Content-Type: application/json" -d '{"deadline":"2099-07-06T18:00:00+08:00"}'`,
        },
      },
      { sessionKey: "distribution-curl-session", agentId: "main" },
    );

    assert.equal(result?.block, true);
    assert.match(result.blockReason, /不要通过 Bash\/PowerShell\/curl|YP Action 工具|create_with_distributions/);
    assert.equal(result?.requireApproval, undefined);
  });

  it("blocks PowerShell create-with-distributions API calls before approval fallback can fail", async () => {
    const direct = await registeredHandler("before_tool_call")(
      {
        toolName: "powershell",
        toolCallId: "distribution-powershell-1",
        params: {
          command: String.raw`Invoke-WebRequest -Uri "http://100.107.143.45:8000/api/projects/create-with-distributions/" -Method POST`,
        },
      },
      { sessionKey: "distribution-powershell-session", agentId: "main" },
    );
    const nested = await registeredHandler("before_tool_call")(
      {
        toolName: "exec",
        toolCallId: "distribution-powershell-2",
        params: {
          command: String.raw`powershell -Command "irm http://100.107.143.45:8000/api/projects/create-with-distributions/ -Method POST"`,
        },
      },
      { sessionKey: "distribution-powershell-session", agentId: "main" },
    );

    assert.equal(direct?.block, true);
    assert.equal(nested?.block, true);
    assert.match(direct.blockReason, /不要通过 Bash\/PowerShell\/curl|YP Action 工具|create_with_distributions/);
    assert.match(nested.blockReason, /不要通过 Bash\/PowerShell\/curl|YP Action 工具|create_with_distributions/);
  });

  it("blocks pwsh create_with_distributions script invocations", async () => {
    const result = await registeredHandler("before_tool_call")(
      {
        toolName: "pwsh",
        toolCallId: "distribution-pwsh-1",
        params: {
          command: String.raw`./create_with_distributions.ps1 -deadline 2099-07-06T18:00:00+08:00`,
        },
      },
      { sessionKey: "distribution-pwsh-session", agentId: "main" },
    );

    assert.equal(result?.block, true);
    assert.match(result.blockReason, /不要通过 Bash\/PowerShell\/curl|YP Action 工具|create_with_distributions/);
  });

  it("requires one-time approval before a create_with_distributions tool call", async () => {
    const result = await registeredHandler("before_tool_call")(
      {
        toolName: "create_with_distributions",
        toolCallId: "distribution-tool-approval-1",
        params: {
          project: { projectName: "618达人提报", deadline: "2099-07-06T18:00:00+08:00" },
          supplierIds: ["supplier-1"],
          sendWechatNotification: true,
        },
      },
      { sessionKey: "distribution-tool-session", agentId: "main" },
    );

    assert.equal(result?.block, undefined);
    assert.equal(result?.requireApproval?.title, "创建项目并分发供应商前确认");
    assert.match(result?.requireApproval?.description, /create_with_distributions/);
  });

  it("does not treat a plain text mention as a create_with_distributions call", async () => {
    const result = await registeredHandler("before_tool_call")(
      {
        toolName: "exec",
        toolCallId: "distribution-mention-1",
        params: { command: "echo create_with_distributions --remind-at 2099-07-06T18:00:00+08:00" },
      },
      { sessionKey: "distribution-mention-session" },
    );

    assert.equal(result, undefined);
  });

  it("blocks create_with_distributions without a valid future reminder time", async () => {
    const before = registeredHandler("before_tool_call");

    const missing = await before(
      {
        toolName: "create_with_distributions",
        toolCallId: "distribution-invalid-1",
        params: { supplierIds: ["supplier-1"] },
      },
      { sessionKey: "distribution-invalid-session-1" },
    );
    const expired = await before(
      {
        toolName: "create_with_distributions",
        toolCallId: "distribution-invalid-2",
        params: { deadline: "2020-01-01T00:00:00+08:00", supplierIds: ["supplier-1"] },
      },
      { sessionKey: "distribution-invalid-session-2" },
    );

    assert.equal(missing?.block, true);
    assert.match(missing.blockReason, /deadline|remind/i);
    assert.equal(expired?.block, true);
    assert.match(expired.blockReason, /未来时间/);
  });

  it("does not create a cron reminder after an approved successful distribution and waits for the user", async () => {
    const before = registeredHandler("before_tool_call");
    const after = registeredHandler("after_tool_call");
    const event = {
      toolName: "create_with_distributions",
      toolCallId: "distribution-success-1",
      params: { deadline: "2099-07-06T18:00:00+08:00", supplierIds: ["supplier-1"] },
    };
    const ctx = { sessionKey: "distribution-success-session", agentId: "main" };

    const approval = await before(event, ctx);
    await approval.requireApproval.onResolution("allow-once");
    await after({ ...event, result: { exitCode: 0 } }, ctx);
    await after({ ...event, result: { exitCode: 0 } }, ctx);

    const waiting = await before(
      { toolName: "read", toolCallId: "read-waiting", params: {} },
      ctx,
    );
    assert.equal(waiting?.block, true);
    assert.match(waiting.blockReason, /等待用户/);
    assert.doesNotMatch(waiting.blockReason, /提醒|Cron|cron/);

    const otherSession = await before(
      { toolName: "read", toolCallId: "read-other", params: {} },
      { sessionKey: "distribution-other-session" },
    );
    assert.equal(otherSession, undefined);

    await registeredHandler("message_received")(
      { from: "media-user", content: "继续", sessionKey: "distribution-success-session" },
      { channelId: "wecom", sessionKey: "distribution-success-session" },
    );
    const resumed = await before(
      { toolName: "read", toolCallId: "read-resumed", params: {} },
      ctx,
    );
    assert.equal(resumed, undefined);
  });

  it("allows create_with_distributions without a cron service", async () => {
    const result = await registeredHandler("before_tool_call")(
      {
        toolName: "create_with_distributions",
        toolCallId: "distribution-no-cron-1",
        params: { deadline: "2099-07-06T18:00:00+08:00", supplierIds: ["supplier-1"] },
      },
      { sessionKey: "distribution-no-cron-session", agentId: "main" },
    );

    assert.equal(result?.block, undefined);
    assert.equal(result?.requireApproval?.title, "创建项目并分发供应商前确认");
  });

  it("does not schedule or lock after distribution denial or failure", async () => {
    const before = registeredHandler("before_tool_call");
    const after = registeredHandler("after_tool_call");
    const ctx = { sessionKey: "distribution-failure-session" };
    const denied = {
      toolName: "create_with_distributions",
      toolCallId: "distribution-denied-1",
      params: { deadline: "2099-07-06T18:00:00+08:00", supplierIds: ["supplier-1"] },
    };
    const failed = {
      toolName: "create_with_distributions",
      toolCallId: "distribution-failed-1",
      params: { deadline: "2099-07-06T19:00:00+08:00", supplierIds: ["supplier-1"] },
    };

    const deniedApproval = await before(denied, ctx);
    await deniedApproval.requireApproval.onResolution("deny");
    await after({ ...denied, result: { exitCode: 0 } }, ctx);

    const failedApproval = await before(failed, ctx);
    await failedApproval.requireApproval.onResolution("allow-once");
    await after({ ...failed, result: { exitCode: 1 }, error: "exit 1" }, ctx);

    const next = await before(
      { toolName: "read", toolCallId: "read-after-failure", params: {} },
      ctx,
    );
    assert.equal(next, undefined);
  });

  it("allows rank_creators approval after distribution succeeds and the user continues", async () => {
    const before = registeredHandler("before_tool_call");
    const after = registeredHandler("after_tool_call");
    const messageReceived = registeredHandler("message_received");
    const ctx = { sessionKey: "distribution-then-rank-session" };
    const event = {
      toolName: "create_with_distributions",
      toolCallId: "distribution-then-rank-1",
      params: { deadline: "2099-07-06T20:00:00+08:00", supplierIds: ["supplier-1"] },
    };

    const approval = await before(event, ctx);
    await approval.requireApproval.onResolution("allow-once");
    await after({ ...event, result: { exitCode: 0 } }, ctx);

    await messageReceived(
      { from: "media-user", content: "继续精排", sessionKey: "distribution-then-rank-session" },
      ctx,
    );

    const ranking = await before(
      { toolName: "rank_creators", toolCallId: "rank-after-distribution", params: {} },
      ctx,
    );
    assert.equal(ranking?.block, undefined);
    assert.equal(ranking?.requireApproval?.title, "确认对候选池进行达人精排");
  });

  it("response contract guard accepts the actual common response envelope", () => {
    const errors = responseContractGuard({
      toolName: "validate_requirement",
      success: true,
      data: {},
      error: null,
      traceId: "trace-ok",
    });

    assert.deepEqual(errors, []);
  });

  it("response contract guard accepts valid workflow_state envelope", () => {
    const errors = responseContractGuard({
      toolName: "validate_requirement",
      success: true,
      data: {},
      workflowState: {
        phase: "requirement_ready",
        pending_gate: null,
        platform_states: {
          xhs: { mcn_phase: "not_started", risk_level: null },
        },
      },
      allowedActions: ["search_creators"],
      traceId: "trace-state",
    });

    assert.deepEqual(errors, []);
  });

  it("response contract guard blocks validate_requirement results that contradict the original brief", () => {
    const originalBrief = "媒介助手：\n平台：小红书\n品牌：腾讯workbuddy\n账号类型：ai/学习/职场/大学生/泛生活\n非报备预算：1w粉以下 视频预算500以内\n1-2w粉 视频预算1000内\n数据好的情况下，预算可放宽至1500以内\n要5个人，返点5%\n数据要求：平均cpe低于3";
    const errors = responseContractGuard({
      toolName: "validate_requirement",
      success: true,
      error: null,
      traceId: "trace-bad-parse",
      params: {
        raw_messages: [{ role: "client", content: originalBrief }],
      },
      data: {
        status: "ready",
        requirement_parsed: {
          platforms: ["xhs", "dy"],
          category_requirements: ["教育"],
          budget_min_cents: 1000000,
          budget_max_cents: 2000000,
          budget_raw: "以内\n1-2w",
          quantity_total: 5,
        },
      },
    });

    assert.equal(errors.length, 2);
    assert.match(errors.map((error) => error.message).join("; "), /平台.*dy/);
    assert.match(errors.map((error) => error.message).join("; "), /预算.*粉/);
    assert.doesNotMatch(errors.map((error) => error.message).join("; "), /类目.*账号类型/);
  });

  it("response contract guard accepts soft account requirements outside category fields", () => {
    const originalBrief = "平台：小红书\n账号类型：ai/学习/职场/大学生/泛生活\n单价500以内\n需要5个\nDDL：2099-07-06 18:00前";
    const errors = responseContractGuard({
      toolName: "validate_requirement",
      success: true,
      error: null,
      traceId: "trace-soft-requirements",
      params: {
        raw_messages: [{ role: "client", content: originalBrief }],
      },
      data: {
        status: "ready",
        requirement_parsed: {
          platforms: ["xhs"],
          category_requirements: [],
          creator_type_requirements: [],
          content_requirements: "ai 学习 职场 大学生 泛生活",
          budget_max_cents: 50000,
          quantity_total: 5,
          submission_deadline_at: "2099-07-06T18:00:00+08:00",
        },
      },
    });

    assert.deepEqual(errors, []);
  });

  it("response persistence rewrites an envelope missing trace_id", () => {
    const rewritten = rewriteInvalidToolResult({
      toolName: "validate_requirement",
      success: true,
      data: {},
    });

    assert.equal(rewritten.success, false);
    assert.equal(rewritten.error.code, "INVALID_RESPONSE_CONTRACT");
    assert.equal(rewritten.data, null);
    assert.equal(rewritten.trace_id, undefined);
  });

  it("registered persistence hook synchronously rewrites an invalid YPmcn message", () => {
    const handler = registeredHandler("tool_result_persist");
    const result = handler(
      {
        toolName: "12221__validate_requirement",
        toolCallId: "call-bad",
        message: {
          role: "toolResult",
          toolCallId: "call-bad",
          toolName: "12221__validate_requirement",
          content: [{ type: "text", text: JSON.stringify({ success: true, data: {} }) }],
          details: {
            structuredContent: { success: true, data: {} },
          },
          isError: false,
        },
      },
      { sessionKey: "test:persist-invalid" },
    );

    assert.equal(typeof result?.then, "undefined", "tool_result_persist must not return a Promise");
    assert.equal(result.message.isError, true);
    assert.equal(result.message.details.ypmcn.invalidResponseContract, true);
    assert.equal(result.message.details.structuredContent.error.code, "INVALID_RESPONSE_CONTRACT");
    assert.equal(JSON.parse(result.message.content[0].text).error.code, "INVALID_RESPONSE_CONTRACT");
  });

  it("registered persistence hook rewrites semantically invalid validate_requirement results", () => {
    const handler = registeredHandler("tool_result_persist");
    const originalBrief = "平台：小红书\n账号类型：ai/学习/职场/大学生/泛生活\n非报备预算：1w粉以下 视频预算500以内\n1-2w粉 视频预算1000内\n数据好的情况下，预算可放宽至1500以内";
    const envelope = {
      success: true,
      error: null,
      trace_id: "trace-semantic-bad",
      data: {
        status: "ready",
        requirement_parsed: {
          platforms: ["xhs", "dy"],
          category_requirements: ["教育"],
          budget_min_cents: 1000000,
          budget_max_cents: 2000000,
          budget_raw: "以内\n1-2w",
        },
      },
    };
    const result = handler({
      toolName: "12221__validate_requirement",
      toolCallId: "call-semantic-bad",
      params: {
        raw_messages: [{ role: "client", content: originalBrief }],
      },
      message: {
        role: "toolResult",
        toolCallId: "call-semantic-bad",
        toolName: "12221__validate_requirement",
        content: [{ type: "text", text: JSON.stringify(envelope) }],
        details: { structuredContent: envelope },
        isError: false,
      },
    });

    assert.equal(result.message.isError, true);
    assert.equal(result.message.details.structuredContent.error.code, "INVALID_REQUIREMENT_PARSE");
    assert.match(result.message.details.structuredContent.error.message, /平台.*dy/);
  });

  it("registered persistence hook leaves non-YPmcn tool results untouched", () => {
    const handler = registeredHandler("tool_result_persist");
    const result = handler({
      toolName: "read",
      toolCallId: "call-read",
      message: {
        role: "toolResult",
        toolCallId: "call-read",
        toolName: "read",
        content: [{ type: "text", text: "ordinary read output" }],
        isError: false,
      },
    });

    assert.equal(result, undefined);
  });

  it("persisted workflow state is reused by the next prefixed tool call in the same session", async () => {
    const persist = registeredHandler("tool_result_persist");
    const before = registeredHandler("before_tool_call");
    const sessionKey = "test:workflow-cache";
    const workflowState = {
      phase: "mcn_planning",
      allowed_actions: ["rank_creators"],
      pending_gate: null,
      platform_states: {
        xhs: { mcn_phase: "waiting_return", risk_level: null },
      },
    };
    const envelope = {
      success: true,
      data: {},
      error: null,
      trace_id: "trace-state-cache",
      workflow_state: workflowState,
      allowed_actions: ["rank_creators"],
    };

    const persisted = persist(
      {
        toolName: "12221__get_recommendation_run_detail",
        toolCallId: "call-state",
        message: {
          role: "toolResult",
          toolCallId: "call-state",
          toolName: "12221__get_recommendation_run_detail",
          content: [{ type: "text", text: JSON.stringify(envelope) }],
          details: { structuredContent: envelope },
          isError: false,
        },
      },
      { sessionKey },
    );
    assert.equal(persisted, undefined);

    const result = await before(
      { toolName: "12221__rank_creators", params: {} },
      { sessionKey },
    );

    assert.equal(result?.block, true);
    assert.match(result.blockReason, /mcn_phase=waiting_return|allowed_actions 与 platform_states 矛盾/);
  });

  it("plugin entry registers optional tool and message hooks", () => {
    const registered = collectRegisteredEvents().map((entry) => entry.event).sort();
    const registrations = collectRegisteredToolRegistrations();
    const tools = registrations.map(({ tool }) => tool.name);

    assert.deepEqual(registered, [
      "after_tool_call",
      "before_tool_call",
      "message_received",
      "tool_result_persist",
    ]);
    assert.deepEqual(tools, ["create_with_distributions"]);
    assert.equal(registrations[0]?.options?.optional, true);
  });

  it("create_with_distributions local tool returns a dry-run envelope by default", async () => {
    const [tool] = collectRegisteredTools();
    const result = await tool.execute("dry-run-call", {
      mcn_run_id: "c2a1a52977c545cfb9e98fa8625bbc4d",
      deadline: "2099-08-31T18:00:00+08:00",
      projectName: "测试项目",
    });
    const envelope = JSON.parse(result.content[0].text);

    assert.equal(envelope.success, true);
    assert.equal(envelope.data.dry_run, true);
    assert.equal(envelope.data.endpointUrl, undefined);
    assert.equal(envelope.data.payload.mcn_run_id, "c2a1a52977c545cfb9e98fa8625bbc4d");
    assert.equal(envelope.data.payload.remindAt, "2099-08-31T18:00:00+08:00");
    assert.equal(envelope.error, null);
    assert.equal(envelope.trace_id, "local-dry-run");
  });

  it("create_with_distributions tool schema does not expose live-send controls", () => {
    const [tool] = collectRegisteredTools();

    assert.equal(tool.parameters.properties.execute, undefined);
    assert.equal(tool.parameters.properties.endpointUrl, undefined);
  });

  it("create_with_distributions local tool rejects legacy live-send controls", async () => {
    const [tool] = collectRegisteredTools();
    const result = await tool.execute("legacy-live-call", {
      mcn_run_id: "c2a1a52977c545cfb9e98fa8625bbc4d",
      deadline: "2099-08-31T18:00:00+08:00",
      execute: true,
      endpointUrl: "http://100.107.143.45:8000/api/projects/create-with-distributions/",
    });
    const envelope = JSON.parse(result.content[0].text);

    assert.equal(result.isError, true);
    assert.equal(envelope.success, false);
    assert.equal(envelope.error.code, "INVALID_ARGUMENT");
    assert.match(envelope.error.message, /execute|endpointUrl/);
  });

  it("registered before hook passes validate_requirement with normal raw_messages through the JSON pre-parse", async () => {
    const before = registeredHandler("before_tool_call");
    const result = await before(
      {
        toolName: "validate_requirement",
        params: initialValidateParams(),
      },
      { sessionKey: "test:pre-parse-valid" },
    );

    assert.notEqual(result?.block, true);
  });

  it("registered before hook blocks validate_requirement with unserializable raw_messages before guards run", async () => {
    const before = registeredHandler("before_tool_call");
    const circular = { role: "client", content: "circular" };
    circular.self = circular;
    const result = await before(
      {
        toolName: "validate_requirement",
        params: {
          raw_messages: [circular],
        },
      },
      { sessionKey: "test:pre-parse-circular" },
    );

    assert.equal(result?.block, true);
    assert.match(result.blockReason, /raw_messages/);
    assert.match(result.blockReason, /序列化/);
  });
});
