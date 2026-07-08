export class ConfigError extends Error {
    code;
    missingVars;
    constructor(code, missingVars) {
        super(`Config error: ${code} — missing: ${missingVars.join(", ")}`);
        this.code = code;
        this.missingVars = missingVars;
    }
}
