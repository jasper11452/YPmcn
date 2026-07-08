/**
 * Query normalization and extraction for vector MCP.
 *
 * Pure functions for:
 * - Normalizing source tags (content_tags, grow_tags) into stable text
 * - Extracting vector query terms from requirement fields
 * - Separating positive semantic needs from negative requirements
 * - Excluding brand/project/numeric/KPI fields from vector queries
 */
/** Tag type for source normalization. */
export type TagType = "content" | "grow";
/** Result of normalizing source tags. */
export type NormalizedTagText = {
    tagType: TagType;
    rawTags: string[];
    normalizedText: string;
};
/** Input for vector query extraction. */
export type QueryExtractionInput = {
    content_requirements?: string | string[];
    creator_type_requirements?: string | string[];
    tone_requirements?: string | string[];
    negative_requirements?: string | string[];
    requirements_json?: Record<string, unknown>;
    brand?: string;
    project_name?: string;
    product?: string;
    budget_raw?: string;
    quantity_total?: number;
    submission_deadline_raw?: string;
};
/** Result of vector query extraction. */
export type QueryExtractionResult = {
    positiveTerms: string[];
    negativeTerms: string[];
    positiveQuery: string;
    excludedFields: Record<string, unknown>;
    error?: "NO_SEMANTIC_QUERY_TERMS";
};
/**
 * Normalize source tags into stable text.
 *
 * Accepts arrays, comma/Chinese comma/slash/semicolon separated strings.
 * Ignores empty values, de-duplicates, trims whitespace.
 *
 * Deterministic, side-effect free.
 */
export declare function normalizeTagText(tagType: TagType, tags: unknown): NormalizedTagText;
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
export declare function extractVectorQuery(input: QueryExtractionInput): QueryExtractionResult;
