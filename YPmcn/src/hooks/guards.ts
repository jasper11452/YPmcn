import { validateFieldSelection, validateToolParams } from "../contract/validator.js";
import type { ValidationIssue } from "../contract/types.js";
import type {
  BeforeToolCallResult,
  FieldDefinition,
  GuardContext,
  RuntimeState,
} from "./types.js";

const TARGET_TOOLS = new Set([
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
  "get_workflow_state",
]);

const READ_ONLY_TOOLS = new Set([
  "select_inquiry_form_fields",
  "get_recommendation_run_detail",
  "get_creator_detail",
  "get_workflow_state",
]);
const SHELL_TOOLS = new Set(["exec", "bash", "shell", "powershell", "pwsh"]);
const SEND_ROLES = new Set(["media", "procurement"]);
const PROVIDER_WRITE_PATTERN =
  /(?:create[-_]with[-_]distributions|\/api\/projects\/create-with-distributions)(?:\b|\/)/i;
const ISO_WITH_TIMEZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => deepEqual(value, right[index]))
    );
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && deepEqual(left[key], right[key]),
    )
  );
}

function blocked(code: string, message: string): BeforeToolCallResult {
  return { block: true, blockReason: `${code}: ${message}` };
}

function blockedByIssues(issues: ValidationIssue[]): BeforeToolCallResult | undefined {
  if (issues.length === 0) return undefined;
  const summary = issues
    .slice(0, 3)
    .map((entry) => `${entry.code} at ${entry.path}`)
    .join("; ");
  return blocked(issues[0].code, summary);
}

function shellText(params: Record<string, unknown>): string {
  return ["command", "cmd", "script", "input"]
    .map((key) => params[key])
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

function phaseRequired(state: RuntimeState | undefined, expected: RuntimeState["phase"]): BeforeToolCallResult | undefined {
  if (state?.phase === expected) return undefined;
  return blocked(
    "INVALID_PHASE",
    `Tool requires phase ${expected}; current phase is ${state?.phase ?? "missing"}.`,
  );
}

function sameIdentifier(
  params: Record<string, unknown>,
  state: RuntimeState,
  key: "requirement_id" | "candidate_pool_id" | "mcn_recommendation_id" | "run_id",
): BeforeToolCallResult | undefined {
  const expected = state[key];
  if (nonemptyString(expected) && params[key] === expected) return undefined;
  return blocked("STATE_CONFLICT", `${key} does not match the current-session projection.`);
}

function validateSendTimestamps(
  params: Record<string, unknown>,
  nowMs: number,
): BeforeToolCallResult | undefined {
  const deadline = params.deadline;
  const remindAt = params.remindAt;
  if (!nonemptyString(deadline) || !ISO_WITH_TIMEZONE.test(deadline)) {
    return blocked("INVALID_INPUT", "deadline must be a timezone-qualified ISO timestamp.");
  }
  if (!nonemptyString(remindAt) || !ISO_WITH_TIMEZONE.test(remindAt)) {
    return blocked("INVALID_INPUT", "remindAt must be a timezone-qualified ISO timestamp.");
  }
  const deadlineMs = Date.parse(deadline);
  const remindAtMs = Date.parse(remindAt);
  if (!Number.isFinite(deadlineMs) || deadlineMs <= nowMs) {
    return blocked("INVALID_INPUT", "deadline must be in the future.");
  }
  if (!Number.isFinite(remindAtMs) || remindAtMs <= nowMs) {
    return blocked("INVALID_INPUT", "remindAt must be in the future.");
  }
  if (remindAtMs > deadlineMs) {
    return blocked("INVALID_INPUT", "remindAt cannot be later than deadline.");
  }
  return undefined;
}

function validateDistributionGuard(
  context: GuardContext,
  state: RuntimeState | undefined,
): BeforeToolCallResult | undefined {
  if (!nonemptyString(context.toolCallId)) {
    return blocked("INVALID_INPUT", "A provider write requires toolCallId evidence.");
  }
  const confirmation = state?.sendConfirmation;
  if (!confirmation || !SEND_ROLES.has(confirmation.operatorRole)) {
    return blocked("CONFIRMATION_REQUIRED", "A known media/procurement operator role is required.");
  }
  if (
    confirmation.mcn_recommendation_id !== context.params.mcn_recommendation_id ||
    confirmation.supplyConfirmed !== true ||
    confirmation.mcnConfirmed !== true ||
    confirmation.messageConfirmed !== true
  ) {
    return blocked(
      "CONFIRMATION_REQUIRED",
      "Supply, target-MCN, and outbound-message confirmations are all required.",
    );
  }
  const phaseError = phaseRequired(state, "field_selection_ready");
  if (phaseError || !state) return phaseError;
  const idError = sameIdentifier(context.params, state, "mcn_recommendation_id");
  if (idError) return idError;
  if (!state.fieldSelection) {
    return blocked("FIELD_SELECTION_INVALID", "Current-session field-selection proof is missing.");
  }
  const selectionIssues = validateFieldSelection({
    success: true,
    fields: state.fieldSelection.fields,
    items: state.fieldSelection.items,
    selected_count: state.fieldSelection.selected_count,
  });
  if (selectionIssues.length > 0) return blockedByIssues(selectionIssues);
  if (!deepEqual(context.params.columns, state.fieldSelection.items)) {
    return blocked(
      "FIELD_SELECTION_INVALID",
      "Outbound columns must exactly match the ordered current-session field selection.",
    );
  }
  return validateSendTimestamps(context.params, context.nowMs ?? Date.now());
}

function manualRecoveryIsCurrent(state: RuntimeState, nowMs: number): boolean {
  return (
    typeof state.manualRecoveryConfirmedAt === "number" &&
    state.manualRecoveryConfirmedAt <= nowMs
  );
}

function validateSyncGuard(
  context: GuardContext,
  state: RuntimeState | undefined,
): BeforeToolCallResult | undefined {
  // A state projection can be lost between send and first reconciliation. The
  // authoritative sync is the only safe way to reconstruct it from semantic IDs.
  if (!state) return undefined;

  const requirementError = sameIdentifier(context.params, state, "requirement_id");
  if (requirementError) return requirementError;
  const mcnError = sameIdentifier(context.params, state, "mcn_recommendation_id");
  if (mcnError) return mcnError;

  if (state.phase === "distribution_sync_pending") return undefined;
  if (state.phase === "recovered") {
    return blocked(
      "RECOVERY_ALREADY_TERMINAL",
      "Authoritative state is terminal; another recovery write is not allowed.",
    );
  }
  if (state.phase === "waiting_return") {
    if (
      context.recoveryTrigger === "manual" &&
      manualRecoveryIsCurrent(state, context.nowMs ?? Date.now())
    ) {
      return undefined;
    }
    if (context.recoveryTrigger === "scheduled" && context.trigger === "cron") {
      return undefined;
    }
    return blocked(
      "RECOVERY_NOT_CONFIRMED",
      "Waiting recovery requires explicit current-session manual intent or cron evidence.",
    );
  }
  if (state.phase === "recovery_sync_pending") {
    if (!state.lastIngest) {
      return blocked("INVALID_PHASE", "Final sync requires successful ingest evidence.");
    }
    if (context.recoveryTrigger !== state.lastIngest.trigger) {
      return blocked("STATE_CONFLICT", "Final sync trigger does not match the ingest trigger.");
    }
    if (state.lastIngest.trigger === "scheduled" && context.trigger !== "cron") {
      return blocked("RECOVERY_NOT_CONFIRMED", "Scheduled final sync requires cron evidence.");
    }
    return undefined;
  }
  return blocked("INVALID_PHASE", `Sync is not allowed from phase ${state.phase}.`);
}

function validateIngestGuard(
  context: GuardContext,
  state: RuntimeState | undefined,
): BeforeToolCallResult | undefined {
  const phaseError = phaseRequired(state, "recovering");
  if (phaseError || !state) return phaseError;
  const requirementError = sameIdentifier(context.params, state, "requirement_id");
  if (requirementError) return requirementError;
  const mcnError = sameIdentifier(context.params, state, "mcn_recommendation_id");
  if (mcnError) return mcnError;
  if (!state.lastSync) {
    return blocked("RECOVERY_NOT_CONFIRMED", "Ingest requires current-session sync evidence.");
  }

  const requestedTrigger = context.params.trigger;
  if (requestedTrigger === "manual") {
    if (
      context.recoveryTrigger !== "manual" ||
      state.lastSync.trigger !== "manual" ||
      !manualRecoveryIsCurrent(state, context.nowMs ?? Date.now()) ||
      state.lastSync.at < (state.manualRecoveryConfirmedAt ?? Number.POSITIVE_INFINITY)
    ) {
      return blocked(
        "RECOVERY_NOT_CONFIRMED",
        "Manual ingest requires confirmation followed by a matching successful sync.",
      );
    }
    return undefined;
  }
  if (
    requestedTrigger === "scheduled" &&
    context.recoveryTrigger !== "manual" &&
    context.trigger === "cron" &&
    state.lastSync.trigger === "scheduled"
  ) {
    return undefined;
  }
  return blocked(
    "RECOVERY_NOT_CONFIRMED",
    "Scheduled ingest requires matching current-session sync and ctx.trigger=cron.",
  );
}

function validatePhaseAndIdentity(
  toolName: string,
  context: GuardContext,
  state: RuntimeState | undefined,
): BeforeToolCallResult | undefined {
  switch (toolName) {
    case "validate_requirement":
      if (!state || state.phase === "requirement_draft" || state.phase === "feedback_routing") {
        return undefined;
      }
      return blocked("INVALID_PHASE", `Requirement validation is not allowed from ${state.phase}.`);
    case "search_creators": {
      const phaseError = phaseRequired(state, "requirement_ready");
      return phaseError || (state ? sameIdentifier(context.params, state, "requirement_id") : phaseError);
    }
    case "rank_mcns": {
      const phaseError = phaseRequired(state, "candidate_pool_ready");
      return phaseError || (state ? sameIdentifier(context.params, state, "candidate_pool_id") : phaseError);
    }
    case "select_inquiry_form_fields": {
      const phaseError = phaseRequired(state, "mcn_planning");
      return phaseError || (state ? sameIdentifier(context.params, state, "mcn_recommendation_id") : phaseError);
    }
    case "create_with_distributions":
      return validateDistributionGuard(context, state);
    case "sync_mcn_inquiry_status":
      return validateSyncGuard(context, state);
    case "ingest_mcn_submissions":
      return validateIngestGuard(context, state);
    case "manual_source_creators": {
      const phaseError = phaseRequired(state, "recovered");
      return phaseError || (state ? sameIdentifier(context.params, state, "requirement_id") : phaseError);
    }
    case "rank_creators": {
      const phaseError = phaseRequired(state, "recovered");
      if (phaseError || !state) return phaseError;
      const idError = sameIdentifier(context.params, state, "mcn_recommendation_id");
      if (idError) return idError;
      if (state.lastSync?.lifecycle_status !== "recovered") {
        return blocked("INVALID_PHASE", "Ranking requires the latest authoritative sync to be recovered.");
      }
      return undefined;
    }
    case "create_submission_batch": {
      const phaseError = phaseRequired(state, "recommendation_ready");
      return phaseError || (state ? sameIdentifier(context.params, state, "run_id") : phaseError);
    }
    case "record_client_feedback": {
      const phaseError = phaseRequired(state, "submission_batch_ready");
      return phaseError || (state ? sameIdentifier(context.params, state, "run_id") : phaseError);
    }
    default:
      return undefined;
  }
}

export function normalizeYpmcnToolName(toolName: string): string | null {
  for (const prefix of ["ypmcn__", "mcp__ypmcn__"]) {
    if (toolName.startsWith(prefix)) {
      const candidate = toolName.slice(prefix.length);
      return candidate.length > 0 ? candidate : null;
    }
  }
  return null;
}

export async function runBeforeToolCallGuards(
  context: GuardContext,
): Promise<BeforeToolCallResult | undefined> {
  if (SHELL_TOOLS.has(context.toolName) && PROVIDER_WRITE_PATTERN.test(shellText(context.params))) {
    return blocked(
      "INTEGRATION_REQUIRED",
      "Provider writes must use the declared MCP tool, not a shell or curl bypass.",
    );
  }

  const toolName = normalizeYpmcnToolName(context.toolName);
  if (!toolName) return undefined;
  if (!TARGET_TOOLS.has(toolName)) {
    return blocked("INTEGRATION_REQUIRED", `Tool ${toolName} is not executable in the mvp-v2 profile.`);
  }
  if (!nonemptyString(context.sessionKey)) {
    return blocked("INVALID_INPUT", "A current sessionKey is required for state-safe execution.");
  }
  if (toolName === "create_with_distributions" && context.params.preview_only !== false) {
    return blocked("SCHEMA_MISMATCH", "mvp-v2 forbids preview sends; preview_only must be false.");
  }

  const contractError = blockedByIssues(validateToolParams(toolName, context.params));
  if (contractError) return contractError;

  const state = context.store.get(context.sessionKey);
  const phaseError = validatePhaseAndIdentity(toolName, context, state);
  if (phaseError) return phaseError;

  if (!READ_ONLY_TOOLS.has(toolName) && !nonemptyString(context.toolCallId)) {
    return blocked("INVALID_INPUT", "A business write requires toolCallId evidence.");
  }
  return undefined;
}

export type { FieldDefinition };
