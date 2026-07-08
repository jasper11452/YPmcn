/**
 * Fake e2e validation: sync + search using fake providers and in-memory Qdrant.
 *
 * Proves the full pipeline works locally without real credentials.
 * Run via: npm run validate:fake
 */
export interface FakeE2eResult {
    success: boolean;
    mode: "fake";
    synced: number;
    searched: boolean;
    error?: string;
}
export declare function runFakeE2eValidation(): Promise<FakeE2eResult>;
