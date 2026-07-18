import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { loadContractSchema } from "./contract/loader.js";
import { validateToolParams } from "./contract/validator.js";

type Json = Record<string, any>;
type ConfirmationStatus = "pending" | "approved" | "in_flight" | "consumed" | "unknown" | "denied";

const PREFIXES = ["ypmcn__", "mcp__ypmcn__", "ypmcn-mcp__", "ypmcn-provider__"];
const SHELL_TOOLS = new Set(["bash", "exec", "shell", "powershell", "pwsh"]);
const CONFIRMATION_TTL_MS = 10 * 60 * 1_000;
const WORKFLOW_STATE_TTL_MS = 10 * 60 * 1_000;
const SUPPLY_PLAN_TTL_MS = 10 * 60 * 1_000;
const BLOCKED_TOOL_TURN_TTL_MS = 2 * 60 * 1_000;
const TRUSTED_ID_TTL_MS = 10 * 60 * 1_000;
const WECOM_TEMPLATE_ID = "ypmcn-wecom-inquiry-v1";
const WECOM_TEMPLATE_RELATIVE_PATH = join("skills", "media-assistant", "assets", "wecom_inquiry_template.txt");
const CONFIRMATION_MARKER = /\[YP_CONFIRMATION:([0-9a-f-]{36})\]/i;
const SUPPLY_PLAN_MARKER = /\[YP_SUPPLY_PLAN_CONFIRMATION:([0-9a-f-]{36})\]/i;
const CONFIRM_SEND_LABEL = "确认发送";
const CONFIRM_SUPPLY_PLAN_LABEL = "确认供给方案";
const ISO_WITH_TIMEZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const PROVIDER_WRITE_TARGET = /create[-_]with[-_]distributions|\/api\/projects\/create-with-distributions/i;
const SHELL_WRITE_CLIENT = /\b(?:curl|wget|httpie)\b|\bInvoke-(?:WebRequest|RestMethod)\b|\brequests\.(?:post|put|patch|delete)\b|\baxios\.(?:post|put|patch|delete)\b|\bfetch\s*\(|\b(?:mcp|mcporter|openclaw)\b[^\n]*(?:call|invoke|run)\b/i;
const SCHEMA_PROBE = /(?:^|[^a-z])(?:schema[_ -]?check|dry[_ -]?run|probe)(?:$|[^a-z])/i;
const REQUIREMENT_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const REQUIREMENT_PLATFORMS = new Set(["xiaohongshu", "douyin"]);
const AMBIGUITY_SENTINEL = /^(?:__UNRESOLVED__|UNRESOLVED|TBD|TODO|待确认|待补充|不明确)$/i;
const CREATOR_UNIT_PRICE_FIELDS = ["kolOfficialPriceL1", "kolOfficialPriceL2", "kolOfficialPriceL3"] as const;
const REQUIREMENT_RANGE_FIELDS = [
  "photoInteract",
  "followercount",
  "userlikecount",
  "likeIncrement",
  "avgview",
  "avglike",
  "avgcomment",
  "avgcollect",
  "avginteract",
  "femaleRate",
  "age1Rate",
  "age2Rate",
  "age3Rate",
  "age4Rate",
  "age5Rate",
  "age6Rate",
  "cpeL1",
  "cpeL2",
  "cpeL3",
  "cpmL1",
  "cpmL2",
  "cpmL3",
  ...CREATOR_UNIT_PRICE_FIELDS,
] as const;
const UNIT_INTERVAL_RANGE_FIELDS = new Set([
  "photoInteract",
  "femaleRate",
  "age1Rate",
  "age2Rate",
  "age3Rate",
  "age4Rate",
  "age5Rate",
  "age6Rate",
]);
const REQUIREMENT_RECORD_SCHEMA = loadContractSchema("requirement-record.schema.json");
const REQUIREMENT_PAYLOAD_FIELDS = new Set(Object.keys(REQUIREMENT_RECORD_SCHEMA.properties ?? {}));
const PROVIDER_MANAGED_REQUIREMENT_FIELDS = new Set(["id", "demandVersion", "createdAt", "updatedAt"]);
const REQUIREMENT_STRING_FIELDS = new Set([
  "demandId", "brandName", "projectName", "product", "rebate", "contentTag", "description",
  "kwGender", "kwIpDependency", "kwUserUrl", "organization",
]);
const REQUIREMENT_LABEL_FIELDS = new Set([
  "contentFeatureLabel", "contentThemeLabel", "kolPersonaLabel", "talentTypeLabel",
  "pgyBloggerTypeLabel", "xtTalentTypeLabel",
]);
const ACCOUNT_TYPE_TARGET_FIELDS = new Set(["contentTag", ...REQUIREMENT_LABEL_FIELDS]);
const REQUIREMENT_BOOLEAN_INTEGER_FIELDS = new Set(["hasOrganization", "hasOrder30day", "hasSocial30day"]);
const REQUIREMENT_NONNEGATIVE_INTEGER_FIELDS = new Set(["clickMedium", "viewMedium", "photoView", "videoInteract"]);
const REQUIREMENT_OPTIONAL_DATETIME_FIELDS = ["projectStartStart", "projectStartEnd"] as const;
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

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function requirementRange(value: unknown): readonly [number, number] | undefined {
  if (typeof value !== "string" || value.trim() !== value) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      !parsed.every((item) => typeof item === "number" && Number.isFinite(item) && item >= 0) ||
      parsed[0] > parsed[1] ||
      JSON.stringify(parsed) !== value
    ) return undefined;
    return parsed as [number, number];
  } catch {
    return undefined;
  }
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
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
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

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deny(code: string, message: string): Json {
  return { block: true, blockReason: `${code}: ${message}` };
}

function store(rootDir: string): { path: string; data: Json } {
  const path = statePath(rootDir);
  const data = load(path);
  data.schema_version = 8;
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

export function beginPromptTurn(rootDir: string, preview?: Json): void {
  const current = store(rootDir);
  current.data.prompt_epoch = Number(current.data.prompt_epoch ?? 0) + 1;
  current.data.blocked_requirement_semantics = {};
  delete current.data.blocked_tool_turn;
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
  } else {
    delete current.data.prompt_requirement_gate;
  }
  save(current.path, current.data);
}

const CONTINUATION_BLOCK_CODES = new Set([
  "YP_CONFIRMATION_REQUIRED",
  "YP_SUPPLY_PLAN_CONFIRMATION_REQUIRED",
  "WRITE_RESULT_UNKNOWN",
  "WORKFLOW_STATE_REFRESH_REQUIRED",
]);

export function recordBlockedToolResult(rootDir: string, result: Json | undefined): void {
  if (!result?.block || !text(result.blockReason)) return;
  const code = result.blockReason.split(":", 1)[0];
  if (code.startsWith("BLOCKED_") || CONTINUATION_BLOCK_CODES.has(code)) return;
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
    `A previous Tool call in this user turn was blocked with ${blocked.code}; stop without changing arguments or calling another Tool until the next user turn.`,
  );
}

function saveReceipt(rootDir: string, id: string, receipt: Json): void {
  const current = store(rootDir);
  current.data.confirmations[id] = receipt;
  save(current.path, current.data);
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

function recordTrustedIds(event: Json, tool: string, rootDir: string): void {
  if (!successful(event.error ? { isError: true } : event.result)) return;
  const result = unwrap(event.result);
  const valuesByKind = collectTrustedIds(result);
  if (tool === "validate_requirement") {
    const requirementId = result?.data?.id ?? result?.id;
    if (text(requirementId)) valuesByKind.set("requirement_id", new Set([requirementId.trim()]));
  }
  if (valuesByKind.size === 0) return;
  const current = store(rootDir);
  const now = Date.now();
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
  save(current.path, current.data);
}

function hasTrustedId(rootDir: string, kind: string, value: unknown): boolean {
  if (!text(value)) return false;
  return store(rootDir).data.trusted_ids.some((receipt: Json) =>
    receipt.kind === kind && receipt.value === value.trim()
  );
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

    const action = isExternalSend ? "create_with_distributions" : "rank_mcns";
    receipt.status = binding.allowed_actions.includes(action) ? "approved" : "consumed";
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

  const expectedSupplyRatio = source.database_candidate_count / source.demand_count;
  if (source.supply_demand_ratio !== expectedSupplyRatio) return undefined;
  const expectedGap = Math.max(0, source.target_submission_count - source.estimated_valid_return_count);
  if (source.estimated_gap_count !== expectedGap) return undefined;
  const expectedManual = Math.max(Math.ceil(source.demand_count * 0.2), expectedGap);
  if (source.recommended_manual_creator_count !== expectedManual) return undefined;

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
  let source: unknown;
  if (data && Object.prototype.hasOwnProperty.call(data, "supply_plan")) source = data.supply_plan;
  else if (Object.prototype.hasOwnProperty.call(root, "supply_plan")) source = root.supply_plan;
  else if (data) source = data;
  else source = root;
  return validateSupplyPlan(source);
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
      current.data.supply_plans[requirementId] = {
        ...values,
        fingerprint: fingerprint(values),
        observed_at_ms: now,
        expires_at_ms: now + SUPPLY_PLAN_TTL_MS,
      };
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
  return /(?:"status"\s*:\s*"(?:rejected|cancelled|canceled|timeout)"|拒绝|取消|超时|timeout|rejected|cancelled|canceled)/i
    .test(answerText(value));
}

function clarificationAnswered(value: unknown, expectedAnswerCount: number): boolean {
  if (rejectedOutcome(value)) return false;
  const answers = answerValues(value);
  return answers.length === expectedAnswerCount && answers.every(text);
}

function approvalOutcome(value: unknown, expectedLabel: string): "approved" | "denied" | "unknown" {
  const root = unwrap(value);
  if (rejectedOutcome(root)) return "denied";
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

function findAmbiguitySentinel(value: unknown, path = "payload"): string | undefined {
  if (typeof value === "string") {
    return AMBIGUITY_SENTINEL.test(value.trim()) ? path : undefined;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findAmbiguitySentinel(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Json)) {
      const found = findAmbiguitySentinel(item, `${path}.${key}`);
      if (found) return found;
    }
  }
  return undefined;
}

function validateAuditableBrief(raw: unknown, payload: Json): Json | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return deny("BLOCKED_REQUIREMENT_INCOMPLETE", "payload.rawMessagesJson must be a ypmcn-brief-v1 audit object.");
  }
  const audit = raw as Json;
  if (audit.schemaVersion !== "ypmcn-brief-v1") {
    return deny("BLOCKED_REQUIREMENT_INCOMPLETE", "payload.rawMessagesJson.schemaVersion must equal ypmcn-brief-v1.");
  }
  if (!text(audit.originalBrief)) {
    return deny("BLOCKED_REQUIREMENT_INCOMPLETE", "payload.rawMessagesJson.originalBrief must preserve the non-empty original brief.");
  }
  if (!Array.isArray(audit.atoms) || audit.atoms.length === 0) {
    return deny("BLOCKED_REQUIREMENT_INCOMPLETE", "payload.rawMessagesJson.atoms must be a non-empty array.");
  }

  let mappedCount = 0;
  let preservedCount = 0;
  for (let index = 0; index < audit.atoms.length; index += 1) {
    const atom = audit.atoms[index];
    const path = `payload.rawMessagesJson.atoms[${index}]`;
    if (!atom || typeof atom !== "object" || Array.isArray(atom)) {
      return deny("BLOCKED_REQUIREMENT_INCOMPLETE", `${path} must be an object.`);
    }
    if (!text(atom.sourceText) || !audit.originalBrief.includes(atom.sourceText)) {
      return deny("BLOCKED_REQUIREMENT_INCOMPLETE", `${path}.sourceText must be a non-empty exact substring of originalBrief.`);
    }
    if (atom.disposition !== "mapped" && atom.disposition !== "preserved") {
      return deny("BLOCKED_REQUIREMENT_INCOMPLETE", `${path}.disposition must be mapped or preserved.`);
    }
    if (typeof atom.confidence !== "number" || !Number.isFinite(atom.confidence) || atom.confidence < 0 || atom.confidence > 1) {
      return deny("BLOCKED_REQUIREMENT_INCOMPLETE", `${path}.confidence must be a finite number from 0 through 1.`);
    }
    if (typeof atom.inferred !== "boolean") {
      return deny("BLOCKED_REQUIREMENT_INCOMPLETE", `${path}.inferred must be boolean.`);
    }
    if (atom.disposition === "mapped") {
      mappedCount += 1;
      if (!text(atom.targetField) || !Object.prototype.hasOwnProperty.call(payload, atom.targetField)) {
        return deny("BLOCKED_REQUIREMENT_INCOMPLETE", `${path}.targetField must name a field present in payload.`);
      }
    } else {
      preservedCount += 1;
      if (!text(atom.preservedText) || atom.preservedText !== atom.sourceText) {
        return deny("BLOCKED_REQUIREMENT_INCOMPLETE", `${path}.preservedText must exactly equal sourceText for a preserved atom.`);
      }
    }
  }

  const coverage = audit.coverageCheck;
  if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)) {
    return deny("BLOCKED_REQUIREMENT_INCOMPLETE", "payload.rawMessagesJson.coverageCheck is required.");
  }
  if (
    coverage.atomCount !== audit.atoms.length ||
    coverage.mappedCount !== mappedCount ||
    coverage.preservedCount !== preservedCount ||
    coverage.unresolvedCount !== 0 ||
    coverage.atomCount !== coverage.mappedCount + coverage.preservedCount + coverage.unresolvedCount
  ) {
    return deny(
      "BLOCKED_REQUIREMENT_AUDIT_CONFLICT",
      "payload.rawMessagesJson.coverageCheck must be derived from the same atoms: atomCount=atoms.length, mappedCount and preservedCount must match dispositions, unresolvedCount must be zero, and atomCount=mappedCount+preservedCount+unresolvedCount.",
    );
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

function exactOptionLabels(question: Json, expected: readonly string[]): boolean {
  if (!Array.isArray(question.options) || question.options.length !== expected.length) return false;
  const labels = question.options.map((option: unknown) => {
    if (typeof option === "string") return option.trim();
    return option && typeof option === "object" && text((option as Json).label)
      ? (option as Json).label.trim()
      : undefined;
  });
  return labels.every((label, index) => label === expected[index]);
}

function nativeRequirementClarification(input: Json): boolean {
  if (!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 3) return false;
  return input.questions.every((question: unknown) => {
    if (!question || typeof question !== "object") return false;
    const item = question as Json;
    const body = text(item.question) ? item.question : "";
    const title = [item.header, item.title, body].filter(text).join(" ");
    if (!/需求确认/.test(title) || !/已确认[：:]/.test(body) || !/需确认[：:]/.test(body) || !/影响[：:]/.test(body)) {
      return false;
    }
    if (!Array.isArray(item.options) || item.options.length < 2 || item.options.length > 3) return false;
    return item.options.every((option: unknown) =>
      typeof option === "string" ? text(option) : Boolean(option && typeof option === "object" && text((option as Json).label))
    );
  });
}

function promptRequirementGate(
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
      "Use one native AskUserQuestion with 1-3 questions titled 需求确认; every question body must contain 已确认:, 需确认:, and 影响:, with 2-3 mutually exclusive options.",
    );
  }
  gate.clarification_fingerprint = fingerprint(input);
  gate.clarification_in_flight = true;
  gate.updated_at_ms = Date.now();
  current.data.prompt_requirement_gate = gate;
  save(current.path, current.data);
  return undefined;
}

function numericQuestionValues(question: string, field: string): number[] {
  const numberPattern = "[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?";
  const pattern = new RegExp(
    `(?:^|[^A-Za-z0-9_])(?:[\\s*\u0060"']{0,3})${escapeRegex(field)}(?:[\\s*\u0060"']{0,3})(?:=|:|：)\\s*(${numberPattern})(?![A-Za-z0-9_.])`,
    "g",
  );
  return [...question.matchAll(pattern)].map((match) => Number(match[1]));
}

function ratioQuestionValues(question: string, field: string): Array<[number, number]> {
  const pattern = new RegExp(
    `(?:^|[^A-Za-z0-9_])(?:[\\s*\u0060"']{0,3})${escapeRegex(field)}(?:[\\s*\u0060"']{0,3})(?:=|:|：)\\s*(\\d+)\\s*:\\s*(\\d+)(?!\\d)`,
    "g",
  );
  return [...question.matchAll(pattern)].map((match) => [Number(match[1]), Number(match[2])]);
}

function questionMatchesSupplyPlan(question: string, values: SupplyPlan): boolean {
  for (const field of SUPPLY_PLAN_FIELDS) {
    if (field === "mcn_manual_creator_ratio") {
      const matches = ratioQuestionValues(question, field);
      if (
        matches.length !== 1 ||
        matches[0][0] !== values.mcn_covered_creator_count ||
        matches[0][1] !== values.recommended_manual_creator_count
      ) return false;
      continue;
    }
    const matches = numericQuestionValues(question, field);
    if (matches.length !== 1 || matches[0] !== values[field]) return false;
  }
  return true;
}

function labeledSegments(question: string, aliases: readonly string[]): string[] {
  const names = aliases.map(escapeRegex).join("|");
  const pattern = new RegExp(
    `(?:^|[^A-Za-z0-9_])(?:${names})\\s*(?:=|:|：)\\s*([^;；\\n]+)`,
    "gi",
  );
  return [...question.matchAll(pattern)].map((match) => match[1].trim());
}

function unquote(value: string): string {
  let result = value.trim().replace(/[。.]$/, "").trim();
  const pairs: Array<[string, string]> = [["\"", "\""], ["'", "'"], ["“", "”"], ["‘", "’"]];
  for (const [open, close] of pairs) {
    if (result.startsWith(open) && result.endsWith(close)) return result.slice(open.length, -close.length).trim();
  }
  return result;
}

function exactLabeledText(question: string, aliases: readonly string[], expected: string): boolean {
  const matches = labeledSegments(question, aliases);
  return matches.length === 1 && unquote(matches[0]) === expected;
}

function exactLabeledCount(question: string, aliases: readonly string[], expected: number): boolean {
  const matches = labeledSegments(question, aliases);
  return matches.length === 1 && /^\d+$/.test(unquote(matches[0])) && Number(unquote(matches[0])) === expected;
}

function exactLabeledColumns(question: string, expected: string[]): boolean {
  const matches = labeledSegments(question, ["column_names", "已选列名", "表单字段"]);
  if (matches.length !== 1) return false;
  const raw = matches[0].trim();
  let parsed: unknown;
  if (raw.startsWith("[")) {
    try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
  }
  const names: unknown[] = Array.isArray(parsed)
    ? parsed
    : raw.replace(/^\[|\]$/g, "").split(/\s*(?:,|，|、|\|)\s*/).filter(Boolean).map(unquote);
  return names.length === expected.length && names.every((name, index) => name === expected[index]);
}

function questionMatchesExternalSummary(question: string, summary: Json): boolean {
  if (!text(summary.project_name) || !text(summary.deadline)) return false;
  if (summary.message_template_id !== WECOM_TEMPLATE_ID ||
    typeof summary.message_template_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(summary.message_template_sha256)) return false;
  if (!Number.isSafeInteger(summary.supplier_count) || summary.supplier_count <= 0) return false;
  if (!Array.isArray(summary.column_names) || summary.column_names.length === 0 || !summary.column_names.every(text)) return false;
  return exactLabeledText(question, ["project_name", "项目名", "项目名称"], summary.project_name) &&
    exactLabeledCount(question, ["supplier_count", "机构数", "机构数量"], summary.supplier_count) &&
    exactLabeledText(question, ["deadline", "截止时间"], summary.deadline) &&
    exactLabeledColumns(question, summary.column_names) &&
    exactLabeledText(question, ["message_template_id", "消息模板"], summary.message_template_id) &&
    exactLabeledText(question, ["message_template_sha256", "消息模板哈希"], summary.message_template_sha256);
}

function validateMarkedAsk(input: Json, data: Json): Json | undefined {
  const marker = findMarker(input);
  if (!marker) return undefined;
  const receipt = data.confirmations?.[marker.id] as Json | undefined;
  if (!receipt || receipt.kind !== marker.kind || receipt.status !== "pending") {
    return deny("INTEGRATION_REQUIRED", "The confirmation marker is unknown, expired, or no longer pending.");
  }
  const question = markerQuestion(input, marker);
  if (!question) {
    return deny("BLOCKED_CONFIRMATION_MISMATCH", "The marker must appear in exactly one AskUserQuestion question body.");
  }

  if (marker.kind === "supply_plan") {
    if (!exactOptionLabels(question, [CONFIRM_SUPPLY_PLAN_LABEL, "调整方案"])) {
      return deny("BLOCKED_CONFIRMATION_MISMATCH", "Supply-plan options must be exactly 确认供给方案 and 调整方案.");
    }
    const requirementId = text(receipt.requirement_id) ? receipt.requirement_id : "";
    const plan = requirementId ? storedSupplyPlan(data, requirementId) : undefined;
    if (!plan || !supplyPlanReceiptMatches(receipt, requirementId, receipt.request_fingerprint, plan)) {
      return deny("INTEGRATION_REQUIRED", "The supply-plan receipt is not bound to the current provider plan.");
    }
    if (!questionMatchesSupplyPlan(question.question, plan.values)) {
      return deny("BLOCKED_CONFIRMATION_MISMATCH", "The question must show each provider supply-plan field with its exact bound value.");
    }
    return undefined;
  }

  if (!exactOptionLabels(question, [CONFIRM_SEND_LABEL, "需要修改"])) {
    return deny("BLOCKED_CONFIRMATION_MISMATCH", "External-send options must be exactly 确认发送 and 需要修改.");
  }
  if (!questionMatchesExternalSummary(question.question, receipt.safe_summary ?? {})) {
    return deny("BLOCKED_CONFIRMATION_MISMATCH", "The question must show the bound project name, supplier count, deadline, selected column names, and fixed WeCom template identity/hash.");
  }
  return undefined;
}

function requirementSemanticKey(payload: Json): string | undefined {
  const originalBrief = payload.rawMessagesJson?.originalBrief;
  return text(originalBrief) ? fingerprint(originalBrief.trim()) : undefined;
}

function mappedRequirementSemantics(payload: Json): Json {
  const atoms = Array.isArray(payload.rawMessagesJson?.atoms) ? payload.rawMessagesJson.atoms : [];
  const mapped: Json = {};
  for (const atom of atoms) {
    if (!atom || typeof atom !== "object" || atom.disposition !== "mapped" ||
      !text(atom.sourceText) || !text(atom.targetField)) continue;
    mapped[atom.sourceText] = atom.targetField;
  }
  return mapped;
}

function recordBlockedRequirementSemantics(current: { path: string; data: Json }, payload: Json): void {
  const key = requirementSemanticKey(payload);
  if (!key) return;
  const mapped = mappedRequirementSemantics(payload);
  if (Object.keys(mapped).length === 0) return;
  current.data.blocked_requirement_semantics[key] = mapped;
  save(current.path, current.data);
}

function requirementSemanticDowngrade(current: { path: string; data: Json }, payload: Json): Json | undefined {
  const key = requirementSemanticKey(payload);
  const previous = key ? current.data.blocked_requirement_semantics[key] : undefined;
  if (!previous || typeof previous !== "object" || Array.isArray(previous)) return undefined;
  const currentMapped = mappedRequirementSemantics(payload);
  const downgraded = Object.entries(previous).find(([sourceText, targetField]) =>
    currentMapped[sourceText] !== targetField || !Object.prototype.hasOwnProperty.call(payload, String(targetField))
  );
  if (!downgraded) return undefined;
  return deny(
    "BLOCKED_REQUIREMENT_SEMANTIC_REWRITE",
    `The blocked atom ${JSON.stringify(downgraded[0])} must remain mapped to payload.${String(downgraded[1])}; wait for a new user turn instead of deleting, preserving, or remapping it.`,
  );
}

function explicitJsonArray(sourceText: string): boolean {
  try {
    const parsed = JSON.parse(sourceText.trim());
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

function validateTaxonomyMapping(payload: Json): Json | undefined {
  const audit = payload.rawMessagesJson;
  if (!audit || typeof audit !== "object" || !Array.isArray(audit.atoms) || !text(audit.originalBrief)) {
    return undefined;
  }
  for (const atom of audit.atoms) {
    if (!atom || typeof atom !== "object" || atom.disposition !== "mapped" ||
      !text(atom.sourceText) || !text(atom.targetField) ||
      !ACCOUNT_TYPE_TARGET_FIELDS.has(atom.targetField)) continue;
    const index = audit.originalBrief.indexOf(atom.sourceText);
    const context = index >= 0
      ? audit.originalBrief.slice(Math.max(0, index - 16), index + atom.sourceText.length)
      : atom.sourceText;
    const accountTypeWording = /(?:账号|达人|博主|蒲公英|星图)?类型\s*[：:]?/.test(context);
    if (atom.targetField === "contentTag") {
      if (!accountTypeWording) continue;
    } else if (explicitJsonArray(atom.sourceText)) {
      continue;
    }
    return deny(
      "BLOCKED_TAXONOMY_CONFIRMATION_REQUIRED",
      `Natural-language atom ${JSON.stringify(atom.sourceText)} cannot map to payload.${atom.targetField} without an explicit taxonomy value; ask whether it is a content topic or a platform talent type and stop.`,
    );
  }
  return undefined;
}

function validateRequirementPayload(payload: Json): Json | undefined {
  const unknownField = Object.keys(payload).find((field) => !REQUIREMENT_PAYLOAD_FIELDS.has(field));
  if (unknownField) {
    return deny(
      "BLOCKED_REQUIREMENT_INCOMPLETE",
      `payload.${unknownField} is not a real customer_demands field; map it to the packaged 61-column schema or preserve the original wording in rawMessagesJson.`,
    );
  }
  const providerManagedField = Object.keys(payload).find((field) => PROVIDER_MANAGED_REQUIREMENT_FIELDS.has(field));
  if (providerManagedField) {
    return deny(
      "BLOCKED_REQUIREMENT_INCOMPLETE",
      `payload.${providerManagedField} is Provider-managed and must not be supplied by the Agent.`,
    );
  }
  if (!text(payload.platform)) {
    return deny("BLOCKED_REQUIREMENT_INCOMPLETE", "payload.platform is required; ask for the missing platform and stop.");
  }
  if (!REQUIREMENT_PLATFORMS.has(payload.platform)) {
    return deny("BLOCKED_REQUIREMENT_INCOMPLETE", "payload.platform must be xiaohongshu or douyin; clarify the platform and stop.");
  }
  if (!Number.isInteger(payload.quantityTotal) || payload.quantityTotal <= 0) {
    return deny("BLOCKED_REQUIREMENT_INCOMPLETE", "payload.quantityTotal must be a positive integer; ask for the missing or ambiguous quantity and stop.");
  }
  if (!text(payload.submissionDeadlineAt) || !REQUIREMENT_DATETIME.test(payload.submissionDeadlineAt)) {
    return deny("BLOCKED_REQUIREMENT_INCOMPLETE", "payload.submissionDeadlineAt is required in YYYY-MM-DD HH:mm:ss format; clarify the deadline and stop.");
  }
  for (const field of REQUIREMENT_OPTIONAL_DATETIME_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, field) &&
      (typeof payload[field] !== "string" || !REQUIREMENT_DATETIME.test(payload[field]))) {
      return deny("BLOCKED_REQUIREMENT_INCOMPLETE", `payload.${field} must use YYYY-MM-DD HH:mm:ss when supplied.`);
    }
  }
  if (text(payload.projectStartStart) && text(payload.projectStartEnd) && payload.projectStartStart > payload.projectStartEnd) {
    return deny("BLOCKED_REQUIREMENT_INCOMPLETE", "payload.projectStartStart must not be later than payload.projectStartEnd.");
  }
  for (const field of REQUIREMENT_STRING_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, field) && !text(payload[field])) {
      return deny("BLOCKED_REQUIREMENT_INCOMPLETE", `payload.${field} must be a non-empty string when supplied.`);
    }
  }
  for (const field of REQUIREMENT_LABEL_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(payload, field)) continue;
    const value = payload[field];
    if (!value || typeof value !== "object" ||
      (Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0)) {
      return deny("BLOCKED_REQUIREMENT_INCOMPLETE", `payload.${field} must be a non-empty JSON array or object when supplied.`);
    }
  }
  for (const field of REQUIREMENT_BOOLEAN_INTEGER_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, field) && payload[field] !== 0 && payload[field] !== 1) {
      return deny("BLOCKED_REQUIREMENT_INCOMPLETE", `payload.${field} must be integer 0 or 1 when supplied.`);
    }
  }
  for (const field of REQUIREMENT_NONNEGATIVE_INTEGER_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, field) &&
      (!Number.isInteger(payload[field]) || payload[field] < 0)) {
      return deny("BLOCKED_REQUIREMENT_INCOMPLETE", `payload.${field} must be a non-negative integer when supplied.`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(payload, "interactionRate") &&
    (typeof payload.interactionRate !== "number" || !Number.isFinite(payload.interactionRate) ||
      payload.interactionRate < 0 || payload.interactionRate > 1)) {
    return deny("BLOCKED_REQUIREMENT_INCOMPLETE", "payload.interactionRate must be a finite number between 0 and 1 when supplied.");
  }
  for (const field of REQUIREMENT_RANGE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(payload, field)) continue;
    const range = requirementRange(payload[field]);
    if (!range) {
      return deny(
        "BLOCKED_REQUIREMENT_INCOMPLETE",
        `payload.${field} must be a canonical non-negative range string such as "[0,0.5]"; clarify and normalize the range before validation.`,
      );
    }
    if (UNIT_INTERVAL_RANGE_FIELDS.has(field) && range[1] > 1) {
      return deny(
        "BLOCKED_REQUIREMENT_INCOMPLETE",
        `payload.${field} is a rate range and both bounds must be between 0 and 1.`,
      );
    }
  }
  const suppliedUnitPrices = CREATOR_UNIT_PRICE_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(payload, field));
  if (suppliedUnitPrices.length === 0) {
    return deny(
      "BLOCKED_REQUIREMENT_INCOMPLETE",
      "one of payload.kolOfficialPriceL1/L2/L3 is business-required as a [min,max] range string; ask for the single-creator budget and its content tier, then stop.",
    );
  }
  const invalidUnitPrice = suppliedUnitPrices.find((field) => {
    const range = requirementRange(payload[field]);
    return !range || range[1] <= 0;
  });
  if (invalidUnitPrice) {
    return deny(
      "BLOCKED_REQUIREMENT_INCOMPLETE",
      `payload.${invalidUnitPrice} must be a canonical RMB [min,max] range with a positive upper bound; clarify the single-creator budget and stop.`,
    );
  }
  const auditFailure = validateAuditableBrief(payload.rawMessagesJson, payload);
  if (auditFailure) return auditFailure;
  const taxonomyFailure = validateTaxonomyMapping(payload);
  if (taxonomyFailure) return taxonomyFailure;
  const sentinelPath = findAmbiguitySentinel(payload);
  if (sentinelPath) {
    return deny("BLOCKED_REQUIREMENT_INCOMPLETE", `${sentinelPath} contains an unresolved placeholder; clarify the semantic ambiguity and stop.`);
  }
  return undefined;
}

function externalSummaryText(summary: Json): string {
  return [
    `project_name=${summary.project_name}`,
    `supplier_count=${summary.supplier_count}`,
    `deadline=${summary.deadline}`,
    `column_names=${JSON.stringify(summary.column_names)}`,
    `message_template_id=${summary.message_template_id}`,
    `message_template_sha256=${summary.message_template_sha256}`,
  ].join("; ");
}

function supplyPlanText(values: SupplyPlan): string {
  return SUPPLY_PLAN_FIELDS.map((field) => `${field}=${values[field]}`).join("; ");
}

function authorizeExternalSend(input: Json, rootDir: string, toolCallId?: string): Json | undefined {
  const basicFailure = validateExternalSend(input);
  if (basicFailure) return basicFailure;

  const template = messageTemplateBinding(rootDir);
  if (!template) {
    return deny("INTEGRATION_REQUIRED", "The packaged fixed WeCom inquiry template is missing or empty.");
  }
  const requestFingerprint = fingerprint({ input, template });
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
      `confirmation_id=${id}; call AskUserQuestion with marker [YP_CONFIRMATION:${id}] and these exact values: ${externalSummaryText(receipt.safe_summary)}. Options must be exactly “${CONFIRM_SEND_LABEL}” and “需要修改”; only the first authorizes an unchanged retry.`,
    );
  }

  const id = randomUUID();
  const now = Date.now();
  current.data.confirmations[id] = {
    kind: "external_send",
    request_fingerprint: requestFingerprint,
    input_fingerprint: fingerprint(input),
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
  save(current.path, current.data);
  return deny(
    "YP_CONFIRMATION_REQUIRED",
    `confirmation_id=${id}; call AskUserQuestion with marker [YP_CONFIRMATION:${id}] and these exact values: ${externalSummaryText(current.data.confirmations[id].safe_summary)}. Options must be exactly “${CONFIRM_SEND_LABEL}” and “需要修改”.`,
  );
}

function authorizeSupplyPlan(input: Json, rootDir: string, toolCallId?: string): Json | undefined {
  const requirementId = text(input.id) ? input.id : "";
  const requestFingerprint = fingerprint(input);
  const current = store(rootDir);
  const plan = requirementId ? storedSupplyPlan(current.data, requirementId) : undefined;
  if (!plan) {
    return deny(
      "INTEGRATION_REQUIRED",
      "rank_mcns requires a valid provider supply plan from a successful search_creators call for the same requirement.",
    );
  }
  const approved = Object.entries<Json>(current.data.confirmations).find(([, receipt]) =>
    receipt.status === "approved" && supplyPlanReceiptMatches(receipt, requirementId, requestFingerprint, plan)
  );
  if (approved) {
    const [id, receipt] = approved;
    receipt.status = "in_flight" satisfies ConfirmationStatus;
    receipt.tool_call_id = toolCallId ?? null;
    receipt.updated_at_ms = Date.now();
    current.data.confirmations[id] = receipt;
    save(current.path, current.data);
    return undefined;
  }

  const existing = Object.entries<Json>(current.data.confirmations).find(([, receipt]) =>
    ["pending", "in_flight", "unknown"].includes(receipt.status) &&
    supplyPlanReceiptMatches(receipt, requirementId, requestFingerprint, plan)
  );
  if (existing) {
    const [id, receipt] = existing;
    if (receipt.status === "unknown" || receipt.status === "in_flight") {
      return deny("WRITE_RESULT_UNKNOWN", `supply_plan_confirmation_id=${id}; call get_workflow_state before retrying rank_mcns.`);
    }
    return deny(
      "YP_SUPPLY_PLAN_CONFIRMATION_REQUIRED",
      `confirmation_id=${id}; call AskUserQuestion with marker [YP_SUPPLY_PLAN_CONFIRMATION:${id}] and these exact provider values: ${supplyPlanText(plan.values)}. Options must be exactly “${CONFIRM_SUPPLY_PLAN_LABEL}” and “调整方案”; only the first authorizes the unchanged rank_mcns call.`,
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
    `confirmation_id=${id}; call AskUserQuestion with marker [YP_SUPPLY_PLAN_CONFIRMATION:${id}] and these exact provider values: ${supplyPlanText(plan.values)}. Options must be exactly “${CONFIRM_SUPPLY_PLAN_LABEL}” and “调整方案”.`,
  );
}

export function beforeTool(event: Json, _ctx: Json, rootDir: string): Json | undefined {
  const raw = String(event.toolName ?? event.name ?? "").trim();
  const input = event.params && typeof event.params === "object" ? event.params :
    event.arguments && typeof event.arguments === "object" ? event.arguments : {};

  const current = store(rootDir);
  const promptGateFailure = promptRequirementGate(raw, input, current);
  if (promptGateFailure) return promptGateFailure;
  if (SHELL_TOOLS.has(raw.toLowerCase())) {
    const command = [input.command, input.cmd, input.script, input.input].filter(text).join("\n");
    return PROVIDER_WRITE_TARGET.test(command) && SHELL_WRITE_CLIENT.test(command)
      ? deny("INTEGRATION_REQUIRED", "Provider writes must use the declared MCP tool, not shell or curl.")
      : undefined;
  }
  if (isAskTool(raw)) return validateMarkedAsk(input, current.data);

  const tool = normalize(raw);
  if (!tool) return undefined;
  const issues = validateToolParams(tool, input);
  if (issues.length > 0) {
    const first = issues[0];
    return deny(first.code, `${first.path}: ${first.message}`);
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
  if (tool === "validate_requirement") {
    const payload = input.payload && typeof input.payload === "object" ? input.payload : input;
    const semanticDowngrade = requirementSemanticDowngrade(current, payload);
    if (semanticDowngrade) return semanticDowngrade;
    const labels = [payload.projectName, payload.brandName, payload.note].filter(text).join(" ");
    const blockRequirement = (failure: Json): Json => {
      recordBlockedRequirementSemantics(current, payload);
      return failure;
    };
    if (SCHEMA_PROBE.test(labels)) {
      return blockRequirement(deny("BLOCKED_NO_DRY_RUN", "validate_requirement always writes; inspect the host tool schema without calling it."));
    }
    if (payload.status !== "ready") {
      return blockRequirement(deny("BLOCKED_REQUIREMENT_INCOMPLETE", "payload.status must be ready; clarify every missing or ambiguous required value before validation."));
    }
    const requirementFailure = validateRequirementPayload(payload);
    if (requirementFailure) return blockRequirement(requirementFailure);
    const emptyField = Object.entries(payload).find(([, value]) =>
      value === null || (typeof value === "string" && value.trim() === "") ||
      (Array.isArray(value) && value.length === 0)
    );
    if (emptyField) {
      return blockRequirement(deny("BLOCKED_REQUIREMENT_INCOMPLETE", `payload.${emptyField[0]} is empty; omit optional fields and clarify required fields before validation.`));
    }
  }
  if (tool === "rank_mcns") return authorizeSupplyPlan(input, rootDir, text(event.toolCallId) ? event.toolCallId.trim() : undefined);
  if (tool === "create_with_distributions") {
    return authorizeExternalSend(input, rootDir, text(event.toolCallId) ? event.toolCallId.trim() : undefined);
  }
  return undefined;
}

export function afterTool(event: Json, _ctx: Json, rootDir: string): void {
  const raw = String(event.toolName ?? event.name ?? "").trim();
  const input = event.params && typeof event.params === "object" ? event.params :
    event.arguments && typeof event.arguments === "object" ? event.arguments : {};
  const tool = normalize(raw);
  if (tool) recordTrustedIds(event, tool, rootDir);
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
    const promptGate = current.data.prompt_requirement_gate;
    if (promptGate && typeof promptGate === "object" && promptGate.status === "pending" &&
      promptGate.clarification_in_flight === true && promptGate.clarification_fingerprint === fingerprint(input)) {
      const result = event.result ?? event.message;
      const expectedAnswerCount = Array.isArray(input.questions) ? input.questions.length : 0;
      if (!event.error && clarificationAnswered(result, expectedAnswerCount)) {
        promptGate.status = "clarified";
        promptGate.answer_fingerprint = fingerprint(answerValues(result));
        delete promptGate.last_result_error;
      } else {
        promptGate.last_result_error = event.error ? "ask_user_question_failed" :
          rejectedOutcome(result) ? "clarification_cancelled" : "clarification_result_unrecognized";
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
  const requestFingerprint = fingerprint(input);
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

export function endSession(_event: Json, _ctx: Json, rootDir: string): void {
  // YP Action does not reliably provide session lifecycle events. Cleanup is TTL-based
  // and is run on every tool hook; session_end is only an opportunistic sweep.
  store(rootDir);
}
