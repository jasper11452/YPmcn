import { validateFieldSelection } from "../contract/validator.js";
import { normalizeYpmcnToolName } from "./guards.js";
import type {
  ApplyToolResultContext,
  FieldDefinition,
  FieldSelectionProof,
  RecoveryTrigger,
  RuntimeState,
  SyncEvidence,
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
  const unwrapped = unwrapResult(result);
  if (!isRecord(unwrapped) || unwrapped.success !== true || !isRecord(unwrapped.data)) {
    return undefined;
  }
  return unwrapped.data;
}

function fieldSelectionProof(result: unknown): FieldSelectionProof | undefined {
  const unwrapped = unwrapResult(result);
  if (validateFieldSelection(unwrapped).length > 0 || !isRecord(unwrapped)) return undefined;
  return {
    fields: structuredClone(unwrapped.fields as Record<string, FieldDefinition>),
    items: structuredClone(unwrapped.items as FieldDefinition[]),
    selected_count: unwrapped.selected_count as number,
  };
}

function currentOrDraft(state: RuntimeState | undefined): RuntimeState {
  return state ?? { phase: "requirement_draft" };
}

function recoveryTrigger(context: ApplyToolResultContext): RecoveryTrigger | "initial" {
  return context.recoveryTrigger ?? "initial";
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

function applySync(
  current: RuntimeState | undefined,
  params: Record<string, unknown>,
  data: Record<string, unknown>,
  context: ApplyToolResultContext,
): RuntimeState | undefined {
  const evidence = validSyncEvidence(
    data,
    context.nowMs ?? Date.now(),
    recoveryTrigger(context),
  );
  if (!evidence) return current;

  const base: RuntimeState = current ?? {
    phase: "distribution_sync_pending",
    requirement_id: nonemptyString(params.requirement_id) ? params.requirement_id : undefined,
    mcn_recommendation_id: nonemptyString(params.mcn_recommendation_id)
      ? params.mcn_recommendation_id
      : undefined,
  };
  const terminal = evidence.lifecycle_status === "recovered" || evidence.lifecycle_status === "closed";
  let phase = base.phase;

  if (base.phase === "distribution_sync_pending") {
    phase = terminal ? "recovered" : "waiting_return";
  } else if (base.phase === "waiting_return") {
    if (terminal) phase = "recovered";
    else if (context.recoveryTrigger === "manual" || context.recoveryTrigger === "scheduled") {
      phase = "recovering";
    }
  } else if (base.phase === "recovery_sync_pending" && terminal) {
    phase = "recovered";
  } else if (base.phase === "recovered") {
    phase = "recovered";
  }

  return {
    ...base,
    phase,
    requirement_id: base.requirement_id ?? (nonemptyString(params.requirement_id) ? params.requirement_id : undefined),
    mcn_recommendation_id:
      base.mcn_recommendation_id ??
      (nonemptyString(params.mcn_recommendation_id) ? params.mcn_recommendation_id : undefined),
    inquiry_batch_id: evidence.inquiry_batch_id,
    inquiry_ids: evidence.inquiry_ids,
    snapshot_id: evidence.snapshot_id,
    lastSync: evidence,
  };
}

function applySuccessfulResult(
  toolName: string,
  current: RuntimeState | undefined,
  context: ApplyToolResultContext,
): RuntimeState | undefined {
  if (toolName === "select_inquiry_form_fields") {
    const selection = fieldSelectionProof(context.result);
    if (!selection || !current || !nonemptyString(context.params.mcn_recommendation_id)) {
      return current;
    }
    return {
      ...current,
      phase: "field_selection_ready",
      mcn_recommendation_id: context.params.mcn_recommendation_id,
      fieldSelection: selection,
    };
  }

  const data = standardData(context.result);
  if (!data) return current;

  switch (toolName) {
    case "validate_requirement":
      if (!nonemptyString(data.id) || data.status !== "ready") return current;
      return {
        ...currentOrDraft(current),
        phase: "requirement_ready",
        requirement_id: data.id,
      };
    case "search_creators":
      if (!nonemptyString(data.id) || data.candidate_pool_written !== true) return current;
      return {
        ...currentOrDraft(current),
        phase: "candidate_pool_ready",
        candidate_pool_id: data.id,
      };
    case "rank_mcns":
      if (!nonemptyString(data.id) || !hasOwn(data, "inquiry_advice")) return current;
      return {
        ...currentOrDraft(current),
        phase: "mcn_planning",
        mcn_recommendation_id: data.id,
      };
    case "create_with_distributions":
      if (
        !current ||
        !nonemptyString(data.provider_project_id) ||
        !nonemptyString(data.distribution_batch_ref) ||
        !Array.isArray(data.distributions) ||
        data.distributions.length === 0
      ) {
        return current;
      }
      return {
        ...current,
        phase: "distribution_sync_pending",
        provider_project_id: data.provider_project_id,
        distribution_batch_ref: data.distribution_batch_ref,
      };
    case "sync_mcn_inquiry_status":
      return applySync(current, context.params, data, context);
    case "ingest_mcn_submissions": {
      const trigger = context.params.trigger;
      if (
        !current ||
        (trigger !== "manual" && trigger !== "scheduled") ||
        !nonemptyString(data.id) ||
        !Number.isInteger(data.accepted_count) ||
        !Number.isInteger(data.rejected_count) ||
        !Number.isInteger(data.created_submission_item_count)
      ) {
        return current;
      }
      return {
        ...current,
        phase: "recovery_sync_pending",
        lastIngest: {
          at: context.nowMs ?? Date.now(),
          ingest_batch_id: data.id,
          trigger,
        },
      };
    }
    case "manual_source_creators":
      if (!current || !nonemptyString(data.manual_batch_id) || !Number.isInteger(data.imported_count)) {
        return current;
      }
      return {
        ...current,
        manual_batch_ids: [...(current.manual_batch_ids ?? []), data.manual_batch_id],
      };
    case "rank_creators":
      if (!current || !nonemptyString(data.run_id) || !Number.isInteger(data.ranked_count)) {
        return current;
      }
      return { ...current, phase: "recommendation_ready", run_id: data.run_id };
    case "create_submission_batch":
      if (
        !current ||
        !nonemptyString(data.id) ||
        !Number.isInteger(data.batch_no) ||
        !Number.isInteger(data.submitted_count)
      ) {
        return current;
      }
      return {
        ...current,
        phase: "submission_batch_ready",
        submission_batch_id: data.id,
        batch_no: data.batch_no as number,
      };
    case "record_client_feedback":
      if (!current || !Number.isInteger(data.updated_count) || !nonemptyString(data.next_action)) {
        return current;
      }
      return { ...current, phase: "feedback_routing" };
    default:
      return current;
  }
}

export function applyToolResult(context: ApplyToolResultContext): RuntimeState | undefined {
  if (!nonemptyString(context.sessionKey)) return undefined;
  const toolName = normalizeYpmcnToolName(context.toolName);
  if (!toolName) return context.store.get(context.sessionKey);

  return context.store.update(context.sessionKey, (current) =>
    applySuccessfulResult(toolName, current, context),
  );
}
