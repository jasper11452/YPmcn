import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateSourceMapping, loadSourceMapping, REQUIRED_FIELDS, } from "./contract.js";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
/** Build a valid mapping with all required + optional fields. */
function validMappings() {
    return {
        xhs: {
            platform: "platform",
            platform_account_id: "xhs_creator_id",
            display_name: "xhs_nickname",
            content_tags: "xhs_content_tags_json",
            grow_tags: "xhs_grow_tags_json",
            source_updated_at: "xhs_updated_at",
            source_table: "xhs_source_table",
            profile_url: "xhs_homepage_url",
        },
        dy: {
            platform: "platform",
            platform_account_id: "dy_creator_id",
            display_name: "dy_nickname",
            content_tags: "dy_content_tags_json",
            grow_tags: "dy_grow_tags_json",
            source_updated_at: "dy_updated_at",
            source_table: "dy_source_table",
            profile_url: "dy_homepage_url",
        },
    };
}
describe("validateSourceMapping", () => {
    it("returns ok:true for a complete mapping", () => {
        const result = validateSourceMapping(validMappings());
        assert.equal(result.ok, true);
    });
    it("returns ok:false with grow_tags missing when removed from xhs", () => {
        const mappings = validMappings();
        // @ts-expect-error — intentionally removing a required field for the test
        delete mappings.xhs.grow_tags;
        const result = validateSourceMapping(mappings);
        assert.equal(result.ok, false);
        if (!result.ok) {
            const growTagMissing = result.missing.some((m) => m.platform === "xhs" && m.field === "grow_tags");
            assert.equal(growTagMissing, true, "grow_tags should be listed as missing for xhs");
            // Only one field should be missing
            assert.equal(result.missing.length, 1);
        }
    });
    it("reports missing fields for both platforms when mapping is empty", () => {
        const mappings = {
            xhs: {},
            dy: {},
        };
        const result = validateSourceMapping(mappings);
        assert.equal(result.ok, false);
        if (!result.ok) {
            // All required fields missing for both platforms
            assert.equal(result.missing.length, REQUIRED_FIELDS.length * 2);
        }
    });
});
describe("loadSourceMapping", () => {
    it("loads and validates the example mapping file", () => {
        const examplePath = resolve(__dirname, "../../src/source/mapping.example.json");
        const mappings = loadSourceMapping(examplePath);
        assert.equal(mappings.xhs.platform, "platform");
        assert.equal(mappings.dy.platform_account_id, "dy_creator_id");
    });
    it("throws a clear error when file does not exist", () => {
        assert.throws(() => loadSourceMapping("/nonexistent/path/mapping.json"), (err) => {
            assert.match(err.message, /Source mapping file not found/);
            return true;
        });
    });
});
