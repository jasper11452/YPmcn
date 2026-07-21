import {
  denyStructured,
  type Json,
  save,
  sha256Text,
  store,
  text,
} from "./runtime-hook-state.js";
import {
  guardWorkflowTool,
  normalize,
  recordWorkflowToolResult,
} from "./runtime-hook-workflow.js";

export { withStateScope } from "./runtime-hook-state.js";

const SHELL_TOOLS = new Set(["bash", "exec", "shell", "powershell", "pwsh"]);
const PROVIDER_WRITE_TARGET = /create[-_]with[-_]distributions|\/api\/projects\/create-with-distributions/i;
const SHELL_WRITE_CLIENT = /\b(?:curl|wget|httpie)\b|\bInvoke-(?:WebRequest|RestMethod)\b|\brequests\.(?:post|put|patch|delete)\b|\baxios\.(?:post|put|patch|delete)\b|\bfetch\s*\(|\b(?:mcp|mcporter|openclaw)\b[^\n]*(?:call|invoke|run)\b/i;
const LAST_RANK_CREATORS_REQUIREMENT_KEY = "last_rank_creators_requirement_id_sha256";

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

export function beforeTool(
  event: Json,
  _ctx: Json,
  rootDir: string,
  onNotice?: (message: string) => void,
): Json | undefined {
  const raw = String(event.toolName ?? event.name ?? "").trim();
  const input = event.params && typeof event.params === "object" ? event.params :
    event.arguments && typeof event.arguments === "object" ? event.arguments : {};
  const tool = normalize(raw);

  if (SHELL_TOOLS.has(raw.toLowerCase())) {
    const command = [input.command, input.cmd, input.script, input.input].filter(text).join("\n");
    return PROVIDER_WRITE_TARGET.test(command) && SHELL_WRITE_CLIENT.test(command)
      ? denyStructured("INTEGRATION_REQUIRED", "Provider writes must use the declared MCP tool, not shell or curl.")
      : undefined;
  }
  if (tool === "rank_creators") {
    const notice = repeatedRankCreatorsNotice(input, rootDir);
    if (notice) onNotice?.(notice);
    return undefined;
  }
  if (tool !== "create_with_distributions" && tool !== "manual_source_creators") return undefined;
  const current = store(rootDir);
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
    tool,
    input,
    rootDir,
  );
}

export function endSession(_event: Json, _ctx: Json, rootDir: string): void {
  // Confirmation access performs TTL cleanup; session_end is an opportunistic sweep.
  store(rootDir);
}
