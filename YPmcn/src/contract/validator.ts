import { loadContractProfile, loadContractSchema } from "./loader.js";
import type {
  ContractSchema,
  MvpContractProfile,
  SchemaType,
  ToolContract,
  ToolOutputContract,
  ValidationIssue,
} from "./types.js";

const FIELD_DEFINITION_KEYS = ["key", "name", "type", "required"] as const;
const FIELD_SELECTION_REQUIRED_KEYS = ["success", "fields", "items", "selected_count"] as const;
const FIELD_SELECTION_DISPLAY_KEYS = ["url", "message", "description", "output_format"] as const;
const FIELD_SELECTION_KEYS: ReadonlySet<string> = new Set([
  ...FIELD_SELECTION_REQUIRED_KEYS,
  ...FIELD_SELECTION_DISPLAY_KEYS,
]);
const RFC3339_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

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
    required: contract.required,
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
  ];
}

function fieldIssue(path: string, message: string): ValidationIssue {
  return issue("FIELD_SELECTION_INVALID", path, message);
}

function validateFieldDefinition(
  definition: unknown,
  path: string,
  expectedKey?: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isRecord(definition)) {
    return [fieldIssue(path, "Field definition must be an object.")];
  }
  const keys = Object.keys(definition);
  for (const key of FIELD_DEFINITION_KEYS) {
    if (!hasOwn(definition, key)) {
      issues.push(fieldIssue(propertyPath(path, key), "Field definition property is missing."));
    }
  }
  for (const key of keys) {
    if (!(FIELD_DEFINITION_KEYS as readonly string[]).includes(key)) {
      issues.push(fieldIssue(propertyPath(path, key), "Field definition property is not allowed."));
    }
  }
  for (const key of ["key", "name", "type"] as const) {
    if (typeof definition[key] !== "string" || definition[key].length === 0) {
      issues.push(fieldIssue(propertyPath(path, key), "Field definition value must be a nonempty string."));
    }
  }
  if (typeof definition.required !== "boolean") {
    issues.push(fieldIssue(`${path}.required`, "Field required must be a boolean."));
  }
  if (expectedKey !== undefined && definition.key !== expectedKey) {
    issues.push(fieldIssue(`${path}.key`, "Field-map key must match definition.key."));
  }
  return issues;
}

function validateFieldMap(value: unknown): ValidationIssue[] {
  if (!isRecord(value)) return [fieldIssue("$.fields", "Fields must be an object map.")];
  const issues: ValidationIssue[] = [];
  for (const [key, definition] of Object.entries(value)) {
    issues.push(...validateFieldDefinition(definition, propertyPath("$.fields", key), key));
  }
  return issues;
}

function validateOrderedItems(value: unknown): ValidationIssue[] {
  if (!Array.isArray(value)) return [fieldIssue("$.items", "Items must be an array.")];
  const issues: ValidationIssue[] = [];
  const seenKeys = new Set<string>();
  value.forEach((definition, index) => {
    const itemPath = `$.items[${index}]`;
    issues.push(...validateFieldDefinition(definition, itemPath));
    if (isRecord(definition) && typeof definition.key === "string" && definition.key.length > 0) {
      if (seenKeys.has(definition.key)) {
        issues.push(fieldIssue(`${itemPath}.key`, "Item keys must be unique."));
      }
      seenKeys.add(definition.key);
    }
  });
  return issues;
}

export function validateFieldSelection(result: unknown): ValidationIssue[] {
  if (!isRecord(result)) {
    return [fieldIssue("$", "Field-selection result must be an object.")];
  }

  const issues: ValidationIssue[] = [];
  for (const key of FIELD_SELECTION_REQUIRED_KEYS) {
    if (!hasOwn(result, key)) {
      issues.push(fieldIssue(propertyPath("$", key), "Required top-level property is missing."));
    }
  }
  for (const key of Object.keys(result)) {
    if (!FIELD_SELECTION_KEYS.has(key)) {
      issues.push(fieldIssue(propertyPath("$", key), "Top-level property is not allowed."));
    }
  }
  if (result.success !== true) {
    issues.push(fieldIssue("$.success", "Field selection must report success=true."));
  }
  for (const key of FIELD_SELECTION_DISPLAY_KEYS) {
    if (hasOwn(result, key) && typeof result[key] !== "string") {
      issues.push(fieldIssue(propertyPath("$", key), "Display metadata must be a string."));
    }
  }

  issues.push(...validateFieldMap(result.fields));
  issues.push(...validateOrderedItems(result.items));

  if (!isRecord(result.fields) || Object.keys(result.fields).length === 0) {
    issues.push(fieldIssue("$.fields", "Field map must be nonempty."));
  }
  if (!Array.isArray(result.items) || result.items.length === 0) {
    issues.push(fieldIssue("$.items", "Items must be nonempty."));
  }
  if (!Number.isInteger(result.selected_count) || (result.selected_count as number) < 1) {
    issues.push(fieldIssue("$.selected_count", "Selected count must be a positive integer."));
  }
  if (Array.isArray(result.items) && result.selected_count !== result.items.length) {
    issues.push(fieldIssue("$.selected_count", "Selected count must equal items.length."));
  }

  if (isRecord(result.fields) && Array.isArray(result.items)) {
    const fieldMap = result.fields;
    const items = result.items;
    const itemKeys = new Set(
      items
        .filter(isRecord)
        .map((item) => item.key)
        .filter((key): key is string => typeof key === "string"),
    );
    for (const key of Object.keys(fieldMap)) {
      if (!itemKeys.has(key)) {
        issues.push(fieldIssue(propertyPath("$.fields", key), "Field-map key has no matching item."));
      }
    }
    items.forEach((item, index) => {
      if (!isRecord(item) || typeof item.key !== "string") return;
      if (!hasOwn(fieldMap, item.key)) {
        issues.push(fieldIssue(`$.items[${index}].key`, "Item key is missing from the field map."));
        return;
      }
      if (!deepEqual(fieldMap[item.key], item)) {
        issues.push(
          fieldIssue(`$.items[${index}]`, "Field map and item definitions must be identical."),
        );
      }
    });
    if (Object.keys(fieldMap).length !== items.length) {
      issues.push(fieldIssue("$.fields", "Field map and items must contain the same unique keys."));
    }
  }

  return issues;
}

function outputIssue(path: string, message: string): ValidationIssue {
  return issue("SCHEMA_MISMATCH", path, message);
}

function resolveOutputSchemaReference(
  profile: MvpContractProfile,
  reference: string,
): ContractSchema | undefined {
  const outputEnvelopePrefix = "#/outputEnvelopes/";
  if (reference.startsWith(outputEnvelopePrefix)) {
    const name = reference.slice(outputEnvelopePrefix.length);
    return profile.outputEnvelopes[name];
  }
  if (reference === "schemas/workflow-state.schema.json#/properties/identifiers") {
    return loadContractSchema("workflow-state.schema.json").properties?.identifiers;
  }
  return undefined;
}

function isValidDateTime(value: string): boolean {
  const match = RFC3339_DATE_TIME.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  if (
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return false;
  }
  const daysInMonth = month === 2
    ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28)
    : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return day >= 1 && day <= daysInMonth && Number.isFinite(Date.parse(value));
}

function validateOutputSchema(
  profile: MvpContractProfile,
  schema: ContractSchema,
  value: unknown,
  path: string,
): ValidationIssue[] {
  if (schema.$ref !== undefined) {
    const resolved = typeof schema.$ref === "string"
      ? resolveOutputSchemaReference(profile, schema.$ref)
      : undefined;
    return resolved
      ? validateOutputSchema(profile, resolved, value, path)
      : [outputIssue(path, `Output schema reference ${String(schema.$ref)} is unsupported.`)];
  }

  const issues: ValidationIssue[] = [];
  const types = expectedTypes(schema);
  if (types.length > 0 && !types.some((type) => matchesType(value, type))) {
    return [
      outputIssue(
        path,
        `Expected ${types.join(" or ")}; received ${value === null ? "null" : typeof value}.`,
      ),
    ];
  }

  if (hasOwn(schema as Record<string, unknown>, "const") && !deepEqual(value, schema.const)) {
    issues.push(outputIssue(path, "Value does not match the required constant."));
  }
  if (schema.enum && !schema.enum.some((candidate) => deepEqual(candidate, value))) {
    issues.push(outputIssue(path, "Value is not in the approved enum."));
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      issues.push(outputIssue(path, `String must contain at least ${schema.minLength} character(s).`));
    }
    if (schema.pattern !== undefined) {
      try {
        if (!new RegExp(schema.pattern).test(value)) {
          issues.push(outputIssue(path, "String does not match the approved pattern."));
        }
      } catch {
        issues.push(outputIssue(path, "Output schema pattern is invalid."));
      }
    }
    if (schema.format === "date-time" && !isValidDateTime(value)) {
      issues.push(outputIssue(path, "String must be a timezone-qualified date-time."));
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      issues.push(outputIssue(path, `Number must be at least ${schema.minimum}.`));
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      issues.push(outputIssue(path, `Number must be at most ${schema.maximum}.`));
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      issues.push(outputIssue(path, `Array must contain at least ${schema.minItems} item(s).`));
    }
    if (schema.uniqueItems) {
      for (let index = 0; index < value.length; index += 1) {
        if (value.slice(0, index).some((candidate) => deepEqual(candidate, value[index]))) {
          issues.push(outputIssue(`${path}[${index}]`, "Array items must be unique."));
        }
      }
    }
    if (schema.items) {
      value.forEach((item, index) => {
        issues.push(...validateOutputSchema(profile, schema.items as ContractSchema, item, `${path}[${index}]`));
      });
    }
  }
  if (isRecord(value)) {
    if (schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties) {
      issues.push(outputIssue(path, `Object must contain at least ${schema.minProperties} property(ies).`));
    }
    for (const required of schema.required ?? []) {
      if (!hasOwn(value, required)) {
        issues.push(outputIssue(propertyPath(path, required), "Required property is missing."));
      }
    }
    const properties = schema.properties ?? {};
    for (const [key, child] of Object.entries(value)) {
      const childPath = propertyPath(path, key);
      if (hasOwn(properties, key)) {
        issues.push(...validateOutputSchema(profile, properties[key], child, childPath));
      } else if (isRecord(schema.additionalProperties)) {
        issues.push(
          ...validateOutputSchema(profile, schema.additionalProperties, child, childPath),
        );
      } else if (schema.additionalProperties === false) {
        issues.push(outputIssue(childPath, "Property is not declared by the output contract."));
      }
    }
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter(
      (candidate) => validateOutputSchema(profile, candidate, value, path).length === 0,
    ).length;
    if (matches !== 1) {
      issues.push(outputIssue(path, "Value must match exactly one approved output variant."));
    }
  }
  return issues;
}

function validateStandardToolOutput(
  profile: MvpContractProfile,
  contract: ToolOutputContract,
  result: unknown,
): ValidationIssue[] {
  const envelopeName = isRecord(result) && result.success === true
    ? contract.successEnvelope
    : contract.failureEnvelope;
  const envelope = profile.outputEnvelopes[envelopeName];
  if (!envelope) {
    return [outputIssue("$", `Output envelope ${envelopeName} is unavailable.`)];
  }
  const issues = validateOutputSchema(profile, envelope, result, "$");
  if (!isRecord(result)) return issues;

  if (result.success === true) {
    return [
      ...issues,
      ...validateOutputSchema(profile, contract.successSchema, result.data, "$.data"),
    ];
  }
  if (result.success === false && isRecord(result.error)) {
    const code = result.error.code;
    if (typeof code !== "string" || !contract.errorCodes.includes(code as never)) {
      issues.push(outputIssue("$.error.code", "Error code is not declared for this tool."));
    }
  }
  return issues;
}

/**
 * Validate a normalized MCP result against the approved per-tool output
 * contract. Transport wrappers are intentionally not accepted here; callers
 * must unwrap only their known Hook transport envelope before validation.
 */
export function validateToolOutput(tool: string, result: unknown): ValidationIssue[] {
  const profile = loadTargetProfile();
  if (!profile) {
    return [issue("INTEGRATION_REQUIRED", "$.profile", "The target contract profile is unavailable.")];
  }
  const contract = hasOwn(profile.outputContracts, tool)
    ? profile.outputContracts[tool]
    : undefined;
  if (!contract) {
    return [
      issue(
        "INTEGRATION_REQUIRED",
        "$.tool",
        `Tool ${String(tool)} is not declared by the target output contract.`,
      ),
    ];
  }
  if (contract.successEnvelope === "top-level-field-selection" && isRecord(result) && result.success === true) {
    return [
      ...validateOutputSchema(
        profile,
        profile.outputEnvelopes[contract.successEnvelope],
        result,
        "$",
      ),
      ...validateFieldSelection(result),
    ];
  }
  return validateStandardToolOutput(profile, contract, result);
}
