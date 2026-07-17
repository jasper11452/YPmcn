import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { validateToolParams } from "./contract/validator.js";

type Json = Record<string, any>;
type ConfirmationStatus = "pending" | "approved" | "in_flight" | "consumed" | "unknown" | "denied";

const PREFIXES = ["ypmcn__", "mcp__ypmcn__", "ypmcn-mcp__", "ypmcn-provider__"];
const SHELL_TOOLS = new Set(["bash", "exec", "shell", "powershell", "pwsh"]);
const CONFIRMATION_TTL_MS = 10 * 60 * 1_000;
const CONFIRMATION_MARKER = /\[YP_CONFIRMATION:([0-9a-f-]{36})\]/i;
const SUPPLY_PLAN_MARKER = /\[YP_SUPPLY_PLAN_CONFIRMATION:([0-9a-f-]{36})\]/i;
const CONFIRM_SEND_LABEL = "确认发送";
const CONFIRM_SUPPLY_PLAN_LABEL = "确认供给方案";
const ISO_WITH_TIMEZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const PROVIDER_WRITE_TARGET = /create[-_]with[-_]distributions|\/api\/projects\/create-with-distributions/i;
const SHELL_WRITE_CLIENT = /\b(?:curl|wget|httpie)\b|\bInvoke-(?:WebRequest|RestMethod)\b|\brequests\.(?:post|put|patch|delete)\b|\baxios\.(?:post|put|patch|delete)\b|\bfetch\s*\(|\b(?:mcp|mcporter|openclaw)\b[^\n]*(?:call|invoke|run)\b/i;
const SCHEMA_PROBE = /(?:^|[^a-z])(?:schema[_ -]?check|dry[_ -]?run|probe)(?:$|[^a-z])/i;

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function normalize(name: string): string | undefined {
  for (const prefix of PREFIXES) {
    if (name.startsWith(prefix)) return name.slice(prefix.length) || undefined;
  }
  return undefined;
}

function isAskTool(name: string): boolean {
  return name.replace(/[^a-z]/gi, "").toLowerCase() === "askuserquestion";
}

function statePath(rootDir: string): string {
  return join(rootDir, "state", "confirmation_guard.json");
}

function load(path: string): Json {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function save(path: string, data: Json): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, JSON.stringify(data, null, 2), "utf8");
  renameSync(temp, path);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Json;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

function deny(code: string, message: string): Json {
  return { block: true, blockReason: `${code}: ${message}` };
}

function store(rootDir: string): { path: string; data: Json } {
  const path = statePath(rootDir);
  const data = load(path);
  data.schema_version = 2;
  data.confirmations ??= {};
  let changed = false;
  const now = Date.now();
  for (const [id, receipt] of Object.entries<Json>(data.confirmations)) {
    if (!receipt || Number(receipt.expires_at_ms ?? 0) <= now) {
      delete data.confirmations[id];
      changed = true;
    }
  }
  if (changed) save(path, data);
  return { path, data };
}

function saveReceipt(rootDir: string, id: string, receipt: Json): void {
  const current = store(rootDir);
  current.data.confirmations[id] = receipt;
  save(current.path, current.data);
}

function createSummary(input: Json): Json {
  return {
    project_name: text(input.projectName) ? input.projectName : null,
    supplier_count: Array.isArray(input.supplierIds) ? input.supplierIds.length : 0,
    deadline: text(input.deadline) ? input.deadline : null,
    field_count: Array.isArray(input.columns) ? input.columns.length : 0,
  };
}

function unwrap(value: any): any {
  if (!value || typeof value !== "object") return value;
  if ("result" in value) return unwrap(value.result);
  if ("structuredContent" in value) return unwrap(value.structuredContent);
  if (Array.isArray(value.content)) {
    for (const item of value.content) {
      if (text(item?.text)) {
        try { return unwrap(JSON.parse(item.text)); } catch { return item.text; }
      }
    }
  }
  return value;
}

function successful(result: any): boolean {
  const root = unwrap(result);
  return Boolean(root && typeof root === "object" && root.success === true && root.isError !== true && root.error == null);
}

function findMarker(value: unknown): { id: string; kind: "external_send" | "supply_plan" } | undefined {
  const encoded = canonical(value);
  const send = encoded.match(CONFIRMATION_MARKER);
  if (send?.[1]) return { id: send[1].toLowerCase(), kind: "external_send" };
  const supplyPlan = encoded.match(SUPPLY_PLAN_MARKER);
  if (supplyPlan?.[1]) return { id: supplyPlan[1].toLowerCase(), kind: "supply_plan" };
  return undefined;
}

function answerText(value: unknown): string {
  const root = unwrap(value);
  if (typeof root === "string") return root;
  return canonical(root);
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

function approvalOutcome(value: unknown, expectedLabel: string): "approved" | "denied" | "unknown" {
  const root = unwrap(value);
  const answer = answerText(root);
  if (/"status"\s*:\s*"(?:rejected|timeout)"/i.test(answer)) return "denied";
  const labels = selectedLabels(root);
  if (labels) return labels.length === 1 && labels[0] === expectedLabel ? "approved" : "denied";
  if (/拒绝|超时|timeout|rejected|需要修改|调整方案|自定义/i.test(answer)) return "denied";
  if (typeof root === "string" && root.trim() === expectedLabel) return "approved";
  return "unknown";
}

function validateExternalSend(input: Json): Json | undefined {
  if (!Array.isArray(input.supplierIds) || input.supplierIds.length === 0) {
    return deny("BLOCKED_EMPTY_SUPPLIER", "supplierIds must be non-empty.");
  }
  if (
    !text(input.deadline) ||
    !ISO_WITH_TIMEZONE.test(input.deadline) ||
    Number.isNaN(Date.parse(input.deadline)) ||
    Date.parse(input.deadline) <= Date.now()
  ) {
    return deny("BLOCKED_INVALID_DEADLINE", "deadline must be a future ISO-8601 datetime with timezone.");
  }
  return undefined;
}

function authorizeExternalSend(input: Json, rootDir: string): Json | undefined {
  const basicFailure = validateExternalSend(input);
  if (basicFailure) return basicFailure;

  const requestFingerprint = fingerprint(input);
  const current = store(rootDir);
  const approved = Object.entries<Json>(current.data.confirmations).find(([, receipt]) =>
    receipt.kind === "external_send" && receipt.request_fingerprint === requestFingerprint && receipt.status === "approved"
  );
  if (approved) {
    const [id, receipt] = approved;
    receipt.status = "in_flight" satisfies ConfirmationStatus;
    receipt.updated_at_ms = Date.now();
    current.data.confirmations[id] = receipt;
    save(current.path, current.data);
    return undefined;
  }

  const existing = Object.entries<Json>(current.data.confirmations).find(([, receipt]) =>
    receipt.kind === "external_send" && receipt.request_fingerprint === requestFingerprint && ["pending", "in_flight", "unknown"].includes(receipt.status)
  );
  if (existing) {
    const [id, receipt] = existing;
    if (receipt.status === "unknown" || receipt.status === "in_flight") {
      return deny("WRITE_RESULT_UNKNOWN", `confirmation_id=${id}; call get_workflow_state to reconcile before any retry.`);
    }
    return deny(
      "YP_CONFIRMATION_REQUIRED",
      `confirmation_id=${id}; call AskUserQuestion with marker [YP_CONFIRMATION:${id}] and a self-contained send summary. Only the exact option “${CONFIRM_SEND_LABEL}” authorizes an unchanged retry.`,
    );
  }

  const id = randomUUID();
  const now = Date.now();
  current.data.confirmations[id] = {
    kind: "external_send",
    request_fingerprint: requestFingerprint,
    safe_summary: createSummary(input),
    status: "pending" satisfies ConfirmationStatus,
    created_at_ms: now,
    updated_at_ms: now,
    expires_at_ms: now + CONFIRMATION_TTL_MS,
  };
  save(current.path, current.data);
  return deny(
    "YP_CONFIRMATION_REQUIRED",
    `confirmation_id=${id}; call AskUserQuestion with marker [YP_CONFIRMATION:${id}] and a self-contained send summary. Offer “${CONFIRM_SEND_LABEL}” and “需要修改”; do not add a reject option.`,
  );
}

function authorizeSupplyPlan(input: Json, rootDir: string): Json | undefined {
  const requestFingerprint = fingerprint(input);
  const current = store(rootDir);
  const approved = Object.entries<Json>(current.data.confirmations).find(([, receipt]) =>
    receipt.kind === "supply_plan" && receipt.request_fingerprint === requestFingerprint && receipt.status === "approved"
  );
  if (approved) {
    const [id, receipt] = approved;
    receipt.status = "in_flight" satisfies ConfirmationStatus;
    receipt.updated_at_ms = Date.now();
    current.data.confirmations[id] = receipt;
    save(current.path, current.data);
    return undefined;
  }

  const existing = Object.entries<Json>(current.data.confirmations).find(([, receipt]) =>
    receipt.kind === "supply_plan" && receipt.request_fingerprint === requestFingerprint && ["pending", "in_flight", "unknown"].includes(receipt.status)
  );
  if (existing) {
    const [id, receipt] = existing;
    if (receipt.status === "unknown" || receipt.status === "in_flight") {
      return deny("WRITE_RESULT_UNKNOWN", `supply_plan_confirmation_id=${id}; call get_workflow_state before retrying rank_mcns.`);
    }
    return deny(
      "YP_SUPPLY_PLAN_CONFIRMATION_REQUIRED",
      `confirmation_id=${id}; call AskUserQuestion with marker [YP_SUPPLY_PLAN_CONFIRMATION:${id}]. The popup must show demand_count, database_candidate_count, supply_demand_ratio, recommended_mcn_count, recommended_manual_count, and recommended_mcn_manual_ratio. Only “${CONFIRM_SUPPLY_PLAN_LABEL}” authorizes the unchanged rank_mcns call and all rank parameters are fingerprint-bound.`,
    );
  }

  const id = randomUUID();
  const now = Date.now();
  current.data.confirmations[id] = {
    kind: "supply_plan",
    request_fingerprint: requestFingerprint,
    safe_summary: { requirement_id: input.id, platform: input.platform },
    status: "pending" satisfies ConfirmationStatus,
    created_at_ms: now,
    updated_at_ms: now,
    expires_at_ms: now + CONFIRMATION_TTL_MS,
  };
  save(current.path, current.data);
  return deny(
    "YP_SUPPLY_PLAN_CONFIRMATION_REQUIRED",
    `confirmation_id=${id}; call AskUserQuestion with marker [YP_SUPPLY_PLAN_CONFIRMATION:${id}]. The popup must show demand_count, database_candidate_count, supply_demand_ratio, recommended_mcn_count, recommended_manual_count, and recommended_mcn_manual_ratio. Offer “${CONFIRM_SUPPLY_PLAN_LABEL}” and “调整方案”.`,
  );
}

export function beforeTool(event: Json, _ctx: Json, rootDir: string): Json | undefined {
  const raw = String(event.toolName ?? event.name ?? "").trim();
  const input = event.params && typeof event.params === "object" ? event.params :
    event.arguments && typeof event.arguments === "object" ? event.arguments : {};

  store(rootDir);
  if (SHELL_TOOLS.has(raw.toLowerCase())) {
    const command = [input.command, input.cmd, input.script, input.input].filter(text).join("\n");
    return PROVIDER_WRITE_TARGET.test(command) && SHELL_WRITE_CLIENT.test(command)
      ? deny("INTEGRATION_REQUIRED", "Provider writes must use the declared MCP tool, not shell or curl.")
      : undefined;
  }
  if (isAskTool(raw)) return undefined;

  const tool = normalize(raw);
  if (!tool) return undefined;
  const issues = validateToolParams(tool, input);
  if (issues.length > 0) {
    const first = issues[0];
    return deny(first.code, `${first.path}: ${first.message}`);
  }
  if (tool === "validate_requirement") {
    const payload = input.payload && typeof input.payload === "object" ? input.payload : input;
    const labels = [payload.projectName, payload.brandName, payload.note].filter(text).join(" ");
    if (SCHEMA_PROBE.test(labels)) {
      return deny("BLOCKED_NO_DRY_RUN", "validate_requirement always writes; inspect the host tool schema without calling it.");
    }
    if (payload.status !== "ready") {
      return deny("BLOCKED_REQUIREMENT_INCOMPLETE", "payload.status must be ready; clarify every missing or ambiguous required value before validation.");
    }
    const emptyField = Object.entries(payload).find(([, value]) =>
      value === null || (typeof value === "string" && value.trim() === "") ||
      (Array.isArray(value) && value.length === 0)
    );
    if (emptyField) {
      return deny("BLOCKED_REQUIREMENT_INCOMPLETE", `payload.${emptyField[0]} is empty; omit optional fields and clarify required fields before validation.`);
    }
  }
  if (tool === "rank_mcns") return authorizeSupplyPlan(input, rootDir);
  if (tool === "create_with_distributions") return authorizeExternalSend(input, rootDir);
  return undefined;
}

export function afterTool(event: Json, _ctx: Json, rootDir: string): void {
  const raw = String(event.toolName ?? event.name ?? "").trim();
  const input = event.params && typeof event.params === "object" ? event.params :
    event.arguments && typeof event.arguments === "object" ? event.arguments : {};
  const current = store(rootDir);

  if (isAskTool(raw)) {
    const marker = findMarker(input);
    if (!marker || !current.data.confirmations[marker.id]) return;
    const receipt = current.data.confirmations[marker.id] as Json;
    if (receipt.kind !== marker.kind) return;
    if (receipt.status !== "pending") return;
    const expectedLabel = marker.kind === "external_send" ? CONFIRM_SEND_LABEL : CONFIRM_SUPPLY_PLAN_LABEL;
    const outcome = approvalOutcome(event.error ? { status: "rejected" } : event.result ?? event.message, expectedLabel);
    receipt.status = outcome === "approved" ? "approved" : outcome === "denied" ? "denied" : "pending";
    receipt.updated_at_ms = Date.now();
    current.data.confirmations[marker.id] = receipt;
    save(current.path, current.data);
    return;
  }

  const tool = normalize(raw);
  if (tool !== "create_with_distributions" && tool !== "rank_mcns") return;
  const kind = tool === "create_with_distributions" ? "external_send" : "supply_plan";
  const requestFingerprint = fingerprint(input);
  const inFlight = Object.entries<Json>(current.data.confirmations).find(([, receipt]) =>
    receipt.kind === kind && receipt.request_fingerprint === requestFingerprint && receipt.status === "in_flight"
  );
  if (!inFlight) return;
  const [id, receipt] = inFlight;
  receipt.status = successful(event.error ? { isError: true } : event.result) ? "consumed" : "unknown";
  receipt.updated_at_ms = Date.now();
  current.data.confirmations[id] = receipt;
  save(current.path, current.data);
}

export function endSession(_event: Json, _ctx: Json, rootDir: string): void {
  // YP Action does not reliably provide session lifecycle events. Cleanup is TTL-based
  // and is run on every tool hook; session_end is only an opportunistic sweep.
  store(rootDir);
}
