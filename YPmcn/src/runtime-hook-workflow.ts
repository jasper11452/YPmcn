import { randomUUID } from "node:crypto";

import {
  CONFIRMATION_TTL_MS,
  canonical,
  denyStructured,
  fingerprint,
  globalStore,
  type ConfirmationStatus,
  type GuardStore,
  type Json,
  save,
  sha256Text,
  store,
  text,
  withStoreLock,
} from "./runtime-hook-state.js";

const PREFIXES = ["ypmcn__", "mcp__ypmcn__", "ypmcn-mcp__", "ypmcn-provider__"];
const HOSTED_MCP_PREFIXES = ["ypmcn-mcp_", "ypmcn-provider_"];
const EXTERNAL_SEND_HEADER = "企微外发确认";
const EXTERNAL_SEND_CONFIRM_LABEL = "确认发送";
const EXTERNAL_SEND_CANCEL_LABEL = "取消发送";
const EXTERNAL_SEND_CONFIRMATION_MARKER = "EXTERNAL_SEND_CONFIRMATION_REQUIRED";
const EXTERNAL_SEND_RECEIPT_WINDOW = `${Math.ceil(CONFIRMATION_TTL_MS / 60_000)} 分钟`;
const POST_RACE_MANUAL_CONFIRMATION_HEADER = "赛后补量";
const MCN_CONFIRMATION_HEADER = "MCN确认";
const FIELD_CONFIRMATION_HEADER = "字段确认";
const MCN_RETURN_CONFIRMATION_HEADER = "机构回填确认";
const CONFIRM_MCN_RETURN_LABEL = "确认已完成回填";
const WAIT_MCN_RETURN_LABEL = "尚未完成，继续等待";
const START_POST_RACE_MANUAL_LABEL = "一键发起拓展达人补量";
const REVISE_MCN_SELECTION_LABEL = "追加机构后重新计算";
const SKIP_POST_RACE_MANUAL_LABEL = "暂不补量，继续询价";
const CONFIRM_NO_MANUAL_LABEL = "确认机构方案，继续询价";
const MANUAL_TASK_STATUSES = new Set(["started", "running", "completed"]);
const MANUAL_TASK_OPERATIONS = new Set(["created", "reused"]);
const DISTRIBUTION_SENT_STATUSES = new Set(["sent", "delivered"]);
const DISTRIBUTION_UNBOUND_STATUSES = new Set([
  "unbound", "not_bound", "group_unbound", "group_chat_unbound", "wecom_group_unbound",
]);
const DISTRIBUTION_SENT_LIST_KEYS = ["sent_supplier_ids", "sent_suppliers"];
const DISTRIBUTION_UNBOUND_LIST_KEYS = ["unbound_supplier_ids", "unbound_suppliers"];
const GROUP_BINDING_ERROR = /(?:未绑定|未配置|没有绑定|群聊.{0,12}(?:不存在|无效)|企业微信配置|企微配置|(?:wecom|wechat|group.?chat).{0,24}(?:unbound|not.?bound|missing|not.?configured))/iu;
const GROUP_BINDING_CONTEXT = /(?:群聊|企微|企业微信|wecom|wechat|group.?chat)/iu;
const EXTERNAL_SEND_CONFIRMATION_MODES = new Set([
  "ask_user_question", "unbound_subset_continuation", "individual_fallback_continuation",
]);
const MCN_ID_KEYS = [
  "supplier_id", "supplierId", "mcn_id", "mcnId", "institution_id", "institutionId",
  "agency_id", "agencyId", "vendor_id", "vendorId",
];
const MCN_NAME_KEYS = [
  "supplier_name", "supplierName", "mcn_name", "mcnName", "institution_name", "institutionName",
  "agency_name", "agencyName", "organization_name", "organizationName", "display_name", "displayName",
];
const MCN_CONTEXT_KEY = /(?:mcn|supplier|institution|agency|vendor|recommend)/i;
const REQUIREMENT_PRIMARY_KEY = /^[0-9a-f]{32}$/i;
const REQUIREMENT_BRIEF_TTL_MS = 30 * 60 * 1_000;
const PREFLIGHT_DENIAL_TTL_MS = 5 * 60 * 1_000;
const SEARCH_REQUIREMENT_RECEIPT_KEY = "search_requirement_receipt";
const CURRENT_PROVIDER_CONTRACT_BLOCKS: Record<string, string> = {
  create_submission_batch: "The current Provider requires submission_batche_page and columns instead of the approved number contract. Their semantics cannot be derived from local state, so do not call this write tool or invent a mapping; deploy the approved Provider input contract first.",
  get_workflow_state: "The current Provider requires requirement_id, but approved recovery uses trace_id or demand_id with demand_version. Do not synthesize a requirement_id or call this incompatible recovery tool; deploy the approved Provider input contract first.",
};
const WORKFLOW_EVENT_LIMIT = 200;
const UNIT_SCOPED_ROOT_KEYS = [
  "manual_sourcing_requirement_receipt",
  SEARCH_REQUIREMENT_RECEIPT_KEY,
  "wecom_send_inquiry_id_history",
];

type PreflightDenialReason =
  | "brief_mismatch"
  | "invalid_input"
  | "missing_session_context"
  | "primary_key_format"
  | "requirement_id_mismatch"
  | "requirement_receipt_missing"
  | "workflow_lineage"
  | "workflow_order";

const recentRequirementBriefs = new Map<string, number>();
const preflightDenials = new Map<string, { reason: PreflightDenialReason; expiresAt: number }>();

function pruneTransientReceipts(now = Date.now()): void {
  for (const [hash, expiresAt] of recentRequirementBriefs) {
    if (expiresAt <= now) recentRequirementBriefs.delete(hash);
  }
  for (const [key, receipt] of preflightDenials) {
    if (receipt.expiresAt <= now) preflightDenials.delete(key);
  }
}

function preflightKey(event: Json, tool: string, input: Json): string {
  const callId = text(event.toolCallId)
    ? event.toolCallId.trim()
    : text(event.callID)
      ? event.callID.trim()
      : undefined;
  return callId
    ? `call:${callId}`
    : `input:${tool}:${fingerprint(input)}`;
}

function denyPreflight(
  event: Json,
  tool: string,
  input: Json,
  reason: PreflightDenialReason,
  code: string,
  message: string,
): Json {
  pruneTransientReceipts();
  preflightDenials.set(preflightKey(event, tool, input), {
    reason,
    expiresAt: Date.now() + PREFLIGHT_DENIAL_TTL_MS,
  });
  return denyStructured(code, message);
}

function takePreflightDenial(event: Json, tool: string, input: Json): PreflightDenialReason | undefined {
  pruneTransientReceipts();
  const key = preflightKey(event, tool, input);
  const receipt = preflightDenials.get(key);
  if (receipt) preflightDenials.delete(key);
  return receipt?.reason;
}

function validRequirementPrimaryKey(value: unknown): value is string {
  return text(value) && REQUIREMENT_PRIMARY_KEY.test(value.trim());
}

export function recordRequirementBriefReceipt(brief: string, rootDir: string): void {
  if (!text(brief)) return;
  pruneTransientReceipts();
  const briefHash = sha256Text(brief);
  recentRequirementBriefs.set(briefHash, Date.now() + REQUIREMENT_BRIEF_TTL_MS);
  const current = store(rootDir);
  current.data.source_brief_sha256 = briefHash;
  save(current.path, current.data);
}

export function recordPostValidationIntent(intent: "manual" | "search", rootDir: string): void {
  const current = store(rootDir);
  const workflow = current.data.workflow as Json;
  current.data.pending_post_validation_intent = intent;
  workflow.post_validation_intent = intent;
  workflow.post_validation_actions = [intent === "manual" ? "manual_source_creators" : "search_creators"];
  workflow.next_action = "validate_requirement";
  workflow.waiting_for = null;
  workflow.updated_at_ms = Date.now();
  save(current.path, current.data);
}

export function recordManualCreatorListDisplay(messages: unknown, rootDir: string): void {
  if (!Array.isArray(messages)) return;
  const current = store(rootDir);
  const workflow = current.data.workflow as Json;
  if (
    workflow.manual_sourcing_creator_list_display_status !== "required" ||
    !text(workflow.manual_sourcing_display_marker)
  ) return;
  const marker = workflow.manual_sourcing_display_marker.trim();
  const observed = messages.some((message) => {
    if (!message || typeof message !== "object" || (message as Json).role !== "assistant") return false;
    const values: unknown[] = [(message as Json).content, (message as Json).text, (message as Json).message];
    const serialized = values.map((value) => typeof value === "string" ? value : JSON.stringify(value ?? "")).join("\n");
    return serialized.includes(`<!-- ${marker} -->`) &&
      serialized.includes("| 平台 |") && serialized.includes("| 达人ID |") &&
      serialized.includes("| 达人昵称 |") && serialized.includes("| 内容标签 |") &&
      serialized.includes("| 主页链接 |");
  });
  if (!observed) return;
  workflow.manual_sourcing_creator_list_displayed = true;
  workflow.manual_sourcing_creator_list_display_status = "displayed";
  workflow.manual_sourcing_creator_list_displayed_at_ms = Date.now();
  workflow.updated_at_ms = workflow.manual_sourcing_creator_list_displayed_at_ms;
  save(current.path, current.data);
}

export function normalize(name: string): string | undefined {
  for (const prefix of PREFIXES) {
    if (name.startsWith(prefix)) return name.slice(prefix.length) || undefined;
  }
  for (const prefix of HOSTED_MCP_PREFIXES) {
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
  return [
    column.label, column.name, column.field_name,
    column.field, column.key, column.field_key,
  ].find(text)?.trim();
}

type InquiryColumn = { key: string; name: string };

function normalizedInquiryColumn(value: unknown): InquiryColumn | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const column = value as Json;
  const key = [column.key, column.field_key, column.field, column.database_field].find(text)?.trim();
  const name = [column.name, column.field_name, column.label, column.description].find(text)?.trim();
  return key && name ? { key, name } : undefined;
}

function validInquiryColumns(value: unknown): InquiryColumn[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const columns = value.map(normalizedInquiryColumn);
  if (columns.some((column) => !column)) return undefined;
  const normalized = columns as InquiryColumn[];
  return new Set(normalized.map(({ key }) => key)).size === normalized.length ? normalized : undefined;
}

function columnsFromDescription(value: unknown): InquiryColumn[] | undefined {
  if (!text(value)) return undefined;
  const columns = value.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*([^：:]+?)\s*[：:]\s*(.+?)\s*$/.exec(line);
    return match ? [{ key: match[1].trim(), name: match[2].trim() }] : [];
  });
  return validInquiryColumns(columns);
}

function fieldSelectionEvidence(root: unknown): InquiryColumn[] | undefined {
  const candidates: InquiryColumn[][] = [];
  const visit = (value: unknown, key?: string): void => {
    if (Array.isArray(value)) {
      const columns = validInquiryColumns(value);
      if (columns) candidates.push(columns);
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") {
      if (key && /description/i.test(key)) {
        const columns = columnsFromDescription(value);
        if (columns) candidates.push(columns);
      }
      return;
    }
    for (const [childKey, child] of Object.entries(value as Json)) visit(child, childKey);
  };
  visit(unwrap(root));
  const unique = new Map(candidates.map((columns) => [canonical(columns), columns]));
  return unique.size === 1 ? [...unique.values()][0] : undefined;
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

function firstQuestion(input: Json): Json | undefined {
  const questions = Array.isArray(input.questions) ? input.questions : [input];
  if (questions.length !== 1 || !questions[0] || typeof questions[0] !== "object") return undefined;
  return questions[0] as Json;
}

function questionOptionLabels(question: Json): string[] {
  if (!Array.isArray(question.options)) return [];
  return question.options.map((option) => {
    if (text(option)) return option.trim();
    return option && typeof option === "object" && text(option.label) ? option.label.trim() : undefined;
  }).filter(text);
}

function answerForQuestion(event: Json, input: Json): string | undefined {
  if (event.error) return undefined;
  const question = firstQuestion(input);
  if (!question || !text(question.question)) return undefined;
  const questionText = question.question.trim();
  const labels = questionOptionLabels(question);
  for (const candidate of answerValues(event.result ?? event.message)) {
    if (labels.includes(candidate)) return candidate;
    const prefix = `${questionText}: `;
    if (!candidate.startsWith(prefix)) continue;
    const answer = candidate.slice(prefix.length).trim();
    if (labels.includes(answer)) return answer;
  }
  return undefined;
}

function echoedExternalSendSelection(event: Json): { question: string; answer: string } | undefined {
  if (event.error) return undefined;
  for (const candidate of answerValues(event.result ?? event.message)) {
    for (const answer of [EXTERNAL_SEND_CONFIRM_LABEL, EXTERNAL_SEND_CANCEL_LABEL]) {
      const suffix = `: ${answer}`;
      if (!candidate.endsWith(suffix)) continue;
      const question = candidate.slice(0, -suffix.length).trim();
      if (question) return { question, answer };
    }
  }
  return undefined;
}

function firstQuestionHeader(input: Json): string | undefined {
  const question = firstQuestion(input);
  if (!question) return undefined;
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

function identifierText(value: unknown): string | undefined {
  if (text(value)) return value.trim();
  return Number.isSafeInteger(value) && Number(value) > 0 ? String(value) : undefined;
}

function objectRecords(root: unknown): Json[] {
  const queue: unknown[] = [unwrap(root)];
  const records: Json[] = [];
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
    records.push(record);
    queue.push(...Object.values(record));
  }
  return records;
}

function approvedTargetData(root: unknown): Json | undefined {
  const envelope = unwrap(root);
  if (
    !envelope || typeof envelope !== "object" || Array.isArray(envelope) ||
    envelope.success !== true || envelope.error !== null ||
    !envelope.data || typeof envelope.data !== "object" || Array.isArray(envelope.data)
  ) return undefined;
  return envelope.data as Json;
}

type SupplyRiskLevel = "high_risk" | "medium_risk" | "safe";

function supplyRiskLevel(coverageCount: number, demandCount: number): SupplyRiskLevel {
  if (coverageCount < demandCount * 20) return "high_risk";
  if (coverageCount < demandCount * 30) return "medium_risk";
  return "safe";
}

function multiplierMatches(value: unknown, coverageCount: number, demandCount: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 &&
    Math.abs(value - coverageCount / demandCount) <= 0.01;
}

type SearchSupplyEvidence = {
  demandCount: number;
  rateCardCreatorCount: number;
  rateCardMultiplier: number;
  riskLevel: SupplyRiskLevel;
  contract: "supply-assessment-v2";
  recommendedAction?: string;
};

function providerSupplyRisk(value: unknown): SupplyRiskLevel | undefined {
  if (value === "high_risk" || value === "medium_risk" || value === "safe") return value;
  return value === "low_risk" ? "safe" : undefined;
}

function currentSearchSupplyEvidence(data: Json, workflow: Json): SearchSupplyEvidence | undefined {
  const assessment = data.supply_assessment;
  if (!assessment || typeof assessment !== "object" || Array.isArray(assessment)) return undefined;
  const candidateCount = assessment.candidate_count;
  const demandCount = assessment.quantity_total;
  const multiplier = assessment.supply_multiplier;
  const statedRisk = providerSupplyRisk(assessment.supply_risk_level);
  const recommendedAction = text(assessment.recommended_action)
    ? assessment.recommended_action.trim()
    : undefined;
  if (
    !Number.isInteger(data.total_matched) || data.total_matched < 0 ||
    !Number.isInteger(candidateCount) || candidateCount < 0 || candidateCount !== data.total_matched ||
    !Number.isInteger(demandCount) || demandCount < 1 ||
    !multiplierMatches(multiplier, candidateCount, demandCount) ||
    !statedRisk || !recommendedAction
  ) return undefined;
  if (Number.isInteger(workflow.quantity_total) && workflow.quantity_total !== demandCount) return undefined;
  const calculatedRisk = supplyRiskLevel(candidateCount, demandCount);
  if (calculatedRisk !== statedRisk) return undefined;
  return {
    demandCount,
    rateCardCreatorCount: candidateCount,
    rateCardMultiplier: multiplier,
    riskLevel: calculatedRisk,
    contract: "supply-assessment-v2",
    recommendedAction,
  };
}

function searchSupplyEvidence(root: unknown, workflow: Json): SearchSupplyEvidence | undefined {
  const data = approvedTargetData(root);
  if (!data) return undefined;
  return currentSearchSupplyEvidence(data, workflow);
}

type RankMcnCoverageEvidence = {
  inquiryId: string;
  demandCount: number;
  selectedSupplierIds: string[];
  selectedMcnCount: number;
  coveredCreatorCount: number;
  coverageMultiplier: number;
  riskLevel: SupplyRiskLevel;
  manualSourcingGapCount: number;
  institutionManualCreatorRatio: string;
};

type ManualSourcingEvidence = {
  taskId: string;
  inquiryId: string;
  targetCount: number;
  status: string;
  operation: string;
  startedAt: string;
  acceptedCount: number;
};

type DirectManualSourcingEvidence = {
  requirementId: string;
  size: string;
  excelFilePath?: string;
  creatorCount: number;
  creatorRowsSha256: string;
  creatorFields: string[];
};

const MANUAL_REQUIREMENT_RECEIPT_KEY = "manual_sourcing_requirement_receipt";

function validationRequirementId(root: unknown): string | undefined {
  const data = approvedTargetData(root);
  if (!data) return undefined;
  return validRequirementPrimaryKey(data.id) ? data.id.trim() : undefined;
}

function freshRequirementReceipt(requirementId: string, now: number): Json {
  return {
    requirement_id_sha256: sha256Text(requirementId),
    status: "fresh",
    issued_at_ms: now,
  };
}

function recordRequirementReceipts(
  event: Json,
  tool: string,
  rootDir: string,
  preflightDenial?: PreflightDenialReason,
): void {
  const current = store(rootDir);
  const global = globalStore(rootDir);
  const now = Date.now();

  if (tool === "validate_requirement") {
    const requirementId = event.error ? undefined : validationRequirementId(event.result);
    // Mirror the handoff receipt so before_tool_call can verify the immediately
    // following manual call even when the host drops its session identifier.
    for (const target of global.path === current.path ? [current] : [current, global]) {
      if (requirementId) {
        target.data[MANUAL_REQUIREMENT_RECEIPT_KEY] = freshRequirementReceipt(requirementId, now);
        target.data[SEARCH_REQUIREMENT_RECEIPT_KEY] = freshRequirementReceipt(requirementId, now);
      } else {
        delete target.data[MANUAL_REQUIREMENT_RECEIPT_KEY];
        delete target.data[SEARCH_REQUIREMENT_RECEIPT_KEY];
      }
      save(target.path, target.data);
    }
    return;
  }

  if (preflightDenial === "primary_key_format" || preflightDenial === "brief_mismatch") return;
  const currentManualHash = (current.data[MANUAL_REQUIREMENT_RECEIPT_KEY] as Json | undefined)?.requirement_id_sha256;
  const currentSearchHash = (current.data[SEARCH_REQUIREMENT_RECEIPT_KEY] as Json | undefined)?.requirement_id_sha256;
  for (const target of global.path === current.path ? [current] : [current, global]) {
    let changed = false;
    const manualReceipt = target.data[MANUAL_REQUIREMENT_RECEIPT_KEY] as Json | undefined;
    const searchReceipt = target.data[SEARCH_REQUIREMENT_RECEIPT_KEY] as Json | undefined;
    if (manualReceipt?.status === "fresh" && (target === current || manualReceipt.requirement_id_sha256 === currentManualHash)) {
      manualReceipt.status = tool === "manual_source_creators" ? "consumed" : "expired";
      manualReceipt.updated_at_ms = now;
      target.data[MANUAL_REQUIREMENT_RECEIPT_KEY] = manualReceipt;
      changed = true;
    }
    if (searchReceipt?.status === "fresh" && (target === current || searchReceipt.requirement_id_sha256 === currentSearchHash)) {
      searchReceipt.status = tool === "search_creators" ? "consumed" : "expired";
      searchReceipt.updated_at_ms = now;
      target.data[SEARCH_REQUIREMENT_RECEIPT_KEY] = searchReceipt;
      changed = true;
    }
    if (changed) save(target.path, target.data);
  }
}

function authorizeFreshManualRequirement(
  event: Json,
  input: Json,
  current: GuardStore,
  rootDir: string,
): Json | undefined {
  const workflow = current.data.workflow as Json;
  if (workflow.search_flow_started === true && workflow.mcn_flow_completed !== true) {
    return denyPreflight(
      event, "manual_source_creators", input, "workflow_order", "INVALID_PHASE",
      "search_creators started the mandatory MCN flow. Complete rank_mcns, user-operated field selection, confirmed WeCom distribution, and its required sync step before manual sourcing.",
    );
  }
  const receipt = current.data[MANUAL_REQUIREMENT_RECEIPT_KEY] as Json | undefined;
  if (receipt?.status !== "fresh" || !text(receipt.requirement_id_sha256)) {
    return denyPreflight(
      event, "manual_source_creators", input, "requirement_receipt_missing", "INVALID_PHASE",
      "manual_source_creators requires a fresh same-session validate_requirement receipt. Do not reuse a historical ID.",
    );
  }
  if (sha256Text(input.requirement_id.trim()) !== receipt.requirement_id_sha256) {
    receipt.status = "expired";
    receipt.updated_at_ms = Date.now();
    current.data[MANUAL_REQUIREMENT_RECEIPT_KEY] = receipt;
    save(current.path, current.data);
    return denyPreflight(
      event, "manual_source_creators", input, "requirement_id_mismatch", "INVALID_INPUT",
      "manual_source_creators.requirement_id must equal data.id from the immediately preceding successful validate_requirement response; data.demand_id is never valid.",
    );
  }

  receipt.status = "consumed";
  receipt.updated_at_ms = Date.now();
  current.data[MANUAL_REQUIREMENT_RECEIPT_KEY] = receipt;
  save(current.path, current.data);
  const global = globalStore(rootDir);
  const mirrored = global.data[MANUAL_REQUIREMENT_RECEIPT_KEY] as Json | undefined;
  if (
    global.path !== current.path && mirrored?.status === "fresh" &&
    mirrored.requirement_id_sha256 === receipt.requirement_id_sha256
  ) {
    mirrored.status = "consumed";
    mirrored.updated_at_ms = receipt.updated_at_ms;
    global.data[MANUAL_REQUIREMENT_RECEIPT_KEY] = mirrored;
    save(global.path, global.data);
  }
  return undefined;
}

function authorizeFreshSearchRequirement(event: Json, input: Json, current: GuardStore): Json | undefined {
  const receipt = current.data[SEARCH_REQUIREMENT_RECEIPT_KEY] as Json | undefined;
  if (receipt?.status !== "fresh" || !text(receipt.requirement_id_sha256)) {
    return denyPreflight(
      event, "search_creators", input, "requirement_receipt_missing", "INVALID_PHASE",
      "search_creators requires data.id from the latest successful same-session validate_requirement response. Do not create another requirement merely to recover from an ID namespace mistake.",
    );
  }
  if (sha256Text(input.id.trim()) !== receipt.requirement_id_sha256) {
    return denyPreflight(
      event, "search_creators", input, "requirement_id_mismatch", "INVALID_INPUT",
      "search_creators.id must equal data.id from the latest successful validate_requirement response; data.demand_id is never valid.",
    );
  }
  receipt.status = "consumed";
  receipt.updated_at_ms = Date.now();
  current.data[SEARCH_REQUIREMENT_RECEIPT_KEY] = receipt;
  save(current.path, current.data);
  return undefined;
}

function authorizeRequirementBrief(event: Json, input: Json): Json | undefined {
  const originalBrief = input.payload?.rawMessagesJson?.originalBrief;
  if (!text(originalBrief)) {
    return denyPreflight(
      event, "validate_requirement", input, "brief_mismatch", "INVALID_INPUT",
      "validate_requirement.payload.rawMessagesJson.originalBrief must contain the exact original client Brief.",
    );
  }
  pruneTransientReceipts();
  if (!recentRequirementBriefs.has(sha256Text(originalBrief))) {
    return denyPreflight(
      event, "validate_requirement", input, "brief_mismatch", "INVALID_INPUT",
      "rawMessagesJson.originalBrief does not exactly match a recent client Brief. Preserve the full original text; never add retry markers or reconstruct a platform-specific Brief.",
    );
  }
  return undefined;
}

function authorizeFieldSelection(event: Json, input: Json, current: GuardStore): Json | undefined {
  if (!text(input.platform) || !["xiaohongshu", "douyin"].includes(input.platform.trim())) {
    return denyPreflight(
      event, "select_inquiry_form_fields", input, "invalid_input", "INVALID_INPUT",
      "select_inquiry_form_fields.platform must be the confirmed xiaohongshu or douyin platform.",
    );
  }
  const workflow = current.data.workflow as Json;
  if (workflow.field_selection_attempted === true) {
    return denyPreflight(
      event, "select_inquiry_form_fields", input, "workflow_order", "INVALID_PHASE",
      "select_inquiry_form_fields was already opened for the active MCN flow. Wait for and use only the user's webpage callback; never select fields for the user or reopen the selector after success, cancellation, timeout, or an invalid callback.",
    );
  }
  return undefined;
}

function authorizeRankCreators(event: Json, input: Json, current: GuardStore): Json | undefined {
  const workflow = current.data.workflow as Json;
  if (
    workflow.phase !== "candidate_pool_enriched" || workflow.next_action !== "rank_creators" ||
    (workflow.manual_sourcing_creator_data_received !== true && workflow.mcn_submissions_ingested !== true)
  ) {
    return denyPreflight(
      event, "rank_creators", input, "workflow_order", "INVALID_PHASE",
      "rank_creators requires either the current manual creator-data receipt or the current successfully ingested MCN submissions.",
    );
  }
  const inquiryId = latestWecomSendInquiryId(current.data);
  const hasInquiryIds = Object.prototype.hasOwnProperty.call(input, "inquiry_ids");
  const inquiryIds = input.inquiry_ids;
  const matchesLatestInquiry = Array.isArray(inquiryIds) && inquiryIds.length === 1 &&
    inquiryIds[0] === inquiryId;
  if (
    !text(workflow.requirement_id) || input.requirement_id !== workflow.requirement_id ||
    Object.prototype.hasOwnProperty.call(input, "inquiry_id") ||
    (inquiryId ? !matchesLatestInquiry : hasInquiryIds && inquiryIds !== null)
  ) {
    return denyPreflight(
      event, "rank_creators", input, "workflow_lineage", "INVALID_INPUT",
      "rank_creators must use the current manual-sourcing requirement_id. If a prior verified create_with_distributions result returned an inquiry_id, pass an inquiry_ids array containing exactly the most recent such inquiry_id; otherwise omit inquiry_ids or use null.",
    );
  }
  return undefined;
}

function authorizeSubmissionBatch(event: Json, input: Json, current: GuardStore): Json | undefined {
  const workflow = current.data.workflow as Json;
  if (workflow.phase !== "recommendation_ready" || workflow.next_action !== "create_submission_batch") {
    return denyPreflight(
      event, "create_submission_batch", input, "workflow_order", "INVALID_PHASE",
      "create_submission_batch requires the immediately preceding successful rank_creators result.",
    );
  }
  if (
    workflow.rank_creators_evidence_status !== "valid" ||
    !text(workflow.requirement_id) || input.requirement_id !== workflow.requirement_id ||
    !text(workflow.manual_sourcing_size) || input.size !== workflow.manual_sourcing_size ||
    !text(input.number) || !/^[1-9]\d*$/.test(input.number.trim())
  ) {
    return denyPreflight(
      event, "create_submission_batch", input, "workflow_lineage", "INVALID_INPUT",
      "create_submission_batch must use the current manual sourcing requirement_id and size plus a positive integer batch number.",
    );
  }
  return undefined;
}

type DistributionOutcomeEvidence = {
  projectId?: string;
  inquiryId?: string;
  requestedCount: number;
  sentCount: number;
  unboundCount: number;
  outcomes: Array<{ supplierId: string; status: "sent" | "unbound" }>;
};

function latestWecomSendInquiryId(data: Json): string | undefined {
  if (!Array.isArray(data.wecom_send_inquiry_id_history)) return undefined;
  return data.wecom_send_inquiry_id_history.find(text)?.trim();
}

function recordWecomSendInquiryId(data: Json, inquiryId: string | undefined): void {
  if (!inquiryId) return;
  const previous = Array.isArray(data.wecom_send_inquiry_id_history)
    ? data.wecom_send_inquiry_id_history.filter(text).map((value: string) => value.trim())
    : [];
  data.wecom_send_inquiry_id_history = [
    inquiryId,
    ...previous.filter((value: string) => value !== inquiryId),
  ].slice(0, 100);
}

type DistributionUnboundRejectionEvidence = {
  remainingSupplierIds: string[];
  unboundSupplierIds: string[];
  unboundCount: number;
};

type DistributionBatchFallbackEvidence = {
  supplierIds: string[];
};

function rankMcnCoverageEvidence(
  root: unknown,
  input: Json,
  workflow: Json,
): RankMcnCoverageEvidence | undefined {
  const data = approvedTargetData(root);
  if (!data || input.write_mcn_recommendation_items === false) return undefined;
  if (
    !text(workflow.requirement_id) || !text(input.id) ||
    input.id.trim() !== workflow.requirement_id.trim()
  ) return undefined;

  const matches: RankMcnCoverageEvidence[] = [];
  for (const record of objectRecords(data)) {
    const inquiryId = identifierText(record.inquiry_id);
    const demandCount = record.demand_count;
    const selectedMcnCount = record.selected_mcn_count;
    const coveredCreatorCount = record.selected_mcn_covered_creator_count;
    const coverageMultiplier = record.selected_mcn_coverage_multiplier;
    const riskLevel = record.selected_mcn_risk_level;
    const manualSourcingGapCount = record.manual_sourcing_gap_count;
    const rawSupplierIds = record.selected_supplier_ids;
    if (
      !inquiryId || !Number.isInteger(demandCount) || demandCount < 1 ||
      !Array.isArray(rawSupplierIds) || rawSupplierIds.length < 1 ||
      !rawSupplierIds.every(text) || !Number.isInteger(selectedMcnCount) || selectedMcnCount < 1 ||
      record.coverage_scope !== "selected_institutions_deduplicated_union" ||
      !Number.isInteger(coveredCreatorCount) || coveredCreatorCount < 0 ||
      !multiplierMatches(coverageMultiplier, coveredCreatorCount, demandCount) ||
      !["high_risk", "medium_risk", "safe"].includes(riskLevel)
    ) continue;
    const selectedSupplierIds = rawSupplierIds.map((supplierId: string) => supplierId.trim());
    if (new Set(selectedSupplierIds).size !== selectedSupplierIds.length) continue;
    if (selectedMcnCount !== selectedSupplierIds.length) continue;
    if (Number.isInteger(workflow.quantity_total) && workflow.quantity_total !== demandCount) continue;
    const expectedRisk = supplyRiskLevel(coveredCreatorCount, demandCount);
    if (riskLevel !== expectedRisk) continue;
    const expectedGap = Math.max(demandCount * 20 - coveredCreatorCount, 0);
    // Older Provider revisions returned null once the selected institutions
    // already reached 20x. Normalize that legacy success shape to the explicit
    // zero the confirmation UI now requires.
    if (manualSourcingGapCount !== expectedGap && !(expectedGap === 0 && manualSourcingGapCount === null)) {
      continue;
    }
    matches.push({
      inquiryId,
      demandCount,
      selectedSupplierIds,
      selectedMcnCount,
      coveredCreatorCount,
      coverageMultiplier,
      riskLevel: expectedRisk,
      manualSourcingGapCount: expectedGap,
      institutionManualCreatorRatio: `${demandCount}:${expectedGap}`,
    });
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function manualSourcingEvidence(
  root: unknown,
  input: Json,
  workflow: Json,
): ManualSourcingEvidence | undefined {
  const data = approvedTargetData(root);
  if (!data) return undefined;
  const expectedRequirementId = text(workflow.requirement_id) ? workflow.requirement_id.trim() : undefined;
  const expectedInquiryId = identifierText(workflow.rank_mcn_inquiry_id);
  const expectedTarget = workflow.pending_manual_target_count;
  if (
    !expectedRequirementId || !expectedInquiryId || !Number.isInteger(expectedTarget) || expectedTarget < 1 ||
    workflow.post_race_risk_level !== "high_risk" ||
    workflow.post_race_manual_sourcing_gap_count !== expectedTarget ||
    !text(input.requirement_id) || input.requirement_id.trim() !== expectedRequirementId ||
    input.target_count !== expectedTarget
  ) return undefined;

  const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
  for (const record of objectRecords(data)) {
    const taskId = record.task_id;
    const requirementId = record.requirement_id;
    const inquiryId = identifierText(record.inquiry_id);
    const targetCount = record.target_count;
    const status = record.status;
    const operation = record.operation;
    const startedAt = record.started_at;
    const acceptedCount = record.accepted_count;
    if (
      !text(taskId) || !text(requirementId) || requirementId.trim() !== expectedRequirementId ||
      inquiryId !== expectedInquiryId || targetCount !== expectedTarget ||
      !text(status) || !MANUAL_TASK_STATUSES.has(status) ||
      !text(operation) || !MANUAL_TASK_OPERATIONS.has(operation) ||
      !text(startedAt) || !timestampPattern.test(startedAt) || Number.isNaN(Date.parse(startedAt)) ||
      !Number.isInteger(acceptedCount) || acceptedCount < 0
    ) continue;
    return {
      taskId: taskId.trim(),
      inquiryId,
      targetCount,
      status,
      operation,
      startedAt,
      acceptedCount,
    };
  }
  return undefined;
}

function directManualSourcingEvidence(
  root: unknown,
  input: Json,
): DirectManualSourcingEvidence | undefined {
  if (
    !text(input.requirement_id) || !text(input.size) ||
    !/^[1-9]\d*$/.test(input.size.trim())
  ) return undefined;
  const envelope = unwrap(root);
  if (
    !envelope || typeof envelope !== "object" || Array.isArray(envelope) ||
    envelope.success !== true || envelope.error !== null
  ) return undefined;

  const candidates = objectRecords(envelope.data)
    .map((record) => record.excel_file_path)
    .filter(text)
    .map((value) => value.trim());
  const unique = new Set(candidates);
  if (unique.size > 1) return undefined;

  const fixedFields = ["platform", "douyinId", "xiaohongshuId", "nickname", "contentTag", "kwUserUrl"];
  const creatorArrays: Json[][] = [];
  for (const record of objectRecords(envelope.data)) {
    for (const key of ["creators", "creator_list", "manual_sourced_creators"]) {
      if (!Array.isArray(record[key]) || record[key].length === 0) continue;
      const rows = record[key].filter((item: unknown): item is Json =>
        Boolean(item && typeof item === "object" && !Array.isArray(item))
      );
      if (rows.length === record[key].length && rows.every((row) => fixedFields.some((field) => row[field] !== undefined))) {
        creatorArrays.push(rows);
      }
    }
  }
  const creatorSets = new Map(creatorArrays.map((rows) => [canonical(rows), rows]));
  if (creatorSets.size !== 1) return undefined;
  const creatorRows = [...creatorSets.values()][0];
  const creatorFields = fixedFields.filter((field) => creatorRows.some((row) => row[field] !== undefined));

  return {
    requirementId: input.requirement_id.trim(),
    size: input.size.trim(),
    ...(unique.size === 1 ? { excelFilePath: [...unique][0] } : {}),
    creatorCount: creatorRows.length,
    creatorRowsSha256: sha256Text(canonical(creatorRows)),
    creatorFields,
  };
}

function syncInquiryIdsEvidence(root: unknown): string[] | undefined {
  const data = approvedTargetData(root);
  if (!data) return undefined;
  const candidates: string[][] = [];
  for (const record of objectRecords(data)) {
    if (Array.isArray(record.inquiry_ids) && record.inquiry_ids.length > 0) {
      const ids = record.inquiry_ids.map(identifierText);
      if (ids.every(text)) candidates.push(ids as string[]);
    }
    const inquiryId = identifierText(record.inquiry_id);
    if (inquiryId) candidates.push([inquiryId]);
  }
  const normalized = candidates
    .map((ids) => [...new Set(ids)])
    .filter((ids) => ids.length > 0);
  const unique = new Map(normalized.map((ids) => [canonical(ids), ids]));
  return unique.size === 1 ? [...unique.values()][0] : undefined;
}

function rankCreatorsEvidence(root: unknown): Json | undefined {
  const envelope = unwrap(root);
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return undefined;
  const records = objectRecords(envelope.data);
  return records.find((record) =>
    (Array.isArray(record.batch_items) && record.batch_items.length > 0) ||
    (text(record.run_id) && Number.isInteger(record.ranked_count) && record.ranked_count > 0)
  );
}

function submissionBatchEvidence(root: unknown): Json | undefined {
  const envelope = unwrap(root);
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return undefined;
  const records = objectRecords(envelope.data);
  return records.find((record) =>
    record.exported === true ||
    [record.file_url, record.download_url, record.spreadsheet_url].some(text) ||
    (text(record.submission_batch_id) && ["success", "completed", "exported"].includes(record.status))
  );
}

function normalizeInstitutionId(value: string): string {
  return value.replaceAll("-", "");
}

function distributionSupplierId(value: unknown): string | undefined {
  if (text(value)) return normalizeInstitutionId(value.trim());
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Json;
  const direct = recordText(record, [...MCN_ID_KEYS, "supplier"]);
  if (direct) return normalizeInstitutionId(direct);
  for (const key of ["supplier", "mcn", "institution", "agency", "vendor"]) {
    const nested = record[key];
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) continue;
    const nestedId = recordText(nested as Json, ["id", ...MCN_ID_KEYS]);
    if (nestedId) return normalizeInstitutionId(nestedId);
  }
  return undefined;
}

function distributionSupplierName(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Json;
  const direct = recordText(record, [...MCN_NAME_KEYS, "name"]);
  if (direct) return direct;
  for (const key of ["supplier", "mcn", "institution", "agency", "vendor"]) {
    const nested = record[key];
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) continue;
    const nestedName = recordText(nested as Json, ["name", ...MCN_NAME_KEYS]);
    if (nestedName) return nestedName;
  }
  return undefined;
}

function rawObjectRecords(root: unknown): Json[] {
  const queue: unknown[] = [root];
  const records: Json[] = [];
  const seen = new Set<unknown>();
  while (queue.length > 0) {
    const value = queue.shift();
    if (typeof value === "string") {
      const parsed = parsedJsonObject(value);
      if (parsed) queue.push(parsed);
      continue;
    }
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      queue.push(...value);
      continue;
    }
    const record = value as Json;
    records.push(record);
    queue.push(...Object.values(record));
  }
  return records;
}

function rawResultTexts(root: unknown): string[] {
  const queue: unknown[] = [root];
  const values: string[] = [];
  const seen = new Set<unknown>();
  while (queue.length > 0) {
    const value = queue.shift();
    if (typeof value === "string") {
      values.push(value.normalize("NFKC").trim());
      const parsed = parsedJsonObject(value);
      if (parsed) queue.push(parsed);
      continue;
    }
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    queue.push(...(Array.isArray(value) ? value : Object.values(value as Json)));
  }
  return values.filter(text);
}

function definiteFailureEnvelope(root: unknown): boolean {
  if (successful(root)) return false;
  return rawObjectRecords(root).some((record) =>
    record.success === false || record.ok === false || record.isError === true ||
    (text(record.status) && ["error", "failed", "failure", "rejected"].includes(record.status.toLowerCase())) ||
    (record.error !== null && record.error !== undefined && record.error !== false)
  );
}

function hasDistributionWriteEvidence(root: unknown): boolean {
  for (const record of rawObjectRecords(root)) {
    if ([
      "project_id", "provider_project_id", "distribution_id", "distributionId",
    ].some((key) => identifierText(record[key]) !== undefined)) return true;
    if (["created", "distributions"].some((key) => Array.isArray(record[key]) && record[key].length > 0)) {
      return true;
    }
    for (const key of DISTRIBUTION_SENT_LIST_KEYS) {
      if (Array.isArray(record[key]) && record[key].length > 0) return true;
    }
    const status = recordText(record, ["notification_status", "send_status", "outcome", "status"])
      ?.toLowerCase();
    if (status && DISTRIBUTION_SENT_STATUSES.has(status)) return true;
  }
  return false;
}

function distributionBatchFallbackEvidence(
  event: Json,
  input: Json,
): DistributionBatchFallbackEvidence | undefined {
  if (
    event.error || !definiteFailureEnvelope(event.result) || hasDistributionWriteEvidence(event.result) ||
    !Array.isArray(input.supplierIds) || input.supplierIds.length < 2
  ) return undefined;
  const supplierIds = input.supplierIds.filter(text).map((supplierId: string) => supplierId.trim());
  if (supplierIds.length !== input.supplierIds.length || new Set(supplierIds).size !== supplierIds.length) {
    return undefined;
  }
  return { supplierIds };
}

function distributionUnboundRejectionEvidence(
  event: Json,
  input: Json,
  workflow: Json,
): DistributionUnboundRejectionEvidence | undefined {
  if (
    event.error || !definiteFailureEnvelope(event.result) || hasDistributionWriteEvidence(event.result) ||
    !Array.isArray(input.supplierIds) || input.supplierIds.length === 0
  ) return undefined;
  const requested = input.supplierIds.filter(text).map((supplierId: string) => supplierId.trim());
  if (requested.length !== input.supplierIds.length || new Set(requested).size !== requested.length) return undefined;
  const requestedByNormalizedId = new Map(
    requested.map((supplierId) => [normalizeInstitutionId(supplierId), supplierId]),
  );
  if (requestedByNormalizedId.size !== requested.length) return undefined;
  const unbound = new Set<string>();
  const unboundNames = new Set<string>();
  let structuredBindingEvidence = false;
  const addUnbound = (supplierId: string | undefined) => {
    const requestedSupplierId = supplierId
      ? requestedByNormalizedId.get(normalizeInstitutionId(supplierId))
      : undefined;
    if (requestedSupplierId) unbound.add(requestedSupplierId);
  };

  for (const record of rawObjectRecords(event.result)) {
    for (const key of DISTRIBUTION_UNBOUND_LIST_KEYS) {
      if (!Array.isArray(record[key])) continue;
      structuredBindingEvidence = true;
      for (const item of record[key]) {
        addUnbound(distributionSupplierId(item));
        const supplierName = distributionSupplierName(item);
        if (supplierName) unboundNames.add(supplierName);
      }
    }
    const status = recordText(record, ["notification_status", "send_status", "outcome", "status"])
      ?.toLowerCase();
    const bindingFlag = ["group_chat_bound", "wechat_group_bound", "wecom_group_bound", "is_group_bound"]
      .map((key) => record[key])
      .find((value) => typeof value === "boolean");
    const error = recordText(record, ["notification_error", "send_error", "reason", "message", "detail"]);
    const recordProvesUnbound = bindingFlag === false ||
      Boolean(status && DISTRIBUTION_UNBOUND_STATUSES.has(status)) ||
      Boolean(error && GROUP_BINDING_ERROR.test(error) && GROUP_BINDING_CONTEXT.test(error));
    if (!recordProvesUnbound) continue;
    structuredBindingEvidence = true;
    addUnbound(distributionSupplierId(record));
    const supplierName = distributionSupplierName(record);
    if (supplierName) unboundNames.add(supplierName);
  }

  const bindingMessages = rawResultTexts(event.result).filter((value) =>
    GROUP_BINDING_ERROR.test(value) && GROUP_BINDING_CONTEXT.test(value)
  );
  if (bindingMessages.length > 0) {
    const mentionedIds = requested.filter((supplierId) =>
      bindingMessages.some((message) => message.includes(supplierId))
    );
    for (const supplierId of mentionedIds) {
      if (!mentionedIds.some((other) => other !== supplierId && other.includes(supplierId))) {
        addUnbound(supplierId);
      }
    }
  }

  const requestedByHash = new Map(requested.map((supplierId) => [sha256Text(supplierId), supplierId]));
  const supplierIdsByName = new Map<string, string[]>();
  if (Array.isArray(workflow.mcn_recipient_directory)) {
    for (const recipient of workflow.mcn_recipient_directory) {
      if (!recipient || typeof recipient !== "object" || !text(recipient.name)) continue;
      const supplierId = text(recipient.supplier_id_sha256)
        ? requestedByHash.get(recipient.supplier_id_sha256.trim())
        : undefined;
      if (!supplierId) continue;
      const supplierIds = supplierIdsByName.get(recipient.name.trim()) ?? [];
      supplierIds.push(supplierId);
      supplierIdsByName.set(recipient.name.trim(), supplierIds);
    }
  }
  const mentionedNames = [...supplierIdsByName.keys()].filter((name) =>
    unboundNames.has(name) || bindingMessages.some((message) => message.includes(name))
  );
  for (const name of mentionedNames) {
    if (mentionedNames.some((other) => other !== name && other.includes(name))) continue;
    const supplierIds = supplierIdsByName.get(name) ?? [];
    if (supplierIds.length === 1) addUnbound(supplierIds[0]);
  }

  if ((!structuredBindingEvidence && bindingMessages.length === 0) || unbound.size === 0) return undefined;
  return {
    remainingSupplierIds: requested.filter((supplierId) => !unbound.has(supplierId)),
    unboundSupplierIds: requested.filter((supplierId) => unbound.has(supplierId)),
    unboundCount: unbound.size,
  };
}

function distributionOutcomeEvidence(root: unknown, input: Json): DistributionOutcomeEvidence | undefined {
  const data = approvedTargetData(root);
  if (!data || !Array.isArray(input.supplierIds) || input.supplierIds.length === 0) return undefined;
  const requested = input.supplierIds.filter(text).map((supplierId: string) => supplierId.trim());
  if (requested.length !== input.supplierIds.length || new Set(requested).size !== requested.length) return undefined;
  const requestedByNormalizedId = new Map(
    requested.map((supplierId) => [normalizeInstitutionId(supplierId), supplierId]),
  );
  if (requestedByNormalizedId.size !== requested.length) return undefined;
  const outcomes = new Map<string, "sent" | "unbound" | "conflict">();
  const recordOutcome = (supplierId: string | undefined, outcome: "sent" | "unbound") => {
    const requestedSupplierId = supplierId
      ? requestedByNormalizedId.get(normalizeInstitutionId(supplierId))
      : undefined;
    if (!requestedSupplierId) return;
    const existing = outcomes.get(requestedSupplierId);
    outcomes.set(requestedSupplierId, existing && existing !== outcome ? "conflict" : outcome);
  };

  for (const record of objectRecords(data)) {
    for (const key of DISTRIBUTION_UNBOUND_LIST_KEYS) {
      if (!Array.isArray(record[key])) continue;
      for (const item of record[key]) recordOutcome(distributionSupplierId(item), "unbound");
    }

    const supplierId = distributionSupplierId(record);
    if (!supplierId || !requestedByNormalizedId.has(normalizeInstitutionId(supplierId))) continue;
    const status = recordText(record, ["notification_status", "send_status", "outcome", "status"])?.toLowerCase();
    const bindingFlag = ["group_chat_bound", "wechat_group_bound", "wecom_group_bound", "is_group_bound"]
      .map((key) => record[key])
      .find((value) => typeof value === "boolean");
    const error = recordText(record, ["notification_error", "send_error", "reason", "message"]);
    if (status && DISTRIBUTION_SENT_STATUSES.has(status)) {
      recordOutcome(supplierId, "sent");
    } else if (
      bindingFlag === false ||
      (status && DISTRIBUTION_UNBOUND_STATUSES.has(status)) ||
      (["failed", "skipped"].includes(status ?? "") && Boolean(error && GROUP_BINDING_ERROR.test(error)))
    ) {
      recordOutcome(supplierId, "unbound");
    }
  }

  if (outcomes.size !== requested.length || [...outcomes.values()].includes("conflict")) return undefined;
  const sentCount = [...outcomes.values()].filter((outcome) => outcome === "sent").length;
  const projectId = resultText(data, ["project_id", "provider_project_id"]);
  const inquiryId = resultText(data, ["inquiry_id"]);
  if (sentCount > 0 && !projectId) return undefined;
  return {
    projectId,
    inquiryId,
    requestedCount: requested.length,
    sentCount,
    unboundCount: requested.length - sentCount,
    outcomes: requested.map((supplierId) => ({
      supplierId,
      status: outcomes.get(supplierId) as "sent" | "unbound",
    })),
  };
}

function distributionFallbackStatuses(workflow: Json): Json[] {
  return Array.isArray(workflow.distribution_supplier_statuses)
    ? workflow.distribution_supplier_statuses.filter((item: unknown): item is Json =>
      Boolean(item && typeof item === "object" && !Array.isArray(item) && text((item as Json).supplier_id_sha256))
    )
    : [];
}

function individualFallbackPending(workflow: Json, input: Json): boolean {
  if (
    workflow.distribution_outcome_status !== "fallback_in_progress" ||
    !Array.isArray(input.supplierIds) || input.supplierIds.length !== 1 || !text(input.supplierIds[0])
  ) return false;
  const supplierHash = sha256Text(input.supplierIds[0].trim());
  return distributionFallbackStatuses(workflow).some((item) =>
    item.supplier_id_sha256 === supplierHash && item.status === "pending"
  );
}

function completedIndividualFallbackStatus(workflow: Json, input: Json): string | undefined {
  if (
    !["fallback_in_progress", "all_sent_individually", "partial_individual"].includes(
      workflow.distribution_outcome_status,
    ) || !Array.isArray(input.supplierIds) || input.supplierIds.length !== 1 || !text(input.supplierIds[0])
  ) return undefined;
  const supplierHash = sha256Text(input.supplierIds[0].trim());
  const status = distributionFallbackStatuses(workflow).find((item) =>
    item.supplier_id_sha256 === supplierHash
  )?.status;
  return text(status) && status !== "pending" ? status : undefined;
}

function recordText(record: Json, keys: string[]): string | undefined {
  const value = keys.map((key) => record[key]).find(text);
  return text(value) ? value.normalize("NFKC").trim().replace(/\s+/g, " ") : undefined;
}

function collectMcnRecipientDirectory(root: unknown): Json[] {
  const recipients = new Map<string, string | null>();
  const queue: Array<{ value: unknown; contextKey: string }> = [{ value: unwrap(root), contextKey: "" }];
  const seen = new Set<unknown>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const { value, contextKey } = current;
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      queue.push(...value.map((item) => ({ value: item, contextKey })));
      continue;
    }

    const record = value as Json;
    const explicitId = recordText(record, MCN_ID_KEYS);
    const contextual = MCN_CONTEXT_KEY.test(contextKey);
    const supplierId = explicitId ?? (contextual ? recordText(record, ["id"]) : undefined);
    const explicitName = recordText(record, MCN_NAME_KEYS);
    const name = explicitName ?? (explicitId || contextual ? recordText(record, ["name"]) : undefined);
    if (supplierId && name) {
      const supplierIdSha256 = sha256Text(supplierId);
      if (!recipients.has(supplierIdSha256)) recipients.set(supplierIdSha256, name);
      else if (recipients.get(supplierIdSha256) !== name) recipients.set(supplierIdSha256, null);
    }

    queue.push(...Object.entries(record).map(([key, item]) => ({ value: item, contextKey: key })));
  }

  return [...recipients.entries()]
    .filter((entry): entry is [string, string] => text(entry[1]))
    .map(([supplier_id_sha256, name]) => ({ supplier_id_sha256, name }));
}

function clearMcnRecipientDirectory(workflow: Json): void {
  delete workflow.mcn_recipient_directory;
  delete workflow.mcn_directory_requirement_id_sha256;
  delete workflow.selected_supplier_id_hashes;
}

function appendWorkflowEvent(data: Json, event: Json): void {
  const unitId = text(data.active_execution_unit_id) ? data.active_execution_unit_id.trim() : undefined;
  const taggedEvent = unitId ? { execution_unit_id: unitId, ...event } : event;
  const events = Array.isArray(data.workflow_events) ? data.workflow_events : [];
  events.push(taggedEvent);
  data.workflow_events = events.slice(-WORKFLOW_EVENT_LIMIT);
  const unit = unitId && data.execution_units?.[unitId];
  if (unit && typeof unit === "object" && !Array.isArray(unit)) {
    const unitEvents = Array.isArray(unit.events) ? unit.events : [];
    unitEvents.push(taggedEvent);
    unit.events = unitEvents.slice(-WORKFLOW_EVENT_LIMIT);
    unit.updated_at_ms = event.at_ms ?? Date.now();
  }
}

function initialExecutionWorkflow(): Json {
  return {
    phase: "requirement_draft",
    next_action: "validate_requirement",
    waiting_for: null,
    transition_seq: 0,
    updated_at_ms: null,
  };
}

function executionUnitDraftId(input: Json): string {
  return `draft:${fingerprint(input.payload ?? {})}`;
}

function inputRequirementId(tool: string, input: Json): string | undefined {
  if (tool === "validate_requirement") return undefined;
  return [input.requirement_id, input.id].find(text)?.trim();
}

function stashUnitScopedRootState(data: Json, unit: Json): void {
  unit.local_state ??= {};
  for (const key of UNIT_SCOPED_ROOT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(data, key)) unit.local_state[key] = data[key];
    else delete unit.local_state[key];
    delete data[key];
  }
}

function restoreUnitScopedRootState(data: Json, unit: Json): void {
  for (const key of UNIT_SCOPED_ROOT_KEYS) delete data[key];
  for (const key of UNIT_SCOPED_ROOT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(unit.local_state ?? {}, key)) data[key] = unit.local_state[key];
  }
}

export function activateExecutionUnitForTool(
  current: GuardStore,
  tool: string,
  input: Json,
  result?: unknown,
): void {
  const data = current.data;
  data.execution_units ??= {};
  data.requirement_execution_unit_ids ??= {};
  const requirementId = inputRequirementId(tool, input) ??
    (tool === "validate_requirement" ? validationRequirementId(result) : undefined);
  const requirementHash = requirementId ? sha256Text(requirementId) : undefined;
  const draftId = tool === "validate_requirement" ? executionUnitDraftId(input) : undefined;
  let targetId = requirementHash ? data.requirement_execution_unit_ids[requirementHash] : undefined;
  if (requirementHash && !targetId) {
    targetId = Object.values<Json>(data.execution_units).find((unit) =>
      unit.requirement_id_sha256 === requirementHash
    )?.id;
    if (!targetId && text(data.workflow?.requirement_id) &&
      sha256Text(data.workflow.requirement_id.trim()) === requirementHash) {
      targetId = data.active_execution_unit_id;
    }
    // An unrecognized downstream ID is validated against the active unit. It must
    // not create or switch local state before its lineage has been established by
    // a successful validate_requirement result.
    if (!targetId && tool !== "validate_requirement") return;
  }
  targetId ??= draftId;
  targetId ??= data.active_execution_unit_id;
  if (!text(targetId)) return;

  const now = Date.now();
  let target = data.execution_units[targetId];
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    target = {
      id: targetId,
      status: "active",
      platform: text(input.payload?.platform) ? input.payload.platform.trim() :
        text(input.platform) ? input.platform.trim() : undefined,
      requirement_payload_sha256: draftId ? draftId.slice("draft:".length) : undefined,
      requirement_id_sha256: requirementHash,
      workflow: initialExecutionWorkflow(),
      events: [],
      local_state: {},
      created_at_ms: now,
      updated_at_ms: now,
    };
    data.execution_units[targetId] = target;
  }
  if (requirementHash) {
    data.requirement_execution_unit_ids[requirementHash] = targetId;
    target.requirement_id_sha256 = requirementHash;
  }

  const previousId = text(data.active_execution_unit_id) ? data.active_execution_unit_id.trim() : undefined;
  if (previousId && previousId !== targetId) {
    const previous = data.execution_units[previousId];
    if (previous && typeof previous === "object" && !Array.isArray(previous)) {
      previous.workflow = data.workflow;
      stashUnitScopedRootState(data, previous);
      if (previous.status !== "completed") {
        previous.status = "suspended";
        previous.suspended_at_ms = now;
        previous.suspend_reason = "switched_execution_unit";
      }
      appendWorkflowEvent(data, {
        kind: "execution_unit_suspended",
        status: previous.status,
        next_execution_unit_id: targetId,
        phase: previous.workflow?.phase,
        next_action: previous.workflow?.next_action,
        at_ms: now,
      });
    }
  }

  data.active_execution_unit_id = targetId;
  data.workflow = target.workflow;
  if (previousId !== targetId) restoreUnitScopedRootState(data, target);
  if (tool === "validate_requirement" && ["manual", "search"].includes(data.pending_post_validation_intent)) {
    target.workflow.post_validation_intent = data.pending_post_validation_intent;
    target.workflow.post_validation_actions = [
      data.pending_post_validation_intent === "manual" ? "manual_source_creators" : "search_creators",
    ];
    delete data.pending_post_validation_intent;
  }
  if (target.status === "suspended") {
    target.status = "active";
    target.resumed_at_ms = now;
    delete target.suspended_at_ms;
    delete target.suspend_reason;
    appendWorkflowEvent(data, {
      kind: "execution_unit_resumed",
      status: "active",
      previous_execution_unit_id: previousId,
      phase: target.workflow?.phase,
      next_action: target.workflow?.next_action,
      at_ms: now,
    });
  } else if (target.status !== "completed") {
    target.status = "active";
  }
  target.updated_at_ms = now;
  save(current.path, data);
}

function finalizeActiveExecutionUnit(data: Json, now: number): void {
  const unitId = text(data.active_execution_unit_id) ? data.active_execution_unit_id.trim() : undefined;
  const unit = unitId && data.execution_units?.[unitId];
  if (!unit || typeof unit !== "object" || Array.isArray(unit)) return;
  const wasCompleted = unit.status === "completed";
  unit.workflow = data.workflow;
  stashUnitScopedRootState(data, unit);
  restoreUnitScopedRootState(data, unit);
  unit.status = data.workflow?.next_action == null ? "completed" : "active";
  if (unit.status === "completed" && !unit.completed_at_ms) unit.completed_at_ms = now;
  unit.updated_at_ms = now;
  if (unit.status === "completed" && !wasCompleted) {
    appendWorkflowEvent(data, {
      kind: "execution_unit_completed",
      status: "completed",
      phase: data.workflow?.phase,
      next_action: null,
      at_ms: now,
    });
  }
}

function authorizeInquirySync(event: Json, input: Json, current: GuardStore): Json | undefined {
  if (syncInputBoundToSendEvidence(input, current.data.workflow as Json)) {
    const workflow = current.data.workflow as Json;
    workflow.sync_call_order_status = "authorized_after_wecom_send";
    workflow.sync_after_wecom_send = true;
    workflow.sync_order_checked_at_ms = Date.now();
    save(current.path, current.data);
    return undefined;
  }
  const workflow = current.data.workflow as Json;
  workflow.sync_call_order_status = "blocked_missing_matching_wecom_send";
  workflow.sync_after_wecom_send = false;
  workflow.sync_order_checked_at_ms = Date.now();
  save(current.path, current.data);
  return denyPreflight(
    event, "sync_mcn_inquiry_status", input, "workflow_lineage", "INVALID_PHASE",
    "sync_mcn_inquiry_status requires a prior successful create_with_distributions response with explicit per-supplier sent details matching this exact requirement, project, and supplier set. Sync output is never WeCom send evidence.",
  );
}

function clearDistributionSendEvidence(workflow: Json): void {
  for (const key of [
    "project_id", "requested_supplier_count", "sent_supplier_count", "unbound_supplier_count",
    "failed_supplier_count", "unknown_supplier_count", "distribution_supplier_statuses",
    "distribution_outcome_status", "distribution_outcome_error", "distribution_send_evidence_status",
    "distribution_send_evidence_tool", "distribution_sent_detail_count", "sync_inquiry_ids",
    "inquiry_sync_evidence_status", "inquiry_sync_evidence_error",
    "distribution_source_brief_sha256",
    "wecom_confirmation_id", "wecom_confirmation_status", "wecom_confirmation_mode",
    "wecom_confirmation_request_sha256", "wecom_confirmation_user_prompted",
    "wecom_confirmation_user_approved", "wecom_confirmation_updated_at_ms",
  ]) delete workflow[key];
}

function syncInputBoundToSendEvidence(input: Json, workflow: Json): boolean {
  if (
    workflow.distribution_send_evidence_status !== "valid" ||
    workflow.distribution_send_evidence_tool !== "create_with_distributions" ||
    !Number.isInteger(workflow.sent_supplier_count) || workflow.sent_supplier_count < 1 ||
    !text(workflow.requirement_id) || !text(input.requirement_id) ||
    input.requirement_id.trim() !== workflow.requirement_id.trim() ||
    !text(input.project_id) || !Array.isArray(input.supplierIds) || input.supplierIds.length < 1 ||
    !input.supplierIds.every(text)
  ) return false;
  const supplierIds = input.supplierIds.map((supplierId: string) => supplierId.trim());
  if (new Set(supplierIds).size !== supplierIds.length) return false;
  const projectId = input.project_id.trim();
  const eligibleHashes = distributionFallbackStatuses(workflow)
    .filter((item) => item.status === "sent" && (
      text(item.project_id) ? item.project_id.trim() === projectId : workflow.project_id === projectId
    ))
    .map((item) => item.supplier_id_sha256.trim())
    .sort();
  const requestedHashes = supplierIds.map((supplierId) => sha256Text(supplierId)).sort();
  return eligibleHashes.length > 0 && eligibleHashes.length === requestedHashes.length &&
    eligibleHashes.every((hash, index) => hash === requestedHashes[index]);
}

function postRaceQuestionMatchesEvidence(input: Json, workflow: Json): boolean {
  const question = firstQuestion(input);
  const body = text(question?.question) ? question.question.replace(/\s+/gu, "") : "";
  const demandCount = workflow.demand_count;
  const selectedMcnCount = workflow.post_race_selected_mcn_count;
  const coverageCount = workflow.post_race_selected_mcn_covered_creator_count;
  const multiplier = workflow.post_race_selected_mcn_coverage_multiplier;
  const manualCount = workflow.post_race_manual_sourcing_gap_count;
  const ratio = workflow.post_race_institution_manual_creator_ratio;
  if (
    !body || !Number.isInteger(demandCount) || !Number.isInteger(selectedMcnCount) ||
    !Number.isInteger(coverageCount) || typeof multiplier !== "number" ||
    !Number.isInteger(manualCount) || !text(ratio)
  ) return false;
  return [
    `需求达人数量：${demandCount}`,
    `已选机构数量：${selectedMcnCount}`,
    `预估机构达人覆盖量：${coverageCount}`,
    `供需倍数：${multiplier}`,
    `建议手动拓展达人数量：${manualCount}`,
    `机构承接达人与手动拓展达人比例：${ratio}`,
  ].every((metric) => body.includes(metric));
}

function updateWorkflowForDecision(event: Json, input: Json, rootDir: string): void {
  if (event.error) return;
  const header = firstQuestionHeader(input);
  if (![
    POST_RACE_MANUAL_CONFIRMATION_HEADER,
    MCN_CONFIRMATION_HEADER,
    FIELD_CONFIRMATION_HEADER,
    MCN_RETURN_CONFIRMATION_HEADER,
  ].includes(header ?? "")) return;
  const current = store(rootDir);
  const workflow = current.data.workflow as Json;
  const answer = answerForQuestion(event, input);
  if (!answer) {
    const now = Date.now();
    workflow.user_pause_status = "ask_cancelled_closed_timed_out_or_failed";
    workflow.user_pause_at_ms = now;
    workflow.updated_at_ms = now;
    appendWorkflowEvent(current.data, {
      kind: "user_gate_stopped",
      header,
      status: "waiting_for_new_user_message",
      phase: workflow.phase,
      next_action: workflow.next_action,
      at_ms: now,
    });
    save(current.path, current.data);
    return;
  }
  delete workflow.user_pause_status;
  delete workflow.user_pause_at_ms;
  workflow.last_user_command = answer;
  workflow.updated_at_ms = Date.now();

  if (header === POST_RACE_MANUAL_CONFIRMATION_HEADER) {
    if (!postRaceQuestionMatchesEvidence(input, workflow)) {
      workflow.next_action = "confirm_post_race_manual_sourcing";
      workflow.waiting_for = "user";
      workflow.post_race_confirmation_error = "missing_required_summary_metrics";
      save(current.path, current.data);
      return;
    }
    delete workflow.post_race_confirmation_error;
    const gap = workflow.post_race_manual_sourcing_gap_count;
    if (
      answer === START_POST_RACE_MANUAL_LABEL && workflow.post_race_evidence_status === "valid" &&
      workflow.post_race_risk_level === "high_risk" && Number.isInteger(gap) && gap > 0
    ) {
      workflow.pending_manual_target_count = gap;
      workflow.manual_sourcing_after_mcn_flow = true;
      workflow.next_action = "confirm_mcn_selection";
      workflow.waiting_for = "user";
    } else if (answer === REVISE_MCN_SELECTION_LABEL) {
      delete workflow.pending_manual_target_count;
      workflow.next_action = "revise_mcn_selection";
      workflow.waiting_for = "user";
    } else if (
      [SKIP_POST_RACE_MANUAL_LABEL, CONFIRM_NO_MANUAL_LABEL].includes(answer) &&
      workflow.post_race_evidence_status === "valid"
    ) {
      delete workflow.pending_manual_target_count;
      workflow.next_action = "confirm_mcn_selection";
      workflow.waiting_for = "user";
    } else {
      delete workflow.pending_manual_target_count;
      workflow.next_action = "confirm_post_race_manual_sourcing";
      workflow.waiting_for = "user";
    }
  } else if (header === MCN_CONFIRMATION_HEADER) {
    const approved = ["确认MCN方案", "确认继续"].includes(answer);
    workflow.next_action = approved ? "select_inquiry_form_fields" : "confirm_mcn_selection";
    workflow.waiting_for = approved ? null : "user";
  } else if (header === FIELD_CONFIRMATION_HEADER) {
    const approved = ["确认字段", "确认继续"].includes(answer);
    workflow.next_action = approved ? "create_with_distributions" : "confirm_inquiry_fields";
    workflow.waiting_for = approved ? null : "user";
  } else {
    const approved = answer === CONFIRM_MCN_RETURN_LABEL &&
      workflow.manual_sourcing_creator_data_received === true &&
      workflow.manual_sourcing_has_prior_wecom_send === true;
    workflow.manual_sourcing_mcn_return_confirmation_status = approved ? "confirmed" : "waiting";
    workflow.manual_sourcing_mcn_return_confirmed_at_ms = approved ? Date.now() : undefined;
    workflow.phase = approved ? "candidate_pool_enriched" : "waiting_mcn_return";
    workflow.next_action = approved ? "rank_creators" : "confirm_mcn_return_completed";
    workflow.waiting_for = approved ? null : "user";
  }

  workflow.transition_seq = Number(workflow.transition_seq ?? 0) + 1;
  appendWorkflowEvent(current.data, {
    seq: workflow.transition_seq,
    kind: "user_command",
    header,
    answer,
    next_action: workflow.next_action,
    at_ms: workflow.updated_at_ms,
  });
  save(current.path, current.data);
}

function updateLocalWorkflow(
  event: Json,
  tool: string,
  input: Json,
  rootDir: string,
  preflightDenial?: PreflightDenialReason,
  externalSendConfirmed = false,
  currentOverride?: GuardStore,
): void {
  const stateChangingTools = new Set([
    "validate_requirement", "search_creators", "rank_mcns", "select_inquiry_form_fields",
    "create_with_distributions", "sync_mcn_inquiry_status", "ingest_mcn_submissions",
    "manual_source_creators", "rank_creators", "audit_manual_adjustment",
    "create_submission_batch", "record_client_feedback",
  ]);
  if (!stateChangingTools.has(tool)) return;

  const current = currentOverride ?? store(rootDir);
  activateExecutionUnitForTool(current, tool, input, event.result);
  const workflow = current.data.workflow as Json;
  if (preflightDenial) {
    const now = Date.now();
    workflow.last_tool = tool;
    workflow.last_tool_status = "blocked";
    workflow.preflight_error = preflightDenial;
    workflow.transition_seq = Number(workflow.transition_seq ?? 0) + 1;
    workflow.updated_at_ms = now;
    if (tool === "sync_mcn_inquiry_status") {
      workflow.sync_call_order_status = "blocked_missing_matching_wecom_send";
      workflow.sync_after_wecom_send = false;
      workflow.sync_order_checked_at_ms = now;
    }
    if (preflightDenial === "missing_session_context") {
      workflow.phase = "blocked";
      workflow.next_action = "await_host_upgrade";
      workflow.waiting_for = "integration";
    } else if (preflightDenial === "primary_key_format") {
      workflow.next_action = `correct_${tool}_primary_key_from_validate_data_id`;
      workflow.waiting_for = "assistant";
    } else if (preflightDenial === "brief_mismatch") {
      workflow.next_action = "restore_exact_original_brief";
      workflow.waiting_for = "assistant";
    } else if (preflightDenial === "invalid_input") {
      workflow.next_action = `correct_${tool}_input`;
      workflow.waiting_for = "assistant";
    } else if (preflightDenial === "workflow_lineage") {
      workflow.next_action = `recover_${tool}_lineage`;
      workflow.waiting_for = "assistant";
    } else if (preflightDenial === "workflow_order") {
      workflow.next_action = workflow.next_action ?? `recover_${tool}_order`;
      workflow.waiting_for = "assistant";
    } else {
      workflow.next_action = "validate_requirement";
      workflow.waiting_for = "assistant";
    }
    appendWorkflowEvent(current.data, {
      seq: workflow.transition_seq,
      kind: "tool_preflight_denied",
      tool,
      status: "blocked",
      reason: preflightDenial,
      phase: workflow.phase,
      next_action: workflow.next_action,
      at_ms: now,
    });
    finalizeActiveExecutionUnit(current.data, now);
    save(current.path, current.data);
    return;
  }
  const continueToManualAfterValidation = tool === "validate_requirement" &&
    (workflow.post_validation_intent === "manual" || (
    workflow.next_action === "validate_requirement" && (
      workflow.phase === "inquiry_fields_ready" ||
      (Number.isInteger(workflow.pending_manual_target_count) && workflow.pending_manual_target_count > 0)
    )));
  const envelopeOk = successful(event.error ? { isError: true } : event.result);
  const fieldEvidence = tool === "select_inquiry_form_fields" && envelopeOk
    ? fieldSelectionEvidence(event.result)
    : undefined;
  const rankEvidence = tool === "rank_mcns" && envelopeOk
    ? rankMcnCoverageEvidence(event.result, input, workflow)
    : undefined;
  const manualEvidence = tool === "manual_source_creators" && envelopeOk
    ? text(input.size)
      ? directManualSourcingEvidence(event.result, input)
      : manualSourcingEvidence(event.result, input, workflow)
    : undefined;
  const syncInquiryIds = tool === "sync_mcn_inquiry_status" && envelopeOk
    ? syncInquiryIdsEvidence(event.result)
    : undefined;
  const syncBoundToSendEvidence = tool === "sync_mcn_inquiry_status"
    ? syncInputBoundToSendEvidence(input, workflow)
    : true;
  const distributionEvidence = tool === "create_with_distributions" && envelopeOk
    ? distributionOutcomeEvidence(event.result, input)
    : undefined;
  const creatorRankEvidence = tool === "rank_creators" && envelopeOk
    ? rankCreatorsEvidence(event.result)
    : undefined;
  const exportEvidence = tool === "create_submission_batch" && envelopeOk
    ? submissionBatchEvidence(event.result)
    : undefined;
  const distributionUnboundRejection = tool === "create_with_distributions" && !envelopeOk
    ? distributionUnboundRejectionEvidence(event, input, workflow)
    : undefined;
  const distributionBatchFallback = tool === "create_with_distributions" && !envelopeOk &&
    !distributionUnboundRejection
    ? distributionBatchFallbackEvidence(event, input)
    : undefined;
  const isIndividualFallback = tool === "create_with_distributions" &&
    individualFallbackPending(workflow, input);
  const ok = envelopeOk &&
    (tool !== "select_inquiry_form_fields" || fieldEvidence !== undefined) &&
    (tool !== "rank_mcns" || rankEvidence !== undefined) &&
    (tool !== "manual_source_creators" || manualEvidence !== undefined) &&
    (tool !== "sync_mcn_inquiry_status" || syncBoundToSendEvidence) &&
    (tool !== "create_with_distributions" || (
      externalSendConfirmed && distributionEvidence !== undefined
    )) &&
    (tool !== "rank_creators" || creatorRankEvidence !== undefined) &&
    (tool !== "create_submission_batch" || exportEvidence !== undefined);
  const writeTool = tool !== "select_inquiry_form_fields";
  const unknownWriteResult = writeTool && !envelopeOk &&
    (Boolean(event.error) || !definiteFailureEnvelope(event.result));
  const now = Date.now();
  workflow.last_tool = tool;
  workflow.last_tool_status = ok ? "success" : unknownWriteResult ? "unknown" : "failed";
  workflow.transition_seq = Number(workflow.transition_seq ?? 0) + 1;
  workflow.updated_at_ms = now;
  if (tool === "search_creators" || tool === "rank_mcns") clearMcnRecipientDirectory(workflow);
  if (tool === "search_creators" || tool === "rank_mcns") {
    clearDistributionSendEvidence(workflow);
    for (const key of [
      "rank_mcn_inquiry_id", "rank_mcn_inquiry_evidence_status", "rank_mcn_inquiry_evidence_error",
      "post_race_evidence_status", "post_race_risk_level", "post_race_selected_mcn_count",
      "post_race_selected_mcn_covered_creator_count", "post_race_selected_mcn_coverage_multiplier",
      "post_race_manual_sourcing_gap_count", "post_race_institution_manual_creator_ratio",
      "pending_manual_target_count",
    ]) delete workflow[key];
    delete workflow.field_selection_attempted;
  }

  if (tool === "select_inquiry_form_fields" && ok) {
    // The Tool waits for the selector callback and returns the submitted fields.
    // Persist normalized callback evidence so later calls and resumed sessions can verify lineage.
    workflow.phase = "inquiry_fields_ready";
    workflow.next_action = "validate_requirement";
    workflow.waiting_for = null;
    if (text(input.platform)) workflow.platform = input.platform.trim();
    workflow.field_selection_evidence_status = "valid";
    workflow.field_selection_attempted = true;
    workflow.field_selection_columns = fieldEvidence;
    workflow.field_selection_columns_sha256 = sha256Text(canonical(fieldEvidence));
    delete workflow.field_selection_evidence_error;
  } else if (tool === "create_with_distributions" && distributionUnboundRejection) {
    const unboundHashes = new Set(
      distributionUnboundRejection.unboundSupplierIds.map((supplierId) => sha256Text(supplierId)),
    );
    workflow.phase = "inquiry_sending";
    workflow.requested_supplier_count = input.supplierIds.length;
    workflow.sent_supplier_count = 0;
    workflow.unbound_supplier_count = distributionUnboundRejection.unboundCount;
    workflow.failed_supplier_count = 0;
    workflow.unknown_supplier_count = 0;
    workflow.distribution_supplier_statuses = input.supplierIds.map((supplierId: string) => {
      const supplierHash = sha256Text(supplierId.trim());
      return {
        supplier_id_sha256: supplierHash,
        status: unboundHashes.has(supplierHash) ? "unbound" : "pending",
      };
    });
    delete workflow.project_id;
    delete workflow.distribution_outcome_error;
    workflow.distribution_outcome_status = distributionUnboundRejection.remainingSupplierIds.length > 0
      ? "fallback_in_progress"
      : "none_sent";
    workflow.distribution_send_evidence_status = "none_sent";
    workflow.distribution_send_evidence_tool = "create_with_distributions";
    workflow.distribution_sent_detail_count = 0;
    workflow.next_action = distributionUnboundRejection.remainingSupplierIds.length > 0
      ? "fallback_send_next_individual_mcn"
      : workflow.manual_sourcing_after_mcn_flow === true
        ? "validate_requirement"
        : "report_distribution_result";
    if (distributionUnboundRejection.remainingSupplierIds.length === 0) {
      workflow.mcn_flow_completed = true;
      if (workflow.manual_sourcing_after_mcn_flow === true) workflow.post_validation_intent = "manual";
    }
    workflow.waiting_for = null;
  } else if (tool === "create_with_distributions" && distributionBatchFallback) {
    workflow.phase = "inquiry_sending";
    workflow.requested_supplier_count = distributionBatchFallback.supplierIds.length;
    workflow.sent_supplier_count = 0;
    workflow.unbound_supplier_count = 0;
    workflow.failed_supplier_count = 0;
    workflow.unknown_supplier_count = 0;
    workflow.distribution_supplier_statuses = distributionBatchFallback.supplierIds.map((supplierId) => ({
      supplier_id_sha256: sha256Text(supplierId),
      status: "pending",
    }));
    workflow.distribution_outcome_status = "fallback_in_progress";
    workflow.distribution_send_evidence_status = "none_sent";
    workflow.distribution_send_evidence_tool = "create_with_distributions";
    workflow.distribution_sent_detail_count = 0;
    workflow.next_action = "fallback_send_next_individual_mcn";
    workflow.waiting_for = null;
    delete workflow.project_id;
    delete workflow.distribution_outcome_error;
  } else if (tool === "create_with_distributions" && isIndividualFallback) {
    const supplierHash = sha256Text(input.supplierIds[0].trim());
    const statuses = distributionFallbackStatuses(workflow);
    const item = statuses.find((candidate) => candidate.supplier_id_sha256 === supplierHash)!;
    if (distributionEvidence?.sentCount === 1) {
      item.status = "sent";
      if (distributionEvidence.projectId) item.project_id = distributionEvidence.projectId;
      recordWecomSendInquiryId(current.data, distributionEvidence.inquiryId);
    } else if (distributionEvidence?.unboundCount === 1) {
      item.status = "unbound";
    } else if (!event.error && definiteFailureEnvelope(event.result) && !hasDistributionWriteEvidence(event.result)) {
      item.status = "failed";
    } else {
      item.status = "unknown";
    }
    item.updated_at_ms = now;
    workflow.distribution_supplier_statuses = statuses;
    const count = (status: string) => statuses.filter((candidate) => candidate.status === status).length;
    const pendingCount = count("pending");
    workflow.sent_supplier_count = count("sent");
    workflow.unbound_supplier_count = count("unbound");
    workflow.failed_supplier_count = count("failed");
    workflow.unknown_supplier_count = count("unknown");
    workflow.distribution_send_evidence_status = workflow.sent_supplier_count > 0 ? "valid" : "none_sent";
    workflow.distribution_send_evidence_tool = "create_with_distributions";
    workflow.distribution_sent_detail_count = workflow.sent_supplier_count;
    if (workflow.sent_supplier_count > 0 && text(current.data.source_brief_sha256)) {
      workflow.distribution_source_brief_sha256 = current.data.source_brief_sha256.trim();
    }
    delete workflow.distribution_outcome_error;
    if (pendingCount > 0) {
      workflow.phase = "inquiry_sending";
      workflow.distribution_outcome_status = "fallback_in_progress";
      workflow.next_action = "fallback_send_next_individual_mcn";
      workflow.waiting_for = null;
    } else if (workflow.sent_supplier_count > 0) {
      workflow.phase = "waiting_mcn_return";
      workflow.distribution_outcome_status = workflow.sent_supplier_count === statuses.length
        ? "all_sent_individually"
        : "partial_individual";
      workflow.next_action = "sync_sent_mcn_inquiry_status_individually";
      workflow.waiting_for = "provider";
    } else {
      workflow.phase = "inquiry_fields_ready";
      workflow.distribution_outcome_status = "none_sent";
      workflow.mcn_flow_completed = true;
      workflow.next_action = workflow.manual_sourcing_after_mcn_flow === true
        ? "validate_requirement"
        : "report_distribution_result";
      if (workflow.manual_sourcing_after_mcn_flow === true) workflow.post_validation_intent = "manual";
      workflow.waiting_for = null;
    }
  } else if (!ok) {
    if (tool === "select_inquiry_form_fields") {
      workflow.field_selection_attempted = true;
      workflow.field_selection_evidence_status = envelopeOk ? "invalid" : "unavailable";
      workflow.field_selection_evidence_error = envelopeOk
        ? "missing_or_conflicting_callback_columns"
        : "provider_call_failed";
      delete workflow.field_selection_columns;
      delete workflow.field_selection_columns_sha256;
    }
    if (tool === "rank_mcns") {
      workflow.rank_mcn_inquiry_evidence_status = envelopeOk ? "invalid" : "unavailable";
      workflow.rank_mcn_inquiry_evidence_error = envelopeOk
        ? "missing_or_conflicting_selected_coverage_evidence"
        : "provider_call_failed_or_unknown";
      workflow.post_race_evidence_status = envelopeOk ? "invalid" : "unavailable";
    }
    if (tool === "manual_source_creators") {
      workflow.manual_sourcing_evidence_status = envelopeOk ? "invalid" : "unavailable";
      workflow.manual_sourcing_evidence_error = envelopeOk
        ? text(input.size)
          ? "missing_or_conflicting_creator_rows"
          : "missing_or_conflicting_task_evidence"
        : "provider_call_failed_or_unknown";
    }
    if (tool === "rank_creators") {
      workflow.rank_creators_evidence_status = envelopeOk ? "invalid" : "unavailable";
      workflow.rank_creators_evidence_error = envelopeOk
        ? "missing_persisted_ranking_evidence"
        : unknownWriteResult ? "write_result_unknown" : "provider_call_failed";
    }
    if (tool === "create_submission_batch") {
      workflow.submission_batch_evidence_status = envelopeOk ? "invalid" : "unavailable";
      workflow.submission_batch_evidence_error = envelopeOk
        ? "missing_export_evidence"
        : unknownWriteResult ? "write_result_unknown" : "provider_call_failed";
    }
    if (tool === "create_with_distributions") {
      workflow.distribution_outcome_status = envelopeOk ? "incomplete" : "unavailable";
      workflow.distribution_outcome_error = envelopeOk
        ? "missing_or_conflicting_per_supplier_send_evidence"
        : "provider_call_failed_or_unknown";
      for (const key of [
        "project_id", "requested_supplier_count", "sent_supplier_count", "unbound_supplier_count",
        "distribution_retry_active", "distribution_initial_requested_supplier_count",
        "distribution_excluded_unbound_supplier_count", "distribution_retry_supplier_count",
        "distribution_supplier_statuses", "failed_supplier_count", "unknown_supplier_count",
        "distribution_send_evidence_tool", "distribution_sent_detail_count",
      ]) delete workflow[key];
      workflow.distribution_send_evidence_status = "invalid";
      if (!externalSendConfirmed) {
        workflow.distribution_outcome_error = "missing_matching_user_confirmation_receipt";
        workflow.wecom_confirmation_status = "missing";
        workflow.wecom_confirmation_user_prompted = false;
        workflow.wecom_confirmation_user_approved = false;
      }
    }
    if (tool === "sync_mcn_inquiry_status") {
      workflow.inquiry_sync_evidence_status = envelopeOk ? "invalid" : "unavailable";
      workflow.inquiry_sync_evidence_error = envelopeOk
        ? "missing_matching_create_with_distributions_send_details"
        : "provider_call_failed_or_unknown";
      delete workflow.sync_inquiry_ids;
    }
    workflow.next_action = unknownWriteResult ? `reconcile_${tool}` : `recover_${tool}`;
    workflow.waiting_for = unknownWriteResult ? "provider" : "user";
  } else {
    const root = event.result;
    switch (tool) {
      case "validate_requirement": {
        workflow.phase = "requirement_ready";
        const nextAction = continueToManualAfterValidation
          ? "manual_source_creators"
          : "search_creators";
        workflow.next_action = nextAction;
        workflow.post_validation_actions = [nextAction];
        delete workflow.post_validation_intent;
        workflow.waiting_for = null;
        const requirementId = validationRequirementId(root);
        if (requirementId) workflow.requirement_id = requirementId;
        if (text(input.payload?.platform)) workflow.platform = input.payload.platform.trim();
        if (Number.isInteger(input.payload?.quantityTotal)) workflow.quantity_total = input.payload.quantityTotal;
        break;
      }
      case "search_creators": {
        workflow.phase = "candidate_pool_ready";
        workflow.search_flow_started = true;
        workflow.mcn_flow_completed = false;
        workflow.mcn_flow_started_at_ms = now;
        workflow.waiting_for = null;
        for (const key of [
          "supply_plan_status", "supply_plan_error", "matched_creator_count", "supply_ratio",
          "hard_shortfall_count", "buffer_shortfall_count", "supply_risk_level",
          "suggested_expansion_count", "mcn_covered_creator_count", "mcn_manual_creator_ratio",
          "recommended_action",
        ]) delete workflow[key];
        const supply = searchSupplyEvidence(root, workflow);
        if (!supply) {
          for (const key of [
            "demand_count", "pre_race_rate_card_creator_count",
            "pre_race_rate_card_multiplier", "pre_race_risk_level",
            "pre_race_supply_contract", "pre_race_recommended_action",
          ]) delete workflow[key];
          workflow.pre_race_supply_status = "invalid";
          workflow.pre_race_supply_error = "missing_or_contradictory_rate_card_evidence";
          workflow.next_action = "recover_search_supply_plan";
          break;
        }
        workflow.pre_race_supply_status = "valid";
        delete workflow.pre_race_supply_error;
        workflow.demand_count = supply.demandCount;
        workflow.pre_race_rate_card_creator_count = supply.rateCardCreatorCount;
        workflow.pre_race_rate_card_multiplier = supply.rateCardMultiplier;
        workflow.pre_race_risk_level = supply.riskLevel;
        workflow.pre_race_supply_contract = supply.contract;
        if (supply.recommendedAction) workflow.pre_race_recommended_action = supply.recommendedAction;
        else delete workflow.pre_race_recommended_action;
        workflow.next_action = "rank_mcns";
        break;
      }
      case "rank_mcns": {
        if (!rankEvidence) break;
        workflow.phase = "mcn_planning";
        workflow.rank_mcn_inquiry_id = rankEvidence.inquiryId;
        workflow.rank_mcn_inquiry_evidence_status = "valid";
        delete workflow.rank_mcn_inquiry_evidence_error;
        workflow.post_race_evidence_status = "valid";
        workflow.post_race_selected_mcn_count = rankEvidence.selectedMcnCount;
        workflow.post_race_selected_mcn_covered_creator_count = rankEvidence.coveredCreatorCount;
        workflow.post_race_selected_mcn_coverage_multiplier = rankEvidence.coverageMultiplier;
        workflow.post_race_risk_level = rankEvidence.riskLevel;
        workflow.post_race_manual_sourcing_gap_count = rankEvidence.manualSourcingGapCount;
        workflow.post_race_institution_manual_creator_ratio =
          rankEvidence.institutionManualCreatorRatio;
        delete workflow.pending_manual_target_count;
        workflow.selected_supplier_id_hashes = rankEvidence.selectedSupplierIds
          .map((supplierId) => sha256Text(supplierId))
          .sort();
        workflow.next_action = "confirm_post_race_manual_sourcing";
        workflow.waiting_for = "user";
        if (Number.isInteger(input.minimum_mcn_count)) workflow.mcn_race_size = input.minimum_mcn_count;
        const selectedHashes = new Set(workflow.selected_supplier_id_hashes);
        const recipients = collectMcnRecipientDirectory(root).filter((recipient) =>
          selectedHashes.has(recipient.supplier_id_sha256)
        );
        if (recipients.length > 0 && text(input.id)) {
          workflow.mcn_recipient_directory = recipients;
          workflow.mcn_directory_requirement_id_sha256 = sha256Text(input.id.trim());
        }
        break;
      }
      case "create_with_distributions":
        if (!distributionEvidence) break;
        if (distributionEvidence.sentCount > 0) {
          recordWecomSendInquiryId(current.data, distributionEvidence.inquiryId);
        }
        if (text(input.requirement_id)) workflow.requirement_id = input.requirement_id.trim();
        if (distributionEvidence.projectId) workflow.project_id = distributionEvidence.projectId;
        else delete workflow.project_id;
        delete workflow.supplier_count;
        const excludedUnboundCount = Number.isInteger(workflow.distribution_excluded_unbound_supplier_count)
          ? workflow.distribution_excluded_unbound_supplier_count
          : 0;
        const initialRequestedCount = excludedUnboundCount > 0 &&
          Number.isInteger(workflow.distribution_initial_requested_supplier_count)
          ? workflow.distribution_initial_requested_supplier_count
          : distributionEvidence.requestedCount;
        const totalUnboundCount = excludedUnboundCount + distributionEvidence.unboundCount;
        workflow.requested_supplier_count = initialRequestedCount;
        workflow.sent_supplier_count = distributionEvidence.sentCount;
        workflow.unbound_supplier_count = totalUnboundCount;
        workflow.distribution_supplier_statuses = distributionEvidence.outcomes.map(({ supplierId, status }) => ({
          supplier_id_sha256: sha256Text(supplierId),
          status,
          ...(status === "sent" && distributionEvidence.projectId
            ? { project_id: distributionEvidence.projectId }
            : {}),
        }));
        delete workflow.distribution_retry_active;
        delete workflow.distribution_retry_supplier_count;
        delete workflow.distribution_outcome_error;
        workflow.distribution_send_evidence_status = distributionEvidence.sentCount > 0 ? "valid" : "none_sent";
        workflow.distribution_send_evidence_tool = "create_with_distributions";
        workflow.distribution_sent_detail_count = distributionEvidence.sentCount;
        if (distributionEvidence.sentCount > 0 && text(current.data.source_brief_sha256)) {
          workflow.distribution_source_brief_sha256 = current.data.source_brief_sha256.trim();
        }
        workflow.wecom_send_completed_transition_seq = workflow.transition_seq;
        if (distributionEvidence.sentCount === 0) {
          workflow.mcn_flow_completed = true;
          workflow.phase = "inquiry_fields_ready";
          workflow.next_action = workflow.manual_sourcing_after_mcn_flow === true
            ? "validate_requirement"
            : "report_distribution_result";
          if (workflow.manual_sourcing_after_mcn_flow === true) workflow.post_validation_intent = "manual";
          workflow.waiting_for = null;
          workflow.distribution_outcome_status = "none_sent";
        } else {
          workflow.phase = "waiting_mcn_return";
          workflow.next_action = "sync_mcn_inquiry_status";
          workflow.waiting_for = "provider";
          workflow.distribution_outcome_status = totalUnboundCount > 0 ? "partial" : "all_sent";
        }
        break;
      case "ingest_mcn_submissions":
        workflow.phase = "candidate_pool_enriched";
        workflow.mcn_submissions_ingested = true;
        workflow.next_action = "rank_creators";
        workflow.waiting_for = null;
        break;
      case "rank_creators": {
        workflow.phase = "recommendation_ready";
        workflow.next_action = "await_provider_submission_contract_upgrade";
        workflow.waiting_for = "integration";
        workflow.provider_contract_blocked_tool = "create_submission_batch";
        workflow.rank_creators_evidence_status = "valid";
        workflow.rank_creators_input_sha256 = sha256Text(canonical(input));
        delete workflow.rank_creators_evidence_error;
        const runId = resultText(root, ["run_id"]);
        if (runId) workflow.run_id = runId;
        break;
      }
      case "create_submission_batch":
        workflow.phase = "submission_batch_ready";
        workflow.next_action = null;
        workflow.waiting_for = null;
        workflow.submission_batch_evidence_status = "valid";
        workflow.submission_batch_input_sha256 = sha256Text(canonical(input));
        delete workflow.submission_batch_evidence_error;
        if (text(input.number)) workflow.submission_batch_number = input.number.trim();
        break;
      case "record_client_feedback":
        workflow.phase = "feedback_routing";
        workflow.next_action = null;
        workflow.waiting_for = null;
        break;
      case "sync_mcn_inquiry_status":
        workflow.sync_call_order_status = "completed_after_wecom_send";
        workflow.sync_after_wecom_send = true;
        workflow.sync_completed_at_ms = now;
        workflow.mcn_flow_completed = true;
        workflow.inquiry_sync_evidence_status = syncInquiryIds ? "valid_with_inquiries" : "valid_no_inquiries";
        delete workflow.inquiry_sync_evidence_error;
        if (syncInquiryIds) {
          workflow.sync_inquiry_ids = syncInquiryIds;
        } else {
          delete workflow.sync_inquiry_ids;
        }
        if (workflow.manual_sourcing_creator_data_received === true) {
          workflow.phase = "waiting_mcn_return";
          workflow.next_action = "confirm_mcn_return_completed";
          workflow.waiting_for = "user";
          workflow.manual_sourcing_mcn_return_confirmation_status = "required";
        } else if (workflow.manual_sourcing_after_mcn_flow === true) {
          workflow.next_action = "validate_requirement";
          workflow.waiting_for = null;
          workflow.post_validation_intent = "manual";
        } else {
          workflow.next_action = syncInquiryIds ? "ingest_mcn_submissions" : "await_or_ingest_mcn_submissions";
          workflow.waiting_for = syncInquiryIds ? null : "provider";
        }
        break;
      case "manual_source_creators":
        if (!manualEvidence) break;
        if ("creatorCount" in manualEvidence) {
          const sameBriefAsDistribution = text(workflow.distribution_source_brief_sha256) &&
            text(current.data.source_brief_sha256) &&
            workflow.distribution_source_brief_sha256.trim() === current.data.source_brief_sha256.trim();
          const hasPriorWecomSend = (workflow.manual_sourcing_after_mcn_flow === true || sameBriefAsDistribution) &&
            workflow.distribution_send_evidence_status === "valid" &&
            workflow.distribution_send_evidence_tool === "create_with_distributions" &&
            workflow.sync_after_wecom_send === true;
          workflow.phase = hasPriorWecomSend ? "waiting_mcn_return" : "candidate_pool_enriched";
          workflow.requirement_id = manualEvidence.requirementId;
          workflow.manual_sourcing_size = manualEvidence.size;
          if (manualEvidence.excelFilePath) {
            workflow.manual_sourcing_excel_file_sha256 = sha256Text(manualEvidence.excelFilePath);
          } else {
            delete workflow.manual_sourcing_excel_file_sha256;
          }
          const batchFingerprint = sha256Text(canonical({
            requirement_id: manualEvidence.requirementId,
            size: manualEvidence.size,
            creator_rows_sha256: manualEvidence.creatorRowsSha256,
          }));
          workflow.manual_sourcing_batch_id_sha256 = batchFingerprint;
          workflow.manual_sourcing_creator_rows_sha256 = manualEvidence.creatorRowsSha256;
          workflow.manual_sourcing_creator_count = manualEvidence.creatorCount;
          workflow.manual_sourcing_creator_fields = manualEvidence.creatorFields;
          workflow.manual_sourcing_creator_data_received = true;
          workflow.manual_sourcing_creator_data_status = "received";
          workflow.manual_sourcing_creator_data_received_at_ms = now;
          workflow.manual_sourcing_creator_list_displayed = false;
          workflow.manual_sourcing_creator_list_display_status = "required";
          delete workflow.manual_sourcing_creator_list_displayed_at_ms;
          workflow.manual_sourcing_display_marker = `YPmcnManualCreatorsDisplayed:${batchFingerprint}`;
          workflow.manual_sourcing_has_prior_wecom_send = hasPriorWecomSend;
          delete workflow.manual_sourcing_after_mcn_flow;
          delete workflow.pending_manual_target_count;
          workflow.manual_sourcing_evidence_status = "valid";
          delete workflow.manual_sourcing_evidence_error;
          delete workflow.manual_sourcing_inquiry_ids;
          workflow.next_action = hasPriorWecomSend ? "confirm_mcn_return_completed" : "rank_creators";
          workflow.waiting_for = hasPriorWecomSend ? "user" : null;
          workflow.manual_sourcing_mcn_return_confirmation_status = hasPriorWecomSend ? "required" : "not_required";
          if (hasPriorWecomSend) delete workflow.manual_sourcing_mcn_return_confirmed_at_ms;
        } else {
          workflow.manual_sourcing_task_id = manualEvidence.taskId;
          workflow.manual_sourcing_inquiry_id = manualEvidence.inquiryId;
          workflow.manual_sourcing_status = manualEvidence.status;
          workflow.manual_sourcing_operation = manualEvidence.operation;
          workflow.manual_sourcing_target_count = manualEvidence.targetCount;
          workflow.manual_sourcing_started_at = manualEvidence.startedAt;
          workflow.manual_sourcing_accepted_count = manualEvidence.acceptedCount;
          workflow.manual_sourcing_evidence_status = "valid";
          delete workflow.manual_sourcing_evidence_error;
          delete workflow.pending_manual_target_count;
          workflow.next_action = "confirm_mcn_selection";
          workflow.waiting_for = "user";
        }
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
  finalizeActiveExecutionUnit(current.data, now);
  save(current.path, current.data);
}

export function renderLocalWorkflowContext(rootDir: string): string {
  const data = store(rootDir).data;
  const workflow = data.workflow as Json;
  const executionUnits = Object.values<Json>(data.execution_units ?? {}).map((unit) => ({
    id: unit.id,
    status: unit.status,
    platform: unit.platform ?? unit.workflow?.platform,
    requirement_id_sha256: unit.requirement_id_sha256,
    phase: unit.workflow?.phase,
    next_action: unit.workflow?.next_action,
    waiting_for: unit.workflow?.waiting_for,
    suspended_at_ms: unit.suspended_at_ms,
    completed_at_ms: unit.completed_at_ms,
  }));
  const stopDisposition = workflow.user_pause_status === "ask_cancelled_closed_timed_out_or_failed"
    ? "allowed_wait_for_new_user_message"
    : workflow.next_action == null
      ? "allowed_terminal"
      : workflow.waiting_for === "provider"
        ? "allowed_provider_wait"
        : workflow.waiting_for === "integration"
          ? "allowed_terminal_integration_failure"
          : workflow.waiting_for === "user"
            ? "ask_user_question_required_before_stop"
            : "continue_same_turn_required";
  return [
    "YPmcn authoritative local orchestration state (state/confirmation_guard.json):",
    JSON.stringify({ active_execution_unit_id: data.active_execution_unit_id, stop_disposition: stopDisposition, workflow, execution_units: executionUnits }),
    "Use this local phase/next_action instead of Provider workflow_state/allowed_actions for orchestration. Actual Tool results remain the authority for business facts and identifiers.",
    "Each inherited shared-field plus differing-field combination is an independent execution unit. Switching units suspends the previous unfinished unit locally; resume from the recorded unit next_action instead of Provider state.",
    "Human-in-the-loop rule: waiting_for=user requires an immediate native AskUserQuestion gate (or reflects an explicit user-selected pause), never a prose question. A deterministic next_action with no Ask gate continues in the same assistant turn without asking for 继续.",
    "External-send exception: a confirmed 企微外发 AskUserQuestion callback may arrive in a later assistant turn. When the local receipt is approved and unexpired, call create_with_distributions once with the exact same parameters; do not reopen the popup because the turn changed.",
    "Output rule: use Tool calls only until an allowed stop. Final text is allowed only for a terminal result, provider wait, terminal failure without safe recovery, or a user-cancelled popup; it must not ask, offer, or invite continuation.",
  ].join("\n");
}

function selectedRecipientNames(input: Json, workflow: Json): string[] | undefined {
  if (!Array.isArray(input.supplierIds) || input.supplierIds.length === 0) return [];
  const unnamed = () => input.supplierIds.map(() => "名称未提供");
  if (!text(input.requirement_id) || !text(workflow.mcn_directory_requirement_id_sha256)) return unnamed();
  if (sha256Text(input.requirement_id.trim()) !== workflow.mcn_directory_requirement_id_sha256) return undefined;
  if (!Array.isArray(workflow.mcn_recipient_directory)) return unnamed();

  const namesBySupplierHash = new Map<string, string>();
  for (const recipient of workflow.mcn_recipient_directory) {
    if (!recipient || typeof recipient !== "object") continue;
    if (text(recipient.supplier_id_sha256) && text(recipient.name)) {
      namesBySupplierHash.set(recipient.supplier_id_sha256.trim(), recipient.name.trim());
    }
  }
  return input.supplierIds.map((supplierId: unknown) =>
    text(supplierId) ? namesBySupplierHash.get(sha256Text(supplierId.trim())) ?? "名称未提供" : "名称未提供"
  );
}

function recipientRequirementMismatch(input: Json, workflow: Json): boolean {
  return Boolean(
    text(input.requirement_id) &&
    text(workflow.mcn_directory_requirement_id_sha256) &&
    sha256Text(input.requirement_id.trim()) !== workflow.mcn_directory_requirement_id_sha256,
  );
}

function recipientSelectionMismatch(input: Json, workflow: Json): boolean {
  if (workflow.post_race_evidence_status !== "valid") return false;
  if (!Array.isArray(workflow.selected_supplier_id_hashes)) return true;
  if (!Array.isArray(input.supplierIds) || !input.supplierIds.every(text)) return true;
  const actual = input.supplierIds.map((supplierId: string) => sha256Text(supplierId.trim())).sort();
  const expected = workflow.selected_supplier_id_hashes
    .filter(text)
    .map((supplierHash: string) => supplierHash.trim())
    .sort();
  return actual.length !== new Set(actual).size ||
    actual.length !== expected.length || actual.some((supplierHash, index) => supplierHash !== expected[index]);
}

function createSummary(input: Json, workflow: Json): Json {
  const description = text(input.description) ? input.description : "";
  return {
    requirement_id_sha256: text(input.requirement_id) ? sha256Text(input.requirement_id.trim()) : null,
    supplier_count: Array.isArray(input.supplierIds) ? input.supplierIds.length : 0,
    recipient_names: selectedRecipientNames(input, workflow),
    column_names: Array.isArray(input.columns) ? input.columns.map(selectedColumnName).filter(text) : [],
    description_sha256: description ? sha256Text(description) : null,
  };
}

function descriptionPreview(value: unknown): string {
  if (!text(value)) return "（未提供企微消息）";
  return value;
}

function externalSendQuestion(input: Json, summary: Json): string {
  const recipientNames = Array.isArray(summary.recipient_names) ? summary.recipient_names.filter(text) : [];
  const columnNames = Array.isArray(summary.column_names) ? summary.column_names.filter(text) : [];
  return [
    "⚠️ 不可逆企微外发",
    "",
    `确认后将立即向 ${summary.supplier_count} 家机构执行企微群聊绑定校验；仅向已绑定的机构发送，未绑定的机构不会发送并会在结果中列出。`,
    "",
    `发送对象（${summary.supplier_count} 家）`,
    ...(recipientNames.length > 0
      ? recipientNames.map((name: string, index: number) => `${index + 1}. ${name}`)
      : Array.from(
          { length: Number(summary.supplier_count) || 0 },
          (_, index) => `${index + 1}. 名称未提供`,
        )),
    "",
    "回填字段",
    ...(columnNames.length > 0 ? columnNames.map((name: string) => `- ${name}`) : ["- 未选择"]),
    "",
    "企微消息正文",
    "────────",
    descriptionPreview(input.description),
    "────────",
    "",
    "是否确认立即发送？",
  ].join("\n");
}

function externalSendAskInputForQuestion(question: string, summary: Json): Json {
  return {
    questions: [{
      header: EXTERNAL_SEND_HEADER,
      question,
      options: [
        {
          label: EXTERNAL_SEND_CONFIRM_LABEL,
          description: `校验上述 ${summary.supplier_count} 家机构的群聊绑定，仅向已绑定机构发送并返回未绑定名单`,
        },
        {
          label: EXTERNAL_SEND_CANCEL_LABEL,
          description: "停止本次外发，可先修改发送对象、字段或消息",
        },
      ],
    }],
  };
}

function externalSendAskInput(input: Json, summary: Json): Json {
  return externalSendAskInputForQuestion(externalSendQuestion(input, summary), summary);
}

function confirmationRequiredResult(askInput: Json): Json {
  return {
    block: true,
    blockReason: [
      `${EXTERNAL_SEND_CONFIRMATION_MARKER}: Provider 尚未调用。`,
      "立即调用宿主工具 AskUserQuestion，arguments 必须与下方 JSON 完全一致，不得改写问题、换行或选项：",
      "<AskUserQuestionInput>",
      JSON.stringify(askInput),
      "</AskUserQuestionInput>",
      `AskUserQuestion 的提交回调可在后续 assistant turn 到达；本地一次性确认回执会在 ${EXTERNAL_SEND_RECEIPT_WINDOW} 内保持有效，切勿因回合切换重新生成确认。`,
      `仅当回调结果为“${EXTERNAL_SEND_CONFIRM_LABEL}”时，立即用完全相同的 create_with_distributions 参数再调用一次；其他结果停止且不发送。`,
    ].join("\n"),
  };
}

function projectExternalConfirmation(
  current: GuardStore,
  id: string,
  receipt: Json,
  status: string,
): void {
  const workflow = current.data.workflow as Json;
  workflow.wecom_confirmation_id = id;
  workflow.wecom_confirmation_status = status;
  workflow.wecom_confirmation_mode = receipt.confirmation_mode;
  workflow.wecom_confirmation_request_sha256 = receipt.request_fingerprint;
  workflow.wecom_confirmation_user_prompted = receipt.user_prompted === true;
  workflow.wecom_confirmation_user_approved = receipt.user_confirmed === true;
  workflow.wecom_confirmation_updated_at_ms = Date.now();
  if (status === "denied") {
    workflow.user_pause_status = "ask_cancelled_closed_timed_out_or_failed";
    workflow.user_pause_at_ms = workflow.wecom_confirmation_updated_at_ms;
  } else {
    delete workflow.user_pause_status;
    delete workflow.user_pause_at_ms;
  }
}

function authorizeExternalSend(
  input: Json,
  rootDir: string,
  toolCallId?: string,
  scopeAvailable = true,
): Json | undefined {
  const selected = scopeAvailable ? store(rootDir) : globalStore(rootDir);
  const locked = withStoreLock(selected.path, (current) =>
    authorizeExternalSendInStore(input, toolCallId, current)
  );
  if (!locked.acquired) {
    return denyStructured(
      "INTEGRATION_REQUIRED",
      "A local external-send confirmation transition is already in progress. Wait for it to finish, then retry the declared MCP tool without sending directly.",
    );
  }
  return locked.value;
}

function authorizeExternalSendInStore(
  input: Json,
  toolCallId: string | undefined,
  current: GuardStore,
): Json | undefined {
  const requestFingerprint = fingerprint(input);
  const inFlight = Object.entries<Json>(current.data.confirmations).find(([, receipt]) =>
    receipt.kind === "external_send" && EXTERNAL_SEND_CONFIRMATION_MODES.has(receipt.confirmation_mode) &&
    receipt.status === "in_flight" && receipt.request_fingerprint === requestFingerprint
  );
  if (inFlight) {
    if (inFlight[1].tool_call_id === (toolCallId ?? null)) return undefined;
    return denyStructured(
      "INTEGRATION_REQUIRED",
      "This exact external-send request is already in flight under another tool call. Wait for its result or reconcile the unknown outcome before any retry.",
    );
  }

  const completedFallbackStatus = completedIndividualFallbackStatus(
    current.data.workflow as Json,
    input,
  );
  if (completedFallbackStatus) {
    return denyStructured(
      "INTEGRATION_REQUIRED",
      `该机构在本次逐个发送中的状态已记录为 ${completedFallbackStatus}，禁止重复发送。`,
    );
  }

  const approved = Object.entries<Json>(current.data.confirmations).find(([, receipt]) =>
    receipt.kind === "external_send" && EXTERNAL_SEND_CONFIRMATION_MODES.has(receipt.confirmation_mode) &&
    receipt.status === "approved" && receipt.request_fingerprint === requestFingerprint &&
    receipt.user_prompted === true && receipt.user_confirmed === true
  );
  if (approved) {
    const [id, receipt] = approved;
    receipt.status = "in_flight" satisfies ConfirmationStatus;
    receipt.tool_call_id = toolCallId ?? null;
    receipt.updated_at_ms = Date.now();
    current.data.confirmations[id] = receipt;
    current.data.latest_external_confirmation_id = id;
    projectExternalConfirmation(current, id, receipt, "in_flight");
    save(current.path, current.data);
    return undefined;
  }

  const pending = Object.entries<Json>(current.data.confirmations).find(([, receipt]) =>
    receipt.kind === "external_send" && receipt.confirmation_mode === "ask_user_question" &&
    receipt.status === "pending" && receipt.request_fingerprint === requestFingerprint
  );
  if (pending) {
    const askInput = externalSendAskInput(input, pending[1].safe_summary);
    if (pending[1].ask_input_fingerprint === fingerprint(askInput)) {
      return confirmationRequiredResult(askInput);
    }
    pending[1].status = "denied" satisfies ConfirmationStatus;
    pending[1].resolution = "prompt-changed";
    pending[1].updated_at_ms = Date.now();
    current.data.confirmations[pending[0]] = pending[1];
  }

  const now = Date.now();
  for (const [id, receipt] of Object.entries<Json>(current.data.confirmations)) {
    if (
      receipt.kind !== "external_send" || !EXTERNAL_SEND_CONFIRMATION_MODES.has(receipt.confirmation_mode) ||
      !["pending", "approved"].includes(receipt.status)
    ) continue;
    receipt.status = "denied" satisfies ConfirmationStatus;
    receipt.resolution = "superseded";
    receipt.updated_at_ms = now;
    current.data.confirmations[id] = receipt;
  }

  const id = randomUUID();
  const summary = createSummary(input, current.data.workflow as Json);
  if (recipientRequirementMismatch(input, current.data.workflow as Json)) {
    save(current.path, current.data);
    return denyStructured(
      "INTEGRATION_REQUIRED",
      "发送对象所属需求与最近一次 MCN排序结果不一致，请返回 MCN 方案修改或重新选择后再发送。",
    );
  }
  if (recipientSelectionMismatch(input, current.data.workflow as Json)) {
    save(current.path, current.data);
    return denyStructured(
      "INTEGRATION_REQUIRED",
      "发送机构集合与最近一次赛后覆盖去重并集计算绑定的机构集合不一致，请重新计算倍率与补量建议后再发送。",
    );
  }
  for (const key of [
    "distribution_retry_active", "distribution_initial_requested_supplier_count",
    "distribution_excluded_unbound_supplier_count", "distribution_retry_supplier_count",
  ]) delete current.data.workflow[key];
  const askInput = externalSendAskInput(input, summary);
  current.data.confirmations[id] = {
    kind: "external_send",
    confirmation_mode: "ask_user_question",
    request_fingerprint: requestFingerprint,
    input_fingerprint: requestFingerprint,
    ask_input_fingerprint: fingerprint(askInput),
    safe_summary: summary,
    status: "pending" satisfies ConfirmationStatus,
    user_prompted: false,
    user_confirmed: false,
    created_at_ms: now,
    updated_at_ms: now,
    expires_at_ms: now + CONFIRMATION_TTL_MS,
  };
  current.data.latest_external_confirmation_id = id;
  projectExternalConfirmation(current, id, current.data.confirmations[id], "popup_required");
  save(current.path, current.data);
  return confirmationRequiredResult(askInput);
}

export function guardWorkflowTool(
  event: Json,
  tool: string,
  input: Json,
  _current: GuardStore,
  rootDir: string,
  scopeAvailable: boolean,
): Json | undefined {
  const providerContractBlock = CURRENT_PROVIDER_CONTRACT_BLOCKS[tool];
  if (providerContractBlock) return denyStructured("INTEGRATION_REQUIRED", providerContractBlock);
  if (tool === "select_inquiry_form_fields") return authorizeFieldSelection(event, input, _current);
  if (tool === "validate_requirement") return authorizeRequirementBrief(event, input);
  if (tool === "search_creators") {
    if (!validRequirementPrimaryKey(input.id)) {
      return denyPreflight(
        event, tool, input, "primary_key_format", "INVALID_INPUT",
        "search_creators.id must be the 32-character hexadecimal data.id returned by validate_requirement; never pass numeric data.demand_id or demand_version. Correct the ID from the existing response without validating again.",
      );
    }
    return scopeAvailable ? authorizeFreshSearchRequirement(event, input, _current) : undefined;
  }
  if (tool === "manual_source_creators") {
    if (!validRequirementPrimaryKey(input.requirement_id)) {
      return denyPreflight(
        event, tool, input, "primary_key_format", "INVALID_INPUT",
        "manual_source_creators.requirement_id must be the 32-character hexadecimal data.id returned by validate_requirement; never pass numeric data.demand_id or demand_version. Correct the ID from the existing response without validating again.",
      );
    }
    return authorizeFreshManualRequirement(event, input, _current, rootDir);
  }
  if (tool === "rank_creators") return authorizeRankCreators(event, input, _current);
  if (tool === "sync_mcn_inquiry_status") return authorizeInquirySync(event, input, _current);
  if (tool === "create_submission_batch") return authorizeSubmissionBatch(event, input, _current);
  if (tool === "create_with_distributions") {
    return authorizeExternalSend(input, rootDir, text(event.toolCallId)
      ? event.toolCallId.trim()
      : text(event.callID)
        ? event.callID.trim()
        : undefined, scopeAvailable);
  }
  return undefined;
}

function recordExternalSendResult(event: Json, input: Json, rootDir: string): GuardStore | undefined {
  const selected = store(rootDir);
  const locked = withStoreLock(selected.path, (current) =>
    recordExternalSendResultInStore(event, input, current)
  );
  return locked.acquired ? locked.value : undefined;
}

function recordExternalSendResultInStore(
  event: Json,
  input: Json,
  current: GuardStore,
): GuardStore | undefined {
  const requestFingerprint = fingerprint(input);
  const afterToolCallId = text(event.toolCallId)
    ? event.toolCallId.trim()
    : text(event.callID)
      ? event.callID.trim()
      : undefined;
  const matchesInFlight = (receipt: Json) => {
    if (
      receipt.kind !== "external_send" ||
      !EXTERNAL_SEND_CONFIRMATION_MODES.has(receipt.confirmation_mode)
    ) return false;
    if (receipt.status !== "in_flight" || receipt.input_fingerprint !== requestFingerprint) return false;
    if (afterToolCallId && text(receipt.tool_call_id)) return receipt.tool_call_id === afterToolCallId;
    return true;
  };
  const inFlight = Object.entries<Json>(current.data.confirmations).find(([, receipt]) =>
    matchesInFlight(receipt)
  );
  if (!inFlight) return undefined;
  const [id, receipt] = inFlight;
  if (receipt.user_prompted !== true || receipt.user_confirmed !== true) return undefined;
  const now = Date.now();
  const unboundRejection = distributionUnboundRejectionEvidence(
    event,
    input,
    current.data.workflow as Json,
  );
  const batchFallback = unboundRejection ? undefined : distributionBatchFallbackEvidence(event, input);
  if (unboundRejection) {
    receipt.status = "consumed" satisfies ConfirmationStatus;
    receipt.resolution = "batch-group-mapping-rejected-individual-fallback";
    for (const supplierId of unboundRejection.remainingSupplierIds) {
      const retryInput = { ...input, supplierIds: [supplierId] };
      const retryId = randomUUID();
      const safeSummary = createSummary(retryInput, current.data.workflow as Json);
      const askInput = externalSendAskInput(retryInput, safeSummary);
      current.data.confirmations[retryId] = {
        kind: "external_send",
        confirmation_mode: "ask_user_question",
        request_fingerprint: fingerprint(retryInput),
        input_fingerprint: fingerprint(retryInput),
        ask_input_fingerprint: fingerprint(askInput),
        safe_summary: safeSummary,
        status: "pending" satisfies ConfirmationStatus,
        user_prompted: false,
        user_confirmed: false,
        parent_confirmation_id: id,
        excluded_supplier_count: unboundRejection.unboundCount,
        created_at_ms: now,
        updated_at_ms: now,
        expires_at_ms: receipt.expires_at_ms,
      };
      current.data.latest_external_confirmation_id = retryId;
      projectExternalConfirmation(current, retryId, current.data.confirmations[retryId], "popup_required");
    }
  } else if (batchFallback) {
    receipt.status = "consumed" satisfies ConfirmationStatus;
    receipt.resolution = "batch-pre-send-rejected-individual-fallback";
    for (const supplierId of batchFallback.supplierIds) {
      const fallbackInput = { ...input, supplierIds: [supplierId] };
      const fallbackId = randomUUID();
      const safeSummary = createSummary(fallbackInput, current.data.workflow as Json);
      const askInput = externalSendAskInput(fallbackInput, safeSummary);
      current.data.confirmations[fallbackId] = {
        kind: "external_send",
        confirmation_mode: "ask_user_question",
        request_fingerprint: fingerprint(fallbackInput),
        input_fingerprint: fingerprint(fallbackInput),
        ask_input_fingerprint: fingerprint(askInput),
        safe_summary: safeSummary,
        status: "pending" satisfies ConfirmationStatus,
        user_prompted: false,
        user_confirmed: false,
        parent_confirmation_id: id,
        created_at_ms: now,
        updated_at_ms: now,
        expires_at_ms: receipt.expires_at_ms,
      };
      current.data.latest_external_confirmation_id = fallbackId;
      projectExternalConfirmation(current, fallbackId, current.data.confirmations[fallbackId], "popup_required");
    }
  } else if (!event.error && definiteFailureEnvelope(event.result) && !hasDistributionWriteEvidence(event.result)) {
    receipt.status = "consumed" satisfies ConfirmationStatus;
    receipt.resolution = "definite-no-write-failure";
  } else {
    receipt.status = successful(event.error ? { isError: true } : event.result) ? "consumed" : "unknown";
  }
  receipt.updated_at_ms = now;
  delete receipt.tool_call_id;
  current.data.confirmations[id] = receipt;
  const latestIdValue = current.data.latest_external_confirmation_id;
  const latestId = text(latestIdValue) ? latestIdValue.trim() : undefined;
  const latestReceipt = latestId ? current.data.confirmations[latestId] as Json | undefined : undefined;
  if ((unboundRejection || batchFallback) && latestId && latestReceipt?.status === "pending") {
    projectExternalConfirmation(current, latestId, latestReceipt, "popup_required");
  } else {
    projectExternalConfirmation(current, id, receipt, receipt.status);
  }
  save(current.path, current.data);
  return current;
}

function recordExternalSendDecision(event: Json, input: Json, rootDir: string): void {
  const selected = store(rootDir);
  withStoreLock(selected.path, (current) => recordExternalSendDecisionInStore(event, input, current));
}

function recordExternalSendDecisionInStore(event: Json, input: Json, current: GuardStore): void {
  const askInputFingerprint = fingerprint(input);
  const matchPending = (candidate: GuardStore): { pending: [string, Json]; answer?: string } | undefined => {
    let pending = Object.entries<Json>(candidate.data.confirmations).find(([, receipt]) =>
      receipt.kind === "external_send" && receipt.confirmation_mode === "ask_user_question" &&
      receipt.status === "pending" && receipt.ask_input_fingerprint === askInputFingerprint
    );
    let answer = pending ? answerForQuestion(event, input) : undefined;

    // Some hosts normalize or depth-truncate AskUserQuestion params before the
    // after_tool_call hook. Their result still echoes the exact rendered question
    // and selected label, so bind that echo back to one unique pending receipt.
    if (!pending) {
      const echoed = echoedExternalSendSelection(event);
      const matches = Object.entries<Json>(candidate.data.confirmations).flatMap(([id, receipt]) => {
        if (receipt.kind !== "external_send" || receipt.confirmation_mode !== "ask_user_question" ||
            receipt.status !== "pending" || !echoed) return [];
        const echoedAskInput = externalSendAskInputForQuestion(echoed.question, receipt.safe_summary);
        return receipt.ask_input_fingerprint === fingerprint(echoedAskInput)
          ? [{ id, receipt, answer: echoed.answer }]
          : [];
      });
      if (matches.length === 1) {
        pending = [matches[0].id, matches[0].receipt];
        answer = matches[0].answer;
      }
    }
    return pending ? { pending, answer } : undefined;
  };

  const matched = matchPending(current);
  if (!matched) return;

  const { pending: [id, receipt], answer } = matched;
  const now = Date.now();
  receipt.user_prompted = true;
  receipt.user_confirmed = !event.error && event.result?.isError !== true &&
    answer === EXTERNAL_SEND_CONFIRM_LABEL;
  receipt.status = !event.error && event.result?.isError !== true && answer === EXTERNAL_SEND_CONFIRM_LABEL
    ? "approved" satisfies ConfirmationStatus
    : "denied" satisfies ConfirmationStatus;
  receipt.resolution = answer ?? "denied";
  receipt.callback_received_at_ms = now;
  if (receipt.status === "approved") receipt.approved_at_ms = now;
  else delete receipt.approved_at_ms;
  receipt.updated_at_ms = now;
  current.data.confirmations[id] = receipt;
  projectExternalConfirmation(current, id, receipt, receipt.status);
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
    recordExternalSendDecision(event, input, rootDir);
    updateWorkflowForDecision(event, input, rootDir);
    return;
  }
  if (!tool) return;
  const preflightDenial = takePreflightDenial(event, tool, input);
  const externalSendStore = tool === "create_with_distributions"
    ? recordExternalSendResult(event, input, rootDir)
    : undefined;
  updateLocalWorkflow(event, tool, input, rootDir, preflightDenial, Boolean(externalSendStore), externalSendStore);
  recordRequirementReceipts(event, tool, rootDir, preflightDenial);
}
