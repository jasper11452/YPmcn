import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  expectedRequiredTools,
  loadContractProfile,
  loadDatabaseContract,
  loadErrorCatalog,
  loadRequirementDictionary,
  loadRequirementsContract,
  loadWorkflowContract,
  validateContractProfileDocument,
} from "../dist/contract/loader.js";
import {
  parseFieldSelectionDescription,
  validateToolParams,
} from "../dist/contract/validator.js";

const CURRENT_TOOLS = [
  "validate_requirement", "search_creators", "rank_mcns",
  "select_inquiry_form_fields", "create_with_distributions",
  "sync_mcn_inquiry_status", "ingest_mcn_submissions",
  "manual_source_creators", "rank_creators", "create_submission_batch",
  "record_client_feedback", "get_recommendation_run_detail",
  "get_creator_detail", "audit_manual_adjustment", "get_workflow_state",
];

function validDistribution(overrides = {}) {
  const description = overrides.description ??
    "您好，现招募小红书达人参与项目 A。\n请协助推荐合适人选，谢谢。";
  return {
    requirement_id: "req-1",
    columns: [{ key: "kwUid", name: "达人 ID" }],
    supplierIds: ["supplier-1"],
    description,
    wechat_notification_message: description,
    ...overrides,
  };
}

describe("current Endpoint contract loader", () => {
  it("loads and freezes the live-input profile with non-advertised outputs", () => {
    const profile = loadContractProfile("mvp-v2");
    assert.equal(Object.isFrozen(profile), true);
    assert.deepEqual([...profile.requiredTools, ...profile.optionalTools], CURRENT_TOOLS);
    assert.deepEqual(Object.keys(profile.outputEnvelopes), ["observed-runtime"]);
    assert.equal(profile.outputEnvelopes["observed-runtime"].additionalProperties, true);
    for (const name of CURRENT_TOOLS) {
      assert.equal(profile.outputContracts[name].advertisedOutputSchema, false, name);
      if (name !== "manual_source_creators") {
        assert.deepEqual(profile.outputContracts[name].errorCodes, [], name);
      }
    }
    assert.deepEqual(profile.outputContracts.manual_source_creators.errorCodes, [
      "INVALID_INPUT", "STATE_CONFLICT", "WRITE_RESULT_UNKNOWN",
    ]);
  });

  it("loads local-JSON workflow authority without making it Provider success evidence", () => {
    const workflow = loadWorkflowContract();
    assert.equal(workflow.projectionStatus, "local-json-recorded");
    assert.equal(workflow.stateAuthority.providerFacts, false);
    assert.equal(workflow.stateAuthority.providerBusinessFacts, true);
    assert.equal(workflow.stateAuthority.sessionLifecycleRequired, false);
    assert.equal(workflow.stateAuthority.providerOutputSchemaAdvertised, false);
    assert.equal(workflow.stateAuthority.missingEvidenceBehavior, "no-phase-advance");
    assert.equal(workflow.stateAuthority.ledger.status, "schema-present-not-used-by-current-tools");
    assert.match(workflow.stateAuthority.currentProviderGaps.sync_mcn_inquiry_status, /does not query provider state or upsert mcn_inquiries/);
    assert.match(workflow.policies.rankCreatorsPrerequisite, /distribution.*recovery/i);
    const distributionTransitions = workflow.transitions.filter((item) =>
      ["create_with_distributions", "sync_mcn_inquiry_status"].includes(item.trigger?.name)
    );
    assert.ok(distributionTransitions.some((item) => item.implementationStatus === "target-blocked"));
    const rankTransition = workflow.transitions.find((item) => item.trigger?.name === "rank_creators");
    assert.ok(rankTransition.guards.some((guard) => /distribution/.test(guard)));
    assert.ok(rankTransition.guards.some((guard) => /recovery/.test(guard)));
    assert.equal(workflow.transitions.some((item) =>
      item.from === "waiting_mcn_return" && item.trigger?.name === "manual_source_creators"
    ), false);
    const manualTransitions = workflow.transitions.filter((item) =>
      item.trigger?.name === "manual_source_creators"
    );
    assert.equal(manualTransitions.length, 1);
    assert.equal(manualTransitions[0].from, "mcn_planning");
    assert.match(workflow.policies.rankInquiryEvidence, /rank_mcns.*inquiry_id/);
    assert.match(workflow.policies.manualSourcingEvidence, /task_id.*inquiry_id.*target_count.*started_at/);
    assert.equal(Object.isFrozen(workflow), true);
    assert.equal(loadDatabaseContract().profile, "mvp-v2");
    assert.equal(loadErrorCatalog().profile, "mvp-v2");
    assert.equal(loadRequirementDictionary().profile, "mvp-v2");
    assert.equal(loadRequirementsContract().profile, "mvp-v2");
  });

  it("keeps parsed validation isolated and rejects advertised-output inventions", () => {
    const profile = structuredClone(loadContractProfile("mvp-v2"));
    assert.doesNotThrow(() => validateContractProfileDocument("mvp-v2", profile));
    profile.outputContracts.rank_creators.advertisedOutputSchema = true;
    assert.throws(
      () => validateContractProfileDocument("mvp-v2", profile),
      /non-advertised/,
    );
  });

  it("keeps the legacy profile detection-only", () => {
    const legacy = loadContractProfile("legacy-1.9.4");
    assert.equal(legacy.writable, false);
    assert.equal(legacy.automaticFallback, false);
    assert.deepEqual(expectedRequiredTools(legacy), legacy.observedSummary.toolNames);
    assert.match(
      validateToolParams("validate_requirement", {}, "legacy-1.9.4")[0].message,
      /detection-only/,
    );
  });
});

describe("current Endpoint input validation", () => {
  it("accepts representative live inputs including nullable anyOf branches", () => {
    const cases = [
      ["validate_requirement", { payload: { raw: "brief" } }],
      ["search_creators", { id: "req-1" }],
      ["rank_mcns", { id: "req-1", platform: "xiaohongshu", medium_risk_confirmation: null }],
      ["select_inquiry_form_fields", { platform: "xiaohongshu", url: null, timeout_seconds: 30 }],
      ["create_with_distributions", validDistribution()],
      ["sync_mcn_inquiry_status", {
        requirement_id: "req-1", project_id: "project-1", supplierIds: ["supplier-1"],
      }],
      ["ingest_mcn_submissions", { inquiry_ids: ["1"] }],
      ["manual_source_creators", { requirement_id: "req-1", target_count: 4 }],
      ["rank_creators", { requirement_id: "req-1", limit: 20 }],
      ["create_submission_batch", { run_id: "1", risk_confirmation: null }],
      ["record_client_feedback", { run_id: "1", feedback_items: [{ status: "accepted" }] }],
      ["get_recommendation_run_detail", { run_id: "1" }],
      ["get_creator_detail", { platform: "xiaohongshu", kwUid: "creator-1" }],
      ["audit_manual_adjustment", { run_id: "1", adjustments: [{}], operator_id: "operator-1" }],
      ["get_workflow_state", { trace_id: "trace-1" }],
      ["get_workflow_state", { demand_id: "demand-1", demand_version: 1 }],
    ];
    for (const [tool, params] of cases) {
      assert.deepEqual(validateToolParams(tool, params), [], tool);
    }
  });

  it("rejects old provider arguments and malformed nested live inputs", () => {
    assert.equal(
      validateToolParams("select_inquiry_form_fields", {})[0].path,
      "$.platform",
    );
    assert.equal(
      validateToolParams("select_inquiry_form_fields", { platform: "weibo" })[0].path,
      "$.platform",
    );
    const oldSend = validateToolParams("create_with_distributions", {
      ...validDistribution(),
      projectName: "旧项目字段",
      deadline: "2026-07-19T18:00:00+08:00",
      prefillRows: [],
      prefillRowsBySupplier: {},
      mcn_recommendation_id: "mcnr-old",
      remindAt: "2026-07-19T17:00:00+08:00",
      preview_only: false,
    });
    assert.deepEqual(
      oldSend.map(({ path }) => path),
      [
        "$.projectName", "$.deadline", "$.prefillRows", "$.prefillRowsBySupplier",
        "$.mcn_recommendation_id", "$.remindAt", "$.preview_only",
      ],
    );
    assert.equal(validateToolParams("ingest_mcn_submissions", { inquiry_ids: [1] })[0].path, "$.inquiry_ids[0]");
    assert.equal(
      validateToolParams("create_with_distributions", validDistribution({ columns: ["not-an-object"] }))[0].path,
      "$.columns[0]",
    );
    assert.deepEqual(
      validateToolParams("create_with_distributions", validDistribution({
        columns: [{ field_key: "kwUid", field_name: "达人 ID" }],
      })).map(({ path }) => path),
      ["$.columns[0].field_key", "$.columns[0].field_name"],
    );
    assert.equal(
      validateToolParams("create_with_distributions", validDistribution({
        columns: [{ key: "kwUid", name: "" }],
      }))[0].path,
      "$.columns[0].name",
    );
    assert.deepEqual(
      validateToolParams("create_with_distributions", validDistribution({
        columns: [{
          key: "platform",
          name: "平台（xiaohongshu / douyin）",
          type: "VARCHAR(32)",
          required: true,
          group: "项目信息",
        }],
      })).map(({ path }) => path),
      ["$.columns[0].type", "$.columns[0].required", "$.columns[0].group"],
    );
    assert.equal(
      validateToolParams("create_with_distributions", validDistribution({
        description: JSON.stringify({ title: "项目 A", platform: "小红书" }),
      }))[0].path,
      "$.description",
    );
    assert.match(
      validateToolParams("create_with_distributions", validDistribution({
        description: "```json\n{\"title\":\"项目 A\"}\n```",
      }))[0].message,
      /not a code block/,
    );
    assert.equal(
      validateToolParams("create_with_distributions", validDistribution({
        wechat_notification_message: "不同的企微消息",
      }))[0].path,
      "$.wechat_notification_message",
    );
    assert.equal(
      validateToolParams("create_with_distributions", validDistribution({
        wechat_notification_message: undefined,
      }))[0].path,
      "$.wechat_notification_message",
    );
  });

  it("requires the minimal positive manual-sourcing target", () => {
    assert.deepEqual(
      validateToolParams("manual_source_creators", { requirement_id: "req-1" }).map(({ path }) => path),
      ["$.target_count"],
    );
    for (const target_count of [0, -1, 1.5, "4"]) {
      assert.equal(
        validateToolParams("manual_source_creators", { requirement_id: "req-1", target_count })[0].path,
        "$.target_count",
      );
    }
    assert.deepEqual(
      validateToolParams("manual_source_creators", {
        requirement_id: "req-1", target_count: 4, platform: "xiaohongshu",
      }).map(({ path }) => path),
      ["$.platform"],
    );
  });

  it("enforces semantic lookup constraints without changing live schemas", () => {
    assert.equal(validateToolParams("get_workflow_state", {}).length, 1);
    assert.equal(validateToolParams("get_workflow_state", {
      trace_id: "trace-1", demand_id: "demand-1", demand_version: 1,
    }).length, 1);
    assert.equal(validateToolParams("get_workflow_state", {
      demand_id: "demand-1",
    }).length, 1);
    assert.equal(validateToolParams("sync_mcn_inquiry_status", {
      requirement_id: "req-1", project_id: "0", supplierIds: ["supplier-1"],
    })[0].path, "$.project_id");
    assert.equal(validateToolParams("sync_mcn_inquiry_status", {
      requirement_id: "req-1", project_id: "project-1", supplierIds: [],
    })[0].path, "$.supplierIds");
    assert.equal(validateToolParams("sync_mcn_inquiry_status", {
      requirement_id: "req-1", project_id: "project-1", supplierIds: ["0"],
    })[0].path, "$.supplierIds[0]");
    assert.equal(validateToolParams("get_recommendation_run_detail", { run_id: "0" }).length, 1);
    assert.equal(validateToolParams("get_recommendation_run_detail", { run_id: "abc" }).length, 1);
  });
});

describe("field-selection description", () => {
  it("parses unique ordered 数据库字段名：字段备注 lines", () => {
    assert.deepEqual(
      parseFieldSelectionDescription("kwUid：达人 ID\nnickname: 达人昵称"),
      ["kwUid", "nickname"],
    );
    assert.equal(parseFieldSelectionDescription("kwUid"), undefined);
    assert.equal(
      parseFieldSelectionDescription("kwUid：达人 ID\nkwUid：重复"),
      undefined,
    );
  });
});
