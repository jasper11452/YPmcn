import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

function readSpec(relativePath) {
  return JSON.parse(readFileSync(new URL(`../spec/${relativePath}`, import.meta.url), "utf8"));
}

const targetProfile = readSpec("mcp.json");
const workflowProfile = readSpec("workflow.json");
const requirementPolicy = readSpec("requirements.json");
const requirementDictionary = readSpec("requirement-dictionary.json");
const requirementRecordSchema = readSpec("schemas/requirement-record.schema.json");
const constraintExpressionSchema = readSpec("schemas/constraint-expression.schema.json");
const errorProfile = readSpec("errors.json");

const ERROR_MESSAGES = Object.fromEntries(errorProfile.errors.map(({ code, message }) => [code, message]));
const FIELD_ITEMS = [
  { key: "nickname", name: "达人昵称", type: "VARCHAR", required: true },
  { key: "kol_official_price_l1", name: "图文报价", type: "BIGINT", required: true },
];
const FIELD_MAP = Object.fromEntries(FIELD_ITEMS.map((item) => [item.key, item]));
const CONSTRAINT_FIELD_CLASSIFICATIONS = new Set(
  requirementPolicy.processingPolicies.constraintGrammar.fieldVocabulary.allowedClassifications,
);
const CONSTRAINT_FIELDS = new Set(
  Object.entries(requirementDictionary.definitions)
    .filter(([, definition]) => CONSTRAINT_FIELD_CLASSIFICATIONS.has(definition.classification))
    .map(([field]) => field),
);
const RANGE_FIELDS = new Set([
  "budget_min_cents",
  "budget_max_cents",
  "rebate_min_rate",
  "rebate_max_rate",
]);
const DEADLINE_FIELDS = new Set([
  "supplier_response_deadline_at",
  "client_submission_deadline_at",
  "content_publish_deadline_at",
  "submission_deadline_at",
  "submission_deadline_raw",
]);
const RFC3339_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;

function clone(value) {
  return structuredClone(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function frozenClone(value) {
  return deepFreeze(clone(value));
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function deepEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length && left.every((item, index) => deepEqual(item, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && deepEqual(left[key], right[key]));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function resolvePointer(document, pointer) {
  return pointer.split("/").slice(1).reduce((valueAtPointer, token) => {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    return valueAtPointer[key];
  }, document);
}

function matchesType(value, type) {
  switch (type) {
    case "array": return Array.isArray(value);
    case "boolean": return typeof value === "boolean";
    case "integer": return Number.isInteger(value);
    case "null": return value === null;
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "object": return isRecord(value);
    case "string": return typeof value === "string";
    default: return true;
  }
}

function daysInMonth(year, month) {
  if (month === 2) {
    const leap = year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function parseRfc3339(value) {
  if (typeof value !== "string") return undefined;
  const match = RFC3339_PATTERN.exec(value);
  if (!match) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHour, offsetMinute] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (
    month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) ||
    hour > 23 || minute > 59 || second > 60 ||
    (offsetHour !== undefined && Number(offsetHour) > 23) ||
    (offsetMinute !== undefined && Number(offsetMinute) > 59)
  ) {
    return undefined;
  }
  const normalized = value.replace("t", "T").replace("z", "Z");
  const parsed = Date.parse(second === 60
    ? normalized.replace(/:60(?=\.|Z|[+-])/, ":59")
    : normalized);
  if (second === 60 && Number.isFinite(parsed)) return parsed + 1_000;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isUri(value) {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol.length > 1;
  } catch {
    return false;
  }
}

function validateSchema(schema, value, path, issues, rootSchema = schema) {
  if (schema.$ref) {
    if (schema.$ref.startsWith("#")) {
      validateSchema(resolvePointer(rootSchema, schema.$ref.slice(1)), value, path, issues, rootSchema);
    }
    return;
  }

  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length > 0 && !types.some((type) => matchesType(value, type))) {
    issues.push(`${path} has the wrong type`);
    return;
  }
  if (hasOwn(schema, "const") && !deepEqual(value, schema.const)) {
    issues.push(`${path} does not match const`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => deepEqual(value, candidate))) {
    issues.push(`${path} is not in enum`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) issues.push(`${path} is too short`);
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) issues.push(`${path} does not match pattern`);
    if (schema.format === "date-time" && parseRfc3339(value) === undefined) {
      issues.push(`${path} is not an RFC3339 date-time`);
    }
    if (schema.format === "uri" && !isUri(value)) issues.push(`${path} is not a URI`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) issues.push(`${path} is below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) issues.push(`${path} is above maximum`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) issues.push(`${path} has too few items`);
    if (schema.uniqueItems) {
      value.forEach((item, index) => {
        if (value.slice(0, index).some((candidate) => deepEqual(candidate, item))) {
          issues.push(`${path}[${index}] is duplicated`);
        }
      });
    }
    if (schema.items) {
      value.forEach((item, index) => validateSchema(schema.items, item, `${path}[${index}]`, issues, rootSchema));
    }
  }
  if (isRecord(value)) {
    if (schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties) {
      issues.push(`${path} has too few properties`);
    }
    for (const required of schema.required ?? []) {
      if (!hasOwn(value, required)) issues.push(`${path}.${required} is required`);
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (hasOwn(value, key)) validateSchema(child, value[key], `${path}.${key}`, issues, rootSchema);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!hasOwn(schema.properties ?? {}, key)) issues.push(`${path}.${key} is not declared`);
      }
    } else if (isRecord(schema.additionalProperties)) {
      for (const key of Object.keys(value)) {
        if (!hasOwn(schema.properties ?? {}, key)) {
          validateSchema(schema.additionalProperties, value[key], `${path}.${key}`, issues, rootSchema);
        }
      }
    }
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((branch) => {
      const branchIssues = [];
      validateSchema(branch, value, path, branchIssues, rootSchema);
      return branchIssues.length === 0;
    });
    if (matches.length !== 1) issues.push(`${path} does not match exactly one schema branch`);
  }
}

function validateArguments(name, args) {
  const contract = targetProfile.tools[name];
  if (!hasOwn(targetProfile.tools, name) || !contract) return [`Tool ${name} is not declared`];
  if (!isRecord(args)) return ["Arguments must be an object"];
  const issues = [];
  const schema = {
    type: "object",
    required: contract.required,
    properties: contract.properties,
    additionalProperties: false,
  };
  validateSchema(schema, args, "$", issues);
  if (contract.inputModes) {
    const matched = Object.values(contract.inputModes.modes)
      .some((mode) => mode.matchAny.some((key) => hasOwn(args, key)));
    if (!matched) issues.push("$ does not match a declared input mode");
  }
  if (contract.alternativeMode === "exactly-one") {
    const active = contract.requiredAlternatives.filter((keys) => keys.some((key) => hasOwn(args, key)));
    if (active.length !== 1 || !active[0].every((key) => hasOwn(args, key))) {
      issues.push("$ must contain exactly one complete identifier alternative");
    }
  }
  return issues;
}

function classifyRequirementInputIssues(issues) {
  if (issues.length > 0 && issues.every((issue) => [...RANGE_FIELDS].some((field) => issue.includes(`.${field}`)))) {
    return "VALUE_RANGE_INVALID";
  }
  if (issues.length > 0 && issues.every((issue) => [...DEADLINE_FIELDS].some((field) => issue.includes(`.${field}`)))) {
    return "DEADLINE_ORDER_INVALID";
  }
  if (issues.length > 0 && issues.every((issue) => issue.includes(".constraints"))) {
    return "CONSTRAINT_GRAMMAR_INVALID";
  }
  return "INVALID_INPUT";
}

function standardSuccess(data) {
  return { success: true, data: clone(data), error: null };
}

function standardError(code, message = ERROR_MESSAGES[code] ?? code) {
  return {
    success: false,
    data: null,
    error: { code, message, retryable: false },
  };
}

function toolDescription(name) {
  return `Deterministic, network-free mvp-v2 reference implementation for ${name}.`;
}

export function createToolDefinitions() {
  return [...targetProfile.requiredTools, ...targetProfile.optionalTools].map((name) => {
    const contract = targetProfile.tools[name];
    const inputSchema = {
      type: "object",
      required: clone(contract.required),
      properties: clone(contract.properties),
      additionalProperties: false,
    };
    if (contract.requiredAlternatives) {
      inputSchema.oneOf = contract.requiredAlternatives.map((required) => ({ required: clone(required) }));
    }
    if (contract.inputModes) {
      inputSchema.anyOf = Object.values(contract.inputModes.modes)
        .flatMap((mode) => mode.matchAny.map((key) => ({ required: [key] })));
    }
    return { name, description: toolDescription(name), inputSchema };
  });
}

function validateCanonicalMessages(messages) {
  const issues = [];
  validateSchema(
    requirementRecordSchema.properties.raw_messages_json,
    messages,
    "$.raw_messages_json",
    issues,
    requirementRecordSchema,
  );
  return issues;
}

function validateConstraintExpression(expression) {
  const issues = [];
  validateSchema(constraintExpressionSchema, expression, "$", issues, constraintExpressionSchema);

  function inspect(node) {
    if (!isRecord(node)) return;
    if (["comparison", "range", "set"].includes(node.kind) && !CONSTRAINT_FIELDS.has(node.field)) {
      issues.push(`$.field ${String(node.field)} is outside the approved dictionary vocabulary`);
    }
    if (node.kind === "range" && typeof node.lower === "number" && typeof node.upper === "number" && node.lower > node.upper) {
      issues.push("$.lower must be less than or equal to $.upper");
    }
    if (Array.isArray(node.expressions)) {
      for (const child of node.expressions) inspect(child);
    }
    if (isRecord(node.expression)) inspect(node.expression);
  }
  inspect(expression);
  return issues;
}

function requirementSemantics(args) {
  const dictionaryMatchesPolicy =
    requirementPolicy.dictionary.version === requirementDictionary.dictionaryVersion &&
    requirementPolicy.dictionary.hash === requirementDictionary.dictionaryHash;
  const embeddedIdentity = args.requirements_json;
  const embeddedHasVersion = isRecord(embeddedIdentity) && hasOwn(embeddedIdentity, "dictionary_version");
  const embeddedHasHash = isRecord(embeddedIdentity) && hasOwn(embeddedIdentity, "dictionary_hash");
  if (
    !dictionaryMatchesPolicy ||
    embeddedHasVersion !== embeddedHasHash ||
    (embeddedHasVersion && (
      embeddedIdentity.dictionary_version !== requirementDictionary.dictionaryVersion ||
      embeddedIdentity.dictionary_hash !== requirementDictionary.dictionaryHash
    ))
  ) {
    return { errorCode: "DICTIONARY_REFERENCE_MISMATCH" };
  }

  let canonicalMessages;
  if (hasOwn(args, "raw_messages_json")) {
    try {
      canonicalMessages = JSON.parse(args.raw_messages_json);
    } catch {
      return { errorCode: "INVALID_INPUT", message: "raw_messages_json must contain valid JSON" };
    }
    if (validateCanonicalMessages(canonicalMessages).length > 0) {
      return { errorCode: "INVALID_INPUT", message: "raw_messages_json does not match the canonical message schema" };
    }
  }
  if (hasOwn(args, "raw_messages")) {
    if (validateCanonicalMessages(args.raw_messages).length > 0) {
      return { errorCode: "INVALID_INPUT", message: "raw_messages does not normalize to the canonical message schema" };
    }
    if (canonicalMessages !== undefined && !deepEqual(canonicalMessages, args.raw_messages)) {
      return { errorCode: "CANONICAL_INPUT_CONFLICT" };
    }
    canonicalMessages ??= args.raw_messages;
  }

  if (!hasOwn(args, "platform")) {
    return { errorCode: "INVALID_INPUT", message: "platform is required for one executable requirement" };
  }

  const budgetMin = args.budget_min_cents;
  const budgetMax = args.budget_max_cents;
  const rebateMin = args.rebate_min_rate;
  const rebateMax = args.rebate_max_rate;
  if (
    !Number.isInteger(budgetMin) || !Number.isInteger(budgetMax) ||
    budgetMin < 0 || budgetMax < 0 || budgetMin > budgetMax ||
    typeof rebateMin !== "number" || !Number.isFinite(rebateMin) ||
    typeof rebateMax !== "number" || !Number.isFinite(rebateMax) ||
    rebateMin < 0 || rebateMin > 1 || rebateMax < 0 || rebateMax > 1 || rebateMin > rebateMax
  ) {
    return { errorCode: "VALUE_RANGE_INVALID" };
  }

  const supplierDeadline = parseRfc3339(args.supplier_response_deadline_at);
  const contentDeadline = parseRfc3339(args.content_publish_deadline_at);
  const clientCandidates = [
    args.client_submission_deadline_at,
    args.submission_deadline_at,
    args.submission_deadline_raw,
  ].filter((candidate) => candidate !== undefined);
  const parsedClientCandidates = clientCandidates.map(parseRfc3339);
  if (
    supplierDeadline === undefined || contentDeadline === undefined || clientCandidates.length === 0 ||
    parsedClientCandidates.some((candidate) => candidate === undefined) ||
    parsedClientCandidates.some((candidate) => candidate !== parsedClientCandidates[0]) ||
    supplierDeadline > parsedClientCandidates[0] || parsedClientCandidates[0] > contentDeadline
  ) {
    return { errorCode: "DEADLINE_ORDER_INVALID" };
  }

  for (const constraint of args.constraints ?? []) {
    if (validateConstraintExpression(constraint).length > 0) {
      return { errorCode: "CONSTRAINT_GRAMMAR_INVALID" };
    }
  }

  const normalizedDeadlines = {
    supplier_response_deadline_at: new Date(supplierDeadline).toISOString(),
    client_submission_deadline_at: new Date(parsedClientCandidates[0]).toISOString(),
    content_publish_deadline_at: new Date(contentDeadline).toISOString(),
  };
  const rawMessagesHash = canonicalMessages === undefined ? undefined : digest(canonicalMessages);
  const canonicalFields = Object.fromEntries(Object.entries(args).filter(([key]) => ![
    "raw_messages",
    "raw_messages_json",
    "supplier_response_deadline_at",
    "client_submission_deadline_at",
    "content_publish_deadline_at",
    "submission_deadline_at",
    "submission_deadline_raw",
  ].includes(key)));
  const canonicalRequirement = {
    ...canonicalFields,
    raw_messages_hash: rawMessagesHash ?? null,
    deadlines: normalizedDeadlines,
  };
  return {
    rawMessagesHash: rawMessagesHash ?? digest(canonicalRequirement),
    canonicalRequirementHash: digest(canonicalRequirement),
    normalizedDeadlines,
  };
}

function combinationFor(workflowState) {
  if (!Number.isInteger(workflowState.stateVersion) || workflowState.stateVersion < 1) return undefined;
  const matches = workflowProfile.stateCombinations.filter((combination) =>
    combination.phase === workflowState.phase &&
    combination.lifecycleStatuses.some((status) => status === workflowState.lifecycleStatus) &&
    combination.responseStatuses.some((status) => status === workflowState.responseStatus));
  return matches.length === 1 ? matches[0] : undefined;
}

export function createReferenceState(options = {}) {
  const now = options.now ?? Date.now;
  // Accepted only as injectable tripwires/fixtures in tests. The reference
  // implementation never invokes fetch or treats initialState as production data.
  void options.fetch;
  const initialState = options.initialState ?? {};
  const initialIdentifiers = initialState.identifiers ?? {};
  const initialNow = now();
  if (!Number.isFinite(initialNow)) throw new TypeError("now() must return epoch milliseconds");

  const state = {
    phase: initialState.phase ?? "requirement_draft",
    lifecycleStatus: hasOwn(initialState, "lifecycle_status") ? initialState.lifecycle_status : null,
    responseStatus: hasOwn(initialState, "response_status") ? initialState.response_status : null,
    stateVersion: initialState.state_version ?? 1,
    updatedAt: initialState.updated_at ?? new Date(initialNow).toISOString(),
    requirementHeadId: undefined,
    requirementIds: [],
    requirementId: initialIdentifiers.requirement_id,
    requirement: undefined,
    requirementSnapshot: undefined,
    candidatePoolId: initialIdentifiers.candidate_pool_id,
    mcnRecommendationId: initialIdentifiers.mcn_recommendation_id,
    selection: initialIdentifiers.selection_result_id
      ? { id: initialIdentifiers.selection_result_id }
      : undefined,
    sendOperation: initialIdentifiers.send_operation_id
      ? { id: initialIdentifiers.send_operation_id }
      : undefined,
    providerProjectId: undefined,
    distributionBatchRef: undefined,
    distributions: undefined,
    deadlineMs: undefined,
    supplierIds: [],
    inquiryBatchId: initialIdentifiers.inquiry_batch_id,
    inquiryIds: [],
    inquirySnapshot: undefined,
    ingestBatchId: undefined,
    recoveryOperation: initialIdentifiers.recovery_operation_id
      ? { id: initialIdentifiers.recovery_operation_id }
      : undefined,
    submissionItems: [],
    manualBatches: new Map(),
    manualBatchByHash: new Map(),
    run: initialIdentifiers.run_id ? { id: initialIdentifiers.run_id } : undefined,
    submissionBatches: [],
    currentSubmissionBatchId: initialIdentifiers.submission_batch_id,
    feedbackAudits: [],
    adjustmentAudits: new Map(),
  };

  function timestamp() {
    const candidate = now();
    if (!Number.isFinite(candidate)) throw new TypeError("now() must return epoch milliseconds");
    return new Date(Math.max(candidate, Date.parse(state.updatedAt))).toISOString();
  }

  function currentCombination() {
    return combinationFor(state);
  }

  function transition(phase, lifecycleStatus = null, responseStatus = null) {
    const candidate = {
      phase,
      lifecycleStatus,
      responseStatus,
      stateVersion: state.stateVersion + 1,
    };
    if (!combinationFor(candidate)) return false;
    state.phase = phase;
    state.lifecycleStatus = lifecycleStatus;
    state.responseStatus = responseStatus;
    state.stateVersion += 1;
    state.updatedAt = timestamp();
    return true;
  }

  function identifiers() {
    return Object.fromEntries(Object.entries({
      requirement_id: state.requirementId,
      candidate_pool_id: state.candidatePoolId,
      mcn_recommendation_id: state.mcnRecommendationId,
      selection_result_id: state.selection?.id,
      send_operation_id: state.sendOperation?.id,
      inquiry_batch_id: state.inquiryBatchId,
      recovery_operation_id: state.recoveryOperation?.id,
      run_id: state.run?.id,
      submission_batch_id: state.currentSubmissionBatchId,
    }).filter(([, value]) => typeof value === "string" && value.length > 0));
  }

  function matchingIds(args) {
    return args.requirement_id === state.requirementId &&
      args.mcn_recommendation_id === state.mcnRecommendationId;
  }

  function failure(name, code, message) {
    const declaredCodes = targetProfile.outputContracts[name]?.errorCodes ?? [];
    if (!declaredCodes.includes(code)) {
      throw new Error(`${name} attempted undeclared error code ${code}`);
    }
    return standardError(code, message ?? ERROR_MESSAGES[code]);
  }

  function invalidCombination(name) {
    const declaredCodes = targetProfile.outputContracts[name].errorCodes;
    const code = declaredCodes.includes("STATE_COMBINATION_INVALID")
      ? "STATE_COMBINATION_INVALID"
      : "INVALID_PHASE";
    return failure(name, code);
  }

  function requireAction(name, action) {
    const combination = currentCombination();
    if (!combination) return { error: invalidCombination(name) };
    if (!combination.allowedActions.includes(action)) {
      return { error: failure(name, "INVALID_PHASE") };
    }
    return { combination };
  }

  function syncData() {
    const combination = currentCombination();
    return {
      inquiry_batch_id: state.inquiryBatchId,
      inquiry_ids: [...state.inquiryIds],
      snapshot_id: state.inquirySnapshot.id,
      lifecycle_status: state.lifecycleStatus,
      response_status: state.responseStatus,
      state_version: state.stateVersion,
      allowed_actions: clone(combination.allowedActions),
    };
  }

  function ingestData() {
    const combination = currentCombination();
    return {
      id: state.ingestBatchId,
      accepted_count: state.submissionItems.length,
      rejected_count: 0,
      created_submission_item_count: state.submissionItems.length,
      recovery_operation_id: state.recoveryOperation.id,
      state_version: state.stateVersion,
      allowed_actions: clone(combination.allowedActions),
    };
  }

  function requirementData() {
    return {
      id: state.requirementId,
      status: "ready",
      requirement_head_id: state.requirementHeadId,
      requirement_ids: [...state.requirementIds],
      dictionary_version: requirementDictionary.dictionaryVersion,
      dictionary_hash: requirementDictionary.dictionaryHash,
    };
  }

  async function callTool(name, args = {}) {
    if (!hasOwn(targetProfile.tools, name)) {
      return { simulated: true, output: standardError("INTEGRATION_REQUIRED", `Tool ${name} is unavailable`) };
    }
    const inputIssues = validateArguments(name, args);
    if (inputIssues.length > 0) {
      const code = name === "validate_requirement"
        ? classifyRequirementInputIssues(inputIssues)
        : "INVALID_INPUT";
      return { simulated: true, output: failure(name, code, inputIssues.join("; ")) };
    }

    let output;
    switch (name) {
      case "validate_requirement": {
        const combination = currentCombination();
        if (!combination) {
          output = failure(name, "INVALID_INPUT", "Authoritative workflow state is invalid");
          break;
        }
        const semantics = requirementSemantics(args);
        if (semantics.errorCode) {
          output = failure(name, semantics.errorCode, semantics.message);
          break;
        }
        if (!combination.allowedActions.includes("validate_requirement")) {
          output = state.requirement?.canonicalRequirementHash === semantics.canonicalRequirementHash
            ? standardSuccess(requirementData())
            : failure(name, "INVALID_INPUT", "Reference state already contains a different canonical requirement");
          break;
        }
        state.requirementHeadId = "requirement-head-0001";
        state.requirementIds = ["req-0001"];
        state.requirementId = state.requirementIds[0];
        state.requirement = frozenClone({
          id: state.requirementId,
          headId: state.requirementHeadId,
          dictionaryVersion: requirementDictionary.dictionaryVersion,
          dictionaryHash: requirementDictionary.dictionaryHash,
          rawMessagesHash: semantics.rawMessagesHash,
          canonicalRequirementHash: semantics.canonicalRequirementHash,
          budgetMinCents: args.budget_min_cents,
          budgetMaxCents: args.budget_max_cents,
          rebateMinRate: args.rebate_min_rate,
          rebateMaxRate: args.rebate_max_rate,
          deadlines: semantics.normalizedDeadlines,
          constraintsHash: digest(args.constraints ?? []),
        });
        transition("requirement_ready");
        output = standardSuccess(requirementData());
        break;
      }
      case "search_creators": {
        const action = requireAction(name, "search_creators");
        if (action.error) {
          output = action.error;
          break;
        }
        if (args.requirement_id !== state.requirementId) {
          output = failure(name, "SCOPE_MISMATCH");
          break;
        }
        if (
          state.requirement?.dictionaryVersion !== requirementDictionary.dictionaryVersion ||
          state.requirement?.dictionaryHash !== requirementDictionary.dictionaryHash
        ) {
          output = failure(name, "DICTIONARY_REFERENCE_MISMATCH");
          break;
        }
        const asOfAt = timestamp();
        state.requirementSnapshot = frozenClone({
          id: "requirement-snapshot-0001",
          requirementId: state.requirementId,
          dictionaryVersion: requirementDictionary.dictionaryVersion,
          dictionaryHash: requirementDictionary.dictionaryHash,
          rawMessagesHash: state.requirement.rawMessagesHash,
          payloadHash: digest(state.requirement),
          asOfAt,
        });
        state.candidatePoolId = "pool-0001";
        transition("candidate_pool_ready");
        output = standardSuccess({
          id: state.candidatePoolId,
          candidate_pool_written: true,
          requirement_snapshot_id: state.requirementSnapshot.id,
          as_of_at: state.requirementSnapshot.asOfAt,
        });
        break;
      }
      case "rank_mcns": {
        const action = requireAction(name, "rank_mcns");
        if (action.error) {
          output = action.error;
          break;
        }
        if (args.candidate_pool_id !== state.candidatePoolId) {
          output = failure(name, "SCOPE_MISMATCH");
          break;
        }
        if (!state.requirementSnapshot) {
          output = failure(name, "JOIN_GATE_FAILED");
          break;
        }
        state.mcnRecommendationId = "mcnr-0001";
        transition("mcn_planning");
        output = standardSuccess({
          id: state.mcnRecommendationId,
          inquiry_advice: { supplier_ids: ["supplier-1", "supplier-2"] },
          requirement_snapshot_id: state.requirementSnapshot.id,
        });
        break;
      }
      case "select_inquiry_form_fields": {
        const action = requireAction(name, "select_inquiry_form_fields");
        if (action.error) {
          output = action.error;
          break;
        }
        if (args.mcn_recommendation_id !== state.mcnRecommendationId) {
          output = failure(name, "SCOPE_MISMATCH");
          break;
        }
        if (!state.requirementSnapshot) {
          output = failure(name, "JOIN_GATE_FAILED");
          break;
        }
        transition("field_selection_ready");
        state.selection = frozenClone({
          id: "selection-0001",
          mcnRecommendationId: state.mcnRecommendationId,
          requirementSnapshotId: state.requirementSnapshot.id,
          dictionaryVersion: requirementDictionary.dictionaryVersion,
          dictionaryHash: requirementDictionary.dictionaryHash,
          columns: FIELD_ITEMS,
          selectionHash: digest(FIELD_ITEMS),
          stateVersion: state.stateVersion,
          createdAt: state.updatedAt,
        });
        output = {
          success: true,
          url: "http://127.0.0.1/reference-field-selector",
          message: "Reference field selection completed",
          description: "nickname, kol_official_price_l1",
          fields: clone(FIELD_MAP),
          items: clone(state.selection.columns),
          selected_count: state.selection.columns.length,
          output_format: "database_field: label",
        };
        break;
      }
      case "create_with_distributions": {
        const action = requireAction(name, "create_with_distributions");
        if (action.error) {
          output = action.error;
          break;
        }
        if (args.mcn_recommendation_id !== state.mcnRecommendationId) {
          output = failure(name, "SCOPE_MISMATCH");
          break;
        }
        if (
          !state.selection ||
          state.selection.mcnRecommendationId !== state.mcnRecommendationId ||
          state.selection.requirementSnapshotId !== state.requirementSnapshot?.id ||
          state.selection.dictionaryVersion !== requirementDictionary.dictionaryVersion ||
          state.selection.dictionaryHash !== requirementDictionary.dictionaryHash ||
          state.selection.stateVersion !== state.stateVersion
        ) {
          output = failure(name, "SELECTION_RESULT_STALE");
          break;
        }
        if (!deepEqual(args.columns, state.selection.columns)) {
          output = failure(name, "FIELD_SELECTION_INVALID");
          break;
        }
        const distributions = args.supplierIds.map((supplierId, index) => {
          const suffix = String(index + 1).padStart(4, "0");
          return {
            supplier_id: supplierId,
            provider_distribution_id: `provider-distribution-${suffix}`,
            token: `reference-token-${suffix}`,
            fill_link: `https://reference.invalid/fill/reference-token-${suffix}`,
          };
        });
        transition("distribution_sync_pending", "sent", "pending");
        state.providerProjectId = "provider-project-0001";
        state.distributionBatchRef = "distribution-0001";
        state.deadlineMs = parseRfc3339(args.deadline);
        state.supplierIds = frozenClone(args.supplierIds);
        state.distributions = frozenClone(distributions);
        state.sendOperation = frozenClone({
          id: "send-0001",
          selectionResultId: state.selection.id,
          stateVersion: state.stateVersion,
          requestedAt: state.updatedAt,
        });
        output = standardSuccess({
          provider_project_id: state.providerProjectId,
          distribution_batch_ref: state.distributionBatchRef,
          send_operation_id: state.sendOperation.id,
          selection_result_id: state.selection.id,
          state_version: state.stateVersion,
          distributions: state.distributions,
        });
        break;
      }
      case "sync_mcn_inquiry_status": {
        const combination = currentCombination();
        if (!combination) {
          output = invalidCombination(name);
          break;
        }
        if (!matchingIds(args)) {
          output = failure(name, "SCOPE_MISMATCH");
          break;
        }
        if (!state.sendOperation || !state.distributionBatchRef) {
          output = combination.allowedActions.includes("refresh_recovery") ||
              combination.allowedActions.includes("finalize_recovery")
            ? failure(name, "PROVIDER_REFERENCE_MISSING")
            : failure(name, "INVALID_PHASE");
          break;
        }

        if (combination.allowedActions.includes("finalize_recovery")) {
          if (!state.recoveryOperation || !state.ingestBatchId) {
            output = failure(name, "STATE_CONFLICT");
            break;
          }
          transition("recovered", "recovered", "completed");
          output = standardSuccess(syncData());
          break;
        }
        if (!combination.allowedActions.includes("refresh_recovery")) {
          output = failure(name, "INVALID_PHASE");
          break;
        }

        if (!state.inquiryBatchId) {
          state.inquiryBatchId = "inquiry-batch-0001";
          state.inquiryIds = frozenClone(
            state.supplierIds.map((_, index) => `inquiry-${String(index + 1).padStart(4, "0")}`),
          );
          state.inquirySnapshot = frozenClone({
            id: "inquiry-snapshot-0001",
            requirementSnapshotId: state.requirementSnapshot.id,
            inquiryIds: state.inquiryIds,
            createdAt: timestamp(),
          });
        }

        if (state.phase === "distribution_sync_pending") {
          transition("waiting_return", "waiting_return", "pending");
        } else if (state.phase === "waiting_return" && now() > state.deadlineMs) {
          transition("recovering", "waiting_return", "expired");
        } else if (state.phase === "recovering" && state.lifecycleStatus === "recover_failed") {
          transition("recovering", "waiting_return", now() > state.deadlineMs ? "expired" : "pending");
        }
        output = standardSuccess(syncData());
        break;
      }
      case "ingest_mcn_submissions": {
        const combination = currentCombination();
        if (!combination) {
          output = invalidCombination(name);
          break;
        }
        if (!matchingIds(args)) {
          output = failure(name, "SCOPE_MISMATCH");
          break;
        }
        if (["recovered", "closed"].includes(state.lifecycleStatus)) {
          output = failure(name, "RECOVERY_ALREADY_TERMINAL");
          break;
        }
        if (state.recoveryOperation && state.phase === "recovery_sync_pending") {
          if (!state.recoveryOperation.triggerOrigins.includes(args.trigger)) {
            state.recoveryOperation.triggerOrigins.push(args.trigger);
          }
          output = standardSuccess(ingestData());
          break;
        }
        if (!combination.allowedActions.includes("request_recovery")) {
          output = failure(name, "RECOVERY_NOT_CONFIRMED");
          break;
        }
        if (!state.inquirySnapshot || state.inquiryIds.length === 0) {
          output = failure(name, "JOIN_GATE_FAILED");
          break;
        }
        const requestedStateVersion = state.stateVersion;
        const submissionItems = state.supplierIds.map((supplierId, index) => ({
          id: `submission-item-${String(index + 1).padStart(4, "0")}`,
          supplier_id: supplierId,
          creator_id: `creator-${String(index + 1).padStart(4, "0")}`,
        }));
        transition("recovery_sync_pending", "recovering", "partial");
        state.ingestBatchId = "ingest-0001";
        state.submissionItems = frozenClone(submissionItems);
        state.recoveryOperation = {
          id: "recovery-operation-0001",
          requestedStateVersion,
          resultingStateVersion: state.stateVersion,
          triggerOrigins: [args.trigger],
        };
        output = standardSuccess(ingestData());
        break;
      }
      case "manual_source_creators": {
        const combination = currentCombination();
        if (!combination) {
          output = invalidCombination(name);
          break;
        }
        if (["requirement_draft", "blocked"].includes(state.phase)) {
          output = failure(name, "INVALID_PHASE");
          break;
        }
        if (args.requirement_id !== state.requirementId) {
          output = failure(name, "SCOPE_MISMATCH");
          break;
        }
        const batchHash = digest({ requirement_id: args.requirement_id, manual_results: args.manual_results });
        let manualBatch = state.manualBatchByHash.get(batchHash);
        if (!manualBatch) {
          const batchNumber = state.manualBatches.size + 1;
          manualBatch = frozenClone({
            id: `manual-batch-${String(batchNumber).padStart(4, "0")}`,
            requirementId: state.requirementId,
            items: args.manual_results,
            createdAt: timestamp(),
          });
          state.manualBatches.set(manualBatch.id, manualBatch);
          state.manualBatchByHash.set(batchHash, manualBatch);
        }
        output = standardSuccess({
          manual_batch_id: manualBatch.id,
          imported_count: manualBatch.items.length,
        });
        break;
      }
      case "rank_creators": {
        const action = requireAction(name, "rank_creators");
        if (action.error) {
          output = action.error;
          break;
        }
        if (args.mcn_recommendation_id !== state.mcnRecommendationId) {
          output = failure(name, "SCOPE_MISMATCH");
          break;
        }
        if (!state.requirementSnapshot || state.submissionItems.length === 0) {
          output = failure(name, "JOIN_GATE_FAILED");
          break;
        }
        const selectedManualIds = args.manual_batch_ids ?? [...state.manualBatches.keys()];
        const selectedManualBatches = selectedManualIds.map((id) => state.manualBatches.get(id));
        if (selectedManualBatches.some((batch) => !batch || batch.requirementId !== state.requirementId)) {
          output = failure(name, "JOIN_GATE_FAILED");
          break;
        }
        const rankedCount = state.submissionItems.length +
          selectedManualBatches.reduce((count, batch) => count + batch.items.length, 0);
        transition("recommendation_ready", state.lifecycleStatus, state.responseStatus);
        state.run = frozenClone({
          id: "run-0001",
          stateVersion: state.stateVersion,
          snapshot: {
            requirement_snapshot_id: state.requirementSnapshot.id,
            ranked_count: rankedCount,
            submission_item_ids: state.submissionItems.map(({ id }) => id),
            manual_batch_ids: selectedManualIds,
          },
        });
        output = standardSuccess({
          run_id: state.run.id,
          ranked_count: rankedCount,
          requirement_snapshot_id: state.requirementSnapshot.id,
          state_version: state.stateVersion,
        });
        break;
      }
      case "create_submission_batch": {
        const action = requireAction(name, "create_submission_batch");
        if (action.error) {
          output = action.error;
          break;
        }
        if (args.run_id !== state.run?.id) {
          output = failure(name, "SCOPE_MISMATCH");
          break;
        }
        const batchNumber = state.submissionBatches.length + 1;
        transition("submission_batch_ready", state.lifecycleStatus, state.responseStatus);
        const batch = frozenClone({
          id: `submission-batch-${String(batchNumber).padStart(4, "0")}`,
          batchNo: batchNumber,
          submittedCount: state.run.snapshot.ranked_count,
          stateVersion: state.stateVersion,
        });
        state.submissionBatches.push(batch);
        state.currentSubmissionBatchId = batch.id;
        output = standardSuccess({
          id: batch.id,
          batch_no: batch.batchNo,
          submitted_count: batch.submittedCount,
          state_version: batch.stateVersion,
        });
        break;
      }
      case "record_client_feedback": {
        const action = requireAction(name, "record_client_feedback");
        if (action.error) {
          output = action.error;
          break;
        }
        if (args.run_id !== state.run?.id) {
          output = failure(name, "SCOPE_MISMATCH");
          break;
        }
        const offset = state.feedbackAudits.length;
        const feedbackAuditIds = args.feedback_items.map((_, index) =>
          `feedback-audit-${String(offset + index + 1).padStart(4, "0")}`);
        transition("feedback_routing", state.lifecycleStatus, state.responseStatus);
        args.feedback_items.forEach((item, index) => {
          state.feedbackAudits.push(frozenClone({
            id: feedbackAuditIds[index],
            runId: state.run.id,
            item,
            stateVersion: state.stateVersion,
          }));
        });
        output = standardSuccess({
          updated_count: args.feedback_items.length,
          next_action: "feedback_routing",
          feedback_audit_ids: feedbackAuditIds,
          state_version: state.stateVersion,
        });
        break;
      }
      case "get_recommendation_run_detail":
        output = args.run_id === state.run?.id && state.run.snapshot
          ? standardSuccess({
              run_id: state.run.id,
              recommendation_snapshot: state.run.snapshot,
              state_version: state.run.stateVersion,
            })
          : failure(name, "SCOPE_MISMATCH");
        break;
      case "get_creator_detail": {
        const creatorId = args.creator_id ?? `${args.platform}:${args.platform_account_id}`;
        const creatorDetail = args.creator_id
          ? { creator_id: args.creator_id }
          : { platform: args.platform, platform_account_id: args.platform_account_id };
        output = standardSuccess({ creator_id: creatorId, creator_detail: creatorDetail });
        break;
      }
      case "audit_manual_adjustment": {
        const combination = currentCombination();
        if (!combination) {
          output = invalidCombination(name);
          break;
        }
        if (!state.run || !["recommendation_ready", "submission_batch_ready", "feedback_routing"].includes(state.phase)) {
          output = failure(name, "INVALID_PHASE");
          break;
        }
        if (args.run_id !== state.run.id) {
          output = failure(name, "SCOPE_MISMATCH");
          break;
        }
        const auditHash = digest(args);
        let audit = state.adjustmentAudits.get(auditHash);
        if (!audit) {
          audit = frozenClone({
            id: `audit-${String(state.adjustmentAudits.size + 1).padStart(4, "0")}`,
            items: args.adjustments,
            operatorId: args.operator_id,
            stateVersion: state.stateVersion,
          });
          state.adjustmentAudits.set(auditHash, audit);
        }
        output = standardSuccess({
          audit_id: audit.id,
          items: audit.items,
          written_count: audit.items.length,
        });
        break;
      }
      case "get_workflow_state": {
        const combination = currentCombination();
        if (!combination) {
          output = invalidCombination(name);
          break;
        }
        const [identifierName, currentIdentifier] = Object.entries(args)[0];
        if (identifiers()[identifierName] !== currentIdentifier) {
          output = failure(name, "SCOPE_MISMATCH");
          break;
        }
        output = standardSuccess({
          phase: state.phase,
          current_identifier: currentIdentifier,
          lifecycle_status: state.lifecycleStatus,
          response_status: state.responseStatus,
          state_version: state.stateVersion,
          allowed_actions: clone(combination.allowedActions),
          pending_gates: [],
          identifiers: identifiers(),
          updated_at: state.updatedAt,
        });
        break;
      }
      default:
        output = standardError("INTEGRATION_REQUIRED", `Tool ${name} is unavailable`);
    }
    return { simulated: true, output };
  }

  function snapshot() {
    const combination = currentCombination();
    return clone({
      phase: state.phase,
      lifecycle_status: state.lifecycleStatus,
      response_status: state.responseStatus,
      state_version: state.stateVersion,
      allowed_actions: combination?.allowedActions ?? [],
      identifiers: identifiers(),
      updated_at: state.updatedAt,
      submissionItemCount: state.submissionItems.length,
      recoveryOperationCount: state.recoveryOperation ? 1 : 0,
      manualBatchCount: state.manualBatches.size,
      rawMessagesHash: state.requirement?.rawMessagesHash,
    });
  }

  return { callTool, snapshot };
}
