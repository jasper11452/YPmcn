import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runBeforeToolCallGuards } from "../dist/hooks/guards.js";
import { createRuntimeStateStore } from "../dist/hooks/runtime-state.js";

const NOW = Date.parse("2026-07-11T10:00:00+08:00");

function fieldDefinition(key = "friendcount", name = "关注数") {
  return { key, name, type: "BIGINT", required: true };
}

function readyDistributionParams(overrides = {}) {
  return {
    mcn_recommendation_id: "mcnr-1",
    projectName: "测试项目",
    description: "请按时回填",
    deadline: "2026-07-12T18:00:00+08:00",
    remindAt: "2026-07-12T12:00:00+08:00",
    usageScope: "project",
    supplierIds: ["supplier-1"],
    columns: [fieldDefinition()],
    sendWechatNotification: true,
    preview_only: false,
    ...overrides,
  };
}

function sendContext(store, overrides = {}) {
  return {
    toolName: "ypmcn__create_with_distributions",
    params: readyDistributionParams(),
    sessionKey: "session-1",
    toolCallId: "call-1",
    nowMs: NOW,
    store,
    ...overrides,
  };
}

function readyDistributionState(overrides = {}) {
  return {
    phase: "field_selection_ready",
    requirement_id: "req-1",
    candidate_pool_id: "pool-1",
    mcn_recommendation_id: "mcnr-1",
    fieldSelection: {
      fields: { friendcount: fieldDefinition() },
      items: [fieldDefinition()],
      selected_count: 1,
    },
    sendConfirmation: {
      mcn_recommendation_id: "mcnr-1",
      operatorRole: "media",
      supplyConfirmed: true,
      mcnConfirmed: true,
      messageConfirmed: true,
      confirmedAt: NOW,
    },
    ...overrides,
  };
}

describe("mvp-v2 before-tool guards", () => {
  it("accepts exact semantic IDs and rejects legacy chained IDs", async () => {
    const store = createRuntimeStateStore({ now: () => NOW });
    store.set("session-1", {
      phase: "requirement_ready",
      requirement_id: "req-1",
    });

    const allowed = await runBeforeToolCallGuards({
      toolName: "ypmcn__search_creators",
      params: { requirement_id: "req-1" },
      sessionKey: "session-1",
      toolCallId: "call-search",
      nowMs: NOW,
      store,
    });
    assert.equal(allowed, undefined);

    const blocked = await runBeforeToolCallGuards({
      toolName: "ypmcn__search_creators",
      params: { id: "req-1", demand_id: "legacy", demand_version: 1 },
      sessionKey: "session-1",
      toolCallId: "call-search-legacy",
      nowMs: NOW,
      store,
    });
    assert.equal(blocked?.block, true);
    assert.match(blocked?.blockReason ?? "", /SCHEMA_MISMATCH/);

    const bare = await runBeforeToolCallGuards({
      toolName: "search_creators",
      params: { id: "req-1", demand_id: "legacy", demand_version: 1 },
      sessionKey: "session-1",
      toolCallId: "call-search-bare",
      nowMs: NOW,
      store,
    });
    assert.equal(bare, undefined);
  });

  it("fails a distribution closed when session, call ID, or host confirmation is missing", async () => {
    for (const missing of ["sessionKey", "toolCallId", "sendConfirmation"]) {
      const store = createRuntimeStateStore({ now: () => NOW });
      store.set("session-1", readyDistributionState());
      const ctx = sendContext(store);
      if (missing === "sendConfirmation") {
        store.set("session-1", readyDistributionState({ sendConfirmation: undefined }));
      } else {
        delete ctx[missing];
      }
      const result = await runBeforeToolCallGuards(ctx);
      assert.equal(result?.block, true, missing);
      assert.match(result?.blockReason ?? "", /CONFIRMATION_REQUIRED|INVALID_INPUT/, missing);
    }
  });

  it("requires every send confirmation and current field-selection proof", async () => {
    const cases = [
      { confirmation: { supplyConfirmed: false } },
      { confirmation: { mcnConfirmed: false } },
      { confirmation: { messageConfirmed: false } },
      { confirmation: { mcn_recommendation_id: "mcnr-stale" } },
      { columns: [fieldDefinition("postcount", "作品数")] },
    ];

    for (const testCase of cases) {
      const store = createRuntimeStateStore({ now: () => NOW });
      const base = readyDistributionState();
      store.set("session-1", readyDistributionState({
        sendConfirmation: {
          ...base.sendConfirmation,
          ...testCase.confirmation,
        },
      }));
      const result = await runBeforeToolCallGuards(sendContext(store, {
        params: readyDistributionParams(testCase.columns ? { columns: testCase.columns } : {}),
      }));
      assert.equal(result?.block, true);
      assert.match(result?.blockReason ?? "", /CONFIRMATION_REQUIRED|FIELD_SELECTION_INVALID/);
    }
  });

  it("rejects preview sends and past reminder timestamps", async () => {
    const store = createRuntimeStateStore({ now: () => NOW });
    store.set("session-1", readyDistributionState());

    const preview = await runBeforeToolCallGuards(sendContext(store, {
      params: readyDistributionParams({ preview_only: true }),
    }));
    assert.equal(preview?.block, true);
    assert.match(preview?.blockReason ?? "", /SCHEMA_MISMATCH/);

    const expired = await runBeforeToolCallGuards(sendContext(store, {
      params: readyDistributionParams({ remindAt: "2026-07-10T12:00:00+08:00" }),
    }));
    assert.equal(expired?.block, true);
    assert.match(expired?.blockReason ?? "", /INVALID_INPUT/);
  });

  it("blocks shell and curl bypasses of the provider write", async () => {
    const store = createRuntimeStateStore({ now: () => NOW });
    const result = await runBeforeToolCallGuards({
      toolName: "exec",
      params: { command: "curl https://example.invalid/api/projects/create-with-distributions" },
      sessionKey: "session-1",
      toolCallId: "call-shell",
      nowMs: NOW,
      store,
    });
    assert.equal(result?.block, true);
    assert.match(result?.blockReason ?? "", /INTEGRATION_REQUIRED/);
  });

  it("allows manual and scheduled ingest only after the matching current sync", async () => {
    const manualStore = createRuntimeStateStore({ now: () => NOW });
    manualStore.set("session-1", {
      phase: "recovering",
      requirement_id: "req-1",
      mcn_recommendation_id: "mcnr-1",
      manualRecoveryConfirmedAt: NOW,
      lastSync: { at: NOW, lifecycle_status: "waiting_return", response_status: "partial", trigger: "manual" },
    });
    const manual = await runBeforeToolCallGuards({
      toolName: "ypmcn__ingest_mcn_submissions",
      params: { mcn_recommendation_id: "mcnr-1", requirement_id: "req-1", trigger: "manual" },
      sessionKey: "session-1",
      toolCallId: "call-ingest-manual",
      recoveryTrigger: "manual",
      nowMs: NOW,
      store: manualStore,
    });
    assert.equal(manual, undefined);

    const scheduledStore = createRuntimeStateStore({ now: () => NOW });
    scheduledStore.set("session-2", {
      phase: "recovering",
      requirement_id: "req-1",
      mcn_recommendation_id: "mcnr-1",
      lastSync: { at: NOW, lifecycle_status: "waiting_return", response_status: "partial", trigger: "scheduled" },
    });
    const scheduled = await runBeforeToolCallGuards({
      toolName: "ypmcn__ingest_mcn_submissions",
      params: { mcn_recommendation_id: "mcnr-1", requirement_id: "req-1", trigger: "scheduled" },
      sessionKey: "session-2",
      toolCallId: "call-ingest-scheduled",
      trigger: "cron",
      nowMs: NOW,
      store: scheduledStore,
    });
    assert.equal(scheduled, undefined);

    const outsideCron = await runBeforeToolCallGuards({
      toolName: "ypmcn__ingest_mcn_submissions",
      params: { mcn_recommendation_id: "mcnr-1", requirement_id: "req-1", trigger: "scheduled" },
      sessionKey: "session-2",
      toolCallId: "call-ingest-invalid",
      nowMs: NOW,
      store: scheduledStore,
    });
    assert.equal(outsideCron?.block, true);
    assert.match(outsideCron?.blockReason ?? "", /RECOVERY_NOT_CONFIRMED/);
  });

  it("blocks ranking until an authoritative final sync reports recovered", async () => {
    const store = createRuntimeStateStore({ now: () => NOW });
    store.set("session-1", {
      phase: "recovery_sync_pending",
      requirement_id: "req-1",
      mcn_recommendation_id: "mcnr-1",
      lastSync: { at: NOW, lifecycle_status: "recovering", response_status: "partial", trigger: "manual" },
      lastIngest: { at: NOW, ingest_batch_id: "ingest-1", trigger: "manual" },
    });
    const result = await runBeforeToolCallGuards({
      toolName: "ypmcn__rank_creators",
      params: { mcn_recommendation_id: "mcnr-1" },
      sessionKey: "session-1",
      toolCallId: "call-rank",
      nowMs: NOW,
      store,
    });
    assert.equal(result?.block, true);
    assert.match(result?.blockReason ?? "", /INVALID_PHASE/);
  });
});
