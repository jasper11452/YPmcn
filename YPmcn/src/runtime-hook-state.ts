import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { dirname, join } from "node:path";

import { loadErrorCatalog } from "./contract/loader.js";

export type Json = Record<string, any>;
export type ConfirmationStatus = "pending" | "approved" | "in_flight" | "consumed" | "unknown" | "denied";
export type GuardStore = { path: string; data: Json };
export type StoreLockResult<T> = { acquired: true; value: T } | { acquired: false };
const STATE_SCOPE = new AsyncLocalStorage<string>();
const STATE_SCHEMA_VERSION = 20;
const STORE_LOCK_STALE_MS = 60 * 1_000;

export const CONFIRMATION_TTL_MS = 10 * 60 * 1_000;

function initialWorkflowState(): Json {
  return {
    phase: "requirement_draft",
    next_action: "validate_requirement",
    waiting_for: null,
    transition_seq: 0,
    updated_at_ms: null,
  };
}

export function text(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function statePath(rootDir: string): string {
  const scope = STATE_SCOPE.getStore();
  if (!scope) return join(rootDir, "state", "confirmation_guard.json");
  const scopeHash = createHash("sha256").update(scope, "utf8").digest("hex").slice(0, 24);
  return join(rootDir, "state", "sessions", scopeHash, "confirmation_guard.json");
}

export function withStateScope<T>(scope: string | undefined, callback: () => T): T {
  return scope ? STATE_SCOPE.run(scope, callback) : callback();
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

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function acquireStoreLock(path: string): number | undefined {
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return openSync(lockPath, "wx");
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > STORE_LOCK_STALE_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch (lockError) {
        if (errorCode(lockError) === "ENOENT") continue;
      }
      return undefined;
    }
  }
  return undefined;
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

export function denyStructured(code: string, context: string): Json {
  const definition = loadErrorCatalog().errors.find((entry) => entry.code === code);
  if (!definition) throw new Error(`unknown contract error code: ${code}`);
  const message = text(context)
    ? context
    : typeof definition.message === "string"
      ? definition.message
      : code;
  return {
    block: true,
    blockReason: `${code}: ${message}`,
    errorCode: code,
    category: definition.category,
    retryable: definition.retryable,
    recoveryAction: definition.recoveryAction,
  };
}

function storeAtPath(path: string): GuardStore {
  const data = load(path);
  const previousSchemaVersion = data.schema_version;
  let changed = previousSchemaVersion !== STATE_SCHEMA_VERSION;
  data.schema_version = STATE_SCHEMA_VERSION;
  if (!data.confirmations || typeof data.confirmations !== "object" || Array.isArray(data.confirmations)) {
    data.confirmations = {};
    changed = true;
  }
  if (!data.workflow || typeof data.workflow !== "object" || Array.isArray(data.workflow)) {
    data.workflow = initialWorkflowState();
    changed = true;
  }
  if (previousSchemaVersion !== undefined && Number(previousSchemaVersion) < 17) {
    for (const key of [
      "supply_plan_status", "supply_plan_error", "matched_creator_count", "supply_ratio",
      "hard_shortfall_count", "buffer_shortfall_count", "supply_risk_level",
      "suggested_expansion_count", "mcn_covered_creator_count", "mcn_manual_creator_ratio",
      "recommended_action", "pending_manual_target_count",
    ]) delete data.workflow[key];
    if ([
      "confirm_manual_target_count", "manual_source_creators", "confirm_search_results",
    ].includes(data.workflow.next_action)) {
      data.workflow.next_action = "recover_supply_decision_contract_upgrade";
      data.workflow.waiting_for = "user";
    }
    if (
      data.workflow.phase === "requirement_draft" &&
      data.workflow.next_action === "validate_requirement"
    ) {
      data.workflow.next_action = "select_inquiry_form_fields";
      data.workflow.waiting_for = null;
    }
    changed = true;
  }
  if (previousSchemaVersion !== undefined && previousSchemaVersion !== STATE_SCHEMA_VERSION) {
    delete data.manual_sourcing_requirement_receipt;
    delete data.search_requirement_receipt;
    delete data.workflow.post_validation_actions;
    delete data.workflow.pre_race_supply_contract;
    if (data.workflow.next_action === "manual_source_creators") {
      data.workflow.next_action = "validate_requirement";
      data.workflow.waiting_for = null;
    }
    if (["rank_creators", "create_submission_batch"].includes(data.workflow.next_action)) {
      data.workflow.next_action = "recover_direct_flow_contract_upgrade";
      data.workflow.waiting_for = "user";
    }
    changed = true;
  }
  if (!Array.isArray(data.workflow_events)) {
    data.workflow_events = [];
    changed = true;
  } else if (data.workflow_events.length > 50) {
    data.workflow_events = data.workflow_events.slice(-50);
    changed = true;
  }
  for (const key of [
    "trusted_ids",
    "trusted_relations",
    "blocked_requirement_semantics",
    "supply_plans",
    "search_receipts",
    "workflow_states",
    "field_selections",
    "prompt_requirement_gate",
    "ready_requirement_binding",
    "latest_requirement_id",
    "latest_supply_plan_confirmation_id",
    "prompt_epoch",
  ]) {
    if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
    delete data[key];
    changed = true;
  }
  const now = Date.now();
  for (const [id, receipt] of Object.entries<Json>(data.confirmations)) {
    if (!receipt || Number(receipt.expires_at_ms ?? 0) <= now) {
      delete data.confirmations[id];
      changed = true;
    }
  }
  if (text(data.latest_external_confirmation_id) && !data.confirmations[data.latest_external_confirmation_id]) {
    delete data.latest_external_confirmation_id;
    changed = true;
  }
  if (changed) save(path, data);
  return { path, data };
}

/**
 * Applies a synchronous state transition while holding an inter-process lock.
 * Callers must fail closed when the lock is unavailable; spinning would risk
 * bypassing a one-time external-send confirmation under concurrent hosts.
 */
export function withStoreLock<T>(path: string, callback: (current: GuardStore) => T): StoreLockResult<T> {
  const handle = acquireStoreLock(path);
  if (handle === undefined) return { acquired: false };
  try {
    return { acquired: true, value: callback(storeAtPath(path)) };
  } finally {
    closeSync(handle);
    try {
      unlinkSync(`${path}.lock`);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
}

export function store(rootDir: string): GuardStore {
  return storeAtPath(statePath(rootDir));
}

export function globalStore(rootDir: string): GuardStore {
  return storeAtPath(join(rootDir, "state", "confirmation_guard.json"));
}
