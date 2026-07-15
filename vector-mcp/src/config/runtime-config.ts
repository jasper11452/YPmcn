// @ts-nocheck
/**
 * Centralized runtime settings reader.
 *
 * Keep runtime settings isolated from provider, database, and transport modules.
 */

// ── Mode ──────────────────────────────────────────────────────────────────────
export const MODE: "real" | "fake" =
  process.env.VECTOR_MCP_MODE === "real" ? "real" : "fake";

// Fake mode is an isolated deterministic test fixture. Real mode never reads or writes it.
export const FAKE_PERSIST_PATH: string =
  process.env.VECTOR_PERSIST_PATH ??
  new URL("../../.qdrant-fake.json", import.meta.url).pathname;
