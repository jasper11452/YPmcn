import { randomUUID } from "node:crypto";

import {
  bindingFingerprint,
  CONFIRMATION_TTL_MS,
  type ConfirmationStatus,
  type GuardStore,
  type Json,
  save,
  sha256Text,
  store,
  text,
} from "./runtime-hook-state.js";

const PREFIXES = ["ypmcn__", "mcp__ypmcn__", "ypmcn-mcp__", "ypmcn-provider__"];
const EXTERNAL_SEND_TITLE = "企微外发确认";
const EXTERNAL_SEND_DESCRIPTION_MAX_LENGTH = 256;
const SEARCH_CONFIRMATION_HEADER = "供给确认";
const MCN_CONFIRMATION_HEADER = "MCN确认";
const FIELD_CONFIRMATION_HEADER = "字段确认";

type ApprovalResolution = "allow-once" | "allow-always" | "deny" | "timeout" | "cancelled";

export function normalize(name: string): string | undefined {
  for (const prefix of PREFIXES) {
    if (name.startsWith(prefix)) return name.slice(prefix.length) || undefined;
  }
  return undefined;
}

export function isAskTool(name: string): boolean {
  return name.replace(/[^a-z]/gi, "").toLowerCase() === "askuserquestion";
}

function selectedColumnName(value: unknown): string | undefined {
  if (text(value)) return value.trim();
  if (!value || typeof value !== "object") return undefined;
  const column = value as Json;
  return [column.name, column.field_name, column.key, column.field_key].find(text)?.trim();
}

function parsedJsonObject(value: string): Json | undefined {
  const trimmed = value.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  try {
    const parsed = JSON.parse(fenced?.[1] ?? trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Json : undefined;
  } catch {
    return undefined;
  }
}

function unwrap(value: any): any {
  if (typeof value === "string") {
    const parsed = parsedJsonObject(value);
    return parsed ? unwrap(parsed) : value;
  }
  if (!value || typeof value !== "object") return value;
  if ("result" in value) return unwrap(value.result);
  if ("structuredContent" in value) return unwrap(value.structuredContent);
  if (value.details && typeof value.details === "object" && "structuredContent" in value.details) {
    return unwrap(value.details.structuredContent);
  }
  if (Array.isArray(value.content)) {
    let fallback: string | undefined;
    for (const item of value.content) {
      if (!text(item?.text)) continue;
      fallback ??= item.text;
      const parsed = parsedJsonObject(item.text);
      if (parsed) return unwrap(parsed);
    }
    if (fallback) return fallback;
  }
  return value;
}

function successful(result: any): boolean {
  const root = unwrap(result);
  return Boolean(root && typeof root === "object" && (
    root.success === true || root.ok === true || root.status === "success"
  ) && root.isError !== true && root.error == null);
}

function selectedLabels(value: unknown): string[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = selectedLabels(item);
      if (found) return found;
    }
    return undefined;
  }
  for (const [key, item] of Object.entries(value as Json)) {
    if (/^selected_?labels?$/i.test(key) && Array.isArray(item)) {
      return item.filter((label): label is string => typeof label === "string").map((label) => label.trim());
    }
    const found = selectedLabels(item);
    if (found) return found;
  }
  return undefined;
}

function answerValues(value: unknown): string[] {
  const root = unwrap(value);
  if (typeof root === "string") return text(root) ? [root.trim()] : [];
  if (!root || typeof root !== "object") return [];
  const collect = (item: unknown): string[] => {
    if (typeof item === "string") return text(item) ? [item.trim()] : [];
    if (Array.isArray(item)) return item.flatMap(collect);
    if (!item || typeof item !== "object") return [];
    const labels = selectedLabels(item);
    return labels ?? Object.values(item as Json).flatMap(collect);
  };
  if (Object.prototype.hasOwnProperty.call(root, "answers")) {
    const answers = collect(root.answers);
    if (answers.length > 0) return answers;
  }
  if (Object.prototype.hasOwnProperty.call(root, "answer")) return collect(root.answer);
  return collect(selectedLabels(root));
}

function firstQuestionHeader(input: Json): string | undefined {
  const questions = Array.isArray(input.questions) ? input.questions : [input];
  if (questions.length !== 1 || !questions[0] || typeof questions[0] !== "object") return undefined;
  const question = questions[0] as Json;
  return [question.header, question.title].find(text)?.trim();
}

function findValue(root: unknown, keys: string[], accept: (value: unknown) => boolean): unknown {
  const queue: unknown[] = [unwrap(root)];
  const seen = new Set<unknown>();
  while (queue.length > 0) {
    const value = queue.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      queue.push(...value);
      continue;
    }
    const record = value as Json;
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(record, key) && accept(record[key])) return record[key];
    }
    queue.push(...Object.values(record));
  }
  return undefined;
}

function resultText(root: unknown, keys: string[]): string | undefined {
  const value = findValue(root, keys, (candidate) => text(candidate));
  return text(value) ? value.trim() : undefined;
}

function resultNumber(root: unknown, keys: string[]): number | undefined {
  const value = findValue(root, keys, (candidate) => typeof candidate === "number" && Number.isFinite(candidate));
  return typeof value === "number" ? value : undefined;
}

function appendWorkflowEvent(data: Json, event: Json): void {
  const events = Array.isArray(data.workflow_events) ? data.workflow_events : [];
  events.push(event);
  data.workflow_events = events.slice(-50);
}

function updateWorkflowForDecision(event: Json, input: Json, rootDir: string): void {
  if (event.error) return;
  const header = firstQuestionHeader(input);
  if (![SEARCH_CONFIRMATION_HEADER, MCN_CONFIRMATION_HEADER, FIELD_CONFIRMATION_HEADER].includes(header ?? "")) return;
  const answers = answerValues(event.result ?? event.message);
  if (answers.length !== 1) return;

  const current = store(rootDir);
  const workflow = current.data.workflow as Json;
  const answer = answers[0];
  workflow.last_user_command = answer;
  workflow.updated_at_ms = Date.now();

  if (header === SEARCH_CONFIRMATION_HEADER) {
    const approved = ["确认并开始MCN赛马", "按建议开始MCN赛马", "确认继续"].includes(answer);
    workflow.next_action = approved ? "rank_mcns" : "confirm_search_results";
    workflow.waiting_for = approved ? null : "user";
  } else if (header === MCN_CONFIRMATION_HEADER) {
    const approved = ["确认MCN方案", "确认继续"].includes(answer);
    workflow.next_action = approved ? "select_inquiry_form_fields" : "confirm_mcn_selection";
    workflow.waiting_for = approved ? null : "user";
  } else {
    const approved = ["确认字段", "确认继续"].includes(answer);
    workflow.next_action = approved ? "create_with_distributions" : "confirm_inquiry_fields";
    workflow.waiting_for = approved ? null : "user";
  }

  appendWorkflowEvent(current.data, {
    seq: Number(workflow.transition_seq ?? 0),
    kind: "user_command",
    header,
    answer,
    next_action: workflow.next_action,
    at_ms: workflow.updated_at_ms,
  });
  save(current.path, current.data);
}

function updateLocalWorkflow(event: Json, tool: string, input: Json, rootDir: string): void {
  const stateChangingTools = new Set([
    "validate_requirement", "search_creators", "rank_mcns", "select_inquiry_form_fields",
    "create_with_distributions", "sync_mcn_inquiry_status", "ingest_mcn_submissions",
    "manual_source_creators", "rank_creators", "audit_manual_adjustment",
    "create_submission_batch", "record_client_feedback",
  ]);
  if (!stateChangingTools.has(tool)) return;

  const current = store(rootDir);
  const workflow = current.data.workflow as Json;
  const ok = successful(event.error ? { isError: true } : event.result);
  const now = Date.now();
  workflow.last_tool = tool;
  workflow.last_tool_status = ok ? "success" : "failed";
  workflow.updated_at_ms = now;

  if (!ok) {
    workflow.next_action = `recover_${tool}`;
    workflow.waiting_for = "user";
  } else {
    workflow.transition_seq = Number(workflow.transition_seq ?? 0) + 1;
    const root = event.result;
    switch (tool) {
      case "validate_requirement": {
        workflow.phase = "requirement_ready";
        workflow.next_action = "search_creators";
        workflow.waiting_for = null;
        const requirementId = resultText(root, ["id", "requirement_id"]);
        if (requirementId) workflow.requirement_id = requirementId;
        if (text(input.payload?.platform)) workflow.platform = input.payload.platform.trim();
        if (Number.isInteger(input.payload?.quantityTotal)) workflow.quantity_total = input.payload.quantityTotal;
        break;
      }
      case "search_creators": {
        workflow.phase = "candidate_pool_ready";
        workflow.next_action = "confirm_search_results";
        workflow.waiting_for = "user";
        const matched = resultNumber(root, [
          "matched_creator_count", "eligible_creator_count", "candidate_count", "creator_count", "total_count",
        ]);
        const suggested = resultNumber(root, [
          "suggested_expansion_count", "recommended_expansion_count", "expansion_count",
        ]);
        if (matched !== undefined) workflow.matched_creator_count = matched;
        if (suggested !== undefined) workflow.suggested_expansion_count = suggested;
        break;
      }
      case "rank_mcns":
        workflow.phase = "mcn_planning";
        workflow.next_action = "confirm_mcn_selection";
        workflow.waiting_for = "user";
        if (Number.isInteger(input.minimum_mcn_count)) workflow.mcn_race_size = input.minimum_mcn_count;
        break;
      case "select_inquiry_form_fields":
        workflow.phase = "inquiry_fields_ready";
        workflow.next_action = "confirm_inquiry_fields";
        workflow.waiting_for = "user";
        break;
      case "create_with_distributions":
        workflow.phase = "waiting_mcn_return";
        workflow.next_action = "sync_mcn_inquiry_status";
        workflow.waiting_for = "provider";
        if (text(input.requirement_id)) workflow.requirement_id = input.requirement_id.trim();
        workflow.supplier_count = Array.isArray(input.supplierIds) ? input.supplierIds.length : 0;
        break;
      case "ingest_mcn_submissions":
        workflow.phase = "candidate_pool_enriched";
        workflow.next_action = "rank_creators";
        workflow.waiting_for = null;
        break;
      case "rank_creators": {
        workflow.phase = "recommendation_ready";
        workflow.next_action = "confirm_creator_recommendation";
        workflow.waiting_for = "user";
        const runId = resultText(root, ["run_id"]);
        if (runId) workflow.run_id = runId;
        break;
      }
      case "create_submission_batch":
        workflow.phase = "submission_batch_ready";
        workflow.next_action = "record_client_feedback";
        workflow.waiting_for = "user";
        break;
      case "record_client_feedback":
        workflow.phase = "feedback_routing";
        workflow.next_action = null;
        workflow.waiting_for = "user";
        break;
      case "sync_mcn_inquiry_status":
        workflow.next_action = "await_or_ingest_mcn_submissions";
        workflow.waiting_for = "provider";
        break;
      case "manual_source_creators":
        workflow.next_action = "create_with_distributions";
        workflow.waiting_for = null;
        break;
      case "audit_manual_adjustment":
        workflow.next_action = "confirm_creator_recommendation";
        workflow.waiting_for = "user";
        break;
    }
  }

  appendWorkflowEvent(current.data, {
    seq: Number(workflow.transition_seq ?? 0),
    kind: "tool_result",
    tool,
    status: workflow.last_tool_status,
    phase: workflow.phase,
    next_action: workflow.next_action,
    at_ms: now,
  });
  save(current.path, current.data);
}

export function renderLocalWorkflowContext(rootDir: string): string {
  const workflow = store(rootDir).data.workflow as Json;
  return [
    "YPmcn authoritative local orchestration state (state/confirmation_guard.json):",
    JSON.stringify(workflow),
    "Use this local phase/next_action instead of Provider workflow_state/allowed_actions for orchestration. Actual Tool results remain the authority for business facts and identifiers.",
  ].join("\n");
}

function createSummary(input: Json): Json {
  const description = text(input.description) ? input.description.trim() : "";
  return {
    requirement_id_sha256: text(input.requirement_id) ? sha256Text(input.requirement_id.trim()) : null,
    supplier_count: Array.isArray(input.supplierIds) ? input.supplierIds.length : 0,
    column_names: Array.isArray(input.columns) ? input.columns.map(selectedColumnName).filter(text) : [],
    description_sha256: description ? sha256Text(description) : null,
  };
}

function descriptionPreview(value: unknown): string {
  if (!text(value)) return "（未提供企微消息）";
  const parsed = parsedJsonObject(value);
  const rendered = parsed ? JSON.stringify(parsed) : value.trim();
  return rendered;
}

function truncateCodePoints(value: string, maximum: number): string {
  const points = Array.from(value);
  return points.length <= maximum ? value : `${points.slice(0, maximum - 1).join("")}…`;
}

function approvalDescription(input: Json, summary: Json): string {
  return truncateCodePoints([
    `这是不可逆外发操作。确认后将立即向 ${summary.supplier_count} 家机构发送企微消息。`,
    `回填字段：${summary.column_names.length > 0 ? summary.column_names.join("、") : "未选择"}`,
    `消息内容：${descriptionPreview(input.description)}`,
  ].join("\n"), EXTERNAL_SEND_DESCRIPTION_MAX_LENGTH);
}

function approvalResult(current: GuardStore, id: string, input: Json, summary: Json): Json {
  return {
    requireApproval: {
      title: EXTERNAL_SEND_TITLE,
      description: approvalDescription(input, summary),
      severity: "warning",
      timeoutMs: CONFIRMATION_TTL_MS,
      timeoutBehavior: "deny",
      onResolution: (decision: ApprovalResolution) => {
        const receipt = current.data.confirmations[id] as Json | undefined;
        if (!receipt || receipt.status !== "pending") return;
        receipt.status = decision === "allow-once" || decision === "allow-always"
          ? "in_flight" satisfies ConfirmationStatus
          : "denied" satisfies ConfirmationStatus;
        receipt.resolution = decision;
        receipt.updated_at_ms = Date.now();
        current.data.confirmations[id] = receipt;
        save(current.path, current.data);
      },
    },
  };
}

function authorizeExternalSend(input: Json, rootDir: string, toolCallId?: string): Json | undefined {
  const requestFingerprint = bindingFingerprint(input);
  const current = store(rootDir);
  const inFlight = Object.entries<Json>(current.data.confirmations).find(([, receipt]) =>
    receipt.kind === "external_send" && receipt.status === "in_flight" &&
    receipt.request_fingerprint === requestFingerprint && text(toolCallId) && receipt.tool_call_id === toolCallId
  );
  if (inFlight) return undefined;

  const pending = Object.entries<Json>(current.data.confirmations).find(([, receipt]) =>
    receipt.kind === "external_send" && receipt.status === "pending" &&
    receipt.request_fingerprint === requestFingerprint && receipt.tool_call_id === (toolCallId ?? null)
  );
  if (pending) return approvalResult(current, pending[0], input, pending[1].safe_summary);

  const id = randomUUID();
  const now = Date.now();
  const summary = createSummary(input);
  current.data.confirmations[id] = {
    kind: "external_send",
    request_fingerprint: requestFingerprint,
    input_fingerprint: requestFingerprint,
    safe_summary: summary,
    status: "pending" satisfies ConfirmationStatus,
    tool_call_id: toolCallId ?? null,
    created_at_ms: now,
    updated_at_ms: now,
    expires_at_ms: now + CONFIRMATION_TTL_MS,
  };
  current.data.latest_external_confirmation_id = id;
  save(current.path, current.data);
  return approvalResult(current, id, input, summary);
}

export function guardWorkflowTool(
  event: Json,
  tool: string,
  input: Json,
  _current: GuardStore,
  rootDir: string,
): Json | undefined {
  return tool === "create_with_distributions"
    ? authorizeExternalSend(input, rootDir, text(event.toolCallId) ? event.toolCallId.trim() : undefined)
    : undefined;
}

function recordExternalSendResult(event: Json, input: Json, rootDir: string): void {
  const current = store(rootDir);
  const requestFingerprint = bindingFingerprint(input);
  const afterToolCallId = text(event.toolCallId) ? event.toolCallId.trim() : undefined;
  const inFlight = Object.entries<Json>(current.data.confirmations).find(([, receipt]) => {
    if (receipt.kind !== "external_send" || receipt.status !== "in_flight") return false;
    if (afterToolCallId && text(receipt.tool_call_id)) return receipt.tool_call_id === afterToolCallId;
    return receipt.input_fingerprint === requestFingerprint;
  });
  if (!inFlight) return;
  const [id, receipt] = inFlight;
  receipt.status = successful(event.error ? { isError: true } : event.result) ? "consumed" : "unknown";
  receipt.updated_at_ms = Date.now();
  delete receipt.tool_call_id;
  current.data.confirmations[id] = receipt;
  save(current.path, current.data);
}

export function recordWorkflowToolResult(
  event: Json,
  raw: string,
  tool: string | undefined,
  input: Json,
  rootDir: string,
): void {
  if (isAskTool(raw)) {
    updateWorkflowForDecision(event, input, rootDir);
    return;
  }
  if (!tool) return;
  if (tool === "create_with_distributions") recordExternalSendResult(event, input, rootDir);
  updateLocalWorkflow(event, tool, input, rootDir);
}
