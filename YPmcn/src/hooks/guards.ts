import { validateFieldSelection, validateToolParams } from "../contract/validator.js";
import type { ValidationIssue } from "../contract/types.js";
import type {
  BeforeToolCallResult,
  FieldDefinition,
  GuardContext,
  RuntimeState,
  WorkflowAction,
  WorkflowIdentifiers,
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

const HOST_PREFIX = "mcp__ypmcn__";
const READ_ONLY_TOOLS = new Set([
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

const ACTIONS_BY_TOOL: Readonly<Record<string, readonly WorkflowAction[]>> = {
  validate_requirement: ["validate_requirement"],
  search_creators: ["search_creators"],
  rank_mcns: ["rank_mcns"],
  select_inquiry_form_fields: ["select_inquiry_form_fields"],
  create_with_distributions: ["create_with_distributions"],
  sync_mcn_inquiry_status: ["refresh_recovery", "finalize_recovery"],
  ingest_mcn_submissions: ["request_recovery"],
  rank_creators: ["rank_creators"],
  create_submission_batch: ["create_submission_batch"],
  record_client_feedback: ["record_client_feedback"],
};

const IDENTIFIER_BY_TOOL: Readonly<
  Partial<Record<string, Array<keyof WorkflowIdentifiers>>>
> = {
  search_creators: ["requirement_id"],
  rank_mcns: ["candidate_pool_id"],
  select_inquiry_form_fields: ["mcn_recommendation_id"],
  create_with_distributions: ["mcn_recommendation_id"],
  sync_mcn_inquiry_status: ["requirement_id", "mcn_recommendation_id"],
  ingest_mcn_submissions: ["requirement_id", "mcn_recommendation_id"],
  manual_source_creators: ["requirement_id"],
  rank_creators: ["mcn_recommendation_id"],
  create_submission_batch: ["run_id"],
  record_client_feedback: ["run_id"],
};

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

function authoritativeState(
  state: RuntimeState | undefined,
): RuntimeState["authoritative"] | undefined {
  if (!state || state.requiresWorkflowRefresh || !state.authoritative) return undefined;
  return state.authoritative;
}

function requireAuthoritativeIdentifiers(
  toolName: string,
  params: Record<string, unknown>,
  state: RuntimeState | undefined,
): BeforeToolCallResult | undefined {
  const identifiers = authoritativeState(state)?.identifiers;
  for (const key of IDENTIFIER_BY_TOOL[toolName] ?? []) {
    const expected = identifiers?.[key];
    if (!nonemptyString(expected)) {
      return blocked(
        "STATE_COMBINATION_INVALID",
        `Server projection is missing the authoritative ${key}.`,
      );
    }
    if (params[key] !== expected) {
      return blocked("STATE_CONFLICT", `${key} does not match the server workflow projection.`);
    }
  }
  return undefined;
}

function authorizeBusinessAction(
  toolName: string,
  state: RuntimeState | undefined,
): BeforeToolCallResult | undefined {
  const authority = authoritativeState(state);
  if (!authority) {
    return blocked(
      "STATE_COMBINATION_INVALID",
      "A current get_workflow_state projection with state_version and allowed_actions is required.",
    );
  }
  const actions = ACTIONS_BY_TOOL[toolName];
  if (!actions) {
    return blocked(
      "STATE_COMBINATION_INVALID",
      `Tool ${toolName} has no server allowed_actions authorization in the approved workflow.`,
    );
  }
  const active = actions.filter((action) => authority.allowed_actions.includes(action));
  if (active.length === 0) {
    return blocked(
      "STATE_COMBINATION_INVALID",
      `Server allowed_actions does not authorize ${toolName}.`,
    );
  }
  if (toolName === "sync_mcn_inquiry_status") {
    if (active.length > 1) {
      return blocked("STATE_COMBINATION_INVALID", "Recovery operation is ambiguous in server allowed_actions.");
    }
    if (
      active[0] === "finalize_recovery" &&
      !nonemptyString(authority.identifiers?.recovery_operation_id)
    ) {
      return blocked(
        "STATE_COMBINATION_INVALID",
        "Final recovery sync requires a server recovery_operation_id.",
      );
    }
  }
  if (
    toolName === "rank_creators" &&
    authority.lifecycle_status !== "recovered" &&
    authority.lifecycle_status !== "closed"
  ) {
    return blocked(
      "STATE_COMBINATION_INVALID",
      "Ranking requires a server lifecycle_status of recovered or closed.",
    );
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
  if (!nonemptyString(context.operatorRole) || !SEND_ROLES.has(context.operatorRole)) {
    return blocked("CONFIRMATION_REQUIRED", "A known media/procurement operator role is required.");
  }
  if (
    context.gateState?.supplyConfirmed !== true ||
    context.gateState.mcnConfirmed !== true ||
    context.gateState.messageConfirmed !== true
  ) {
    return blocked(
      "CONFIRMATION_REQUIRED",
      "Supply, target-MCN, and outbound-message confirmations are all required.",
    );
  }
  const authority = authoritativeState(state);
  if (!authority || !nonemptyString(authority.identifiers?.selection_result_id)) {
    return blocked(
      "STATE_COMBINATION_INVALID",
      "A current server selection_result_id is required before a distribution write.",
    );
  }
  if (!state?.fieldSelection) {
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

function isDisallowedBusinessAlias(toolName: string): boolean {
  if (TARGET_TOOLS.has(toolName)) return true;
  if (!toolName.startsWith("mcp__")) return false;
  const candidate = toolName.split("__").at(-1) ?? "";
  return TARGET_TOOLS.has(candidate);
}

/** Return a contract tool only for its exact Host-qualified business identity. */
export function normalizeYpmcnToolName(toolName: string): string | null {
  if (!toolName.startsWith(HOST_PREFIX)) return null;
  const candidate = toolName.slice(HOST_PREFIX.length);
  return TARGET_TOOLS.has(candidate) ? candidate : null;
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
  if (!toolName) {
    return isDisallowedBusinessAlias(context.toolName)
      ? blocked(
        "INTEGRATION_REQUIRED",
        "Business Hook events must use mcp__ypmcn__<contract-tool> exactly.",
      )
      : undefined;
  }

  if (!nonemptyString(context.sessionKey)) {
    return blocked("INVALID_INPUT", "A current sessionKey is required for state-safe execution.");
  }
  if (toolName === "create_with_distributions" && context.params.preview_only !== false) {
    return blocked("SCHEMA_MISMATCH", "mvp-v2 forbids preview sends; preview_only must be false.");
  }
  const contractError = blockedByIssues(validateToolParams(toolName, context.params));
  if (contractError) return contractError;

  if (READ_ONLY_TOOLS.has(toolName)) return undefined;
  const state = context.store.get(context.sessionKey);
  const isInitialValidationBootstrap = toolName === "validate_requirement" && state === undefined;
  if (!isInitialValidationBootstrap) {
    const authorizationError = authorizeBusinessAction(toolName, state);
    if (authorizationError) return authorizationError;
    const identifierError = requireAuthoritativeIdentifiers(toolName, context.params, state);
    if (identifierError) return identifierError;
    if (toolName === "create_with_distributions") {
      const distributionError = validateDistributionGuard(context, state);
      if (distributionError) return distributionError;
    }
  }
  if (!nonemptyString(context.toolCallId)) {
    return blocked("INVALID_INPUT", "A business write requires toolCallId evidence.");
  }
  return undefined;
}

export type { FieldDefinition };
