export type ContractProfileName = "mvp-v2" | "legacy-1.9.4";

export type ContractErrorCode =
  | "INTEGRATION_REQUIRED"
  | "SCHEMA_MISMATCH"
  | "INVALID_INPUT"
  | "INVALID_PHASE"
  | "CONFIRMATION_REQUIRED"
  | "FIELD_SELECTION_INVALID"
  | "PROVIDER_REFERENCE_MISSING"
  | "RECOVERY_NOT_CONFIRMED"
  | "RECOVERY_ALREADY_TERMINAL"
  | "STATE_CONFLICT"
  | "WRITE_RESULT_UNKNOWN";

export interface ValidationIssue {
  code: ContractErrorCode;
  path: string;
  message: string;
}

export type SchemaType =
  | "array"
  | "boolean"
  | "integer"
  | "null"
  | "number"
  | "object"
  | "string";

export interface ContractSchema {
  type?: SchemaType | SchemaType[];
  const?: unknown;
  enum?: unknown[];
  minLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  uniqueItems?: boolean;
  required?: string[];
  properties?: Record<string, ContractSchema>;
  items?: ContractSchema;
  additionalProperties?: boolean | ContractSchema;
  [key: string]: unknown;
}

export interface ToolInputMode {
  matchAny: string[];
}

export interface ToolInputModes {
  policy: "at-least-one";
  allowMultiple: true;
  modes: Record<string, ToolInputMode>;
}

export interface ToolContract {
  name: string;
  required: string[];
  requiredAlternatives?: string[][];
  alternativeMode?: "exactly-one";
  inputModes?: ToolInputModes;
  properties: Record<string, ContractSchema>;
  forbidden: string[];
  [key: string]: unknown;
}

export interface LegacyObservedToolContract {
  name: string;
  required: string[];
  properties: Record<string, ContractSchema>;
  capability: "detection-only";
  executable: false;
  writerAuthorization: "none";
  writers: {
    always: string[];
    conditional: string[];
  };
}

export interface MvpContractProfile {
  schemaVersion: number;
  profile: "mvp-v2";
  mode: "writable";
  requiredTools: string[];
  optionalTools: string[];
  tools: Record<string, ToolContract>;
  [key: string]: unknown;
}

export interface LegacyObservedSummary {
  toolNames: string[];
  tools: Record<string, LegacyObservedToolContract>;
}

export interface LegacyContractProfile {
  schemaVersion: number;
  profile: "legacy-1.9.4";
  targetProfile: "mvp-v2";
  mode: "detection-only";
  writable: false;
  automaticFallback: false;
  observedSummary: LegacyObservedSummary;
  [key: string]: unknown;
}

export type ContractProfile = MvpContractProfile | LegacyContractProfile;

export interface WorkflowContract {
  schemaVersion: number;
  profile: "mvp-v2";
  phases: string[];
  transitions: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface DatabaseContract {
  schemaVersion: number;
  profile: "mvp-v2";
  readinessStatus: string;
  writerOwnership: Array<Record<string, unknown>>;
  invariants: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface ErrorCatalog {
  schemaVersion: number;
  profile: "mvp-v2";
  codes: ContractErrorCode[];
  errors: Array<Record<string, unknown>>;
  [key: string]: unknown;
}
