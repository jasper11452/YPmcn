import { loadContractSchema } from "./contract/loader.js";
import {
  bindingFingerprint,
  deny,
  type GuardStore,
  type Json,
  save,
  store,
  text,
} from "./runtime-hook-state.js";

const REQUIREMENT_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const REQUIREMENT_PLATFORMS = new Set(["xiaohongshu", "douyin"]);
const AMBIGUITY_SENTINEL = /^(?:__UNRESOLVED__|UNRESOLVED|TBD|TODO|待确认|待补充|不明确)$/i;
const CREATOR_UNIT_PRICE_FIELDS = ["kolOfficialPriceL1", "kolOfficialPriceL2", "kolOfficialPriceL3"] as const;
const REQUIREMENT_RANGE_FIELDS = [
  "photoInteract",
  "followercount",
  "userlikecount",
  "likeIncrement",
  "avgview",
  "avglike",
  "avgcomment",
  "avgcollect",
  "avginteract",
  "femaleRate",
  "age1Rate",
  "age2Rate",
  "age3Rate",
  "age4Rate",
  "age5Rate",
  "age6Rate",
  "cpeL1",
  "cpeL2",
  "cpeL3",
  "cpmL1",
  "cpmL2",
  "cpmL3",
  ...CREATOR_UNIT_PRICE_FIELDS,
] as const;
const UNIT_INTERVAL_RANGE_FIELDS = new Set([
  "photoInteract",
  "femaleRate",
  "age1Rate",
  "age2Rate",
  "age3Rate",
  "age4Rate",
  "age5Rate",
  "age6Rate",
]);
const REQUIREMENT_RECORD_SCHEMA = loadContractSchema("requirement-record.schema.json");
const REQUIREMENT_PAYLOAD_FIELDS = new Set(Object.keys(REQUIREMENT_RECORD_SCHEMA.properties ?? {}));
const PROVIDER_MANAGED_REQUIREMENT_FIELDS = new Set(["id", "demandVersion", "createdAt", "updatedAt"]);
const REQUIREMENT_STRING_FIELDS = new Set([
  "demandId", "brandName", "projectName", "product", "rebate", "contentTag", "description",
  "kwGender", "kwIpDependency", "kwUserUrl", "organization",
]);
const REQUIREMENT_LABEL_FIELDS = new Set([
  "contentFeatureLabel", "contentThemeLabel", "kolPersonaLabel", "talentTypeLabel",
  "pgyBloggerTypeLabel", "xtTalentTypeLabel",
]);
const ACCOUNT_TYPE_TARGET_FIELDS = new Set(["contentTag", ...REQUIREMENT_LABEL_FIELDS]);
const REQUIREMENT_BOOLEAN_INTEGER_FIELDS = new Set(["hasOrganization", "hasOrder30day", "hasSocial30day"]);
const REQUIREMENT_NONNEGATIVE_INTEGER_FIELDS = new Set(["clickMedium", "viewMedium", "photoView", "videoInteract"]);
const REQUIREMENT_OPTIONAL_DATETIME_FIELDS = ["projectStartStart", "projectStartEnd"] as const;

function requirementRange(value: unknown): readonly [number, number] | undefined {
  if (typeof value !== "string" || value.trim() !== value) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      !parsed.every((item) => typeof item === "number" && Number.isFinite(item) && item >= 0) ||
      parsed[0] > parsed[1] ||
      JSON.stringify(parsed) !== value
    ) return undefined;
    return parsed as [number, number];
  } catch {
    return undefined;
  }
}

export function readyRequirementFailure(
  tool: string | undefined,
  input: Json,
  current: GuardStore,
): Json | undefined {
  const binding = current.data.ready_requirement_binding;
  if (!binding || typeof binding !== "object" || binding.status === "validated") return undefined;
  if (binding.status === "failed") return undefined;
  if (binding.status !== "pending") {
    return deny(
      "BLOCKED_REQUIREMENT_VALIDATION_IN_FLIGHT",
      "The authoritative Ready Preview validation is already in flight or failed; stop until a new user turn.",
    );
  }
  if (tool !== "validate_requirement") {
    return deny(
      "BLOCKED_REQUIREMENT_VALIDATION_REQUIRED",
      "A Ready Preview is bound to this turn; the only permitted Tool is validate_requirement with the exact injected arguments.",
    );
  }
  const payload = input.payload && typeof input.payload === "object" ? input.payload : input;
  if (!text(binding.payload_fingerprint) || bindingFingerprint(payload) !== binding.payload_fingerprint) {
    return deny(
      "BLOCKED_REQUIREMENT_PREVIEW_MISMATCH",
      "validate_requirement.payload does not match the current Ready Preview after harmless whitespace, Unicode-width, and null-field normalization. Rebuild it from the current confirmed values.",
    );
  }
  return undefined;
}

function markReadyRequirementInFlight(current: GuardStore, payload: Json): void {
  const binding = current.data.ready_requirement_binding;
  if (!binding || typeof binding !== "object" || binding.status !== "pending") return;
  if (binding.payload_fingerprint !== bindingFingerprint(payload)) return;
  binding.status = "in_flight";
  binding.updated_at_ms = Date.now();
  current.data.ready_requirement_binding = binding;
  save(current.path, current.data);
}

function findAmbiguitySentinel(value: unknown, path = "payload"): string | undefined {
  if (typeof value === "string") {
    return AMBIGUITY_SENTINEL.test(value.trim()) ? path : undefined;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findAmbiguitySentinel(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Json)) {
      const found = findAmbiguitySentinel(item, `${path}.${key}`);
      if (found) return found;
    }
  }
  return undefined;
}

function normalizedEvidence(value: string): string {
  return [...value.normalize("NFKC")]
    .filter((character) => /[\p{L}\p{N}\p{S}]/u.test(character))
    .join("")
    .toLocaleLowerCase("und");
}

function recoverOriginalEvidence(originalBrief: string, sourceText: string): string | undefined {
  const trimmed = sourceText.trim();
  if (trimmed && originalBrief.includes(trimmed)) return trimmed;

  const needle = normalizedEvidence(trimmed);
  if (needle.length < 2) return undefined;

  let normalizedOriginal = "";
  const spans: Array<{ start: number; end: number }> = [];
  let offset = 0;
  for (const character of originalBrief) {
    const start = offset;
    offset += character.length;
    for (const normalizedCharacter of character.normalize("NFKC").toLocaleLowerCase("und")) {
      if (!/[\p{L}\p{N}\p{S}]/u.test(normalizedCharacter)) continue;
      normalizedOriginal += normalizedCharacter;
      spans.push({ start, end: offset });
    }
  }

  const matchStart = normalizedOriginal.indexOf(needle);
  if (matchStart < 0 || normalizedOriginal.indexOf(needle, matchStart + 1) >= 0) return undefined;
  const first = spans[matchStart];
  const last = spans[matchStart + needle.length - 1];
  if (!first || !last) return undefined;
  const recovered = originalBrief.slice(first.start, last.end).trim();
  return recovered || undefined;
}

function validateAuditableBrief(raw: unknown, payload: Json): Json | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return deny("BLOCKED_REQUIREMENT_INCOMPLETE", "payload.rawMessagesJson must be a ypmcn-brief-v1 audit object.");
  }
  const audit = raw as Json;
  if (audit.schemaVersion !== "ypmcn-brief-v1") {
    return deny("BLOCKED_REQUIREMENT_INCOMPLETE", "payload.rawMessagesJson.schemaVersion must equal ypmcn-brief-v1.");
  }
  if (!text(audit.originalBrief)) {
    return deny("BLOCKED_REQUIREMENT_INCOMPLETE", "payload.rawMessagesJson.originalBrief must preserve the non-empty original brief.");
  }
  if (!Array.isArray(audit.atoms) || audit.atoms.length === 0) {
    return deny("BLOCKED_REQUIREMENT_INCOMPLETE", "payload.rawMessagesJson.atoms must be a non-empty array.");
  }

  let mappedCount = 0;
  let preservedCount = 0;
  for (let index = 0; index < audit.atoms.length; index += 1) {
    const atom = audit.atoms[index];
    const path = `payload.rawMessagesJson.atoms[${index}]`;
    if (!atom || typeof atom !== "object" || Array.isArray(atom)) {
      return deny("BLOCKED_REQUIREMENT_INCOMPLETE", `${path} must be an object.`);
    }
    if (!text(atom.sourceText)) {
      return deny("BLOCKED_REQUIREMENT_INCOMPLETE", `${path}.sourceText must be non-empty.`);
    }
    if (!audit.originalBrief.includes(atom.sourceText)) {
      const previousSourceText = atom.sourceText;
      const recovered = recoverOriginalEvidence(audit.originalBrief, previousSourceText);
      if (recovered) {
        atom.sourceText = recovered;
        if (atom.disposition === "preserved" && atom.preservedText === previousSourceText) {
          atom.preservedText = recovered;
        }
      }
    }
    if (atom.disposition !== "mapped" && atom.disposition !== "preserved") {
      return deny("BLOCKED_REQUIREMENT_INCOMPLETE", `${path}.disposition must be mapped or preserved.`);
    }
    if (typeof atom.confidence !== "number" || !Number.isFinite(atom.confidence) || atom.confidence < 0 || atom.confidence > 1) {
      return deny("BLOCKED_REQUIREMENT_INCOMPLETE", `${path}.confidence must be a finite number from 0 through 1.`);
    }
    if (typeof atom.inferred !== "boolean") {
      return deny("BLOCKED_REQUIREMENT_INCOMPLETE", `${path}.inferred must be boolean.`);
    }
    if (atom.disposition === "mapped") {
      mappedCount += 1;
      if (!text(atom.targetField) || !Object.prototype.hasOwnProperty.call(payload, atom.targetField)) {
        return deny("BLOCKED_REQUIREMENT_INCOMPLETE", `${path}.targetField must name a field present in payload.`);
      }
    } else {
      preservedCount += 1;
      if (!text(atom.preservedText) || atom.preservedText !== atom.sourceText) {
        return deny("BLOCKED_REQUIREMENT_INCOMPLETE", `${path}.preservedText must exactly equal sourceText for a preserved atom.`);
      }
    }
  }

  const coverage = audit.coverageCheck;
  if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)) {
    return deny("BLOCKED_REQUIREMENT_INCOMPLETE", "payload.rawMessagesJson.coverageCheck is required.");
  }
  if (
    coverage.atomCount !== audit.atoms.length ||
    coverage.mappedCount !== mappedCount ||
    coverage.preservedCount !== preservedCount ||
    coverage.unresolvedCount !== 0 ||
    coverage.atomCount !== coverage.mappedCount + coverage.preservedCount + coverage.unresolvedCount
  ) {
    return deny(
      "BLOCKED_REQUIREMENT_AUDIT_CONFLICT",
      "payload.rawMessagesJson.coverageCheck must be derived from the same atoms: atomCount=atoms.length, mappedCount and preservedCount must match dispositions, unresolvedCount must be zero, and atomCount=mappedCount+preservedCount+unresolvedCount.",
    );
  }
  return undefined;
}

function explicitJsonArray(sourceText: string): boolean {
  try {
    const parsed = JSON.parse(sourceText.trim());
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

function validateTaxonomyMapping(payload: Json): Json | undefined {
  const audit = payload.rawMessagesJson;
  if (!audit || typeof audit !== "object" || !Array.isArray(audit.atoms) || !text(audit.originalBrief)) {
    return undefined;
  }
  for (const atom of audit.atoms) {
    if (!atom || typeof atom !== "object" || atom.disposition !== "mapped" ||
      !text(atom.sourceText) || !text(atom.targetField) ||
      !ACCOUNT_TYPE_TARGET_FIELDS.has(atom.targetField)) continue;
    const index = audit.originalBrief.indexOf(atom.sourceText);
    const context = index >= 0
      ? audit.originalBrief.slice(Math.max(0, index - 16), index + atom.sourceText.length)
      : atom.sourceText;
    const talentWording = /(?:账号|达人|博主|蒲公英|星图)/.test(context);
    if (atom.targetField === "contentTag") {
      if (!talentWording) continue;
    } else if (talentWording || explicitJsonArray(atom.sourceText)) {
      continue;
    }
    return deny(
      "BLOCKED_TAXONOMY_CONFIRMATION_REQUIRED",
      `Natural-language atom ${JSON.stringify(atom.sourceText)} cannot map to payload.${atom.targetField} without an explicit taxonomy value; ask whether it is a content topic or a platform talent type and stop.`,
    );
  }
  return undefined;
}

function validateRequirementPayload(payload: Json): Json | undefined {
  const unknownField = Object.keys(payload).find((field) => !REQUIREMENT_PAYLOAD_FIELDS.has(field));
  if (unknownField) {
    return deny(
      "BLOCKED_REQUIREMENT_INCOMPLETE",
      `payload.${unknownField} is not a real customer_demands field; map it to the packaged 61-column schema or preserve the original wording in rawMessagesJson.`,
    );
  }
  const providerManagedField = Object.keys(payload).find((field) => PROVIDER_MANAGED_REQUIREMENT_FIELDS.has(field));
  if (providerManagedField) {
    return deny(
      "BLOCKED_REQUIREMENT_INCOMPLETE",
      `payload.${providerManagedField} is Provider-managed and must not be supplied by the Agent.`,
    );
  }
  if (!text(payload.platform)) {
    return deny("BLOCKED_REQUIREMENT_INCOMPLETE", "payload.platform is required; ask for the missing platform and stop.");
  }
  if (!REQUIREMENT_PLATFORMS.has(payload.platform)) {
    return deny("BLOCKED_REQUIREMENT_INCOMPLETE", "payload.platform must be xiaohongshu or douyin; clarify the platform and stop.");
  }
  if (!Number.isInteger(payload.quantityTotal) || payload.quantityTotal <= 0) {
    return deny("BLOCKED_REQUIREMENT_INCOMPLETE", "payload.quantityTotal must be a positive integer; ask for the missing or ambiguous quantity and stop.");
  }
  if (!text(payload.submissionDeadlineAt) || !REQUIREMENT_DATETIME.test(payload.submissionDeadlineAt)) {
    return deny("BLOCKED_REQUIREMENT_INCOMPLETE", "payload.submissionDeadlineAt is required in YYYY-MM-DD HH:mm:ss format; clarify the deadline and stop.");
  }
  for (const field of REQUIREMENT_OPTIONAL_DATETIME_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, field) &&
      (typeof payload[field] !== "string" || !REQUIREMENT_DATETIME.test(payload[field]))) {
      return deny("BLOCKED_REQUIREMENT_INCOMPLETE", `payload.${field} must use YYYY-MM-DD HH:mm:ss when supplied.`);
    }
  }
  if (text(payload.projectStartStart) && text(payload.projectStartEnd) && payload.projectStartStart > payload.projectStartEnd) {
    return deny("BLOCKED_REQUIREMENT_INCOMPLETE", "payload.projectStartStart must not be later than payload.projectStartEnd.");
  }
  for (const field of REQUIREMENT_STRING_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, field) && !text(payload[field])) {
      return deny("BLOCKED_REQUIREMENT_INCOMPLETE", `payload.${field} must be a non-empty string when supplied.`);
    }
  }
  for (const field of REQUIREMENT_LABEL_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(payload, field)) continue;
    const value = payload[field];
    if (!value || typeof value !== "object" ||
      (Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0)) {
      return deny("BLOCKED_REQUIREMENT_INCOMPLETE", `payload.${field} must be a non-empty JSON array or object when supplied.`);
    }
  }
  for (const field of REQUIREMENT_BOOLEAN_INTEGER_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, field) && payload[field] !== 0 && payload[field] !== 1) {
      return deny("BLOCKED_REQUIREMENT_INCOMPLETE", `payload.${field} must be integer 0 or 1 when supplied.`);
    }
  }
  for (const field of REQUIREMENT_NONNEGATIVE_INTEGER_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, field) &&
      (!Number.isInteger(payload[field]) || payload[field] < 0)) {
      return deny("BLOCKED_REQUIREMENT_INCOMPLETE", `payload.${field} must be a non-negative integer when supplied.`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(payload, "interactionRate") &&
    (typeof payload.interactionRate !== "number" || !Number.isFinite(payload.interactionRate) ||
      payload.interactionRate < 0 || payload.interactionRate > 1)) {
    return deny("BLOCKED_REQUIREMENT_INCOMPLETE", "payload.interactionRate must be a finite number between 0 and 1 when supplied.");
  }
  for (const field of REQUIREMENT_RANGE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(payload, field)) continue;
    const range = requirementRange(payload[field]);
    if (!range) {
      return deny(
        "BLOCKED_REQUIREMENT_INCOMPLETE",
        `payload.${field} must be a canonical non-negative range string such as "[0,0.5]"; clarify and normalize the range before validation.`,
      );
    }
    if (UNIT_INTERVAL_RANGE_FIELDS.has(field) && range[1] > 1) {
      return deny(
        "BLOCKED_REQUIREMENT_INCOMPLETE",
        `payload.${field} is a rate range and both bounds must be between 0 and 1.`,
      );
    }
  }
  const suppliedUnitPrices = CREATOR_UNIT_PRICE_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(payload, field));
  if (suppliedUnitPrices.length === 0) {
    return deny(
      "BLOCKED_REQUIREMENT_INCOMPLETE",
      "one of payload.kolOfficialPriceL1/L2/L3 is business-required as a [min,max] range string; ask for the single-creator budget and its content tier, then stop.",
    );
  }
  const invalidUnitPrice = suppliedUnitPrices.find((field) => {
    const range = requirementRange(payload[field]);
    return !range || range[1] <= 0;
  });
  if (invalidUnitPrice) {
    return deny(
      "BLOCKED_REQUIREMENT_INCOMPLETE",
      `payload.${invalidUnitPrice} must be a canonical RMB [min,max] range with a positive upper bound; clarify the single-creator budget and stop.`,
    );
  }
  const auditFailure = validateAuditableBrief(payload.rawMessagesJson, payload);
  if (auditFailure) return auditFailure;
  const taxonomyFailure = validateTaxonomyMapping(payload);
  if (taxonomyFailure) return taxonomyFailure;
  const sentinelPath = findAmbiguitySentinel(payload);
  if (sentinelPath) {
    return deny("BLOCKED_REQUIREMENT_INCOMPLETE", `${sentinelPath} contains an unresolved placeholder; clarify the semantic ambiguity and stop.`);
  }
  return undefined;
}

export function guardValidateRequirement(input: Json, current: GuardStore): Json | undefined {
  const payload = input.payload && typeof input.payload === "object" ? input.payload : input;
  if (payload.status !== "ready") {
    return deny("BLOCKED_REQUIREMENT_INCOMPLETE", "payload.status must be ready; clarify every missing or ambiguous required value before validation.");
  }
  const requirementFailure = validateRequirementPayload(payload);
  if (requirementFailure) return requirementFailure;
  const emptyField = Object.entries(payload).find(([, value]) =>
    value === null || (typeof value === "string" && value.trim() === "") ||
    (Array.isArray(value) && value.length === 0)
  );
  if (emptyField) {
    return deny("BLOCKED_REQUIREMENT_INCOMPLETE", `payload.${emptyField[0]} is empty; omit optional fields and clarify required fields before validation.`);
  }
  markReadyRequirementInFlight(current, payload);
  return undefined;
}

export function settleReadyRequirement(input: Json, rootDir: string, succeeded: boolean): void {
  const current = store(rootDir);
  const binding = current.data.ready_requirement_binding;
  const payload = input.payload && typeof input.payload === "object" ? input.payload : input;
  if (!binding || typeof binding !== "object" || binding.status !== "in_flight" ||
    binding.payload_fingerprint !== bindingFingerprint(payload)) return;
  binding.status = succeeded ? "validated" : "failed";
  binding.updated_at_ms = Date.now();
  current.data.ready_requirement_binding = binding;
  save(current.path, current.data);
}
