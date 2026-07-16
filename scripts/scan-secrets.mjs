#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API_KEY_PREFIX = /\b(?:sk|sf)-[A-Za-z0-9][A-Za-z0-9_-]{15,}\b/i;
const ASSIGNMENT_NAME = /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*[:=]/g;
const QUOTED_ASSIGNMENT_NAME = /(["'])([A-Za-z_$][A-Za-z0-9_$]*)\1\s*[:=]/g;
const API_KEY_NAME = /(?:api_?key|apikey|access_?token|auth_?token|client_?secret|corp_?secret)/i;
const DB_PASSWORD_NAME = /^(?:password|(?:mysql|database|db)_?password)$/i;
const EXPLICIT_PLACEHOLDER = /^(?:<[^>]+>|\{\{[^}]+\}\}|redacted|replace[-_ ]?me|your[-_ ]?(?:api[-_ ]?key|password|token|secret)|(?:test|mock|fake|dummy)(?:[-_ ]?(?:api[-_ ]?key|key|password|token|secret))?|pass|password|secret|example|placeholder|[*x•]+)$/i;

function isPlaceholderOrDynamic(value) {
  const normalized = value.trim();
  if (!normalized) return true;
  if (/\$\{|\$[A-Za-z_{]|process\.env|import\.meta\.env|Deno\.env/i.test(normalized)) return true;
  return EXPLICIT_PLACEHOLDER.test(normalized);
}

function isCodeFile(file) {
  return /\.(?:[cm]?[jt]s|[jt]sx)$/i.test(file);
}

function skipWhitespace(text, start) {
  let index = start;
  while (index < text.length && /\s/.test(text[index])) index += 1;
  return index;
}

function readQuotedToken(text, start) {
  const quote = text[start];
  let escaped = false;
  let index = start + 1;
  let value = "";

  for (; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      value += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === quote) {
      break;
    } else {
      value += character;
    }
  }

  return { end: index, value };
}

function codeAssignmentCandidates(text) {
  const candidates = [];
  let index = 0;

  function appendTrackedTextCandidates(start, end) {
    for (const candidate of textAssignmentCandidates(text.slice(start, end))) {
      candidates.push({
        expressionStart: start + candidate.expressionStart,
        index: start + candidate.index,
        name: candidate.name,
      });
    }
  }

  while (index < text.length) {
    const character = text[index];

    if (character === "/" && text[index + 1] === "/") {
      const newline = text.indexOf("\n", index + 2);
      const end = newline === -1 ? text.length : newline;
      appendTrackedTextCandidates(index, end);
      index = newline === -1 ? text.length : newline + 1;
      continue;
    }
    if (character === "/" && text[index + 1] === "*") {
      const close = text.indexOf("*/", index + 2);
      const end = close === -1 ? text.length : close + 2;
      appendTrackedTextCandidates(index, end);
      index = end;
      continue;
    }

    if (character === "\"" || character === "'" || character === "`") {
      const { end, value } = readQuotedToken(text, index);
      if (character !== "`" && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)) {
        const separator = skipWhitespace(text, end + 1);
        if (text[separator] === ":" || text[separator] === "=") {
          candidates.push({
            expressionStart: separator + 1,
            index,
            name: value,
          });
        }
      }
      index = Math.min(text.length, end + 1);
      continue;
    }

    if (/[A-Za-z_$]/.test(character)) {
      const start = index;
      index += 1;
      while (index < text.length && /[A-Za-z0-9_$]/.test(text[index])) index += 1;
      const name = text.slice(start, index);
      const separator = skipWhitespace(text, index);
      if (text[separator] === ":" || text[separator] === "=") {
        candidates.push({
          expressionStart: separator + 1,
          index: start,
          name,
        });
      }
      continue;
    }

    index += 1;
  }

  return candidates;
}

function textAssignmentCandidates(text) {
  const candidates = [];
  for (const match of text.matchAll(ASSIGNMENT_NAME)) {
    const index = match.index ?? 0;
    candidates.push({
      expressionStart: index + match[0].length,
      index,
      name: match[1],
    });
  }
  for (const match of text.matchAll(QUOTED_ASSIGNMENT_NAME)) {
    const index = match.index ?? 0;
    candidates.push({
      expressionStart: index + match[0].length,
      index,
      name: match[2],
    });
  }

  const seen = new Set();
  return candidates
    .sort((left, right) => left.index - right.index)
    .filter((candidate) => {
      const key = `${candidate.index}:${candidate.expressionStart}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function assignmentCandidates(file, text) {
  return isCodeFile(file)
    ? codeAssignmentCandidates(text)
    : textAssignmentCandidates(text);
}

function readAssignmentExpression(text, start) {
  let depth = 0;
  let escaped = false;
  let index = start;
  let quote = null;
  let seenToken = false;

  for (; index < text.length; index += 1) {
    const character = text[index];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      seenToken = true;
      continue;
    }

    if (character === "\"" || character === "'" || character === "`") {
      let previous = index - 1;
      while (previous >= start && /[\t\r\n ]/.test(text[previous])) previous -= 1;
      const startsQuotedOperand = !seenToken || /[|&?+*/.=([{,:-]/.test(text[previous] ?? "");
      if (depth === 0 && !startsQuotedOperand) break;
      quote = character;
      seenToken = true;
      continue;
    }
    if (character === "(" || character === "[" || character === "{") {
      depth += 1;
      seenToken = true;
      continue;
    }
    if (character === ")" || character === "]" || character === "}") {
      if (depth === 0) break;
      depth -= 1;
      seenToken = true;
      continue;
    }
    if (depth === 0 && (character === "," || character === ";")) break;

    if (depth === 0 && character === "\n") {
      if (!seenToken) continue;

      let previous = index - 1;
      while (previous >= start && /[\t\r ]/.test(text[previous])) previous -= 1;
      let next = index + 1;
      while (next < text.length && /[\t\r ]/.test(text[next])) next += 1;
      const continuesBefore = /[|&?+*/.=([{,:-]/.test(text[previous] ?? "");
      const continuesAfter = /[|&?.]/.test(text[next] ?? "");
      if (continuesBefore || continuesAfter) continue;
      break;
    }

    if (!/\s/.test(character)) seenToken = true;
  }

  return { end: index, expression: text.slice(start, index) };
}

function literalValues(expression) {
  const source = expression
    .replace(/\brequiredEnv\s*\([^)]*\)/g, "")
    .replace(/\bDeno\.env\.get\s*\([^)]*\)/g, "")
    .replace(/\b(?:process\.env|import\.meta\.env)\s*\[[^\]]*\]/g, "");
  const values = [];
  const containers = [];

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "(") {
      let previous = index - 1;
      while (previous >= 0 && /\s/.test(source[previous])) previous -= 1;
      const isCall = /[A-Za-z0-9_$)\]]/.test(source[previous] ?? "");
      containers.push({ close: ")", opaque: isCall });
      continue;
    }
    if (character === "[" || character === "{") {
      containers.push({ close: character === "[" ? "]" : "}", opaque: true });
      continue;
    }
    if (character === ")" || character === "]" || character === "}") {
      if (containers.at(-1)?.close === character) containers.pop();
      continue;
    }
    if (character !== "\"" && character !== "'" && character !== "`") continue;

    const quote = character;
    const valueStart = index + 1;
    let escaped = false;
    index += 1;
    for (; index < source.length; index += 1) {
      if (escaped) {
        escaped = false;
      } else if (source[index] === "\\") {
        escaped = true;
      } else if (source[index] === quote) {
        break;
      }
    }
    let next = index + 1;
    while (next < source.length && /\s/.test(source[next])) next += 1;
    const methodCall = source.slice(next).match(/^(?:\?\.|\.)\s*[A-Za-z_$][A-Za-z0-9_$]*\s*\(([^)]*)\)/);
    const constructedFromArguments = methodCall && methodCall[1].trim().length > 0;
    const insideOpaqueContainer = containers.some(({ opaque }) => opaque);
    if (!insideOpaqueContainer && index < source.length && !constructedFromArguments) {
      values.push(source.slice(valueStart, index));
    }
  }

  return values;
}

function lineStarts(text) {
  const starts = [0];
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    starts.push(index + 1);
  }
  return starts;
}

function lineNumberAt(starts, index) {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle] <= index) low = middle + 1;
    else high = middle;
  }
  return low;
}

function scanText(file, text) {
  if (text.includes("\0")) return [];

  const findings = [];
  const findingKeys = new Set();
  const lines = text.split(/\r?\n/);
  const starts = lineStarts(text);
  const apiAssignmentLines = new Set();

  function addFinding(rule, line) {
    const key = `${rule}:${line}`;
    if (findingKeys.has(key)) return;
    findingKeys.add(key);
    findings.push({ file, rule, line });
  }

  for (const assignment of assignmentCandidates(file, text)) {
    const isApiKey = API_KEY_NAME.test(assignment.name);
    const isDbPassword = DB_PASSWORD_NAME.test(assignment.name);
    if (!isApiKey && !isDbPassword) continue;

    const assignmentIndex = assignment.index;
    const { end, expression } = readAssignmentExpression(text, assignment.expressionStart);
    const values = literalValues(expression);
    const line = lineNumberAt(starts, assignmentIndex);

    if (isApiKey) {
      const hasLiteral = API_KEY_PREFIX.test(expression)
        || values.some((value) => value.trim().length >= 16 && !isPlaceholderOrDynamic(value));
      if (hasLiteral) {
        addFinding("generic-api-key", line);
        const endLine = lineNumberAt(starts, end);
        for (let coveredLine = line; coveredLine <= endLine; coveredLine += 1) {
          apiAssignmentLines.add(coveredLine);
        }
      }
    }

    if (isDbPassword && values.some((value) => !isPlaceholderOrDynamic(value))) {
      addFinding("literal-db-password", line);
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (API_KEY_PREFIX.test(line) && !apiAssignmentLines.has(index + 1)) {
      addFinding("generic-api-key", index + 1);
    }
  }

  const ruleOrder = { "generic-api-key": 0, "literal-db-password": 1 };
  return findings.sort((left, right) => (
    left.line - right.line || ruleOrder[left.rule] - ruleOrder[right.rule]
  ));
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
  }).split("\0").filter((path) => {
    if (!path || !existsSync(path)) return false;
    const stat = lstatSync(path);
    return stat.isFile() || stat.isSymbolicLink();
  });
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
