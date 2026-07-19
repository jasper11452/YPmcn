import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  bindingFingerprint,
  canonical,
  CONFIRMATION_TTL_MS,
  deny,
  fingerprint,
  type ConfirmationStatus,
  type GuardStore,
  type Json,
  recordBlockedToolResult,
  save,
  sha256Text,
  store,
  SUPPLY_PLAN_TTL_MS,
  text,
  TRUSTED_ID_TTL_MS,
  WORKFLOW_STATE_TTL_MS,
} from "./runtime-hook-state.js";

const PREFIXES = ["ypmcn__", "mcp__ypmcn__", "ypmcn-mcp__", "ypmcn-provider__"];
const WECOM_TEMPLATE_ID = "ypmcn-wecom-inquiry-v1";
const WECOM_TEMPLATE_RELATIVE_PATH = join("skills", "media-assistant", "assets", "wecom_inquiry_template.txt");
const CONFIRMATION_MARKER = /\[YP_CONFIRMATION:([0-9a-f-]{36})\]/i;
const SUPPLY_PLAN_MARKER = /\[YP_SUPPLY_PLAN_CONFIRMATION:([0-9a-f-]{36})\]/i;
const CONFIRM_SEND_LABEL = "确认发送";
const CONFIRM_SUPPLY_PLAN_LABEL = "确认供给方案";
const SUPPLY_PLAN_CONFIRMATION_HEADER = "供给确认";
const EXTERNAL_SEND_CONFIRMATION_HEADER = "外发确认";
const LOCAL_CONTINUATION_FAILURE_CODES = new Set([
  "BLOCKED_REQUIREMENT_CLARIFICATION_REQUIRED",
  "YP_CONFIRMATION_REQUIRED",
  "YP_SUPPLY_PLAN_CONFIRMATION_REQUIRED",
  "WRITE_RESULT_UNKNOWN",
  "WORKFLOW_STATE_REFRESH_REQUIRED",
]);
const CONTINUOUS_WRITE_TOOLS = new Set([
  "validate_requirement",
  "search_creators",
  "manual_source_creators",
  "sync_mcn_inquiry_status",
  "ingest_mcn_submissions",
  "rank_creators",
  "audit_manual_adjustment",
  "create_submission_batch",
  "record_client_feedback",
]);
const ISO_WITH_TIMEZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const SUPPLY_PLAN_FIELDS = [
  "demand_count",
  "database_candidate_count",
  "supply_demand_ratio",
  "target_submission_count",
  "estimated_valid_return_count",
  "estimated_gap_count",
  "recommended_mcn_count",
  "mcn_covered_creator_count",
  "recommended_manual_creator_count",
  "mcn_manual_creator_ratio",
] as const;
type SupplyPlan = {
  demand_count: number;
  database_candidate_count: number;
  supply_demand_ratio: number;
  target_submission_count: number;
  estimated_valid_return_count: number;
  estimated_gap_count: number;
  recommended_mcn_count: number;
  mcn_covered_creator_count: number;
  recommended_manual_creator_count: number;
  mcn_manual_creator_ratio: string;
};

type SupplyPlanBinding = {
  values: SupplyPlan;
  fingerprint: string;
  observed_at_ms: number;
  expires_at_ms: number;
};

type WorkflowStateBinding = {
  project_name: string;
  allowed_actions: string[];
  demand_id: string | null;
  demand_version: number | null;
  requirement_id: string | null;
  trace_id: string | null;
  observed_at_ms: number;
  expires_at_ms: number;
  fingerprint: string;
};

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

function unwrap(value: any): any {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object") return unwrap(parsed);
    } catch {
      // Native YP Action confirmations are flattened text, not JSON.
    }
    return value;
  }
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

export function successful(result: any): boolean {
  const root = unwrap(result);
  return Boolean(root && typeof root === "object" && root.success === true && root.isError !== true && root.error == null);
}

function collectTrustedIds(
  value: unknown,
  found = new Map<string, Set<string>>(),
): Map<string, Set<string>> {
  if (Array.isArray(value)) {
    for (const item of value) collectTrustedIds(item, found);
    return found;
  }
  if (!value || typeof value !== "object") return found;
  const record = value as Json;
  const aliases: Record<string, string> = {
    kwUid: "kwUid",
    kw_uid: "kwUid",
    requirement_id: "requirement_id",
    requirementId: "requirement_id",
    project_id: "project_id",
    projectId: "project_id",
    mcn_id: "mcn_id",
    mcnId: "mcn_id",
    inquiry_id: "inquiry_id",
    inquiryId: "inquiry_id",
    run_id: "run_id",
    runId: "run_id",
  };
  for (const [key, kind] of Object.entries(aliases)) {
    if (!text(record[key])) continue;
    if (!found.has(kind)) found.set(kind, new Set());
    found.get(kind)?.add(record[key].trim());
  }
  for (const child of Object.values(record)) collectTrustedIds(child, found);
  return found;
}

export function recordTrustedIds(event: Json, tool: string, rootDir: string): void {
  if (!successful(event.error ? { isError: true } : event.result)) return;
  const result = unwrap(event.result);
  const valuesByKind = collectTrustedIds(result);
  let validatedRequirementId: string | undefined;
  if (tool === "validate_requirement") {
    const requirementId = result?.data?.id;
    if (text(requirementId) || (typeof requirementId === "number" && Number.isFinite(requirementId))) {
      validatedRequirementId = String(requirementId).trim();
      valuesByKind.set("requirement_id", new Set([validatedRequirementId]));
    }
  }
  if (valuesByKind.size === 0) {
    if (tool === "validate_requirement") {
      const current = store(rootDir);
      delete current.data.latest_requirement_id;
      save(current.path, current.data);
    }
    return;
  }
  const current = store(rootDir);
  const now = Date.now();
  if (tool === "validate_requirement") delete current.data.latest_requirement_id;
  for (const [kind, values] of valuesByKind) {
    for (const value of values) {
      current.data.trusted_ids = current.data.trusted_ids.filter((receipt: Json) =>
        receipt.kind !== kind || receipt.value !== value
      );
      current.data.trusted_ids.push({
        kind,
        value,
        source_tool: tool,
        observed_at_ms: now,
        expires_at_ms: now + TRUSTED_ID_TTL_MS,
      });
    }
  }
  if (validatedRequirementId) {
    current.data.latest_requirement_id = {
      value: validatedRequirementId,
      source_tool: "validate_requirement",
      observed_at_ms: now,
      expires_at_ms: now + TRUSTED_ID_TTL_MS,
    };
  }
  save(current.path, current.data);
}

function hasTrustedId(rootDir: string, kind: string, value: unknown): boolean {
  if (!text(value)) return false;
  return store(rootDir).data.trusted_ids.some((receipt: Json) =>
    receipt.kind === kind && receipt.value === value.trim()
  );
}

function latestRequirementId(data: Json): string | undefined {
  const binding = data.latest_requirement_id;
  return binding && typeof binding === "object" && binding.source_tool === "validate_requirement" && text(binding.value)
    ? binding.value.trim()
    : undefined;
}

function recordValue(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
}

function actionName(value: string): string {
  return normalize(value) ?? value;
}

function workflowStateKey(projectName: string): string {
  return fingerprint(projectName.trim());
}

function workflowStateCore(binding: Omit<WorkflowStateBinding, "fingerprint">): Json {
  return {
    project_name: binding.project_name,
    allowed_actions: binding.allowed_actions,
    demand_id: binding.demand_id,
    demand_version: binding.demand_version,
    requirement_id: binding.requirement_id,
    trace_id: binding.trace_id,
    observed_at_ms: binding.observed_at_ms,
    expires_at_ms: binding.expires_at_ms,
  };
}

function responseWorkflowState(result: unknown, input: Json): WorkflowStateBinding | undefined {
  const root = recordValue(unwrap(result));
  if (!root || root.success !== true) return undefined;
  const data = recordValue(root.data) ?? root;
  const state = recordValue(data.workflow_state) ?? recordValue(data.workflowState) ??
    recordValue(root.workflow_state) ?? recordValue(root.workflowState) ?? data;
  const requirement = recordValue(state.requirement) ?? recordValue(data.requirement);
  const projectName = [
    state.project_name, state.projectName,
    data.project_name, data.projectName,
    requirement?.project_name, requirement?.projectName,
    root.project_name, root.projectName,
  ].find(text)?.trim();
  const actionsValue = [state.allowed_actions, state.allowedActions, data.allowed_actions, data.allowedActions,
    root.allowed_actions, root.allowedActions].find(Array.isArray);
  if (!projectName || !Array.isArray(actionsValue) || !actionsValue.every(text)) return undefined;
  const allowedActions = [...new Set(actionsValue.map((value) => actionName(value.trim())))].sort();
  const requirementId = [
    state.requirement_id, state.requirementId,
    data.requirement_id, data.requirementId,
    requirement?.requirement_id, requirement?.requirementId, requirement?.id,
    root.requirement_id, root.requirementId,
  ].find(text)?.trim() ?? null;
  const now = Date.now();
  const core = {
    project_name: projectName,
    allowed_actions: allowedActions,
    demand_id: text(input.demand_id) ? input.demand_id.trim() : null,
    demand_version: Number.isSafeInteger(input.demand_version) ? input.demand_version : null,
    requirement_id: requirementId,
    trace_id: text(input.trace_id) ? input.trace_id.trim() : null,
    observed_at_ms: now,
    expires_at_ms: now + WORKFLOW_STATE_TTL_MS,
  };
  return { ...core, fingerprint: fingerprint(workflowStateCore(core)) };
}

function reconcileUnknownConfirmations(data: Json, binding: WorkflowStateBinding): void {
  for (const receipt of Object.values<Json>(data.confirmations)) {
    if (!receipt || !["in_flight", "unknown"].includes(receipt.status)) continue;
    const sameDemand = text(receipt.workflow_demand_id) && receipt.workflow_demand_id === binding.demand_id &&
      receipt.workflow_demand_version === binding.demand_version;
    const sameTrace = text(receipt.workflow_trace_id) && receipt.workflow_trace_id === binding.trace_id;
    const isExternalSend = receipt.kind === "external_send" &&
      receipt.safe_summary?.project_name === binding.project_name && Boolean(sameDemand || sameTrace);
    const isSupplyPlan = receipt.kind === "supply_plan" && binding.requirement_id &&
      receipt.requirement_id === binding.requirement_id;
    if (!isExternalSend && !isSupplyPlan) continue;

    // The current provider has no idempotency ledger for external distribution.
    // Workflow permission alone cannot prove that an unknown send did not happen.
    if (isExternalSend) {
      receipt.status = "unknown";
    } else {
      receipt.status = binding.allowed_actions.includes("rank_mcns") ? "approved" : "consumed";
    }
    receipt.workflow_state_fingerprint = binding.fingerprint;
    receipt.workflow_demand_id = binding.demand_id;
    receipt.workflow_demand_version = binding.demand_version;
    receipt.workflow_trace_id = binding.trace_id;
    receipt.reconciled_workflow_state_fingerprint = binding.fingerprint;
    receipt.reconciled_at_ms = Date.now();
    delete receipt.tool_call_id;
  }
}

function recordWorkflowState(event: Json, input: Json, rootDir: string): void {
  const current = store(rootDir);
  if (!event.error && successful(event.result)) {
    const binding = responseWorkflowState(event.result, input);
    if (binding) {
      for (const [key, previous] of Object.entries<Json>(current.data.workflow_states)) {
        const sameDemand = binding.demand_id && previous.demand_id === binding.demand_id &&
          previous.demand_version === binding.demand_version;
        const sameTrace = binding.trace_id && previous.trace_id === binding.trace_id;
        if (sameDemand || sameTrace) delete current.data.workflow_states[key];
      }
      current.data.workflow_states[workflowStateKey(binding.project_name)] = binding;
      reconcileUnknownConfirmations(current.data, binding);
    }
  }
  save(current.path, current.data);
}

function storedWorkflowState(data: Json, projectName: string): WorkflowStateBinding | undefined {
  const value = recordValue(data.workflow_states?.[workflowStateKey(projectName)]);
  if (!value || value.project_name !== projectName.trim() || !Array.isArray(value.allowed_actions) ||
    !value.allowed_actions.every(text) || !Number.isSafeInteger(value.observed_at_ms) ||
    !Number.isSafeInteger(value.expires_at_ms) || value.expires_at_ms <= Date.now()) return undefined;
  const core = {
    project_name: value.project_name,
    allowed_actions: [...value.allowed_actions],
    demand_id: text(value.demand_id) ? value.demand_id : null,
    demand_version: Number.isSafeInteger(value.demand_version) ? value.demand_version : null,
    requirement_id: text(value.requirement_id) ? value.requirement_id : null,
    trace_id: text(value.trace_id) ? value.trace_id : null,
    observed_at_ms: value.observed_at_ms,
    expires_at_ms: value.expires_at_ms,
  };
  if (value.fingerprint !== fingerprint(workflowStateCore(core))) return undefined;
  return { ...core, fingerprint: value.fingerprint };
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validateSupplyPlan(value: unknown): SupplyPlan | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Json;
  if (!SUPPLY_PLAN_FIELDS.every((field) => Object.prototype.hasOwnProperty.call(source, field))) return undefined;

  if (!nonNegativeInteger(source.demand_count) || source.demand_count === 0) return undefined;
  if (!nonNegativeInteger(source.database_candidate_count)) return undefined;
  if (!nonNegativeInteger(source.target_submission_count) || source.target_submission_count === 0) return undefined;
  if (!nonNegativeInteger(source.estimated_valid_return_count)) return undefined;
  if (!nonNegativeInteger(source.estimated_gap_count)) return undefined;
  if (!nonNegativeInteger(source.recommended_mcn_count)) return undefined;
  if (!nonNegativeInteger(source.mcn_covered_creator_count)) return undefined;
  if (!nonNegativeInteger(source.recommended_manual_creator_count)) return undefined;
  if (typeof source.supply_demand_ratio !== "number" || !Number.isFinite(source.supply_demand_ratio)) return undefined;

  if (source.supply_demand_ratio < 0) return undefined;

  if (typeof source.mcn_manual_creator_ratio !== "string") return undefined;
  const ratio = /^(\d+)\s*:\s*(\d+)$/.exec(source.mcn_manual_creator_ratio.trim());
  if (
    !ratio ||
    Number(ratio[1]) !== source.mcn_covered_creator_count ||
    Number(ratio[2]) !== source.recommended_manual_creator_count
  ) return undefined;

  return {
    demand_count: source.demand_count,
    database_candidate_count: source.database_candidate_count,
    supply_demand_ratio: source.supply_demand_ratio,
    target_submission_count: source.target_submission_count,
    estimated_valid_return_count: source.estimated_valid_return_count,
    estimated_gap_count: source.estimated_gap_count,
    recommended_mcn_count: source.recommended_mcn_count,
    mcn_covered_creator_count: source.mcn_covered_creator_count,
    recommended_manual_creator_count: source.recommended_manual_creator_count,
    mcn_manual_creator_ratio: `${source.mcn_covered_creator_count}:${source.recommended_manual_creator_count}`,
  };
}

function responseSupplyPlan(result: unknown): SupplyPlan | undefined {
  const root = unwrap(result);
  if (!root || typeof root !== "object" || Array.isArray(root)) return undefined;

  const data = root.data && typeof root.data === "object" && !Array.isArray(root.data) ? root.data as Json : undefined;
  let source: Json | undefined;
  if (data && Object.prototype.hasOwnProperty.call(data, "supply_plan") && data.supply_plan && typeof data.supply_plan === "object") {
    source = data.supply_plan as Json;
  } else if (data) {
    source = data;
  } else if (root && typeof root === "object") {
    source = root as Json;
  }
  if (!source) return undefined;

  // If source has all 10 fields, validate strictly
  if (SUPPLY_PLAN_FIELDS.every((field) => Object.prototype.hasOwnProperty.call(source, field))) {
    const providerPlan = validateSupplyPlan(source);
    if (!providerPlan) return undefined;

    // search_creators may return a precomputed plan based on the unfiltered recall pool.
    // Bind the confirmation to the committed hard-filter result whenever those facts are
    // present, because that is what the user sees and what rank_mcns will consume.
    const assessment = recordValue(data?.supply_assessment);
    const demandCount = nonNegativeInteger(assessment?.quantity_total) && assessment.quantity_total > 0
      ? assessment.quantity_total
      : providerPlan.demand_count;
    const candidateCount = nonNegativeInteger(data?.total_matched)
      ? data.total_matched
      : nonNegativeInteger(assessment?.candidate_count)
        ? assessment.candidate_count
        : providerPlan.database_candidate_count;
    const creators = Array.isArray(data?.creators) ? data.creators : [];
    const coveredCreatorIds = new Set<string>();
    for (const creator of creators) {
      if (!creator || typeof creator !== "object" || !text((creator as Json).supplier_id)) continue;
      const item = creator as Json;
      const creatorId = [item.kw_uid, item.kwUid, item.candidate_id].find((value) =>
        text(value) || (typeof value === "number" && Number.isFinite(value))
      );
      if (creatorId != null) coveredCreatorIds.add(String(creatorId));
    }
    const coveredCount = creators.length > 0 ? coveredCreatorIds.size : providerPlan.mcn_covered_creator_count;
    const manualCount = providerPlan.recommended_manual_creator_count;
    return validateSupplyPlan({
      ...providerPlan,
      demand_count: demandCount,
      database_candidate_count: candidateCount,
      supply_demand_ratio: candidateCount / demandCount,
      mcn_covered_creator_count: coveredCount,
      recommended_manual_creator_count: manualCount,
      mcn_manual_creator_ratio: `${coveredCount}:${manualCount}`,
    });
  }

  // Partial data: require at minimum demand_count and database_candidate_count
  const demand = source.demand_count;
  const candidates = source.database_candidate_count;
  if (typeof demand !== "number" || typeof candidates !== "number") return undefined;
  if (!Number.isSafeInteger(demand) || demand <= 0) return undefined;
  if (!Number.isSafeInteger(candidates) || candidates < 0) return undefined;

  const ratio = candidates / demand;
  const target = nonNegativeInteger(source.target_submission_count) && source.target_submission_count > 0
    ? source.target_submission_count
    : Math.max(candidates, demand);
  const valid = nonNegativeInteger(source.estimated_valid_return_count)
    ? source.estimated_valid_return_count
    : Math.round(target * 0.8);
  const gap = Math.max(0, target - valid);
  const manual = Math.max(Math.ceil(demand * 0.2), gap);
  const mcnCovered = nonNegativeInteger(source.mcn_covered_creator_count)
    ? source.mcn_covered_creator_count
    : Math.max(0, candidates - manual);
  const mcnCount = nonNegativeInteger(source.recommended_mcn_count)
    ? source.recommended_mcn_count
    : Math.max(1, Math.ceil(mcnCovered / Math.max(1, Math.round(mcnCovered / 5))));

  let ratioStr: string;
  if (typeof source.mcn_manual_creator_ratio === "string") {
    const parsed = /^(\d+)\s*:\s*(\d+)$/.exec(source.mcn_manual_creator_ratio.trim());
    if (parsed && Number(parsed[1]) >= 0 && Number(parsed[2]) >= 0) {
      ratioStr = source.mcn_manual_creator_ratio.trim();
    } else {
      ratioStr = `${mcnCovered}:${manual}`;
    }
  } else {
    ratioStr = `${mcnCovered}:${manual}`;
  }

  return {
    demand_count: demand,
    database_candidate_count: candidates,
    supply_demand_ratio: ratio,
    target_submission_count: target,
    estimated_valid_return_count: valid,
    estimated_gap_count: gap,
    recommended_mcn_count: mcnCount,
    mcn_covered_creator_count: mcnCovered,
    recommended_manual_creator_count: manual,
    mcn_manual_creator_ratio: ratioStr,
  };
}

function storedSupplyPlan(data: Json, requirementId: string): SupplyPlanBinding | undefined {
  const entry = data.supply_plans?.[requirementId];
  const values = validateSupplyPlan(entry);
  if (!values || !Number.isSafeInteger(entry.observed_at_ms) || !Number.isSafeInteger(entry.expires_at_ms) ||
    entry.expires_at_ms <= Date.now()) return undefined;
  const planFingerprint = fingerprint(values);
  if (entry.fingerprint !== planFingerprint) return undefined;
  return {
    values,
    fingerprint: planFingerprint,
    observed_at_ms: entry.observed_at_ms,
    expires_at_ms: entry.expires_at_ms,
  };
}

function supplyPlanReceiptMatches(
  receipt: Json,
  requirementId: string,
  requestFingerprint: string,
  plan: SupplyPlanBinding,
): boolean {
  const receiptValues = validateSupplyPlan(receipt.safe_summary);
  return receipt.kind === "supply_plan" &&
    receipt.requirement_id === requirementId &&
    receipt.request_fingerprint === requestFingerprint &&
    receipt.supply_plan_fingerprint === plan.fingerprint &&
    Boolean(receiptValues) &&
    fingerprint(receiptValues) === plan.fingerprint;
}

function supplyPlanReceiptMatchesPlan(
  receipt: Json,
  requirementId: string,
  plan: SupplyPlanBinding,
): boolean {
  const receiptValues = validateSupplyPlan(receipt.safe_summary);
  return receipt.kind === "supply_plan" &&
    receipt.requirement_id === requirementId &&
    receipt.supply_plan_fingerprint === plan.fingerprint &&
    Boolean(receiptValues) &&
    fingerprint(receiptValues) === plan.fingerprint;
}

function recordSupplyPlan(event: Json, input: Json, rootDir: string): void {
  if (!text(input.id)) return;
  const requirementId = input.id;
  const current = store(rootDir);
  delete current.data.supply_plans[requirementId];
  for (const [id, receipt] of Object.entries<Json>(current.data.confirmations)) {
    if (
      receipt?.kind === "supply_plan" &&
      (receipt.requirement_id === requirementId || receipt.safe_summary?.requirement_id === requirementId)
    ) delete current.data.confirmations[id];
  }

  if (!event.error && successful(event.result)) {
    const values = responseSupplyPlan(event.result);
    if (values) {
      const now = Date.now();
      const plan = {
        ...values,
        fingerprint: fingerprint(values),
        observed_at_ms: now,
        expires_at_ms: now + SUPPLY_PLAN_TTL_MS,
      };
      current.data.supply_plans[requirementId] = plan;
      const confirmationId = randomUUID();
      current.data.confirmations[confirmationId] = {
        kind: "supply_plan",
        requirement_id: requirementId,
        request_fingerprint: null,
        supply_plan_fingerprint: plan.fingerprint,
        safe_summary: { ...values },
        status: "pending" satisfies ConfirmationStatus,
        created_at_ms: now,
        updated_at_ms: now,
        expires_at_ms: now + CONFIRMATION_TTL_MS,
      };
      current.data.latest_supply_plan_confirmation_id = confirmationId;
    }
  }
  save(current.path, current.data);
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
      return item.filter((label): label is string => typeof label === "string")
        .map((label) => label.trim());
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
  const hasAnswers = Object.prototype.hasOwnProperty.call(root, "answers");
  const hasAnswer = Object.prototype.hasOwnProperty.call(root, "answer");
  const collect = (item: unknown): string[] => {
    if (typeof item === "string") return text(item) ? [item.trim()] : [];
    if (Array.isArray(item)) return item.flatMap(collect);
    if (!item || typeof item !== "object") return [];
    const labels = selectedLabels(item);
    if (labels) return labels;
    return Object.values(item as Json).flatMap(collect);
  };
  const answers = hasAnswers ? collect(root.answers) : [];
  if (answers.length > 0) return answers;
  if (hasAnswer) return collect(root.answer);
  return collect(selectedLabels(root));
}

function rejectedOutcome(value: unknown): boolean {
  return /(?:"status"\s*:\s*"(?:rejected|denied|cancelled|canceled|timeout)"|拒绝|否决|取消|超时|timeout|rejected|denied|cancelled|canceled|user\s+denied\s+the\s+operation)/i
    .test(answerText(value));
}

function flattenedClarificationAnswers(value: unknown, questions: unknown): string[] {
  const root = unwrap(value);
  if (typeof root !== "string" || !Array.isArray(questions) || questions.length === 0) return [];
  const prompts = questions.map((question) =>
    question && typeof question === "object" && text((question as Json).question)
      ? (question as Json).question.trim()
      : ""
  );
  if (prompts.some((prompt) => !prompt)) return [];

  let remaining = root.replace(/\r\n?/g, "\n").trim();
  const answers: string[] = [];
  for (let index = 0; index < prompts.length; index += 1) {
    const prefix = `${prompts[index]}:`;
    if (!remaining.startsWith(prefix)) return [];
    remaining = remaining.slice(prefix.length);
    const nextPrefix = index + 1 < prompts.length ? `\n${prompts[index + 1]}:` : undefined;
    const nextIndex = nextPrefix ? remaining.indexOf(nextPrefix) : -1;
    if (nextPrefix && nextIndex < 0) return [];
    const answer = (nextPrefix ? remaining.slice(0, nextIndex) : remaining).trim();
    if (!text(answer)) return [];
    answers.push(answer);
    remaining = nextPrefix ? remaining.slice(nextIndex + 1) : "";
  }
  return remaining.trim() ? [] : answers;
}

function clarificationAnswerValues(value: unknown, questions: unknown): string[] {
  if (rejectedOutcome(value) || !Array.isArray(questions)) return [];
  const answers = answerValues(value);
  if (answers.length === questions.length && answers.every(text)) return answers;
  return flattenedClarificationAnswers(value, questions);
}

function approvalOutcome(value: unknown, expectedLabel: string): "approved" | "denied" | "unknown" {
  const root = unwrap(value);
  if (rejectedOutcome(root)) return "denied";
  if (typeof root === "string") {
    const flattened = root.trim();
    const selected = [expectedLabel, "确认发送", "确认供给方案", "需要修改", "调整方案"]
      .find((label) => flattened === label || new RegExp(`[：:]\\s*${escapeRegex(label)}\\s*$`).test(flattened));
    if (selected) return selected === expectedLabel ? "approved" : "denied";
  }
  const answers = answerValues(root);
  if (answers.length > 0) return answers.length === 1 && answers[0] === expectedLabel ? "approved" : "denied";
  if (/需要修改|调整方案|自定义/i.test(answerText(root))) return "denied";
  return "unknown";
}

function validateExternalSend(input: Json): Json | undefined {
  if (!text(input.projectName)) {
    return deny("BLOCKED_INVALID_PROJECT", "projectName must be a non-empty string.");
  }
  if (!Array.isArray(input.supplierIds) || input.supplierIds.length === 0) {
    return deny("BLOCKED_EMPTY_SUPPLIER", "supplierIds must be non-empty.");
  }
  if (!Array.isArray(input.columns) || input.columns.length === 0) {
    return deny("BLOCKED_EMPTY_COLUMNS", "columns must contain the confirmed return fields in their confirmed order.");
  }
  if (input.columns.some((column: unknown) => !selectedColumnName(column))) {
    return deny("BLOCKED_EMPTY_COLUMNS", "every selected column must have a name or field name that can be confirmed.");
  }
  const missingSupplierPrefill = input.supplierIds.find((supplierId: any) =>
    !text(supplierId) || !Array.isArray(input.prefillRowsBySupplier?.[supplierId])
  );
  if (missingSupplierPrefill !== undefined) {
    return deny("BLOCKED_INVALID_PREFILL_BINDING", "prefillRowsBySupplier must contain an array for every supplierId.");
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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function markerQuestion(input: Json, marker: { id: string; kind: "external_send" | "supply_plan" }): Json | undefined {
  const token = marker.kind === "external_send"
    ? `[YP_CONFIRMATION:${marker.id}]`
    : `[YP_SUPPLY_PLAN_CONFIRMATION:${marker.id}]`;
  const candidates = Array.isArray(input.questions) ? input.questions : [input];
  const matches = candidates.filter((item): item is Json =>
    Boolean(item && typeof item === "object" && text(item.question) && item.question.toLowerCase().includes(token.toLowerCase()))
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function confirmationOptions(
  question: Json,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  if (!Array.isArray(question.options) || question.options.length < required.length || question.options.length > 6) return false;
  const labels = question.options.map((option: unknown) => {
    if (typeof option === "string") return option.trim();
    return option && typeof option === "object" && text((option as Json).label)
      ? (option as Json).label.trim()
      : "";
  });
  const allowed = new Set([...required, ...optional]);
  return new Set(labels).size === labels.length && required.every((label) => labels.includes(label)) &&
    labels.every((label) => allowed.has(label));
}

function readableRequirementBody(body: string): boolean {
  const normalized = body.trim();
  return normalized.length >= 2 && normalized.length <= 120 && /[？?]$/u.test(normalized) && !/[\r\n]/.test(normalized);
}

function nativeRequirementClarification(input: Json): boolean {
  if (!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 5) return false;
  const headers = new Set<string>();
  const valid = input.questions.every((question: unknown) => {
    if (!question || typeof question !== "object") return false;
    const item = question as Json;
    const body = text(item.question) ? item.question : "";
    const title = [item.header, item.title].find(text)?.trim();
    if (!title || title.length > 16 || headers.has(title) || !readableRequirementBody(body)) return false;
    headers.add(title);
    if (item.multiSelect !== undefined && item.multiSelect !== false) return false;
    if (!Array.isArray(item.options) || item.options.length < 2 || item.options.length > 6) return false;
    const labels = new Set<string>();
    return item.options.every((option: unknown) => {
      const value = option && typeof option === "object" ? option as Json : undefined;
      const label = typeof option === "string" ? option.trim() : text(value?.label) ? value.label.trim() : "";
      const description = text(value?.description) ? value.description.trim() : "";
      if (!label || label.length > 24 || labels.has(label) || description.length > 80) {
        return false;
      }
      labels.add(label);
      return true;
    });
  });
  return valid;
}

export function promptRequirementGate(
  raw: string,
  input: Json,
  current: { path: string; data: Json },
): Json | undefined {
  const gate = current.data.prompt_requirement_gate;
  if (!gate || typeof gate !== "object" || gate.status !== "pending") return undefined;
  if (!isAskTool(raw)) {
    return deny(
      "BLOCKED_REQUIREMENT_CLARIFICATION_REQUIRED",
      `The authoritative prompt gate is ${gate.gate}; before clarification, read/resources/prompts and all business Tools are denied. Use only the native AskUserQuestion Tool.`,
    );
  }
  if (!nativeRequirementClarification(input)) {
    return deny(
      "BLOCKED_REQUIREMENT_CONFIRMATION_MISMATCH",
      "Use one native AskUserQuestion form with 1-5 concise single-choice questions that cover the unresolved values. Questions may use either Chinese or ASCII question marks; options may be strings or label/description objects.",
    );
  }
  gate.clarification_fingerprint = fingerprint(input);
  gate.clarification_in_flight = true;
  gate.updated_at_ms = Date.now();
  current.data.prompt_requirement_gate = gate;
  save(current.path, current.data);
  return undefined;
}

export function validateMarkedAsk(input: Json, data: Json): Json | undefined {
  let marker = findMarker(input);
  if (!marker) {
    const questions = Array.isArray(input.questions) ? input.questions : [input];
    const supplyQuestions = questions.filter((question: unknown) => {
      if (!question || typeof question !== "object") return false;
      const item = question as Json;
      const title = [item.header, item.title].find(text)?.trim();
      const labels = Array.isArray(item.options)
        ? item.options.map((option: unknown) => typeof option === "string" ? option.trim() :
          option && typeof option === "object" && text((option as Json).label) ? (option as Json).label.trim() : "")
        : [];
      return title === SUPPLY_PLAN_CONFIRMATION_HEADER || labels.includes(CONFIRM_SUPPLY_PLAN_LABEL);
    });
    const externalQuestions = questions.filter((question: unknown) => {
      if (!question || typeof question !== "object") return false;
      const item = question as Json;
      const title = [item.header, item.title].find(text)?.trim();
      const labels = Array.isArray(item.options)
        ? item.options.map((option: unknown) => typeof option === "string" ? option.trim() :
          option && typeof option === "object" && text((option as Json).label) ? (option as Json).label.trim() : "")
        : [];
      return title === EXTERNAL_SEND_CONFIRMATION_HEADER || labels.includes(CONFIRM_SEND_LABEL);
    });
    if (supplyQuestions.length === 0 && externalQuestions.length === 0) return undefined;
    if (supplyQuestions.length > 0 && externalQuestions.length > 0) {
      return deny("BLOCKED_CONFIRMATION_MISMATCH", "Supply and external-send confirmations must be separate questions.");
    }
    if (externalQuestions.length > 0) {
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
    } else {
    if (supplyQuestions.length !== 1) {
      return deny("BLOCKED_CONFIRMATION_MISMATCH", "Supply-plan confirmation must contain exactly one bound question.");
    }
    const question = supplyQuestions[0];
    const latestId = text(data.latest_supply_plan_confirmation_id)
      ? data.latest_supply_plan_confirmation_id
      : undefined;
    const latestReceipt = latestId ? data.confirmations[latestId] as Json | undefined : undefined;
    const requirementId = text(latestReceipt?.requirement_id) ? latestReceipt.requirement_id : "";
    const plan = requirementId ? storedSupplyPlan(data, requirementId) : undefined;
    if (!latestId || !latestReceipt || latestReceipt.kind !== "supply_plan" || latestReceipt.status !== "pending" ||
      latestReceipt.request_fingerprint != null || !plan ||
      !supplyPlanReceiptMatchesPlan(latestReceipt, requirementId, plan)) {
      return deny("BLOCKED_CONFIRMATION_MISMATCH", "Supply-plan confirmation needs exactly one current search_creators result.");
    }
    question.question = `${supplyPlanText(latestReceipt.safe_summary)}｜[YP_SUPPLY_PLAN_CONFIRMATION:${latestId}]`;
    marker = { id: latestId, kind: "supply_plan" };
    }
  }
  const receipt = data.confirmations?.[marker.id] as Json | undefined;
  if (!receipt || receipt.kind !== marker.kind || receipt.status !== "pending") {
    return deny("INTEGRATION_REQUIRED", "The confirmation marker is unknown, expired, or no longer pending.");
  }
  const question = markerQuestion(input, marker);
  if (!question) {
    return deny("BLOCKED_CONFIRMATION_MISMATCH", "The marker must appear in exactly one AskUserQuestion question body.");
  }
  if (marker.kind === "supply_plan") {
    if (!confirmationOptions(question, [CONFIRM_SUPPLY_PLAN_LABEL, "调整方案"], ["稍后再说", "取消"])) {
      return deny("BLOCKED_CONFIRMATION_MISMATCH", "Supply-plan options must include 确认供给方案 and 调整方案; optional cancel/later choices are allowed.");
    }
    const requirementId = text(receipt.requirement_id) ? receipt.requirement_id : "";
    const plan = requirementId ? storedSupplyPlan(data, requirementId) : undefined;
    if (!plan || !supplyPlanReceiptMatches(receipt, requirementId, receipt.request_fingerprint, plan)) {
      return deny("INTEGRATION_REQUIRED", "The supply-plan receipt is not bound to the current provider plan.");
    }
    // The receipt is authoritative. Hydrate the visible question from it instead of
    // forcing the agent to reproduce a long result byte-for-byte.
    question.question = `${supplyPlanText(plan.values)}｜[YP_SUPPLY_PLAN_CONFIRMATION:${marker.id}]`;
    return undefined;
  }

  if (!confirmationOptions(question, [CONFIRM_SEND_LABEL, "需要修改"], ["自定义消息", "稍后再说", "取消"])) {
    return deny("BLOCKED_CONFIRMATION_MISMATCH", "External-send options must include 确认发送 and 需要修改; custom-message and cancel/later choices are allowed.");
  }
  question.question = `${externalSummaryText(receipt.safe_summary ?? {})}｜[YP_CONFIRMATION:${marker.id}]`;
  return undefined;
}

function externalSummaryText(summary: Json): string {
  return [
    `【外发对象】项目名=${summary.project_name}｜机构数=${summary.supplier_count}`,
    `【外发内容】截止时间=${summary.deadline}｜表单字段=${JSON.stringify(summary.column_names)}`,
    `【固定模板】消息模板=${summary.message_template_id}`,
    "【影响】确认后真实企微外发",
  ].join(" ");
}

function supplyPlanText(values: SupplyPlan): string {
  const manualTotal = values.mcn_covered_creator_count + values.recommended_manual_creator_count;
  const manualShare = manualTotal === 0 ? 0 : Number((values.recommended_manual_creator_count / manualTotal * 100).toFixed(2));
  return [
    `【真实数据】需求人数=${values.demand_count}｜候选达人=${values.database_candidate_count}｜供给倍数=${values.supply_demand_ratio}`,
    `【推荐方案】目标提报=${values.target_submission_count}｜预计有效=${values.estimated_valid_return_count}｜预计缺口=${values.estimated_gap_count}｜推荐MCN=${values.recommended_mcn_count}｜MCN覆盖达人=${values.mcn_covered_creator_count}｜人工补充=${values.recommended_manual_creator_count}｜MCN人工比例=${values.mcn_manual_creator_ratio}｜建议手扒占比=${manualShare}%`,
    "【影响】确认后写入MCN排序",
  ].join(" ");
}

function authorizeExternalSend(input: Json, rootDir: string, toolCallId?: string): Json | undefined {
  const basicFailure = validateExternalSend(input);
  if (basicFailure) return basicFailure;

  const template = messageTemplateBinding(rootDir);
  if (!template) {
    return deny("INTEGRATION_REQUIRED", "The packaged fixed WeCom inquiry template is missing or empty.");
  }
  const requestFingerprint = bindingFingerprint({ input, template });
  const current = store(rootDir);

  const workflowState = storedWorkflowState(current.data, input.projectName);
  const unresolved = Object.entries<Json>(current.data.confirmations).find(([, receipt]) =>
    receipt.kind === "external_send" && receipt.request_fingerprint === requestFingerprint &&
    ["in_flight", "unknown"].includes(receipt.status)
  );
  if (!workflowState) {
    if (unresolved) {
      return deny("WRITE_RESULT_UNKNOWN", `confirmation_id=${unresolved[0]}; call get_workflow_state to reconcile before any retry.`);
    }
    return deny(
      "WORKFLOW_STATE_REFRESH_REQUIRED",
      "Call get_workflow_state immediately before external distribution; its successful result must identify the same project_name and include allowed_actions.",
    );
  }
  if (!workflowState.allowed_actions.includes("create_with_distributions")) {
    return deny("BLOCKED_WORKFLOW_ACTION", "The latest authoritative workflow state does not allow create_with_distributions.");
  }

  const existing = Object.entries<Json>(current.data.confirmations).find(([, receipt]) =>
    receipt.kind === "external_send" && receipt.request_fingerprint === requestFingerprint &&
    receipt.workflow_state_fingerprint === workflowState.fingerprint &&
    ["pending", "approved", "in_flight", "unknown"].includes(receipt.status)
  );
  if (existing && ["unknown", "in_flight"].includes(existing[1].status)) {
    return deny("WRITE_RESULT_UNKNOWN", `confirmation_id=${existing[0]}; call get_workflow_state to reconcile before any retry.`);
  }

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
      `confirmation_id=${id}; call AskUserQuestion with header “${EXTERNAL_SEND_CONFIRMATION_HEADER}”. The Hook binds and renders the authoritative summary. Include “${CONFIRM_SEND_LABEL}” and “需要修改”; optional “自定义消息”, “稍后再说”, or “取消” choices are allowed. Only “${CONFIRM_SEND_LABEL}” authorizes this request.`,
    );
  }

  const id = randomUUID();
  const now = Date.now();
  current.data.confirmations[id] = {
    kind: "external_send",
    request_fingerprint: requestFingerprint,
    input_fingerprint: bindingFingerprint(input),
    workflow_state_fingerprint: workflowState.fingerprint,
    workflow_demand_id: workflowState.demand_id,
    workflow_demand_version: workflowState.demand_version,
    workflow_trace_id: workflowState.trace_id,
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
    `confirmation_id=${id}; call AskUserQuestion with header “${EXTERNAL_SEND_CONFIRMATION_HEADER}”. The Hook binds and renders the authoritative summary. Include “${CONFIRM_SEND_LABEL}” and “需要修改”; optional “自定义消息”, “稍后再说”, or “取消” choices are allowed.`,
  );
}

function authorizeSupplyPlan(input: Json, rootDir: string, toolCallId?: string): Json | undefined {
  const requirementId = text(input.id) ? input.id : "";
  const requestFingerprint = bindingFingerprint(input);
  const current = store(rootDir);
  const plan = requirementId ? storedSupplyPlan(current.data, requirementId) : undefined;
  if (!plan) {
    return deny(
      "INTEGRATION_REQUIRED",
      "rank_mcns requires a valid provider supply plan from a successful search_creators call for the same requirement.",
    );
  }
  const approved = Object.entries<Json>(current.data.confirmations).find(([, receipt]) =>
    receipt.status === "approved" && supplyPlanReceiptMatchesPlan(receipt, requirementId, plan) &&
    (receipt.request_fingerprint === requestFingerprint || receipt.request_fingerprint == null)
  );
  if (approved) {
    const [id, receipt] = approved;
    if (receipt.request_fingerprint == null) {
      receipt.request_fingerprint = requestFingerprint;
    }
    receipt.status = "in_flight" satisfies ConfirmationStatus;
    receipt.tool_call_id = toolCallId ?? null;
    receipt.updated_at_ms = Date.now();
    current.data.confirmations[id] = receipt;
    save(current.path, current.data);
    return undefined;
  }

  const existing = Object.entries<Json>(current.data.confirmations).find(([, receipt]) =>
    ["pending", "in_flight", "unknown"].includes(receipt.status) &&
    supplyPlanReceiptMatchesPlan(receipt, requirementId, plan) &&
    (receipt.request_fingerprint === requestFingerprint || receipt.request_fingerprint == null)
  );
  if (existing) {
    const [id, receipt] = existing;
    if (receipt.status === "unknown" || receipt.status === "in_flight") {
      return deny("WRITE_RESULT_UNKNOWN", `supply_plan_confirmation_id=${id}; call get_workflow_state before retrying rank_mcns.`);
    }
    if (receipt.request_fingerprint == null) {
      receipt.request_fingerprint = requestFingerprint;
      receipt.updated_at_ms = Date.now();
      current.data.confirmations[id] = receipt;
      save(current.path, current.data);
    }
    return deny(
      "YP_SUPPLY_PLAN_CONFIRMATION_REQUIRED",
      `confirmation_id=${id}; call AskUserQuestion with header “${SUPPLY_PLAN_CONFIRMATION_HEADER}”. The Hook binds and renders the authoritative Provider plan. Include “${CONFIRM_SUPPLY_PLAN_LABEL}” and “调整方案”; optional “稍后再说” or “取消” choices are allowed. Only “${CONFIRM_SUPPLY_PLAN_LABEL}” authorizes ranking.`,
    );
  }

  const id = randomUUID();
  const now = Date.now();
  current.data.confirmations[id] = {
    kind: "supply_plan",
    requirement_id: requirementId,
    request_fingerprint: requestFingerprint,
    supply_plan_fingerprint: plan.fingerprint,
    safe_summary: { ...plan.values },
    status: "pending" satisfies ConfirmationStatus,
    created_at_ms: now,
    updated_at_ms: now,
    expires_at_ms: now + CONFIRMATION_TTL_MS,
  };
  save(current.path, current.data);
  return deny(
    "YP_SUPPLY_PLAN_CONFIRMATION_REQUIRED",
    `confirmation_id=${id}; call AskUserQuestion with header “${SUPPLY_PLAN_CONFIRMATION_HEADER}”. The Hook binds and renders the authoritative Provider plan. Include “${CONFIRM_SUPPLY_PLAN_LABEL}” and “调整方案”; optional “稍后再说” or “取消” choices are allowed.`,
  );
}

export function guardWorkflowTool(
  event: Json,
  tool: string,
  input: Json,
  current: GuardStore,
  rootDir: string,
): Json | undefined {
  if (tool === "search_creators") {
    const expectedId = latestRequirementId(current.data);
    if (!expectedId) {
      return deny(
        "ID_PROVENANCE_REQUIRED",
        "$.id must equal data.id from the latest successful validate_requirement response; demand_id and invented IDs are not accepted.",
      );
    }
    if (input.id.trim() !== expectedId) {
      return deny(
        "ID_PROVENANCE_MISMATCH",
        "$.id does not equal data.id from the latest successful validate_requirement response; never substitute demand_id or demand_version.",
      );
    }
  }
  if (tool === "get_creator_detail" && !hasTrustedId(rootDir, "kwUid", input.kwUid)) {
    return deny(
      "ID_PROVENANCE_REQUIRED",
      "$.kwUid must come from a successful trusted YPmcn Tool response observed in the current TTL window; do not probe invented creator IDs.",
    );
  }
  if (tool === "sync_mcn_inquiry_status") {
    const untrusted = ["requirement_id", "project_id", "mcn_id"].find((kind) =>
      !hasTrustedId(rootDir, kind, input[kind])
    );
    if (untrusted) {
      return deny(
        "ID_PROVENANCE_REQUIRED",
        `$.${untrusted} must come from a successful trusted YPmcn Tool response observed in the current TTL window.`,
      );
    }
  }
  if (tool === "ingest_mcn_submissions" && !hasTrustedId(rootDir, "inquiry_id", input.inquiry_id)) {
    return deny(
      "ID_PROVENANCE_REQUIRED",
      "$.inquiry_id must come from a successful trusted YPmcn Tool response observed in the current TTL window.",
    );
  }
  if ([
    "create_submission_batch",
    "record_client_feedback",
    "get_recommendation_run_detail",
    "audit_manual_adjustment",
  ].includes(tool) && !hasTrustedId(rootDir, "run_id", input.run_id)) {
    return deny(
      "ID_PROVENANCE_REQUIRED",
      "$.run_id must come from a successful trusted YPmcn Tool response observed in the current TTL window.",
    );
  }
  if (tool === "rank_mcns") return authorizeSupplyPlan(input, rootDir, text(event.toolCallId) ? event.toolCallId.trim() : undefined);
  if (tool === "create_with_distributions") {
    return authorizeExternalSend(input, rootDir, text(event.toolCallId) ? event.toolCallId.trim() : undefined);
  }
  return undefined;
}

function explicitToolFailureCode(event: Json): string | undefined {
  const root = unwrap(event.result);
  if (!event.error && (!root || typeof root !== "object" || (root.success !== false && root.isError !== true))) {
    return undefined;
  }
  const error = event.error ?? root?.error;
  const errorMessage = typeof error === "string"
    ? error
    : error && typeof error === "object" && text(error.message)
      ? error.message
      : undefined;
  const messageCode = errorMessage?.trim().match(/^([A-Z][A-Z0-9_]+)\s*:/)?.[1];
  const candidate = error && typeof error === "object"
    ? error.code ?? error.error_code ?? error.name
    : undefined;
  const code = [messageCode, candidate, root?.code, root?.error_code].find(text);
  return code ? code.trim().replace(/[^A-Za-z0-9_-]/g, "_") : "MCP_TOOL_FAILED";
}

export function recordFailedContinuousTool(event: Json, tool: string, rootDir: string): void {
  if (!CONTINUOUS_WRITE_TOOLS.has(tool)) return;
  const code = explicitToolFailureCode(event);
  if (!code) return;
  const currentBlock = store(rootDir).data.blocked_tool_turn;
  if (LOCAL_CONTINUATION_FAILURE_CODES.has(code) || currentBlock?.code === code) return;
  recordBlockedToolResult(
    rootDir,
    deny(code, `${tool} returned an explicit failure. Do not retry automatically or end with a plain blocked message; use native AskUserQuestion in this turn to show the error and let the user choose the safe next action.`),
  );
}

export function recordWorkflowToolResult(
  event: Json,
  raw: string,
  tool: string | undefined,
  input: Json,
  rootDir: string,
): void {
  if (tool === "search_creators") {
    recordSupplyPlan(event, input, rootDir);
    return;
  }
  if (tool === "get_workflow_state") {
    recordWorkflowState(event, input, rootDir);
    return;
  }
  const current = store(rootDir);

  if (isAskTool(raw)) {
    const askResult = event.result ?? event.message;
    if (!event.error && !rejectedOutcome(askResult) && answerValues(askResult).length > 0) {
      delete current.data.blocked_tool_turn;
      save(current.path, current.data);
    }
    const promptGate = current.data.prompt_requirement_gate;
    if (promptGate && typeof promptGate === "object" && promptGate.status === "pending" &&
      promptGate.clarification_in_flight === true && promptGate.clarification_fingerprint === fingerprint(input)) {
      const result = event.result ?? event.message;
      const clarificationAnswers = clarificationAnswerValues(result, input.questions);
      if (!event.error && clarificationAnswers.length > 0) {
        promptGate.status = "clarified";
        promptGate.answer_fingerprint = fingerprint(clarificationAnswers);
        delete promptGate.last_result_error;
      } else if (rejectedOutcome(result)) {
        promptGate.status = "cancelled";
        promptGate.last_result_error = "clarification_cancelled";
      } else {
        promptGate.last_result_error = event.error ? "ask_user_question_failed" : "clarification_result_unrecognized";
      }
      promptGate.updated_at_ms = Date.now();
      delete promptGate.clarification_in_flight;
      current.data.prompt_requirement_gate = promptGate;
      save(current.path, current.data);
    }
    const marker = findMarker(input);
    if (!marker || !current.data.confirmations[marker.id]) return;
    const receipt = current.data.confirmations[marker.id] as Json;
    if (receipt.kind !== marker.kind) return;
    if (receipt.status !== "pending") return;
    const questionFailure = validateMarkedAsk(input, current.data);
    if (questionFailure) {
      receipt.status = "denied";
      receipt.updated_at_ms = Date.now();
      receipt.denial_reason = questionFailure.blockReason;
      current.data.confirmations[marker.id] = receipt;
      save(current.path, current.data);
      return;
    }
    const expectedLabel = marker.kind === "external_send" ? CONFIRM_SEND_LABEL : CONFIRM_SUPPLY_PLAN_LABEL;
    const outcome = approvalOutcome(event.error ? { status: "rejected" } : event.result ?? event.message, expectedLabel);
    receipt.status = outcome === "approved" ? "approved" : outcome === "denied" ? "denied" : "pending";
    if (outcome === "unknown") receipt.last_result_error = "confirmation_result_unrecognized";
    else delete receipt.last_result_error;
    receipt.updated_at_ms = Date.now();
    current.data.confirmations[marker.id] = receipt;
    save(current.path, current.data);
    return;
  }

  if (tool !== "create_with_distributions" && tool !== "rank_mcns") return;
  const kind = tool === "create_with_distributions" ? "external_send" : "supply_plan";
  const requestFingerprint = bindingFingerprint(input);
  const afterToolCallId = text(event.toolCallId) ? event.toolCallId.trim() : undefined;
  const inFlight = Object.entries<Json>(current.data.confirmations).find(([, receipt]) => {
    if (receipt.kind !== kind || receipt.status !== "in_flight") return false;
    if (afterToolCallId && text(receipt.tool_call_id)) return receipt.tool_call_id === afterToolCallId;
    return (tool === "create_with_distributions" ? receipt.input_fingerprint : receipt.request_fingerprint) === requestFingerprint;
  });
  if (!inFlight) return;
  const [id, receipt] = inFlight;
  receipt.status = successful(event.error ? { isError: true } : event.result) ? "consumed" : "unknown";
  receipt.updated_at_ms = Date.now();
  delete receipt.tool_call_id;
  current.data.confirmations[id] = receipt;
  if (tool === "create_with_distributions" && text(input.projectName)) {
    delete current.data.workflow_states[workflowStateKey(input.projectName)];
  }
  save(current.path, current.data);
}
