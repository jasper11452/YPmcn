import { readFileSync } from "node:fs";

import type {
  ContractProfile,
  ContractProfileName,
  DatabaseContract,
  ErrorCatalog,
  LegacyContractProfile,
  LegacyObservedToolContract,
  MvpContractProfile,
  ToolContract,
  WorkflowContract,
} from "./types.js";

const PROFILE_FILES: Record<ContractProfileName, string> = {
  "mvp-v2": "profiles/mvp-v2.json",
  "legacy-1.9.4": "profiles/legacy-1.9.4.json",
};

const profileCache = new Map<ContractProfileName, ContractProfile>();
let workflowCache: WorkflowContract | undefined;
let databaseCache: DatabaseContract | undefined;
let errorCache: ErrorCatalog | undefined;

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
  const specUrl = new URL(`../../spec/${relativePath}`, import.meta.url);
  return JSON.parse(readFileSync(specUrl, "utf8")) as unknown;
}

function requireUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} must not contain duplicates`);
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
  validateWritableToolMap(
    profile.tools,
    [...profile.requiredTools, ...profile.optionalTools],
    "mvp-v2.tools",
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
  const frozen = deepFreeze(validated);
  profileCache.set(name, frozen);
  return frozen;
}

export function loadWorkflowContract(): WorkflowContract {
  if (workflowCache) return workflowCache;
  const value = requireRecord(readSpec("workflow.json"), "workflow contract");
  if (value.schemaVersion !== 1 || value.profile !== "mvp-v2") {
    throw new Error("workflow contract identity is invalid");
  }
  if (!isStringArray(value.phases)) throw new Error("workflow phases must be a string array");
  requireArray(value.transitions, "workflow transitions");
  workflowCache = deepFreeze(value as unknown as WorkflowContract);
  return workflowCache;
}

export function loadDatabaseContract(): DatabaseContract {
  if (databaseCache) return databaseCache;
  const value = requireRecord(readSpec("database.json"), "database contract");
  if (value.schemaVersion !== 1 || value.profile !== "mvp-v2") {
    throw new Error("database contract identity is invalid");
  }
  if (typeof value.readinessStatus !== "string") {
    throw new Error("database readinessStatus must be a string");
  }
  requireArray(value.writerOwnership, "database writerOwnership");
  requireArray(value.invariants, "database invariants");
  databaseCache = deepFreeze(value as unknown as DatabaseContract);
  return databaseCache;
}

export function loadErrorCatalog(): ErrorCatalog {
  if (errorCache) return errorCache;
  const value = requireRecord(readSpec("errors.json"), "error catalog");
  if (value.schemaVersion !== 1 || value.profile !== "mvp-v2") {
    throw new Error("error catalog identity is invalid");
  }
  if (!isStringArray(value.codes)) throw new Error("error codes must be a string array");
  requireArray(value.errors, "error definitions");
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
