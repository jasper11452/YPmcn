import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  bindingFingerprint,
  canonical,
  CONFIRMATION_TTL_MS,
  deny,
  type ConfirmationStatus,
  type GuardStore,
  type Json,
  save,
  sha256Text,
  store,
  text,
} from "./runtime-hook-state.js";

const PREFIXES = ["ypmcn__", "mcp__ypmcn__", "ypmcn-mcp__", "ypmcn-provider__"];
const WECOM_TEMPLATE_ID = "ypmcn-wecom-inquiry-v1";
const WECOM_TEMPLATE_RELATIVE_PATH = join("skills", "media-assistant", "assets", "wecom_inquiry_template.txt");
const CONFIRMATION_MARKER = /\[YP_CONFIRMATION:([0-9a-f-]{36})\]/i;
const CONFIRM_SEND_LABEL = "确认发送";
const EXTERNAL_SEND_CONFIRMATION_HEADER = "外发确认";

type ConfirmationMarker = { id: string; kind: "external_send" };
type MessageTemplateBinding = {
  message_template_id: string;
  message_template_sha256: string;
};

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
  if (!value || typeof value !== "object") return undefined;
  const column = value as Json;
  return [column.name, column.field_name, column.key, column.field_key].find(text)?.trim();
}

function messageTemplateBinding(rootDir: string): MessageTemplateBinding | undefined {
  try {
    const template = readFileSync(join(rootDir, WECOM_TEMPLATE_RELATIVE_PATH), "utf8");
    if (!text(template)) return undefined;
    return {
      message_template_id: WECOM_TEMPLATE_ID,
      message_template_sha256: sha256Text(template),
    };
  } catch {
    return undefined;
  }
}

function createSummary(input: Json, template: MessageTemplateBinding): Json {
  return {
    project_name: text(input.projectName) ? input.projectName.trim() : null,
    supplier_count: Array.isArray(input.supplierIds) ? input.supplierIds.length : 0,
    deadline: text(input.deadline) ? input.deadline.trim() : null,
    column_names: Array.isArray(input.columns) ? input.columns.map(selectedColumnName) : [],
    ...template,
  };
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
  return Boolean(root && typeof root === "object" && root.success === true && root.isError !== true && root.error == null);
}

function findMarker(value: unknown): ConfirmationMarker | undefined {
  const match = canonical(value).match(CONFIRMATION_MARKER);
  return match?.[1] ? { id: match[1].toLowerCase(), kind: "external_send" } : undefined;
}

function externalConfirmationQuestions(input: Json): Json[] {
  const questions = Array.isArray(input.questions) ? input.questions : [input];
  return questions.filter((question: unknown): question is Json => {
    if (!question || typeof question !== "object") return false;
    const item = question as Json;
    return [item.header, item.title].find(text)?.trim() === EXTERNAL_SEND_CONFIRMATION_HEADER;
  });
}

export function isExternalConfirmationAsk(input: Json): boolean {
  return Boolean(findMarker(input)) || externalConfirmationQuestions(input).length > 0;
}

function markerQuestion(input: Json, marker: ConfirmationMarker): Json | undefined {
  const token = `[YP_CONFIRMATION:${marker.id}]`;
  const candidates = Array.isArray(input.questions) ? input.questions : [input];
  const matches = candidates.filter((item): item is Json =>
    Boolean(item && typeof item === "object" && text(item.question) && item.question.toLowerCase().includes(token.toLowerCase()))
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function confirmationOptions(question: Json): boolean {
  if (!Array.isArray(question.options) || question.options.length < 2 || question.options.length > 6) return false;
  const labels = question.options.map((option: unknown) => {
    if (typeof option === "string") return option.trim();
    return option && typeof option === "object" && text((option as Json).label)
      ? (option as Json).label.trim()
      : "";
  });
  const allowed = new Set([CONFIRM_SEND_LABEL, "需要修改", "自定义消息", "稍后再说", "取消"]);
  return new Set(labels).size === labels.length &&
    labels.includes(CONFIRM_SEND_LABEL) && labels.includes("需要修改") &&
    labels.every((label) => allowed.has(label));
}

function externalSummaryText(summary: Json): string {
  return [
    `【外发对象】项目名=${summary.project_name}｜机构数=${summary.supplier_count}`,
    `【外发内容】截止时间=${summary.deadline}｜表单字段=${JSON.stringify(summary.column_names)}`,
    `【固定模板】消息模板=${summary.message_template_id}`,
    "【影响】确认后真实企微外发",
  ].join(" ");
}

export function validateMarkedAsk(input: Json, data: Json): Json | undefined {
  let marker = findMarker(input);
  if (!marker) {
    const externalQuestions = externalConfirmationQuestions(input);
    if (externalQuestions.length === 0) return undefined;
    if (externalQuestions.length !== 1) {
      return deny("BLOCKED_CONFIRMATION_MISMATCH", "External-send confirmation must contain exactly one bound question.");
    }
    const latestId = text(data.latest_external_confirmation_id) ? data.latest_external_confirmation_id : undefined;
    const receipt = latestId ? data.confirmations[latestId] as Json | undefined : undefined;
    if (!latestId || !receipt || receipt.kind !== "external_send" || receipt.status !== "pending") {
      return deny("INTEGRATION_REQUIRED", "External-send confirmation needs one current pending distribution request.");
    }
    externalQuestions[0].question = `${externalSummaryText(receipt.safe_summary)}｜[YP_CONFIRMATION:${latestId}]`;
    marker = { id: latestId, kind: "external_send" };
  }

  const receipt = data.confirmations?.[marker.id] as Json | undefined;
  if (!receipt || receipt.kind !== "external_send" || receipt.status !== "pending") {
    return deny("INTEGRATION_REQUIRED", "The confirmation marker is unknown, expired, or no longer pending.");
  }
  const question = markerQuestion(input, marker);
  if (!question) {
    return deny("BLOCKED_CONFIRMATION_MISMATCH", "The marker must appear in exactly one AskUserQuestion question body.");
  }
  if (!confirmationOptions(question)) {
    return deny("BLOCKED_CONFIRMATION_MISMATCH", "External-send options must include 确认发送 and 需要修改; optional custom-message and cancel/later choices are allowed.");
  }
  question.question = `${externalSummaryText(receipt.safe_summary ?? {})}｜[YP_CONFIRMATION:${marker.id}]`;
  return undefined;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function rejectedOutcome(value: unknown): boolean {
  const root = unwrap(value);
  const rendered = typeof root === "string" ? root : canonical(root);
  return /(?:"status"\s*:\s*"(?:rejected|denied|cancelled|canceled|timeout)"|拒绝|否决|取消|超时|timeout|rejected|denied|cancelled|canceled|user\s+denied\s+the\s+operation)/i.test(rendered);
}

function approvalOutcome(value: unknown): "approved" | "denied" | "unknown" {
  const root = unwrap(value);
  if (rejectedOutcome(root)) return "denied";
  if (typeof root === "string") {
    const flattened = root.trim();
    const selected = [CONFIRM_SEND_LABEL, "需要修改", "自定义消息", "稍后再说", "取消"]
      .find((label) => flattened === label || new RegExp(`[：:]\\s*${escapeRegex(label)}\\s*$`).test(flattened));
    if (selected) return selected === CONFIRM_SEND_LABEL ? "approved" : "denied";
  }
  const answers = answerValues(root);
  if (answers.length > 0) return answers.length === 1 && answers[0] === CONFIRM_SEND_LABEL ? "approved" : "denied";
  return "unknown";
}

function authorizeExternalSend(input: Json, rootDir: string, toolCallId?: string): Json | undefined {
  const template = messageTemplateBinding(rootDir);
  if (!template) {
    return deny("INTEGRATION_REQUIRED", "The packaged fixed WeCom inquiry template is missing or empty.");
  }
  const requestFingerprint = bindingFingerprint({ input, template });
  const current = store(rootDir);
  const existing = Object.entries<Json>(current.data.confirmations).find(([, receipt]) =>
    receipt.kind === "external_send" && receipt.request_fingerprint === requestFingerprint &&
    ["pending", "approved"].includes(receipt.status)
  );

  if (existing) {
    const [id, receipt] = existing;
    if (receipt.status === "approved") {
      receipt.status = "in_flight" satisfies ConfirmationStatus;
      receipt.tool_call_id = toolCallId ?? null;
      receipt.updated_at_ms = Date.now();
      current.data.confirmations[id] = receipt;
      save(current.path, current.data);
      return undefined;
    }
    return deny(
      "YP_CONFIRMATION_REQUIRED",
      `confirmation_id=${id}; call AskUserQuestion with header “${EXTERNAL_SEND_CONFIRMATION_HEADER}”. The Hook binds and renders the authoritative summary. Include “${CONFIRM_SEND_LABEL}” and “需要修改”. Only “${CONFIRM_SEND_LABEL}” authorizes this request.`,
    );
  }

  const id = randomUUID();
  const now = Date.now();
  current.data.confirmations[id] = {
    kind: "external_send",
    request_fingerprint: requestFingerprint,
    input_fingerprint: bindingFingerprint(input),
    safe_summary: createSummary(input, template),
    status: "pending" satisfies ConfirmationStatus,
    created_at_ms: now,
    updated_at_ms: now,
    expires_at_ms: now + CONFIRMATION_TTL_MS,
  };
  current.data.latest_external_confirmation_id = id;
  save(current.path, current.data);
  return deny(
    "YP_CONFIRMATION_REQUIRED",
    `confirmation_id=${id}; call AskUserQuestion with header “${EXTERNAL_SEND_CONFIRMATION_HEADER}”. The Hook binds and renders the authoritative summary. Include “${CONFIRM_SEND_LABEL}” and “需要修改”.`,
  );
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

export function recordWorkflowToolResult(
  event: Json,
  raw: string,
  tool: string | undefined,
  input: Json,
  rootDir: string,
): void {
  if (isAskTool(raw)) {
    const marker = findMarker(input);
    if (!marker) return;
    const current = store(rootDir);
    const receipt = current.data.confirmations[marker.id] as Json | undefined;
    if (!receipt || receipt.kind !== "external_send" || receipt.status !== "pending") return;
    const questionFailure = validateMarkedAsk(input, current.data);
    if (questionFailure) {
      receipt.status = "denied";
      receipt.denial_reason = questionFailure.blockReason;
    } else {
      const outcome = approvalOutcome(event.error ? { status: "rejected" } : event.result ?? event.message);
      receipt.status = outcome === "approved" ? "approved" : outcome === "denied" ? "denied" : "pending";
      if (outcome === "unknown") receipt.last_result_error = "confirmation_result_unrecognized";
      else delete receipt.last_result_error;
    }
    receipt.updated_at_ms = Date.now();
    current.data.confirmations[marker.id] = receipt;
    save(current.path, current.data);
    return;
  }

  if (tool !== "create_with_distributions") return;
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
