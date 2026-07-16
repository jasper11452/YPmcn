#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const MCP_PROFILES = Object.freeze({
  development: "http://192.168.0.129:32008/sse",
  production: "https://mcp.eshypdata.com/sse",
});

const specPath = fileURLToPath(new URL("../spec/mcp.json", import.meta.url));
const targets = [
  fileURLToPath(new URL("../YPmcn/.mcp.json", import.meta.url)),
  fileURLToPath(new URL("../YPmcn/mcp.json", import.meta.url)),
];

export function mcpConfig(profile) {
  const url = MCP_PROFILES[profile];
  if (!url) throw new Error(`Unknown MCP profile: ${profile}`);
  return {
    mcpServers: {
      "ypmcn-mcp": {
        url,
        transport: "sse",
        connectionTimeoutMs: 30000,
      },
    },
  };
}

export function writeMcpProfile(profile, paths = targets) {
  const url = MCP_PROFILES[profile];
  const config = `${JSON.stringify(mcpConfig(profile), null, 2)}\n`;
  for (const path of paths) writeFileSync(path, config);
  if (paths === targets) {
    const spec = readFileSync(specPath, "utf8")
      .replace(/"endpoint": "[^"]+"/, `"endpoint": "${url}"`)
      .replace(/"activeProfile": "[^"]+"/, `"activeProfile": "${profile}"`);
    writeFileSync(specPath, spec);
  }
  return url;
}

function parseProfile(args) {
  if (args.length !== 1 || !(args[0] in MCP_PROFILES)) {
    throw new Error("Usage: node scripts/set-mcp-profile.mjs <development|production>");
  }
  return args[0];
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  try {
    const profile = parseProfile(process.argv.slice(2));
    const url = writeMcpProfile(profile);
    process.stdout.write(`[mcp-profile] ${profile} ${url}\n`);
  } catch (error) {
    process.stderr.write(`[mcp-profile] FAIL ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
