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
  | "CANONICAL_INPUT_CONFLICT"
  | "DICTIONARY_REFERENCE_MISMATCH"
  | "VALUE_RANGE_INVALID"
  | "DEADLINE_ORDER_INVALID"
  | "CONSTRAINT_GRAMMAR_INVALID"
  | "JOIN_GATE_FAILED"
  | "SCOPE_MISMATCH"
  | "LATE_DATA_REJECTED"
  | "OFFER_PROMOTION_CONFLICT"
  | "SELECTION_RESULT_STALE"
  | "STATE_COMBINATION_INVALID"
  | "STATE_CONFLICT"
  | "EMBEDDING_UNAVAILABLE"
  | "RERANKER_UNAVAILABLE"
  | "SQL_ONLY_DEGRADED"
  | "VECTOR_CONFIGURATION_INVALID"
  | "VECTOR_INDEX_STALE"
  | "VECTOR_STORE_UNAVAILABLE"
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
  pattern?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  required?: string[];
  properties?: Record<string, ContractSchema>;
  items?: ContractSchema;
  additionalProperties?: boolean | ContractSchema;
  anyOf?: ContractSchema[];
  oneOf?: ContractSchema[];
  $ref?: string;
  [key: string]: unknown;
}

export interface ToolOutputContract {
  advertisedOutputSchema: false;
  evidenceBasis: string;
  successEnvelope: string;
  failureEnvelope: string;
  successSchema: ContractSchema;
  errorCodes: ContractErrorCode[];
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
  providerInputCompatibility?: "local-input-subset-of-provider";
  required: string[];
  agentRequired?: string[];
  requiredAlternatives?: string[][];
  alternativeMode?: "exactly-one";
  inputModes?: ToolInputModes;
  properties: Record<string, ContractSchema>;
  forbidden: string[];
  sideEffects: "read-only" | "business-write" | "provider-write";
  writers: {
    always: string[];
    conditional: string[];
  };
  retry: {
    policy: string;
    blindRetry: boolean;
    unknownOutcome: string;
    reconcileWith: string | null;
  };
  outputEnvelope: string;
  successEvidence: string[];
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

export interface McpServerIdentity {
  canonicalNamespace: "ypmcn";
  hostQualifiedToolName: {
    format: "mcp__ypmcn__<contract-tool>";
    pattern: string;
    businessToolIdentity: "exact-qualified-name-and-contract-tool";
    bareHookEvent: "not-a-business-tool";
  };
  providerToolsList: {
    toolNameFormat: "bare-contract-tool";
    namespace: "not-applicable";
    businessToolIdentity: "catalog-membership-only";
  };
  excludedNamespaces: ["vector-mcp"];
}

export interface MvpContractProfile {
  schemaVersion: number;
  profile: "mvp-v2";
  mode: "writable";
  serverIdentity: McpServerIdentity;
  requiredTools: string[];
  optionalTools: string[];
  outputEnvelopes: Record<string, ContractSchema>;
  outputContracts: Record<string, ToolOutputContract>;
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
  projectionStatus: "local-json-recorded";
  phases: string[];
  allowedActions: string[];
  stateAuthority: Record<string, unknown>;
  transitions: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface DatabaseContract {
  schemaVersion: number;
  profile: "mvp-v2";
  readinessStatus: string;
  modelVersion: string;
  modelStatus: string;
  entities: Record<string, DatabaseEntityContract>;
  relationships: Array<Record<string, unknown>>;
  writerOwnership: Array<Record<string, unknown>>;
  invariants: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface DatabaseEntityContract {
  role: string;
  owner: string;
  recordSchema: string;
  primaryKey: string[];
  requiredFields: string[];
  uniqueKeys: Array<{
    id: string;
    columns: string[];
    nullsAllowed: boolean;
    status: "external-unverified";
  }>;
  [key: string]: unknown;
}

export interface RequirementDictionary {
  schemaVersion: number;
  profile: "mvp-v2";
  dictionaryVersion: string;
  dictionaryHashAlgorithm: "sha256";
  dictionaryHashCanonicalization: "recursive-key-sort-json-v1";
  dictionaryHashScope: "definitions";
  dictionaryHash: string;
  contentPolicy: {
    containsCustomerContent: false;
    allowedContent: string[];
    forbiddenContent: string[];
  };
  definitions: Record<string, Record<string, unknown>>;
}

export interface RequirementsContract {
  schemaVersion: number;
  profile: "mvp-v2";
  status: "approved";
  dictionary: Record<string, unknown>;
  schemaHashAlgorithm: "sha256";
  schemaHashCanonicalization: "recursive-key-sort-json-v1";
  schemas: Record<string, { path: string; hash: string }>;
  canonicalInput: Record<string, unknown>;
  valuePolicies: Record<string, unknown>;
  processingPolicies: Record<string, unknown>;
  governance: Record<string, unknown>;
}

export interface ContractSchemaDocument extends ContractSchema {
  $schema: string;
  $id: string;
  title: string;
}

export interface ErrorCatalog {
  schemaVersion: number;
  profile: "mvp-v2";
  codes: ContractErrorCode[];
  errors: Array<Record<string, unknown>>;
  [key: string]: unknown;
}
