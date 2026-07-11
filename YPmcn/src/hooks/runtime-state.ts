import type { RuntimeState, RuntimeStateStore } from "./types.js";

const DEFAULT_STATE_TTL_MS = 24 * 60 * 60 * 1_000;

interface StoredState {
  state: RuntimeState;
  expiresAt: number;
}

function cloneState(state: RuntimeState): RuntimeState {
  return structuredClone(state);
}

export interface RuntimeStateStoreOptions {
  now?: () => number;
  ttlMs?: number;
}

export function createRuntimeStateStore(
  options: RuntimeStateStoreOptions = {},
): RuntimeStateStore {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_STATE_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new TypeError("Runtime-state ttlMs must be a positive finite number.");
  }

  const entries = new Map<string, StoredState>();

  function get(sessionKey: string): RuntimeState | undefined {
    const entry = entries.get(sessionKey);
    if (!entry) return undefined;
    if (entry.expiresAt <= now()) {
      entries.delete(sessionKey);
      return undefined;
    }
    return cloneState(entry.state);
  }

  function set(sessionKey: string, state: RuntimeState): RuntimeState {
    if (sessionKey.trim().length === 0) {
      throw new TypeError("Runtime-state sessionKey must be nonempty.");
    }
    const stored = cloneState(state);
    entries.set(sessionKey, { state: stored, expiresAt: now() + ttlMs });
    return cloneState(stored);
  }

  return {
    get,
    set,
    update(sessionKey, updater) {
      const next = updater(get(sessionKey));
      if (next === undefined) {
        entries.delete(sessionKey);
        return undefined;
      }
      return set(sessionKey, next);
    },
    delete(sessionKey) {
      entries.delete(sessionKey);
    },
    clear() {
      entries.clear();
    },
  };
}

export function markManualRecoveryConfirmed(
  store: RuntimeStateStore,
  sessionKey: string,
  confirmedAt = Date.now(),
): RuntimeState | undefined {
  return store.update(sessionKey, (state) => {
    if (!state || state.phase !== "waiting_return") return state;
    return { ...state, manualRecoveryConfirmedAt: confirmedAt };
  });
}

