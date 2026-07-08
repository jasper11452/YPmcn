/**
 * Source-field contract for the vector MCP layer.
 *
 * Defines the canonical field names the vector layer reads from MySQL
 * source tables (小红书达人表, 抖音达人表) and provides validation
 * for user-supplied column-name mappings.
 */
import { readFileSync } from "node:fs";
// ── Required / optional split ───────────────────────────────────────
/**
 * Fields that MUST be present in every source mapping.
 * `display_name` and `profile_url` are optional.
 */
export const REQUIRED_FIELDS = [
    "platform",
    "platform_account_id",
    "content_tags",
    "grow_tags",
    "source_updated_at",
    "source_table",
];
const ALL_FIELDS = [
    ...REQUIRED_FIELDS,
    "display_name",
    "profile_url",
];
// ── Validator ───────────────────────────────────────────────────────
/**
 * Validate that every required field is present in each platform mapping.
 *
 * Deterministic, side-effect free.
 */
export function validateSourceMapping(mappings) {
    const missing = [];
    for (const platform of ["xhs", "dy"]) {
        const mapping = mappings[platform];
        if (!mapping) {
            for (const field of REQUIRED_FIELDS) {
                missing.push({ platform, field });
            }
            continue;
        }
        for (const field of REQUIRED_FIELDS) {
            if (!mapping[field] || typeof mapping[field] !== "string" || mapping[field].trim() === "") {
                missing.push({ platform, field });
            }
        }
    }
    return missing.length === 0 ? { ok: true } : { ok: false, missing };
}
// ── Loader ──────────────────────────────────────────────────────────
/**
 * Read a JSON mapping file from disk and validate it.
 *
 * @throws Error with a clear message if the file does not exist or is invalid JSON.
 * @throws Error if validation fails (required fields missing).
 */
export function loadSourceMapping(jsonPath) {
    let raw;
    try {
        raw = readFileSync(jsonPath, "utf-8");
    }
    catch (err) {
        const code = err?.code;
        if (code === "ENOENT") {
            throw new Error(`Source mapping file not found: ${jsonPath}`);
        }
        throw err;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new Error(`Source mapping file is not valid JSON: ${jsonPath}`);
    }
    // Basic structural check
    if (typeof parsed !== "object" || parsed === null) {
        throw new Error(`Source mapping file must contain a JSON object: ${jsonPath}`);
    }
    const mappings = parsed;
    // Validate required fields
    const result = validateSourceMapping(mappings);
    if (!result.ok) {
        const details = result.missing
            .map((m) => `  ${m.platform}.${m.field}`)
            .join("\n");
        throw new Error(`Source mapping validation failed — missing required fields:\n${details}`);
    }
    return mappings;
}
