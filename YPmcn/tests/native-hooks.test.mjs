import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import plugin from "../dist/index.js";

const pluginRoot = new URL("..", import.meta.url).pathname;
const tempDir = mkdtempSync(join(tmpdir(), "ypmcn-native-hooks-"));
const stateFile = join(tempDir, "session_guard.json");
const hooks = new Map();

before(() => {
  process.env.YPMCN_STATE_FILE = stateFile;
  plugin.register({
    rootDir: pluginRoot,
    logger: { error() {} },
    on(name, handler) { hooks.set(name, handler); },
  });
});

after(() => {
  delete process.env.YPMCN_STATE_FILE;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("OpenClaw native hook bridge", () => {
  it("registers the supported tool and session hooks", () => {
    assert.deepEqual([...hooks.keys()].sort(), ["after_tool_call", "before_tool_call", "session_end"]);
  });

  it("blocks a provider write attempted through shell", async () => {
    const result = await hooks.get("before_tool_call")({
      toolName: "Bash",
      params: { command: "curl -X POST https://api/create-with-distributions" },
      toolCallId: "call-1",
    }, { sessionKey: "native-session" });
    assert.equal(result.block, true);
    assert.match(result.blockReason, /INTEGRATION_REQUIRED/);
  });

  it("projects a successful MCP result and cleans the ended session", async () => {
    await hooks.get("after_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params: { payload: { raw: "brief" } },
      toolCallId: "call-2",
      result: { success: true, data: { id: "req-native-1" } },
    }, { sessionKey: "native-session" });

    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.sessions["native-session"].phase, "requirement_ready");
    assert.equal(state.sessions["native-session"].ids.requirement_id, "req-native-1");

    await hooks.get("session_end")({
      sessionId: "native-session-id",
      sessionKey: "native-session",
      messageCount: 1,
    }, { sessionKey: "native-session" });
    const cleaned = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(cleaned.sessions["native-session"], undefined);
  });
});
