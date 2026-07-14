#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

function deny(reason) {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  })}\n`);
}

function candidateRealpath(projectRoot, value) {
  const absolute = isAbsolute(value) ? resolve(value) : resolve(projectRoot, value);
  let existing = absolute;
  while (!existsSync(existing) && existing !== dirname(existing)) existing = dirname(existing);
  return resolve(realpathSync(existing), relative(existing, absolute));
}

function isWithin(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

const input = JSON.parse(readFileSync(0, "utf8"));
const projectRoot = realpathSync(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const toolName = input.tool_name;
const toolInput = input.tool_input ?? {};

if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(toolName)) {
  const filePath = toolInput.file_path ?? toolInput.notebook_path;
  if (!filePath) {
    deny("V2.2 path gate could not resolve the target file");
  } else {
    const candidate = candidateRealpath(projectRoot, filePath);
    const writableControlRoots = ["changes", "workflows/tasks"].map((path) => candidateRealpath(projectRoot, path));
    if (!isWithin(projectRoot, candidate) || !writableControlRoots.some((root) => isWithin(root, candidate))) {
      deny("Claude Orchestrator may directly write only changes/ and workflows/tasks/; dispatch production edits through agent-flow");
    }
  }
} else if (toolName === "Bash") {
  const command = String(toolInput.command ?? "");
  const controllerCommand = /^\s*npm\s+run\s+agent-flow\s+--\s+[^;&|><]+\s*$/.test(command);
  const approvedGeneratedWrite = /^\s*npm\s+run\s+docs:sync\s*$/.test(command);
  const obviousWrite = /(?:^|[;&|]\s*)(?:rm|mv|cp|install|mkdir|touch|tee|truncate|chmod|chown)\b|(?:^|\s)(?:sed|perl)\s+-i\b|(?:^|\s)(?:npm|pnpm|yarn)\s+(?:install|add|remove|update)\b|>>?|\bgit\s+(?:add|commit|merge|rebase|cherry-pick|reset|checkout|switch|clean|push)\b/.test(command);
  if (obviousWrite && !controllerCommand && !approvedGeneratedWrite) {
    deny("Claude Orchestrator shell writes must go through agent-flow; only docs:sync is an approved direct generated write");
  }
}
