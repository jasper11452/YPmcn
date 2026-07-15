import { normalizeYpmcnToolName } from "./guards.js";
import { parseFieldSelectionDescription } from "../contract/validator.js";
import type {
  ApplyToolResultContext,
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

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function unwrapResult(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (value.isError === true) return value;
  if (Object.hasOwn(value, "result")) return unwrapResult(value.result);
  if (Object.hasOwn(value, "structuredContent")) return unwrapResult(value.structuredContent);
  if (Array.isArray(value.content)) {
    for (const entry of value.content) {
      if (!isRecord(entry) || typeof entry.text !== "string") continue;
      const parsed = parseJson(entry.text);
      if (parsed !== undefined) return unwrapResult(parsed);
    }
  }
  return value;
}

interface ObservedSuccess {
  root: Record<string, unknown>;
  data?: Record<string, unknown>;
  traceId?: string;
}

function observedSuccess(result: unknown): ObservedSuccess | undefined {
  const root = unwrapResult(result);
  if (
    !isRecord(root) ||
    root.isError === true ||
    root.success !== true ||
    (Object.hasOwn(root, "error") && root.error !== null && root.error !== undefined)
  ) {
    return undefined;
  }
  return {
    root,
    data: isRecord(root.data) ? root.data : undefined,
    traceId: nonemptyString(root.trace_id) ? root.trace_id : undefined,
  };
}

function knownFailure(result: unknown): boolean {
  const root = unwrapResult(result);
  return isRecord(root) && (root.isError === true || root.success === false);
}

function withResultIssue(
  current: RuntimeState | undefined,
  toolName: string,
  at: number,
): RuntimeState {
  const readOnly = toolName === "select_inquiry_form_fields" ||
    toolName === "get_recommendation_run_detail" ||
    toolName === "get_creator_detail" ||
    toolName === "get_workflow_state";
  return {
    ...currentOrDraft(current),
    lastResultIssue: {
      toolName,
      code: readOnly ? "INTEGRATION_REQUIRED" : "WRITE_RESULT_UNKNOWN",
      at,
    },
  };
}

function clearResultIssue(state: RuntimeState): RuntimeState {
  const { lastResultIssue: _ignored, ...rest } = state;
  return rest;
}

function explicitString(
  evidence: ObservedSuccess,
  ...keys: string[]
): string | undefined {
  for (const source of [evidence.data, evidence.root]) {
    if (!source) continue;
    for (const key of keys) {
      if (nonemptyString(source[key])) return source[key];
    }
  }
  return undefined;
}

function parseFieldSelection(evidence: ObservedSuccess): FieldSelectionProof | undefined {
  const description = explicitString(evidence, "description");
  if (!description) return undefined;
  const fieldNames = parseFieldSelectionDescription(description);
  if (!fieldNames) return undefined;
  return { description, fieldNames };
}

function currentOrDraft(state: RuntimeState | undefined): RuntimeState {
  return state ?? { phase: "requirement_draft" };
}

function recoveryTrigger(context: ApplyToolResultContext): RecoveryTrigger | "initial" {
  return context.recoveryTrigger ?? "initial";
}

function applySync(
  current: RuntimeState | undefined,
  evidence: ObservedSuccess,
  context: ApplyToolResultContext,
): RuntimeState | undefined {
  if (!current) return current;
  const { requirement_id, project_id, mcn_id } = context.params;
  if (
    !nonemptyString(requirement_id) ||
    !nonemptyString(project_id) ||
    !nonemptyString(mcn_id) ||
    (current.requirement_id !== undefined && current.requirement_id !== requirement_id) ||
    (current.project_id !== undefined && current.project_id !== project_id) ||
    (current.mcn_id !== undefined && current.mcn_id !== mcn_id)
  ) {
    return current;
  }
  const inquiryId = explicitString(evidence, "inquiry_id");
  const sync: SyncEvidence = {
    at: context.nowMs ?? Date.now(),
    trigger: recoveryTrigger(context),
    requirement_id,
    project_id,
    mcn_id,
    inquiry_id: inquiryId,
    trace_id: evidence.traceId,
  };
  let phase = current.phase;
  if (phase === "distribution_sync_pending") phase = "waiting_return";
  else if (phase === "waiting_return" && context.recoveryTrigger) {
    if (!inquiryId) {
      return withResultIssue(
        current,
        "sync_mcn_inquiry_status",
        context.nowMs ?? Date.now(),
      );
    }
    phase = "recovering";
  }
  else if (phase === "recovery_sync_pending") phase = "recovered";
  else if (phase !== "recovered") return current;
  return clearResultIssue({
    ...current,
    phase,
    requirement_id,
    project_id,
    mcn_id,
    inquiry_id: inquiryId ?? current.inquiry_id,
    lastSync: sync,
  });
}

function applySuccessfulResult(
  toolName: string,
  current: RuntimeState | undefined,
  context: ApplyToolResultContext,
): RuntimeState | undefined {
  const evidence = observedSuccess(context.result);
  if (!evidence) {
    return knownFailure(context.result)
      ? current
      : withResultIssue(current, toolName, context.nowMs ?? Date.now());
  }

  switch (toolName) {
    case "validate_requirement": {
      const requirementId = explicitString(evidence, "requirement_id", "id");
      if (!requirementId) {
        return withResultIssue(current, toolName, context.nowMs ?? Date.now());
      }
      return clearResultIssue({
        ...currentOrDraft(current),
        phase: "requirement_ready",
        requirement_id: requirementId,
      });
    }
    case "search_creators":
      if (!current || current.phase !== "requirement_ready" || context.params.id !== current.requirement_id) {
        return current;
      }
      return clearResultIssue({ ...current, phase: "search_completed" });
    case "rank_mcns": {
      if (!current || current.phase !== "search_completed" || context.params.id !== current.requirement_id) {
        return current;
      }
      const recommendationId = explicitString(evidence, "mcn_recommendation_id", "id");
      if (!recommendationId) {
        return withResultIssue(current, toolName, context.nowMs ?? Date.now());
      }
      return clearResultIssue({
        ...current,
        phase: "mcn_planning",
        mcn_recommendation_id: recommendationId,
        fieldSelection: undefined,
        sendConfirmation: undefined,
      });
    }
    case "select_inquiry_form_fields": {
      if (!current || current.phase !== "mcn_planning") return current;
      const selection = parseFieldSelection(evidence);
      if (!selection) {
        return withResultIssue(current, toolName, context.nowMs ?? Date.now());
      }
      return clearResultIssue({ ...current, phase: "field_selection_ready", fieldSelection: selection });
    }
    case "create_with_distributions": {
      if (!current || current.phase !== "field_selection_ready") return current;
      const projectId = explicitString(evidence, "project_id");
      const mcnId = explicitString(evidence, "mcn_id");
      if (!projectId || !mcnId) {
        return withResultIssue(current, toolName, context.nowMs ?? Date.now());
      }
      return clearResultIssue({
        ...current,
        phase: "distribution_sync_pending",
        project_id: projectId,
        mcn_id: mcnId,
      });
    }
    case "sync_mcn_inquiry_status":
      return applySync(current, evidence, context);
    case "ingest_mcn_submissions": {
      if (
        !current ||
        current.phase !== "recovering" ||
        !nonemptyString(context.params.inquiry_id) ||
        context.params.inquiry_id !== current.inquiry_id ||
        !context.recoveryTrigger
      ) {
        return current;
      }
      return clearResultIssue({
        ...current,
        phase: "recovery_sync_pending",
        lastIngest: {
          at: context.nowMs ?? Date.now(),
          inquiry_id: context.params.inquiry_id,
          trigger: context.recoveryTrigger,
          trace_id: evidence.traceId,
        },
      });
    }
    case "rank_creators": {
      if (!current || current.phase !== "recovered" || context.params.requirement_id !== current.requirement_id) {
        return current;
      }
      const runId = explicitString(evidence, "run_id");
      if (!runId) {
        return withResultIssue(current, toolName, context.nowMs ?? Date.now());
      }
      return clearResultIssue({ ...current, phase: "recommendation_ready", run_id: runId });
    }
    case "create_submission_batch":
      if (!current || current.phase !== "recommendation_ready" || context.params.run_id !== current.run_id) {
        return current;
      }
      return clearResultIssue({ ...current, phase: "submission_batch_ready" });
    case "record_client_feedback":
      if (!current || current.phase !== "submission_batch_ready" || context.params.run_id !== current.run_id) {
        return current;
      }
      return clearResultIssue({ ...current, phase: "feedback_routing" });
    default:
      return current;
  }
}

export function applyToolResult(context: ApplyToolResultContext): RuntimeState | undefined {
  if (!nonemptyString(context.sessionKey)) return undefined;
  const toolName = normalizeYpmcnToolName(context.toolName);
  if (!toolName) return context.store.get(context.sessionKey);
  return context.store.update(context.sessionKey, (current) =>
    applySuccessfulResult(toolName, current, context));
}
