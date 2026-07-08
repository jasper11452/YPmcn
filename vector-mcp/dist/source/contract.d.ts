/**
 * Source-field contract for the vector MCP layer.
 *
 * Defines the canonical field names the vector layer reads from MySQL
 * source tables (小红书达人表, 抖音达人表) and provides validation
 * for user-supplied column-name mappings.
 */
/** Supported source platforms. */
export type SourcePlatform = "xhs" | "dy";
/**
 * Canonical field names the vector layer expects from every source row.
 *
 * - `platform`            — "xhs" or "dy"
 * - `platform_account_id` — native creator ID on the platform
 * - `display_name`        — human-readable creator name (optional)
 * - `content_tags`        — JSON array of content-category tags
 * - `grow_tags`           — JSON array of growth-stage tags
 * - `source_updated_at`   — ISO-8601 timestamp of last source refresh
 * - `source_table`        — logical source-table identifier
 * - `profile_url`         — creator profile URL (optional)
 */
export type SourceField = "platform" | "platform_account_id" | "display_name" | "content_tags" | "grow_tags" | "source_updated_at" | "source_table" | "profile_url";
/**
 * Fields that MUST be present in every source mapping.
 * `display_name` and `profile_url` are optional.
 */
export declare const REQUIRED_FIELDS: readonly SourceField[];
/**
 * Maps each canonical SourceField to the actual MySQL column name
 * for one source table.
 */
export type SourceMapping = Record<SourceField, string>;
/**
 * Top-level mapping: one SourceMapping per platform.
 */
export type SourceMappings = Record<SourcePlatform, SourceMapping>;
/**
 * Validate that every required field is present in each platform mapping.
 *
 * Deterministic, side-effect free.
 */
export declare function validateSourceMapping(mappings: SourceMappings): {
    ok: true;
} | {
    ok: false;
    missing: Array<{
        platform: SourcePlatform;
        field: SourceField;
    }>;
};
/**
 * Read a JSON mapping file from disk and validate it.
 *
 * @throws Error with a clear message if the file does not exist or is invalid JSON.
 * @throws Error if validation fails (required fields missing).
 */
export declare function loadSourceMapping(jsonPath: string): SourceMappings;
