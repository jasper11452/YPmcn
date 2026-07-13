import { loadContractProfile, loadContractSchema } from "../contract/loader.js";
import type { ContractSchema, MvpContractProfile } from "../contract/types.js";
import { validateFieldSelection } from "../contract/validator.js";
import { normalizeYpmcnToolName } from "./guards.js";
import type {
  ApplyToolResultContext,
  FieldDefinition,
  FieldSelectionProof,
  RecoveryTrigger,
  RuntimeState,
  SyncEvidence,
} from "./types.js";

const ISO_WITH_TIMEZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length && left.every((entry, index) => deepEqual(entry, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) =>
      key === rightKeys[index] && hasOwn(right, key) && deepEqual(left[key], right[key]));
}

function unwrapResult(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (hasOwn(value, "result")) return unwrapResult(value.result);
  if (hasOwn(value, "structuredContent")) return unwrapResult(value.structuredContent);
  if (Array.isArray(value.content)) {
    for (const entry of value.content) {
      if (!isRecord(entry) || typeof entry.text !== "string") continue;
      const parsed = parseJson(entry.text);
      if (parsed !== undefined) return unwrapResult(parsed);
    }
  }
  return value;
}

function resolveJsonPointer(root: unknown, pointer: string): unknown {
  let current = root;
  for (const rawPart of pointer.split("/").filter(Boolean)) {
    if (!isRecord(current)) return undefined;
    const part = rawPart.replace(/~1/g, "/").replace(/~0/g, "~");
    current = current[part];
  }
  return current;
}

function resolveSchemaReference(
  reference: string,
  profile: MvpContractProfile,
): ContractSchema | undefined {
  if (reference.startsWith("#/")) {
    const resolved = resolveJsonPointer(profile, reference.slice(1));
    return isRecord(resolved) ? resolved as ContractSchema : undefined;
  }
  const [schemaPath, pointer = ""] = reference.split("#", 2);
  if (!schemaPath.startsWith("schemas/")) return undefined;
  try {
    const document = loadContractSchema(schemaPath.slice("schemas/".length));
    const resolved = pointer ? resolveJsonPointer(document, pointer) : document;
    return isRecord(resolved) ? resolved as ContractSchema : undefined;
  } catch {
    return undefined;
  }
}

function matchesSchema(
  schema: ContractSchema,
  value: unknown,
  profile: MvpContractProfile,
): boolean {
  if (typeof schema.$ref === "string") {
    const resolved = resolveSchemaReference(schema.$ref, profile);
    return resolved !== undefined && matchesSchema(resolved, value, profile);
  }
  if (Array.isArray(schema.oneOf)) {
    if (schema.oneOf.filter((candidate) => matchesSchema(candidate, value, profile)).length !== 1) {
      return false;
    }
  }
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length > 0 && !types.some((type) => {
    switch (type) {
      case "array": return Array.isArray(value);
      case "boolean": return typeof value === "boolean";
      case "integer": return typeof value === "number" && Number.isInteger(value);
      case "null": return value === null;
      case "number": return typeof value === "number" && Number.isFinite(value);
      case "object": return isRecord(value);
      case "string": return typeof value === "string";
    }
  })) return false;
  if (hasOwn(schema as Record<string, unknown>, "const") && !deepEqual(value, schema.const)) return false;
  if (schema.enum && !schema.enum.some((candidate) => deepEqual(candidate, value))) return false;

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) return false;
    if (schema.pattern !== undefined) {
      try {
        if (!new RegExp(schema.pattern).test(value)) return false;
      } catch {
        return false;
      }
    }
    if (schema.format === "date-time" &&
      (!ISO_WITH_TIMEZONE.test(value) || !Number.isFinite(Date.parse(value)))) return false;
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) return false;
    if (schema.maximum !== undefined && value > schema.maximum) return false;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.uniqueItems && value.some((entry, index) =>
      value.slice(0, index).some((candidate) => deepEqual(candidate, entry)))) return false;
    if (schema.items && !value.every((entry) => matchesSchema(schema.items as ContractSchema, entry, profile))) {
      return false;
    }
  }
  if (isRecord(value)) {
    if (typeof schema.minProperties === "number" && Object.keys(value).length < schema.minProperties) {
      return false;
    }
    if ((schema.required ?? []).some((key) => !hasOwn(value, key))) return false;
    const properties = schema.properties ?? {};
    for (const [key, entry] of Object.entries(value)) {
      const property = properties[key];
      if (property) {
        if (!matchesSchema(property, entry, profile)) return false;
      } else if (schema.additionalProperties === false) {
        return false;
      } else if (isRecord(schema.additionalProperties) &&
        !matchesSchema(schema.additionalProperties as ContractSchema, entry, profile)) {
        return false;
      }
    }
  }
  return true;
}

function successfulOutput(toolName: string, result: unknown): Record<string, unknown> | undefined {
  let profile: MvpContractProfile;
  try {
    profile = loadContractProfile("mvp-v2");
  } catch {
    return undefined;
  }
  const contract = profile.outputContracts[toolName];
  if (!contract) return undefined;
  const unwrapped = unwrapResult(result);
  if (!isRecord(unwrapped)) return undefined;
  if (contract.successEnvelope === "standard") {
    const envelope = profile.outputEnvelopes.standard;
    if (!envelope || !matchesSchema(envelope, unwrapped, profile) ||
      unwrapped.success !== true || !isRecord(unwrapped.data) || unwrapped.error !== null ||
      !matchesSchema(contract.successSchema, unwrapped.data, profile)) {
      return undefined;
    }
    return unwrapped.data;
  }
  return matchesSchema(contract.successSchema, unwrapped, profile) ? unwrapped : undefined;
}

function fieldSelectionProof(result: unknown): FieldSelectionProof | undefined {
  const unwrapped = unwrapResult(result);
  if (validateFieldSelection(unwrapped).length > 0 || !isRecord(unwrapped)) return undefined;
  return {
    fields: structuredClone(unwrapped.fields as Record<string, FieldDefinition>),
    items: structuredClone(unwrapped.items as FieldDefinition[]),
    selected_count: unwrapped.selected_count as number,
  };
}

function currentOrDraft(state: RuntimeState | undefined): RuntimeState {
  return state ?? { phase: "requirement_draft" };
}

function recoveryTrigger(context: ApplyToolResultContext): RecoveryTrigger | "initial" {
  return context.recoveryTrigger ?? "initial";
}

function validSyncEvidence(
  data: Record<string, unknown>,
  at: number,
  trigger: RecoveryTrigger | "initial",
): SyncEvidence | undefined {
  if (
    !nonemptyString(data.inquiry_batch_id) ||
    !Array.isArray(data.inquiry_ids) ||
    !data.inquiry_ids.every(nonemptyString) ||
    !nonemptyString(data.snapshot_id) ||
    !nonemptyString(data.lifecycle_status) ||
    !nonemptyString(data.response_status)
  ) {
    return undefined;
  }
  return {
    at,
    trigger,
    inquiry_batch_id: data.inquiry_batch_id,
    inquiry_ids: [...data.inquiry_ids],
    snapshot_id: data.snapshot_id,
    lifecycle_status: data.lifecycle_status,
    response_status: data.response_status,
  };
}

function applySync(
  current: RuntimeState | undefined,
  params: Record<string, unknown>,
  data: Record<string, unknown>,
  context: ApplyToolResultContext,
): RuntimeState | undefined {
  const evidence = validSyncEvidence(
    data,
    context.nowMs ?? Date.now(),
    recoveryTrigger(context),
  );
  if (!evidence) return current;

  const base: RuntimeState = current ?? {
    phase: "distribution_sync_pending",
    requirement_id: nonemptyString(params.requirement_id) ? params.requirement_id : undefined,
    mcn_recommendation_id: nonemptyString(params.mcn_recommendation_id)
      ? params.mcn_recommendation_id
      : undefined,
  };
  const terminal = evidence.lifecycle_status === "recovered" || evidence.lifecycle_status === "closed";
  let phase = base.phase;

  if (base.phase === "distribution_sync_pending") {
    phase = terminal ? "recovered" : "waiting_return";
  } else if (base.phase === "waiting_return") {
    if (terminal) phase = "recovered";
    else if (context.recoveryTrigger === "manual" || context.recoveryTrigger === "scheduled") {
      phase = "recovering";
    }
  } else if (base.phase === "recovery_sync_pending" && terminal) {
    phase = "recovered";
  } else if (base.phase === "recovered") {
    phase = "recovered";
  }

  return {
    ...base,
    phase,
    requirement_id: base.requirement_id ?? (nonemptyString(params.requirement_id) ? params.requirement_id : undefined),
    mcn_recommendation_id:
      base.mcn_recommendation_id ??
      (nonemptyString(params.mcn_recommendation_id) ? params.mcn_recommendation_id : undefined),
    inquiry_batch_id: evidence.inquiry_batch_id,
    inquiry_ids: evidence.inquiry_ids,
    snapshot_id: evidence.snapshot_id,
    lastSync: evidence,
  };
}

function applySuccessfulResult(
  toolName: string,
  current: RuntimeState | undefined,
  context: ApplyToolResultContext,
): RuntimeState | undefined {
  const output = successfulOutput(toolName, context.result);
  if (!output) return current;

  if (toolName === "select_inquiry_form_fields") {
    const selection = fieldSelectionProof(output);
    if (
      !selection ||
      !current ||
      current.phase !== "mcn_planning" ||
      !nonemptyString(context.params.mcn_recommendation_id) ||
      current.mcn_recommendation_id !== context.params.mcn_recommendation_id
    ) {
      return current;
    }
    return {
      ...current,
      phase: "field_selection_ready",
      mcn_recommendation_id: context.params.mcn_recommendation_id,
      fieldSelection: selection,
    };
  }

  const data = output;

  switch (toolName) {
    case "validate_requirement":
      if (!nonemptyString(data.id) || data.status !== "ready") return current;
      return {
        ...currentOrDraft(current),
        phase: "requirement_ready",
        requirement_id: data.id,
      };
    case "search_creators":
      if (!nonemptyString(data.id) || data.candidate_pool_written !== true) return current;
      return {
        ...currentOrDraft(current),
        phase: "candidate_pool_ready",
        candidate_pool_id: data.id,
      };
    case "rank_mcns":
      if (!nonemptyString(data.id) || !hasOwn(data, "inquiry_advice")) return current;
      return {
        ...currentOrDraft(current),
        phase: "mcn_planning",
        mcn_recommendation_id: data.id,
        fieldSelection: undefined,
        sendConfirmation: undefined,
      };
    case "create_with_distributions":
      if (
        !current ||
        !nonemptyString(data.provider_project_id) ||
        !nonemptyString(data.distribution_batch_ref) ||
        !Array.isArray(data.distributions) ||
        data.distributions.length === 0
      ) {
        return current;
      }
      return {
        ...current,
        phase: "distribution_sync_pending",
        provider_project_id: data.provider_project_id,
        distribution_batch_ref: data.distribution_batch_ref,
      };
    case "sync_mcn_inquiry_status":
      return applySync(current, context.params, data, context);
    case "ingest_mcn_submissions": {
      const trigger = context.params.trigger;
      if (
        !current ||
        (trigger !== "manual" && trigger !== "scheduled") ||
        !nonemptyString(data.id) ||
        !Number.isInteger(data.accepted_count) ||
        !Number.isInteger(data.rejected_count) ||
        !Number.isInteger(data.created_submission_item_count)
      ) {
        return current;
      }
      return {
        ...current,
        phase: "recovery_sync_pending",
        lastIngest: {
          at: context.nowMs ?? Date.now(),
          ingest_batch_id: data.id,
          trigger,
        },
      };
    }
    case "manual_source_creators":
      if (!current || !nonemptyString(data.manual_batch_id) || !Number.isInteger(data.imported_count)) {
        return current;
      }
      return {
        ...current,
        manual_batch_ids: [...(current.manual_batch_ids ?? []), data.manual_batch_id],
      };
    case "rank_creators":
      if (!current || !nonemptyString(data.run_id) || !Number.isInteger(data.ranked_count)) {
        return current;
      }
      return { ...current, phase: "recommendation_ready", run_id: data.run_id };
    case "create_submission_batch":
      if (
        !current ||
        !nonemptyString(data.id) ||
        !Number.isInteger(data.batch_no) ||
        !Number.isInteger(data.submitted_count)
      ) {
        return current;
      }
      return {
        ...current,
        phase: "submission_batch_ready",
        submission_batch_id: data.id,
        batch_no: data.batch_no as number,
      };
    case "record_client_feedback":
      if (!current || !Number.isInteger(data.updated_count) || !nonemptyString(data.next_action)) {
        return current;
      }
      return { ...current, phase: "feedback_routing" };
    default:
      return current;
  }
}

export function applyToolResult(context: ApplyToolResultContext): RuntimeState | undefined {
  if (!nonemptyString(context.sessionKey)) return undefined;
  const toolName = normalizeYpmcnToolName(context.toolName);
  if (!toolName) return context.store.get(context.sessionKey);

  return context.store.update(context.sessionKey, (current) =>
    applySuccessfulResult(toolName, current, context),
  );
}
