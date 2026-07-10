import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const V2_PROFILE = "profiles/mvp-v2.json";

const REQUIRED_TOOLS = [
  "validate_requirement",
  "search_creators",
  "rank_mcns",
  "select_inquiry_form_fields",
  "create_with_distributions",
  "sync_mcn_inquiry_status",
  "ingest_mcn_submissions",
  "manual_source_creators",
  "rank_creators",
  "create_submission_batch",
  "record_client_feedback",
  "get_recommendation_run_detail",
  "get_creator_detail",
  "audit_manual_adjustment",
];

const OPTIONAL_TOOLS = ["get_workflow_state"];

const EXPECTED_PROPERTY_TYPES = {
  validate_requirement: {
    platform: "string",
    submission_deadline_at: "string",
    submission_deadline_raw: "string",
    raw_messages_json: "string",
    budget_min_cents: "integer",
    budget_max_cents: "integer",
    budget_raw: "string",
    rebate_min_rate: "number",
    rebate_max_rate: "number",
    rebate_raw: "string",
    quantity_total: "integer",
    project_name: "string",
    brand: "string",
    product: "string",
    content_requirements: "string",
    category_requirements: "array",
    requirements_json: "object",
    raw_messages: "array",
    note: "string",
  },
  search_creators: { requirement_id: "string" },
  rank_mcns: { candidate_pool_id: "string" },
  select_inquiry_form_fields: { mcn_recommendation_id: "string" },
  create_with_distributions: {
    mcn_recommendation_id: "string",
    projectName: "string",
    description: "string",
    deadline: "string",
    remindAt: "string",
    usageScope: "string",
    supplierIds: "array",
    columns: "array",
    sendWechatNotification: "boolean",
    preview_only: "boolean",
    prefillRowsBySupplier: "object",
  },
  sync_mcn_inquiry_status: {
    mcn_recommendation_id: "string",
    requirement_id: "string",
  },
  ingest_mcn_submissions: {
    mcn_recommendation_id: "string",
    requirement_id: "string",
    trigger: "string",
  },
  manual_source_creators: {
    requirement_id: "string",
    manual_results: "array",
  },
  rank_creators: {
    mcn_recommendation_id: "string",
    ranking_strategy: "string",
    manual_batch_ids: "array",
  },
  create_submission_batch: { run_id: "string" },
  record_client_feedback: {
    run_id: "string",
    feedback_items: "array",
  },
  get_recommendation_run_detail: {
    run_id: "string",
    include_submissions: "boolean",
    include_creator_detail: "boolean",
    include_feedback: "boolean",
  },
  get_creator_detail: {
    creator_id: "string",
    platform: "string",
    platform_account_id: "string",
    include_offers: "boolean",
    include_mcn: "boolean",
    include_recent_metrics: "boolean",
    include_vector_text: "boolean",
  },
  audit_manual_adjustment: {
    run_id: "string",
    adjustments: "array",
    operator_id: "string",
  },
  get_workflow_state: {
    requirement_id: "string",
    mcn_recommendation_id: "string",
    inquiry_batch_id: "string",
    run_id: "string",
  },
};

async function loadSpec(relativePath) {
  const source = await readFile(
    new URL(`../spec/${relativePath}`, import.meta.url),
    "utf8",
  );
  return JSON.parse(source);
}

function allWriters(tool) {
  return [...tool.writers.always, ...tool.writers.conditional];
}

describe("mvp-v2 machine-readable contract profile", () => {
  it("is writable and declares exactly the approved required and optional tools", async () => {
    const profile = await loadSpec(V2_PROFILE);

    assert.equal(profile.profile, "mvp-v2");
    assert.equal(profile.mode, "writable");
    assert.deepEqual(profile.requiredTools, REQUIRED_TOOLS);
    assert.deepEqual(profile.optionalTools, OPTIONAL_TOOLS);
    assert.deepEqual(
      Object.keys(profile.tools).sort(),
      [...REQUIRED_TOOLS, ...OPTIONAL_TOOLS].sort(),
    );
  });

  it("gives every tool a complete explicit input contract", async () => {
    const profile = await loadSpec(V2_PROFILE);

    for (const [name, tool] of Object.entries(profile.tools)) {
      assert.equal(tool.name, name, `${name} has a mismatched declared name`);
      for (const key of [
        "required",
        "properties",
        "forbidden",
        "sideEffects",
        "writers",
        "retry",
        "outputEnvelope",
        "successEvidence",
      ]) {
        assert.ok(Object.hasOwn(tool, key), `${name} is missing ${key}`);
      }
      assert.ok(Array.isArray(tool.required), `${name}.required must be an array`);
      assert.ok(Array.isArray(tool.forbidden), `${name}.forbidden must be an array`);
      assert.equal(typeof tool.properties, "object");
      for (const required of tool.required) {
        assert.ok(
          Object.hasOwn(tool.properties, required),
          `${name} requires undeclared property ${required}`,
        );
      }
      for (const forbidden of tool.forbidden) {
        assert.ok(
          !Object.hasOwn(tool.properties, forbidden),
          `${name} both accepts and forbids ${forbidden}`,
        );
      }
      assert.deepEqual(
        Object.fromEntries(
          Object.entries(tool.properties).map(([property, schema]) => [
            property,
            schema.type,
          ]),
        ),
        EXPECTED_PROPERTY_TYPES[name],
        `${name} property types drifted`,
      );
    }
  });

  it("uses only V2 identifiers and preserves the documented input alternatives", async () => {
    const profile = await loadSpec(V2_PROFILE);
    const requiredDemandFields = [
      "platform",
      "submission_deadline_at",
      "submission_deadline_raw",
      "raw_messages_json",
      "budget_min_cents",
      "budget_max_cents",
      "budget_raw",
      "rebate_min_rate",
      "rebate_max_rate",
      "rebate_raw",
      "quantity_total",
    ];

    assert.deepEqual(
      profile.tools.validate_requirement.required,
      requiredDemandFields,
    );
    assert.equal(profile.tools.validate_requirement.properties.note.type, "string");

    for (const [name, tool] of Object.entries(profile.tools)) {
      if (name === "validate_requirement") continue;
      assert.ok(tool.forbidden.includes("demand_id"), `${name} permits demand_id`);
      assert.ok(
        tool.forbidden.includes("demand_version"),
        `${name} permits demand_version`,
      );
    }

    assert.deepEqual(
      Object.keys(profile.tools.sync_mcn_inquiry_status.properties),
      ["mcn_recommendation_id", "requirement_id"],
    );
    assert.deepEqual(profile.tools.sync_mcn_inquiry_status.required, [
      "mcn_recommendation_id",
      "requirement_id",
    ]);
    assert.ok(
      !Object.hasOwn(profile.tools.ingest_mcn_submissions.properties, "items"),
    );
    assert.ok(
      profile.tools.ingest_mcn_submissions.forbidden.includes("items"),
    );
    assert.deepEqual(profile.tools.create_submission_batch.required, ["run_id"]);
    assert.deepEqual(
      Object.keys(profile.tools.create_submission_batch.properties),
      ["run_id"],
    );
    assert.ok(
      profile.tools.create_submission_batch.forbidden.includes(
        "allow_need_confirm_with_risk",
      ),
    );

    assert.equal(profile.tools.get_creator_detail.alternativeMode, "exactly-one");
    assert.deepEqual(profile.tools.get_creator_detail.requiredAlternatives, [
      ["creator_id"],
      ["platform", "platform_account_id"],
    ]);
    assert.equal(profile.tools.get_workflow_state.alternativeMode, "exactly-one");
    assert.deepEqual(profile.tools.get_workflow_state.requiredAlternatives, [
      ["requirement_id"],
      ["mcn_recommendation_id"],
      ["inquiry_batch_id"],
      ["run_id"],
    ]);
  });

  it("defines nonempty structured arrays without open-ended item objects", async () => {
    const profile = await loadSpec(V2_PROFILE);
    const { properties: sendProperties } =
      profile.tools.create_with_distributions;

    assert.equal(sendProperties.usageScope.const, "project");
    assert.equal(sendProperties.preview_only.const, false);
    assert.equal(sendProperties.supplierIds.minItems, 1);
    assert.equal(sendProperties.supplierIds.items.type, "string");
    assert.equal(sendProperties.supplierIds.items.minLength, 1);
    assert.equal(sendProperties.columns.minItems, 1);
    assert.equal(sendProperties.columns.ordered, true);
    assert.deepEqual(sendProperties.columns.items.required, [
      "key",
      "name",
      "type",
      "required",
    ]);
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(sendProperties.columns.items.properties).map(
          ([name, schema]) => [name, schema.type],
        ),
      ),
      { key: "string", name: "string", type: "string", required: "boolean" },
    );
    assert.equal(sendProperties.columns.items.additionalProperties, false);

    const arrayCases = [
      ["manual_source_creators", "manual_results"],
      ["record_client_feedback", "feedback_items"],
      ["audit_manual_adjustment", "adjustments"],
    ];
    for (const [toolName, propertyName] of arrayCases) {
      const schema = profile.tools[toolName].properties[propertyName];
      assert.equal(schema.minItems, 1, `${toolName}.${propertyName} may be empty`);
      assert.equal(schema.items.type, "object");
      assert.ok(schema.items.required.length > 0);
      assert.ok(Object.keys(schema.items.properties).length > 0);
      assert.equal(schema.items.additionalProperties, false);
    }

    const manualBatchIds = profile.tools.rank_creators.properties.manual_batch_ids;
    assert.equal(manualBatchIds.items.type, "string");
    assert.equal(manualBatchIds.items.minLength, 1);
  });

  it("assigns side effects and writer ownership without crossing boundaries", async () => {
    const profile = await loadSpec(V2_PROFILE);

    for (const [name, tool] of Object.entries(profile.tools)) {
      assert.ok(
        ["read-only", "business-write", "provider-write"].includes(
          tool.sideEffects,
        ),
        `${name} has unknown side-effect class`,
      );
      assert.deepEqual(Object.keys(tool.writers), ["always", "conditional"]);
      assert.ok(Array.isArray(tool.writers.always));
      assert.ok(Array.isArray(tool.writers.conditional));
      if (tool.sideEffects === "read-only") {
        assert.deepEqual(allWriters(tool), [], `${name} is not read-only`);
      }
    }

    const inquiryWriters = Object.values(profile.tools)
      .filter((tool) => allWriters(tool).includes("mcn_inquiries"))
      .map((tool) => tool.name);
    assert.deepEqual(inquiryWriters, ["sync_mcn_inquiry_status"]);

    assert.equal(
      profile.tools.select_inquiry_form_fields.sideEffects,
      "read-only",
    );
    assert.equal(
      profile.tools.create_with_distributions.sideEffects,
      "provider-write",
    );
    assert.deepEqual(
      allWriters(profile.tools.create_with_distributions),
      [],
    );
    assert.ok(
      !allWriters(profile.tools.ingest_mcn_submissions).includes(
        "mcn_inquiries",
      ),
    );
    assert.ok(
      !allWriters(profile.tools.audit_manual_adjustment).includes(
        "creator_recommendation_items",
      ),
    );
  });

  it("declares retry reconciliation and the single output-envelope exception", async () => {
    const profile = await loadSpec(V2_PROFILE);

    assert.deepEqual(profile.outputEnvelopes.standard.required, [
      "success",
      "data",
      "error",
    ]);
    assert.deepEqual(profile.outputEnvelopes.standard.error.required, [
      "code",
      "message",
      "retryable",
    ]);

    for (const [name, tool] of Object.entries(profile.tools)) {
      assert.ok(tool.successEvidence.length > 0, `${name} has no success evidence`);
      assert.deepEqual(Object.keys(tool.retry), [
        "policy",
        "blindRetry",
        "unknownOutcome",
        "reconcileWith",
      ]);
      if (tool.sideEffects === "read-only") {
        assert.equal(tool.retry.blindRetry, true, `${name} query is not retryable`);
        assert.equal(tool.retry.unknownOutcome, "not-applicable");
      } else {
        assert.equal(tool.retry.blindRetry, false, `${name} permits blind retry`);
        assert.equal(tool.retry.unknownOutcome, "reconcile-before-retry");
        assert.equal(typeof tool.retry.reconcileWith, "string");
        assert.ok(tool.retry.reconcileWith.length > 0);
      }
    }

    const envelopeExceptions = Object.values(profile.tools)
      .filter((tool) => tool.outputEnvelope !== "standard")
      .map((tool) => tool.name);
    assert.deepEqual(envelopeExceptions, ["select_inquiry_form_fields"]);
    assert.equal(
      profile.tools.select_inquiry_form_fields.outputEnvelope,
      "top-level-field-selection",
    );
    assert.deepEqual(
      profile.tools.select_inquiry_form_fields.successEvidence,
      [
        "success === true",
        "fields",
        "items",
        "selected_count === items.length",
        "selected_count > 0",
      ],
    );
  });
});
