import { validateToolParams } from "./contract/validator.js";
import {
  guardValidateRequirement,
  readyRequirementFailure,
  recordReadyRequirementCorrection,
  settleReadyRequirement,
} from "./runtime-hook-requirement.js";
import {
  denyStructured,
  type Json,
  store,
  text,
} from "./runtime-hook-state.js";
import {
  guardWorkflowTool,
  isAskTool,
  normalize,
  promptRequirementGate,
  recordTrustedIds,
  recordWorkflowToolResult,
  settlePromptRequirementGate,
  successfulValidateRequirement,
  validateMarkedAsk,
} from "./runtime-hook-workflow.js";

export { beginPromptTurn, withStateScope } from "./runtime-hook-state.js";

const SHELL_TOOLS = new Set(["bash", "exec", "shell", "powershell", "pwsh"]);
const PROVIDER_WRITE_TARGET = /create[-_]with[-_]distributions|\/api\/projects\/create-with-distributions/i;
const SHELL_WRITE_CLIENT = /\b(?:curl|wget|httpie)\b|\bInvoke-(?:WebRequest|RestMethod)\b|\brequests\.(?:post|put|patch|delete)\b|\baxios\.(?:post|put|patch|delete)\b|\bfetch\s*\(|\b(?:mcp|mcporter|openclaw)\b[^\n]*(?:call|invoke|run)\b/i;

export function beforeTool(event: Json, _ctx: Json, rootDir: string): Json | undefined {
  const raw = String(event.toolName ?? event.name ?? "").trim();
  const input = event.params && typeof event.params === "object" ? event.params :
    event.arguments && typeof event.arguments === "object" ? event.arguments : {};
  const tool = normalize(raw);

  const current = store(rootDir);
  const promptGateFailure = promptRequirementGate(raw, input, current);
  if (promptGateFailure) return promptGateFailure;
  const readyFailure = readyRequirementFailure(tool, input, current, isAskTool(raw));
  if (readyFailure) return readyFailure;
  if (SHELL_TOOLS.has(raw.toLowerCase())) {
    const command = [input.command, input.cmd, input.script, input.input].filter(text).join("\n");
    return PROVIDER_WRITE_TARGET.test(command) && SHELL_WRITE_CLIENT.test(command)
      ? denyStructured("INTEGRATION_REQUIRED", "Provider writes must use the declared MCP tool, not shell or curl.")
      : undefined;
  }
  if (isAskTool(raw)) return validateMarkedAsk(input, current.data);

  if (!tool) return undefined;
  const issues = validateToolParams(tool, input);
  if (issues.length > 0) {
    const first = issues[0];
    const failure = denyStructured(first.code, `${first.path}: ${first.message}`);
    return tool === "validate_requirement"
      ? recordReadyRequirementCorrection(input, current, failure)
      : failure;
  }
  if (tool === "validate_requirement") {
    const requirementFailure = guardValidateRequirement(input, current);
    if (requirementFailure) return recordReadyRequirementCorrection(input, current, requirementFailure);
  }
  return guardWorkflowTool(event, tool, input, current, rootDir);
}

export function afterTool(event: Json, _ctx: Json, rootDir: string): void {
  const raw = String(event.toolName ?? event.name ?? "").trim();
  const input = event.params && typeof event.params === "object" ? event.params :
    event.arguments && typeof event.arguments === "object" ? event.arguments : {};
  const tool = normalize(raw);
  if (tool) recordTrustedIds(event, tool, rootDir);
  if (tool === "validate_requirement") {
    const succeeded = successfulValidateRequirement(event);
    settleReadyRequirement(input, rootDir, succeeded);
    settlePromptRequirementGate(rootDir, succeeded);
    return;
  }
  recordWorkflowToolResult(event, raw, tool, input, rootDir);
}

export function endSession(_event: Json, _ctx: Json, rootDir: string): void {
  // YP Action does not reliably provide session lifecycle events. Cleanup is TTL-based
  // and is run on every tool hook; session_end is only an opportunistic sweep.
  store(rootDir);
}
