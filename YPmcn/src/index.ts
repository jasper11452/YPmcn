import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { afterTool, beforeTool, endSession } from "./runtime-hooks.js";

const plugin: ReturnType<typeof definePluginEntry> = definePluginEntry({
  id: "ypmcn-media-assistant",
  name: "YPmcn 媒介助手",
  description: "按 mvp-v2 契约执行语义 ID 链路、人工门禁和可恢复回收状态机。",
  register(api) {
    const rootDir = api.rootDir ?? process.cwd();
    api.on("before_tool_call", async (event, ctx) => {
      try {
        return beforeTool(event, ctx, rootDir);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        api.logger.error(`pre_tool_guard failed: ${reason}`);
        return { block: true, blockReason: `YPmcn guard unavailable: ${reason}` };
      }
    });

    api.on("after_tool_call", async (event, ctx) => {
      try {
        afterTool(event, ctx, rootDir);
      } catch (error) {
        api.logger.error(`post_tool_update failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    api.on("session_end", async (event, ctx) => {
      try {
        endSession(event, ctx, rootDir);
      } catch (error) {
        api.logger.error(`session_cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  },
});

export default plugin;
