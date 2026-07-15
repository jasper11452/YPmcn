import { validateToolParams } from "../contract/validator.js";
import type { ValidationIssue } from "../contract/types.js";
import type { BeforeToolCallResult, GuardContext, RuntimeState } from "./types.js";

const TARGET_TOOLS = new Set([
  "validate_requirement", "search_creators", "rank_mcns",
  "select_inquiry_form_fields", "create_with_distributions",
  "sync_mcn_inquiry_status", "ingest_mcn_submissions",
  "manual_source_creators", "rank_creators", "create_submission_batch",
  "record_client_feedback", "get_recommendation_run_detail",
  "get_creator_detail", "audit_manual_adjustment", "get_workflow_state",
]);
const READ_ONLY_TOOLS = new Set([
  "select_inquiry_form_fields", "get_recommendation_run_detail",
  "get_creator_detail", "get_workflow_state",
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

function blocked(code: string, message: string): BeforeToolCallResult {
  return { block: true, blockReason: `${code}: ${message}` };
}

function blockedByIssues(issues: ValidationIssue[]): BeforeToolCallResult | undefined {
  if (issues.length === 0) return undefined;
  const summary = issues.slice(0, 3).map((entry) => `${entry.code} at ${entry.path}`).join("; ");
  return blocked(issues[0].code, summary);
}

function shellText(params: Record<string, unknown>): string {
  return ["command", "cmd", "script", "input"]
    .map((key) => params[key])
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

function phaseRequired(
  state: RuntimeState | undefined,
  expected: RuntimeState["phase"],
): BeforeToolCallResult | undefined {
  if (state?.phase === expected) return undefined;
  return blocked(
    "INVALID_PHASE",
    `Tool requires local projection ${expected}; current projection is ${state?.phase ?? "missing"}.`,
  );
}

function matchingString(
  actual: unknown,
  expected: string | undefined,
  label: string,
): BeforeToolCallResult | undefined {
  if (nonemptyString(expected) && actual === expected) return undefined;
  return blocked("STATE_CONFLICT", `${label} does not match current-session evidence.`);
}

function columnContainsField(column: Record<string, unknown>, fieldName: string): boolean {
  return Object.keys(column).includes(fieldName) ||
    Object.values(column).some((value) => value === fieldName);
}

function validateDistributionGuard(
  context: GuardContext,
  state: RuntimeState | undefined,
): BeforeToolCallResult | undefined {
  const phaseError = phaseRequired(state, "field_selection_ready");
  if (phaseError || !state) return phaseError;
  if (!nonemptyString(context.toolCallId)) {
    return blocked("INVALID_INPUT", "A provider write requires toolCallId evidence.");
  }
  const confirmation = state.sendConfirmation;
  if (
    !confirmation ||
    !SEND_ROLES.has(confirmation.operatorRole) ||
    confirmation.mcn_recommendation_id !== state.mcn_recommendation_id ||
    confirmation.supplyConfirmed !== true ||
    confirmation.mcnConfirmed !== true ||
    confirmation.messageConfirmed !== true
  ) {
    return blocked(
      "CONFIRMATION_REQUIRED",
      "Current target-MCN, supply, and outbound-message confirmations are required.",
    );
  }
  const selection = state.fieldSelection;
  if (!selection || selection.fieldNames.length === 0) {
    return blocked("FIELD_SELECTION_INVALID", "Current-session field description is missing.");
  }
  const columns = context.params.columns;
  if (
    !Array.isArray(columns) ||
    columns.length !== selection.fieldNames.length ||
    !columns.every((column, index) =>
      isRecord(column) && columnContainsField(column, selection.fieldNames[index]))
  ) {
    return blocked(
      "FIELD_SELECTION_INVALID",
      "Ordered columns must bind one-to-one to the confirmed field-description names.",
    );
  }
  if (!Array.isArray(context.params.supplierIds) || context.params.supplierIds.length === 0) {
    return blocked("INVALID_INPUT", "At least one supplierId is required for a distribution write.");
  }
  const deadline = context.params.deadline;
  if (
    !nonemptyString(deadline) ||
    !ISO_WITH_TIMEZONE.test(deadline) ||
    !Number.isFinite(Date.parse(deadline)) ||
    Date.parse(deadline) <= (context.nowMs ?? Date.now())
  ) {
    return blocked("INVALID_INPUT", "deadline must be a future timezone-qualified timestamp.");
  }
  return undefined;
}

function manualRecoveryIsCurrent(state: RuntimeState, nowMs: number): boolean {
  return typeof state.manualRecoveryConfirmedAt === "number" &&
    state.manualRecoveryConfirmedAt <= nowMs;
}

function scheduledContext(context: GuardContext): boolean {
  return context.recoveryTrigger === "scheduled" &&
    context.trigger === "cron" &&
    nonemptyString(context.params.cron_job_id);
}

function validateSyncGuard(
  context: GuardContext,
  state: RuntimeState | undefined,
): BeforeToolCallResult | undefined {
  if (!state) return blocked("INTEGRATION_REQUIRED", "Current-session send evidence is missing.");
  for (const [key, expected] of [
    ["requirement_id", state.requirement_id],
    ["project_id", state.project_id],
    ["mcn_id", state.mcn_id],
  ] as const) {
    const error = matchingString(context.params[key], expected, key);
    if (error) return error;
  }
  if (state.phase === "distribution_sync_pending") return undefined;
  if (state.phase === "waiting_return") {
    if (
      context.recoveryTrigger === "manual" &&
      manualRecoveryIsCurrent(state, context.nowMs ?? Date.now())
    ) return undefined;
    if (scheduledContext(context)) return undefined;
    return blocked(
      "RECOVERY_NOT_CONFIRMED",
      "Recovery sync requires current manual intent or scheduled cron evidence.",
    );
  }
  if (state.phase === "recovery_sync_pending") {
    if (!state.lastIngest || context.recoveryTrigger !== state.lastIngest.trigger) {
      return blocked("STATE_CONFLICT", "Final sync does not match current ingest evidence.");
    }
    if (state.lastIngest.trigger === "scheduled" && !scheduledContext(context)) {
      return blocked("RECOVERY_NOT_CONFIRMED", "Scheduled final sync requires cron evidence.");
    }
    return undefined;
  }
  if (state.phase === "recovered") {
    return blocked("RECOVERY_ALREADY_TERMINAL", "Local recovery sequence is already complete.");
  }
  return blocked("INVALID_PHASE", `Sync is not allowed from local projection ${state.phase}.`);
}

function validateIngestGuard(
  context: GuardContext,
  state: RuntimeState | undefined,
): BeforeToolCallResult | undefined {
  const phaseError = phaseRequired(state, "recovering");
  if (phaseError || !state) return phaseError;
  const inquiryError = matchingString(context.params.inquiry_id, state.inquiry_id, "inquiry_id");
  if (inquiryError) return inquiryError;
  if (!state.lastSync) {
    return blocked("RECOVERY_NOT_CONFIRMED", "Ingest requires successful current-session sync evidence.");
  }
  if (
    context.recoveryTrigger === "manual" &&
    manualRecoveryIsCurrent(state, context.nowMs ?? Date.now()) &&
    state.lastSync.trigger === "manual" &&
    state.lastSync.at >= (state.manualRecoveryConfirmedAt ?? Number.POSITIVE_INFINITY)
  ) return undefined;
  if (
    context.recoveryTrigger === "scheduled" &&
    context.trigger === "cron" &&
    state.lastSync.trigger === "scheduled"
  ) return undefined;
  return blocked("RECOVERY_NOT_CONFIRMED", "Ingest requires matching manual or cron sync evidence.");
}

function validatePhaseAndIdentity(
  toolName: string,
  context: GuardContext,
  state: RuntimeState | undefined,
): BeforeToolCallResult | undefined {
  switch (toolName) {
    case "validate_requirement":
      return !state || state.phase === "requirement_draft" || state.phase === "feedback_routing"
        ? undefined
        : blocked("INVALID_PHASE", `Requirement validation is not allowed from ${state.phase}.`);
    case "search_creators": {
      const error = phaseRequired(state, "requirement_ready");
      return error || matchingString(context.params.id, state?.requirement_id, "id");
    }
    case "rank_mcns": {
      const error = phaseRequired(state, "search_completed");
      return error || matchingString(context.params.id, state?.requirement_id, "id");
    }
    case "select_inquiry_form_fields":
      return phaseRequired(state, "mcn_planning");
    case "create_with_distributions":
      return validateDistributionGuard(context, state);
    case "sync_mcn_inquiry_status":
      return validateSyncGuard(context, state);
    case "ingest_mcn_submissions":
      return validateIngestGuard(context, state);
    case "manual_source_creators":
      return phaseRequired(state, "recovered");
    case "rank_creators": {
      const error = phaseRequired(state, "recovered");
      return error || matchingString(
        context.params.requirement_id,
        state?.requirement_id,
        "requirement_id",
      );
    }
    case "create_submission_batch": {
      const error = phaseRequired(state, "recommendation_ready");
      return error || matchingString(context.params.run_id, state?.run_id, "run_id");
    }
    case "record_client_feedback": {
      const error = phaseRequired(state, "submission_batch_ready");
      return error || matchingString(context.params.run_id, state?.run_id, "run_id");
    }
    case "audit_manual_adjustment":
      return matchingString(context.params.run_id, state?.run_id, "run_id");
    default:
      return undefined;
  }
}

const TOOL_NAME_PREFIXES = [
  "ypmcn__",
  "mcp__ypmcn__",
  "ypmcn-mcp__",
  "ypmcn-provider__",
] as const;

export function normalizeYpmcnToolName(toolName: string): string | null {
  for (const prefix of TOOL_NAME_PREFIXES) {
    if (!toolName.startsWith(prefix)) continue;
    const candidate = toolName.slice(prefix.length);
    return candidate.length > 0 ? candidate : null;
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
    return blocked("INTEGRATION_REQUIRED", `Tool ${toolName} is not executable in the current profile.`);
  }
  if (!nonemptyString(context.sessionKey)) {
    return blocked("INVALID_INPUT", "A current sessionKey is required for state-safe execution.");
  }
  const contractError = blockedByIssues(validateToolParams(toolName, context.params));
  if (contractError) return contractError;
  const state = context.store.get(context.sessionKey);
  if (state?.lastResultIssue?.toolName === toolName && !READ_ONLY_TOOLS.has(toolName)) {
    return blocked(
      state.lastResultIssue.code,
      "Previous result lacked explicit evidence; reconcile before retrying this write.",
    );
  }
  const phaseError = validatePhaseAndIdentity(toolName, context, state);
  if (phaseError) return phaseError;
  if (!READ_ONLY_TOOLS.has(toolName) && !nonemptyString(context.toolCallId)) {
    return blocked("INVALID_INPUT", "A business write requires toolCallId evidence.");
  }
  return undefined;
}
