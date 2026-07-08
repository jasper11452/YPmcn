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
export interface RealValidationResult {
    success: boolean;
    skipped: true;
    code: string;
    missing?: string[];
}
export declare function runRealValidation(env?: NodeJS.ProcessEnv): RealValidationResult;
