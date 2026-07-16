import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const profilePath = new URL("../../spec/mcp.json", import.meta.url);
const profile = JSON.parse(await readFile(profilePath, "utf8"));

const REQUIRED = [
  "validate_requirement", "search_creators", "rank_mcns",
  "select_inquiry_form_fields", "create_with_distributions",
  "sync_mcn_inquiry_status", "ingest_mcn_submissions",
  "manual_source_creators", "rank_creators", "create_submission_batch",
  "record_client_feedback", "get_recommendation_run_detail",
  "get_creator_detail", "audit_manual_adjustment",
];
const OPTIONAL = ["get_workflow_state"];

const EXPECTED_INPUTS = {
  validate_requirement: { required: ["payload"], properties: { payload: "object" } },
  search_creators: { required: ["id"], properties: { id: "string" } },
  rank_mcns: {
    required: ["id", "platform"],
    properties: {
      id: "string", platform: "string", minimum_mcn_count: "integer",
      target_multiplier: "number", buffer_rate: "number",
      medium_risk_confirmed: "boolean", medium_risk_confirmation: "object|null",
      limit: "integer",
      write_mcn_recommendation_items: "boolean",
    },
  },
  select_inquiry_form_fields: {
    required: [], properties: { url: "string|null", timeout_seconds: "integer" },
  },
  create_with_distributions: {
    required: ["projectName", "deadline", "columns", "supplierIds", "prefillRows", "prefillRowsBySupplier"],
    properties: {
      projectName: "string", description: "string|null", deadline: "string",
      usageScope: "string|null", columns: "array", supplierIds: "array",
      prefillRows: "array", prefillRowsBySupplier: "object",
    },
  },
  sync_mcn_inquiry_status: {
    required: ["requirement_id", "project_id", "mcn_id"],
    properties: {
      requirement_id: "string", project_id: "string", mcn_id: "string",
      cron_job_id: "string|null", scheduled_recover_at: "string|null",
    },
  },
  ingest_mcn_submissions: {
    required: ["inquiry_id", "items"],
    properties: { inquiry_id: "string", items: "array" },
  },
  manual_source_creators: {
    required: ["demand_id", "demand_version"],
    properties: {
      demand_id: "string", demand_version: "integer",
      search_context: "object|null", manual_results: "array|null",
    },
  },
  rank_creators: {
    required: ["requirement_id", "limit"],
    properties: { requirement_id: "string", limit: "integer" },
  },
  create_submission_batch: {
    required: ["run_id"],
    properties: {
      run_id: "string", target_submission_count: "integer|null",
      recommendation_item_ids: "array|null", exclude_submitted: "boolean",
      allow_need_confirm_with_risk: "boolean", risk_confirmation: "object|null",
      created_by: "string",
    },
  },
  record_client_feedback: {
    required: ["run_id", "feedback_items"],
    properties: {
      run_id: "string", feedback_items: "array", requirement_changes: "object|null",
    },
  },
  get_recommendation_run_detail: {
    required: ["run_id"],
    properties: {
      run_id: "string", include_submissions: "boolean",
      include_creator_detail: "boolean", include_feedback: "boolean",
    },
  },
  get_creator_detail: {
    required: ["platform", "kwUid"],
    properties: {
      platform: "string", kwUid: "string", include_offers: "boolean",
      include_mcn: "boolean", include_vector_text: "boolean",
      include_recent_metrics: "boolean",
    },
  },
  audit_manual_adjustment: {
    required: ["run_id", "adjustments", "operator_id"],
    properties: { run_id: "string", adjustments: "array", operator_id: "string" },
  },
  get_workflow_state: {
    required: [],
    properties: {
      demand_id: "string|null", demand_version: "integer|null", trace_id: "string|null",
    },
  },
};

function inputSummary(tool) {
  return {
    required: tool.required,
    properties: Object.fromEntries(
      Object.entries(tool.properties).map(([name, schema]) => [
        name,
        schema.type ?? schema.anyOf.map((branch) => branch.type).join("|"),
      ]),
    ),
  };
}

describe("current Endpoint MCP contract", () => {
  it("declares the exact non-pgy tool catalog", () => {
    assert.deepEqual(profile.providerContractBasis, {
      endpoint: "http://192.168.0.129:32008/sse",
      productionEndpoint: "https://mcp.eshypdata.com/sse",
      activeProfile: "development",
      inputAuthority: "live-tools/list",
      schemaSelection: "current-endpoint-over-old-mvp-v2",
      ignoredToolPrefix: "pgy",
      advertisedOutputSchema: false,
    });
    assert.deepEqual(profile.requiredTools, REQUIRED);
    assert.deepEqual(profile.optionalTools, OPTIONAL);
    assert.equal([...REQUIRED, ...OPTIONAL].some((name) => name.startsWith("pgy")), false);
  });

  it("matches the live tools/list input surface exactly", () => {
    assert.deepEqual(Object.keys(profile.tools), [...REQUIRED, ...OPTIONAL]);
    for (const [name, expected] of Object.entries(EXPECTED_INPUTS)) {
      assert.deepEqual(inputSummary(profile.tools[name]), expected, name);
      assert.deepEqual(profile.tools[name].forbidden, [], name);
    }
  });

  it("keeps the two provider semantic constraints explicit", () => {
    assert.match(profile.tools.get_workflow_state.semanticRequirement, /demand_id.*demand_version.*trace_id/);
    assert.match(profile.tools.get_recommendation_run_detail.semanticRequirement, /positive integer/);
  });

  it("does not promote runtime observations into advertised output schemas", () => {
    assert.deepEqual(Object.keys(profile.outputEnvelopes), ["observed-runtime"]);
    assert.equal(profile.outputEnvelopes["observed-runtime"].contractStatus, "not-advertised");
    for (const name of [...REQUIRED, ...OPTIONAL]) {
      const output = profile.outputContracts[name];
      assert.equal(output.advertisedOutputSchema, false, name);
      assert.equal(output.successEnvelope, "observed-runtime", name);
      assert.equal(output.failureEnvelope, "observed-runtime", name);
      assert.deepEqual(output.successSchema, { type: "object", additionalProperties: true }, name);
    }
    assert.match(profile.outputContracts.rank_creators.evidenceBasis, /run_id/);
    assert.match(profile.outputContracts.select_inquiry_form_fields.evidenceBasis, /数据库字段名：字段备注/);
  });

  it("keeps host qualification exact while provider tools/list names stay bare", () => {
    const identity = profile.serverIdentity;
    assert.equal(identity.canonicalNamespace, "ypmcn");
    assert.equal(identity.providerToolsList.toolNameFormat, "bare-contract-tool");
    assert.equal(
      identity.hostQualifiedToolName.pattern,
      "^mcp__ypmcn__(?:" + [...REQUIRED, ...OPTIONAL].join("|") + ")$",
    );
  });
});
