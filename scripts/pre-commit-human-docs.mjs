#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { collectHumanDocDrift, syncHumanDocs } from "./sync-human-docs.mjs";

const humanDocs = ["docs/README.md", "docs/PROJECT_MAP.md", "docs/EVOLUTION.md"];

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  return result.stdout;
}

function pathsFromNullDelimited(source) {
  return source.split("\0").filter(Boolean);
}

function isProposal(path) {
  return /^changes\/CHG-\d{4}-\d{3}-.+\.md$/.test(path) && !path.endsWith("-impact.md");
}

function isHumanDocSource(path) {
  return path.startsWith("spec/") || isProposal(path);
}

function isProtectedPath(path) {
  return isHumanDocSource(path) || humanDocs.includes(path);
}

try {
  const repoRoot = git(["rev-parse", "--show-toplevel"], process.cwd()).trim();
  const staged = pathsFromNullDelimited(git([
    "diff",
    "--cached",
    "--name-only",
    "--diff-filter=ACMRD",
    "-z",
  ], repoRoot));
  const stagedSources = staged.filter(isHumanDocSource);

  if (stagedSources.length === 0) {
    process.stdout.write("[human-docs] no relevant staged changes\n");
  } else {
    const unstaged = pathsFromNullDelimited(git([
      "diff",
      "--name-only",
      "--diff-filter=ACMRD",
      "-z",
      "--",
      "spec",
      "changes",
      ...humanDocs,
    ], repoRoot)).filter(isProtectedPath);
    const untracked = pathsFromNullDelimited(git([
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      "spec",
      "changes",
      ...humanDocs,
    ], repoRoot)).filter(isProtectedPath);
    const unsafe = [...new Set([...unstaged, ...untracked])].sort();
    if (unsafe.length > 0) {
      throw new Error(`unsafe human-doc source state; stage or remove these paths first: ${unsafe.join(", ")}`);
    }

    const updated = syncHumanDocs(repoRoot);
    git(["add", "--", ...humanDocs], repoRoot);
    const drift = collectHumanDocDrift(repoRoot);
    if (drift.length > 0) throw new Error(`human docs remain stale: ${drift.join(", ")}`);
    process.stdout.write(`[human-docs] pre-commit synchronized${updated.length > 0 ? `: ${updated.join(", ")}` : ""}\n`);
  }
} catch (error) {
  process.stderr.write(`[human-docs] pre-commit FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
