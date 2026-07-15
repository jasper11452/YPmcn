import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runBeforeToolCallGuards } from "../dist/hooks/guards.js";
import { createRuntimeStateStore } from "../dist/hooks/runtime-state.js";

const NOW = Date.parse("2026-07-15T10:00:00+08:00");

function distributionParams(overrides = {}) {
  return {
    projectName: "项目 A",
    deadline: "2026-07-16T18:00:00+08:00",
    columns: [{ key: "kw_uid" }, { name: "nickname" }],
    supplierIds: ["supplier-1"],
    prefillRows: [],
    prefillRowsBySupplier: {},
    ...overrides,
  };
}

function readyState(overrides = {}) {
  return {
    phase: "field_selection_ready",
    requirement_id: "req-1",
    mcn_recommendation_id: "mcnr-local-1",
    fieldSelection: {
      description: "kw_uid：达人 ID\nnickname：达人昵称",
      fieldNames: ["kw_uid", "nickname"],
    },
    sendConfirmation: {
      mcn_recommendation_id: "mcnr-local-1",
      operatorRole: "media",
      supplyConfirmed: true,
      mcnConfirmed: true,
      messageConfirmed: true,
      confirmedAt: NOW,
    },
    ...overrides,
  };
}

function context(store, tool, params, overrides = {}) {
  return {
    toolName: `mcp__ypmcn__${tool}`,
    params,
    sessionKey: "session-1",
    toolCallId: `call-${tool}`,
    nowMs: NOW,
    store,
    ...overrides,
  };
}

describe("current Endpoint before-tool guards", () => {
  it("uses live id arguments and rejects old chained arguments", async () => {
    const store = createRuntimeStateStore({ now: () => NOW });
    store.set("session-1", { phase: "requirement_ready", requirement_id: "req-1" });
    assert.equal(await runBeforeToolCallGuards(
      context(store, "search_creators", { id: "req-1" }),
    ), undefined);
    const blocked = await runBeforeToolCallGuards(
      context(store, "search_creators", { requirement_id: "req-1" }),
    );
    assert.match(blocked?.blockReason ?? "", /SCHEMA_MISMATCH/);
  });

  it("requires scoped confirmation, call evidence, and exact field-description binding", async () => {
    for (const state of [
      readyState({ sendConfirmation: undefined }),
      readyState({ sendConfirmation: { ...readyState().sendConfirmation, messageConfirmed: false } }),
      readyState({ sendConfirmation: {
        ...readyState().sendConfirmation,
        mcn_recommendation_id: "stale",
      } }),
    ]) {
      const store = createRuntimeStateStore({ now: () => NOW });
      store.set("session-1", state);
      const blocked = await runBeforeToolCallGuards(
        context(store, "create_with_distributions", distributionParams()),
      );
      assert.match(blocked?.blockReason ?? "", /CONFIRMATION_REQUIRED/);
    }

    const store = createRuntimeStateStore({ now: () => NOW });
    store.set("session-1", readyState());
    assert.equal(await runBeforeToolCallGuards(
      context(store, "create_with_distributions", distributionParams()),
    ), undefined);
    const reordered = await runBeforeToolCallGuards(
      context(store, "create_with_distributions", distributionParams({
        columns: [{ name: "nickname" }, { key: "kw_uid" }],
      })),
    );
    assert.match(reordered?.blockReason ?? "", /FIELD_SELECTION_INVALID/);
    const missingCall = await runBeforeToolCallGuards(
      context(store, "create_with_distributions", distributionParams(), { toolCallId: undefined }),
    );
    assert.match(missingCall?.blockReason ?? "", /INVALID_INPUT/);
  });

  it("rejects unsupported send arguments before any provider call", async () => {
    const store = createRuntimeStateStore({ now: () => NOW });
    store.set("session-1", readyState());
    for (const forbidden of [
      { mcn_recommendation_id: "mcnr-local-1" },
      { preview_only: false },
      { remindAt: "2026-07-16T17:00:00+08:00" },
    ]) {
      const blocked = await runBeforeToolCallGuards(context(
        store,
        "create_with_distributions",
        distributionParams(forbidden),
      ));
      assert.match(blocked?.blockReason ?? "", /SCHEMA_MISMATCH/);
    }
  });

  it("fails closed on missing state and mismatched sync identifiers", async () => {
    const store = createRuntimeStateStore({ now: () => NOW });
    const params = { requirement_id: "req-1", project_id: "project-1", mcn_id: "mcn-1" };
    const missing = await runBeforeToolCallGuards(context(
      store, "sync_mcn_inquiry_status", params,
    ));
    assert.match(missing?.blockReason ?? "", /INTEGRATION_REQUIRED/);
    store.set("session-1", {
      phase: "distribution_sync_pending",
      requirement_id: "req-1",
      project_id: "project-1",
      mcn_id: "mcn-1",
    });
    assert.equal(await runBeforeToolCallGuards(context(
      store, "sync_mcn_inquiry_status", params,
    )), undefined);
    const mismatch = await runBeforeToolCallGuards(context(
      store, "sync_mcn_inquiry_status", { ...params, project_id: "other" },
    ));
    assert.match(mismatch?.blockReason ?? "", /STATE_CONFLICT/);
  });

  it("requires matching manual or scheduled evidence for recovery writes", async () => {
    const manualStore = createRuntimeStateStore({ now: () => NOW });
    manualStore.set("session-1", {
      phase: "recovering",
      requirement_id: "req-1",
      project_id: "project-1",
      mcn_id: "mcn-1",
      inquiry_id: "inquiry-1",
      manualRecoveryConfirmedAt: NOW,
      lastSync: {
        at: NOW, trigger: "manual", requirement_id: "req-1",
        project_id: "project-1", mcn_id: "mcn-1", inquiry_id: "inquiry-1",
      },
    });
    assert.equal(await runBeforeToolCallGuards(context(
      manualStore,
      "ingest_mcn_submissions",
      { inquiry_id: "inquiry-1", items: [{}] },
      { recoveryTrigger: "manual" },
    )), undefined);

    const scheduledStore = createRuntimeStateStore({ now: () => NOW });
    scheduledStore.set("session-1", {
      phase: "waiting_return",
      requirement_id: "req-1", project_id: "project-1", mcn_id: "mcn-1",
    });
    const syncParams = {
      requirement_id: "req-1", project_id: "project-1", mcn_id: "mcn-1",
      cron_job_id: "cron-1",
    };
    assert.equal(await runBeforeToolCallGuards(context(
      scheduledStore,
      "sync_mcn_inquiry_status",
      syncParams,
      { recoveryTrigger: "scheduled", trigger: "cron" },
    )), undefined);
    const outsideCron = await runBeforeToolCallGuards(context(
      scheduledStore,
      "sync_mcn_inquiry_status",
      syncParams,
      { recoveryTrigger: "scheduled" },
    ));
    assert.match(outsideCron?.blockReason ?? "", /RECOVERY_NOT_CONFIRMED/);
  });

  it("blocks shell and curl bypasses of the provider write", async () => {
    const store = createRuntimeStateStore({ now: () => NOW });
    const blocked = await runBeforeToolCallGuards({
      toolName: "exec",
      params: { command: "curl https://example.invalid/api/projects/create-with-distributions" },
      sessionKey: "session-1",
      toolCallId: "call-shell",
      nowMs: NOW,
      store,
    });
    assert.match(blocked?.blockReason ?? "", /INTEGRATION_REQUIRED/);
  });

  it("blocks blind retry after an ambiguous write result", async () => {
    const store = createRuntimeStateStore({ now: () => NOW });
    store.set("session-1", {
      phase: "requirement_draft",
      lastResultIssue: {
        toolName: "validate_requirement",
        code: "WRITE_RESULT_UNKNOWN",
        at: NOW,
      },
    });
    const blocked = await runBeforeToolCallGuards(context(
      store,
      "validate_requirement",
      { payload: { brief: "same write" } },
    ));
    assert.match(blocked?.blockReason ?? "", /WRITE_RESULT_UNKNOWN/);
  });
});
