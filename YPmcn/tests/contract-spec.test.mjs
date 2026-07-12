import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const V2_PROFILE = "mcp.json";
const LEGACY_PROFILE = "profiles/legacy-1.9.4.json";
const WORKFLOW_SPEC = "workflow.json";
const DATABASE_SPEC = "database.json";
const ERRORS_SPEC = "errors.json";
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

const WORKFLOW_POLICIES = {
  sendSuccessPhase: "distribution_sync_pending",
  waitingReturnRequires: "first-successful-sync",
  ordinaryMessageUnlocksWaiting: false,
  manualRecoveryConfirmation: "explicit-current-session-confirmation",
  scheduledRecoveryContext: "ctx.trigger=cron",
  recoverySequence: [
    "sync_mcn_inquiry_status",
    "ingest_mcn_submissions",
    "sync_mcn_inquiry_status",
  ],
  rankingAllowedAfterPhase: "recovered",
  terminalRecovery: {
    authoritativeLifecycleStatuses: ["recovered", "closed"],
    behavior: "no-op",
    sideEffectsAllowed: false,
    evidence: [
      "error.code === RECOVERY_ALREADY_TERMINAL",
      "no-write-tool-invoked",
    ],
  },
};

const WORKFLOW_TRANSITIONS = [
  {
    id: "requirement-validated",
    from: "requirement_draft",
    trigger: { type: "tool", name: "validate_requirement" },
    guards: [
      "required-demand-fields-present",
      "result.data.status === ready",
    ],
    evidence: [
      "success === true",
      "data.id",
      "data.status",
    ],
    nextPhase: "requirement_ready",
  },
  {
    id: "candidate-pool-written",
    from: "requirement_ready",
    trigger: { type: "tool", name: "search_creators" },
    guards: ["params.requirement_id === state.requirement_id"],
    evidence: [
      "success === true",
      "data.id",
      "data.candidate_pool_written",
    ],
    nextPhase: "candidate_pool_ready",
  },
  {
    id: "mcn-plan-written",
    from: "candidate_pool_ready",
    trigger: { type: "tool", name: "rank_mcns" },
    guards: ["params.candidate_pool_id === state.candidate_pool_id"],
    evidence: [
      "success === true",
      "data.id",
      "data.inquiry_advice",
    ],
    nextPhase: "mcn_planning",
  },
  {
    id: "inquiry-fields-selected",
    from: "mcn_planning",
    trigger: { type: "tool", name: "select_inquiry_form_fields" },
    guards: [
      "params.mcn_recommendation_id === state.mcn_recommendation_id",
    ],
    evidence: [
      "success === true",
      "fields",
      "items",
      "selected_count === items.length",
      "selected_count > 0",
    ],
    nextPhase: "field_selection_ready",
  },
  {
    id: "distribution-sent",
    from: "field_selection_ready",
    trigger: { type: "tool", name: "create_with_distributions" },
    guards: [
      "supply-mcn-message-confirmations-present",
      "field-selection-matches-ordered-columns",
      "params.preview_only === false",
    ],
    evidence: [
      "success === true",
      "data.provider_project_id",
      "data.distribution_batch_ref",
      "data.distributions.length > 0",
    ],
    nextPhase: "distribution_sync_pending",
  },
  {
    id: "first-distribution-sync",
    from: "distribution_sync_pending",
    trigger: { type: "tool", name: "sync_mcn_inquiry_status" },
    guards: [
      "params.mcn_recommendation_id === state.mcn_recommendation_id",
      "params.requirement_id === state.requirement_id",
    ],
    evidence: [
      "success === true",
      "data.inquiry_batch_id",
      "data.inquiry_ids",
      "data.snapshot_id",
      "data.lifecycle_status",
      "data.response_status",
    ],
    nextPhase: "waiting_return",
  },
  {
    id: "manual-recovery-confirmed",
    from: "waiting_return",
    trigger: { type: "event", name: "manual_recovery_confirmed" },
    guards: ["explicit-recovery-intent-in-current-session"],
    evidence: ["state.manual_recovery_confirmed_at"],
    nextPhase: "waiting_return",
  },
  {
    id: "manual-recovery-sync",
    from: "waiting_return",
    trigger: { type: "tool", name: "sync_mcn_inquiry_status" },
    guards: [
      "state.manual_recovery_confirmed_at-is-current",
      "ctx.recovery_trigger === manual",
      "result.data.lifecycle_status not in [recovered, closed]",
    ],
    evidence: [
      "success === true",
      "data.inquiry_batch_id",
      "data.inquiry_ids",
      "data.snapshot_id",
      "data.lifecycle_status",
      "data.response_status",
    ],
    nextPhase: "recovering",
  },
  {
    id: "scheduled-recovery-sync",
    from: "waiting_return",
    trigger: { type: "tool", name: "sync_mcn_inquiry_status" },
    guards: [
      "ctx.trigger === cron",
      "result.data.lifecycle_status not in [recovered, closed]",
    ],
    evidence: [
      "success === true",
      "data.inquiry_batch_id",
      "data.inquiry_ids",
      "data.snapshot_id",
      "data.lifecycle_status",
      "data.response_status",
    ],
    nextPhase: "recovering",
  },
  {
    id: "manual-terminal-reconciliation",
    from: "waiting_return",
    trigger: { type: "tool", name: "sync_mcn_inquiry_status" },
    guards: [
      "state.manual_recovery_confirmed_at-is-current",
      "ctx.recovery_trigger === manual",
      "result.data.lifecycle_status in [recovered, closed]",
    ],
    evidence: [
      "success === true",
      "data.inquiry_batch_id",
      "data.inquiry_ids",
      "data.snapshot_id",
      "data.lifecycle_status",
      "data.response_status",
    ],
    nextPhase: "recovered",
  },
  {
    id: "scheduled-terminal-reconciliation",
    from: "waiting_return",
    trigger: { type: "tool", name: "sync_mcn_inquiry_status" },
    guards: [
      "ctx.trigger === cron",
      "result.data.lifecycle_status in [recovered, closed]",
    ],
    evidence: [
      "success === true",
      "data.inquiry_batch_id",
      "data.inquiry_ids",
      "data.snapshot_id",
      "data.lifecycle_status",
      "data.response_status",
    ],
    nextPhase: "recovered",
  },
  {
    id: "manual-submission-ingest",
    from: "recovering",
    trigger: { type: "tool", name: "ingest_mcn_submissions" },
    guards: [
      "params.trigger === manual",
      "state.manual_recovery_confirmed_at-is-current",
      "current-session-successful-sync-evidence-present",
    ],
    evidence: [
      "success === true",
      "data.id",
      "data.accepted_count",
      "data.rejected_count",
      "data.created_submission_item_count",
    ],
    nextPhase: "recovery_sync_pending",
  },
  {
    id: "scheduled-submission-ingest",
    from: "recovering",
    trigger: { type: "tool", name: "ingest_mcn_submissions" },
    guards: [
      "params.trigger === scheduled",
      "ctx.trigger === cron",
      "current-session-successful-sync-evidence-present",
    ],
    evidence: [
      "success === true",
      "data.id",
      "data.accepted_count",
      "data.rejected_count",
      "data.created_submission_item_count",
    ],
    nextPhase: "recovery_sync_pending",
  },
  {
    id: "recovery-final-sync",
    from: "recovery_sync_pending",
    trigger: { type: "tool", name: "sync_mcn_inquiry_status" },
    guards: [
      "current-session-successful-ingest-evidence-present",
      "result.data.lifecycle_status === recovered",
    ],
    evidence: [
      "success === true",
      "data.inquiry_batch_id",
      "data.inquiry_ids",
      "data.snapshot_id",
      "data.lifecycle_status",
      "data.response_status",
    ],
    nextPhase: "recovered",
  },
  {
    id: "terminal-recovery-no-op",
    from: "recovered",
    trigger: { type: "event", name: "recovery_requested" },
    guards: ["authoritative-lifecycle-status in [recovered, closed]"],
    evidence: [
      "error.code === RECOVERY_ALREADY_TERMINAL",
      "no-write-tool-invoked",
    ],
    nextPhase: "recovered",
  },
  {
    id: "creators-ranked",
    from: "recovered",
    trigger: { type: "tool", name: "rank_creators" },
    guards: ["latest-authoritative-sync-lifecycle-status === recovered"],
    evidence: [
      "success === true",
      "data.run_id",
      "data.ranked_count",
    ],
    nextPhase: "recommendation_ready",
  },
  {
    id: "submission-batch-created",
    from: "recommendation_ready",
    trigger: { type: "tool", name: "create_submission_batch" },
    guards: ["params.run_id === state.run_id"],
    evidence: [
      "success === true",
      "data.id",
      "data.batch_no",
      "data.submitted_count",
    ],
    nextPhase: "submission_batch_ready",
  },
  {
    id: "client-feedback-recorded",
    from: "submission_batch_ready",
    trigger: { type: "tool", name: "record_client_feedback" },
    guards: ["params.run_id === state.run_id"],
    evidence: [
      "success === true",
      "data.updated_count",
      "data.next_action",
    ],
    nextPhase: "feedback_routing",
  },
];

const DATABASE_WRITER_OWNERSHIP = [
  {
    tool: "validate_requirement",
    always: ["customer_demands"],
    conditional: [],
  },
  {
    tool: "search_creators",
    always: ["creator_candidate_pool"],
    conditional: [],
  },
  {
    tool: "rank_mcns",
    always: ["mcn_recommendation_items"],
    conditional: [],
  },
  {
    tool: "select_inquiry_form_fields",
    always: [],
    conditional: [],
  },
  {
    tool: "create_with_distributions",
    always: [],
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
    conditional: ["creator_supply_offers"],
  },
  {
    tool: "manual_source_creators",
    always: ["manual_sourced_creators"],
    conditional: ["creator_supply_offers"],
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
    conditional: ["customer_demands"],
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
    always: ["creator_recommendation_items"],
    conditional: ["creator_submissions"],
  },
  {
    tool: "get_workflow_state",
    always: [],
    conditional: [],
  },
];

const DATABASE_INVARIANTS = [
  {
    id: "unique-supplier-mapping",
    requirement:
      "mcn_agencies.supplier_id is nonempty and unique, providing one supplier_id for each targeted mcn_id",
    owner: "production-database",
    evidence: [
      "unique constraint on mcn_agencies.supplier_id",
      "readiness query returns exactly one supplier_id for every targeted mcn_id",
    ],
    status: "external-unverified",
  },
  {
    id: "single-send-context",
    requirement:
      "one send context exists per (mcn_recommendation_id, requirement_id); resend requires a new mcn_recommendation_id",
    owner: "distribution-provider-backend",
    evidence: [
      "unique or transactional idempotency proof for (mcn_recommendation_id, requirement_id)",
      "resend scenario creates a new mcn_recommendation_id",
    ],
    status: "external-unverified",
  },
  {
    id: "stable-provider-correlation",
    requirement:
      "provider send uses a stable business correlation key and an unknown outcome is queried with that key before any retry",
    owner: "distribution-provider-backend",
    evidence: [
      "provider contract documents the stable correlation key",
      "timeout scenario queries provider state and does not issue a second send",
    ],
    status: "external-unverified",
  },
  {
    id: "atomic-first-sync",
    requirement:
      "first sync transactionally creates or reuses one snapshot, one inquiry batch, one inquiry per supplier, and one cron",
    owner: "sync-mcn-inquiry-status-backend",
    evidence: [
      "transaction and uniqueness constraints cover snapshot, inquiry batch, supplier inquiry, and cron writes",
      "concurrent first-sync test returns the same snapshot, inquiry batch, inquiries, and cron",
    ],
    status: "external-unverified",
  },
  {
    id: "unique-provider-references",
    requirement:
      "provider_distribution_id is unique and every token and fill_link is nonempty and unique",
    owner: "production-database-and-provider",
    evidence: [
      "unique constraints cover provider_distribution_id, token, and fill_link",
      "provider integration test rejects empty or duplicate references",
    ],
    status: "external-unverified",
  },
  {
    id: "idempotent-submission-ingest",
    requirement:
      "submission ingest is idempotent on (provider_distribution_id, provider_row_id)",
    owner: "ingest-mcn-submissions-backend",
    evidence: [
      "unique constraint on (provider_distribution_id, provider_row_id)",
      "duplicate-row integration test preserves one logical submission item",
    ],
    status: "external-unverified",
  },
  {
    id: "single-recovery-owner",
    requirement:
      "recovery uses compare-and-swap or a row lock so concurrent manual and scheduled recovery permit one ingest owner",
    owner: "production-database-recovery-coordinator",
    evidence: [
      "CAS predicate or row-lock transaction is documented",
      "manual-versus-scheduled concurrency test observes one ingest owner",
    ],
    status: "external-unverified",
  },
  {
    id: "accepted-source-merge-priority",
    requirement:
      "creator merge priority is mcn_submission > manual_source > candidate_pool and automatic rank accepts only accepted records",
    owner: "rank-creators-backend",
    evidence: [
      "three-source collision fixture selects the documented priority winner",
      "ranking fixture excludes need_review and every status other than accepted",
    ],
    status: "external-unverified",
  },
  {
    id: "submission-batch-retry",
    requirement:
      "retry for a run returns its current unfinished submission batch; a new batch is created only after continue_submission",
    owner: "create-submission-batch-backend",
    evidence: [
      "same-run retry test returns the existing unfinished batch identifier",
      "new-batch test succeeds only after feedback next_action is continue_submission",
    ],
    status: "external-unverified",
  },
];

const DATABASE_PROOF_BOUNDARY = {
  isMigrationProof: false,
  isDeploymentProof: false,
  statement:
    "This specification declares external readiness requirements; it is not migration or deployment proof.",
};

const ERROR_CODES = [
  "INTEGRATION_REQUIRED",
  "SCHEMA_MISMATCH",
  "INVALID_INPUT",
  "INVALID_PHASE",
  "CONFIRMATION_REQUIRED",
  "FIELD_SELECTION_INVALID",
  "PROVIDER_REFERENCE_MISSING",
  "RECOVERY_NOT_CONFIRMED",
  "RECOVERY_ALREADY_TERMINAL",
  "STATE_CONFLICT",
  "WRITE_RESULT_UNKNOWN",
];

const ERROR_SEMANTICS = [
  {
    code: "INTEGRATION_REQUIRED",
    retryable: false,
    category: "integration",
    message: "The required target integration is unavailable or incompatible.",
    recoveryAction:
      "Install or upgrade the target integration, then rerun read-only contract verification.",
    writeRelated: true,
    blindRetry: false,
    retryPolicy: {
      mode: "blocked-until-corrected",
      directRetry: false,
      conditionalRetryAfterReconciliation: false,
      authoritativeReconciliationRequired: false,
      reconcileWith: null,
    },
  },
  {
    code: "SCHEMA_MISMATCH",
    retryable: false,
    category: "integration",
    message: "The runtime schema does not match the approved target contract.",
    recoveryAction:
      "Inspect the read-only schema diff and deploy a compatible provider contract.",
    writeRelated: true,
    blindRetry: false,
    retryPolicy: {
      mode: "blocked-until-corrected",
      directRetry: false,
      conditionalRetryAfterReconciliation: false,
      authoritativeReconciliationRequired: false,
      reconcileWith: null,
    },
  },
  {
    code: "INVALID_INPUT",
    retryable: false,
    category: "validation",
    message: "The request input is invalid for the approved contract.",
    recoveryAction:
      "Correct the reported input fields and submit a new validated request.",
    writeRelated: false,
    blindRetry: false,
    retryPolicy: {
      mode: "correct-input-before-new-attempt",
      directRetry: false,
      conditionalRetryAfterReconciliation: false,
      authoritativeReconciliationRequired: false,
      reconcileWith: null,
    },
  },
  {
    code: "INVALID_PHASE",
    retryable: false,
    category: "workflow",
    message: "The requested action is not allowed in the current workflow phase.",
    recoveryAction:
      "Refresh authoritative workflow state and continue only from an allowed transition.",
    writeRelated: true,
    blindRetry: false,
    retryPolicy: {
      mode: "refresh-state-before-new-attempt",
      directRetry: false,
      conditionalRetryAfterReconciliation: false,
      authoritativeReconciliationRequired: true,
      reconcileWith: "get-workflow-state-or-sync",
    },
  },
  {
    code: "CONFIRMATION_REQUIRED",
    retryable: false,
    category: "confirmation",
    message: "Explicit user confirmation is required before this action.",
    recoveryAction:
      "Obtain the required current-session confirmation before making a new call.",
    writeRelated: true,
    blindRetry: false,
    retryPolicy: {
      mode: "confirm-before-new-attempt",
      directRetry: false,
      conditionalRetryAfterReconciliation: false,
      authoritativeReconciliationRequired: false,
      reconcileWith: null,
    },
  },
  {
    code: "FIELD_SELECTION_INVALID",
    retryable: false,
    category: "validation",
    message: "The selected inquiry fields do not match the approved ordered columns.",
    recoveryAction:
      "Run field selection again and use its current ordered fields and items exactly.",
    writeRelated: true,
    blindRetry: false,
    retryPolicy: {
      mode: "reselect-fields-before-new-attempt",
      directRetry: false,
      conditionalRetryAfterReconciliation: false,
      authoritativeReconciliationRequired: false,
      reconcileWith: null,
    },
  },
  {
    code: "PROVIDER_REFERENCE_MISSING",
    retryable: false,
    category: "provider",
    message: "A required provider distribution reference is missing or empty.",
    recoveryAction:
      "Query provider state by stable correlation key and repair the reference before continuing.",
    writeRelated: true,
    blindRetry: false,
    retryPolicy: {
      mode: "reconcile-before-new-attempt",
      directRetry: false,
      conditionalRetryAfterReconciliation: false,
      authoritativeReconciliationRequired: true,
      reconcileWith: "query-provider-by-stable-correlation-key",
    },
  },
  {
    code: "RECOVERY_NOT_CONFIRMED",
    retryable: false,
    category: "recovery",
    message: "Manual recovery has not been explicitly confirmed in the current session.",
    recoveryAction:
      "Obtain explicit recovery confirmation, then restart the sync-ingest-sync sequence.",
    writeRelated: true,
    blindRetry: false,
    retryPolicy: {
      mode: "confirm-before-new-attempt",
      directRetry: false,
      conditionalRetryAfterReconciliation: false,
      authoritativeReconciliationRequired: false,
      reconcileWith: null,
    },
  },
  {
    code: "RECOVERY_ALREADY_TERMINAL",
    retryable: false,
    category: "recovery",
    message: "Recovery is already terminal with lifecycle status recovered or closed.",
    recoveryAction:
      "Treat the request as a no-op and do not invoke any recovery write.",
    writeRelated: true,
    blindRetry: false,
    retryPolicy: {
      mode: "terminal-no-op",
      directRetry: false,
      conditionalRetryAfterReconciliation: false,
      authoritativeReconciliationRequired: false,
      reconcileWith: null,
    },
  },
  {
    code: "STATE_CONFLICT",
    retryable: false,
    category: "concurrency",
    message: "Authoritative state changed while the requested transition was being applied.",
    recoveryAction:
      "Query or sync authoritative state; retry only if reconciliation shows the intended write is still valid.",
    writeRelated: true,
    blindRetry: false,
    retryPolicy: {
      mode: "reconcile-then-conditional-retry",
      directRetry: false,
      conditionalRetryAfterReconciliation: true,
      authoritativeReconciliationRequired: true,
      reconcileWith: "query-or-sync-authoritative-state",
    },
  },
  {
    code: "WRITE_RESULT_UNKNOWN",
    retryable: false,
    category: "write-safety",
    message: "The outcome of the write is unknown and must not be retried directly.",
    recoveryAction:
      "Use the designated query or sync path to reconcile the write result before any new action.",
    writeRelated: true,
    blindRetry: false,
    retryPolicy: {
      mode: "reconcile-only",
      directRetry: false,
      conditionalRetryAfterReconciliation: false,
      authoritativeReconciliationRequired: true,
      reconcileWith: "query-or-sync-write-result",
    },
  },
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
    required: [],
    sideEffects: "business-write",
    writers: { always: ["customer_demands"], conditional: [] },
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
    writers: { always: ["creator_candidate_pool"], conditional: [] },
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
    sideEffects: "read-only",
    writers: { always: [], conditional: [] },
    retry: {
      policy: "query-safe",
      blindRetry: true,
      unknownOutcome: "not-applicable",
      reconcileWith: null,
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
    writers: { always: [], conditional: [] },
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
      conditional: ["creator_supply_offers"],
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
      conditional: ["creator_supply_offers"],
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
      conditional: ["customer_demands"],
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
      always: ["creator_recommendation_items"],
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
  assert.deepEqual(
    {
      schemaVersion: workflow.schemaVersion,
      profile: workflow.profile,
      phases: workflow.phases,
      lifecycleStatuses: workflow.lifecycleStatuses,
      responseStatuses: workflow.responseStatuses,
      policies: workflow.policies,
      transitions: workflow.transitions,
    },
    {
      schemaVersion: 1,
      profile: "mvp-v2",
      phases: WORKFLOW_PHASES,
      lifecycleStatuses: LIFECYCLE_STATUSES,
      responseStatuses: RESPONSE_STATUSES,
      policies: WORKFLOW_POLICIES,
      transitions: WORKFLOW_TRANSITIONS,
    },
    "workflow contract drifted",
  );
}

function evaluateWorkflowGuard(guard, context) {
  const lifecycleSubject =
    "(?:result\\.data\\.lifecycle_status|authoritative-lifecycle-status|latest-authoritative-sync-lifecycle-status)";
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

function traverseWorkflow(
  workflow,
  { startPhase, context, allowedTriggerNames },
) {
  const pendingPhases = [startPhase];
  const visitedPhases = new Set();
  const traversed = [];

  while (pendingPhases.length > 0) {
    const phase = pendingPhases.shift();
    if (visitedPhases.has(phase)) continue;
    visitedPhases.add(phase);

    for (const transition of workflow.transitions.filter(
      ({ from, trigger }) =>
        from === phase && allowedTriggerNames.has(trigger.name),
    )) {
      if (!transitionApplies(transition, context)) continue;
      traversed.push(transition);
      if (!visitedPhases.has(transition.nextPhase)) {
        pendingPhases.push(transition.nextPhase);
      }
    }
  }

  return { phases: visitedPhases, transitions: traversed };
}

const RECOVERY_TRIGGER_NAMES = new Set([
  "manual_recovery_confirmed",
  "sync_mcn_inquiry_status",
  "ingest_mcn_submissions",
  "recovery_requested",
]);

function recoveryContext(mode, lifecycleStatus) {
  return {
    mode,
    lifecycleStatus,
    manualConfirmed: mode === "manual",
    successfulSync: true,
    successfulIngest: false,
  };
}

function assertRecoveryGraphSemantics(workflow) {
  for (const mode of ["manual", "scheduled"]) {
    for (const lifecycleStatus of ["recovered", "closed"]) {
      const result = traverseWorkflow(workflow, {
        startPhase: "waiting_return",
        context: recoveryContext(mode, lifecycleStatus),
        allowedTriggerNames: RECOVERY_TRIGGER_NAMES,
      });
      const expectedTerminalTransition =
        mode === "manual"
          ? "manual-terminal-reconciliation"
          : "scheduled-terminal-reconciliation";

      assert.ok(
        result.transitions.some(({ id }) => id === expectedTerminalTransition),
        `${mode} ${lifecycleStatus} lacks its terminal reconciliation`,
      );
      assert.ok(
        result.phases.has("recovered"),
        `${mode} ${lifecycleStatus} does not reach recovered`,
      );
      assert.equal(
        result.phases.has("recovering"),
        false,
        `${mode} ${lifecycleStatus} visits recovering`,
      );
      assert.equal(
        result.transitions.some(
          ({ trigger }) => trigger.name === "ingest_mcn_submissions",
        ),
        false,
        `${mode} ${lifecycleStatus} reaches submission ingest`,
      );
    }
  }

  const nonterminalCases = [
    {
      mode: "manual",
      lifecycleStatus: "recover_requested",
      syncTransition: "manual-recovery-sync",
      ingestTransition: "manual-submission-ingest",
      wrongIngestTransition: "scheduled-submission-ingest",
    },
    {
      mode: "scheduled",
      lifecycleStatus: "waiting_return",
      syncTransition: "scheduled-recovery-sync",
      ingestTransition: "scheduled-submission-ingest",
      wrongIngestTransition: "manual-submission-ingest",
    },
  ];
  for (const testCase of nonterminalCases) {
    const result = traverseWorkflow(workflow, {
      startPhase: "waiting_return",
      context: recoveryContext(testCase.mode, testCase.lifecycleStatus),
      allowedTriggerNames: RECOVERY_TRIGGER_NAMES,
    });
    const transitionIds = result.transitions.map(({ id }) => id);

    assert.ok(
      result.phases.has("recovering"),
      `${testCase.mode} nonterminal status cannot reach recovering`,
    );
    assert.ok(
      transitionIds.includes(testCase.syncTransition),
      `${testCase.mode} recovery uses the wrong sync path`,
    );
    assert.ok(
      transitionIds.includes(testCase.ingestTransition),
      `${testCase.mode} recovery cannot reach its ingest path`,
    );
    assert.equal(
      transitionIds.includes(testCase.wrongIngestTransition),
      false,
      `${testCase.mode} recovery reaches the other mode's ingest`,
    );
  }
}

function assertDatabaseContract(database) {
  assert.deepEqual(
    {
      schemaVersion: database.schemaVersion,
      profile: database.profile,
      readinessStatus: database.readinessStatus,
      proofBoundary: database.proofBoundary,
      writerOwnership: database.writerOwnership,
      invariants: database.invariants,
    },
    {
      schemaVersion: 1,
      profile: "mvp-v2",
      readinessStatus: "external-unverified",
      proofBoundary: DATABASE_PROOF_BOUNDARY,
      writerOwnership: DATABASE_WRITER_OWNERSHIP,
      invariants: DATABASE_INVARIANTS,
    },
    "database contract drifted",
  );
}

function assertErrorsContract(errors) {
  assert.deepEqual(
    {
      schemaVersion: errors.schemaVersion,
      profile: errors.profile,
      codes: errors.codes,
      errors: errors.errors,
    },
    {
      schemaVersion: 1,
      profile: "mvp-v2",
      codes: ERROR_CODES,
      errors: ERROR_SEMANTICS,
    },
    "errors contract drifted",
  );
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
          tool.sideEffects = "business-write";
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
          tool.retry.blindRetry = false;
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
      [],
    );
    assert.ok(
      !allWriters(profile.tools.ingest_mcn_submissions).includes(
        "mcn_inquiries",
      ),
    );
    assert.deepEqual(allWriters(profile.tools.audit_manual_adjustment), [
      "creator_recommendation_items",
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
  it("declares the exact approved phases and status vocabularies", async () => {
    const workflow = await loadSpec(WORKFLOW_SPEC);

    assert.equal(workflow.schemaVersion, 1);
    assert.equal(workflow.profile, "mvp-v2");
    assert.deepEqual(workflow.phases, WORKFLOW_PHASES);
    assert.deepEqual(workflow.lifecycleStatuses, LIFECYCLE_STATUSES);
    assert.deepEqual(workflow.responseStatuses, RESPONSE_STATUSES);
  });

  it("allows exactly the approved guarded and evidenced transitions", async () => {
    const workflow = await loadSpec(WORKFLOW_SPEC);

    assert.deepEqual(workflow.policies, WORKFLOW_POLICIES);
    assert.deepEqual(workflow.transitions, WORKFLOW_TRANSITIONS);
    assert.equal(
      workflow.transitions.some(
        (transition) => transition.trigger.name === "message_received",
      ),
      false,
    );
    assertWorkflowContract(workflow);
  });

  it("uses every tool profile's complete success evidence exactly", async () => {
    const [workflow, profile] = await Promise.all([
      loadSpec(WORKFLOW_SPEC),
      loadSpec(V2_PROFILE),
    ]);

    for (const transition of workflow.transitions.filter(
      ({ trigger }) => trigger.type === "tool",
    )) {
      const tool = profile.tools[transition.trigger.name];
      assert.ok(tool, `${transition.id} references an unknown tool`);
      assert.deepEqual(
        transition.evidence,
        tool.successEvidence,
        `${transition.id} evidence drifted from ${tool.name}`,
      );
    }
  });

  it("advances a requirement draft only when validation status is ready", async () => {
    const workflow = await loadSpec(WORKFLOW_SPEC);
    const transition = workflow.transitions.find(
      ({ id }) => id === "requirement-validated",
    );
    const context = { requiredDemandFieldsPresent: true };

    assert.equal(
      transitionApplies(transition, {
        ...context,
        requirementStatus: "draft",
      }),
      false,
    );
    assert.equal(
      transitionApplies(transition, {
        ...context,
        requirementStatus: "ready",
      }),
      true,
    );
  });

  it("enforces terminal and nonterminal recovery graph semantics for both modes", async () => {
    const workflow = await loadSpec(WORKFLOW_SPEC);

    assertRecoveryGraphSemantics(workflow);
  });

  it("keeps recovery_requested as a terminal event-only no-op", async () => {
    const workflow = await loadSpec(WORKFLOW_SPEC);
    const result = traverseWorkflow(workflow, {
      startPhase: "recovered",
      context: recoveryContext("manual", "recovered"),
      allowedTriggerNames: new Set(["recovery_requested"]),
    });

    assert.deepEqual([...result.phases], ["recovered"]);
    assert.deepEqual(
      result.transitions.map(({ id }) => id),
      ["terminal-recovery-no-op"],
    );
    assert.equal(
      result.transitions.some(({ trigger }) => trigger.type === "tool"),
      false,
    );
    assert.deepEqual(result.transitions[0].evidence, [
      "error.code === RECOVERY_ALREADY_TERMINAL",
      "no-write-tool-invoked",
    ]);
  });

  it("detects a mutation to a workflow transition", async () => {
    const workflow = await loadSpec(WORKFLOW_SPEC);
    const mutated = structuredClone(workflow);
    mutated.transitions.find(
      ({ id }) => id === "first-distribution-sync",
    ).nextPhase = "recovered";

    assert.throws(
      () => assertWorkflowContract(mutated),
      /workflow contract drifted/,
    );
  });

  it("detects lifecycle, terminal-path, and mode-context mutations", async () => {
    const workflow = await loadSpec(WORKFLOW_SPEC);
    assertRecoveryGraphSemantics(workflow);

    const mutationCases = [
      {
        label: "removed closed from terminal guard",
        mutate: (mutated) => {
          const transition = mutated.transitions.find(
            ({ id }) => id === "manual-terminal-reconciliation",
          );
          transition.guards = transition.guards.map((guard) =>
            guard ===
            "result.data.lifecycle_status in [recovered, closed]"
              ? "result.data.lifecycle_status in [recovered]"
              : guard,
          );
        },
      },
      {
        label: "redirected terminal path",
        mutate: (mutated) => {
          mutated.transitions.find(
            ({ id }) => id === "manual-terminal-reconciliation",
          ).nextPhase = "recovering";
        },
      },
      {
        label: "weakened nonterminal guard",
        mutate: (mutated) => {
          const transition = mutated.transitions.find(
            ({ id }) => id === "manual-recovery-sync",
          );
          transition.guards = transition.guards.map((guard) =>
            guard ===
            "result.data.lifecycle_status not in [recovered, closed]"
              ? "result.data.lifecycle_status not in [recovered]"
              : guard,
          );
        },
      },
      {
        label: "broken manual context",
        mutate: (mutated) => {
          const transition = mutated.transitions.find(
            ({ id }) => id === "manual-terminal-reconciliation",
          );
          transition.guards = transition.guards.map((guard) =>
            guard === "ctx.recovery_trigger === manual"
              ? "ctx.recovery_trigger === scheduled"
              : guard,
          );
        },
      },
      {
        label: "broken cron context",
        mutate: (mutated) => {
          const transition = mutated.transitions.find(
            ({ id }) => id === "scheduled-terminal-reconciliation",
          );
          transition.guards = transition.guards.map((guard) =>
            guard === "ctx.trigger === cron"
              ? "ctx.trigger === timer"
              : guard,
          );
        },
      },
    ];

    for (const { label, mutate } of mutationCases) {
      const mutated = structuredClone(workflow);
      mutate(mutated);
      assert.throws(
        () => assertRecoveryGraphSemantics(mutated),
        `${label} was not detected`,
      );
    }
  });

  it("rejects unrecognized lifecycle predicates instead of failing open", async () => {
    const workflow = await loadSpec(WORKFLOW_SPEC);
    const mutated = structuredClone(workflow);
    const transition = mutated.transitions.find(
      ({ id }) => id === "manual-recovery-sync",
    );
    transition.guards = transition.guards.map((guard) =>
      guard === "result.data.lifecycle_status not in [recovered, closed]"
        ? "result.data.lifecycle_status excludes [recovered, closed]"
        : guard,
    );

    assert.throws(
      () => assertRecoveryGraphSemantics(mutated),
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
    assert.deepEqual(database.proofBoundary, DATABASE_PROOF_BOUNDARY);
    assert.deepEqual(database.invariants, DATABASE_INVARIANTS);
    for (const invariant of database.invariants) {
      assert.equal(invariant.status, "external-unverified");
      assert.equal(typeof invariant.owner, "string");
      assert.ok(invariant.owner.length > 0);
      assert.ok(invariant.evidence.length > 0);
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
    assert.deepEqual(errors.errors, ERROR_SEMANTICS);
    assert.equal(new Set(errors.codes).size, errors.codes.length);
    assert.deepEqual(
      errors.errors.map(({ code }) => code),
      ERROR_CODES,
    );
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
