export const REQUIRED_FIELDS = ["platform", "platform_account_id", "content_tags", "grow_tags", "source_updated_at", "source_table"];
import { readFileSync } from "node:fs";
export function validateSourceMapping(mappings) {
    const missing = [];
    for (const platform of ["xhs", "dy"]) {
        const mapping = mappings[platform];
        if (!mapping) {
            missing.push({ platform, field: "platform" });
            continue;
        }
        for (const field of REQUIRED_FIELDS) {
            if (!mapping[field])
                missing.push({ platform, field });
        }
    }
    return missing.length === 0 ? { ok: true } : { ok: false, missing };
}
export function loadSourceMapping(jsonPath) {
    const raw = readFileSync(jsonPath, "utf-8");
    const mappings = JSON.parse(raw);
    const validation = validateSourceMapping(mappings);
    if (!validation.ok) {
        throw new Error(`Invalid source mapping: missing fields for ${JSON.stringify(validation.missing)}`);
    }
    return mappings;
}
