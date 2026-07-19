import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { dirname, join } from "node:path";

import { loadErrorCatalog } from "./contract/loader.js";

export type Json = Record<string, any>;
export type ConfirmationStatus = "pending" | "approved" | "in_flight" | "consumed" | "unknown" | "denied";
export type GuardStore = { path: string; data: Json };
const STATE_SCOPE = new AsyncLocalStorage<string>();

export const CONFIRMATION_TTL_MS = 10 * 60 * 1_000;

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

function normalizeBindingValue(value: unknown): unknown {
  if (typeof value === "string") return value.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (Array.isArray(value)) return value.map(normalizeBindingValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Json)
        .filter(([, item]) => item !== null && item !== undefined)
        .map(([key, item]) => [key, normalizeBindingValue(item)]),
    );
  }
  return value;
}

export function bindingFingerprint(value: unknown): string {
  return fingerprint(normalizeBindingValue(value));
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

export function store(rootDir: string): GuardStore {
  const path = statePath(rootDir);
  const data = load(path);
  let changed = data.schema_version !== 12;
  data.schema_version = 12;
  if (!data.confirmations || typeof data.confirmations !== "object" || Array.isArray(data.confirmations)) {
    data.confirmations = {};
    changed = true;
  }
  for (const key of [
    "trusted_ids",
    "trusted_relations",
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
