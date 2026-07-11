import { readFileSync } from "node:fs";

const profilePath = new URL("../YPmcn/spec/profiles/mvp-v2.json", import.meta.url);
const targetProfile = JSON.parse(readFileSync(profilePath, "utf8"));

const FIELD_ITEMS = [
  { key: "nickname", name: "达人昵称", type: "VARCHAR", required: true },
  { key: "kol_official_price_l1", name: "图文报价", type: "BIGINT", required: true },
];
const FIELD_MAP = Object.fromEntries(FIELD_ITEMS.map((item) => [item.key, item]));

function clone(value) {
  return structuredClone(value);
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

function validateSchema(schema, value, path, issues) {
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
  if (typeof value === "string" && schema.minLength !== undefined && value.length < schema.minLength) {
    issues.push(`${path} is too short`);
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
    if (schema.items) value.forEach((item, index) => validateSchema(schema.items, item, `${path}[${index}]`, issues));
  }
  if (isRecord(value)) {
    for (const required of schema.required ?? []) {
      if (!hasOwn(value, required)) issues.push(`${path}.${required} is required`);
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (hasOwn(value, key)) validateSchema(child, value[key], `${path}.${key}`, issues);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!hasOwn(schema.properties ?? {}, key)) issues.push(`${path}.${key} is not declared`);
      }
    } else if (isRecord(schema.additionalProperties)) {
      for (const key of Object.keys(value)) {
        if (!hasOwn(schema.properties ?? {}, key)) {
          validateSchema(schema.additionalProperties, value[key], `${path}.${key}`, issues);
        }
      }
    }
  }
}

function validateArguments(name, args) {
  const contract = targetProfile.tools[name];
  if (!contract) return [`Tool ${name} is not declared`];
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

function standardSuccess(data) {
  return { success: true, data: { ...data, simulated: true }, error: null };
}

function standardError(code, message) {
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

function matchingIds(state, args) {
  return args.requirement_id === state.requirementId &&
    args.mcn_recommendation_id === state.mcnRecommendationId;
}

export function createReferenceState(options = {}) {
  const now = options.now ?? Date.now;
  // Accepted only as an injectable tripwire in tests. The reference state has
  // no code path that invokes it.
  void options.fetch;

  const state = {
    phase: "requirement_draft",
    requirementId: undefined,
    candidatePoolId: undefined,
    mcnRecommendationId: undefined,
    providerProjectId: undefined,
    distributionBatchRef: undefined,
    deadlineMs: undefined,
    supplierIds: [],
    inquiryBatchId: undefined,
    inquiryIds: [],
    snapshotId: undefined,
    ingestBatchId: undefined,
    ingestTrigger: undefined,
    submissionItems: [],
    manualBatchId: undefined,
    manualImportedCount: 0,
    runId: undefined,
    submissionBatchId: undefined,
  };

  function invalidState(message) {
    return standardError("INVALID_PHASE", message);
  }

  async function callTool(name, args = {}) {
    const inputIssues = validateArguments(name, args);
    if (inputIssues.length > 0) {
      return { simulated: true, output: standardError("INVALID_INPUT", inputIssues.join("; ")) };
    }

    let output;
    switch (name) {
      case "validate_requirement":
        state.requirementId ??= "req-0001";
        state.phase = "requirement_ready";
        output = standardSuccess({ id: state.requirementId, status: "ready" });
        break;
      case "search_creators":
        if (args.requirement_id !== state.requirementId) {
          output = standardError("STATE_CONFLICT", "requirement_id does not match");
          break;
        }
        state.candidatePoolId ??= "pool-0001";
        state.phase = "candidate_pool_ready";
        output = standardSuccess({ id: state.candidatePoolId, candidate_pool_written: true });
        break;
      case "rank_mcns":
        if (args.candidate_pool_id !== state.candidatePoolId) {
          output = standardError("STATE_CONFLICT", "candidate_pool_id does not match");
          break;
        }
        state.mcnRecommendationId ??= "mcnr-0001";
        state.phase = "mcn_planning";
        output = standardSuccess({
          id: state.mcnRecommendationId,
          inquiry_advice: { supplier_ids: ["supplier-1", "supplier-2"] },
        });
        break;
      case "select_inquiry_form_fields":
        if (args.mcn_recommendation_id !== state.mcnRecommendationId) {
          output = standardError("STATE_CONFLICT", "mcn_recommendation_id does not match");
          break;
        }
        state.phase = "field_selection_ready";
        output = {
          success: true,
          url: "http://127.0.0.1/reference-field-selector",
          message: "Reference field selection completed",
          description: "nickname, kol_official_price_l1",
          fields: clone(FIELD_MAP),
          items: clone(FIELD_ITEMS),
          selected_count: FIELD_ITEMS.length,
          output_format: "database_field: label",
        };
        break;
      case "create_with_distributions":
        if (state.phase !== "field_selection_ready" || args.mcn_recommendation_id !== state.mcnRecommendationId) {
          output = invalidState("Field selection must precede distribution");
          break;
        }
        if (!deepEqual(args.columns, FIELD_ITEMS)) {
          output = standardError("FIELD_SELECTION_INVALID", "columns do not match selected fields");
          break;
        }
        state.providerProjectId ??= "provider-project-0001";
        state.distributionBatchRef ??= "distribution-0001";
        state.deadlineMs = Date.parse(args.deadline);
        state.supplierIds = [...args.supplierIds];
        state.phase = "distribution_sync_pending";
        output = standardSuccess({
          provider_project_id: state.providerProjectId,
          distribution_batch_ref: state.distributionBatchRef,
          distributions: state.supplierIds.map((supplierId, index) => ({
            provider_distribution_id: `provider-distribution-${String(index + 1).padStart(4, "0")}`,
            supplier_id: supplierId,
            status: "sent",
          })),
        });
        break;
      case "sync_mcn_inquiry_status": {
        if (!state.distributionBatchRef || !matchingIds(state, args)) {
          output = invalidState("Distribution and matching semantic IDs are required before sync");
          break;
        }
        state.inquiryBatchId ??= "inquiry-batch-0001";
        state.snapshotId ??= "snapshot-0001";
        if (state.inquiryIds.length === 0) {
          state.inquiryIds = state.supplierIds.map((_, index) => `inquiry-${String(index + 1).padStart(4, "0")}`);
        }
        let lifecycleStatus;
        let responseStatus;
        if (state.ingestBatchId) {
          lifecycleStatus = "recovered";
          responseStatus = "completed";
          state.phase = "recovered";
        } else if (now() > state.deadlineMs) {
          lifecycleStatus = "recovering";
          responseStatus = "partial";
          state.phase = "recovering";
        } else {
          lifecycleStatus = "waiting_return";
          responseStatus = "pending";
          state.phase = "waiting_return";
        }
        output = standardSuccess({
          inquiry_batch_id: state.inquiryBatchId,
          inquiry_ids: [...state.inquiryIds],
          snapshot_id: state.snapshotId,
          lifecycle_status: lifecycleStatus,
          response_status: responseStatus,
        });
        break;
      }
      case "ingest_mcn_submissions":
        if (
          state.ingestBatchId &&
          state.ingestTrigger === args.trigger &&
          matchingIds(state, args)
        ) {
          output = standardSuccess({
            id: state.ingestBatchId,
            accepted_count: state.submissionItems.length,
            rejected_count: 0,
            created_submission_item_count: state.submissionItems.length,
          });
          break;
        }
        if (state.phase !== "recovering" || !matchingIds(state, args)) {
          output = invalidState("A matching successful recovery sync is required before ingest");
          break;
        }
        state.ingestBatchId ??= `ingest-${args.trigger}-0001`;
        state.ingestTrigger ??= args.trigger;
        if (state.submissionItems.length === 0) {
          state.submissionItems = state.supplierIds.map((supplierId, index) => ({
            id: `submission-item-${String(index + 1).padStart(4, "0")}`,
            supplier_id: supplierId,
            creator_id: `creator-${String(index + 1).padStart(4, "0")}`,
          }));
        }
        state.phase = "recovery_sync_pending";
        output = standardSuccess({
          id: state.ingestBatchId,
          accepted_count: state.submissionItems.length,
          rejected_count: 0,
          created_submission_item_count: state.submissionItems.length,
        });
        break;
      case "manual_source_creators":
        if (args.requirement_id !== state.requirementId) {
          output = standardError("STATE_CONFLICT", "requirement_id does not match");
          break;
        }
        state.manualBatchId ??= "manual-batch-0001";
        state.manualImportedCount = args.manual_results.length;
        output = standardSuccess({
          manual_batch_id: state.manualBatchId,
          imported_count: state.manualImportedCount,
        });
        break;
      case "rank_creators":
        if (state.phase !== "recovered" || args.mcn_recommendation_id !== state.mcnRecommendationId) {
          output = invalidState("Authoritative recovered state is required before ranking");
          break;
        }
        state.runId ??= "run-0001";
        state.phase = "recommendation_ready";
        output = standardSuccess({
          run_id: state.runId,
          ranked_count: state.submissionItems.length + state.manualImportedCount,
        });
        break;
      case "create_submission_batch":
        if (state.phase !== "recommendation_ready" || args.run_id !== state.runId) {
          output = invalidState("A matching recommendation run is required");
          break;
        }
        state.submissionBatchId ??= "submission-batch-0001";
        state.phase = "submission_batch_ready";
        output = standardSuccess({
          id: state.submissionBatchId,
          batch_no: 1,
          submitted_count: state.submissionItems.length + state.manualImportedCount,
        });
        break;
      case "record_client_feedback":
        if (state.phase !== "submission_batch_ready" || args.run_id !== state.runId) {
          output = invalidState("A matching submission batch is required");
          break;
        }
        state.phase = "feedback_routing";
        output = standardSuccess({
          updated_count: args.feedback_items.length,
          next_action: "feedback_routing",
        });
        break;
      case "get_recommendation_run_detail":
        output = args.run_id === state.runId
          ? standardSuccess({ run_id: state.runId, phase: state.phase })
          : standardError("INVALID_INPUT", "Unknown run_id");
        break;
      case "get_creator_detail":
        output = standardSuccess({
          creator_id: args.creator_id ?? `${args.platform}:${args.platform_account_id}`,
          creator_detail: clone(args),
        });
        break;
      case "audit_manual_adjustment":
        output = standardSuccess({
          audit_id: "audit-0001",
          items: clone(args.adjustments),
          written_count: args.adjustments.length,
        });
        break;
      case "get_workflow_state":
        output = standardSuccess(snapshot());
        break;
      default:
        output = standardError("INTEGRATION_REQUIRED", `Tool ${name} is unavailable`);
    }
    return { simulated: true, output };
  }

  function snapshot() {
    return clone({
      phase: state.phase,
      requirement_id: state.requirementId,
      candidate_pool_id: state.candidatePoolId,
      mcn_recommendation_id: state.mcnRecommendationId,
      inquiry_batch_id: state.inquiryBatchId,
      run_id: state.runId,
      submissionItemCount: state.submissionItems.length,
    });
  }

  return { callTool, snapshot };
}
