import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { dirname, join } from "node:path";

import { loadErrorCatalog } from "./contract/loader.js";

export type Json = Record<string, any>;
export type ConfirmationStatus = "pending" | "approved" | "in_flight" | "consumed" | "unknown" | "denied";
export type GuardStore = { path: string; data: Json };
const STATE_SCOPE = new AsyncLocalStorage<string>();
const STATE_SCHEMA_VERSION = 21;
const WORKFLOW_EVENT_LIMIT = 200;

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
  if (!data.execution_units || typeof data.execution_units !== "object" || Array.isArray(data.execution_units)) {
    const unitId = "legacy";
    data.execution_units = {
      [unitId]: {
        id: unitId,
        status: "active",
        workflow: data.workflow,
        events: [],
        created_at_ms: Date.now(),
        updated_at_ms: Date.now(),
      },
    };
    data.active_execution_unit_id = unitId;
    changed = true;
  }
  const orderedExecutionUnitIds = Array.isArray(data.execution_unit_order)
    ? data.execution_unit_order.filter((id: unknown): id is string => text(id) && Boolean(data.execution_units[id]))
    : [];
  const uniqueExecutionUnitIds = [...new Set(orderedExecutionUnitIds)];
  const remainingExecutionUnitIds = Object.values<Json>(data.execution_units)
    .filter((unit) => text(unit.id) && !uniqueExecutionUnitIds.includes(unit.id))
    .sort((left, right) => Number(left.created_at_ms ?? 0) - Number(right.created_at_ms ?? 0) ||
      left.id.localeCompare(right.id))
    .map((unit) => unit.id);
  const normalizedExecutionUnitOrder = [...uniqueExecutionUnitIds, ...remainingExecutionUnitIds];
  if (canonical(data.execution_unit_order) !== canonical(normalizedExecutionUnitOrder)) {
    data.execution_unit_order = normalizedExecutionUnitOrder;
    changed = true;
  }
  if (!text(data.active_execution_unit_id) || !data.execution_units[data.active_execution_unit_id]) {
    const firstUnitId = data.execution_unit_order[0];
    if (firstUnitId) {
      data.active_execution_unit_id = firstUnitId;
      data.workflow = data.execution_units[firstUnitId].workflow;
    }
    changed = true;
  }
  const activeUnit = data.execution_units[data.active_execution_unit_id];
  if (activeUnit && activeUnit.workflow !== data.workflow) {
    // JSON persistence breaks object identity between the compatibility projection
    // and the active unit snapshot. The top-level projection is the most recently
    // written value, so rebind it into the active unit on every load.
    activeUnit.workflow = data.workflow;
  }
  for (const [unitId, unit] of Object.entries<Json>(data.execution_units)) {
    if (unitId === data.active_execution_unit_id || unit.status !== "active") continue;
    unit.status = "suspended";
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
  } else if (data.workflow_events.length > WORKFLOW_EVENT_LIMIT) {
    data.workflow_events = data.workflow_events.slice(-WORKFLOW_EVENT_LIMIT);
    changed = true;
  }
  for (const unit of Object.values<Json>(data.execution_units)) {
    if (!Array.isArray(unit.events)) {
      unit.events = [];
      changed = true;
    } else if (unit.events.length > WORKFLOW_EVENT_LIMIT) {
      unit.events = unit.events.slice(-WORKFLOW_EVENT_LIMIT);
      changed = true;
    }
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

export function store(rootDir: string): GuardStore {
  return storeAtPath(statePath(rootDir));
}

export function globalStore(rootDir: string): GuardStore {
  return storeAtPath(join(rootDir, "state", "confirmation_guard.json"));
}

export function sessionStores(rootDir: string): GuardStore[] {
  const sessionsDir = join(rootDir, "state", "sessions");
  try {
    return readdirSync(sessionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => storeAtPath(join(sessionsDir, entry.name, "confirmation_guard.json")));
  } catch {
    return [];
  }
}
