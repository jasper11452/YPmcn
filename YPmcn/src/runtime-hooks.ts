import {
  denyStructured,
  type Json,
  store,
  text,
} from "./runtime-hook-state.js";
import {
  guardWorkflowTool,
  isAskTool,
  isExternalConfirmationAsk,
  normalize,
  recordWorkflowToolResult,
  validateMarkedAsk,
} from "./runtime-hook-workflow.js";

export { withStateScope } from "./runtime-hook-state.js";

const SHELL_TOOLS = new Set(["bash", "exec", "shell", "powershell", "pwsh"]);
const PROVIDER_WRITE_TARGET = /create[-_]with[-_]distributions|\/api\/projects\/create-with-distributions/i;
const SHELL_WRITE_CLIENT = /\b(?:curl|wget|httpie)\b|\bInvoke-(?:WebRequest|RestMethod)\b|\brequests\.(?:post|put|patch|delete)\b|\baxios\.(?:post|put|patch|delete)\b|\bfetch\s*\(|\b(?:mcp|mcporter|openclaw)\b[^\n]*(?:call|invoke|run)\b/i;

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

export function beforeTool(event: Json, _ctx: Json, rootDir: string): Json | undefined {
  const raw = String(event.toolName ?? event.name ?? "").trim();
  const input = event.params && typeof event.params === "object" ? event.params :
    event.arguments && typeof event.arguments === "object" ? event.arguments : {};
  const tool = normalize(raw);
  const askTool = isAskTool(raw);

  if (SHELL_TOOLS.has(raw.toLowerCase())) {
    const command = [input.command, input.cmd, input.script, input.input].filter(text).join("\n");
    return PROVIDER_WRITE_TARGET.test(command) && SHELL_WRITE_CLIENT.test(command)
      ? denyStructured("INTEGRATION_REQUIRED", "Provider writes must use the declared MCP tool, not shell or curl.")
      : undefined;
  }
  if (!askTool && tool !== "create_with_distributions") return undefined;
  if (askTool && !isExternalConfirmationAsk(input)) return undefined;

  const current = store(rootDir);
  if (askTool) return validateMarkedAsk(input, current.data);
  if (tool !== "create_with_distributions") return undefined;
  return guardWorkflowTool(event, tool, input, current, rootDir);
}

export function afterTool(event: Json, _ctx: Json, rootDir: string): void {
  const raw = String(event.toolName ?? event.name ?? "").trim();
  const input = event.params && typeof event.params === "object" ? event.params :
    event.arguments && typeof event.arguments === "object" ? event.arguments : {};
  const tool = normalize(raw);
  recordWorkflowToolResult(
    event,
    raw,
    tool === "create_with_distributions" ? tool : undefined,
    input,
    rootDir,
  );
}

export function endSession(_event: Json, _ctx: Json, rootDir: string): void {
  // Confirmation access performs TTL cleanup; session_end is an opportunistic sweep.
  store(rootDir);
}
