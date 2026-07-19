import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { loadErrorCatalog } from "./contract/loader.js";

export type Json = Record<string, any>;
export type ConfirmationStatus = "pending" | "approved" | "in_flight" | "consumed" | "unknown" | "denied";
export type GuardStore = { path: string; data: Json };

export const CONFIRMATION_TTL_MS = 10 * 60 * 1_000;
export const WORKFLOW_STATE_TTL_MS = 10 * 60 * 1_000;
export const SUPPLY_PLAN_TTL_MS = 10 * 60 * 1_000;
export const TRUSTED_ID_TTL_MS = 10 * 60 * 1_000;
const BLOCKED_TOOL_TURN_TTL_MS = 2 * 60 * 1_000;
const READY_REQUIREMENT_TTL_MS = 10 * 60 * 1_000;

export function text(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
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

export function save(path: string, data: Json): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(data, null, 2), "utf8");
  renameSync(temp, path);
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Json;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function deny(code: string, message: string): Json {
  return { block: true, blockReason: `${code}: ${message}` };
}

export function denyStructured(code: string, context: string): Json {
  const definition = loadErrorCatalog().errors.find((entry) => entry.code === code);
  if (!definition) throw new Error(`unknown contract error code: ${code}`);
  const message = typeof definition.message === "string" ? definition.message : context;
  return {
    block: true,
    blockReason: `${code}: ${message}`,
    errorCode: code,
    category: definition.category,
    retryable: definition.retryable,
    recoveryAction: definition.recoveryAction,
  };
}

export function store(rootDir: string): GuardStore {
  const path = statePath(rootDir);
  const data = load(path);
  data.schema_version = 9;
  data.confirmations ??= {};
  if (!Array.isArray(data.trusted_ids)) data.trusted_ids = [];
  if (!data.blocked_requirement_semantics || typeof data.blocked_requirement_semantics !== "object" || Array.isArray(data.blocked_requirement_semantics)) {
    data.blocked_requirement_semantics = {};
  }
  if (!data.supply_plans || typeof data.supply_plans !== "object" || Array.isArray(data.supply_plans)) {
    data.supply_plans = {};
  }
  if (!data.workflow_states || typeof data.workflow_states !== "object" || Array.isArray(data.workflow_states)) {
    data.workflow_states = {};
  }
  let changed = false;
  const now = Date.now();
  for (const [id, receipt] of Object.entries<Json>(data.confirmations)) {
    if (!receipt || Number(receipt.expires_at_ms ?? 0) <= now) {
      delete data.confirmations[id];
      changed = true;
    }
  }
  for (const [key, receipt] of Object.entries<Json>(data.workflow_states)) {
    if (!receipt || Number(receipt.expires_at_ms ?? 0) <= now) {
      delete data.workflow_states[key];
      changed = true;
    }
  }
  for (const [key, plan] of Object.entries<Json>(data.supply_plans)) {
    if (!plan || Number(plan.expires_at_ms ?? 0) <= now) {
      delete data.supply_plans[key];
      changed = true;
    }
  }
  if (data.prompt_requirement_gate && Number(data.prompt_requirement_gate.expires_at_ms ?? 0) <= now) {
    delete data.prompt_requirement_gate;
    changed = true;
  }
  if (data.ready_requirement_binding && Number(data.ready_requirement_binding.expires_at_ms ?? 0) <= now) {
    delete data.ready_requirement_binding;
    changed = true;
  }
  if (data.latest_requirement_id && Number(data.latest_requirement_id.expires_at_ms ?? 0) <= now) {
    delete data.latest_requirement_id;
    changed = true;
  }
  if (data.blocked_tool_turn && Number(data.blocked_tool_turn.expires_at_ms ?? 0) <= now) {
    delete data.blocked_tool_turn;
    changed = true;
  }
  const trustedIds = data.trusted_ids.filter((receipt: unknown) =>
    receipt && typeof receipt === "object" &&
    text((receipt as Json).kind) && text((receipt as Json).value) &&
    Number((receipt as Json).expires_at_ms ?? 0) > now
  );
  if (trustedIds.length !== data.trusted_ids.length) {
    data.trusted_ids = trustedIds;
    changed = true;
  }
  if (changed) save(path, data);
  return { path, data };
}

export function beginPromptTurn(rootDir: string, preview?: Json, readyPayload?: Json): void {
  const current = store(rootDir);
  current.data.prompt_epoch = Number(current.data.prompt_epoch ?? 0) + 1;
  current.data.blocked_requirement_semantics = {};
  delete current.data.blocked_tool_turn;
  delete current.data.prompt_requirement_gate;
  delete current.data.ready_requirement_binding;
  if (preview && preview.gate !== "ready") {
    current.data.prompt_requirement_gate = {
      gate: preview.gate,
      preview_fingerprint: fingerprint(preview),
      missing_required: Array.isArray(preview.missingRequired) ? preview.missingRequired : [],
      semantic_ambiguities: Array.isArray(preview.semanticAmbiguities) ? preview.semanticAmbiguities : [],
      status: "pending",
      prompt_epoch: current.data.prompt_epoch,
      observed_at_ms: Date.now(),
      expires_at_ms: Date.now() + CONFIRMATION_TTL_MS,
    };
  } else if (preview?.gate === "ready" && readyPayload && typeof readyPayload === "object") {
    const audit = readyPayload.rawMessagesJson;
    current.data.ready_requirement_binding = {
      status: "pending",
      preview_fingerprint: fingerprint(preview),
      payload_fingerprint: fingerprint(readyPayload),
      audit_fingerprint: fingerprint(audit),
      atom_count: Array.isArray(audit?.atoms) ? audit.atoms.length : 0,
      prompt_epoch: current.data.prompt_epoch,
      observed_at_ms: Date.now(),
      expires_at_ms: Date.now() + READY_REQUIREMENT_TTL_MS,
    };
  }
  save(current.path, current.data);
}

const CONTINUATION_BLOCK_CODES = new Set([
  "YP_CONFIRMATION_REQUIRED",
  "YP_SUPPLY_PLAN_CONFIRMATION_REQUIRED",
  "WRITE_RESULT_UNKNOWN",
  "WORKFLOW_STATE_REFRESH_REQUIRED",
  "BLOCKED_REQUIREMENT_CLARIFICATION_REQUIRED",
]);

export function recordBlockedToolResult(rootDir: string, result: Json | undefined): void {
  if (!result?.block || !text(result.blockReason)) return;
  const code = result.blockReason.split(":", 1)[0];
  if (code === "BLOCKED_PREVIOUS_HOOK_RESULT" || CONTINUATION_BLOCK_CODES.has(code)) return;
  const current = store(rootDir);
  const now = Date.now();
  current.data.blocked_tool_turn = {
    code,
    prompt_epoch: Number(current.data.prompt_epoch ?? 0),
    observed_at_ms: now,
    expires_at_ms: now + BLOCKED_TOOL_TURN_TTL_MS,
  };
  save(current.path, current.data);
}

export function blockedToolTurnFailure(rootDir: string): Json | undefined {
  const blocked = store(rootDir).data.blocked_tool_turn;
  if (!blocked || typeof blocked !== "object" || !text(blocked.code)) return undefined;
  return deny(
    "BLOCKED_PREVIOUS_HOOK_RESULT",
    `A previous Tool call in this user turn was blocked with ${blocked.code}. Do not retry automatically. The only permitted next Tool is native AskUserQuestion so the user can choose a correction, one explicit retry when safe, or stop; a completed choice unlocks the selected safe path in this same turn.`,
  );
}
