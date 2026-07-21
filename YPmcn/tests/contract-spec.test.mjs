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
  "get_creator_detail", "audit_manual_adjustment", "get_workflow_state",
];
const OPTIONAL = [];

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
    required: ["url"], properties: { url: "string", timeout_seconds: "integer" },
  },
  create_with_distributions: {
    required: ["requirement_id", "columns", "supplierIds"],
    properties: {
      requirement_id: "string", description: "string|null",
      wechat_notification_message: "string",
      columns: "array", supplierIds: "array",
    },
  },
  sync_mcn_inquiry_status: {
    required: ["requirement_id", "project_id", "supplierIds"],
    properties: {
      requirement_id: "string", project_id: "string", supplierIds: "array",
    },
  },
  ingest_mcn_submissions: {
    required: ["inquiry_ids"],
    properties: { inquiry_ids: "array" },
  },
  manual_source_creators: {
    required: ["requirement_id", "target_count"],
    properties: { requirement_id: "string", target_count: "integer" },
  },
  rank_creators: {
    required: ["requirement_id", "inquiry_ids", "columns"],
    properties: { requirement_id: "string", inquiry_ids: "array", columns: "array" },
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
      endpoint: "https://mcp.eshypdata.com/sse",
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

  it("matches the declared local contract", () => {
    assert.deepEqual(Object.keys(profile.tools), [...REQUIRED, ...OPTIONAL]);
    for (const [name, expected] of Object.entries(EXPECTED_INPUTS)) {
      assert.deepEqual(inputSummary(profile.tools[name]), expected, name);
      assert.deepEqual(profile.tools[name].forbidden, [], name);
    }
  });

  it("keeps the two provider semantic constraints explicit", () => {
    assert.match(profile.tools.get_workflow_state.semanticRequirement, /demand_id.*demand_version.*trace_id/);
    assert.match(profile.tools.get_recommendation_run_detail.semanticRequirement, /positive integer/);
    assert.match(profile.tools.rank_creators.agentSemanticRequirements.inquiry_ids, /returned by sync/);
    assert.match(
      profile.tools.rank_creators.agentSemanticRequirements.columns,
      /exactly the same ordered key\/name object array passed to create_with_distributions/,
    );
  });

  it("adds the Agent-required plain-text message without misreporting the live Provider required list", () => {
    assert.deepEqual(
      profile.tools.create_with_distributions.agentRequired,
      ["description", "wechat_notification_message"],
    );
    assert.match(
      profile.tools.create_with_distributions.agentSemanticRequirements.description,
      /plain-text WeChat message.*line breaks.*must not be JSON/,
    );
    assert.match(
      profile.tools.create_with_distributions.agentSemanticRequirements.wechat_notification_message,
      /exactly identical to description/,
    );
    assert.equal(
      profile.tools.create_with_distributions.agentSemanticRequirements.aliases.requirement_ID,
      "requirement_id",
    );
    assert.equal(profile.tools.create_with_distributions.agentSemanticRequirements.aliases.colums, "columns");
    assert.match(
      profile.tools.create_with_distributions.agentSemanticRequirements.columns,
      /only non-empty key and name.*field_key\/field_name to key\/name.*discard all other metadata/,
    );
    assert.deepEqual(
      profile.tools.create_with_distributions.properties.columns.items,
      {
        type: "object",
        required: ["key", "name"],
        properties: {
          key: { type: "string", minLength: 1 },
          name: { type: "string", minLength: 1 },
        },
        additionalProperties: false,
      },
    );
  });

  it("requires a URL when opening the inquiry field selector", () => {
    const tool = profile.tools.select_inquiry_form_fields;
    assert.deepEqual(tool.required, ["url"]);
    assert.equal(tool.properties.url.type, "string");
    assert.equal(tool.properties.platform, undefined);
  });

  it("does not promote runtime observations into advertised output schemas", () => {
    assert.deepEqual(Object.keys(profile.outputEnvelopes), ["observed-runtime"]);
    assert.equal(profile.outputEnvelopes["observed-runtime"].contractStatus, "not-advertised");
    for (const name of [...REQUIRED, ...OPTIONAL]) {
      const output = profile.outputContracts[name];
      assert.equal(output.advertisedOutputSchema, false, name);
      assert.equal(output.successEnvelope, "observed-runtime", name);
      assert.equal(output.failureEnvelope, "observed-runtime", name);
      assert.equal(output.successSchema.type, "object", name);
      assert.equal(output.successSchema.additionalProperties, true, name);
      if (!["search_creators", "rank_mcns", "manual_source_creators"].includes(name)) {
        assert.deepEqual(output.successSchema, { type: "object", additionalProperties: true }, name);
      }
    }
    assert.deepEqual(profile.outputContracts.search_creators.successSchema.properties.data.required, [
      "demand_count", "eligible_creator_count", "supply_ratio",
    ]);
    assert.deepEqual(profile.outputContracts.rank_mcns.successSchema.properties.data.required, [
      "inquiry_id", "demand_count", "selected_supplier_ids", "selected_mcn_count",
      "coverage_scope", "selected_mcn_covered_creator_count",
      "selected_mcn_coverage_multiplier", "selected_mcn_risk_level",
      "manual_sourcing_gap_count",
    ]);
    assert.deepEqual(
      profile.outputContracts.rank_mcns.successSchema.properties.data.properties.selected_mcn_risk_level.enum,
      ["high_risk", "medium_risk", "safe"],
    );
    assert.deepEqual(profile.outputContracts.manual_source_creators.successSchema.properties.data.required, [
      "task_id", "requirement_id", "inquiry_id", "target_count", "status", "operation", "started_at", "accepted_count",
    ]);
    assert.deepEqual(
      profile.outputContracts.manual_source_creators.successSchema.properties.data.properties.status.enum,
      ["started", "running", "completed"],
    );
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
