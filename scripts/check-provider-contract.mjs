#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const targetProfile = JSON.parse(
  readFileSync(new URL("../spec/mcp.json", import.meta.url), "utf8"),
);
const legacyProfile = JSON.parse(
  readFileSync(new URL("../spec/profiles/legacy-1.9.4.json", import.meta.url), "utf8"),
);
const PROTOCOL_VERSION = "2024-11-05";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function schemaHash(tools) {
  const schemas = tools
    .map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema ?? tool.input_schema ?? null }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return createHash("sha256").update(canonicalJson(schemas)).digest("hex");
}

function sameValue(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function pushDiff(diffs, tool, path, reason, expected, actual) {
  diffs.push({ tool, path, reason, expected, actual });
}

const COMPARED_SCHEMA_KEYS = [
  "type",
  "const",
  "enum",
  "format",
  "minLength",
  "minimum",
  "maximum",
  "minItems",
  "uniqueItems",
  "ordered",
];

function compareSchemaNode(tool, expected, actual, path, diffs) {
  if (!isRecord(actual)) {
    pushDiff(diffs, tool, path, "missing_schema", expected, actual ?? null);
    return;
  }
  for (const key of COMPARED_SCHEMA_KEYS) {
    const expectedHasKey = Object.prototype.hasOwnProperty.call(expected, key);
    const actualHasKey = Object.prototype.hasOwnProperty.call(actual, key);
    if (expectedHasKey !== actualHasKey || (expectedHasKey && !sameValue(expected[key], actual[key]))) {
      pushDiff(diffs, tool, `${path}.${key}`, "value_mismatch", expected[key], actual[key] ?? null);
    }
  }

  if (Array.isArray(expected.anyOf) || Array.isArray(actual.anyOf)) {
    if (!Array.isArray(actual.anyOf)) {
      pushDiff(diffs, tool, `${path}.anyOf`, "missing_schema", expected.anyOf, actual.anyOf ?? null);
    } else if (!Array.isArray(expected.anyOf)) {
      pushDiff(diffs, tool, `${path}.anyOf`, "unexpected_schema", null, actual.anyOf);
    } else if (actual.anyOf.length !== expected.anyOf.length) {
      pushDiff(
        diffs,
        tool,
        `${path}.anyOf`,
        "length_mismatch",
        expected.anyOf.length,
        actual.anyOf.length,
      );
    } else {
      for (let index = 0; index < expected.anyOf.length; index += 1) {
        compareSchemaNode(
          tool,
          expected.anyOf[index],
          actual.anyOf[index],
          `${path}.anyOf[${index}]`,
          diffs,
        );
      }
    }
  }

  if (Array.isArray(expected.required) || Array.isArray(actual.required)) {
    const actualRequired = Array.isArray(actual.required) ? actual.required : [];
    for (const key of expected.required) {
      if (!actualRequired.includes(key)) {
        pushDiff(diffs, tool, `${path}.required`, "missing_required", key, actualRequired);
      }
    }
    for (const key of actualRequired) {
      if (!expected.required.includes(key)) {
        pushDiff(diffs, tool, `${path}.required`, "unexpected_required", expected.required, key);
      }
    }
  }

  if (isRecord(expected.properties) || isRecord(actual.properties)) {
    const actualProperties = isRecord(actual.properties) ? actual.properties : {};
    for (const [key, expectedChild] of Object.entries(expected.properties)) {
      if (!Object.prototype.hasOwnProperty.call(actualProperties, key)) {
        pushDiff(diffs, tool, `${path}.properties.${key}`, "missing_property", expectedChild, null);
      } else {
        compareSchemaNode(tool, expectedChild, actualProperties[key], `${path}.properties.${key}`, diffs);
      }
    }
    for (const key of Object.keys(actualProperties)) {
      if (!Object.prototype.hasOwnProperty.call(expected.properties, key)) {
        pushDiff(diffs, tool, `${path}.properties.${key}`, "unexpected_property", null, actualProperties[key]);
      }
    }
  }

  if (expected.items !== undefined || actual.items !== undefined) {
    if (expected.items === undefined) {
      pushDiff(diffs, tool, `${path}.items`, "unexpected_schema", null, actual.items);
    } else {
      compareSchemaNode(tool, expected.items, actual.items, `${path}.items`, diffs);
    }
  }
  if (expected.additionalProperties !== undefined || actual.additionalProperties !== undefined) {
    if (expected.additionalProperties === undefined) {
      pushDiff(
        diffs,
        tool,
        `${path}.additionalProperties`,
        "unexpected_schema",
        null,
        actual.additionalProperties,
      );
    } else
    if (isRecord(expected.additionalProperties)) {
      compareSchemaNode(
        tool,
        expected.additionalProperties,
        actual.additionalProperties,
        `${path}.additionalProperties`,
        diffs,
      );
    } else if (actual.additionalProperties !== expected.additionalProperties) {
      pushDiff(
        diffs,
        tool,
        `${path}.additionalProperties`,
        "value_mismatch",
        expected.additionalProperties,
        actual.additionalProperties ?? null,
      );
    }
  }
}

function targetInputSchema(contract) {
  return {
    type: "object",
    required: contract.required,
    properties: contract.properties,
  };
}

function detectedProfile(toolNames, missingTools) {
  const legacyNames = legacyProfile.observedSummary.toolNames;
  const expectedGap = new Set(legacyProfile.missingTargetTools);
  const exactLegacyGap = missingTools.length === expectedGap.size &&
    missingTools.every((name) => expectedGap.has(name));
  const containsLegacySurface = legacyNames.every((name) => toolNames.has(name));
  if (exactLegacyGap && containsLegacySurface) return "legacy-1.9.4";
  if (missingTools.length === 0) return "current-endpoint";
  return "unknown";
}

export function compareProviderTools(tools) {
  if (!Array.isArray(tools)) throw new TypeError("Provider tools must be an array");
  const toolMap = new Map();
  for (const tool of tools) {
    if (!isRecord(tool) || typeof tool.name !== "string" || toolMap.has(tool.name)) continue;
    if (tool.name.startsWith("pgy")) continue;
    toolMap.set(tool.name, tool);
  }
  const missingTools = targetProfile.requiredTools.filter((name) => !toolMap.has(name));
  const schemaDiffs = [];

  for (const name of [...targetProfile.requiredTools, ...targetProfile.optionalTools]) {
    const providerTool = toolMap.get(name);
    if (!providerTool) continue;
    const providerSchema = providerTool.inputSchema ?? providerTool.input_schema;
    compareSchemaNode(
      name,
      targetInputSchema(targetProfile.tools[name]),
      providerSchema,
      "inputSchema",
      schemaDiffs,
    );
    const providerProperties = isRecord(providerSchema?.properties) ? providerSchema.properties : {};
    for (const forbidden of targetProfile.tools[name].forbidden ?? []) {
      if (Object.prototype.hasOwnProperty.call(providerProperties, forbidden)) {
        pushDiff(
          schemaDiffs,
          name,
          `inputSchema.properties.${forbidden}`,
          "forbidden_property",
          null,
          providerProperties[forbidden],
        );
      }
    }
  }

  return {
    status: missingTools.length === 0 && schemaDiffs.length === 0 ? "PASS" : "FAIL",
    detectedProfile: detectedProfile(new Set(toolMap.keys()), missingTools),
    missingTools,
    schemaDiffs,
    schemaHash: schemaHash([...toolMap.values()]),
  };
}

export function extractSnapshotTools(snapshot) {
  if (Array.isArray(snapshot)) return snapshot;
  if (isRecord(snapshot) && Array.isArray(snapshot.tools)) return snapshot.tools;
  if (isRecord(snapshot) && isRecord(snapshot.result) && Array.isArray(snapshot.result.tools)) {
    return snapshot.result.tools;
  }
  throw new TypeError("Expected a tools/list snapshot containing a tools array");
}

async function parseHttpRpcResponse(response) {
  if (response.status === 202 || response.status === 204) return undefined;
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
  const text = await response.text();
  if (text.trim().length === 0) return undefined;
  if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const dataLine = text.split(/\r?\n/).find((line) => line.startsWith("data:"));
    if (!dataLine) throw new Error("MCP SSE response did not contain data");
    return JSON.parse(dataLine.slice(5).trim());
  }
  return JSON.parse(text);
}

async function postRpc(url, message, fetchImpl, signal, sessionId) {
  const headers = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": PROTOCOL_VERSION,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const response = await fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify(message),
    signal,
  });
  return {
    message: await parseHttpRpcResponse(response),
    sessionId: response.headers.get("mcp-session-id") ?? sessionId,
  };
}

async function streamableHttpTools(url, fetchImpl, signal) {
  const initialized = await postRpc(url, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "ypmcn-provider-contract-checker", version: "3.0.0" },
    },
  }, fetchImpl, signal);
  if (!isRecord(initialized.message?.result)) throw new Error("Provider initialize response is invalid");

  await postRpc(url, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  }, fetchImpl, signal, initialized.sessionId);
  const listed = await postRpc(url, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  }, fetchImpl, signal, initialized.sessionId);
  return extractSnapshotTools(listed.message);
}

function createSseReader(response) {
  if (!response.body) throw new Error("Provider SSE response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  async function next() {
    while (true) {
      const separator = buffer.search(/\r?\n\r?\n/);
      if (separator >= 0) {
        const block = buffer.slice(0, separator);
        const separatorLength = buffer.slice(separator).startsWith("\r\n\r\n") ? 4 : 2;
        buffer = buffer.slice(separator + separatorLength);
        let event = "message";
        const data = [];
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          if (line.startsWith("data:")) data.push(line.slice(5).trim());
        }
        if (data.length > 0) return { event, data: data.join("\n") };
        continue;
      }
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Provider closed SSE before completing tools/list");
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  }
  return { next, cancel: () => reader.cancel() };
}

async function nextSseJson(sse, expectedId) {
  while (true) {
    const event = await sse.next();
    if (event.event !== "message") continue;
    const parsed = JSON.parse(event.data);
    if (parsed.id === expectedId) return parsed;
  }
}

async function legacySseTools(url, fetchImpl, signal) {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { accept: "text/event-stream" },
    signal,
  });
  if (!response.ok) throw new Error(`MCP SSE HTTP ${response.status}`);
  const sse = createSseReader(response);
  try {
    let endpoint;
    while (!endpoint) {
      const event = await sse.next();
      if (event.event === "endpoint") endpoint = new URL(event.data, url).href;
    }
    const send = async (message) => {
      const posted = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message),
        signal,
      });
      if (!posted.ok) throw new Error(`MCP SSE message HTTP ${posted.status}`);
    };
    await send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "ypmcn-provider-contract-checker", version: "3.0.0" },
      },
    });
    const initialized = await nextSseJson(sse, 1);
    if (!isRecord(initialized.result)) throw new Error("Provider initialize response is invalid");
    await send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    await send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    return extractSnapshotTools(await nextSseJson(sse, 2));
  } finally {
    await sse.cancel();
  }
}

export async function checkProviderUrl(url, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("No fetch implementation is available");
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 15_000;
  const timeout = setTimeout(() => controller.abort(new Error("Provider contract check timed out")), timeoutMs);
  try {
    const parsedUrl = new URL(url);
    const tools = parsedUrl.pathname.endsWith("/sse")
      ? await legacySseTools(parsedUrl.href, fetchImpl, controller.signal)
      : await streamableHttpTools(parsedUrl.href, fetchImpl, controller.signal);
    return compareProviderTools(tools);
  } finally {
    clearTimeout(timeout);
  }
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--url" || arg === "--snapshot") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      options[arg.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (Boolean(options.url) === Boolean(options.snapshot)) {
    throw new Error("Use exactly one of --url or --snapshot");
  }
  return options;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = options.snapshot
      ? compareProviderTools(extractSnapshotTools(JSON.parse(readFileSync(options.snapshot, "utf8"))))
      : await checkProviderUrl(options.url);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.status === "PASS" ? 0 : 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      status: "ERROR",
      message: error instanceof Error ? error.message : String(error),
    }, null, 2)}\n`);
    process.exitCode = 2;
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) await main();
