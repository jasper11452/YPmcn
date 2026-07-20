import { randomUUID } from "node:crypto";

import {
  CONFIRMATION_TTL_MS,
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
} from "./runtime-hook-state.js";

const PREFIXES = ["ypmcn__", "mcp__ypmcn__", "ypmcn-mcp__", "ypmcn-provider__"];
const EXTERNAL_SEND_HEADER = "企微外发确认";
const EXTERNAL_SEND_CONFIRM_LABEL = "确认发送";
const EXTERNAL_SEND_CANCEL_LABEL = "取消发送";
const EXTERNAL_SEND_CONFIRMATION_MARKER = "EXTERNAL_SEND_CONFIRMATION_REQUIRED";
const SEARCH_CONFIRMATION_HEADER = "供给确认";
const MANUAL_TARGET_CONFIRMATION_HEADER = "手扒数量";
const MCN_CONFIRMATION_HEADER = "MCN确认";
const FIELD_CONFIRMATION_HEADER = "字段确认";
const START_MANUAL_AND_MCN_LABEL = "启动手扒并开始MCN赛马";
const MCN_ONLY_LABEL = "仅开始MCN赛马";
const ADJUST_MANUAL_TARGET_LABEL = "调整手扒数量";
const MANUAL_TASK_STATUSES = new Set(["started", "running", "completed"]);
const MANUAL_TASK_OPERATIONS = new Set(["created", "reused"]);
const MCN_ID_KEYS = [
  "supplier_id", "supplierId", "mcn_id", "mcnId", "institution_id", "institutionId",
  "agency_id", "agencyId", "vendor_id", "vendorId",
];
const MCN_NAME_KEYS = [
  "supplier_name", "supplierName", "mcn_name", "mcnName", "institution_name", "institutionName",
  "agency_name", "agencyName", "organization_name", "organizationName", "display_name", "displayName",
];
const MCN_CONTEXT_KEY = /(?:mcn|supplier|institution|agency|vendor|recommend)/i;

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
  return [
    column.label, column.name, column.field_name,
    column.field, column.key, column.field_key,
  ].find(text)?.trim();
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

function freeformAnswerForQuestion(event: Json, input: Json): string | undefined {
  if (event.error) return undefined;
  const question = firstQuestion(input);
  if (!question || !text(question.question)) return undefined;
  const questionText = question.question.trim();
  for (const candidate of answerValues(event.result ?? event.message)) {
    const prefix = `${questionText}: `;
    if (candidate.startsWith(prefix)) return candidate.slice(prefix.length).trim();
    if (candidate !== questionText) return candidate;
  }
  return undefined;
}

function positiveManualTarget(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const matched = /^(?:手扒新增|新增|目标)?\s*(\d+)\s*(?:位|个)?$/u.exec(value.normalize("NFKC").trim());
  if (!matched) return undefined;
  const target = Number(matched[1]);
  return Number.isSafeInteger(target) && target > 0 ? target : undefined;
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

type SearchSupplyEvidence = {
  demandCount: number;
  eligibleCreatorCount: number;
  supplyRatio: number;
  hardShortfallCount: number;
  bufferShortfallCount: number;
  supplyRiskLevel: "low_risk" | "medium_risk" | "high_risk";
  suggestedExpansionCount: number;
  recommendedAction: string;
};

function searchSupplyEvidence(root: unknown, workflow: Json): SearchSupplyEvidence | undefined {
  const data = approvedTargetData(root);
  if (!data) return undefined;
  const riskLevels = new Set(["low_risk", "medium_risk", "high_risk"]);
  for (const record of objectRecords(data)) {
    const demandCount = record.demand_count;
    const eligibleCreatorCount = record.eligible_creator_count;
    const supplyRatio = record.supply_ratio;
    const hardShortfallCount = record.hard_shortfall_count;
    const bufferShortfallCount = record.buffer_shortfall_count;
    const supplyRiskLevel = record.supply_risk_level;
    const suggestedExpansionCount = record.suggested_expansion_count;
    const recommendedAction = record.recommended_action;
    if (
      !Number.isInteger(demandCount) || demandCount < 1 ||
      !Number.isInteger(eligibleCreatorCount) || eligibleCreatorCount < 0 ||
      typeof supplyRatio !== "number" || !Number.isFinite(supplyRatio) || supplyRatio < 0 ||
      !Number.isInteger(hardShortfallCount) || hardShortfallCount < 0 ||
      !Number.isInteger(bufferShortfallCount) || bufferShortfallCount < 0 ||
      !text(supplyRiskLevel) || !riskLevels.has(supplyRiskLevel) ||
      !Number.isInteger(suggestedExpansionCount) || suggestedExpansionCount < 0 ||
      !text(recommendedAction)
    ) continue;
    if (Number.isInteger(workflow.quantity_total) && workflow.quantity_total !== demandCount) continue;
    if (hardShortfallCount !== Math.max(demandCount - eligibleCreatorCount, 0)) continue;
    if (Math.abs(supplyRatio - eligibleCreatorCount / demandCount) > 0.01) continue;
    if (
      supplyRiskLevel === "high_risk" &&
      (suggestedExpansionCount < 1 || bufferShortfallCount < 1 || recommendedAction !== "mcn_and_manual")
    ) continue;
    return {
      demandCount,
      eligibleCreatorCount,
      supplyRatio,
      hardShortfallCount,
      bufferShortfallCount,
      supplyRiskLevel: supplyRiskLevel as SearchSupplyEvidence["supplyRiskLevel"],
      suggestedExpansionCount,
      recommendedAction: recommendedAction.trim(),
    };
  }
  return undefined;
}

type ManualSourcingEvidence = {
  taskId: string;
  targetCount: number;
  status: string;
  operation: string;
  startedAt: string;
  acceptedCount: number;
};

function manualSourcingEvidence(
  root: unknown,
  input: Json,
  workflow: Json,
): ManualSourcingEvidence | undefined {
  const data = approvedTargetData(root);
  if (!data) return undefined;
  const expectedRequirementId = text(workflow.requirement_id) ? workflow.requirement_id.trim() : undefined;
  const expectedTarget = workflow.pending_manual_target_count;
  if (
    !expectedRequirementId || !Number.isInteger(expectedTarget) || expectedTarget < 1 ||
    !text(input.requirement_id) || input.requirement_id.trim() !== expectedRequirementId ||
    input.target_count !== expectedTarget
  ) return undefined;

  const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
  for (const record of objectRecords(data)) {
    const taskId = record.task_id;
    const requirementId = record.requirement_id;
    const targetCount = record.target_count;
    const status = record.status;
    const operation = record.operation;
    const startedAt = record.started_at;
    const acceptedCount = record.accepted_count;
    if (
      !text(taskId) || !text(requirementId) || requirementId.trim() !== expectedRequirementId ||
      targetCount !== expectedTarget || !text(status) || !MANUAL_TASK_STATUSES.has(status) ||
      !text(operation) || !MANUAL_TASK_OPERATIONS.has(operation) ||
      !text(startedAt) || !timestampPattern.test(startedAt) || Number.isNaN(Date.parse(startedAt)) ||
      !Number.isInteger(acceptedCount) || acceptedCount < 0
    ) continue;
    return {
      taskId: taskId.trim(),
      targetCount,
      status,
      operation,
      startedAt,
      acceptedCount,
    };
  }
  return undefined;
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
}

function appendWorkflowEvent(data: Json, event: Json): void {
  const events = Array.isArray(data.workflow_events) ? data.workflow_events : [];
  events.push(event);
  data.workflow_events = events.slice(-50);
}

function updateWorkflowForDecision(event: Json, input: Json, rootDir: string): void {
  if (event.error) return;
  const header = firstQuestionHeader(input);
  if (![
    SEARCH_CONFIRMATION_HEADER,
    MANUAL_TARGET_CONFIRMATION_HEADER,
    MCN_CONFIRMATION_HEADER,
    FIELD_CONFIRMATION_HEADER,
  ].includes(header ?? "")) return;
  const answer = header === MANUAL_TARGET_CONFIRMATION_HEADER
    ? freeformAnswerForQuestion(event, input)
    : answerForQuestion(event, input);
  if (!answer) return;

  const current = store(rootDir);
  const workflow = current.data.workflow as Json;
  workflow.last_user_command = answer;
  workflow.updated_at_ms = Date.now();

  if (header === SEARCH_CONFIRMATION_HEADER) {
    const validPlan = workflow.supply_plan_status === "valid";
    const highRisk = workflow.supply_risk_level === "high_risk";
    const suggested = workflow.suggested_expansion_count;
    if (
      answer === START_MANUAL_AND_MCN_LABEL && validPlan && highRisk &&
      Number.isInteger(suggested) && suggested > 0
    ) {
      workflow.pending_manual_target_count = suggested;
      workflow.next_action = "manual_source_creators";
      workflow.waiting_for = null;
    } else if (
      [MCN_ONLY_LABEL, "确认并开始MCN赛马", "按建议开始MCN赛马", "确认继续"].includes(answer) &&
      validPlan
    ) {
      delete workflow.pending_manual_target_count;
      workflow.next_action = "rank_mcns";
      workflow.waiting_for = null;
    } else if (answer === ADJUST_MANUAL_TARGET_LABEL && validPlan && highRisk) {
      delete workflow.pending_manual_target_count;
      workflow.next_action = "confirm_manual_target_count";
      workflow.waiting_for = "user";
    } else {
      workflow.next_action = validPlan ? "confirm_search_results" : "recover_search_supply_plan";
      workflow.waiting_for = "user";
    }
  } else if (header === MANUAL_TARGET_CONFIRMATION_HEADER) {
    const target = positiveManualTarget(answer);
    if (target && workflow.supply_plan_status === "valid" && workflow.supply_risk_level === "high_risk") {
      workflow.pending_manual_target_count = target;
      workflow.next_action = "manual_source_creators";
      workflow.waiting_for = null;
    } else {
      delete workflow.pending_manual_target_count;
      workflow.next_action = "confirm_manual_target_count";
      workflow.waiting_for = "user";
    }
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
  const envelopeOk = successful(event.error ? { isError: true } : event.result);
  const manualEvidence = tool === "manual_source_creators" && envelopeOk
    ? manualSourcingEvidence(event.result, input, workflow)
    : undefined;
  const ok = envelopeOk && (tool !== "manual_source_creators" || manualEvidence !== undefined);
  const now = Date.now();
  workflow.last_tool = tool;
  workflow.last_tool_status = ok ? "success" : "failed";
  workflow.updated_at_ms = now;
  if (tool === "search_creators" || tool === "rank_mcns") clearMcnRecipientDirectory(workflow);

  if (tool === "select_inquiry_form_fields") {
    // The provider call only launches an out-of-band browser selector. Its result
    // cannot tell us whether that browser opened, so always pause for pasted fields.
    workflow.phase = "inquiry_fields_ready";
    workflow.next_action = "confirm_inquiry_fields";
    workflow.waiting_for = "user";
  } else if (!ok) {
    if (tool === "manual_source_creators") {
      workflow.manual_sourcing_evidence_status = envelopeOk ? "invalid" : "unavailable";
      workflow.manual_sourcing_evidence_error = envelopeOk
        ? "missing_or_conflicting_task_evidence"
        : "provider_call_failed_or_unknown";
    }
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
        workflow.waiting_for = "user";
        const supply = searchSupplyEvidence(root, workflow);
        if (!supply) {
          for (const key of [
            "demand_count",
            "matched_creator_count",
            "supply_ratio",
            "hard_shortfall_count",
            "buffer_shortfall_count",
            "supply_risk_level",
            "suggested_expansion_count",
            "recommended_action",
            "pending_manual_target_count",
          ]) delete workflow[key];
          workflow.supply_plan_status = "invalid";
          workflow.supply_plan_error = "missing_or_contradictory_provider_evidence";
          workflow.next_action = "recover_search_supply_plan";
          break;
        }
        workflow.supply_plan_status = "valid";
        delete workflow.supply_plan_error;
        workflow.demand_count = supply.demandCount;
        workflow.matched_creator_count = supply.eligibleCreatorCount;
        workflow.supply_ratio = supply.supplyRatio;
        workflow.hard_shortfall_count = supply.hardShortfallCount;
        workflow.buffer_shortfall_count = supply.bufferShortfallCount;
        workflow.supply_risk_level = supply.supplyRiskLevel;
        workflow.suggested_expansion_count = supply.suggestedExpansionCount;
        workflow.recommended_action = supply.recommendedAction;
        workflow.next_action = "confirm_search_results";
        break;
      }
      case "rank_mcns": {
        workflow.phase = "mcn_planning";
        workflow.next_action = "confirm_mcn_selection";
        workflow.waiting_for = "user";
        if (Number.isInteger(input.minimum_mcn_count)) workflow.mcn_race_size = input.minimum_mcn_count;
        const recipients = collectMcnRecipientDirectory(root);
        if (recipients.length > 0 && text(input.id)) {
          workflow.mcn_recipient_directory = recipients;
          workflow.mcn_directory_requirement_id_sha256 = sha256Text(input.id.trim());
        }
        break;
      }
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
        if (!manualEvidence) break;
        workflow.manual_sourcing_task_id = manualEvidence.taskId;
        workflow.manual_sourcing_status = manualEvidence.status;
        workflow.manual_sourcing_operation = manualEvidence.operation;
        workflow.manual_sourcing_target_count = manualEvidence.targetCount;
        workflow.manual_sourcing_started_at = manualEvidence.startedAt;
        workflow.manual_sourcing_accepted_count = manualEvidence.acceptedCount;
        workflow.manual_sourcing_evidence_status = "valid";
        delete workflow.manual_sourcing_evidence_error;
        delete workflow.pending_manual_target_count;
        workflow.next_action = "rank_mcns";
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
    `确认后将立即向 ${summary.supplier_count} 家机构发送以下企微消息。`,
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
          description: `立即向上述 ${summary.supplier_count} 家机构发送这条企微消息`,
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
      `仅当结果为“${EXTERNAL_SEND_CONFIRM_LABEL}”时，立即用完全相同的 create_with_distributions 参数再调用一次；其他结果停止且不发送。`,
    ].join("\n"),
  };
}

function authorizeExternalSend(input: Json, rootDir: string, toolCallId?: string): Json | undefined {
  const requestFingerprint = fingerprint(input);
  const current = store(rootDir);
  const inFlight = Object.entries<Json>(current.data.confirmations).find(([, receipt]) =>
    receipt.kind === "external_send" && receipt.confirmation_mode === "ask_user_question" &&
    receipt.status === "in_flight" && receipt.request_fingerprint === requestFingerprint &&
    receipt.tool_call_id === (toolCallId ?? null)
  );
  if (inFlight) return undefined;

  const approved = Object.entries<Json>(current.data.confirmations).find(([, receipt]) =>
    receipt.kind === "external_send" && receipt.confirmation_mode === "ask_user_question" &&
    receipt.status === "approved" && receipt.request_fingerprint === requestFingerprint
  );
  if (approved) {
    const [id, receipt] = approved;
    receipt.status = "in_flight" satisfies ConfirmationStatus;
    receipt.tool_call_id = toolCallId ?? null;
    receipt.updated_at_ms = Date.now();
    current.data.confirmations[id] = receipt;
    current.data.latest_external_confirmation_id = id;
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
    if (receipt.kind !== "external_send" || !["pending", "approved"].includes(receipt.status)) continue;
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
      "发送对象所属需求与最近一次 MCN 赛马结果不一致，请返回 MCN 方案修改或重新选择后再发送。",
    );
  }
  const askInput = externalSendAskInput(input, summary);
  current.data.confirmations[id] = {
    kind: "external_send",
    confirmation_mode: "ask_user_question",
    request_fingerprint: requestFingerprint,
    input_fingerprint: requestFingerprint,
    ask_input_fingerprint: fingerprint(askInput),
    safe_summary: summary,
    status: "pending" satisfies ConfirmationStatus,
    created_at_ms: now,
    updated_at_ms: now,
    expires_at_ms: now + CONFIRMATION_TTL_MS,
  };
  current.data.latest_external_confirmation_id = id;
  save(current.path, current.data);
  return confirmationRequiredResult(askInput);
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
  const requestFingerprint = fingerprint(input);
  const afterToolCallId = text(event.toolCallId) ? event.toolCallId.trim() : undefined;
  const inFlight = Object.entries<Json>(current.data.confirmations).find(([, receipt]) => {
    if (receipt.kind !== "external_send" || receipt.confirmation_mode !== "ask_user_question") return false;
    if (receipt.status !== "in_flight" || receipt.input_fingerprint !== requestFingerprint) return false;
    if (afterToolCallId && text(receipt.tool_call_id)) return receipt.tool_call_id === afterToolCallId;
    return true;
  });
  if (!inFlight) return;
  const [id, receipt] = inFlight;
  receipt.status = successful(event.error ? { isError: true } : event.result) ? "consumed" : "unknown";
  receipt.updated_at_ms = Date.now();
  delete receipt.tool_call_id;
  current.data.confirmations[id] = receipt;
  save(current.path, current.data);
}

function recordExternalSendDecision(event: Json, input: Json, rootDir: string): void {
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

  let current = store(rootDir);
  let matched = matchPending(current);
  if (!matched) {
    const fallback = globalStore(rootDir);
    if (fallback.path !== current.path) {
      const fallbackMatch = matchPending(fallback);
      if (fallbackMatch) {
        current = fallback;
        matched = fallbackMatch;
      }
    }
  }
  if (!matched) return;

  const { pending: [id, receipt], answer } = matched;
  receipt.status = !event.error && event.result?.isError !== true && answer === EXTERNAL_SEND_CONFIRM_LABEL
    ? "approved" satisfies ConfirmationStatus
    : "denied" satisfies ConfirmationStatus;
  receipt.resolution = answer ?? "denied";
  receipt.updated_at_ms = Date.now();
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
    recordExternalSendDecision(event, input, rootDir);
    updateWorkflowForDecision(event, input, rootDir);
    return;
  }
  if (!tool) return;
  if (tool === "create_with_distributions") recordExternalSendResult(event, input, rootDir);
  updateLocalWorkflow(event, tool, input, rootDir);
}
