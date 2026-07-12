#!/usr/bin/env node

import { existsSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const hookPath = ".githooks";

function git(args) {
  return spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
}

function skip(reason) {
  process.stdout.write(`[git-hooks] skipped: ${reason}\n`);
}

try {
  const discovered = git(["rev-parse", "--show-toplevel"]);
  if (discovered.status !== 0) {
    skip("not a Git working tree");
  } else if (realpathSync(discovered.stdout.trim()) !== realpathSync(repoRoot)) {
    skip("package is not the repository root");
  } else if (!existsSync(join(repoRoot, hookPath, "pre-commit"))) {
    throw new Error(`${hookPath}/pre-commit is missing`);
  } else {
    const configured = git(["config", "--local", "core.hooksPath", hookPath]);
    if (configured.status !== 0) throw new Error(configured.stderr.trim() || "git config failed");
    process.stdout.write(`[git-hooks] installed ${hookPath}\n`);
  }
} catch (error) {
  process.stderr.write(`[git-hooks] FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
