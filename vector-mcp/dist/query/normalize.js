/**
 * Query normalization and extraction for vector MCP.
 *
 * Pure functions for:
 * - Normalizing source tags (content_tags, grow_tags) into stable text
 * - Extracting vector query terms from requirement fields
 * - Separating positive semantic needs from negative requirements
 * - Excluding brand/project/numeric/KPI fields from vector queries
 */
// ── Constants ─────────────────────────────────────────────────────────
/** Delimiters for splitting tag strings. */
const TAG_DELIMITERS = /[,，、\/;；]/;
/** Negative requirement prefixes. */
const NEGATIVE_PREFIXES = ["不要", "不需要", "不", "拒绝", "排除", "避免", "禁止"];
/** Numeric/KPI patterns to exclude from positive query. */
const NUMERIC_KPI_PATTERNS = [
    /CPM/i,
    /CPC/i,
    /CPE/i,
    /CTR/i,
    /预算/,
    /单价/,
    /粉丝量/,
    /阅读量/,
    /互动量/,
    /互动率/,
    /完播率/,
    /曝光量/,
    /点赞量/,
    /数量/,
    /截止/,
    /deadline/i,
    /budget/i,
    /quantity/i,
    /\d+%/, // percentage patterns
    />?\s*\d+/, // numeric comparisons
];
/** Semantic fields in requirements_json that contribute to positive query. */
const SEMANTIC_REQUIREMENT_FIELDS = [
    "reference_materials",
    "style",
    "topics",
    "content_direction",
    "creator_style",
];
/** Non-semantic fields in requirements_json that should be excluded. */
const NON_SEMANTIC_REQUIREMENT_FIELDS = [
    "performance_thresholds",
    "filter_rules",
    "negative_requirements",
];
// ── Helpers ───────────────────────────────────────────────────────────
/**
 * Split a string by delimiters and normalize.
 */
function splitAndNormalize(input) {
    return input
        .split(TAG_DELIMITERS)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}
/**
 * Convert input (string or array) to array of strings.
 */
function toStringArray(input) {
    if (typeof input === "string") {
        return splitAndNormalize(input);
    }
    if (Array.isArray(input)) {
        return input
            .filter((item) => typeof item === "string")
            .flatMap((item) => splitAndNormalize(item));
    }
    return [];
}
/**
 * Deduplicate strings while preserving order.
 */
function dedupe(items) {
    const seen = new Set();
    return items.filter((item) => {
        if (seen.has(item))
            return false;
        seen.add(item);
        return true;
    });
}
/**
 * Check if a term is a negative requirement.
 */
function isNegativeTerm(term) {
    return NEGATIVE_PREFIXES.some((prefix) => term.startsWith(prefix));
}
/**
 * Extract the core negative term by removing prefix.
 */
function extractNegativeCore(term) {
    for (const prefix of NEGATIVE_PREFIXES) {
        if (term.startsWith(prefix)) {
            return term.slice(prefix.length).trim();
        }
    }
    return term;
}
/**
 * Check if a term contains numeric/KPI patterns.
 */
function containsNumericKPI(term) {
    return NUMERIC_KPI_PATTERNS.some((pattern) => pattern.test(term));
}
/**
 * Check if a term is a brand/project/product mention.
 */
function isBrandOrProject(term, excludedValues) {
    const lowerTerm = term.toLowerCase();
    return excludedValues.some((value) => value && lowerTerm.includes(value.toLowerCase()));
}
// ── Public API ────────────────────────────────────────────────────────
/**
 * Normalize source tags into stable text.
 *
 * Accepts arrays, comma/Chinese comma/slash/semicolon separated strings.
 * Ignores empty values, de-duplicates, trims whitespace.
 *
 * Deterministic, side-effect free.
 */
export function normalizeTagText(tagType, tags) {
    const rawTags = toStringArray(tags);
    const deduped = dedupe(rawTags);
    const normalizedText = deduped.join(" ");
    return {
        tagType,
        rawTags: deduped,
        normalizedText,
    };
}
/**
 * Extract vector query terms from requirement fields.
 *
 * Builds positive terms only from semantic fields:
 * - content_requirements
 * - creator_type_requirements
 * - tone_requirements
 * - requirements_json semantic parts (reference_materials, style, topics, etc.)
 *
 * Negative terms come from:
 * - negative_requirements
 * - requirements_json.negative_requirements
 *
 * Explicitly excludes:
 * - brand, project_name, product
 * - budget_raw, quantity_total, submission_deadline_raw
 * - CPM, CPC, CPE, CTR, reading volume, interaction rate, follower count, etc.
 *
 * If no semantic positive terms remain, returns error: "NO_SEMANTIC_QUERY_TERMS".
 *
 * Deterministic, side-effect free.
 */
export function extractVectorQuery(input) {
    // Collect excluded field values for filtering
    const excludedValues = [
        input.brand,
        input.project_name,
        input.product,
        input.budget_raw,
        input.submission_deadline_raw,
    ].filter((v) => typeof v === "string" && v.length > 0);
    const excludedFields = {};
    if (input.brand !== undefined)
        excludedFields.brand = input.brand;
    if (input.project_name !== undefined)
        excludedFields.project_name = input.project_name;
    if (input.product !== undefined)
        excludedFields.product = input.product;
    if (input.budget_raw !== undefined)
        excludedFields.budget_raw = input.budget_raw;
    if (input.quantity_total !== undefined)
        excludedFields.quantity_total = input.quantity_total;
    if (input.submission_deadline_raw !== undefined)
        excludedFields.submission_deadline_raw = input.submission_deadline_raw;
    // Collect positive terms from semantic fields
    const positiveTerms = [];
    // From direct semantic fields
    const semanticFields = [
        input.content_requirements,
        input.creator_type_requirements,
        input.tone_requirements,
    ];
    for (const field of semanticFields) {
        const terms = toStringArray(field);
        positiveTerms.push(...terms);
    }
    // From requirements_json semantic fields
    if (input.requirements_json && typeof input.requirements_json === "object") {
        for (const fieldName of SEMANTIC_REQUIREMENT_FIELDS) {
            const value = input.requirements_json[fieldName];
            if (value !== undefined) {
                const terms = toStringArray(value);
                positiveTerms.push(...terms);
            }
        }
    }
    // Collect negative terms
    const negativeTerms = [];
    // From negative_requirements
    const negativeFields = toStringArray(input.negative_requirements);
    negativeTerms.push(...negativeFields);
    // From requirements_json.negative_requirements
    if (input.requirements_json?.negative_requirements) {
        const reqNegTerms = toStringArray(input.requirements_json.negative_requirements);
        negativeTerms.push(...reqNegTerms);
    }
    // Process terms: separate positive/negative, filter out numeric/KPI/brand
    const finalPositiveTerms = [];
    const finalNegativeTerms = [];
    for (const term of positiveTerms) {
        // Skip if contains numeric/KPI patterns
        if (containsNumericKPI(term))
            continue;
        // Skip if contains brand/project/product
        if (isBrandOrProject(term, excludedValues))
            continue;
        // Check if it's a negative requirement
        if (isNegativeTerm(term)) {
            const core = extractNegativeCore(term);
            if (core.length > 0) {
                finalNegativeTerms.push(core);
            }
        }
        else {
            finalPositiveTerms.push(term);
        }
    }
    // Process explicit negative terms
    for (const term of negativeTerms) {
        // Skip if contains numeric/KPI patterns
        if (containsNumericKPI(term))
            continue;
        // Extract core if it has a negative prefix
        if (isNegativeTerm(term)) {
            const core = extractNegativeCore(term);
            if (core.length > 0) {
                finalNegativeTerms.push(core);
            }
        }
        else {
            finalNegativeTerms.push(term);
        }
    }
    // Deduplicate
    const dedupedPositive = dedupe(finalPositiveTerms);
    const dedupedNegative = dedupe(finalNegativeTerms);
    // Build positive query
    const positiveQuery = dedupedPositive.join(" ");
    // Check if we have any semantic query terms
    if (dedupedPositive.length === 0) {
        return {
            positiveTerms: [],
            negativeTerms: dedupedNegative,
            positiveQuery: "",
            excludedFields,
            error: "NO_SEMANTIC_QUERY_TERMS",
        };
    }
    return {
        positiveTerms: dedupedPositive,
        negativeTerms: dedupedNegative,
        positiveQuery,
        excludedFields,
    };
}
