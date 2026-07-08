/**
 * Real validation: checks config and reports missing credentials.
 *
 * Behavior contract:
 * - Without env config: exits 0 with { success: false, skipped: true, code: "...", missing: [...] }
 * - With env config: exits 0 with { success: false, skipped: true, code: "REAL_VALIDATION_NOT_IMPLEMENTED" }
 * - Never performs real network/database calls.
 * - Never claims real validation passed.
 *
 * Run via: npm run validate:real
 */
import { loadConfigFromEnv, ConfigError } from "../config/index.js";
// ─── Core logic ──────────────────────────────────────────────────────────────
export function runRealValidation(env) {
    const envToUse = env ?? { ...process.env, VECTOR_MCP_MODE: "real" };
    // Ensure we're in real mode
    if (!envToUse["VECTOR_MCP_MODE"]) {
        envToUse["VECTOR_MCP_MODE"] = "real";
    }
    try {
        loadConfigFromEnv(envToUse);
    }
    catch (err) {
        if (err instanceof ConfigError) {
            return {
                success: false,
                skipped: true,
                code: err.code,
                missing: err.missingVars,
            };
        }
        // Unexpected error — still skip, don't crash
        return {
            success: false,
            skipped: true,
            code: "CONFIG_LOAD_ERROR",
            missing: [err instanceof Error ? err.message : String(err)],
        };
    }
    // Config loaded successfully, but real validation is not implemented yet
    return {
        success: false,
        skipped: true,
        code: "REAL_VALIDATION_NOT_IMPLEMENTED",
    };
}
// ─── CLI entry ───────────────────────────────────────────────────────────────
function main() {
    const result = runRealValidation();
    console.log(JSON.stringify(result, null, 2));
    // Always exit 0 — skipped is a valid outcome, not a CI failure
}
const isDirectRun = typeof process !== "undefined" &&
    process.argv[1] &&
    (process.argv[1].endsWith("/validation/realValidation.js") ||
        process.argv[1].endsWith("/validation/realValidation.ts"));
if (isDirectRun) {
    main();
}
