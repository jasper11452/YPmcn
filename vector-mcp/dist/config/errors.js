export class ConfigError extends Error {
    code;
    missingVars;
    constructor(code, missingVars) {
        const varsList = missingVars.length > 0 ? missingVars.join(", ") : "(unknown)";
        super(`[${code}] Missing required environment variables: ${varsList}`);
        this.name = "ConfigError";
        this.code = code;
        this.missingVars = missingVars;
    }
}
