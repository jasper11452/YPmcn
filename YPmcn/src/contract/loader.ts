import { readFileSync } from "node:fs";

import type {
  ContractProfile,
  ContractProfileName,
  DatabaseContract,
  ErrorCatalog,
  LegacyContractProfile,
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

function validateToolMap(value: unknown, label: string): void {
  const tools = requireRecord(value, label);
  for (const [name, rawTool] of Object.entries(tools)) {
    const tool = requireRecord(rawTool, `${label}.${name}`);
    if (tool.name !== name) throw new Error(`${label}.${name}.name must match its key`);
    if (!isStringArray(tool.required)) {
      throw new Error(`${label}.${name}.required must be a string array`);
    }
    requireRecord(tool.properties, `${label}.${name}.properties`);
  }
}

function validateMvpProfile(value: unknown): MvpContractProfile {
  const profile = requireRecord(value, "mvp-v2 profile");
  if (profile.schemaVersion !== 1 || profile.profile !== "mvp-v2" || profile.mode !== "writable") {
    throw new Error("mvp-v2 profile identity is invalid");
  }
  if (!isStringArray(profile.requiredTools) || !isStringArray(profile.optionalTools)) {
    throw new Error("mvp-v2 tool lists must be string arrays");
  }
  validateToolMap(profile.tools, "mvp-v2.tools");
  const tools = profile.tools as Record<string, ToolContract>;
  for (const name of [...profile.requiredTools, ...profile.optionalTools]) {
    if (!(name in tools)) throw new Error(`mvp-v2 tool ${name} is not defined`);
  }
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
  const summary = requireRecord(profile.observedSummary, "legacy.observedSummary");
  if (!isStringArray(summary.toolNames)) {
    throw new Error("legacy observed tool names must be a string array");
  }
  validateToolMap(summary.tools, "legacy.observedSummary.tools");
  const tools = summary.tools as Record<string, ToolContract>;
  for (const name of summary.toolNames) {
    if (!(name in tools)) throw new Error(`legacy observed tool ${name} is not defined`);
  }
  return profile as unknown as LegacyContractProfile;
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
  const validated = name === "mvp-v2" ? validateMvpProfile(parsed) : validateLegacyProfile(parsed);
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
