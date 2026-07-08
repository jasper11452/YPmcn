// @ts-nocheck
const TAG_DELIMITERS = /[,，、\/;；]/;
const NEGATIVE_PREFIXES = ["不要", "不需要", "不", "拒绝", "排除", "避免", "禁止"];
const NUMERIC_KPI_PATTERNS = [
    /CPM/i, /CPC/i, /CPE/i, /CTR/i, /预算/, /单价/, /粉丝量/,
    /阅读量/, /互动量/, /互动率/, /完播率/, /曝光量/, /点赞量/,
    /数量/, /截止/, /deadline/i, /budget/i, /quantity/i, /\d+%/, />?\s*\d+/,
];
const SEMANTIC_REQUIREMENT_FIELDS = [
    "reference_materials", "style", "topics", "content_direction", "creator_style",
];
function splitAndNormalize(input) {
    return input.split(TAG_DELIMITERS).map((s) => s.trim()).filter((s) => s.length > 0);
}
function toStringArray(input) {
    if (typeof input === "string")
        return splitAndNormalize(input);
    if (Array.isArray(input)) {
        return input.filter((item) => typeof item === "string").flatMap((item) => splitAndNormalize(item));
    }
    return [];
}
function dedupe(items) {
    const seen = new Set();
    return items.filter((item) => { if (seen.has(item))
        return false; seen.add(item); return true; });
}
function isNegativeTerm(term) {
    return NEGATIVE_PREFIXES.some((prefix) => term.startsWith(prefix));
}
function extractNegativeCore(term) {
    for (const prefix of NEGATIVE_PREFIXES) {
        if (term.startsWith(prefix))
            return term.slice(prefix.length).trim();
    }
    return term;
}
function containsNumericKPI(term) {
    return NUMERIC_KPI_PATTERNS.some((pattern) => pattern.test(term));
}
function isBrandOrProject(term, excludedValues) {
    const lowerTerm = term.toLowerCase();
    return excludedValues.some((value) => value && lowerTerm.includes(value.toLowerCase()));
}
export function extractVectorQuery(input) {
    const excludedValues = [
        input.brand, input.project_name, input.product,
        input.budget_raw, input.submission_deadline_raw,
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
    const semanticFields = [
        input.content_requirements, input.creator_type_requirements, input.tone_requirements,
    ];
    const positiveTerms = [];
    for (const field of semanticFields) {
        positiveTerms.push(...toStringArray(field));
    }
    if (input.requirements_json && typeof input.requirements_json === "object") {
        for (const fieldName of SEMANTIC_REQUIREMENT_FIELDS) {
            const value = input.requirements_json[fieldName];
            if (value !== undefined)
                positiveTerms.push(...toStringArray(value));
        }
    }
    const negativeTerms = [];
    negativeTerms.push(...toStringArray(input.negative_requirements));
    if (input.requirements_json && typeof input.requirements_json === "object") {
        const reqNeg = input.requirements_json.negative_requirements;
        if (reqNeg)
            negativeTerms.push(...toStringArray(reqNeg));
    }
    const finalPositiveTerms = [];
    const finalNegativeTerms = [];
    for (const term of positiveTerms) {
        if (containsNumericKPI(term))
            continue;
        if (isBrandOrProject(term, excludedValues))
            continue;
        if (isNegativeTerm(term)) {
            const core = extractNegativeCore(term);
            if (core.length > 0)
                finalNegativeTerms.push(core);
        }
        else {
            finalPositiveTerms.push(term);
        }
    }
    for (const term of negativeTerms) {
        if (containsNumericKPI(term))
            continue;
        if (isNegativeTerm(term)) {
            const core = extractNegativeCore(term);
            if (core.length > 0)
                finalNegativeTerms.push(core);
        }
        else {
            finalNegativeTerms.push(term);
        }
    }
    const dedupedPositive = dedupe(finalPositiveTerms);
    const dedupedNegative = dedupe(finalNegativeTerms);
    const positiveQuery = dedupedPositive.join(" ");
    if (dedupedPositive.length === 0) {
        return {
            positiveTerms: [], negativeTerms: dedupedNegative, positiveQuery: "",
            excludedFields, error: "NO_SEMANTIC_QUERY_TERMS",
        };
    }
    return {
        positiveTerms: dedupedPositive, negativeTerms: dedupedNegative,
        positiveQuery, excludedFields,
    };
}
