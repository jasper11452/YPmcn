import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type Json = Record<string, any>;

const PREFIXES = ["ypmcn__", "mcp__ypmcn__", "ypmcn-mcp__", "ypmcn-provider__"];
const SHELL_TOOLS = new Set(["bash", "exec", "shell", "powershell", "pwsh"]);
const READ_ONLY = new Set([
  "select_inquiry_form_fields", "get_recommendation_run_detail", "get_creator_detail",
  "get_workflow_state",
]);
const ALLOWED: Record<string, Set<string>> = Object.fromEntries(Object.entries({
  requirement_draft: ["validate_requirement"], requirement_ready: ["search_creators"],
  search_completed: ["rank_mcns"], mcn_planning: ["select_inquiry_form_fields"],
  field_selection_ready: ["create_with_distributions"], distribution_sync_pending: ["sync_mcn_inquiry_status"],
  waiting_return: ["sync_mcn_inquiry_status"], recovering: ["ingest_mcn_submissions"],
  recovery_sync_pending: ["sync_mcn_inquiry_status"], recovered: ["manual_source_creators", "rank_creators"],
  recommendation_ready: ["audit_manual_adjustment", "create_submission_batch"], submission_batch_ready: ["record_client_feedback"],
  feedback_routing: [], blocked: [], closed: [],
}).map(([phase, tools]) => [phase, new Set(tools)]));
const ID_RULES: Record<string, Array<[string, string]>> = {
  search_creators: [["id", "requirement_id"]], rank_mcns: [["id", "requirement_id"]],
  rank_creators: [["requirement_id", "requirement_id"]], create_submission_batch: [["run_id", "run_id"]],
  record_client_feedback: [["run_id", "run_id"]], audit_manual_adjustment: [["run_id", "run_id"]],
};
const TTL_MS = 86_400_000;

function text(value: unknown): value is string { return typeof value === "string" && value.trim() !== ""; }
function normalize(name: string): string | undefined {
  for (const prefix of PREFIXES) if (name.startsWith(prefix)) return name.slice(prefix.length) || undefined;
  return undefined;
}
function statePath(rootDir: string): string { return process.env.YPMCN_STATE_FILE || join(rootDir, "state", "session_guard.json"); }
function load(path: string): Json {
  try { const value = JSON.parse(readFileSync(path, "utf8")); return value && typeof value === "object" ? value : {}; }
  catch { return {}; }
}
function save(path: string, data: Json): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, JSON.stringify(data, null, 2), "utf8");
  renameSync(temp, path);
}
function deny(code: string, message: string): Json { return { block: true, blockReason: `${code}: ${message}` }; }
function sessionKey(event: Json, ctx: Json): string { return ctx.sessionKey ?? ctx.sessionId ?? event.runId ?? ""; }
function unwrap(value: any): any {
  if (!value || typeof value !== "object") return value;
  if ("result" in value) return unwrap(value.result);
  if ("structuredContent" in value) return unwrap(value.structuredContent);
  if (Array.isArray(value.content)) for (const item of value.content) if (text(item?.text)) {
    try { return unwrap(JSON.parse(item.text)); } catch { /* keep looking */ }
  }
  return value;
}
function evidence(result: any): Json | undefined {
  const root = unwrap(result);
  return root && typeof root === "object" && root.success === true && root.isError !== true && root.error == null ? root : undefined;
}
function explicit(root: Json, ...keys: string[]): string | undefined {
  for (const source of [root.data, root]) if (source && typeof source === "object")
    for (const key of keys) if (text(source[key])) return source[key];
  return undefined;
}
function fresh(): Json { return {
  phase: "requirement_draft", ids: {},
  confirmations: { supplyConfirmed: false, mcnConfirmed: false, messageConfirmed: false },
  field_selection: { selected: false, fieldNames: [] }, sync: { first_sync_done: false, latest_lifecycle: null },
  manualRecoveryConfirmedAt: null,
}; }
function issue(session: Json, tool: string, code = "WRITE_RESULT_UNKNOWN"): void {
  session.lastResultIssue = { toolName: tool, code, at: Date.now() };
}

export function beforeTool(event: Json, ctx: Json, rootDir: string): Json | undefined {
  const raw = String(event.toolName ?? "").trim();
  const input = event.params && typeof event.params === "object" ? event.params : {};
  if (SHELL_TOOLS.has(raw.toLowerCase())) {
    const command = [input.command, input.cmd, input.script, input.input].filter(text).join("\n");
    return /create[-_]with[-_]distributions|\/api\/projects\/create-with-distributions/i.test(command)
      ? deny("INTEGRATION_REQUIRED", "Provider writes must use the declared MCP tool, not a shell or curl bypass.") : undefined;
  }
  const tool = normalize(raw);
  if (!tool) return undefined;
  const known = READ_ONLY.has(tool) || Object.values(ALLOWED).some((tools) => tools.has(tool));
  if (!known) return undefined;
  const key = sessionKey(event, ctx);
  if (!text(key) && !READ_ONLY.has(tool)) return deny("INVALID_INPUT", "A current sessionKey is required for state-safe execution.");
  const session = load(statePath(rootDir)).sessions?.[key];
  if (session?.lastResultIssue && !READ_ONLY.has(tool)) return deny(session.lastResultIssue.code ?? "WRITE_RESULT_UNKNOWN", "Previous result lacked explicit evidence; reconcile before retrying this write.");
  if (session) {
    const phase = session.phase ?? "requirement_draft";
    if ((phase === "closed" || phase === "recovered") && !READ_ONLY.has(tool) && !(phase === "recovered" && ["manual_source_creators", "rank_creators"].includes(tool)))
      return deny("RECOVERY_ALREADY_TERMINAL", `current phase is terminal: ${phase}, tool ${tool} is blocked`);
    if (!READ_ONLY.has(tool) && !ALLOWED[phase]?.has(tool)) return deny("BLOCKED_PHASE_MISMATCH", `current phase=${phase}, tool=${tool} not allowed`);
    for (const [parameter, id] of ID_RULES[tool] ?? []) {
      if (!text(input[parameter])) return deny("BLOCKED_MISSING_SEMANTIC_IDS", `missing ${parameter} for tool=${tool}`);
      if (session.ids?.[id] && input[parameter] !== session.ids[id]) return deny("BLOCKED_SEMANTIC_ID_MISMATCH", `${parameter} mismatch: expected=${session.ids[id]}, actual=${input[parameter]}`);
    }
  }
  if (["create_with_distributions", "sync_mcn_inquiry_status", "ingest_mcn_submissions"].includes(tool) && !session)
    return deny("INTEGRATION_REQUIRED", "Current-session send evidence is missing.");
  if (tool === "audit_manual_adjustment") {
    if (!session) return deny("INTEGRATION_REQUIRED", "Current-session run evidence is missing.");
    if (!text(input.operator_id)) return deny("INVALID_INPUT", "operator_id is required for an audit write.");
    if (!Array.isArray(input.adjustments) || input.adjustments.length === 0)
      return deny("INVALID_INPUT", "adjustments must contain at least one audit entry.");
    if (input.adjustments.some((adjustment: unknown) => !adjustment || typeof adjustment !== "object" || !text((adjustment as Json).reason)))
      return deny("INVALID_INPUT", "Every audit adjustment requires a non-empty reason.");
  }
  if (tool === "create_with_distributions") {
    for (const flag of ["supplyConfirmed", "mcnConfirmed", "messageConfirmed"]) if (session.confirmations?.[flag] !== true) return deny("BLOCKED_CONFIRMATION_REQUIRED", `${flag}=false`);
    if (!session.field_selection?.selected) return deny("BLOCKED_FIELD_SELECTION_REQUIRED", "field selection not confirmed");
    if (!Array.isArray(input.supplierIds) || input.supplierIds.length === 0) return deny("BLOCKED_EMPTY_SUPPLIER", "supplierIds must be non-empty");
    if (!text(input.deadline) || Number.isNaN(Date.parse(input.deadline)) || Date.parse(input.deadline) <= Date.now()) return deny("BLOCKED_INVALID_DEADLINE", "deadline must be future ISO-8601 with timezone");
  }
  if (!READ_ONLY.has(tool) && !text(event.toolCallId)) return deny("INVALID_INPUT", "A business write requires toolCallId evidence.");
  return undefined;
}

export function afterTool(event: Json, ctx: Json, rootDir: string): void {
  const tool = normalize(String(event.toolName ?? ""));
  const key = sessionKey(event, ctx);
  if (!tool || !text(key)) return;
  const path = statePath(rootDir), data = load(path); data.schema_version ??= 1; data.sessions ??= {};
  for (const [id, value] of Object.entries<Json>(data.sessions)) if ((value?._updated_at_ms ?? 0) < Date.now() - TTL_MS) delete data.sessions[id];
  let session = data.sessions[key] as Json | undefined;
  const result = evidence(event.error ? { isError: true } : event.result);
  if (!result) { if (session) { issue(session, tool); session._updated_at_ms = Date.now(); save(path, data); } return; }
  session ??= fresh(); const input = event.params ?? {}; delete session.lastResultIssue;
  if (tool === "validate_requirement") { const id = explicit(result, "requirement_id", "id"); if (!id) issue(session, tool); else { session.phase = "requirement_ready"; session.ids.requirement_id = id; } }
  else if (tool === "search_creators" && session.phase === "requirement_ready" && input.id === session.ids.requirement_id) session.phase = "search_completed";
  else if (tool === "rank_mcns" && session.phase === "search_completed" && input.id === session.ids.requirement_id) { const id = explicit(result, "mcn_recommendation_id", "id"); if (!id) issue(session, tool); else { session.phase = "mcn_planning"; session.ids.mcn_recommendation_id = id; } }
  else if (tool === "select_inquiry_form_fields" && session.phase === "mcn_planning") { const description = explicit(result, "description"); const names = description?.split("\n").map((line) => line.split(/[：:]/)[0]?.trim()).filter(Boolean); if (!names?.length) issue(session, tool, "INTEGRATION_REQUIRED"); else { session.phase = "field_selection_ready"; session.field_selection = { selected: true, fieldNames: names }; } }
  else if (tool === "create_with_distributions" && session.phase === "field_selection_ready") { const project = explicit(result, "project_id"), mcn = explicit(result, "mcn_id"); if (!project || !mcn) issue(session, tool); else { session.phase = "distribution_sync_pending"; Object.assign(session.ids, { project_id: project, mcn_id: mcn }); } }
  else if (tool === "rank_creators" && session.phase === "recovered" && input.requirement_id === session.ids.requirement_id) { const id = explicit(result, "run_id"); if (!id) issue(session, tool); else { session.phase = "recommendation_ready"; session.ids.run_id = id; } }
  else if (tool === "create_submission_batch" && session.phase === "recommendation_ready" && input.run_id === session.ids.run_id) session.phase = "submission_batch_ready";
  else if (tool === "record_client_feedback" && session.phase === "submission_batch_ready" && input.run_id === session.ids.run_id) session.phase = "feedback_routing";
  session._updated_at_ms = Date.now(); data.sessions[key] = session; save(path, data);
}

export function endSession(event: Json, ctx: Json, rootDir: string): void {
  const path = statePath(rootDir), data = load(path), sessions = data.sessions;
  if (!sessions || typeof sessions !== "object") return;
  const key = sessionKey(event, ctx); let changed = false;
  if (text(key) && key in sessions) { delete sessions[key]; changed = true; }
  for (const [id, value] of Object.entries<Json>(sessions)) if ((value?._updated_at_ms ?? 0) < Date.now() - TTL_MS) { delete sessions[id]; changed = true; }
  if (changed) save(path, data);
}
