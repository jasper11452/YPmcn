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

export interface SendConfirmationProof {
  mcn_recommendation_id: string;
  operatorRole: "media" | "procurement";
  supplyConfirmed: boolean;
  mcnConfirmed: boolean;
  messageConfirmed: boolean;
  confirmedAt: number;
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
  sendConfirmation?: SendConfirmationProof;
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

export interface GuardContext {
  toolName: string;
  params: Record<string, unknown>;
  sessionKey?: string;
  toolCallId?: string;
  nowMs?: number;
  trigger?: string;
  recoveryTrigger?: RecoveryTrigger;
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
