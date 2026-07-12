import { validateFieldSelection, validateToolOutput } from "../contract/validator.js";
import { normalizeYpmcnToolName } from "./guards.js";
import type {
  ApplyToolResultContext,
  AuthoritativeWorkflowProjection,
  FieldDefinition,
  FieldSelectionProof,
  RecoveryTrigger,
  RuntimeState,
  SyncEvidence,
  WorkflowAction,
  WorkflowIdentifiers,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function unwrapResult(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (hasOwn(value, "result")) return unwrapResult(value.result);
  if (hasOwn(value, "structuredContent")) return unwrapResult(value.structuredContent);
  if (Array.isArray(value.content)) {
    for (const entry of value.content) {
      if (!isRecord(entry) || typeof entry.text !== "string") continue;
      const parsed = parseJson(entry.text);
      if (parsed !== undefined) return unwrapResult(parsed);
    }
  }
  return value;
}

function standardData(result: unknown): Record<string, unknown> | undefined {
  if (!isRecord(result) || result.success !== true || !isRecord(result.data)) return undefined;
  return result.data;
}

function fieldSelectionProof(result: unknown): FieldSelectionProof | undefined {
  if (validateFieldSelection(result).length > 0 || !isRecord(result)) return undefined;
  return {
    fields: structuredClone(result.fields as Record<string, FieldDefinition>),
    items: structuredClone(result.items as FieldDefinition[]),
    selected_count: result.selected_count as number,
  };
}

function currentOrDraft(state: RuntimeState | undefined): RuntimeState {
  return state ?? { phase: "requirement_draft" };
}

function recoveryTrigger(context: ApplyToolResultContext): RecoveryTrigger | "initial" {
  return context.recoveryTrigger ?? "initial";
}

function stateVersion(data: Record<string, unknown>): number | undefined {
  return Number.isInteger(data.state_version) && (data.state_version as number) >= 1
    ? data.state_version as number
    : undefined;
}

function isStaleServerResult(
  current: RuntimeState | undefined,
  version: number | undefined,
): boolean {
  return (
    version !== undefined &&
    current?.lastServerStateVersion !== undefined &&
    version <= current.lastServerStateVersion
  );
}

function canReplaceAuthority(current: RuntimeState | undefined, version: number): boolean {
  if (current?.lastServerStateVersion === undefined) return true;
  if (version > current.lastServerStateVersion) return true;
  return version === current.lastServerStateVersion &&
    current.requiresNewerWorkflowState !== true &&
    (current.authoritative === undefined || current.requiresWorkflowRefresh === true);
}

function invalidateAuthority(
  current: RuntimeState,
  version: number | undefined,
): RuntimeState {
  return {
    ...current,
    authoritative: undefined,
    lastServerStateVersion: version ?? current.lastServerStateVersion,
    requiresWorkflowRefresh: true,
    requiresNewerWorkflowState:
      version === undefined && current.lastServerStateVersion !== undefined,
  };
}

function localIdentifiers(
  current: RuntimeState,
  identifiers: WorkflowIdentifiers | undefined,
): RuntimeState {
  if (!identifiers) return current;
  return {
    ...current,
    requirement_id: identifiers.requirement_id ?? current.requirement_id,
    candidate_pool_id: identifiers.candidate_pool_id ?? current.candidate_pool_id,
    mcn_recommendation_id: identifiers.mcn_recommendation_id ?? current.mcn_recommendation_id,
    inquiry_batch_id: identifiers.inquiry_batch_id ?? current.inquiry_batch_id,
    run_id: identifiers.run_id ?? current.run_id,
    submission_batch_id: identifiers.submission_batch_id ?? current.submission_batch_id,
  };
}

function workflowIdentifiers(value: unknown): WorkflowIdentifiers | undefined {
  if (!isRecord(value)) return undefined;
  const identifiers: WorkflowIdentifiers = {};
  for (const key of [
    "requirement_id",
    "candidate_pool_id",
    "mcn_recommendation_id",
    "selection_result_id",
    "send_operation_id",
    "inquiry_batch_id",
    "recovery_operation_id",
    "run_id",
    "submission_batch_id",
  ] as const) {
    if (nonemptyString(value[key])) identifiers[key] = value[key];
  }
  return identifiers;
}

function workflowActions(value: unknown): WorkflowAction[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? structuredClone(value) as WorkflowAction[]
    : undefined;
}

function validSyncEvidence(
  data: Record<string, unknown>,
  at: number,
  trigger: RecoveryTrigger | "initial",
): SyncEvidence | undefined {
  if (
    !nonemptyString(data.inquiry_batch_id) ||
    !Array.isArray(data.inquiry_ids) ||
    !data.inquiry_ids.every(nonemptyString) ||
    !nonemptyString(data.snapshot_id) ||
    !nonemptyString(data.lifecycle_status) ||
    !nonemptyString(data.response_status)
  ) {
    return undefined;
  }
  return {
    at,
    trigger,
    inquiry_batch_id: data.inquiry_batch_id,
    inquiry_ids: [...data.inquiry_ids],
    snapshot_id: data.snapshot_id,
    lifecycle_status: data.lifecycle_status,
    response_status: data.response_status,
  };
}

function projectionFromWorkflowState(
  data: Record<string, unknown>,
): AuthoritativeWorkflowProjection | undefined {
  const version = stateVersion(data);
  const actions = workflowActions(data.allowed_actions);
  const identifiers = workflowIdentifiers(data.identifiers);
  if (
    version === undefined ||
    !actions ||
    !nonemptyString(data.phase) ||
    !nonemptyString(data.current_identifier) ||
    !Array.isArray(data.pending_gates) ||
    !data.pending_gates.every(nonemptyString) ||
    !identifiers ||
    !nonemptyString(data.updated_at)
  ) {
    return undefined;
  }
  return {
    state_version: version,
    allowed_actions: actions,
    phase: data.phase as RuntimeState["phase"],
    current_identifier: data.current_identifier,
    lifecycle_status: typeof data.lifecycle_status === "string" || data.lifecycle_status === null
      ? data.lifecycle_status
      : undefined,
    response_status: typeof data.response_status === "string" || data.response_status === null
      ? data.response_status
      : undefined,
    pending_gates: [...data.pending_gates],
    identifiers,
    updated_at: data.updated_at,
  };
}

function applyWorkflowState(
  current: RuntimeState | undefined,
  data: Record<string, unknown>,
): RuntimeState | undefined {
  const projection = projectionFromWorkflowState(data);
  if (!projection || !canReplaceAuthority(current, projection.state_version)) return current;
  const base = localIdentifiers(currentOrDraft(current), projection.identifiers);
  return {
    ...base,
    phase: projection.phase ?? base.phase,
    authoritative: projection,
    lastServerStateVersion: projection.state_version,
    requiresWorkflowRefresh: false,
    requiresNewerWorkflowState: false,
  };
}

function applyRecoveryAuthority(
  toolName: "sync_mcn_inquiry_status" | "ingest_mcn_submissions",
  current: RuntimeState | undefined,
  data: Record<string, unknown>,
  context: ApplyToolResultContext,
): RuntimeState | undefined {
  const version = stateVersion(data);
  const actions = workflowActions(data.allowed_actions);
  if (version === undefined || !actions || !canReplaceAuthority(current, version)) return current;
  const base = currentOrDraft(current);
  const inheritedIdentifiers = structuredClone(base.authoritative?.identifiers ?? {});
  if (toolName === "ingest_mcn_submissions" && nonemptyString(data.recovery_operation_id)) {
    inheritedIdentifiers.recovery_operation_id = data.recovery_operation_id;
  }
  const authority: AuthoritativeWorkflowProjection = {
    state_version: version,
    allowed_actions: actions,
    lifecycle_status: typeof data.lifecycle_status === "string"
      ? data.lifecycle_status
      : base.authoritative?.lifecycle_status,
    response_status: typeof data.response_status === "string"
      ? data.response_status
      : base.authoritative?.response_status,
    identifiers: inheritedIdentifiers,
  };
  const next: RuntimeState = {
    ...base,
    authoritative: authority,
    lastServerStateVersion: version,
    requiresWorkflowRefresh: false,
    requiresNewerWorkflowState: false,
  };

  if (toolName === "sync_mcn_inquiry_status") {
    const evidence = validSyncEvidence(data, context.nowMs ?? Date.now(), recoveryTrigger(context));
    if (!evidence) return current;
    return {
      ...next,
      inquiry_batch_id: evidence.inquiry_batch_id,
      inquiry_ids: evidence.inquiry_ids,
      snapshot_id: evidence.snapshot_id,
      lastSync: evidence,
    };
  }
  if (
    !nonemptyString(data.id) ||
    !Number.isInteger(data.accepted_count) ||
    !Number.isInteger(data.rejected_count) ||
    !Number.isInteger(data.created_submission_item_count) ||
    !nonemptyString(context.params.trigger) ||
    (context.params.trigger !== "manual" && context.params.trigger !== "scheduled")
  ) {
    return current;
  }
  return {
    ...next,
    lastIngest: {
      at: context.nowMs ?? Date.now(),
      ingest_batch_id: data.id,
      trigger: context.params.trigger,
    },
  };
}

function applySuccessfulResult(
  toolName: string,
  current: RuntimeState | undefined,
  context: ApplyToolResultContext,
  result: unknown,
): RuntimeState | undefined {
  if (toolName === "select_inquiry_form_fields") {
    const selection = fieldSelectionProof(result);
    if (!selection || !nonemptyString(context.params.mcn_recommendation_id)) return current;
    const base = currentOrDraft(current);
    return invalidateAuthority({
      ...base,
      phase: "field_selection_ready",
      mcn_recommendation_id: context.params.mcn_recommendation_id,
      fieldSelection: selection,
    }, undefined);
  }

  const data = standardData(result);
  if (!data) return current;
  if (toolName === "get_workflow_state") return applyWorkflowState(current, data);
  if (toolName === "sync_mcn_inquiry_status" || toolName === "ingest_mcn_submissions") {
    return applyRecoveryAuthority(toolName, current, data, context);
  }

  const version = stateVersion(data);
  if (isStaleServerResult(current, version)) return current;
  const base = currentOrDraft(current);
  let next: RuntimeState;
  switch (toolName) {
    case "validate_requirement":
      if (!nonemptyString(data.id) || data.status !== "ready") return current;
      next = { ...base, phase: "requirement_ready", requirement_id: data.id };
      break;
    case "search_creators":
      if (!nonemptyString(data.id) || data.candidate_pool_written !== true) return current;
      next = { ...base, phase: "candidate_pool_ready", candidate_pool_id: data.id };
      break;
    case "rank_mcns":
      if (!nonemptyString(data.id) || !hasOwn(data, "inquiry_advice")) return current;
      next = { ...base, phase: "mcn_planning", mcn_recommendation_id: data.id };
      break;
    case "create_with_distributions":
      if (
        !nonemptyString(data.provider_project_id) ||
        !nonemptyString(data.distribution_batch_ref) ||
        !Array.isArray(data.distributions) ||
        data.distributions.length === 0
      ) {
        return current;
      }
      next = {
        ...base,
        phase: "distribution_sync_pending",
        provider_project_id: data.provider_project_id,
        distribution_batch_ref: data.distribution_batch_ref,
      };
      break;
    case "manual_source_creators":
      if (!nonemptyString(data.manual_batch_id) || !Number.isInteger(data.imported_count)) return current;
      next = {
        ...base,
        manual_batch_ids: [...(base.manual_batch_ids ?? []), data.manual_batch_id],
      };
      break;
    case "rank_creators":
      if (!nonemptyString(data.run_id) || !Number.isInteger(data.ranked_count)) return current;
      next = { ...base, phase: "recommendation_ready", run_id: data.run_id };
      break;
    case "create_submission_batch":
      if (!nonemptyString(data.id) || !Number.isInteger(data.batch_no) || !Number.isInteger(data.submitted_count)) {
        return current;
      }
      next = {
        ...base,
        phase: "submission_batch_ready",
        submission_batch_id: data.id,
        batch_no: data.batch_no as number,
      };
      break;
    case "record_client_feedback":
      if (!Number.isInteger(data.updated_count) || !nonemptyString(data.next_action)) return current;
      next = { ...base, phase: "feedback_routing" };
      break;
    case "audit_manual_adjustment":
      next = base;
      break;
    default:
      return current;
  }
  return invalidateAuthority(next, version);
}

export function applyToolResult(context: ApplyToolResultContext): RuntimeState | undefined {
  if (!nonemptyString(context.sessionKey)) return undefined;
  const toolName = normalizeYpmcnToolName(context.toolName);
  if (!toolName) return context.store.get(context.sessionKey);

  const result = unwrapResult(context.result);
  if (validateToolOutput(toolName, result).length > 0) {
    return context.store.get(context.sessionKey);
  }
  return context.store.update(context.sessionKey, (current) =>
    applySuccessfulResult(toolName, current, context, result),
  );
}
