import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const plugin: ReturnType<typeof definePluginEntry> = definePluginEntry({
  id: "ypmcn-media-assistant",
  name: "YPmcn 媒介助手",
  description: "按 mvp-v2 契约执行语义 ID 链路、人工门禁和可恢复回收状态机。Python PreToolUse/PostToolUse hooks 由 .claude/settings.json 挂载。",
  register(_api) {},
});

export default plugin;
