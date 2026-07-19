import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import type {
  ContractSchemaDocument,
  ContractProfile,
  ContractProfileName,
  DatabaseContract,
  ErrorCatalog,
  LegacyContractProfile,
  LegacyObservedToolContract,
  MvpContractProfile,
  RequirementDictionary,
  RequirementsContract,
  ToolContract,
  ToolOutputContract,
  WorkflowContract,
} from "./types.js";

const PROFILE_FILES: Record<ContractProfileName, string> = {
  "mvp-v2": "mcp.json",
  "legacy-1.9.4": "profiles/legacy-1.9.4.json",
};

const SCHEMA_FILES = new Set([
  "constraint-expression.schema.json",
  "domain-records.schema.json",
  "requirement-record.schema.json",
  "requirement-snapshot.schema.json",
  "workflow-state.schema.json",
]);

const profileCache = new Map<ContractProfileName, ContractProfile>();
let workflowCache: WorkflowContract | undefined;
let databaseCache: DatabaseContract | undefined;
let errorCache: ErrorCatalog | undefined;
let requirementDictionaryCache: RequirementDictionary | undefined;
let requirementsCache: RequirementsContract | undefined;
const schemaCache = new Map<string, ContractSchemaDocument>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function readSpec(relativePath: string): unknown {
  const specUrl = [
    new URL(`../../../spec/${relativePath}`, import.meta.url),
    new URL(`../../spec/${relativePath}`, import.meta.url),
  ].find((candidate) => existsSync(candidate));
  if (!specUrl) {
    throw new Error(`approved spec is missing: ${relativePath}`);
  }
  return JSON.parse(readFileSync(specUrl, "utf8")) as unknown;
}

function readSchema(relativePath: string): unknown {
  if (!SCHEMA_FILES.has(relativePath)) {
    throw new Error(`unsupported contract schema: ${relativePath}`);
  }
  const schemaUrl = [
    new URL(`../../../spec/schemas/${relativePath}`, import.meta.url),
    new URL(`../../spec/schemas/${relativePath}`, import.meta.url),
  ].find((candidate) => existsSync(candidate));
  if (!schemaUrl) throw new Error(`contract schema is missing: ${relativePath}`);
  return JSON.parse(readFileSync(schemaUrl, "utf8")) as unknown;
}

function canonicalizeJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(value[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("contract value is not JSON-like");
  return encoded;
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalizeJson(value), "utf8").digest("hex");
}

function requireUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} must not contain duplicates`);
  }
}

function requireExactStrings(value: unknown, expected: string[], label: string): string[] {
  if (!isStringArray(value) || JSON.stringify(value) !== JSON.stringify(expected)) {
    throw new Error(`${label} must match the approved ordered values`);
  }
  return value;
}

function validateOutputEnvelopes(value: unknown): Record<string, unknown> {
  const envelopes = requireRecord(value, "mvp-v2.outputEnvelopes");
  requireExactStrings(
    Object.keys(envelopes),
    ["observed-runtime"],
    "mvp-v2.outputEnvelopes keys",
  );
  const observed = requireRecord(
    envelopes["observed-runtime"],
    "mvp-v2.outputEnvelopes.observed-runtime",
  );
  if (
    observed.contractStatus !== "not-advertised" ||
    typeof observed.observationBasis !== "string" ||
    observed.type !== "object" ||
    observed.additionalProperties !== true
  ) {
    throw new Error("mvp-v2 observed runtime envelope must remain permissive and non-advertised");
  }
  const properties = requireRecord(
    observed.properties,
    "mvp-v2.outputEnvelopes.observed-runtime.properties",
  );
  requireExactStrings(
    Object.keys(properties),
    ["success", "trace_id", "data", "error", "workflow_state", "allowed_actions"],
    "mvp-v2.outputEnvelopes.observed-runtime.properties keys",
  );
  return envelopes;
}

function validateExternalSchemaReferences(value: unknown, label: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateExternalSchemaReferences(entry, `${label}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  if (hasOwn(value, "$ref")) {
    if (typeof value.$ref !== "string") throw new Error(`${label}.$ref must be a string`);
    if (value.$ref.startsWith("schemas/")) resolveRecordSchema(value.$ref, `${label}.$ref`);
    else if (!value.$ref.startsWith("#/")) throw new Error(`${label}.$ref is unsupported`);
  }
  for (const [key, child] of Object.entries(value)) {
    if (key !== "$ref") validateExternalSchemaReferences(child, `${label}.${key}`);
  }
}

function validateToolMapKeys(
  tools: Record<string, unknown>,
  expectedNames: string[],
  label: string,
): void {
  const expected = new Set(expectedNames);
  for (const name of expectedNames) {
    if (!hasOwn(tools, name)) throw new Error(`${label}.${name} is missing`);
  }
  for (const name of Object.keys(tools)) {
    if (!expected.has(name)) throw new Error(`${label}.${name} is not declared`);
  }
}

function validateCommonTool(rawTool: unknown, name: string, label: string): Record<string, unknown> {
  const tool = requireRecord(rawTool, `${label}.${name}`);
  if (tool.name !== name) throw new Error(`${label}.${name}.name must match its key`);
  if (!isStringArray(tool.required)) {
    throw new Error(`${label}.${name}.required must be a string array`);
  }
  requireRecord(tool.properties, `${label}.${name}.properties`);
  return tool;
}

function validateServerIdentity(value: unknown, toolNames: string[]): void {
  const identity = requireRecord(value, "mvp-v2.serverIdentity");
  const expectedKeys = new Set([
    "canonicalNamespace",
    "hostQualifiedToolName",
    "providerToolsList",
    "excludedNamespaces",
  ]);
  for (const key of expectedKeys) {
    if (!hasOwn(identity, key)) throw new Error(`mvp-v2.serverIdentity.${key} is missing`);
  }
  for (const key of Object.keys(identity)) {
    if (!expectedKeys.has(key)) throw new Error(`mvp-v2.serverIdentity.${key} is not declared`);
  }
  if (identity.canonicalNamespace !== "ypmcn") {
    throw new Error("mvp-v2.serverIdentity.canonicalNamespace must be ypmcn");
  }

  const host = requireRecord(
    identity.hostQualifiedToolName,
    "mvp-v2.serverIdentity.hostQualifiedToolName",
  );
  if (
    host.format !== "mcp__ypmcn__<contract-tool>" ||
    host.pattern !== `^mcp__ypmcn__(?:${toolNames.join("|")})$` ||
    host.businessToolIdentity !== "exact-qualified-name-and-contract-tool" ||
    host.bareHookEvent !== "not-a-business-tool"
  ) {
    throw new Error("mvp-v2 server identity must use exact Host-qualified contract tool names");
  }

  const providerToolsList = requireRecord(
    identity.providerToolsList,
    "mvp-v2.serverIdentity.providerToolsList",
  );
  if (
    providerToolsList.toolNameFormat !== "bare-contract-tool" ||
    providerToolsList.namespace !== "not-applicable" ||
    providerToolsList.businessToolIdentity !== "catalog-membership-only"
  ) {
    throw new Error("mvp-v2 provider tools/list names must remain bare contract tool names");
  }
  requireExactStrings(
    identity.excludedNamespaces,
    ["vector-mcp"],
    "mvp-v2.serverIdentity.excludedNamespaces",
  );
}

function validateInputModes(
  value: unknown,
  properties: Record<string, unknown>,
  label: string,
): void {
  const inputModes = requireRecord(value, label);
  const expectedPolicyKeys = new Set(["policy", "allowMultiple", "modes"]);
  for (const key of expectedPolicyKeys) {
    if (!hasOwn(inputModes, key)) throw new Error(`${label}.${key} is missing`);
  }
  for (const key of Object.keys(inputModes)) {
    if (!expectedPolicyKeys.has(key)) {
      throw new Error(`${label}.${key} is not declared`);
    }
  }
  if (inputModes.policy !== "at-least-one") {
    throw new Error(`${label}.policy must be at-least-one`);
  }
  if (inputModes.allowMultiple !== true) {
    throw new Error(`${label}.allowMultiple must be true`);
  }

  const modes = requireRecord(inputModes.modes, `${label}.modes`);
  if (Object.keys(modes).length === 0) {
    throw new Error(`${label}.modes must not be empty`);
  }
  for (const [name, rawMode] of Object.entries(modes)) {
    if (name.length === 0) throw new Error(`${label}.modes has an empty name`);
    const mode = requireRecord(rawMode, `${label}.modes.${name}`);
    if (!hasOwn(mode, "matchAny")) {
      throw new Error(`${label}.modes.${name}.matchAny is missing`);
    }
    for (const key of Object.keys(mode)) {
      if (key !== "matchAny") {
        throw new Error(`${label}.modes.${name}.${key} is not declared`);
      }
    }
    if (!isStringArray(mode.matchAny) || mode.matchAny.length === 0) {
      throw new Error(`${label}.modes.${name}.matchAny must be a nonempty string array`);
    }
    requireUnique(mode.matchAny, `${label}.modes.${name}.matchAny`);
    for (const property of mode.matchAny) {
      if (!hasOwn(properties, property)) {
        throw new Error(
          `${label}.modes.${name}.matchAny references undeclared property ${property}`,
        );
      }
    }
  }
}

function validateWritableToolMap(
  value: unknown,
  expectedNames: string[],
  label: string,
): Record<string, ToolContract> {
  const tools = requireRecord(value, label);
  validateToolMapKeys(tools, expectedNames, label);
  for (const [name, rawTool] of Object.entries(tools)) {
    const tool = validateCommonTool(rawTool, name, label);
    const properties = requireRecord(tool.properties, `${label}.${name}.properties`);
    if (!isStringArray(tool.forbidden)) {
      throw new Error(`${label}.${name}.forbidden must be a string array`);
    }
    if (hasOwn(tool, "inputModes")) {
      validateInputModes(tool.inputModes, properties, `${label}.${name}.inputModes`);
    }
  }
  return tools as unknown as Record<string, ToolContract>;
}

function validateOutputContractMap(
  value: unknown,
  tools: Record<string, ToolContract>,
  expectedNames: string[],
  outputEnvelopes: Record<string, unknown>,
  label: string,
): Record<string, ToolOutputContract> {
  const contracts = requireRecord(value, label);
  validateToolMapKeys(contracts, expectedNames, label);
  for (const [name, rawContract] of Object.entries(contracts)) {
    const contract = requireRecord(rawContract, `${label}.${name}`);
    const expectedKeys = new Set([
      "advertisedOutputSchema",
      "evidenceBasis",
      "successEnvelope",
      "failureEnvelope",
      "successSchema",
      "errorCodes",
    ]);
    for (const key of expectedKeys) {
      if (!hasOwn(contract, key)) throw new Error(`${label}.${name}.${key} is missing`);
    }
    for (const key of Object.keys(contract)) {
      if (!expectedKeys.has(key)) throw new Error(`${label}.${name}.${key} is not declared`);
    }
    if (
      typeof contract.successEnvelope !== "string" ||
      !hasOwn(outputEnvelopes, contract.successEnvelope)
    ) {
      throw new Error(`${label}.${name}.successEnvelope is not declared`);
    }
    if (
      typeof contract.failureEnvelope !== "string" ||
      !hasOwn(outputEnvelopes, contract.failureEnvelope)
    ) {
      throw new Error(`${label}.${name}.failureEnvelope is not declared`);
    }
    if (contract.successEnvelope !== tools[name]?.outputEnvelope) {
      throw new Error(`${label}.${name}.successEnvelope must match the tool outputEnvelope`);
    }
    const successSchema = requireRecord(
      contract.successSchema,
      `${label}.${name}.successSchema`,
    );
    if (typeof successSchema.$ref === "string") {
      if (!successSchema.$ref.startsWith("#/outputEnvelopes/")) {
        throw new Error(`${label}.${name}.successSchema has an unsupported $ref`);
      }
      const envelopeName = successSchema.$ref.slice("#/outputEnvelopes/".length);
      if (!hasOwn(outputEnvelopes, envelopeName)) {
        throw new Error(`${label}.${name}.successSchema references an unknown envelope`);
      }
    } else {
      if (successSchema.type !== "object") {
        throw new Error(`${label}.${name}.successSchema must describe an object`);
      }
      if (successSchema.additionalProperties !== true) {
        throw new Error(`${label}.${name}.successSchema must remain permissive`);
      }
    }
    if (
      contract.advertisedOutputSchema !== false ||
      typeof contract.evidenceBasis !== "string" ||
      contract.evidenceBasis.length === 0
    ) {
      throw new Error(`${label}.${name} must mark outputs as non-advertised observations`);
    }
    if (!isStringArray(contract.errorCodes)) {
      throw new Error(`${label}.${name}.errorCodes must be a string array`);
    }
    requireUnique(contract.errorCodes, `${label}.${name}.errorCodes`);
  }
  return contracts as unknown as Record<string, ToolOutputContract>;
}

function validateLegacyToolMap(
  value: unknown,
  expectedNames: string[],
  label: string,
): Record<string, LegacyObservedToolContract> {
  const tools = requireRecord(value, label);
  validateToolMapKeys(tools, expectedNames, label);
  for (const [name, rawTool] of Object.entries(tools)) {
    const tool = validateCommonTool(rawTool, name, label);
    const expectedToolKeys = new Set([
      "name",
      "required",
      "properties",
      "capability",
      "executable",
      "writerAuthorization",
      "writers",
    ]);
    for (const key of expectedToolKeys) {
      if (!hasOwn(tool, key)) throw new Error(`${label}.${name}.${key} is missing`);
    }
    for (const key of Object.keys(tool)) {
      if (!expectedToolKeys.has(key)) {
        throw new Error(`${label}.${name}.${key} is not declared`);
      }
    }
    if (tool.capability !== "detection-only") {
      throw new Error(`${label}.${name}.capability must be detection-only`);
    }
    if (tool.executable !== false) {
      throw new Error(`${label}.${name}.executable must be false`);
    }
    if (tool.writerAuthorization !== "none") {
      throw new Error(`${label}.${name}.writerAuthorization must be none`);
    }
    const writers = requireRecord(tool.writers, `${label}.${name}.writers`);
    for (const key of ["always", "conditional"]) {
      if (!hasOwn(writers, key)) throw new Error(`${label}.${name}.writers.${key} is missing`);
    }
    for (const key of Object.keys(writers)) {
      if (key !== "always" && key !== "conditional") {
        throw new Error(`${label}.${name}.writers.${key} is not declared`);
      }
    }
    if (!isStringArray(writers.always) || !isStringArray(writers.conditional)) {
      throw new Error(`${label}.${name}.writers must contain string arrays`);
    }
    if (writers.always.length > 0 || writers.conditional.length > 0) {
      throw new Error(`${label}.${name} cannot authorize writers`);
    }
  }
  return tools as unknown as Record<string, LegacyObservedToolContract>;
}

function validateMvpProfile(value: unknown): MvpContractProfile {
  const profile = requireRecord(value, "mvp-v2 profile");
  if (profile.schemaVersion !== 1 || profile.profile !== "mvp-v2" || profile.mode !== "writable") {
    throw new Error("mvp-v2 profile identity is invalid");
  }
  if (!isStringArray(profile.requiredTools) || !isStringArray(profile.optionalTools)) {
    throw new Error("mvp-v2 tool lists must be string arrays");
  }
  requireUnique(profile.requiredTools, "mvp-v2.requiredTools");
  requireUnique(profile.optionalTools, "mvp-v2.optionalTools");
  const required = new Set(profile.requiredTools);
  for (const name of profile.optionalTools) {
    if (required.has(name)) {
      throw new Error(`mvp-v2 tool ${name} cannot be both required and optional`);
    }
  }
  const expectedNames = [...profile.requiredTools, ...profile.optionalTools];
  validateServerIdentity(profile.serverIdentity, expectedNames);
  const tools = validateWritableToolMap(
    profile.tools,
    expectedNames,
    "mvp-v2.tools",
  );
  const outputEnvelopes = validateOutputEnvelopes(profile.outputEnvelopes);
  validateOutputContractMap(
    profile.outputContracts,
    tools,
    expectedNames,
    outputEnvelopes,
    "mvp-v2.outputContracts",
  );
  validateExternalSchemaReferences(profile.tools, "mvp-v2.tools");
  validateExternalSchemaReferences(profile.outputContracts, "mvp-v2.outputContracts");
  requireExactStrings(
    tools.select_inquiry_form_fields?.required,
    [],
    "mvp-v2.tools.select_inquiry_form_fields.required",
  );
  return profile as unknown as MvpContractProfile;
}

function validateLegacyProfile(value: unknown): LegacyContractProfile {
  const profile = requireRecord(value, "legacy profile");
  if (
    profile.schemaVersion !== 1 ||
    profile.profile !== "legacy-1.9.4" ||
    profile.mode !== "detection-only" ||
    profile.writable !== false ||
    profile.automaticFallback !== false
  ) {
    throw new Error("legacy profile identity is invalid");
  }
  if (profile.targetProfile !== "mvp-v2") {
    throw new Error("legacy targetProfile must be mvp-v2");
  }
  const summary = requireRecord(profile.observedSummary, "legacy.observedSummary");
  if (!isStringArray(summary.toolNames)) {
    throw new Error("legacy observed tool names must be a string array");
  }
  requireUnique(summary.toolNames, "legacy.observedSummary.toolNames");
  validateLegacyToolMap(
    summary.tools,
    summary.toolNames,
    "legacy.observedSummary.tools",
  );
  return profile as unknown as LegacyContractProfile;
}

function cloneJsonDocument(value: unknown): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("Contract profile document must be JSON-like");
  }
  if (serialized === undefined) {
    throw new Error("Contract profile document must be JSON-like");
  }
  return JSON.parse(serialized) as unknown;
}

export function validateContractProfileDocument(
  name: "mvp-v2",
  value: unknown,
): MvpContractProfile;
export function validateContractProfileDocument(
  name: "legacy-1.9.4",
  value: unknown,
): LegacyContractProfile;
export function validateContractProfileDocument(
  name: ContractProfileName,
  value: unknown,
): ContractProfile;
export function validateContractProfileDocument(
  name: ContractProfileName,
  value: unknown,
): ContractProfile {
  if (!isProfileName(name)) {
    throw new Error(`Unsupported contract profile: ${String(name)}`);
  }
  const snapshot = cloneJsonDocument(value);
  const validated = name === "mvp-v2"
    ? validateMvpProfile(snapshot)
    : validateLegacyProfile(snapshot);
  return deepFreeze(validated);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function isProfileName(name: unknown): name is ContractProfileName {
  return name === "mvp-v2" || name === "legacy-1.9.4";
}

export function loadContractProfile(name: "mvp-v2"): MvpContractProfile;
export function loadContractProfile(name: "legacy-1.9.4"): LegacyContractProfile;
export function loadContractProfile(name: ContractProfileName): ContractProfile;
export function loadContractProfile(name: string): ContractProfile;
export function loadContractProfile(name: string): ContractProfile {
  if (!isProfileName(name)) throw new Error(`Unsupported contract profile: ${String(name)}`);
  const cached = profileCache.get(name);
  if (cached) return cached;

  const parsed = readSpec(PROFILE_FILES[name]);
  const validated = validateContractProfileDocument(name, parsed);
  if (validated.profile === "mvp-v2") {
    const knownCodes = new Set(loadErrorCatalog().codes);
    for (const [toolName, output] of Object.entries(validated.outputContracts)) {
      for (const code of output.errorCodes) {
        if (!knownCodes.has(code)) {
          throw new Error(`mvp-v2.outputContracts.${toolName} references unknown error ${code}`);
        }
      }
    }
  }
  const frozen = deepFreeze(validated);
  profileCache.set(name, frozen);
  return frozen;
}

export function loadContractSchema(relativePath: string): ContractSchemaDocument {
  const cached = schemaCache.get(relativePath);
  if (cached) return cached;
  const value = requireRecord(readSchema(relativePath), `schema ${relativePath}`);
  if (value.$schema !== "https://json-schema.org/draft/2020-12/schema") {
    throw new Error(`schema ${relativePath} must use JSON Schema draft 2020-12`);
  }
  if (
    typeof value.$id !== "string" ||
    !value.$id.endsWith(`/schemas/${relativePath}`)
  ) {
    throw new Error(`schema ${relativePath} has an invalid $id`);
  }
  if (typeof value.title !== "string" || value.title.length === 0) {
    throw new Error(`schema ${relativePath} must have a title`);
  }
  const frozen = deepFreeze(value as unknown as ContractSchemaDocument);
  schemaCache.set(relativePath, frozen);
  return frozen;
}

export function loadRequirementDictionary(): RequirementDictionary {
  if (requirementDictionaryCache) return requirementDictionaryCache;
  const value = requireRecord(readSpec("requirement-dictionary.json"), "requirement dictionary");
  if (value.schemaVersion !== 1 || value.profile !== "mvp-v2") {
    throw new Error("requirement dictionary identity is invalid");
  }
  if (
    typeof value.dictionaryVersion !== "string" ||
    value.dictionaryVersion.length === 0 ||
    value.dictionaryHashAlgorithm !== "sha256" ||
    value.dictionaryHashCanonicalization !== "recursive-key-sort-json-v1" ||
    value.dictionaryHashScope !== "definitions" ||
    typeof value.dictionaryHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.dictionaryHash)
  ) {
    throw new Error("requirement dictionary version or hash metadata is invalid");
  }

  const contentPolicy = requireRecord(value.contentPolicy, "requirement dictionary contentPolicy");
  if (contentPolicy.containsCustomerContent !== false) {
    throw new Error("requirement dictionary must not contain customer content");
  }
  if (
    !isStringArray(contentPolicy.allowedContent) ||
    !isStringArray(contentPolicy.forbiddenContent) ||
    contentPolicy.forbiddenContent.length === 0
  ) {
    throw new Error("requirement dictionary contentPolicy is incomplete");
  }

  const definitions = requireRecord(value.definitions, "requirement dictionary definitions");
  if (Object.keys(definitions).length === 0) {
    throw new Error("requirement dictionary definitions must not be empty");
  }
  const allowedDefinitionKeys = new Set([
    "type",
    "classification",
    "enum",
    "description",
    "unit",
    "minimum",
    "maximum",
    "format",
    "canonical",
  ]);
  for (const [name, rawDefinition] of Object.entries(definitions)) {
    const definition = requireRecord(rawDefinition, `requirement dictionary definitions.${name}`);
    for (const key of Object.keys(definition)) {
      if (!allowedDefinitionKeys.has(key)) {
        throw new Error(`requirement dictionary definitions.${name}.${key} is not metadata`);
      }
    }
    if (
      typeof definition.type !== "string" ||
      typeof definition.classification !== "string" ||
      typeof definition.description !== "string"
    ) {
      throw new Error(`requirement dictionary definitions.${name} is incomplete`);
    }
  }
  const reproducedHash = sha256Canonical(definitions);
  if (reproducedHash !== value.dictionaryHash) {
    throw new Error("requirement dictionary hash does not match canonical definitions");
  }

  requirementDictionaryCache = deepFreeze(value as unknown as RequirementDictionary);
  return requirementDictionaryCache;
}

export function loadRequirementsContract(): RequirementsContract {
  if (requirementsCache) return requirementsCache;
  const value = requireRecord(readSpec("requirements.json"), "requirements contract");
  if (
    value.schemaVersion !== 1 ||
    value.profile !== "mvp-v2" ||
    value.status !== "approved"
  ) {
    throw new Error("requirements contract identity is invalid");
  }
  const dictionaryReference = requireRecord(value.dictionary, "requirements dictionary reference");
  const dictionary = loadRequirementDictionary();
  if (
    dictionaryReference.path !== "requirement-dictionary.json" ||
    dictionaryReference.version !== dictionary.dictionaryVersion ||
    dictionaryReference.hash !== dictionary.dictionaryHash ||
    dictionaryReference.hashAlgorithm !== dictionary.dictionaryHashAlgorithm ||
    dictionaryReference.hashCanonicalization !== dictionary.dictionaryHashCanonicalization ||
    dictionaryReference.hashScope !== dictionary.dictionaryHashScope ||
    dictionaryReference.customerContentAllowed !== false
  ) {
    throw new Error("requirements dictionary reference does not match the approved dictionary");
  }
  if (!isStringArray(dictionaryReference.referencedBy) || dictionaryReference.referencedBy.length === 0) {
    throw new Error("requirements dictionary referencedBy must be a nonempty string array");
  }

  const schemas = requireRecord(value.schemas, "requirements schemas");
  const expectedSchemaPaths: Record<string, string> = {
    constraintExpression: "schemas/constraint-expression.schema.json",
    requirementRecord: "schemas/requirement-record.schema.json",
    requirementSnapshot: "schemas/requirement-snapshot.schema.json",
    domainRecords: "schemas/domain-records.schema.json",
    workflowState: "schemas/workflow-state.schema.json",
  };
  requireExactStrings(
    Object.keys(schemas),
    Object.keys(expectedSchemaPaths),
    "requirements schema registry keys",
  );
  if (
    value.schemaHashAlgorithm !== "sha256" ||
    value.schemaHashCanonicalization !== "recursive-key-sort-json-v1"
  ) {
    throw new Error("requirements schema hash policy is invalid");
  }
  for (const [name, rawSchemaReference] of Object.entries(schemas)) {
    const schemaReference = requireRecord(
      rawSchemaReference,
      `requirements schemas.${name}`,
    );
    if (
      typeof schemaReference.path !== "string" ||
      !schemaReference.path.startsWith("schemas/") ||
      schemaReference.path !== expectedSchemaPaths[name] ||
      typeof schemaReference.hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(schemaReference.hash)
    ) {
      throw new Error(`requirements schemas.${name} has an invalid path`);
    }
    const schema = loadContractSchema(schemaReference.path.slice("schemas/".length));
    if (sha256Canonical(schema) !== schemaReference.hash) {
      throw new Error(`requirements schemas.${name} hash does not match its document`);
    }
  }

  const canonicalInput = requireRecord(value.canonicalInput, "requirements canonicalInput");
  if (
    canonicalInput.field !== "rawMessagesJson" ||
    canonicalInput.transportType !== "json-object" ||
    canonicalInput.storedType !== "json-object" ||
    canonicalInput.schemaVersion !== "ypmcn-brief-v1" ||
    canonicalInput.canonicalization !== "recursive-key-sort-json-v1-preserve-array-order" ||
    JSON.stringify(canonicalInput.requiredMembers) !==
      JSON.stringify(["originalBrief", "atoms", "coverageCheck"]) ||
    JSON.stringify(canonicalInput.compatibilityAliases) !== JSON.stringify([]) ||
    canonicalInput.dictionaryMayContainValues !== false
  ) {
    throw new Error("requirements canonical input policy is invalid");
  }
  const valuePolicies = requireRecord(value.valuePolicies, "requirements valuePolicies");
  const mappedRanges = requireRecord(valuePolicies.mappedRanges, "requirements range policy");
  const creatorUnitPrice = requireRecord(
    valuePolicies.creatorUnitPrice,
    "requirements creator unit price policy",
  );
  const projectTotalBudget = requireRecord(
    valuePolicies.projectTotalBudget,
    "requirements project total budget policy",
  );
  const rebate = requireRecord(valuePolicies.rebate, "requirements rebate policy");
  if (
    mappedRanges.storageType !== "varchar(255)" ||
    mappedRanges.format !== "[min,max] JSON-array text without spaces" ||
    mappedRanges.minimum !== 0 ||
    mappedRanges.boundsRequired !== 2 ||
    mappedRanges.ordering !== "min <= max" ||
    mappedRanges.mappingAuthority !== "field_match_mapping" ||
    mappedRanges.onViolation !== "VALUE_RANGE_INVALID" ||
    !isStringArray(mappedRanges.rateFields) ||
    mappedRanges.rateMaximum !== 1
  ) {
    throw new Error("requirements mapped range policy is invalid");
  }
  if (
    JSON.stringify(creatorUnitPrice.fields) !==
      JSON.stringify(["kolOfficialPriceL1", "kolOfficialPriceL2", "kolOfficialPriceL3"]) ||
    creatorUnitPrice.businessRequiredOneOf !== true ||
    creatorUnitPrice.unit !== "CNY-yuan" ||
    creatorUnitPrice.storage !== "mappedRanges" ||
    projectTotalBudget.dedicatedField !== null ||
    projectTotalBudget.behavior !== "preserve-verbatim-in-rawMessagesJson" ||
    rebate.field !== "rebate" ||
    rebate.type !== "string" ||
    rebate.businessRequired !== false
  ) {
    throw new Error("requirements money and rebate policy is invalid");
  }
  const deadlines = requireRecord(valuePolicies.deadlines, "requirements deadline policy");
  const deadlineTypes = requireArray(deadlines.types, "requirements deadline types").map(
    (rawDeadline, index) => requireRecord(rawDeadline, `requirements deadline types[${index}]`),
  );
  if (
    deadlines.format !== "YYYY-MM-DD HH:mm:ss" ||
    deadlines.onViolation !== "DEADLINE_ORDER_INVALID" ||
    JSON.stringify(deadlineTypes.map((deadline) => deadline.name)) !==
      JSON.stringify([
        "submissionDeadlineAt",
        "projectStartStart",
        "projectStartEnd",
      ]) ||
    deadlineTypes[0].required !== true ||
    deadlineTypes.slice(1).some((deadline) => deadline.required !== false) ||
    deadlines.rawWordingStorage !== "matching rawMessagesJson atom" ||
    deadlines.prohibitedLegacyField !== "submissionDeadlineRaw"
  ) {
    throw new Error("requirements deadline policy is invalid");
  }
  requireExactStrings(
    deadlines.ordering,
    ["projectStartStart <= projectStartEnd when both are present"],
    "requirements deadline ordering",
  );
  const platformSplit = requireRecord(
    valuePolicies.platformSplit,
    "requirements platformSplit policy",
  );
  if (
    JSON.stringify(platformSplit.supportedPlatforms) !== JSON.stringify(["xiaohongshu", "douyin"]) ||
    platformSplit.executionEntity !== "customer_demands" ||
    platformSplit.executionUnitPlatformCardinality !== 1 ||
    platformSplit.multiPlatformBehavior !==
      "one independently validated customer_demands record per platform" ||
    platformSplit.crossPlatformExecutionAllowed !== false
  ) {
    throw new Error("requirements single-platform split policy is invalid");
  }

  const processingPolicies = requireRecord(
    value.processingPolicies,
    "requirements processingPolicies",
  );
  const constraintGrammar = requireRecord(
    processingPolicies.constraintGrammar,
    "requirements constraintGrammar",
  );
  if (
    constraintGrammar.schema !== "schemas/constraint-expression.schema.json" ||
    constraintGrammar.unknownOperatorBehavior !== "fail-closed" ||
    constraintGrammar.unknownFieldBehavior !== "fail-closed" ||
    constraintGrammar.onViolation !== "CONSTRAINT_GRAMMAR_INVALID"
  ) {
    throw new Error("requirements constraint grammar is invalid");
  }
  requireExactStrings(
    constraintGrammar.rootKinds,
    ["all", "any", "not", "comparison", "range", "set"],
    "requirements constraint rootKinds",
  );
  const fieldVocabulary = requireRecord(
    constraintGrammar.fieldVocabulary,
    "requirements constraint fieldVocabulary",
  );
  const allowedClassifications = requireExactStrings(
    fieldVocabulary.allowedClassifications,
    [
      "execution-scope",
      "money-lower-bound",
      "money-upper-bound",
      "rate-lower-bound",
      "rate-upper-bound",
      "deadline",
    ],
    "requirements constraint field classifications",
  );
  if (
    fieldVocabulary.source !== "requirement-dictionary.json#definitions" ||
    fieldVocabulary.membership !== "exact-key-match"
  ) {
    throw new Error("requirements constraint fields must resolve through the approved dictionary");
  }
  const allowedClassificationSet = new Set(allowedClassifications);
  const resolvedConstraintFields = Object.entries(dictionary.definitions)
    .filter(([, definition]) =>
      typeof definition.classification === "string" &&
      allowedClassificationSet.has(definition.classification)
    )
    .map(([name]) => name);
  if (resolvedConstraintFields.length === 0) {
    throw new Error("requirements constraint field vocabulary resolves no dictionary fields");
  }
  const joinGate = requireRecord(processingPolicies.joinGate, "requirements joinGate");
  const joins = requireArray(joinGate.joins, "requirements joinGate joins").map(
    (entry, index) => requireRecord(entry, `requirements joinGate joins[${index}]`),
  );
  if (
    JSON.stringify(joins.map(({ id }) => id)) !== JSON.stringify([
      "requirement-dictionary",
      "selection-snapshot",
      "offer-supplier-binding",
      "send-selection",
    ]) ||
    joins.some((join) =>
      typeof join.from !== "string" ||
      typeof join.to !== "string" ||
      typeof join.cardinality !== "string" ||
      typeof join.scopeRule !== "string"
    ) ||
    joinGate.missingBehavior !== "fail-closed" ||
    joinGate.ambiguousBehavior !== "fail-closed" ||
    joinGate.missingOrAmbiguousError !== "JOIN_GATE_FAILED" ||
    joinGate.scopeError !== "SCOPE_MISMATCH"
  ) {
    throw new Error("requirements join gate is invalid");
  }
  const lateData = requireRecord(processingPolicies.lateData, "requirements lateData");
  const requiredLateDataFields = [
    "observed_at",
    "effective_at",
    "received_at",
    "as_of_at",
    "late_data_cutoff_at",
    "is_late",
    "late_reason",
  ];
  if (
    JSON.stringify(lateData.requiredLineageFields) !== JSON.stringify(requiredLateDataFields) ||
    lateData.classification !== "received_at > late_data_cutoff_at" ||
    lateData.mutationOfFrozenArtifactAllowed !== false ||
    lateData.onForbiddenMutation !== "LATE_DATA_REJECTED"
  ) {
    throw new Error("requirements late-data policy is invalid");
  }
  const offerPromotion = requireRecord(
    processingPolicies.offerPromotion,
    "requirements offerPromotion",
  );
  if (
    JSON.stringify(offerPromotion.states) !== JSON.stringify([
      "candidate",
      "validated",
      "promoted",
      "rejected",
      "superseded",
    ]) ||
    offerPromotion.promotionFrom !== "validated" ||
    offerPromotion.promotionTo !== "promoted" ||
    offerPromotion.writeMode !== "append-new-offer-revision-and-audit-event" ||
    offerPromotion.overwriteActiveOfferAllowed !== false ||
    JSON.stringify(offerPromotion.idempotencyKey) !== JSON.stringify([
      "source_type",
      "source_record_id",
      "scope_type",
      "scope_id",
    ]) ||
    offerPromotion.onConflict !== "OFFER_PROMOTION_CONFLICT"
  ) {
    throw new Error("requirements offer promotion policy is invalid");
  }
  const governance = requireRecord(value.governance, "requirements governance");
  if (
    governance.databaseDeploymentStatus !== "development-read-only-verified-2026-07-18" ||
    governance.legacyProfileCapability !== "detection-only" ||
    governance.productionReadiness !== "NO-GO" ||
    governance.algorithmContract !== "algorithms.json" ||
    governance.algorithmReadinessRequiredForProduction !== true
  ) {
    throw new Error("requirements governance boundary is invalid");
  }

  requirementsCache = deepFreeze(value as unknown as RequirementsContract);
  return requirementsCache;
}

export function loadWorkflowContract(): WorkflowContract {
  if (workflowCache) return workflowCache;
  const value = requireRecord(readSpec("workflow.json"), "workflow contract");
  if (
    value.schemaVersion !== 1 ||
    value.profile !== "mvp-v2" ||
    value.projectionStatus !== "local-json-recorded"
  ) {
    throw new Error("workflow contract identity is invalid");
  }
  if (!isStringArray(value.phases)) throw new Error("workflow phases must be a string array");
  const phases = value.phases;
  requireUnique(phases, "workflow phases");
  if (!isStringArray(value.allowedActions)) {
    throw new Error("workflow allowedActions must be a string array");
  }
  requireUnique(value.allowedActions, "workflow allowedActions");
  const stateAuthority = requireRecord(value.stateAuthority, "workflow stateAuthority");
  if (
    stateAuthority.source !== "local-json-orchestration-state" ||
    stateAuthority.providerFacts !== false ||
    stateAuthority.providerBusinessFacts !== true ||
    stateAuthority.providerOutputSchemaAdvertised !== false ||
    stateAuthority.phaseAdvance !== "record-after-each-successful-tool-result" ||
    stateAuthority.missingEvidenceBehavior !== "no-phase-advance" ||
    stateAuthority.unknownWriteResult !== "WRITE_RESULT_UNKNOWN" ||
    stateAuthority.mayGrantProviderAuthority !== false ||
    stateAuthority.mayDenyForSafety !== false
  ) {
    throw new Error("workflow orchestration state must be recorded in local JSON from actual Tool results");
  }
  const profile = loadContractProfile("mvp-v2");
  const transitions = requireArray(value.transitions, "workflow transitions").map(
    (rawTransition, index) => requireRecord(rawTransition, `workflow transitions[${index}]`),
  );
  const transitionIds: string[] = [];
  transitions.forEach((transition, index) => {
    if (typeof transition.id !== "string" || transition.id.length === 0) {
      throw new Error(`workflow transitions[${index}].id is invalid`);
    }
    transitionIds.push(transition.id);
    if (
      typeof transition.from !== "string" ||
      !phases.includes(transition.from) ||
      typeof transition.nextPhase !== "string" ||
      !phases.includes(transition.nextPhase)
    ) {
      throw new Error(`workflow transitions[${index}] references an unknown phase`);
    }
    const trigger = requireRecord(transition.trigger, `workflow transitions[${index}].trigger`);
    if (trigger.type !== "tool" || typeof trigger.name !== "string") {
      throw new Error(`workflow transitions[${index}] must use a tool trigger`);
    }
    const tool = profile.tools[trigger.name];
    if (!tool) throw new Error(`workflow transitions[${index}] references an unknown tool`);
    if (!isStringArray(transition.guards) || transition.guards.length === 0) {
      throw new Error(`workflow transitions[${index}] must fail closed with explicit guards`);
    }
    if (!isStringArray(transition.evidence) || transition.evidence.length === 0) {
      throw new Error(`workflow transitions[${index}] must require explicit actual evidence`);
    }
  });
  requireUnique(transitionIds, "workflow transition ids");
  workflowCache = deepFreeze(value as unknown as WorkflowContract);
  return workflowCache;
}

function resolveRecordSchema(reference: string, label: string): Record<string, unknown> {
  if (!reference.startsWith("schemas/")) {
    throw new Error(`${label} must reference the Spec schemas directory`);
  }
  const [relativePath, fragment] = reference.slice("schemas/".length).split("#", 2);
  const schema = loadContractSchema(relativePath);
  if (fragment === undefined || fragment.length === 0) return schema as Record<string, unknown>;
  const segments = fragment
    .replace(/^\//, "")
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  let node: unknown = schema;
  for (const segment of segments) {
    const record = requireRecord(node, `${label} fragment`);
    if (!hasOwn(record, segment)) throw new Error(`${label} references a missing schema fragment`);
    node = record[segment];
  }
  return requireRecord(node, `${label} fragment`);
}

export function loadDatabaseContract(): DatabaseContract {
  if (databaseCache) return databaseCache;
  const value = requireRecord(readSpec("database.json"), "database contract");
  if (value.schemaVersion === 2 && value.profile === "mvp-v2") {
    if (
      value.readinessStatus !== "development-observed" ||
      !isRecord(value.database) ||
      value.database.engine !== "mysql" ||
      value.database.name !== "ypmcn" ||
      !isRecord(value.observedTables) ||
      !isRecord(value.toolDatabaseEffects)
    ) {
      throw new Error("observed database contract is invalid");
    }
    databaseCache = deepFreeze(value as unknown as DatabaseContract);
    return databaseCache;
  }
  throw new Error("database contract identity is invalid");
}

export function loadErrorCatalog(): ErrorCatalog {
  if (errorCache) return errorCache;
  const value = requireRecord(readSpec("errors.json"), "error catalog");
  if (value.schemaVersion !== 1 || value.profile !== "mvp-v2") {
    throw new Error("error catalog identity is invalid");
  }
  if (!isStringArray(value.codes)) throw new Error("error codes must be a string array");
  requireUnique(value.codes, "error codes");
  const definitions = requireArray(value.errors, "error definitions");
  const definitionCodes = definitions.map((rawDefinition, index) => {
    const definition = requireRecord(rawDefinition, `error definitions[${index}]`);
    if (typeof definition.code !== "string") {
      throw new Error(`error definitions[${index}].code must be a string`);
    }
    return definition.code;
  });
  if (JSON.stringify(definitionCodes) !== JSON.stringify(value.codes)) {
    throw new Error("error definitions must exactly follow the declared code catalog");
  }
  errorCache = deepFreeze(value as unknown as ErrorCatalog);
  return errorCache;
}

export function expectedRequiredTools(
  profileOrName: ContractProfile | ContractProfileName,
): readonly string[] {
  const name = typeof profileOrName === "string" ? profileOrName : profileOrName.profile;
  const profile = loadContractProfile(name);
  return profile.profile === "mvp-v2"
    ? profile.requiredTools
    : profile.observedSummary.toolNames;
}
