import {
  denyStructured,
  type Json,
  save,
  sha256Text,
  store,
  text,
} from "./runtime-hook-state.js";
import {
  activateExecutionUnitForTool,
  guardWorkflowTool,
  isAskTool,
  normalize,
  recordWorkflowToolResult,
} from "./runtime-hook-workflow.js";

export { withStateScope } from "./runtime-hook-state.js";

const SHELL_TOOLS = new Set(["bash", "exec", "shell", "powershell", "pwsh"]);
const GUARDED_REQUIREMENT_TOOLS = new Set([
  "select_inquiry_form_fields",
  "validate_requirement",
  "search_creators",
  "rank_mcns",
  "sync_mcn_inquiry_status",
  "manual_source_creators",
  "rank_creators",
  "create_submission_batch",
  "get_workflow_state",
]);
const EXECUTION_UNIT_ROUTED_TOOLS = new Set([
  "validate_requirement", "search_creators", "rank_mcns", "select_inquiry_form_fields",
  "create_with_distributions", "sync_mcn_inquiry_status", "ingest_mcn_submissions",
  "manual_source_creators", "rank_creators", "audit_manual_adjustment",
  "create_submission_batch", "record_client_feedback",
]);
const PROVIDER_WRITE_TARGET = /create[-_]with[-_]distributions|\/api\/projects\/create-with-distributions/i;
const SHELL_WRITE_CLIENT = /\b(?:curl|wget|httpie)\b|\bInvoke-(?:WebRequest|RestMethod)\b|\brequests\.(?:post|put|patch|delete)\b|\baxios\.(?:post|put|patch|delete)\b|\bfetch\s*\(|\b(?:mcp|mcporter|openclaw)\b[^\n]*(?:call|invoke|run)\b/i;
const LAST_RANK_CREATORS_REQUIREMENT_KEY = "last_rank_creators_requirement_id_sha256";
const MAX_POST_RANK_QUESTION_LINE_LENGTH = 40;
const POST_RANK_QUESTION_HEADERS = new Set(["赛后补量", "MCN确认", "字段确认"]);

export const REPEATED_RANK_CREATORS_NOTICE = "已根据需求进行排序，请注意";

function repeatedRankCreatorsNotice(input: Json, rootDir: string): string | undefined {
  const current = store(rootDir);
  const requirementHash = text(input.requirement_id)
    ? sha256Text(input.requirement_id.trim())
    : undefined;
  const previousHash = current.data[LAST_RANK_CREATORS_REQUIREMENT_KEY];

  if (requirementHash) current.data[LAST_RANK_CREATORS_REQUIREMENT_KEY] = requirementHash;
  else delete current.data[LAST_RANK_CREATORS_REQUIREMENT_KEY];
  save(current.path, current.data);

  return requirementHash && previousHash === requirementHash
    ? REPEATED_RANK_CREATORS_NOTICE
    : undefined;
}

export function isExternalSendAttempt(event: Json): boolean {
  const raw = String(event.toolName ?? event.name ?? "").trim();
  const input = event.params && typeof event.params === "object" ? event.params :
    event.arguments && typeof event.arguments === "object" ? event.arguments : {};
  if (SHELL_TOOLS.has(raw.toLowerCase())) {
    const command = [input.command, input.cmd, input.script, input.input].filter(text).join("\n");
    return PROVIDER_WRITE_TARGET.test(command) && SHELL_WRITE_CLIENT.test(command);
  }
  return normalize(raw) === "create_with_distributions";
}

export function isManualSourcingAttempt(event: Json): boolean {
  const raw = String(event.toolName ?? event.name ?? "").trim();
  return normalize(raw) === "manual_source_creators";
}

export function isRequirementGuardAttempt(event: Json): boolean {
  const raw = String(event.toolName ?? event.name ?? "").trim();
  const tool = normalize(raw);
  return Boolean(tool && GUARDED_REQUIREMENT_TOOLS.has(tool));
}

export function beforeTool(
  event: Json,
  _ctx: Json,
  rootDir: string,
  onNotice?: (message: string) => void,
  scopeAvailable = false,
): Json | undefined {
  const raw = String(event.toolName ?? event.name ?? "").trim();
  const input = event.params && typeof event.params === "object" ? event.params :
    event.arguments && typeof event.arguments === "object" ? event.arguments : {};
  const tool = normalize(raw);

  if (isAskTool(raw)) {
    const questions = Array.isArray(input.questions) ? input.questions : [];
    const allQuestionsAreMultiline = questions.length > 0 && questions.every((question: unknown) =>
      Boolean(
        question && typeof question === "object" && !Array.isArray(question) &&
        text((question as Json).question) && /\r?\n/.test((question as Json).question),
      )
    );
    if (!allQuestionsAreMultiline) {
      return denyStructured(
        "INVALID_INPUT",
        "Every AskUserQuestion question must use multiline prompt text. Put non-option prompt content on separate lines; option labels and descriptions are exempt.",
      );
    }
    const postRankQuestionsHaveShortLines = questions.every((question: unknown) => {
      if (!question || typeof question !== "object" || Array.isArray(question)) return false;
      const item = question as Json;
      if (!POST_RANK_QUESTION_HEADERS.has(String(item.header ?? "").trim())) return true;
      return String(item.question).split(/\r?\n/u).every((line) =>
        Array.from(line).length <= MAX_POST_RANK_QUESTION_LINE_LENGTH
      );
    });
    if (!postRankQuestionsHaveShortLines) {
      return denyStructured(
        "INVALID_INPUT",
        `After rank_mcns, every AskUserQuestion prompt line must be at most ${MAX_POST_RANK_QUESTION_LINE_LENGTH} Unicode characters. Preserve existing line breaks and wrap longer non-option text onto additional lines.`,
      );
    }
    return undefined;
  }

  if (SHELL_TOOLS.has(raw.toLowerCase())) {
    const command = [input.command, input.cmd, input.script, input.input].filter(text).join("\n");
    return PROVIDER_WRITE_TARGET.test(command) && SHELL_WRITE_CLIENT.test(command)
      ? denyStructured("INTEGRATION_REQUIRED", "Provider writes must use the declared MCP tool, not shell or curl.")
      : undefined;
  }
  let current = tool && EXECUTION_UNIT_ROUTED_TOOLS.has(tool) ? store(rootDir) : undefined;
  if (current && tool) activateExecutionUnitForTool(current, tool, input);
  if (tool === "rank_creators") {
    const notice = repeatedRankCreatorsNotice(input, rootDir);
    if (notice) onNotice?.(notice);
  }
  if (!tool || (!GUARDED_REQUIREMENT_TOOLS.has(tool) && tool !== "create_with_distributions")) {
    return undefined;
  }
  if (tool === "search_creators" && !scopeAvailable) {
    onNotice?.("YPmcn search_creators is using primary-key shape validation only because the host omitted session context.");
  }
  current ??= store(rootDir);
  return guardWorkflowTool(event, tool, input, current, rootDir, scopeAvailable);
}

export function afterTool(event: Json, _ctx: Json, rootDir: string): void {
  const raw = String(event.toolName ?? event.name ?? "").trim();
  const input = event.params && typeof event.params === "object" ? event.params :
    event.arguments && typeof event.arguments === "object" ? event.arguments : {};
  const tool = normalize(raw);
  recordWorkflowToolResult(
    event,
    raw,
    tool,
    input,
    rootDir,
  );
}

export function endSession(_event: Json, _ctx: Json, rootDir: string): void {
  // Confirmation access performs TTL cleanup; session_end is an opportunistic sweep.
  store(rootDir);
}
