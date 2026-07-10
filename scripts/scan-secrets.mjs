#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API_KEY_PREFIX = /\b(?:sk|sf)-[A-Za-z0-9][A-Za-z0-9_-]{15,}\b/i;
const ASSIGNMENT_NAME = /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*[:=]/g;
const API_KEY_NAME = /(?:api_?key|apikey|access_?token|auth_?token|client_?secret|corp_?secret)/i;
const DB_PASSWORD_ASSIGNMENTS = [
  /\bpassword\b\s*:\s*(["'`])([^"'`\r\n]*)\1/i,
  /\b(?:mysql|database|db)_password\b\s*[:=]\s*(["'`])([^"'`\r\n]*)\1/i,
];

function isPlaceholderOrDynamic(value) {
  const normalized = value.trim();
  if (!normalized) return true;
  if (/\$\{|\$[A-Za-z_{]|process\.env|import\.meta\.env|Deno\.env/i.test(normalized)) return true;
  if (/^(?:<[^>]+>|\{\{[^}]+\}\}|REDACTED|REPLACE_ME|YOUR_(?:API_KEY|PASSWORD|TOKEN|SECRET)|[*x•]+)$/.test(normalized)) return true;
  if (/^(?:pass|password|secret)$/.test(normalized.toLowerCase())) return true;
  return /(?:example|placeholder|replace[_-]?me|test|mock|fake|dummy|your[_-]?(?:api[_-]?key|password))/i.test(normalized);
}

function hasLiteralApiKey(line) {
  if (API_KEY_PREFIX.test(line)) return true;

  const assignments = [...line.matchAll(ASSIGNMENT_NAME)]
    .filter((match) => API_KEY_NAME.test(match[1]));

  return assignments.some((assignment) => {
    const suffix = line.slice((assignment.index ?? 0) + assignment[0].length);
    const literalExpression = suffix
      .replace(/\brequiredEnv\s*\([^)]*\)/g, "")
      .replace(/\bDeno\.env\.get\s*\([^)]*\)/g, "")
      .replace(/\b(?:process\.env|import\.meta\.env)\s*\[[^\]]*\]/g, "");
    const values = [...literalExpression.matchAll(/(["'`])([^"'`\r\n]*)\1/g)].map((match) => match[2]);
    return values.some((value) => value.trim().length >= 16 && !isPlaceholderOrDynamic(value));
  });
}

function scanText(file, text) {
  if (text.includes("\0")) return [];

  const findings = [];
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (hasLiteralApiKey(line)) {
      findings.push({ file, rule: "generic-api-key", line: index + 1 });
    }

    const passwordMatch = DB_PASSWORD_ASSIGNMENTS
      .map((pattern) => line.match(pattern))
      .find(Boolean);
    if (passwordMatch && !isPlaceholderOrDynamic(passwordMatch[2])) {
      findings.push({ file, rule: "literal-db-password", line: index + 1 });
    }
  }

  return findings;
}

function isNpmTarball(path) {
  return path.endsWith(".tgz") || path.endsWith(".tar.gz");
}

function scanTarball(path) {
  const entries = execFileSync("tar", ["-tzf", path], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }).split(/\r?\n/).filter((entry) => entry && !entry.endsWith("/"));

  return entries.flatMap((entry) => {
    const content = execFileSync("tar", ["-xOzf", path, "--", entry], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return scanText(`${path}:${entry}`, content);
  });
}

export function scanPaths(paths) {
  return paths.flatMap((path) => (
    isNpmTarball(path)
      ? scanTarball(path)
      : scanText(path, readFileSync(path, "utf8"))
  ));
}

function trackedPaths() {
  return execFileSync("git", ["ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }).split("\0").filter((path) => path && existsSync(path));
}

function runCli(args) {
  const scanningTrackedFiles = args.length === 1 && args[0] === "--tracked";
  const paths = scanningTrackedFiles
    ? trackedPaths()
    : args;

  if (!scanningTrackedFiles && paths.length === 0) {
    console.error("Usage: node scripts/scan-secrets.mjs --tracked | <path...>");
    return 2;
  }

  const findings = scanPaths(paths);
  console.log(JSON.stringify(findings, null, 2));
  return findings.length === 0 ? 0 : 1;
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (entryPath === fileURLToPath(import.meta.url)) {
  process.exitCode = runCli(process.argv.slice(2));
}
