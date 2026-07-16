#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const serverEntry = fileURLToPath(new URL("../vector-mcp/dist/server.js", import.meta.url));
const child = spawn(process.execPath, [serverEntry], {
  cwd: repoRoot,
  env: { ...process.env, VECTOR_MCP_MODE: process.env.VECTOR_MCP_MODE || "local" },
  stdio: ["pipe", "pipe", "pipe"],
});

const pending = new Map();
let nextId = 1;
let stderr = "";
let exited;

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr += chunk; });
child.on("exit", (code, signal) => {
  exited = { code, signal };
  for (const { reject } of pending.values()) {
    reject(new Error(`MCP server exited early: code=${String(code)} signal=${String(signal)}\n${stderr}`));
  }
  pending.clear();
});

createInterface({ input: child.stdout }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    for (const { reject } of pending.values()) reject(new Error(`Non-JSON MCP stdout: ${line}`));
    pending.clear();
    return;
  }
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(`${message.error.code}: ${message.error.message}`));
  else waiter.resolve(message.result);
});

function request(method, params) {
  if (exited) return Promise.reject(new Error(`MCP server is not running: ${JSON.stringify(exited)}`));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}`));
    }, 5_000);
    pending.set(id, {
      resolve(value) { clearTimeout(timer); resolve(value); },
      reject(error) { clearTimeout(timer); reject(error); },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

try {
  const initialized = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "ypmcn-local-smoke", version: "1" },
  });
  assert.equal(initialized.protocolVersion, "2024-11-05");
  assert.equal(initialized.serverInfo.name, "vector-mcp");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  const listed = await request("tools/list", {});
  assert.ok(Array.isArray(listed.tools) && listed.tools.length > 0, "tools/list returned no tools");
  for (const tool of listed.tools) {
    assert.equal(typeof tool.name, "string");
    assert.equal(tool.inputSchema?.type, "object", `${tool.name} has no object inputSchema`);
  }
  process.stdout.write(`[smoke:mcp] PASS protocol=2024-11-05 tools=${listed.tools.length}\n`);
} catch (error) {
  process.stderr.write(`[smoke:mcp] FAIL ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  child.stdin.end();
  setTimeout(() => child.kill("SIGTERM"), 1_000).unref();
}
