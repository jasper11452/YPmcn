import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { registerHooks } from "./hooks/register.js";
import type { HookApi } from "./hooks/register.js";

export { runBeforeToolCallGuards, normalizeYpmcnToolName } from "./hooks/guards.js";
export { registerHooks } from "./hooks/register.js";
export { applyToolResult } from "./hooks/results.js";
export {
  createRuntimeStateStore,
  markManualRecoveryConfirmed,
} from "./hooks/runtime-state.js";
export type * from "./hooks/types.js";

const plugin: ReturnType<typeof definePluginEntry> = definePluginEntry({
  id: "ypmcn-media-assistant",
  name: "YPmcn 媒介助手",
  description: "按 mvp-v2 契约执行语义 ID 链路、人工门禁和可恢复回收状态机。",
  register(api) {
    registerHooks(api as unknown as HookApi);
  },
});

export default plugin;
