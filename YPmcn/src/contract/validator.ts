import { loadContractProfile } from "./loader.js";
import type {
  ContractSchema,
  MvpContractProfile,
  SchemaType,
  ToolContract,
  ValidationIssue,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function propertyPath(path: string, key: string): string {
  return `${path}.${key}`;
}

function issue(
  code: ValidationIssue["code"],
  path: string,
  message: string,
): ValidationIssue {
  return { code, path, message };
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => deepEqual(value, right[index]))
    );
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && hasOwn(right, key) && deepEqual(left[key], right[key]),
    )
  );
}

function matchesType(value: unknown, type: SchemaType): boolean {
  switch (type) {
    case "array":
      return Array.isArray(value);
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
    case "null":
      return value === null;
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "object":
      return isRecord(value);
    case "string":
      return typeof value === "string";
  }
}

function expectedTypes(schema: ContractSchema): SchemaType[] {
  if (schema.type === undefined) return [];
  return Array.isArray(schema.type) ? schema.type : [schema.type];
}

function collectSchemaMismatches(
  schema: ContractSchema,
  value: unknown,
  path: string,
  strictUnknown = false,
  forbidden = new Set<string>(),
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => {
      issues.push(...collectSchemaMismatches(schema.items as ContractSchema, item, `${path}[${index}]`));
    });
    return issues;
  }

  if (!isRecord(value)) return issues;
  const properties = schema.properties ?? {};
  for (const key of Object.keys(value)) {
    const childPath = propertyPath(path, key);
    if (forbidden.has(key)) {
      issues.push(
        issue("SCHEMA_MISMATCH", childPath, `Property ${key} is forbidden by the target contract.`),
      );
      continue;
    }
    if (hasOwn(properties, key)) {
      issues.push(...collectSchemaMismatches(properties[key], value[key], childPath));
      continue;
    }
    if (isRecord(schema.additionalProperties)) {
      issues.push(...collectSchemaMismatches(schema.additionalProperties, value[key], childPath));
      continue;
    }
    if (strictUnknown || schema.additionalProperties === false) {
      issues.push(
        issue("SCHEMA_MISMATCH", childPath, `Property ${key} is not declared by the target contract.`),
      );
    }
  }
  return issues;
}

function validateSchema(schema: ContractSchema, value: unknown, path: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (schema.anyOf) {
    const matched = schema.anyOf.some((candidate) => validateSchema(candidate, value, path).length === 0);
    if (!matched) {
      return [issue("INVALID_INPUT", path, "Value does not match any allowed schema alternative.")];
    }
  }
  const types = expectedTypes(schema);
  if (types.length > 0 && !types.some((type) => matchesType(value, type))) {
    return [
      issue(
        "INVALID_INPUT",
        path,
        `Expected ${types.join(" or ")}; received ${value === null ? "null" : typeof value}.`,
      ),
    ];
  }

  if (hasOwn(schema as Record<string, unknown>, "const") && !deepEqual(value, schema.const)) {
    issues.push(issue("INVALID_INPUT", path, "Value does not match the required constant."));
  }
  if (schema.enum && !schema.enum.some((candidate) => deepEqual(candidate, value))) {
    issues.push(issue("INVALID_INPUT", path, "Value is not in the approved enum."));
  }

  if (typeof value === "string" && schema.minLength !== undefined && value.length < schema.minLength) {
    issues.push(
      issue("INVALID_INPUT", path, `String must contain at least ${schema.minLength} character(s).`),
    );
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      issues.push(issue("INVALID_INPUT", path, `Number must be at least ${schema.minimum}.`));
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      issues.push(issue("INVALID_INPUT", path, `Number must be at most ${schema.maximum}.`));
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      issues.push(
        issue("INVALID_INPUT", path, `Array must contain at least ${schema.minItems} item(s).`),
      );
    }
    if (schema.uniqueItems) {
      for (let index = 0; index < value.length; index += 1) {
        if (value.slice(0, index).some((candidate) => deepEqual(candidate, value[index]))) {
          issues.push(
            issue("INVALID_INPUT", `${path}[${index}]`, "Array items must be unique."),
          );
        }
      }
    }
    if (schema.items) {
      value.forEach((item, index) => {
        issues.push(...validateSchema(schema.items as ContractSchema, item, `${path}[${index}]`));
      });
    }
  }

  if (isRecord(value)) {
    for (const required of schema.required ?? []) {
      if (!hasOwn(value, required)) {
        issues.push(
          issue("INVALID_INPUT", propertyPath(path, required), "Required property is missing."),
        );
      }
    }
    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (hasOwn(value, key)) {
        issues.push(...validateSchema(propertySchema, value[key], propertyPath(path, key)));
      }
    }
    if (isRecord(schema.additionalProperties)) {
      for (const key of Object.keys(value)) {
        if (!hasOwn(schema.properties ?? {}, key)) {
          issues.push(
            ...validateSchema(schema.additionalProperties, value[key], propertyPath(path, key)),
          );
        }
      }
    }
  }

  return issues;
}

function validateAlternatives(contract: ToolContract, params: Record<string, unknown>): ValidationIssue[] {
  if (contract.alternativeMode !== "exactly-one" || !contract.requiredAlternatives) return [];

  const active = contract.requiredAlternatives.filter((alternative) =>
    alternative.some((key) => hasOwn(params, key)),
  );
  const isComplete = active.length === 1 && active[0].every((key) => hasOwn(params, key));
  if (isComplete) return [];
  return [
    issue(
      "INVALID_INPUT",
      "$",
      `Exactly one complete identifier alternative is required: ${contract.requiredAlternatives
        .map((alternative) => alternative.join(" + "))
        .join(" or ")}.`,
    ),
  ];
}

function validateInputModes(
  contract: ToolContract,
  params: Record<string, unknown>,
): ValidationIssue[] {
  if (!contract.inputModes) return [];

  const matchedModes = Object.entries(contract.inputModes.modes)
    .filter(([, mode]) => mode.matchAny.some((key) => hasOwn(params, key)))
    .map(([name]) => name);
  if (matchedModes.length > 0) return [];

  return [
    issue(
      "INVALID_INPUT",
      "$",
      `At least one declared input mode must match: ${Object.keys(
        contract.inputModes.modes,
      ).join(" or ")}.`,
    ),
  ];
}

function loadTargetProfile(): MvpContractProfile | undefined {
  try {
    const profile = loadContractProfile("mvp-v2");
    return profile.profile === "mvp-v2" ? profile : undefined;
  } catch {
    return undefined;
  }
}

function validateSemanticRequirements(
  tool: string,
  params: Record<string, unknown>,
): ValidationIssue[] {
  if (tool === "get_workflow_state") {
    const traceMode = typeof params.trace_id === "string" && params.trace_id.trim().length > 0;
    const demandMode = typeof params.demand_id === "string" && params.demand_id.trim().length > 0 &&
      Number.isInteger(params.demand_version);
    if (traceMode !== demandMode) return [];
    return [issue(
      "INVALID_INPUT",
      "$",
      "Provide exactly one lookup mode: trace_id, or demand_id with demand_version.",
    )];
  }
  if (tool === "create_with_distributions") {
    if (Array.isArray(params.columns)) {
      for (let index = 0; index < params.columns.length; index += 1) {
        const column = params.columns[index];
        if (isRecord(column) &&
          (typeof column.key !== "string" || column.key.trim().length === 0)) {
          return [issue(
            "INVALID_INPUT",
            `$.columns[${index}].key`,
            "Each column must contain a non-empty key.",
          )];
        }
      }
    }
    if (typeof params.description !== "string" || params.description.trim().length === 0) {
      return [issue("INVALID_INPUT", "$.description", "description must be a non-empty plain-text WeChat message.")];
    }
    const trimmed = params.description.trim();
    if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
      return [issue("INVALID_INPUT", "$.description", "description must be direct plain text, not a code block.")];
    }
    try {
      JSON.parse(trimmed);
      return [issue("INVALID_INPUT", "$.description", "description must be direct plain text, not JSON.")];
    } catch {
      return [];
    }
  }
  if (tool === "sync_mcn_inquiry_status") {
    for (const key of ["requirement_id", "project_id"] as const) {
      const value = params[key];
      if (typeof value !== "string" || value.trim().length === 0 || value.trim() === "0") {
        return [issue("INVALID_INPUT", `$.${key}`, `${key} must not be empty or a placeholder ID.`)];
      }
    }
    if (!Array.isArray(params.supplierIds) || params.supplierIds.length === 0) {
      return [issue("INVALID_INPUT", "$.supplierIds", "supplierIds must contain at least one supplier ID.")];
    }
    for (let index = 0; index < params.supplierIds.length; index += 1) {
      const value = params.supplierIds[index];
      if (typeof value !== "string" || value.trim().length === 0 || value.trim() === "0") {
        return [issue(
          "INVALID_INPUT",
          `$.supplierIds[${index}]`,
          "supplierIds must not contain empty or placeholder IDs.",
        )];
      }
    }
  }
  if (tool === "get_recommendation_run_detail") {
    if (typeof params.run_id === "string" && /^[1-9]\d*$/.test(params.run_id)) return [];
    return [issue("INVALID_INPUT", "$.run_id", "run_id must represent a positive integer.")];
  }
  return [];
}

export function validateToolParams(
  tool: string,
  params: unknown,
  profileName = "mvp-v2",
): ValidationIssue[] {
  if (profileName !== "mvp-v2" && profileName !== "legacy-1.9.4") {
    return [
      issue(
        "INTEGRATION_REQUIRED",
        "$.profile",
        `Profile ${String(profileName)} is unsupported and cannot authorize execution.`,
      ),
    ];
  }
  if (profileName === "legacy-1.9.4") {
    return [
      issue(
        "INTEGRATION_REQUIRED",
        "$.profile",
        "The legacy profile is detection-only and cannot authorize execution.",
      ),
    ];
  }

  const profile = loadTargetProfile();
  if (!profile) {
    return [
      issue("INTEGRATION_REQUIRED", "$.profile", "The target contract profile is unavailable."),
    ];
  }
  const contract =
    typeof tool === "string" && hasOwn(profile.tools, tool)
      ? profile.tools[tool]
      : undefined;
  if (!contract) {
    return [
      issue(
        "INTEGRATION_REQUIRED",
        "$.tool",
        `Tool ${String(tool)} is not declared by the target contract.`,
      ),
    ];
  }
  if (!isRecord(params)) {
    return [issue("INVALID_INPUT", "$", "Tool parameters must be an object.")];
  }

  const rootSchema: ContractSchema = {
    type: "object",
    required: [...new Set([...contract.required, ...(contract.agentRequired ?? [])])],
    properties: contract.properties,
  };
  const mismatches = collectSchemaMismatches(
    rootSchema,
    params,
    "$",
    true,
    new Set(contract.forbidden),
  );
  if (mismatches.length > 0) return mismatches;

  return [
    ...validateInputModes(contract, params),
    ...validateAlternatives(contract, params),
    ...validateSchema(rootSchema, params, "$"),
    ...validateSemanticRequirements(tool, params),
  ];
}

export function parseFieldSelectionDescription(description: unknown): string[] | undefined {
  if (typeof description !== "string" || description.trim().length === 0) return undefined;
  const fieldNames: string[] = [];
  for (const rawLine of description.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^([^：:]+)[：:]\s*(.+)$/.exec(line);
    if (!match) return undefined;
    const fieldName = match[1].trim();
    if (!fieldName || fieldNames.includes(fieldName)) return undefined;
    fieldNames.push(fieldName);
  }
  return fieldNames.length > 0 ? fieldNames : undefined;
}
