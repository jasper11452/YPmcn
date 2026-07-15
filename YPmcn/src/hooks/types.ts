export type WorkflowPhase =
  | "requirement_draft"
  | "requirement_ready"
  | "search_completed"
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

export interface FieldSelectionProof {
  description: string;
  fieldNames: string[];
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
  trigger: "initial" | RecoveryTrigger;
  requirement_id: string;
  project_id: string;
  mcn_id: string;
  inquiry_id?: string;
  trace_id?: string;
}

export interface IngestEvidence {
  at: number;
  inquiry_id: string;
  trigger: RecoveryTrigger;
  trace_id?: string;
}

export interface RuntimeState {
  phase: WorkflowPhase;
  requirement_id?: string;
  mcn_recommendation_id?: string;
  project_id?: string;
  mcn_id?: string;
  inquiry_id?: string;
  run_id?: string;
  fieldSelection?: FieldSelectionProof;
  sendConfirmation?: SendConfirmationProof;
  manualRecoveryConfirmedAt?: number;
  lastSync?: SyncEvidence;
  lastIngest?: IngestEvidence;
  lastResultIssue?: {
    toolName: string;
    code: "INTEGRATION_REQUIRED" | "WRITE_RESULT_UNKNOWN";
    at: number;
  };
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
