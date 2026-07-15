export interface CreatorProjectionInput {
  description?: unknown;
  profile?: unknown;
  data_json?: unknown;
}

export interface CreatorProjection {
  contentText: string;
  commercialText: string;
}

const CONTENT_KEYS = new Set([
  "description",
  "contentTypeLabel",
  "contentThemeLabel",
  "industryTagLabel",
  "talentTypeLabel",
  "growTalentTypeLabel",
]);
const COMMERCIAL_KEYS = new Set([
  "parsedBrands",
  "parsedCategories",
  "parsedScenarios",
  "parsedBenefits",
  "parsedIngredients",
  "parsedIp",
  "tagBrand",
  "categories",
  "scenarios",
  "benefits",
  "ingredients",
]);

function parseJson(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function semanticStrings(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed && !/^[-+]?\d+(?:\.\d+)?%?$/.test(trimmed) ? [trimmed] : [];
  }
  if (Array.isArray(value)) return value.flatMap(semanticStrings);
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).flatMap(semanticStrings);
  return [];
}

export function normalizeAndRedact(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, " [EMAIL] ")
    .replace(/(?:https?:\/\/|www\.)\S+/gi, " [URL] ")
    .replace(/(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g, " [PHONE] ")
    .replace(/(?<![A-Za-z0-9])\d{17}[\dXx](?![A-Za-z0-9])/g, " [ID] ")
    .replace(/\b(?=[A-Za-z0-9_-]{16,}\b)(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]+\b/g, " [ID] ")
    .replace(/\s+/g, " ")
    .trim();
}

function joinProjected(parts: unknown[]): string {
  const unique = [...new Set(parts.flatMap(semanticStrings).map(normalizeAndRedact).filter(Boolean))];
  return unique.join(" | ");
}

export function projectCreatorText(input: CreatorProjectionInput): CreatorProjection {
  const data = parseJson(input.data_json);
  const content: unknown[] = [input.description, input.profile];
  const commercial: unknown[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (CONTENT_KEYS.has(key)) content.push(value);
    if (COMMERCIAL_KEYS.has(key)) commercial.push(value);
  }
  return {
    contentText: joinProjected(content),
    commercialText: joinProjected(commercial),
  };
}

export function projectQueryText(value: unknown): string {
  return normalizeAndRedact(value);
}
