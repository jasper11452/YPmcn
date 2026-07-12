import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  normalizeYpmcnToolName,
  runBeforeToolCallGuards,
} from "../dist/hooks/guards.js";
import { createRuntimeStateStore } from "../dist/hooks/runtime-state.js";

const NOW = Date.parse("2026-07-11T10:00:00+08:00");

function qualified(toolName) {
  return `mcp__ypmcn__${toolName}`;
}

function fieldDefinition(key = "friendcount", name = "关注数") {
  return { key, name, type: "BIGINT", required: true };
}

function authority(overrides = {}) {
  return {
    phase: "field_selection_ready",
    current_identifier: "mcnr-1",
    state_version: 7,
    allowed_actions: ["create_with_distributions"],
    pending_gates: [],
    identifiers: {
      requirement_id: "req-1",
      candidate_pool_id: "pool-1",
      mcn_recommendation_id: "mcnr-1",
      selection_result_id: "selection-1",
    },
    updated_at: "2026-07-11T10:00:00+08:00",
    ...overrides,
  };
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

function withState(state) {
  const store = createRuntimeStateStore({ now: () => NOW });
  store.set("session-1", state);
  return store;
}

function guardContext(store, toolName, params, overrides = {}) {
  return {
    toolName: qualified(toolName),
    params,
    sessionKey: "session-1",
    toolCallId: "call-1",
    operatorRole: "media",
    nowMs: NOW,
    store,
    ...overrides,
  };
}

describe("mvp-v2 before-tool guards", () => {
  it("allows only a fresh exact initial validation bootstrap without granting local authority", async () => {
    const store = createRuntimeStateStore({ now: () => NOW });
    const bootstrap = await runBeforeToolCallGuards(guardContext(
      store,
      "validate_requirement",
      { raw_messages_json: "[]" },
    ));
    assert.equal(bootstrap, undefined);
    assert.equal(store.get("session-1"), undefined);

    const missingCall = await runBeforeToolCallGuards(guardContext(
      store,
      "validate_requirement",
      { raw_messages_json: "[]" },
      { toolCallId: undefined },
    ));
    assert.equal(missingCall?.block, true);
    assert.match(missingCall?.blockReason ?? "", /INVALID_INPUT/);

    const nextWrite = await runBeforeToolCallGuards(guardContext(
      store,
      "search_creators",
      { requirement_id: "req-1" },
    ));
    assert.equal(nextWrite?.block, true);
    assert.match(nextWrite?.blockReason ?? "", /STATE_COMBINATION_INVALID/);

    store.set("session-1", { phase: "requirement_draft" });
    const nonFresh = await runBeforeToolCallGuards(guardContext(
      store,
      "validate_requirement",
      { raw_messages_json: "[]" },
    ));
    assert.equal(nonFresh?.block, true);
    assert.match(nonFresh?.blockReason ?? "", /STATE_COMBINATION_INVALID/);
  });

  it("accepts only the exact Host-qualified YPmcn tool identity", async () => {
    assert.equal(normalizeYpmcnToolName(qualified("search_creators")), "search_creators");
    for (const name of [
      "search_creators",
      "mcp__foreign__search_creators",
      "mcp__vector-mcp__search_creators",
      "mcp__ypmcn__search_creators__suffix",
    ]) {
      assert.equal(normalizeYpmcnToolName(name), null, name);
    }

    const store = withState({
      phase: "requirement_ready",
      authoritative: authority({
        phase: "requirement_ready",
        allowed_actions: ["search_creators"],
        identifiers: { requirement_id: "req-1" },
      }),
    });
    for (const name of ["search_creators", "mcp__foreign__search_creators"]) {
      const result = await runBeforeToolCallGuards({
        ...guardContext(store, "search_creators", { requirement_id: "req-1" }),
        toolName: name,
      });
      assert.equal(result?.block, true, name);
      assert.match(result?.blockReason ?? "", /INTEGRATION_REQUIRED/);
    }
  });

  it("requires a current server projection and its allowed action for every business write", async () => {
    const localOnly = withState({
      phase: "recovering",
      requirement_id: "req-1",
      mcn_recommendation_id: "mcnr-1",
      manualRecoveryConfirmedAt: NOW,
      lastSync: {
        at: NOW,
        lifecycle_status: "recovering",
        response_status: "partial",
        trigger: "manual",
      },
    });
    const blocked = await runBeforeToolCallGuards(
      guardContext(localOnly, "ingest_mcn_submissions", {
        mcn_recommendation_id: "mcnr-1",
        requirement_id: "req-1",
        trigger: "manual",
      }, { recoveryTrigger: "manual" }),
    );
    assert.equal(blocked?.block, true);
    assert.match(blocked?.blockReason ?? "", /STATE_COMBINATION_INVALID/);

    const serverAuthorized = withState({
      phase: "requirement_draft",
      authoritative: authority({
        phase: "recovering",
        state_version: 8,
        allowed_actions: ["request_recovery"],
        identifiers: { requirement_id: "req-1", mcn_recommendation_id: "mcnr-1" },
      }),
    });
    const allowed = await runBeforeToolCallGuards(
      guardContext(serverAuthorized, "ingest_mcn_submissions", {
        mcn_recommendation_id: "mcnr-1",
        requirement_id: "req-1",
        trigger: "scheduled",
      }),
    );
    assert.equal(allowed, undefined);
  });

  it("does not let manual text, cron context, local phase, or local IDs grant a recovery write", async () => {
    const store = withState({
      phase: "recovering",
      requirement_id: "req-local",
      mcn_recommendation_id: "mcn-local",
      manualRecoveryConfirmedAt: NOW,
      lastSync: {
        at: NOW,
        lifecycle_status: "recovering",
        response_status: "partial",
        trigger: "scheduled",
      },
      authoritative: authority({
        phase: "waiting_return",
        state_version: 9,
        allowed_actions: ["refresh_recovery"],
        identifiers: {
          requirement_id: "req-1",
          mcn_recommendation_id: "mcnr-1",
        },
      }),
    });
    const result = await runBeforeToolCallGuards(
      guardContext(store, "ingest_mcn_submissions", {
        mcn_recommendation_id: "mcn-local",
        requirement_id: "req-local",
        trigger: "scheduled",
      }, { trigger: "cron", recoveryTrigger: "scheduled" }),
    );
    assert.equal(result?.block, true);
    assert.match(result?.blockReason ?? "", /STATE_COMBINATION_INVALID/);
  });

  it("uses server identifiers and allowed actions, while retaining local confirmations as deny-only send checks", async () => {
    const store = withState({
      phase: "requirement_draft",
      mcn_recommendation_id: "mcn-local",
      fieldSelection: {
        fields: { friendcount: fieldDefinition() },
        items: [fieldDefinition()],
        selected_count: 1,
      },
      authoritative: authority(),
    });
    const allowed = await runBeforeToolCallGuards(guardContext(
      store,
      "create_with_distributions",
      readyDistributionParams(),
      {
        gateState: {
          supplyConfirmed: true,
          mcnConfirmed: true,
          messageConfirmed: true,
        },
      },
    ));
    assert.equal(allowed, undefined);

    const wrongServerId = await runBeforeToolCallGuards(guardContext(
      store,
      "create_with_distributions",
      readyDistributionParams({ mcn_recommendation_id: "mcn-local" }),
      {
        gateState: {
          supplyConfirmed: true,
          mcnConfirmed: true,
          messageConfirmed: true,
        },
      },
    ));
    assert.equal(wrongServerId?.block, true);
    assert.match(wrongServerId?.blockReason ?? "", /STATE_CONFLICT/);

    const missingConfirmation = await runBeforeToolCallGuards(guardContext(
      store,
      "create_with_distributions",
      readyDistributionParams(),
      { gateState: { supplyConfirmed: true, mcnConfirmed: false, messageConfirmed: true } },
    ));
    assert.equal(missingConfirmation?.block, true);
    assert.match(missingConfirmation?.blockReason ?? "", /CONFIRMATION_REQUIRED/);
  });

  it("requires authoritative recovery actions and a server recovery operation for finalization", async () => {
    const refreshStore = withState({
      phase: "requirement_draft",
      authoritative: authority({
        phase: "waiting_return",
        state_version: 10,
        allowed_actions: ["refresh_recovery"],
        identifiers: { requirement_id: "req-1", mcn_recommendation_id: "mcnr-1" },
      }),
    });
    const refresh = await runBeforeToolCallGuards(guardContext(
      refreshStore,
      "sync_mcn_inquiry_status",
      { mcn_recommendation_id: "mcnr-1", requirement_id: "req-1" },
    ));
    assert.equal(refresh, undefined);

    const incompleteFinalizeStore = withState({
      phase: "recovery_sync_pending",
      authoritative: authority({
        phase: "recovery_sync_pending",
        state_version: 11,
        allowed_actions: ["finalize_recovery"],
        identifiers: { requirement_id: "req-1", mcn_recommendation_id: "mcnr-1" },
      }),
    });
    const incompleteFinalize = await runBeforeToolCallGuards(guardContext(
      incompleteFinalizeStore,
      "sync_mcn_inquiry_status",
      { mcn_recommendation_id: "mcnr-1", requirement_id: "req-1" },
    ));
    assert.equal(incompleteFinalize?.block, true);
    assert.match(incompleteFinalize?.blockReason ?? "", /STATE_COMBINATION_INVALID/);

    const finalizeStore = withState({
      phase: "requirement_draft",
      authoritative: authority({
        phase: "recovery_sync_pending",
        state_version: 11,
        allowed_actions: ["finalize_recovery"],
        identifiers: {
          requirement_id: "req-1",
          mcn_recommendation_id: "mcnr-1",
          recovery_operation_id: "recovery-1",
        },
      }),
    });
    const finalized = await runBeforeToolCallGuards(guardContext(
      finalizeStore,
      "sync_mcn_inquiry_status",
      { mcn_recommendation_id: "mcnr-1", requirement_id: "req-1" },
    ));
    assert.equal(finalized, undefined);
  });

  it("blocks a write after an accepted result requires get_workflow_state refresh", async () => {
    const store = withState({
      phase: "field_selection_ready",
      requiresWorkflowRefresh: true,
      authoritative: undefined,
      lastServerStateVersion: 12,
    });
    const result = await runBeforeToolCallGuards(guardContext(
      store,
      "create_with_distributions",
      readyDistributionParams(),
      {
        gateState: {
          supplyConfirmed: true,
          mcnConfirmed: true,
          messageConfirmed: true,
        },
      },
    ));
    assert.equal(result?.block, true);
    assert.match(result?.blockReason ?? "", /STATE_COMBINATION_INVALID/);
  });

  it("blocks shell and curl bypasses of the provider write", async () => {
    const store = createRuntimeStateStore({ now: () => NOW });
    const result = await runBeforeToolCallGuards({
      toolName: "exec",
      params: { command: "curl https://example.invalid/api/projects/create-with-distributions" },
      sessionKey: "session-1",
      toolCallId: "call-shell",
      operatorRole: "media",
      nowMs: NOW,
      store,
    });
    assert.equal(result?.block, true);
    assert.match(result?.blockReason ?? "", /INTEGRATION_REQUIRED/);
  });
});
