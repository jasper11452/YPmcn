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
  "search_creator_tag_vectors",
];

function validDistribution(overrides = {}) {
  return {
    projectName: "项目 A",
    deadline: "2026-07-19T18:00:00+08:00",
    columns: [{ key: "kwUid" }],
    supplierIds: ["supplier-1"],
    prefillRows: [],
    prefillRowsBySupplier: {},
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
      assert.deepEqual(profile.outputContracts[name].errorCodes, [], name);
    }
  });

  it("loads directly coupled specs without promoting session phases to provider facts", () => {
    const workflow = loadWorkflowContract();
    assert.equal(workflow.projectionStatus, "local-session-projection");
    assert.equal(workflow.stateAuthority.providerFacts, false);
    assert.equal(workflow.stateAuthority.providerOutputSchemaAdvertised, false);
    assert.equal(workflow.stateAuthority.missingEvidenceBehavior, "no-phase-advance");
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
      ["select_inquiry_form_fields", { url: null, timeout_seconds: 30 }],
      ["create_with_distributions", validDistribution({ prefillRowsBySupplier: {
        "supplier-1": [{ kwUid: "creator-1" }],
      } })],
      ["sync_mcn_inquiry_status", {
        requirement_id: "req-1", project_id: "project-1", mcn_id: "mcn-1",
        cron_job_id: null, scheduled_recover_at: null,
      }],
      ["ingest_mcn_submissions", { inquiry_id: "inquiry-1", items: [{ kwUid: "creator-1" }] }],
      ["manual_source_creators", { demand_id: "demand-1", demand_version: 1 }],
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
    const oldSend = validateToolParams("create_with_distributions", {
      ...validDistribution(),
      mcn_recommendation_id: "mcnr-old",
      remindAt: "2026-07-19T17:00:00+08:00",
      preview_only: false,
    });
    assert.deepEqual(
      oldSend.map(({ path }) => path),
      ["$.mcn_recommendation_id", "$.remindAt", "$.preview_only"],
    );
    assert.equal(
      validateToolParams("ingest_mcn_submissions", {
        inquiry_id: "inquiry-1", items: ["not-an-object"],
      })[0].path,
      "$.items[0]",
    );
    assert.equal(
      validateToolParams("create_with_distributions", validDistribution({
        prefillRowsBySupplier: { "supplier-1": [{}], bad: "not-an-array" },
      }))[0].path,
      "$.prefillRowsBySupplier.bad",
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
