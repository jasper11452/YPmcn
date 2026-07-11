import { runBeforeToolCallGuards } from "./guards.js";
import { applyToolResult } from "./results.js";
import {
  createRuntimeStateStore,
  markManualRecoveryConfirmed,
} from "./runtime-state.js";
import type {
  GateState,
  RecoveryTrigger,
  RuntimeState,
  RuntimeStateStore,
} from "./types.js";

type HookHandler = (
  event: Record<string, unknown>,
  context?: Record<string, unknown>,
) => unknown;

export interface HookApi {
  on(
    name: string,
    handler: HookHandler,
    options?: Record<string, unknown>,
  ): void;
}

export interface RegisterHooksOptions {
  store?: RuntimeStateStore;
  now?: () => number;
}

const DEFAULT_HOOK_OPTIONS = { priority: 90, timeoutMs: 5_000 };
const MANUAL_RECOVERY_MESSAGES = new Set([
  "继续回收",
  "现在回收",
  "提前回收",
  "继续回收。",
  "现在回收。",
  "提前回收。",
  "继续回收！",
  "现在回收！",
  "提前回收！",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find(nonemptyString) as string | undefined;
}

function resolveSessionKey(
  event: Record<string, unknown>,
  context?: Record<string, unknown>,
): string | undefined {
  return firstString(
    context?.sessionKey,
    context?.sessionId,
    event.sessionKey,
    event.sessionId,
  );
}

function paramsFromEvent(event: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(event.params)) return event.params;
  if (isRecord(event.arguments)) return event.arguments;
  if (isRecord(event.input)) return event.input;
  return {};
}

function booleanFrom(source: Record<string, unknown> | undefined, ...keys: string[]): boolean | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    if (typeof source[key] === "boolean") return source[key] as boolean;
  }
  return undefined;
}

function gateStateFrom(
  event: Record<string, unknown>,
  context?: Record<string, unknown>,
): GateState | undefined {
  const source = isRecord(event.gateState)
    ? event.gateState
    : isRecord(context?.gateState)
      ? context.gateState
      : isRecord(context?.confirmations)
        ? context.confirmations
        : undefined;
  if (!source) return undefined;
  return {
    supplyConfirmed: booleanFrom(source, "supplyConfirmed", "supply_confirmed"),
    mcnConfirmed: booleanFrom(source, "mcnConfirmed", "mcn_confirmed"),
    messageConfirmed: booleanFrom(source, "messageConfirmed", "message_confirmed"),
  };
}

function recoveryTriggerFrom(
  event: Record<string, unknown>,
  context?: Record<string, unknown>,
): RecoveryTrigger | undefined {
  const value = event.recoveryTrigger ?? event.recovery_trigger ??
    context?.recoveryTrigger ?? context?.recovery_trigger;
  return value === "manual" || value === "scheduled" ? value : undefined;
}

function resolveStructuredContent(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (isRecord(value.details) && isRecord(value.details.structuredContent)) {
    return value.details.structuredContent;
  }
  if (isRecord(value.structuredContent)) return value.structuredContent;
  return value;
}

function resultFromEvent(event: Record<string, unknown>): unknown {
  if (event.result !== undefined) return resolveStructuredContent(event.result);
  if (isRecord(event.message)) return resolveStructuredContent(event.message);
  return event;
}

function messageText(event: Record<string, unknown>): string | undefined {
  if (nonemptyString(event.content)) return event.content.trim();
  if (nonemptyString(event.text)) return event.text.trim();
  if (isRecord(event.message)) {
    return firstString(event.message.content, event.message.text)?.trim();
  }
  return undefined;
}

function isExplicitManualRecovery(event: Record<string, unknown>): boolean {
  if (event.manualRecoveryConfirmed === true || event.manual_recovery_confirmed === true) {
    return true;
  }
  const content = messageText(event);
  return content !== undefined && MANUAL_RECOVERY_MESSAGES.has(content);
}

function stateSummary(state: RuntimeState): string {
  const safeEntries: Array<[string, unknown]> = [
    ["phase", state.phase],
    ["requirement_id", state.requirement_id],
    ["candidate_pool_id", state.candidate_pool_id],
    ["mcn_recommendation_id", state.mcn_recommendation_id],
    ["inquiry_batch_id", state.inquiry_batch_id],
    ["run_id", state.run_id],
    ["batch_no", state.batch_no],
  ];
  const lines = safeEntries
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${String(value)}`);
  return ["[YPmcn mvp-v2 会话投影]", ...lines].join("\n");
}

export function registerHooks(api: HookApi, options: RegisterHooksOptions = {}): RuntimeStateStore {
  const now = options.now ?? Date.now;
  const store = options.store ?? createRuntimeStateStore({ now });

  api.on(
    "before_tool_call",
    async (event, context) => {
      const toolName = firstString(event.toolName, event.name) ?? "";
      return runBeforeToolCallGuards({
        toolName,
        params: paramsFromEvent(event),
        sessionKey: resolveSessionKey(event, context),
        toolCallId: firstString(
          event.toolCallId,
          event.tool_call_id,
          context?.toolCallId,
          context?.tool_call_id,
        ),
        operatorRole: firstString(
          event.operatorRole,
          event.operator_role,
          context?.operatorRole,
          context?.operator_role,
        ),
        nowMs: now(),
        trigger: firstString(event.trigger, context?.trigger),
        recoveryTrigger: recoveryTriggerFrom(event, context),
        gateState: gateStateFrom(event, context),
        store,
      });
    },
    DEFAULT_HOOK_OPTIONS,
  );

  api.on(
    "after_tool_call",
    async (event, context) => {
      const toolName = firstString(event.toolName, event.name) ?? "";
      applyToolResult({
        sessionKey: resolveSessionKey(event, context),
        toolName,
        params: paramsFromEvent(event),
        result: resultFromEvent(event),
        nowMs: now(),
        trigger: firstString(event.trigger, context?.trigger),
        recoveryTrigger: recoveryTriggerFrom(event, context),
        store,
      });
    },
    DEFAULT_HOOK_OPTIONS,
  );

  // Persistence must never rewrite provider/MCP evidence. State projection is
  // updated by after_tool_call and remains deliberately separate.
  api.on(
    "tool_result_persist",
    async () => undefined,
    DEFAULT_HOOK_OPTIONS,
  );

  api.on(
    "message_received",
    async (event, context) => {
      const sessionKey = resolveSessionKey(event, context);
      if (!sessionKey || !isExplicitManualRecovery(event)) return;
      markManualRecoveryConfirmed(store, sessionKey, now());
    },
    DEFAULT_HOOK_OPTIONS,
  );

  api.on(
    "agent_turn_prepare",
    async (event, context) => {
      const sessionKey = resolveSessionKey(event, context);
      if (!sessionKey) return undefined;
      const state = store.get(sessionKey);
      if (!state) return undefined;
      return { prependContext: stateSummary(state) };
    },
    DEFAULT_HOOK_OPTIONS,
  );

  api.on(
    "session_end",
    async (event, context) => {
      const sessionKey = resolveSessionKey(event, context);
      if (sessionKey) store.delete(sessionKey);
    },
    DEFAULT_HOOK_OPTIONS,
  );

  return store;
}

