import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { registerHooks } from "../dist/hooks/register.js";
import { createRuntimeStateStore } from "../dist/hooks/runtime-state.js";

const NOW = Date.parse("2026-07-11T10:00:00+08:00");

function fakeApi() {
  const handlers = new Map();
  const actions = new Map();
  return {
    handlers,
    actions,
    session: {
      controls: {
        registerSessionAction(action) {
          actions.set(action.id, action);
        },
      },
    },
    on(name, handler) {
      handlers.set(name, handler);
    },
  };
}

describe("OpenClaw v2 hook registration", () => {
  it("registers the complete state-safe event surface", () => {
    const api = fakeApi();
    const store = createRuntimeStateStore({ now: () => NOW });
    registerHooks(api, { store, now: () => NOW });
    assert.deepEqual([...api.handlers.keys()].sort(), [
      "after_tool_call",
      "agent_turn_prepare",
      "before_tool_call",
      "message_received",
      "session_end",
      "tool_result_persist",
    ]);
    assert.deepEqual([...api.actions.keys()], ["confirm_distribution_send"]);
  });

  it("records send confirmation only through the scoped host session action", async () => {
    const api = fakeApi();
    const store = createRuntimeStateStore({ now: () => NOW });
    store.set("session-1", {
      phase: "field_selection_ready",
      mcn_recommendation_id: "mcnr-1",
    });
    registerHooks(api, { store, now: () => NOW });

    const action = api.actions.get("confirm_distribution_send");
    assert.deepEqual(action.requiredScopes, ["operator.write"]);
    const result = await action.handler({
      sessionKey: "session-1",
      client: { scopes: ["operator.write"] },
      payload: {
        mcn_recommendation_id: "mcnr-1",
        operatorRole: "media",
        supplyConfirmed: true,
        mcnConfirmed: true,
        messageConfirmed: true,
      },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(store.get("session-1")?.sendConfirmation, {
      mcn_recommendation_id: "mcnr-1",
      operatorRole: "media",
      supplyConfirmed: true,
      mcnConfirmed: true,
      messageConfirmed: true,
      confirmedAt: NOW,
    });

    const stale = await action.handler({
      sessionKey: "session-1",
      client: { scopes: ["operator.write"] },
      payload: {
        mcn_recommendation_id: "mcnr-stale",
        operatorRole: "media",
        supplyConfirmed: true,
        mcnConfirmed: true,
        messageConfirmed: true,
      },
    });
    assert.equal(stale.ok, false);
    assert.equal(store.get("session-1")?.sendConfirmation?.mcn_recommendation_id, "mcnr-1");
  });

  it("routes the real bundle-MCP host name through the registered before hook", async () => {
    const api = fakeApi();
    const store = createRuntimeStateStore({ now: () => NOW });
    store.set("session-1", { phase: "requirement_ready", requirement_id: "req-1" });
    registerHooks(api, { store, now: () => NOW });

    const result = await api.handlers.get("before_tool_call")({
      toolName: "ypmcn__search_creators",
      params: { demand_id: "legacy" },
      toolCallId: "call-1",
    }, { sessionKey: "session-1" });

    assert.equal(result.block, true);
    assert.match(result.blockReason, /SCHEMA_MISMATCH/);
  });

  it("keeps waiting state for ordinary messages and records only explicit recovery intent", async () => {
    const api = fakeApi();
    const store = createRuntimeStateStore({ now: () => NOW });
    store.set("session-1", {
      phase: "waiting_return",
      requirement_id: "req-1",
      mcn_recommendation_id: "mcnr-1",
    });
    registerHooks(api, { store, now: () => NOW });

    await api.handlers.get("message_received")({ content: "项目怎么样了？" }, { sessionKey: "session-1" });
    assert.equal(store.get("session-1")?.phase, "waiting_return");
    assert.equal(store.get("session-1")?.manualRecoveryConfirmedAt, undefined);

    await api.handlers.get("message_received")({ content: "现在回收" }, { sessionKey: "session-1" });
    assert.equal(store.get("session-1")?.phase, "waiting_return");
    assert.equal(store.get("session-1")?.manualRecoveryConfirmedAt, NOW);
  });

  it("clears only the ended session", async () => {
    const api = fakeApi();
    const store = createRuntimeStateStore({ now: () => NOW });
    store.set("session-1", { phase: "waiting_return" });
    store.set("session-2", { phase: "recovered" });
    registerHooks(api, { store, now: () => NOW });

    await api.handlers.get("session_end")({}, { sessionKey: "session-1" });
    assert.equal(store.get("session-1"), undefined);
    assert.equal(store.get("session-2")?.phase, "recovered");
  });

  it("injects a state summary without exposing payload bodies", async () => {
    const api = fakeApi();
    const store = createRuntimeStateStore({ now: () => NOW });
    store.set("session-1", {
      phase: "waiting_return",
      requirement_id: "req-1",
      mcn_recommendation_id: "mcnr-1",
      inquiry_batch_id: "inq-1",
    });
    registerHooks(api, { store, now: () => NOW });

    const result = await api.handlers.get("agent_turn_prepare")({}, { sessionKey: "session-1" });
    assert.match(result.prependContext, /waiting_return/);
    assert.match(result.prependContext, /req-1/);
    assert.doesNotMatch(result.prependContext, /raw_messages|budget_raw|description/);
  });

  it("preserves tool results verbatim with a synchronous persistence hook", () => {
    const api = fakeApi();
    const store = createRuntimeStateStore({ now: () => NOW });
    registerHooks(api, { store, now: () => NOW });
    const event = { toolName: "mcp__ypmcn__search_creators", result: { success: true, data: { id: "pool-1" } } };
    const result = api.handlers.get("tool_result_persist")(event, { sessionKey: "session-1" });
    assert.equal(result, undefined);
    assert.equal(result instanceof Promise, false);
    assert.deepEqual(event.result, { success: true, data: { id: "pool-1" } });
  });
});
