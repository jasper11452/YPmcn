import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import {
  loadContractProfile,
  loadContractSchema,
  loadDatabaseContract,
  loadErrorCatalog,
  loadRequirementDictionary,
  loadRequirementsContract,
  loadWorkflowContract,
  validateContractProfileDocument,
} from "../dist/contract/loader.js";

const V2_PROFILE = "mcp.json";
const LEGACY_PROFILE = "profiles/legacy-1.9.4.json";
const WORKFLOW_SPEC = "workflow.json";
const DATABASE_SPEC = "database.json";
const ERRORS_SPEC = "errors.json";
const REQUIREMENTS_SPEC = "requirements.json";
const REQUIREMENT_DICTIONARY_SPEC = "requirement-dictionary.json";
const WORKFLOW_CONTRACT_HASH =
  "fc014adb8d290ce76c6652e8be88ab26cd0aeca2c81384cc82668919b5c19e61";
const DATABASE_CONTRACT_HASH =
  "1becd34323f8f407c271cf71e6aa8e9685c04dbf9824e9c3ab8d73baf85f038a";
const ERRORS_CONTRACT_HASH =
  "08d033de151b3b0fa15502bff810a8750e2b09927147014fb747c82372d66278";
const REQUIREMENTS_CONTRACT_HASH =
  "1bae2a5b31a5507fb34723054de623c4fdca89dddba124aeebcdfac930e101ff";
const CREATOR_SCHEMA_CSV =
  "../skills/media-assistant/references/creator_candidate_pool_schema.csv";

const JSON_VALUE_TYPES = [
  "array",
  "boolean",
  "null",
  "number",
  "object",
  "string",
];

const CREATOR_SCHEMA_FIELDS = parseCreatorSchemaFields(
  readFileSync(new URL(CREATOR_SCHEMA_CSV, import.meta.url), "utf8"),
);

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

const FIELD_DEFINITION_SCHEMA = {
  type: "object",
  required: ["key", "name", "type", "required"],
  properties: {
    key: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1 },
    type: { type: "string", minLength: 1 },
    required: { type: "boolean" },
  },
  additionalProperties: false,
};

const FIELD_SELECTION_ENVELOPE = {
  type: "object",
  required: ["success", "fields", "items", "selected_count"],
  properties: {
    success: { type: "boolean", const: true },
    url: { type: "string" },
    message: { type: "string" },
    description: { type: "string" },
    fields: {
      type: "object",
      minProperties: 1,
      additionalProperties: FIELD_DEFINITION_SCHEMA,
    },
    items: {
      type: "array",
      minItems: 1,
      ordered: true,
      items: FIELD_DEFINITION_SCHEMA,
    },
    selected_count: { type: "integer", minimum: 1 },
    output_format: { type: "string" },
  },
  additionalProperties: false,
  constraints: [
    "selected_count === items.length",
    "selected_count > 0",
  ],
};

const WORKFLOW_PHASES = [
  "requirement_draft",
  "requirement_ready",
  "candidate_pool_ready",
  "mcn_planning",
  "field_selection_ready",
  "distribution_sync_pending",
  "waiting_return",
  "recovering",
  "recovery_sync_pending",
  "recovered",
  "recommendation_ready",
  "submission_batch_ready",
  "feedback_routing",
  "blocked",
];

const LIFECYCLE_STATUSES = [
  "sent",
  "waiting_return",
  "recover_requested",
  "recovering",
  "recover_failed",
  "recovered",
  "closed",
];

const RESPONSE_STATUSES = [
  "pending",
  "partial",
  "completed",
  "expired",
  "failed",
];

const DATABASE_WRITER_OWNERSHIP = [
  {
    tool: "validate_requirement",
    always: ["requirement_headers", "customer_demands"],
    conditional: ["requirement_snapshots"],
  },
  {
    tool: "search_creators",
    always: ["creator_candidate_pool"],
    conditional: ["requirement_snapshots"],
  },
  {
    tool: "rank_mcns",
    always: ["mcn_recommendation_items"],
    conditional: [],
  },
  {
    tool: "select_inquiry_form_fields",
    always: ["selection_results"],
    conditional: [],
  },
  {
    tool: "create_with_distributions",
    always: ["send_operations"],
    conditional: [],
  },
  {
    tool: "sync_mcn_inquiry_status",
    always: ["mcn_inquiries"],
    conditional: ["mcn_inquiry_field_snapshots"],
  },
  {
    tool: "ingest_mcn_submissions",
    always: ["mcn_submission_items"],
    conditional: ["creator_supply_offers", "offer_promotion_events"],
  },
  {
    tool: "manual_source_creators",
    always: ["manual_sourced_creators"],
    conditional: ["creator_supply_offers", "offer_promotion_events"],
  },
  {
    tool: "rank_creators",
    always: ["recommendation_runs", "creator_recommendation_items"],
    conditional: [],
  },
  {
    tool: "create_submission_batch",
    always: ["submission_batches", "creator_submissions"],
    conditional: [],
  },
  {
    tool: "record_client_feedback",
    always: ["creator_submissions"],
    conditional: ["customer_demands", "feedback_audit_events"],
  },
  {
    tool: "get_recommendation_run_detail",
    always: [],
    conditional: [],
  },
  {
    tool: "get_creator_detail",
    always: [],
    conditional: [],
  },
  {
    tool: "audit_manual_adjustment",
    always: ["creator_recommendation_items", "risk_audit_events"],
    conditional: ["creator_submissions"],
  },
  {
    tool: "get_workflow_state",
    always: [],
    conditional: [],
  },
];

const DATABASE_PROOF_BOUNDARY = {
  isMigrationProof: false,
  isDeploymentProof: false,
  statement:
    "This specification declares external readiness requirements; it is not migration or deployment proof.",
};

const ERROR_CODES = [
  "VECTOR_CONFIGURATION_INVALID",
  "EMBEDDING_UNAVAILABLE",
  "RERANKER_UNAVAILABLE",
  "VECTOR_STORE_UNAVAILABLE",
  "VECTOR_INDEX_STALE",
  "SQL_ONLY_DEGRADED",
  "INTEGRATION_REQUIRED",
  "SCHEMA_MISMATCH",
  "INVALID_INPUT",
  "INVALID_PHASE",
  "CONFIRMATION_REQUIRED",
  "FIELD_SELECTION_INVALID",
  "PROVIDER_REFERENCE_MISSING",
  "RECOVERY_NOT_CONFIRMED",
  "RECOVERY_ALREADY_TERMINAL",
  "CANONICAL_INPUT_CONFLICT",
  "DICTIONARY_REFERENCE_MISMATCH",
  "VALUE_RANGE_INVALID",
  "DEADLINE_ORDER_INVALID",
  "CONSTRAINT_GRAMMAR_INVALID",
  "JOIN_GATE_FAILED",
  "SCOPE_MISMATCH",
  "LATE_DATA_REJECTED",
  "OFFER_PROMOTION_CONFLICT",
  "SELECTION_RESULT_STALE",
  "STATE_COMBINATION_INVALID",
  "STATE_CONFLICT",
  "WRITE_RESULT_UNKNOWN",
];

const LEGACY_TOOL_NAMES = [
  "validate_requirement",
  "search_creators",
  "rank_mcns",
  "ingest_mcn_submissions",
  "manual_source_creators",
  "rank_creators",
  "create_submission_batch",
  "record_client_feedback",
  "get_recommendation_run_detail",
  "get_creator_detail",
  "audit_manual_adjustment",
];

const LEGACY_MISSING_TARGET_TOOLS = [
  "select_inquiry_form_fields",
  "sync_mcn_inquiry_status",
  "create_with_distributions",
];

const LEGACY_REQUIRED_FIELDS = {
  validate_requirement: ["raw_messages"],
  search_creators: ["demand_id", "demand_version"],
  rank_mcns: ["demand_id", "demand_version", "platform"],
  ingest_mcn_submissions: ["inquiry_id", "items"],
  manual_source_creators: ["demand_id", "demand_version"],
  rank_creators: ["demand_id", "demand_version", "ranking_strategy"],
  create_submission_batch: ["run_id"],
  record_client_feedback: ["run_id", "feedback_items"],
  get_recommendation_run_detail: ["run_id"],
  get_creator_detail: ["platform", "platform_account_id"],
  audit_manual_adjustment: ["run_id", "adjustments", "operator_id"],
};

const LEGACY_PROPERTY_TYPES = {
  validate_requirement: {
    raw_messages: "array",
    project_context: "object",
    existing_demand_id: "string",
    existing_demand_version: "integer",
  },
  search_creators: {
    demand_id: "string",
    demand_version: "integer",
    authorized_relaxations: "array",
    write_candidate_pool: "boolean",
    limit: "integer",
  },
  rank_mcns: {
    demand_id: "string",
    demand_version: "integer",
    platform: "string",
    minimum_mcn_count: "integer",
    target_multiplier: "number",
    buffer_rate: "number",
    medium_risk_confirmed: "boolean",
    limit: "integer",
    write_mcn_recommendation_items: "boolean",
  },
  ingest_mcn_submissions: {
    inquiry_id: "string",
    items: "array",
  },
  manual_source_creators: {
    demand_id: "string",
    demand_version: "integer",
    search_context: "object",
    manual_results: "array",
  },
  rank_creators: {
    demand_id: "string",
    demand_version: "integer",
    ranking_strategy: "string",
    run_type: "string",
    candidate_ids: "array",
    ranking_weights: "object",
    feedback_preferences: "object",
    exclude_submitted: "boolean",
    allow_manual_sourced_in_initial_run: "boolean",
    source_priority: "array",
    limit: "integer",
    write_recommendation_items: "boolean",
  },
  create_submission_batch: {
    run_id: "string",
    target_submission_count: "integer",
    recommendation_item_ids: "array",
    exclude_submitted: "boolean",
    allow_need_confirm_with_risk: "boolean",
    created_by: "string",
  },
  record_client_feedback: {
    run_id: "string",
    feedback_items: "array",
    requirement_changes: "object",
  },
  get_recommendation_run_detail: {
    run_id: "string",
    include_submissions: "boolean",
    include_creator_detail: "boolean",
    include_feedback: "boolean",
  },
  get_creator_detail: {
    platform: "string",
    platform_account_id: "string",
    include_offers: "boolean",
    include_mcn: "boolean",
    include_vector_text: "boolean",
    include_recent_metrics: "boolean",
  },
  audit_manual_adjustment: {
    run_id: "string",
    adjustments: "array",
    operator_id: "string",
  },
};

const AUTHORITATIVE_TARGET_SUCCESS_EVIDENCE = {
  create_with_distributions: [
    "success === true",
    "data.provider_project_id",
    "data.distribution_batch_ref",
    "data.distributions.length > 0",
  ],
  ingest_mcn_submissions: [
    "success === true",
    "data.id",
    "data.accepted_count",
    "data.rejected_count",
    "data.created_submission_item_count",
  ],
  create_submission_batch: [
    "success === true",
    "data.id",
    "data.batch_no",
    "data.submitted_count",
  ],
};

const TOOL_EXPECTATIONS = {
  validate_requirement: {
    propertyTypes: {
      ...Object.fromEntries(
        CREATOR_SCHEMA_FIELDS.map((field) => [field, JSON_VALUE_TYPES]),
      ),
      platform: "string",
      submission_deadline_at: "string",
      submission_deadline_raw: "string",
      supplier_response_deadline_at: "string",
      client_submission_deadline_at: "string",
      content_publish_deadline_at: "string",
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
      constraints: "array",
      raw_messages: "array",
      note: "string",
    },
    required: [],
    sideEffects: "business-write",
    writers: {
      always: ["requirement_headers", "customer_demands"],
      conditional: ["requirement_snapshots"],
    },
    retry: {
      policy: "reconcile-authoritative-state",
      blindRetry: false,
      unknownOutcome: "reconcile-before-retry",
      reconcileWith: "query-customer-demands-by-authoritative-id",
    },
    outputEnvelope: "standard",
    successEvidence: ["success === true", "data.id", "data.status"],
  },
  search_creators: {
    propertyTypes: { requirement_id: "string" },
    required: ["requirement_id"],
    sideEffects: "business-write",
    writers: {
      always: ["creator_candidate_pool"],
      conditional: ["requirement_snapshots"],
    },
    retry: {
      policy: "reconcile-authoritative-state",
      blindRetry: false,
      unknownOutcome: "reconcile-before-retry",
      reconcileWith: "query-candidate-pool-by-requirement-id",
    },
    outputEnvelope: "standard",
    successEvidence: [
      "success === true",
      "data.id",
      "data.candidate_pool_written",
    ],
  },
  rank_mcns: {
    propertyTypes: { candidate_pool_id: "string" },
    required: ["candidate_pool_id"],
    sideEffects: "business-write",
    writers: { always: ["mcn_recommendation_items"], conditional: [] },
    retry: {
      policy: "reconcile-authoritative-state",
      blindRetry: false,
      unknownOutcome: "reconcile-before-retry",
      reconcileWith: "query-mcn-recommendation-by-candidate-pool-id",
    },
    outputEnvelope: "standard",
    successEvidence: [
      "success === true",
      "data.id",
      "data.inquiry_advice",
    ],
  },
  select_inquiry_form_fields: {
    propertyTypes: { mcn_recommendation_id: "string" },
    required: ["mcn_recommendation_id"],
    sideEffects: "business-write",
    writers: { always: ["selection_results"], conditional: [] },
    retry: {
      policy: "reconcile-authoritative-selection",
      blindRetry: false,
      unknownOutcome: "reconcile-before-retry",
      reconcileWith: "get_workflow_state",
    },
    outputEnvelope: "top-level-field-selection",
    successEvidence: [
      "success === true",
      "fields",
      "items",
      "selected_count === items.length",
      "selected_count > 0",
    ],
  },
  create_with_distributions: {
    propertyTypes: {
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
    required: [
      "mcn_recommendation_id",
      "projectName",
      "description",
      "deadline",
      "remindAt",
      "usageScope",
      "supplierIds",
      "columns",
      "sendWechatNotification",
      "preview_only",
    ],
    sideEffects: "provider-write",
    writers: { always: ["send_operations"], conditional: [] },
    retry: {
      policy: "reconcile-provider-reference",
      blindRetry: false,
      unknownOutcome: "reconcile-before-retry",
      reconcileWith: "sync_mcn_inquiry_status",
    },
    outputEnvelope: "standard",
    successEvidence: [
      "success === true",
      "data.provider_project_id",
      "data.distribution_batch_ref",
      "data.distributions.length > 0",
    ],
  },
  sync_mcn_inquiry_status: {
    propertyTypes: {
      mcn_recommendation_id: "string",
      requirement_id: "string",
    },
    required: ["mcn_recommendation_id", "requirement_id"],
    sideEffects: "business-write",
    writers: {
      always: ["mcn_inquiries"],
      conditional: ["mcn_inquiry_field_snapshots"],
    },
    retry: {
      policy: "idempotent-business-key",
      blindRetry: false,
      unknownOutcome: "reconcile-before-retry",
      reconcileWith: "sync_mcn_inquiry_status",
    },
    outputEnvelope: "standard",
    successEvidence: [
      "success === true",
      "data.inquiry_batch_id",
      "data.inquiry_ids",
      "data.snapshot_id",
      "data.lifecycle_status",
      "data.response_status",
    ],
  },
  ingest_mcn_submissions: {
    propertyTypes: {
      mcn_recommendation_id: "string",
      requirement_id: "string",
      trigger: "string",
    },
    required: ["mcn_recommendation_id", "requirement_id", "trigger"],
    sideEffects: "business-write",
    writers: {
      always: ["mcn_submission_items"],
      conditional: ["creator_supply_offers", "offer_promotion_events"],
    },
    retry: {
      policy: "reconcile-provider-rows",
      blindRetry: false,
      unknownOutcome: "reconcile-before-retry",
      reconcileWith: "sync_mcn_inquiry_status",
    },
    outputEnvelope: "standard",
    successEvidence: [
      "success === true",
      "data.id",
      "data.accepted_count",
      "data.rejected_count",
      "data.created_submission_item_count",
    ],
  },
  manual_source_creators: {
    propertyTypes: {
      requirement_id: "string",
      manual_results: "array",
    },
    required: ["requirement_id", "manual_results"],
    sideEffects: "business-write",
    writers: {
      always: ["manual_sourced_creators"],
      conditional: ["creator_supply_offers", "offer_promotion_events"],
    },
    retry: {
      policy: "reconcile-authoritative-state",
      blindRetry: false,
      unknownOutcome: "reconcile-before-retry",
      reconcileWith: "query-manual-batch-by-requirement-id",
    },
    outputEnvelope: "standard",
    successEvidence: [
      "success === true",
      "data.manual_batch_id",
      "data.imported_count",
    ],
  },
  rank_creators: {
    propertyTypes: {
      mcn_recommendation_id: "string",
      ranking_strategy: "string",
      manual_batch_ids: "array",
    },
    required: ["mcn_recommendation_id"],
    sideEffects: "business-write",
    writers: {
      always: ["recommendation_runs", "creator_recommendation_items"],
      conditional: [],
    },
    retry: {
      policy: "reconcile-authoritative-state",
      blindRetry: false,
      unknownOutcome: "reconcile-before-retry",
      reconcileWith: "get_recommendation_run_detail",
    },
    outputEnvelope: "standard",
    successEvidence: [
      "success === true",
      "data.run_id",
      "data.ranked_count",
    ],
  },
  create_submission_batch: {
    propertyTypes: { run_id: "string" },
    required: ["run_id"],
    sideEffects: "business-write",
    writers: {
      always: ["submission_batches", "creator_submissions"],
      conditional: [],
    },
    retry: {
      policy: "reuse-current-unfinished-batch",
      blindRetry: false,
      unknownOutcome: "reconcile-before-retry",
      reconcileWith: "get_recommendation_run_detail",
    },
    outputEnvelope: "standard",
    successEvidence: [
      "success === true",
      "data.id",
      "data.batch_no",
      "data.submitted_count",
    ],
  },
  record_client_feedback: {
    propertyTypes: {
      run_id: "string",
      feedback_items: "array",
    },
    required: ["run_id", "feedback_items"],
    sideEffects: "business-write",
    writers: {
      always: ["creator_submissions"],
      conditional: ["customer_demands", "feedback_audit_events"],
    },
    retry: {
      policy: "reconcile-authoritative-state",
      blindRetry: false,
      unknownOutcome: "reconcile-before-retry",
      reconcileWith: "get_recommendation_run_detail",
    },
    outputEnvelope: "standard",
    successEvidence: [
      "success === true",
      "data.updated_count",
      "data.next_action",
    ],
  },
  get_recommendation_run_detail: {
    propertyTypes: {
      run_id: "string",
      include_submissions: "boolean",
      include_creator_detail: "boolean",
      include_feedback: "boolean",
    },
    required: ["run_id"],
    sideEffects: "read-only",
    writers: { always: [], conditional: [] },
    retry: {
      policy: "query-safe",
      blindRetry: true,
      unknownOutcome: "not-applicable",
      reconcileWith: null,
    },
    outputEnvelope: "standard",
    successEvidence: [
      "success === true",
      "data.run_id",
      "data.recommendation_snapshot",
    ],
  },
  get_creator_detail: {
    propertyTypes: {
      creator_id: "string",
      platform: "string",
      platform_account_id: "string",
      include_offers: "boolean",
      include_mcn: "boolean",
      include_recent_metrics: "boolean",
      include_vector_text: "boolean",
    },
    required: [],
    sideEffects: "read-only",
    writers: { always: [], conditional: [] },
    retry: {
      policy: "query-safe",
      blindRetry: true,
      unknownOutcome: "not-applicable",
      reconcileWith: null,
    },
    outputEnvelope: "standard",
    successEvidence: [
      "success === true",
      "data.creator_id",
      "data.creator_detail",
    ],
  },
  audit_manual_adjustment: {
    propertyTypes: {
      run_id: "string",
      adjustments: "array",
      operator_id: "string",
    },
    required: ["run_id", "adjustments", "operator_id"],
    sideEffects: "business-write",
    writers: {
      always: ["creator_recommendation_items", "risk_audit_events"],
      conditional: ["creator_submissions"],
    },
    retry: {
      policy: "reconcile-authoritative-state",
      blindRetry: false,
      unknownOutcome: "reconcile-before-retry",
      reconcileWith: "get_recommendation_run_detail",
    },
    outputEnvelope: "standard",
    successEvidence: [
      "success === true",
      "data.audit_id",
      "data.items",
      "data.written_count",
    ],
  },
  get_workflow_state: {
    propertyTypes: {
      requirement_id: "string",
      mcn_recommendation_id: "string",
      inquiry_batch_id: "string",
      run_id: "string",
    },
    required: [],
    sideEffects: "read-only",
    writers: { always: [], conditional: [] },
    retry: {
      policy: "query-safe",
      blindRetry: true,
      unknownOutcome: "not-applicable",
      reconcileWith: null,
    },
    outputEnvelope: "standard",
    successEvidence: [
      "success === true",
      "data.phase",
      "data.current_identifier",
    ],
  },
};

async function loadSpec(relativePath) {
  const source = await readFile(
    new URL(`../../spec/${relativePath}`, import.meta.url),
    "utf8",
  );
  return JSON.parse(source);
}

async function loadSchema(relativePath) {
  const source = await readFile(
    new URL(`../../spec/schemas/${relativePath}`, import.meta.url),
    "utf8",
  );
  return JSON.parse(source);
}

function parseCreatorSchemaFields(source) {
  const [header, ...rows] = source
    .replace(/^\uFEFF/, "")
    .trim()
    .split(/\r?\n/);
  const fieldIndex = header.split(",").indexOf("字段");
  assert.notEqual(fieldIndex, -1, "authority CSV is missing the 字段 column");
  return rows
    .map((row) => row.split(",")[fieldIndex]?.trim())
    .filter(Boolean);
}

async function loadCreatorSchemaFields() {
  const source = await readFile(
    new URL(CREATOR_SCHEMA_CSV, import.meta.url),
    "utf8",
  );
  return parseCreatorSchemaFields(source);
}

function canonicalizeJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalDigest(value) {
  return createHash("sha256").update(canonicalizeJson(value), "utf8").digest("hex");
}

function allWriters(tool) {
  return [...tool.writers.always, ...tool.writers.conditional];
}

function assertToolContract(name, tool) {
  assert.deepEqual(
    {
      propertyTypes: Object.fromEntries(
        Object.entries(tool.properties).map(([property, schema]) => [
          property,
          schema.type,
        ]),
      ),
      required: tool.required,
      sideEffects: tool.sideEffects,
      writers: tool.writers,
      retry: tool.retry,
      outputEnvelope: tool.outputEnvelope,
      successEvidence: tool.successEvidence,
    },
    TOOL_EXPECTATIONS[name],
    `${name} contract drifted`,
  );
}

function assertWorkflowContract(workflow) {
  assert.equal(workflow.schemaVersion, 1, "workflow contract drifted");
  assert.equal(workflow.profile, "mvp-v2", "workflow contract drifted");
  assert.equal(
    canonicalDigest(workflow),
    WORKFLOW_CONTRACT_HASH,
    "workflow contract drifted",
  );
}

function evaluateWorkflowGuard(guard, context) {
  const lifecycleSubject =
    "(?:result\\.data\\.lifecycle_status|authoritative\\.lifecycle_status|authoritative-lifecycle-status|latest-authoritative-sync-lifecycle-status)";
  const membership = guard.match(
    new RegExp(`^(${lifecycleSubject}) (in|not in) \\[([^\\]]+)\\]$`),
  );
  if (membership) {
    const [, , operator, encodedStatuses] = membership;
    const statuses = encodedStatuses
      .split(",")
      .map((status) => status.trim())
      .filter(Boolean);
    const included = statuses.includes(context.lifecycleStatus);
    return operator === "in" ? included : !included;
  }

  const equality = guard.match(
    new RegExp(`^(${lifecycleSubject}) === ([a-z_]+)$`),
  );
  if (equality) return context.lifecycleStatus === equality[2];
  if (guard.includes("lifecycle")) {
    throw new Error(`Unrecognized lifecycle predicate: ${guard}`);
  }

  switch (guard) {
    case "required-demand-fields-present":
      return context.requiredDemandFieldsPresent === true;
    case "result.data.status === ready":
      return context.requirementStatus === "ready";
    case "explicit-recovery-intent-in-current-session":
    case "state.manual_recovery_confirmed_at-is-current":
      return context.mode === "manual" && context.manualConfirmed === true;
    case "ctx.recovery_trigger === manual":
      return context.mode === "manual";
    case "ctx.trigger === cron":
      return context.mode === "scheduled";
    case "params.trigger === manual":
      return context.mode === "manual";
    case "params.trigger === scheduled":
      return context.mode === "scheduled";
    case "current-session-successful-sync-evidence-present":
      return context.successfulSync === true;
    case "current-session-successful-ingest-evidence-present":
      return context.successfulIngest === true;
    default:
      return context.allowedGuards?.has(guard) === true;
  }
}

function transitionApplies(transition, context) {
  return transition.guards.every((guard) =>
    evaluateWorkflowGuard(guard, context),
  );
}

function assertRecoveryGraphSemantics(workflow) {
  assert.deepEqual(
    workflow.recoveryOperations.map(
      ({ name, action, tool, order, sessionContextRequired, nextOperations }) => ({
        name,
        action,
        tool,
        order,
        sessionContextRequired,
        nextOperations,
      }),
    ),
    [
      {
        name: "refresh",
        action: "refresh_recovery",
        tool: "sync_mcn_inquiry_status",
        order: 1,
        sessionContextRequired: false,
        nextOperations: ["request", "finalize"],
      },
      {
        name: "request",
        action: "request_recovery",
        tool: "ingest_mcn_submissions",
        order: 2,
        sessionContextRequired: false,
        nextOperations: ["finalize"],
      },
      {
        name: "finalize",
        action: "finalize_recovery",
        tool: "sync_mcn_inquiry_status",
        order: 3,
        sessionContextRequired: false,
        nextOperations: [],
      },
    ],
  );

  const expectedTransitions = [
    {
      id: "recovery-refreshed-requestable",
      from: "waiting_return",
      tool: "sync_mcn_inquiry_status",
      nextPhase: "recovering",
      requiredGuards: [
        "authoritative.allowed_actions includes refresh_recovery",
        "result.data.allowed_actions includes request_recovery",
        "result.data.lifecycle_status not in [recovered, closed]",
      ],
    },
    {
      id: "recovery-requested",
      from: "recovering",
      tool: "ingest_mcn_submissions",
      nextPhase: "recovery_sync_pending",
      requiredGuards: [
        "authoritative.allowed_actions includes request_recovery",
        "compare-and-swap authoritative.state_version succeeds",
        "params.trigger is audit-only-not-authorization",
      ],
    },
    {
      id: "recovery-finalized",
      from: "recovery_sync_pending",
      tool: "sync_mcn_inquiry_status",
      nextPhase: "recovered",
      requiredGuards: [
        "authoritative.allowed_actions includes finalize_recovery",
        "authoritative.recovery_operation_id is present",
        "result.data.lifecycle_status in [recovered, closed]",
      ],
    },
  ];
  for (const expected of expectedTransitions) {
    const transition = workflow.transitions.find(({ id }) => id === expected.id);
    assert.ok(transition, `missing ${expected.id}`);
    assert.equal(transition.from, expected.from);
    assert.equal(transition.trigger.type, "tool");
    assert.equal(transition.trigger.name, expected.tool);
    assert.equal(transition.nextPhase, expected.nextPhase);
    assert.deepEqual(transition.guards, expected.requiredGuards);
  }

  const sessionAuthorityPatterns =
    /current-session|manual_recovery_confirmed_at|ctx\.(?:trigger|recovery_trigger)/;
  for (const transition of workflow.transitions) {
    for (const guard of transition.guards) {
      assert.doesNotMatch(guard, sessionAuthorityPatterns);
    }
  }
  assert.equal(
    workflow.transitions.some(({ trigger }) => trigger.type === "event"),
    false,
  );

  const terminal = workflow.transitions.find(
    ({ id }) => id === "terminal-recovery-refresh-no-op",
  );
  assert.equal(terminal.from, "recovered");
  assert.equal(terminal.trigger.name, "sync_mcn_inquiry_status");
  assert.equal(terminal.nextPhase, "recovered");
  assert.deepEqual(terminal.guards, [
    "authoritative.lifecycle_status in [recovered, closed]",
    "authoritative.allowed_actions includes refresh_recovery",
    "authoritative.allowed_actions excludes request_recovery",
    "authoritative.allowed_actions excludes finalize_recovery",
  ]);
}

function assertDatabaseContract(database) {
  assert.equal(database.schemaVersion, 1, "database contract drifted");
  assert.equal(database.profile, "mvp-v2", "database contract drifted");
  assert.equal(
    canonicalDigest(database),
    DATABASE_CONTRACT_HASH,
    "database contract drifted",
  );
}

function assertErrorsContract(errors) {
  assert.equal(errors.schemaVersion, 1, "errors contract drifted");
  assert.equal(errors.profile, "mvp-v2", "errors contract drifted");
  assert.equal(
    canonicalDigest(errors),
    ERRORS_CONTRACT_HASH,
    "errors contract drifted",
  );
}

describe("runtime contract loaders", () => {
  it("loads and freezes every approved contract-closure document", () => {
    const profile = loadContractProfile("mvp-v2");
    const workflow = loadWorkflowContract();
    const database = loadDatabaseContract();
    const errors = loadErrorCatalog();
    const dictionary = loadRequirementDictionary();
    const requirements = loadRequirementsContract();

    for (const value of [profile, workflow, database, errors, dictionary, requirements]) {
      assert.equal(Object.isFrozen(value), true);
    }
    assert.equal(
      requirements.dictionary.hash,
      dictionary.dictionaryHash,
    );
    assert.deepEqual(
      workflow.recoveryOperations.map(({ name }) => name),
      ["refresh", "request", "finalize"],
    );
    assert.equal(Object.keys(database.entities).length, 10);
    assert.equal(Object.keys(profile.outputContracts).length, 15);
    assert.equal(profile.serverIdentity.canonicalNamespace, "ypmcn");
  });

  it("loads every referenced generation schema", () => {
    for (const name of [
      "constraint-expression.schema.json",
      "domain-records.schema.json",
      "requirement-record.schema.json",
      "requirement-snapshot.schema.json",
      "workflow-state.schema.json",
    ]) {
      const schema = loadContractSchema(name);
      assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
      assert.equal(Object.isFrozen(schema), true);
    }
  });

  it("rejects incomplete or mismatched per-tool output contracts", () => {
    const profile = structuredClone(loadContractProfile("mvp-v2"));
    delete profile.outputContracts.rank_creators;
    assert.throws(
      () => validateContractProfileDocument("mvp-v2", profile),
      /outputContracts\.rank_creators is missing/,
    );

    const mismatched = structuredClone(loadContractProfile("mvp-v2"));
    mismatched.outputContracts.select_inquiry_form_fields.successEnvelope = "standard";
    assert.throws(
      () => validateContractProfileDocument("mvp-v2", mismatched),
      /successEnvelope must match the tool outputEnvelope/,
    );

    const nonExclusive = structuredClone(loadContractProfile("mvp-v2"));
    nonExclusive.outputEnvelopes.standard.oneOf[0].properties.error.type = "object";
    assert.throws(
      () => validateContractProfileDocument("mvp-v2", nonExclusive),
      /success\/data\/error branches are invalid/,
    );

    const unresolved = structuredClone(loadContractProfile("mvp-v2"));
    unresolved.tools.validate_requirement.properties.constraints.items.$ref =
      "schemas/unknown.schema.json";
    assert.throws(
      () => validateContractProfileDocument("mvp-v2", unresolved),
      /unsupported contract schema/,
    );
  });

  it("rejects Host namespace aliases, bare Hook events, and provider namespace conflation", () => {
    const foreignNamespace = structuredClone(loadContractProfile("mvp-v2"));
    foreignNamespace.serverIdentity.canonicalNamespace = "foreign";
    assert.throws(
      () => validateContractProfileDocument("mvp-v2", foreignNamespace),
      /canonicalNamespace must be ypmcn/,
    );

    const bareHookEvent = structuredClone(loadContractProfile("mvp-v2"));
    bareHookEvent.serverIdentity.hostQualifiedToolName.bareHookEvent = "business-tool";
    assert.throws(
      () => validateContractProfileDocument("mvp-v2", bareHookEvent),
      /exact Host-qualified contract tool names/,
    );

    const providerNamespace = structuredClone(loadContractProfile("mvp-v2"));
    providerNamespace.serverIdentity.providerToolsList.toolNameFormat = "host-qualified-tool";
    assert.throws(
      () => validateContractProfileDocument("mvp-v2", providerNamespace),
      /provider tools\/list names must remain bare contract tool names/,
    );
  });
});

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

  it("defines the only Host business namespace without changing provider bare names", async () => {
    const profile = await loadSpec(V2_PROFILE);
    const toolNames = [...REQUIRED_TOOLS, ...OPTIONAL_TOOLS];
    const identity = profile.serverIdentity;

    assert.equal(identity.canonicalNamespace, "ypmcn");
    assert.equal(identity.hostQualifiedToolName.format, "mcp__ypmcn__<contract-tool>");
    assert.equal(
      identity.hostQualifiedToolName.pattern,
      `^mcp__ypmcn__(?:${toolNames.join("|")})$`,
    );
    assert.equal(
      identity.hostQualifiedToolName.businessToolIdentity,
      "exact-qualified-name-and-contract-tool",
    );
    assert.equal(identity.hostQualifiedToolName.bareHookEvent, "not-a-business-tool");
    assert.deepEqual(identity.excludedNamespaces, ["vector-mcp"]);
    assert.equal(identity.providerToolsList.toolNameFormat, "bare-contract-tool");
    assert.equal(identity.providerToolsList.namespace, "not-applicable");
    assert.equal(identity.providerToolsList.businessToolIdentity, "catalog-membership-only");

    const hostToolPattern = new RegExp(identity.hostQualifiedToolName.pattern);
    for (const name of toolNames) {
      assert.match(`mcp__ypmcn__${name}`, hostToolPattern);
      assert.doesNotMatch(name, hostToolPattern);
      assert.doesNotMatch(`mcp__foreign__${name}`, hostToolPattern);
      assert.doesNotMatch(`mcp__vector-mcp__${name}`, hostToolPattern);
    }
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
      for (const [property, schema] of Object.entries(tool.properties)) {
        assert.ok(
          typeof schema.type === "string" ||
            (Array.isArray(schema.type) &&
              schema.type.length > 0 &&
              schema.type.every((type) => typeof type === "string")),
          `${name}.${property} has no explicit property type`,
        );
      }
    }
  });

  it("declares at-least-one raw or structured requirement input modes", async () => {
    const profile = await loadSpec(V2_PROFILE);
    const tool = profile.tools.validate_requirement;
    const structuredFields = Object.keys(tool.properties).filter(
      (field) => field !== "raw_messages" && field !== "raw_messages_json",
    );

    assert.deepEqual(tool.required, []);
    assert.deepEqual(tool.inputModes, {
      policy: "at-least-one",
      allowMultiple: true,
      modes: {
        raw: { matchAny: ["raw_messages", "raw_messages_json"] },
        structured: { matchAny: structuredFields },
      },
    });
  });

  it("allows every checked-in authority CSV field without inventing unknown scalar types", async () => {
    const [profile, csvFields] = await Promise.all([
      loadSpec(V2_PROFILE),
      loadCreatorSchemaFields(),
    ]);
    const properties = profile.tools.validate_requirement.properties;
    const strongerSchemaFields = new Set([
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
      "project_name",
      "brand",
      "product",
      "note",
    ]);

    assert.equal(new Set(csvFields).size, csvFields.length);
    for (const field of csvFields) {
      assert.ok(Object.hasOwn(properties, field), `missing CSV field ${field}`);
      if (!strongerSchemaFields.has(field)) {
        assert.deepEqual(
          properties[field].type,
          JSON_VALUE_TYPES,
          `${field} invents an unsupported scalar type`,
        );
      }
    }
  });

  it("matches the authoritative nested manual-source and feedback payload fields", async () => {
    const profile = await loadSpec(V2_PROFILE);
    const manualItem =
      profile.tools.manual_source_creators.properties.manual_results.items;
    const feedbackItem =
      profile.tools.record_client_feedback.properties.feedback_items.items;

    assert.deepEqual(manualItem.required, [
      "platform",
      "platform_account_id",
      "profile_url",
    ]);
    for (const field of [
      "platform",
      "platform_account_id",
      "nickname",
      "profile_url",
    ]) {
      assert.ok(Object.hasOwn(manualItem.properties, field), field);
    }
    assert.equal(Object.hasOwn(manualItem.properties, "source_url"), false);

    assert.deepEqual(feedbackItem.required, ["submission_id", "status"]);
    assert.deepEqual(Object.keys(feedbackItem.properties), [
      "submission_id",
      "status",
      "reason",
    ]);
    assert.equal(Object.hasOwn(feedbackItem.properties.status, "enum"), false);
    for (const field of ["creator_submission_id", "decision", "comment"]) {
      assert.equal(Object.hasOwn(feedbackItem.properties, field), false, field);
    }
  });

  it("matches the supplied tool-contract success evidence for every target use", async () => {
    const [profile, workflow] = await Promise.all([
      loadSpec(V2_PROFILE),
      loadSpec(WORKFLOW_SPEC),
    ]);

    for (const [name, expectedEvidence] of Object.entries(
      AUTHORITATIVE_TARGET_SUCCESS_EVIDENCE,
    )) {
      assert.deepEqual(
        profile.tools[name].successEvidence,
        expectedEvidence,
        `${name} profile success evidence drifted from the supplied tool contract`,
      );

      const transitions = workflow.transitions.filter(
        ({ trigger }) => trigger.type === "tool" && trigger.name === name,
      );
      assert.ok(transitions.length > 0, `${name} has no workflow transition`);
      for (const transition of transitions) {
        assert.deepEqual(
          transition.evidence,
          expectedEvidence,
          `${transition.id} success evidence drifted from the supplied tool contract`,
        );
      }
    }
  });

  it("matches the exact approved contract row for every V2 tool", async () => {
    const profile = await loadSpec(V2_PROFILE);
    const expectedToolNames = [...REQUIRED_TOOLS, ...OPTIONAL_TOOLS];

    assert.deepEqual(Object.keys(TOOL_EXPECTATIONS), expectedToolNames);
    for (const name of expectedToolNames) {
      assertToolContract(name, profile.tools[name]);
    }
  });

  it("matches the exact approved top-level field-selection envelope", async () => {
    const profile = await loadSpec(V2_PROFILE);

    assert.deepEqual(
      profile.outputEnvelopes["top-level-field-selection"],
      FIELD_SELECTION_ENVELOPE,
    );
  });

  it("rejects cloned contract rows when exact oracle fields are mutated", async () => {
    const profile = await loadSpec(V2_PROFILE);
    const mutationCases = [
      {
        label: "removed required field",
        name: "create_with_distributions",
        mutate: (tool) => tool.required.pop(),
      },
      {
        label: "changed required field",
        name: "search_creators",
        mutate: (tool) => {
          tool.required[0] = "demand_id";
        },
      },
      {
        label: "changed side-effect class",
        name: "select_inquiry_form_fields",
        mutate: (tool) => {
          tool.sideEffects = "read-only";
        },
      },
      {
        label: "changed always-writer",
        name: "sync_mcn_inquiry_status",
        mutate: (tool) => {
          tool.writers.always[0] = "mcn_submission_items";
        },
      },
      {
        label: "removed conditional writer",
        name: "ingest_mcn_submissions",
        mutate: (tool) => tool.writers.conditional.pop(),
      },
      {
        label: "changed retry policy",
        name: "search_creators",
        mutate: (tool) => {
          tool.retry.policy = "query-safe";
        },
      },
      {
        label: "changed blind-retry flag",
        name: "select_inquiry_form_fields",
        mutate: (tool) => {
          tool.retry.blindRetry = true;
        },
      },
      {
        label: "changed unknown-outcome handling",
        name: "create_with_distributions",
        mutate: (tool) => {
          tool.retry.unknownOutcome = "retry-immediately";
        },
      },
      {
        label: "changed reconciliation path",
        name: "sync_mcn_inquiry_status",
        mutate: (tool) => {
          tool.retry.reconcileWith = "search_creators";
        },
      },
      {
        label: "changed output envelope",
        name: "select_inquiry_form_fields",
        mutate: (tool) => {
          tool.outputEnvelope = "standard";
        },
      },
      {
        label: "removed success evidence",
        name: "rank_creators",
        mutate: (tool) => tool.successEvidence.pop(),
      },
      {
        label: "changed success evidence",
        name: "validate_requirement",
        mutate: (tool) => {
          tool.successEvidence[0] = "success === false";
        },
      },
      {
        label: "renamed distribution success evidence",
        name: "create_with_distributions",
        mutate: (tool) => {
          tool.successEvidence[2] = "data.distribution_reference";
        },
      },
      {
        label: "removed ingest success evidence",
        name: "ingest_mcn_submissions",
        mutate: (tool) => tool.successEvidence.splice(3, 1),
      },
      {
        label: "renamed submission-batch success evidence",
        name: "create_submission_batch",
        mutate: (tool) => {
          tool.successEvidence[1] = "data.batch_id";
        },
      },
    ];

    for (const { label, name, mutate } of mutationCases) {
      const mutated = structuredClone(profile.tools[name]);
      mutate(mutated);
      assert.throws(
        () => assertToolContract(name, mutated),
        new RegExp(`${name} contract drifted`),
        label,
      );
    }
  });

  it("uses only V2 identifiers and preserves the documented input alternatives", async () => {
    const profile = await loadSpec(V2_PROFILE);

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
    for (const forbidden of [
      "mode",
      "provider_project_id",
      "provider_distribution_id",
      "distribution_batch_ref",
      "distributions",
      "fields",
      "items",
      "selected_count",
      "inquiry_batch_id",
      "inquiry_ids",
      "snapshot_id",
      "lifecycle_status",
      "response_status",
      "submitted_item_count",
      "missing_item_count",
      "count",
    ]) {
      assert.ok(
        profile.tools.sync_mcn_inquiry_status.forbidden.includes(forbidden),
        `sync_mcn_inquiry_status permits caller-owned ${forbidden}`,
      );
    }
    assert.ok(
      !Object.hasOwn(profile.tools.ingest_mcn_submissions.properties, "items"),
    );
    assert.ok(
      profile.tools.ingest_mcn_submissions.forbidden.includes("items"),
    );
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

    assert.deepEqual(
      allWriters(profile.tools.create_with_distributions),
      ["send_operations"],
    );
    assert.ok(
      !allWriters(profile.tools.ingest_mcn_submissions).includes(
        "mcn_inquiries",
      ),
    );
    assert.deepEqual(allWriters(profile.tools.audit_manual_adjustment), [
      "creator_recommendation_items",
      "risk_audit_events",
      "creator_submissions",
    ]);
    assert.ok(
      !allWriters(profile.tools.audit_manual_adjustment).includes(
        "manual_adjustment_audits",
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
    const errorSchema = profile.outputEnvelopes.standard.properties.error.oneOf.find(
      ({ type }) => type === "object",
    );
    assert.deepEqual(errorSchema.required, [
      "code",
      "message",
      "retryable",
    ]);
    assert.equal(errorSchema.additionalProperties, false);

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
  });

  it("gives every ordinary tool one closed output contract", async () => {
    const [profile, errors] = await Promise.all([
      loadSpec(V2_PROFILE),
      loadSpec(ERRORS_SPEC),
    ]);
    const toolNames = [...profile.requiredTools, ...profile.optionalTools];
    const knownErrors = new Set(errors.codes);

    assert.deepEqual(Object.keys(profile.outputContracts), toolNames);
    assert.deepEqual(profile.outputEnvelopes.standard.constraints, [
      "success === true -> data !== null && error === null",
      "success === false -> data === null && error !== null",
      "error.code in errors.json#codes",
    ]);
    assert.deepEqual(
      profile.outputEnvelopes.standard.oneOf.map(({ properties }) => [
        properties.success.const,
        properties.data.type,
        properties.error.type,
      ]),
      [[true, "object", "null"], [false, "null", "object"]],
    );
    for (const name of toolNames) {
      const output = profile.outputContracts[name];
      assert.deepEqual(Object.keys(output), [
        "successEnvelope",
        "failureEnvelope",
        "successSchema",
        "errorCodes",
      ]);
      assert.equal(output.successEnvelope, profile.tools[name].outputEnvelope, name);
      assert.equal(output.failureEnvelope, "standard", name);
      assert.equal(typeof output.successSchema, "object", name);
      assert.ok(output.errorCodes.length > 0, name);
      assert.equal(new Set(output.errorCodes).size, output.errorCodes.length, name);
      for (const code of output.errorCodes) {
        assert.equal(knownErrors.has(code), true, `${name}:${code}`);
      }
    }

    assert.deepEqual(
      profile.outputContracts.select_inquiry_form_fields.successSchema,
      { $ref: "#/outputEnvelopes/top-level-field-selection" },
    );
    assert.deepEqual(
      profile.outputContracts.validate_requirement.successSchema.required,
      [
        "id",
        "status",
        "requirement_head_id",
        "requirement_ids",
        "dictionary_version",
        "dictionary_hash",
      ],
    );
    assert.ok(
      profile.outputContracts.create_with_distributions.successSchema.required.includes(
        "send_operation_id",
      ),
    );
    assert.ok(
      profile.outputContracts.sync_mcn_inquiry_status.successSchema.required.includes(
        "allowed_actions",
      ),
    );
    assert.ok(
      profile.outputContracts.get_workflow_state.successSchema.required.includes(
        "state_version",
      ),
    );
  });
});

describe("requirement validity contract", () => {
  it("pins a customer-content-free dictionary by reproducible version and hash", async () => {
    const [requirements, dictionary] = await Promise.all([
      loadSpec(REQUIREMENTS_SPEC),
      loadSpec(REQUIREMENT_DICTIONARY_SPEC),
    ]);

    assert.equal(dictionary.contentPolicy.containsCustomerContent, false);
    assert.deepEqual(dictionary.contentPolicy.forbiddenContent, [
      "customer-message",
      "customer-brief",
      "customer-payload",
      "credential",
      "internal-unredacted-state",
    ]);
    assert.equal(dictionary.dictionaryHashAlgorithm, "sha256");
    assert.equal(dictionary.dictionaryHashScope, "definitions");
    assert.equal(canonicalDigest(dictionary.definitions), dictionary.dictionaryHash);
    assert.deepEqual(
      {
        path: requirements.dictionary.path,
        version: requirements.dictionary.version,
        hash: requirements.dictionary.hash,
        hashAlgorithm: requirements.dictionary.hashAlgorithm,
        hashCanonicalization: requirements.dictionary.hashCanonicalization,
        hashScope: requirements.dictionary.hashScope,
      },
      {
        path: "requirement-dictionary.json",
        version: dictionary.dictionaryVersion,
        hash: dictionary.dictionaryHash,
        hashAlgorithm: dictionary.dictionaryHashAlgorithm,
        hashCanonicalization: dictionary.dictionaryHashCanonicalization,
        hashScope: dictionary.dictionaryHashScope,
      },
    );
    assert.equal(requirements.dictionary.customerContentAllowed, false);
    assert.deepEqual(requirements.dictionary.referencedBy, [
      "requirement_headers",
      "customer_demands",
      "requirement_snapshots",
      "selection_results",
    ]);

    const forbiddenDefinitionKeys = new Set([
      "value",
      "default",
      "example",
      "customer_content",
      "brief",
      "payload",
      "messages",
    ]);
    for (const [name, definition] of Object.entries(dictionary.definitions)) {
      for (const key of Object.keys(definition)) {
        assert.equal(forbiddenDefinitionKeys.has(key), false, `${name}.${key}`);
      }
    }
  });

  it("makes raw_messages_json canonical and fails closed on aliases", async () => {
    const [requirements, profile] = await Promise.all([
      loadSpec(REQUIREMENTS_SPEC),
      loadSpec(V2_PROFILE),
    ]);

    assert.deepEqual(requirements.canonicalInput, {
      field: "raw_messages_json",
      transportType: "canonical-json-text",
      storedType: "json-array",
      canonicalization: "recursive-key-sort-json-v1-preserve-array-order",
      compatibilityAliases: ["raw_messages"],
      whenCanonicalAndAliasPresent: "parse-normalize-and-require-deep-equality",
      onConflict: "fail-closed",
      conflictError: "CANONICAL_INPUT_CONFLICT",
      dictionaryMayContainValues: false,
    });
    assert.deepEqual(
      profile.tools.validate_requirement.properties.raw_messages_json,
      {
        type: "string",
        minLength: 1,
        contentMediaType: "application/json",
        contentSchema: {
          $ref: "schemas/requirement-record.schema.json#/properties/raw_messages_json",
        },
      },
    );
    assert.equal(canonicalDigest(requirements), REQUIREMENTS_CONTRACT_HASH);
  });

  it("locks budget, rebate, three deadlines, and single-platform splitting", async () => {
    const [requirements, profile] = await Promise.all([
      loadSpec(REQUIREMENTS_SPEC),
      loadSpec(V2_PROFILE),
    ]);
    const { budget, rebate, deadlines, platformSplit } = requirements.valuePolicies;

    assert.deepEqual(
      [budget.lowerBoundField, budget.upperBoundField, budget.type, budget.unit],
      ["budget_min_cents", "budget_max_cents", "integer", "CNY-cent"],
    );
    assert.equal(budget.minimum, 0);
    assert.equal(budget.boundsRequired, true);
    assert.equal(budget.ordering, "lower <= upper");
    assert.equal(budget.onViolation, "VALUE_RANGE_INVALID");

    assert.deepEqual(
      [rebate.lowerBoundField, rebate.upperBoundField, rebate.type, rebate.unit],
      ["rebate_min_rate", "rebate_max_rate", "number", "fraction"],
    );
    assert.equal(rebate.minimum, 0);
    assert.equal(rebate.maximum, 1);
    assert.equal(rebate.boundsRequired, true);
    assert.equal(rebate.ordering, "lower <= upper");

    assert.equal(deadlines.timezoneRequired, true);
    assert.equal(deadlines.types.length, 3);
    assert.deepEqual(
      deadlines.types.map(({ name }) => name),
      [
        "supplier_response_deadline_at",
        "client_submission_deadline_at",
        "content_publish_deadline_at",
      ],
    );
    assert.deepEqual(deadlines.ordering, [
      "supplier_response_deadline_at <= client_submission_deadline_at",
      "client_submission_deadline_at <= content_publish_deadline_at",
    ]);
    assert.deepEqual(
      deadlines.compatibilityInputs.map(({ field, mapsTo }) => ({ field, mapsTo })),
      [
        {
          field: "submission_deadline_at",
          mapsTo: "client_submission_deadline_at",
        },
        {
          field: "submission_deadline_raw",
          mapsTo: "client_submission_deadline_at",
        },
      ],
    );
    assert.equal(deadlines.compatibilityConflictBehavior, "fail-closed");
    assert.equal(deadlines.compatibilityConflictError, "DEADLINE_ORDER_INVALID");
    for (const { name } of deadlines.types) {
      assert.equal(profile.tools.validate_requirement.properties[name].format, "date-time");
    }
    assert.equal(deadlines.onViolation, "DEADLINE_ORDER_INVALID");

    assert.equal(platformSplit.headEntity, "requirement_headers");
    assert.equal(platformSplit.executionEntity, "customer_demands");
    assert.equal(platformSplit.executionUnitPlatformCardinality, 1);
    assert.equal(
      platformSplit.multiPlatformBehavior,
      "one-child-requirement-per-platform-under-one-head",
    );
    assert.equal(platformSplit.crossPlatformExecutionAllowed, false);
  });

  it("defines a closed constraint grammar and exact join gate", async () => {
    const [requirements, dictionary, constraintSchema, profile] = await Promise.all([
      loadSpec(REQUIREMENTS_SPEC),
      loadSpec(REQUIREMENT_DICTIONARY_SPEC),
      loadSchema("constraint-expression.schema.json"),
      loadSpec(V2_PROFILE),
    ]);
    const grammar = requirements.processingPolicies.constraintGrammar;
    const joinGate = requirements.processingPolicies.joinGate;

    assert.deepEqual(grammar.rootKinds, [
      "all",
      "any",
      "not",
      "comparison",
      "range",
      "set",
    ]);
    assert.equal(grammar.unknownOperatorBehavior, "fail-closed");
    assert.equal(grammar.unknownFieldBehavior, "fail-closed");
    assert.equal(grammar.onViolation, "CONSTRAINT_GRAMMAR_INVALID");
    assert.equal(
      grammar.fieldVocabulary.source,
      "requirement-dictionary.json#definitions",
    );
    assert.equal(grammar.fieldVocabulary.membership, "exact-key-match");
    const resolvedFields = Object.entries(dictionary.definitions)
      .filter(([, definition]) =>
        grammar.fieldVocabulary.allowedClassifications.includes(
          definition.classification,
        )
      )
      .map(([name]) => name);
    assert.ok(resolvedFields.length > 0);
    assert.deepEqual(profile.tools.validate_requirement.properties.constraints, {
      type: "array",
      items: { $ref: "schemas/constraint-expression.schema.json" },
    });
    assert.deepEqual(
      constraintSchema.$defs.expression.oneOf
        .map(({ $ref }) => $ref.split("/").at(-1))
        .sort(),
      [...grammar.rootKinds].sort(),
    );

    assert.deepEqual(joinGate.joins.map(({ id }) => id), [
      "requirement-dictionary",
      "selection-snapshot",
      "offer-supplier-binding",
      "send-selection",
    ]);
    assert.equal(joinGate.missingBehavior, "fail-closed");
    assert.equal(joinGate.ambiguousBehavior, "fail-closed");
    assert.equal(joinGate.missingOrAmbiguousError, "JOIN_GATE_FAILED");
    assert.equal(joinGate.scopeError, "SCOPE_MISMATCH");
  });

  it("freezes late data and versions offer promotion", async () => {
    const requirements = await loadSpec(REQUIREMENTS_SPEC);
    const { lateData, offerPromotion } = requirements.processingPolicies;

    assert.deepEqual(lateData.requiredLineageFields, [
      "observed_at",
      "effective_at",
      "received_at",
      "as_of_at",
      "late_data_cutoff_at",
      "is_late",
      "late_reason",
    ]);
    assert.equal(lateData.classification, "received_at > late_data_cutoff_at");
    assert.equal(lateData.mutationOfFrozenArtifactAllowed, false);
    assert.equal(lateData.onForbiddenMutation, "LATE_DATA_REJECTED");

    assert.deepEqual(offerPromotion.states, [
      "candidate",
      "validated",
      "promoted",
      "rejected",
      "superseded",
    ]);
    assert.equal(offerPromotion.promotionFrom, "validated");
    assert.equal(offerPromotion.promotionTo, "promoted");
    assert.equal(
      offerPromotion.writeMode,
      "append-new-offer-revision-and-audit-event",
    );
    assert.equal(offerPromotion.overwriteActiveOfferAllowed, false);
    assert.deepEqual(offerPromotion.idempotencyKey, [
      "source_type",
      "source_record_id",
      "scope_type",
      "scope_id",
    ]);
    assert.equal(offerPromotion.onConflict, "OFFER_PROMOTION_CONFLICT");
  });

  it("keeps algorithm, deployment, legacy, and production readiness boundaries closed", async () => {
    const requirements = await loadSpec(REQUIREMENTS_SPEC);

    assert.equal(requirements.governance.algorithmContract, "algorithms.json");
    assert.equal(requirements.governance.algorithmReadinessRequiredForProduction, true);
    assert.equal(requirements.governance.databaseDeploymentStatus, "external-unverified");
    assert.equal(requirements.governance.legacyProfileCapability, "detection-only");
    assert.equal(requirements.governance.productionReadiness, "NO-GO");
    assert.deepEqual(requirements.governance.doesNotDefine, [
      "creator-ranking-weight",
      "mcn-ranking-weight",
      "recall-formula",
      "scoring-threshold",
    ]);
  });
});

describe("legacy-1.9.4 detection profile", () => {
  it("records exactly the observed target tools and three target gaps", async () => {
    const profile = await loadSpec(LEGACY_PROFILE);

    assert.equal(profile.schemaVersion, 1);
    assert.equal(profile.profile, "legacy-1.9.4");
    assert.equal(profile.targetProfile, "mvp-v2");
    assert.equal(profile.sourceFidelity, "observed-summary");
    assert.equal(profile.retainedRawSnapshot, false);
    assert.deepEqual(profile.missingTargetTools, LEGACY_MISSING_TARGET_TOOLS);
    assert.deepEqual(profile.observedSummary.toolNames, LEGACY_TOOL_NAMES);
    assert.deepEqual(
      Object.keys(profile.observedSummary.tools),
      LEGACY_TOOL_NAMES,
    );
    assert.deepEqual(
      REQUIRED_TOOLS.filter((name) => !LEGACY_TOOL_NAMES.includes(name)).sort(),
      [...LEGACY_MISSING_TARGET_TOOLS].sort(),
    );
  });

  it("preserves required old identifiers and other observed payload signals", async () => {
    const profile = await loadSpec(LEGACY_PROFILE);
    const { tools } = profile.observedSummary;

    for (const [name, required] of Object.entries(LEGACY_REQUIRED_FIELDS)) {
      assert.deepEqual(tools[name].required, required, `${name} required drifted`);
      for (const field of required) {
        assert.ok(
          Object.hasOwn(tools[name].properties, field),
          `${name} omits required property ${field}`,
        );
      }
      assert.deepEqual(
        Object.fromEntries(
          Object.entries(tools[name].properties).map(([property, schema]) => [
            property,
            schema.type,
          ]),
        ),
        LEGACY_PROPERTY_TYPES[name],
        `${name} properties drifted`,
      );
    }

    for (const name of [
      "search_creators",
      "rank_mcns",
      "manual_source_creators",
      "rank_creators",
    ]) {
      assert.equal(tools[name].properties.demand_id.type, "string");
      assert.equal(tools[name].properties.demand_version.type, "integer");
    }

    assert.equal(
      tools.ingest_mcn_submissions.properties.inquiry_id.type,
      "string",
    );
    assert.equal(tools.ingest_mcn_submissions.properties.items.type, "array");
    assert.equal(
      tools.create_submission_batch.properties.allow_need_confirm_with_risk
        .type,
      "boolean",
    );
    assert.ok(
      !tools.create_submission_batch.required.includes(
        "allow_need_confirm_with_risk",
      ),
    );
  });

  it("cannot authorize execution, writers, writable selection, or fallback", async () => {
    const [legacy, v2] = await Promise.all([
      loadSpec(LEGACY_PROFILE),
      loadSpec(V2_PROFILE),
    ]);

    assert.equal(legacy.mode, "detection-only");
    assert.equal(legacy.writable, false);
    assert.equal(legacy.automaticFallback, false);
    for (const [name, tool] of Object.entries(legacy.observedSummary.tools)) {
      assert.equal(tool.capability, "detection-only", `${name} is executable`);
      assert.equal(tool.executable, false, `${name} is executable`);
      assert.equal(
        tool.writerAuthorization,
        "none",
        `${name} grants writer authorization`,
      );
      assert.deepEqual(tool.writers, { always: [], conditional: [] });
    }

    const writableProfiles = [legacy, v2]
      .filter(
        (profile) => profile.mode === "writable" && profile.writable !== false,
      )
      .map((profile) => profile.profile);
    assert.deepEqual(writableProfiles, ["mvp-v2"]);
  });

  it("reproduces the declared SHA-256 from the canonical observed summary", async () => {
    const profile = await loadSpec(LEGACY_PROFILE);

    assert.equal(profile.schemaHashScope, "observedSummary");
    assert.equal(profile.schemaHashAlgorithm, "sha256");
    assert.equal(
      profile.schemaHashCanonicalization,
      "recursive-key-sort-json-v1",
    );
    assert.match(profile.schemaHash, /^[a-f0-9]{64}$/);

    const canonicalSummary = canonicalizeJson(profile.observedSummary);
    const reproducedHash = createHash("sha256")
      .update(canonicalSummary, "utf8")
      .digest("hex");
    assert.equal(reproducedHash, profile.schemaHash);
  });
});

describe("workflow contract", () => {
  it("declares the exact approved phases, statuses, actions, and digest", async () => {
    const workflow = await loadSpec(WORKFLOW_SPEC);

    assert.equal(workflow.schemaVersion, 1);
    assert.equal(workflow.profile, "mvp-v2");
    assert.deepEqual(workflow.phases, WORKFLOW_PHASES);
    assert.deepEqual(workflow.lifecycleStatuses, LIFECYCLE_STATUSES);
    assert.deepEqual(workflow.responseStatuses, RESPONSE_STATUSES);
    assert.deepEqual(workflow.allowedActions, [
      "validate_requirement",
      "search_creators",
      "rank_mcns",
      "select_inquiry_form_fields",
      "create_with_distributions",
      "refresh_recovery",
      "request_recovery",
      "finalize_recovery",
      "rank_creators",
      "create_submission_batch",
      "record_client_feedback",
    ]);
    assertWorkflowContract(workflow);
  });

  it("makes persisted server state and allowed_actions authoritative", async () => {
    const workflow = await loadSpec(WORKFLOW_SPEC);

    assert.deepEqual(workflow.stateAuthority, {
      source: "provider-persisted-workflow-state",
      schema: "schemas/workflow-state.schema.json",
      stateVersionRequired: true,
      allowedActionsRequired: true,
      allowedActionsAreClosedWorld: true,
      readActionsAlwaysAllowed: ["get_workflow_state"],
      hookSessionContextAuthoritative: false,
      hookSessionContextMayGrantActions: false,
      hookSessionContextMayDenyForAdditionalSafety: true,
      missingOrUnknownCombinationBehavior: "fail-closed",
      missingOrUnknownCombinationError: "STATE_COMBINATION_INVALID",
      staleStateVersionError: "STATE_CONFLICT",
    });
    assert.equal(workflow.policies.ordinaryMessageUnlocksWaiting, false);
    assert.equal(
      workflow.policies.manualRecoveryConfirmation,
      "recorded-by-server-before-action-is-allowed",
    );
    assert.equal(
      workflow.policies.scheduledRecoveryContext,
      "audit-origin-only-not-authorization",
    );
    assertRecoveryGraphSemantics(workflow);
  });

  it("uses every tool profile's complete success evidence exactly", async () => {
    const [workflow, profile] = await Promise.all([
      loadSpec(WORKFLOW_SPEC),
      loadSpec(V2_PROFILE),
    ]);

    for (const transition of workflow.transitions) {
      const tool = profile.tools[transition.trigger.name];
      assert.ok(tool, `${transition.id} references an unknown tool`);
      assert.deepEqual(
        transition.evidence,
        tool.successEvidence,
        `${transition.id} evidence drifted from ${tool.name}`,
      );
    }
  });

  it("advances a requirement draft only when validation is ready and server-authorized", async () => {
    const workflow = await loadSpec(WORKFLOW_SPEC);
    const transition = workflow.transitions.find(
      ({ id }) => id === "requirement-validated",
    );
    const context = {
      requiredDemandFieldsPresent: true,
      allowedGuards: new Set([
        "authoritative.allowed_actions includes validate_requirement",
      ]),
    };

    assert.equal(
      transitionApplies(transition, { ...context, requirementStatus: "draft" }),
      false,
    );
    assert.equal(
      transitionApplies(transition, { ...context, requirementStatus: "ready" }),
      true,
    );
    assert.equal(
      transitionApplies(transition, {
        requiredDemandFieldsPresent: true,
        requirementStatus: "ready",
        allowedGuards: new Set(),
      }),
      false,
    );
  });

  it("splits recovery into refresh, request, and finalize without event authorization", async () => {
    const workflow = await loadSpec(WORKFLOW_SPEC);

    assert.deepEqual(workflow.policies.recoverySequence, [
      "refresh",
      "request",
      "finalize",
    ]);
    assert.deepEqual(workflow.policies.recoveryToolSequence, [
      "sync_mcn_inquiry_status",
      "ingest_mcn_submissions",
      "sync_mcn_inquiry_status",
    ]);
    assertRecoveryGraphSemantics(workflow);
  });

  it("keeps terminal recovery as a server-authoritative refresh no-op", async () => {
    const workflow = await loadSpec(WORKFLOW_SPEC);
    const transition = workflow.transitions.find(
      ({ id }) => id === "terminal-recovery-refresh-no-op",
    );

    assert.equal(transition.trigger.type, "tool");
    assert.equal(transition.trigger.name, "sync_mcn_inquiry_status");
    assert.equal(transition.from, "recovered");
    assert.equal(transition.nextPhase, "recovered");
    for (const lifecycleStatus of ["recovered", "closed"]) {
      assert.equal(
        evaluateWorkflowGuard(
          "authoritative.lifecycle_status in [recovered, closed]",
          { lifecycleStatus },
        ),
        true,
      );
    }
  });

  it("declares a closed state-combination matrix for every phase", async () => {
    const workflow = await loadSpec(WORKFLOW_SPEC);
    const actionSet = new Set(workflow.allowedActions);

    assert.equal(
      new Set(workflow.stateCombinations.map(({ id }) => id)).size,
      workflow.stateCombinations.length,
    );
    assert.deepEqual(
      [...new Set(workflow.stateCombinations.map(({ phase }) => phase))].sort(),
      [...workflow.phases].sort(),
    );
    for (const combination of workflow.stateCombinations) {
      assert.ok(combination.lifecycleStatuses.length > 0);
      assert.ok(combination.responseStatuses.length > 0);
      assert.equal(typeof combination.terminal, "boolean");
      for (const action of combination.allowedActions) {
        assert.equal(actionSet.has(action), true, `${combination.id} uses ${action}`);
      }
      if (combination.terminal) assert.deepEqual(combination.allowedActions, []);
    }
    const recovered = workflow.stateCombinations.find(
      ({ id }) => id === "recovered-for-ranking",
    );
    assert.equal(recovered.terminal, false);
    assert.deepEqual(recovered.allowedActions, ["refresh_recovery", "rank_creators"]);
    const blocked = workflow.stateCombinations.find(({ id }) => id === "blocked");
    assert.deepEqual(blocked.allowedActions, []);
  });

  it("detects transition, authority, operation, and state-matrix mutations", async () => {
    const workflow = await loadSpec(WORKFLOW_SPEC);
    const mutationCases = [
      (mutated) => {
        mutated.transitions.find(
          ({ id }) => id === "first-distribution-refresh",
        ).nextPhase = "recovered";
      },
      (mutated) => {
        mutated.stateAuthority.hookSessionContextMayGrantActions = true;
      },
      (mutated) => {
        mutated.recoveryOperations[1].sessionContextRequired = true;
      },
      (mutated) => {
        mutated.stateCombinations.find(
          ({ id }) => id === "recovery-requestable",
        ).allowedActions = ["finalize_recovery"];
      },
    ];

    for (const mutate of mutationCases) {
      const mutated = structuredClone(workflow);
      mutate(mutated);
      assert.throws(
        () => assertWorkflowContract(mutated),
        /workflow contract drifted/,
      );
    }
  });

  it("rejects unrecognized lifecycle predicates instead of failing open", () => {
    assert.throws(
      () =>
        evaluateWorkflowGuard(
          "result.data.lifecycle_status excludes [recovered, closed]",
          { lifecycleStatus: "recovered" },
        ),
      /Unrecognized lifecycle predicate/,
    );
  });
});

describe("database boundary contract", () => {
  it("assigns the exact writer set for every target tool", async () => {
    const database = await loadSpec(DATABASE_SPEC);

    assert.deepEqual(database.writerOwnership, DATABASE_WRITER_OWNERSHIP);
    const inquiryWriters = database.writerOwnership
      .filter(({ always, conditional }) =>
        [...always, ...conditional].includes("mcn_inquiries"),
      )
      .map(({ tool }) => tool);
    assert.deepEqual(inquiryWriters, ["sync_mcn_inquiry_status"]);
    assert.deepEqual(
      database.writerOwnership.find(
        ({ tool }) => tool === "sync_mcn_inquiry_status",
      ),
      {
        tool: "sync_mcn_inquiry_status",
        always: ["mcn_inquiries"],
        conditional: ["mcn_inquiry_field_snapshots"],
      },
    );
  });

  it("keeps sync writer ownership aligned with the writable profile", async () => {
    const [database, profile] = await Promise.all([
      loadSpec(DATABASE_SPEC),
      loadSpec(V2_PROFILE),
    ]);
    const databaseOwnership = database.writerOwnership.find(
      ({ tool }) => tool === "sync_mcn_inquiry_status",
    );

    assert.deepEqual(profile.tools.sync_mcn_inquiry_status.writers, {
      always: databaseOwnership.always,
      conditional: databaseOwnership.conditional,
    });
  });

  it("declares every external invariant without claiming deployment proof", async () => {
    const database = await loadSpec(DATABASE_SPEC);

    assert.equal(database.readinessStatus, "external-unverified");
    assert.equal(database.modelStatus, "target-contract-external-unverified");
    assert.deepEqual(database.proofBoundary, DATABASE_PROOF_BOUNDARY);
    assert.deepEqual(
      database.invariants.map(({ id }) => id),
      [
        "unique-supplier-mapping",
        "single-send-context",
        "stable-provider-correlation",
        "atomic-first-sync",
        "unique-provider-references",
        "idempotent-submission-ingest",
        "single-recovery-owner",
        "accepted-source-merge-priority",
        "submission-batch-retry",
        "requirement-dictionary-snapshot-binding",
        "single-platform-execution-unit",
        "immutable-snapshot-and-audit-lineage",
        "late-data-does-not-mutate-frozen-results",
        "offer-promotion-is-versioned-and-idempotent",
      ],
    );
    for (const invariant of database.invariants) {
      assert.equal(invariant.status, "external-unverified");
      assert.equal(typeof invariant.owner, "string");
      assert.ok(invariant.owner.length > 0);
      assert.ok(invariant.evidence.length > 0);
    }
    assertDatabaseContract(database);
  });

  it("declares aggregate, multi-offer, binding, send, selection, and audit entities", async () => {
    const database = await loadSpec(DATABASE_SPEC);
    const expectedEntities = [
      "creator_supply_offers",
      "customer_demands",
      "feedback_audit_events",
      "offer_promotion_events",
      "requirement_headers",
      "requirement_snapshots",
      "risk_audit_events",
      "selection_results",
      "send_operations",
      "supplier_bindings",
    ];

    assert.deepEqual(Object.keys(database.entities).sort(), expectedEntities);
    assert.equal(database.entities.requirement_headers.role, "aggregate-head");
    assert.equal(
      database.entities.creator_supply_offers.cardinality,
      "zero-or-many-per-creator",
    );
    assert.equal(
      database.entities.supplier_bindings.role,
      "provider-supplier-to-mcn-binding",
    );
    assert.equal(
      database.entities.send_operations.role,
      "idempotent-provider-send-operation",
    );
    assert.equal(
      database.entities.selection_results.role,
      "persisted-ordered-field-selection",
    );
    for (const name of [
      "risk_audit_events",
      "feedback_audit_events",
      "offer_promotion_events",
    ]) {
      assert.equal(database.entities[name].appendOnly, true, name);
    }
    for (const [name, entity] of Object.entries(database.entities)) {
      assert.ok(entity.requiredFields.includes("scope_type"), name);
      assert.ok(entity.requiredFields.includes("scope_id"), name);
      assert.ok(entity.recordSchema.startsWith("schemas/"), name);
      assert.ok(entity.uniqueKeys.length > 0, name);
      assert.ok(
        entity.uniqueKeys.some(
          ({ columns }) => JSON.stringify(columns) === JSON.stringify(entity.primaryKey),
        ),
        `${name} lacks a physical primary-key uniqueness constraint`,
      );
      for (const key of entity.uniqueKeys) {
        assert.equal(key.nullsAllowed, false, key.id);
        assert.equal(key.status, "external-unverified", key.id);
      }
    }

    const offer = database.entities.creator_supply_offers;
    for (const field of database.commonFieldPolicies.lateDataFields) {
      assert.ok(offer.requiredFields.includes(field), field);
    }
    for (const name of [
      "requirement_headers",
      "customer_demands",
      "requirement_snapshots",
      "selection_results",
    ]) {
      for (const field of database.commonFieldPolicies.dictionaryReferenceFields) {
        assert.ok(database.entities[name].requiredFields.includes(field), `${name}.${field}`);
      }
    }
    assertDatabaseContract(database);
  });

  it("detects a mutation to an external database invariant", async () => {
    const database = await loadSpec(DATABASE_SPEC);
    const mutated = structuredClone(database);
    mutated.invariants.find(
      ({ id }) => id === "single-recovery-owner",
    ).status = "verified";

    assert.throws(
      () => assertDatabaseContract(mutated),
      /database contract drifted/,
    );
  });

  it("detects removal of the sync-owned field snapshot writer", async () => {
    const database = await loadSpec(DATABASE_SPEC);
    assertDatabaseContract(database);

    const mutated = structuredClone(database);
    mutated.writerOwnership.find(
      ({ tool }) => tool === "sync_mcn_inquiry_status",
    ).conditional = [];
    assert.throws(
      () => assertDatabaseContract(mutated),
      /database contract drifted/,
    );
  });
});

describe("error semantics contract", () => {
  it("declares the exact unique code set and recovery semantics", async () => {
    const errors = await loadSpec(ERRORS_SPEC);

    assert.deepEqual(errors.codes, ERROR_CODES);
    assert.equal(new Set(errors.codes).size, errors.codes.length);
    assert.deepEqual(
      errors.errors.map(({ code }) => code),
      ERROR_CODES,
    );
    assertErrorsContract(errors);
  });

  it("covers every contract-closure fail-closed condition", async () => {
    const errors = await loadSpec(ERRORS_SPEC);
    const newCodes = [
      "CANONICAL_INPUT_CONFLICT",
      "DICTIONARY_REFERENCE_MISMATCH",
      "VALUE_RANGE_INVALID",
      "DEADLINE_ORDER_INVALID",
      "CONSTRAINT_GRAMMAR_INVALID",
      "JOIN_GATE_FAILED",
      "SCOPE_MISMATCH",
      "LATE_DATA_REJECTED",
      "OFFER_PROMOTION_CONFLICT",
      "SELECTION_RESULT_STALE",
      "STATE_COMBINATION_INVALID",
    ];

    for (const code of newCodes) {
      const error = errors.errors.find((candidate) => candidate.code === code);
      assert.ok(error, code);
      assert.equal(error.retryable, false, code);
      assert.equal(error.blindRetry, false, code);
      assert.equal(error.retryPolicy.directRetry, false, code);
      assert.equal(typeof error.recoveryAction, "string", code);
      assert.ok(error.recoveryAction.length > 0, code);
    }
    for (const code of [
      "DICTIONARY_REFERENCE_MISMATCH",
      "JOIN_GATE_FAILED",
      "SCOPE_MISMATCH",
      "LATE_DATA_REJECTED",
      "OFFER_PROMOTION_CONFLICT",
      "SELECTION_RESULT_STALE",
      "STATE_COMBINATION_INVALID",
    ]) {
      const error = errors.errors.find((candidate) => candidate.code === code);
      assert.equal(error.retryPolicy.authoritativeReconciliationRequired, true, code);
      assert.equal(typeof error.retryPolicy.reconcileWith, "string", code);
    }
    assertErrorsContract(errors);
  });

  it("never blind-retries writes and distinguishes conflict reconciliation", async () => {
    const errors = await loadSpec(ERRORS_SPEC);

    for (const error of errors.errors.filter(({ writeRelated }) => writeRelated)) {
      assert.equal(error.blindRetry, false, `${error.code} permits blind retry`);
      assert.equal(
        error.retryPolicy.directRetry,
        false,
        `${error.code} permits a direct retry`,
      );
    }

    const stateConflict = errors.errors.find(
      ({ code }) => code === "STATE_CONFLICT",
    );
    assert.equal(stateConflict.retryable, false);
    assert.equal(
      stateConflict.retryPolicy.mode,
      "reconcile-then-conditional-retry",
    );
    assert.equal(
      stateConflict.retryPolicy.conditionalRetryAfterReconciliation,
      true,
    );
    assert.equal(
      stateConflict.retryPolicy.authoritativeReconciliationRequired,
      true,
    );

    const unknownWrite = errors.errors.find(
      ({ code }) => code === "WRITE_RESULT_UNKNOWN",
    );
    assert.equal(unknownWrite.retryable, false);
    assert.equal(unknownWrite.retryPolicy.mode, "reconcile-only");
    assert.equal(unknownWrite.retryPolicy.directRetry, false);
    assert.equal(
      unknownWrite.retryPolicy.authoritativeReconciliationRequired,
      true,
    );
    assert.equal(
      unknownWrite.retryPolicy.reconcileWith,
      "query-or-sync-write-result",
    );

    const recoveryNotConfirmed = errors.errors.find(
      ({ code }) => code === "RECOVERY_NOT_CONFIRMED",
    );
    assert.doesNotMatch(recoveryNotConfirmed.message, /session/i);
    assert.equal(
      recoveryNotConfirmed.retryPolicy.authoritativeReconciliationRequired,
      true,
    );
    assert.equal(
      recoveryNotConfirmed.retryPolicy.reconcileWith,
      "get_workflow_state",
    );
  });

  it("detects a mutation to an error retry policy", async () => {
    const errors = await loadSpec(ERRORS_SPEC);
    const mutated = structuredClone(errors);
    mutated.errors.find(
      ({ code }) => code === "WRITE_RESULT_UNKNOWN",
    ).retryPolicy.directRetry = true;

    assert.throws(
      () => assertErrorsContract(mutated),
      /errors contract drifted/,
    );
  });
});
