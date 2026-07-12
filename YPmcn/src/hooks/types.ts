export type WorkflowPhase =
  | "requirement_draft"
  | "requirement_ready"
  | "candidate_pool_ready"
  | "mcn_planning"
  | "field_selection_ready"
  | "distribution_sync_pending"
  | "waiting_return"
  | "recovering"
  | "recovery_sync_pending"
  | "recovered"
  | "recommendation_ready"
  | "submission_batch_ready"
  | "feedback_routing"
  | "blocked";

export type RecoveryTrigger = "manual" | "scheduled";

export type WorkflowAction =
  | "validate_requirement"
  | "search_creators"
  | "rank_mcns"
  | "select_inquiry_form_fields"
  | "create_with_distributions"
  | "refresh_recovery"
  | "request_recovery"
  | "finalize_recovery"
  | "rank_creators"
  | "create_submission_batch"
  | "record_client_feedback";

export interface WorkflowIdentifiers {
  requirement_id?: string;
  candidate_pool_id?: string;
  mcn_recommendation_id?: string;
  selection_result_id?: string;
  send_operation_id?: string;
  inquiry_batch_id?: string;
  recovery_operation_id?: string;
  run_id?: string;
  submission_batch_id?: string;
}

/**
 * A validated provider projection. It may be a full `get_workflow_state`
 * response or the action-bearing portion returned by a recovery operation.
 * Only this structure can grant a business action.
 */
export interface AuthoritativeWorkflowProjection {
  state_version: number;
  allowed_actions: WorkflowAction[];
  phase?: WorkflowPhase;
  current_identifier?: string;
  lifecycle_status?: string | null;
  response_status?: string | null;
  pending_gates?: string[];
  identifiers?: WorkflowIdentifiers;
  updated_at?: string;
}

export interface FieldDefinition {
  key: string;
  name: string;
  type: string;
  required: boolean;
}

export interface FieldSelectionProof {
  fields: Record<string, FieldDefinition>;
  items: FieldDefinition[];
  selected_count: number;
}

export interface SyncEvidence {
  at: number;
  lifecycle_status: string;
  response_status: string;
  trigger: "initial" | RecoveryTrigger;
  inquiry_batch_id?: string;
  inquiry_ids?: string[];
  snapshot_id?: string;
}

export interface IngestEvidence {
  at: number;
  ingest_batch_id: string;
  trigger: RecoveryTrigger;
}

export interface RuntimeState {
  phase: WorkflowPhase;
  /** Server-owned action authority; local fields below cannot grant writes. */
  authoritative?: AuthoritativeWorkflowProjection;
  /** Greatest accepted provider state version, including incomplete write results. */
  lastServerStateVersion?: number;
  /** A successful write omitted allowed_actions; refresh before another business write. */
  requiresWorkflowRefresh?: boolean;
  /** A write omitted state_version, so the refresh must advance the last known version. */
  requiresNewerWorkflowState?: boolean;
  requirement_id?: string;
  candidate_pool_id?: string;
  mcn_recommendation_id?: string;
  provider_project_id?: string;
  distribution_batch_ref?: string;
  inquiry_batch_id?: string;
  inquiry_ids?: string[];
  snapshot_id?: string;
  run_id?: string;
  submission_batch_id?: string;
  batch_no?: number;
  manual_batch_ids?: string[];
  fieldSelection?: FieldSelectionProof;
  manualRecoveryConfirmedAt?: number;
  lastSync?: SyncEvidence;
  lastIngest?: IngestEvidence;
}

export interface RuntimeStateStore {
  get(sessionKey: string): RuntimeState | undefined;
  set(sessionKey: string, state: RuntimeState): RuntimeState;
  update(
    sessionKey: string,
    updater: (current: RuntimeState | undefined) => RuntimeState | undefined,
  ): RuntimeState | undefined;
  delete(sessionKey: string): void;
  clear(): void;
}

export interface GateState {
  supplyConfirmed?: boolean;
  mcnConfirmed?: boolean;
  messageConfirmed?: boolean;
}

export interface GuardContext {
  toolName: string;
  params: Record<string, unknown>;
  sessionKey?: string;
  toolCallId?: string;
  operatorRole?: string;
  nowMs?: number;
  trigger?: string;
  recoveryTrigger?: RecoveryTrigger;
  gateState?: GateState;
  store: RuntimeStateStore;
}

export interface BeforeToolCallResult {
  block: true;
  blockReason: string;
}

export interface ApplyToolResultContext {
  sessionKey?: string;
  toolName: string;
  params: Record<string, unknown>;
  result: unknown;
  nowMs?: number;
  trigger?: string;
  recoveryTrigger?: RecoveryTrigger;
  store: RuntimeStateStore;
}
