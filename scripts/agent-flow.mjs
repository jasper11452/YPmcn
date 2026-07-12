#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const defaultRepoRoot = fileURLToPath(new URL("..", import.meta.url));
const defaultProfilePath = join(defaultRepoRoot, "workflows/codex-profiles.json");
const maxParallelWriters = 2;
const activeWriterStatuses = new Set(["DISPATCHED", "EXECUTING"]);
const completedDependencyStatuses = new Set(["MERGED", "ARCHIVED"]);
const runStatuses = new Set([
  "READY",
  "DISPATCHED",
  "EXECUTING",
  "EXECUTOR_DONE",
  "VERIFYING",
  "PASS",
  "FAIL",
  "BLOCKED",
  "REWORK_READY",
  "MERGE_READY",
  "MERGED",
  "ARCHIVED",
]);

const transitions = {
  READY: new Set(["DISPATCHED", "BLOCKED"]),
  DISPATCHED: new Set(["EXECUTING", "BLOCKED"]),
  EXECUTING: new Set(["EXECUTOR_DONE", "FAIL", "BLOCKED"]),
  EXECUTOR_DONE: new Set(["VERIFYING", "REWORK_READY", "BLOCKED"]),
  VERIFYING: new Set(["PASS", "FAIL", "BLOCKED"]),
  PASS: new Set(["MERGE_READY", "BLOCKED"]),
  FAIL: new Set(["REWORK_READY", "BLOCKED"]),
  BLOCKED: new Set(["REWORK_READY"]),
  REWORK_READY: new Set(["DISPATCHED", "BLOCKED"]),
  MERGE_READY: new Set(["MERGED", "BLOCKED"]),
  MERGED: new Set(["ARCHIVED"]),
  ARCHIVED: new Set(),
};

export const pinnedCodexProfiles = Object.freeze({
  "executor-sol-max-fast": Object.freeze({
    model: "gpt-5.6-sol",
    model_reasoning_effort: "max",
    service_tier: "fast",
    sandbox_mode: "workspace-write",
    approval_policy: "never",
  }),
  "executor-terra-max-fast": Object.freeze({
    model: "gpt-5.6-terra",
    model_reasoning_effort: "max",
    service_tier: "fast",
    sandbox_mode: "workspace-write",
    approval_policy: "never",
  }),
  "executor-terra-medium-fast": Object.freeze({
    model: "gpt-5.6-terra",
    model_reasoning_effort: "medium",
    service_tier: "fast",
    sandbox_mode: "workspace-write",
    approval_policy: "never",
  }),
});

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function atomicWrite(path, source) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, source, { mode: 0o600 });
  renameSync(temporary, path);
}

function asError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? defaultRepoRoot,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: options.timeout,
    stdio: options.inherit ? "inherit" : "pipe",
  });
  if (result.error && !options.allowFailure) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${String(result.status)}${details ? `\n${details}` : ""}`);
  }
  return result;
}

export function runJsonlProcess(command, args, options) {
  const {
    cwd = defaultRepoRoot,
    env = {},
    outputPath,
    onEvent = () => {},
    onSpawn = () => {},
  } = options;
  atomicWrite(outputPath, "");
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      onSpawn(child.pid);
    } catch (error) {
      child.kill("SIGTERM");
      rejectPromise(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    let pendingLine = "";
    let callbackError = null;
    let settled = false;

    function consumeLine(line) {
      if (!line.trim()) return;
      try {
        onEvent(JSON.parse(line));
      } catch (error) {
        if (error instanceof SyntaxError) return;
        callbackError = asError(error);
        child.kill("SIGTERM");
      }
    }

    child.stdout.on("data", (chunk) => {
      appendFileSync(outputPath, chunk);
      const text = chunk.toString("utf8");
      stdout += text;
      pendingLine += text;
      const lines = pendingLine.split(/\r?\n/);
      pendingLine = lines.pop() ?? "";
      for (const line of lines) consumeLine(line);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    });
    child.once("close", (status, signal) => {
      if (settled) return;
      settled = true;
      if (pendingLine) consumeLine(pendingLine);
      if (callbackError) rejectPromise(callbackError);
      else resolvePromise({ status, signal, stdout, stderr });
    });
  });
}

function git(repoRoot, args, options = {}) {
  return run("git", args, { cwd: repoRoot, ...options });
}

function gitText(repoRoot, args) {
  return git(repoRoot, args).stdout.trim();
}

function safeTaskId(taskId) {
  if (!/^[A-Za-z0-9._-]+$/.test(taskId)) throw new Error(`unsafe task_id: ${taskId}`);
  return taskId;
}

export function assertProjectIdentity(repoRoot = defaultRepoRoot) {
  const topLevel = gitText(repoRoot, ["rev-parse", "--show-toplevel"]);
  if (realpathSync(topLevel) !== realpathSync(repoRoot)) {
    throw new Error(`agent-flow must run from a YPmcn worktree root, got ${topLevel}`);
  }
  const packageJson = readJson(join(repoRoot, "package.json"));
  const manifest = readJson(join(repoRoot, "spec/manifest.json"));
  const orchestratorSource = readFileSync(join(repoRoot, "CLAUDE.md"), "utf8");
  if (packageJson.name !== "ypmcn-contract-first-automation"
    || manifest.schemaVersion !== 1
    || manifest.profile !== "mvp-v2"
    || manifest.status !== "approved"
    || !orchestratorSource.includes("npm run agent-flow -- status --json")) {
    throw new Error("agent-flow project identity check failed");
  }
  return {
    git_root: topLevel,
    package_name: packageJson.name,
    spec_profile: manifest.profile,
    spec_status: manifest.status,
  };
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

export function loadProfileWhitelist(profilePath = defaultProfilePath) {
  const source = readJson(profilePath);
  if (source.schema_version !== 1 || !source.profiles || typeof source.profiles !== "object") {
    throw new Error(`${profilePath} must define schema_version=1 and profiles`);
  }
  const expectedNames = Object.keys(pinnedCodexProfiles);
  const actualNames = Object.keys(source.profiles);
  if (JSON.stringify([...actualNames].sort()) !== JSON.stringify([...expectedNames].sort())) {
    throw new Error(`Codex profile whitelist must contain exactly: ${expectedNames.join(", ")}`);
  }
  for (const name of expectedNames) {
    const profile = source.profiles[name];
    const expected = pinnedCodexProfiles[name];
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
      throw new Error(`${name} must be an object`);
    }
    const expectedKeys = Object.keys(expected);
    if (JSON.stringify(Object.keys(profile).sort()) !== JSON.stringify([...expectedKeys].sort())) {
      throw new Error(`${name} must contain exactly: ${expectedKeys.join(", ")}`);
    }
    for (const key of expectedKeys) {
      if (profile[key] !== expected[key]) {
        throw new Error(`${name}.${key} must equal ${expected[key]} (case-sensitive)`);
      }
    }
  }
  return source;
}

export function renderCodexProfile(profile) {
  return [
    `model = ${tomlString(profile.model)}`,
    `model_reasoning_effort = ${tomlString(profile.model_reasoning_effort)}`,
    `service_tier = ${tomlString(profile.service_tier)}`,
    `sandbox_mode = ${tomlString(profile.sandbox_mode)}`,
    `approval_policy = ${tomlString(profile.approval_policy)}`,
    "",
  ].join("\n");
}

export function installCodexProfiles({
  codexHome = process.env.CODEX_HOME || join(homedir(), ".codex"),
  profilePath = defaultProfilePath,
} = {}) {
  const whitelist = loadProfileWhitelist(profilePath);
  mkdirSync(codexHome, { recursive: true });
  return Object.entries(whitelist.profiles).map(([name, profile]) => {
    const path = join(codexHome, `${name}.config.toml`);
    atomicWrite(path, renderCodexProfile(profile));
    return path;
  });
}

function collectCatalogModels(value, output = []) {
  if (Array.isArray(value)) value.forEach((entry) => collectCatalogModels(entry, output));
  else if (value && typeof value === "object") {
    if (isNonemptyString(value.slug)) output.push(value);
    for (const entry of Object.values(value)) collectCatalogModels(entry, output);
  }
  return output;
}

export function assessProfileCatalog(catalog, whitelist = loadProfileWhitelist()) {
  const bySlug = new Map(collectCatalogModels(catalog).map((model) => [model.slug, model]));
  return Object.fromEntries(Object.entries(whitelist.profiles).map(([name, profile]) => {
    const model = bySlug.get(profile.model);
    const efforts = Array.isArray(model?.supported_reasoning_levels)
      ? model.supported_reasoning_levels.map((entry) => entry?.effort).filter(isNonemptyString)
      : [];
    return [name, {
      model: profile.model,
      listed_exactly: Boolean(model),
      reasoning_effort: profile.model_reasoning_effort,
      reasoning_supported: Boolean(model) && efforts.includes(profile.model_reasoning_effort),
    }];
  }));
}

function inspectCodexCatalog(whitelist) {
  const result = run("codex", ["debug", "models"], { cwd: defaultRepoRoot });
  return assessProfileCatalog(JSON.parse(result.stdout), whitelist);
}

export function loadTaskFile(path) {
  const task = parseYaml(readFileSync(path, "utf8"));
  if (!task || typeof task !== "object" || Array.isArray(task)) throw new Error(`${path} must contain one task object`);
  Object.defineProperty(task, "__path", { value: path, enumerable: false });
  return task;
}

export function loadTasks(repoRoot = defaultRepoRoot) {
  const tasksRoot = join(repoRoot, "workflows/tasks");
  if (!existsSync(tasksRoot)) return [];
  const tasks = readdirSync(tasksRoot)
    .filter((name) => /\.ya?ml$/i.test(name))
    .sort()
    .map((name) => loadTaskFile(join(tasksRoot, name)));
  const seen = new Set();
  for (const task of tasks) {
    if (seen.has(task.task_id)) throw new Error(`duplicate task_id: ${String(task.task_id)}`);
    seen.add(task.task_id);
  }
  return tasks;
}

function primaryWorktreeRoot(repoRoot) {
  const result = git(repoRoot, ["worktree", "list", "--porcelain"], { allowFailure: true });
  if (result.status !== 0) return resolve(repoRoot);
  const first = result.stdout.match(/^worktree (.+)$/m)?.[1];
  return resolve(first ?? repoRoot);
}

function normalizePattern(pattern) {
  return String(pattern).replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

function staticPrefix(pattern) {
  const normalized = normalizePattern(pattern);
  const wildcard = normalized.search(/[?*[]/);
  return wildcard < 0 ? normalized : normalized.slice(0, wildcard);
}

function hasWildcard(pattern) {
  return /[?*[]/.test(pattern);
}

export function patternsMayOverlap(left, right) {
  const a = normalizePattern(left);
  const b = normalizePattern(right);
  if (a === b) return true;
  if (!hasWildcard(a) && !hasWildcard(b)) return false;
  const prefixA = staticPrefix(a);
  const prefixB = staticPrefix(b);
  if (!prefixA || !prefixB) return true;
  return prefixA === prefixB
    || prefixA.startsWith(prefixB)
    || prefixB.startsWith(prefixA);
}

function globRegex(pattern) {
  const source = normalizePattern(pattern);
  let output = "^";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "*" && source[index + 1] === "*") {
      output += ".*";
      index += 1;
    } else if (character === "*") {
      output += "[^/]*";
    } else if (character === "?") {
      output += "[^/]";
    } else if ("\\^$+?.()|{}[]".includes(character)) {
      output += `\\${character}`;
    } else {
      output += character;
    }
  }
  return new RegExp(`${output}$`);
}

export function pathMatchesPattern(path, pattern) {
  return globRegex(pattern).test(normalizePattern(path));
}

function isNonemptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value, { nonempty = false } = {}) {
  return Array.isArray(value)
    && (!nonempty || value.length > 0)
    && value.every((entry) => isNonemptyString(entry));
}

function isSafeRepoPattern(pattern) {
  if (!isNonemptyString(pattern) || isAbsolute(pattern)) return false;
  const normalized = normalizePattern(pattern);
  return normalized !== ".." && !normalized.startsWith("../") && !normalized.includes("/../");
}

export function validateTaskDefinition(
  task,
  {
    repoRoot = defaultRepoRoot,
    profilePath = defaultProfilePath,
  } = {},
) {
  const errors = [];
  for (const key of [
    "task_id",
    "change_id",
    "change_type",
    "goal",
    "approved_spec_version",
    "change_proposal",
    "impact_analysis",
    "risk_level",
    "execution_profile",
    "profile_reason",
    "rollback",
    "branch",
    "worktree",
    "next_action",
  ]) {
    if (!isNonemptyString(task[key])) errors.push(`${key} must be a nonempty string`);
  }
  for (const key of ["depends_on", "conflicts_with"]) {
    if (!isStringArray(task[key])) errors.push(`${key} must be an array of strings`);
  }
  for (const key of ["allowed_paths", "forbidden_paths", "acceptance", "verification"]) {
    if (!isStringArray(task[key], { nonempty: true })) errors.push(`${key} must be a nonempty array of strings`);
  }
  for (const key of ["allowed_paths", "forbidden_paths"]) {
    if (Array.isArray(task[key]) && task[key].some((pattern) => !isSafeRepoPattern(pattern))) {
      errors.push(`${key} must contain repository-relative patterns without '..' traversal`);
    }
  }
  if (task.change_status !== "SPEC_APPROVED") errors.push("change_status must be SPEC_APPROVED");
  if (!runStatuses.has(task.run_status)) errors.push(`unknown run_status: ${String(task.run_status)}`);
  if (!new Set(["low", "medium", "high", "critical"]).has(task.risk_level)) {
    errors.push(`unknown risk_level: ${String(task.risk_level)}`);
  }
  try {
    safeTaskId(task.task_id ?? "");
  } catch (error) {
    errors.push(asError(error).message);
  }
  if (!Number.isInteger(task.attempt) || task.attempt < 1) errors.push("attempt must be a positive integer");
  if (task.depends_on?.includes(task.task_id) || task.conflicts_with?.includes(task.task_id)) {
    errors.push("task must not depend on or conflict with itself");
  }
  if (!isAbsolute(task.worktree ?? "")) errors.push("worktree must be an absolute path");
  if (isAbsolute(task.worktree ?? "") && resolve(task.worktree) === primaryWorktreeRoot(repoRoot)) {
    errors.push("worktree must not equal repository root");
  }
  if (isAbsolute(task.worktree ?? "")) {
    const primary = primaryWorktreeRoot(repoRoot);
    const fromPrimary = relative(primary, resolve(task.worktree));
    if (fromPrimary && !fromPrimary.startsWith("..") && !isAbsolute(fromPrimary)) {
      errors.push("worktree must be outside the primary repository root");
    }
  }
  if (isNonemptyString(task.branch) && !task.branch.startsWith("codex/")) errors.push("branch must start with codex/");
  if (task.base_sha !== null && task.base_sha !== undefined && !/^[0-9a-f]{40}$/.test(task.base_sha)) {
    errors.push("base_sha must be null or a full lowercase SHA");
  }
  try {
    const whitelist = loadProfileWhitelist(profilePath);
    if (!Object.hasOwn(whitelist.profiles, task.execution_profile)) {
      errors.push(`unknown execution_profile: ${String(task.execution_profile)}`);
    }
  } catch (error) {
    errors.push(asError(error).message);
  }
  if (Array.isArray(task.allowed_paths) && Array.isArray(task.forbidden_paths)) {
    const overlaps = [];
    for (const allowed of task.allowed_paths) {
      for (const forbidden of task.forbidden_paths) {
        if (patternsMayOverlap(allowed, forbidden)) overlaps.push(`${allowed} <> ${forbidden}`);
      }
    }
    if (overlaps.length > 0) errors.push(`allowed_paths overlaps forbidden_paths: ${overlaps.join(", ")}`);
  }
  return [...new Set(errors)];
}

export function detectTaskConflicts(tasks) {
  const conflicts = [];
  for (let leftIndex = 0; leftIndex < tasks.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < tasks.length; rightIndex += 1) {
      const left = tasks[leftIndex];
      const right = tasks[rightIndex];
      const paths = [];
      if (left.depends_on?.includes(right.task_id) || right.depends_on?.includes(left.task_id)) {
        paths.push(`dependency between ${left.task_id} and ${right.task_id}`);
      }
      if (left.conflicts_with?.includes(right.task_id) || right.conflicts_with?.includes(left.task_id)) {
        paths.push(`explicit conflict between ${left.task_id} and ${right.task_id}`);
      }
      for (const leftPath of left.allowed_paths ?? []) {
        for (const rightPath of right.allowed_paths ?? []) {
          if (patternsMayOverlap(leftPath, rightPath)) paths.push(`${leftPath} <> ${rightPath}`);
        }
      }
      if (paths.length > 0) conflicts.push({
        left: left.task_id,
        right: right.task_id,
        paths: [...new Set(paths)].sort(),
      });
    }
  }
  return conflicts;
}

export function validateTaskGraph(tasks) {
  const errors = [];
  const byId = new Map(tasks.map((task) => [task.task_id, task]));
  for (const task of tasks) {
    for (const dependencyId of task.depends_on ?? []) {
      if (!byId.has(dependencyId)) errors.push(`${task.task_id} has missing dependency ${dependencyId}`);
    }
    for (const conflictId of task.conflicts_with ?? []) {
      if (!byId.has(conflictId)) errors.push(`${task.task_id} has missing conflict target ${conflictId}`);
    }
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(taskId, path) {
    if (visiting.has(taskId)) {
      const cycleStart = path.indexOf(taskId);
      errors.push(`dependency cycle: ${[...path.slice(cycleStart), taskId].join(" -> ")}`);
      return;
    }
    if (visited.has(taskId) || !byId.has(taskId)) return;
    visiting.add(taskId);
    const nextPath = [...path, taskId];
    for (const dependencyId of byId.get(taskId).depends_on ?? []) visit(dependencyId, nextPath);
    visiting.delete(taskId);
    visited.add(taskId);
  }
  for (const taskId of byId.keys()) visit(taskId, []);
  return [...new Set(errors)].sort();
}

export function runtimeStateRoot(repoRoot = defaultRepoRoot) {
  const common = gitText(repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return join(common, "agent-flow");
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

export function acquireControlLock(repoRoot, name) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`unsafe control lock name: ${name}`);
  const root = runtimeStateRoot(repoRoot);
  const lockPath = join(root, `${name}.lock`);
  const ownerPath = join(lockPath, "owner.json");
  mkdirSync(root, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lockPath);
      const owner = { pid: process.pid, token: `${process.pid}-${Date.now()}`, acquired_at: new Date().toISOString() };
      atomicWrite(ownerPath, `${JSON.stringify(owner, null, 2)}\n`);
      return () => {
        let current = null;
        try {
          current = readJson(ownerPath);
        } catch {
          return;
        }
        if (current.token === owner.token) rmSync(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let owner = null;
      try {
        owner = readJson(ownerPath);
      } catch {
        throw new Error(`control lock ${name} is busy and has no readable owner`);
      }
      if (processIsAlive(owner.pid)) throw new Error(`control lock ${name} is held by PID ${String(owner.pid)}`);
      rmSync(lockPath, { recursive: true, force: true });
    }
  }
  throw new Error(`could not acquire control lock ${name}`);
}

function runtimeStatePath(repoRoot, taskId) {
  return join(runtimeStateRoot(repoRoot), "tasks", `${safeTaskId(taskId)}.json`);
}

export function readRuntimeState(repoRoot, taskId) {
  const path = runtimeStatePath(repoRoot, taskId);
  return existsSync(path) ? readJson(path) : null;
}

export function writeRuntimeState(repoRoot, taskId, state) {
  const next = {
    ...state,
    task_id: taskId,
    updated_at: new Date().toISOString(),
  };
  if (!runStatuses.has(next.run_status)) throw new Error(`unknown run_status: ${String(next.run_status)}`);
  atomicWrite(runtimeStatePath(repoRoot, taskId), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function initialRuntimeState(repoRoot, task) {
  const artifactPath = join(repoRoot, "workflows/verifications", `${safeTaskId(task.task_id)}.json`);
  if (existsSync(artifactPath)) {
    const verification = readJson(artifactPath);
    const artifactErrors = validateVerificationResult(verification, {
      task,
      state: { base_sha: verification.base_sha, head_sha: verification.head_sha },
    });
    const headIsMerged = /^[0-9a-f]{40}$/.test(verification.head_sha ?? "")
      && git(repoRoot, ["merge-base", "--is-ancestor", verification.head_sha, "HEAD"], { allowFailure: true }).status === 0;
    if (verification.status !== "PASS" || artifactErrors.length > 0 || !headIsMerged) {
      throw new Error(`invalid archived verification artifact: ${artifactPath}${artifactErrors.length ? ` (${artifactErrors.join("; ")})` : ""}`);
    }
    return {
      task_id: task.task_id,
      run_status: "ARCHIVED",
      attempt: task.attempt,
      codex_session_id: null,
      base_sha: verification.base_sha ?? task.base_sha ?? null,
      checkpoint_sha: verification.head_sha ?? null,
      head_sha: verification.head_sha ?? null,
      next_action: null,
      blocked_reason: null,
      verification,
      archived_from_artifact: true,
    };
  }
  return {
    task_id: task.task_id,
    run_status: task.run_status,
    attempt: task.attempt,
    codex_session_id: null,
    base_sha: task.base_sha ?? null,
    checkpoint_sha: null,
    head_sha: null,
    next_action: task.next_action,
    blocked_reason: null,
    verification: null,
  };
}

export function effectiveState(repoRoot, task) {
  return readRuntimeState(repoRoot, task.task_id) ?? initialRuntimeState(repoRoot, task);
}

export function transitionRuntimeState(repoRoot, task, nextStatus, patch = {}) {
  const current = effectiveState(repoRoot, task);
  if (!transitions[current.run_status]?.has(nextStatus)) {
    throw new Error(`invalid run transition ${current.run_status} -> ${nextStatus}`);
  }
  return writeRuntimeState(repoRoot, task.task_id, {
    ...current,
    ...patch,
    run_status: nextStatus,
  });
}

function walkEvidence(root) {
  if (!existsSync(root)) return [];
  const entries = [];
  function visit(directory, prefix = "") {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relativePath = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(path);
      if (stat.isDirectory()) visit(path, relativePath);
      else if (stat.isSymbolicLink()) entries.push({ path: relativePath, symlink: readlinkSync(path) });
      else {
        const source = readFileSync(path);
        entries.push({
          path: relativePath,
          size: source.length,
          sha256: createHash("sha256").update(source).digest("hex"),
        });
      }
    }
  }
  visit(root);
  return entries;
}

export function snapshotVerifierState({ repoRoot, planRoots }) {
  return {
    git_status: git(repoRoot, ["status", "--short", "--untracked-files=all"]).stdout,
    plans: Object.fromEntries(planRoots.map((root) => [root, walkEvidence(root)])),
  };
}

export function compareVerifierSnapshots(before, after) {
  const changes = [];
  if (before.git_status !== after.git_status) changes.push("Git status changed during verification");
  for (const root of new Set([...Object.keys(before.plans), ...Object.keys(after.plans)])) {
    if (JSON.stringify(before.plans[root] ?? []) !== JSON.stringify(after.plans[root] ?? [])) {
      changes.push(`plan files changed under ${root}`);
    }
  }
  return changes;
}

export function buildCodexExecArgs({ task, prompt, outputSchemaPath, outputPath }) {
  return [
    "exec",
    "-C",
    task.worktree,
    "--profile",
    task.execution_profile,
    "--strict-config",
    "--sandbox",
    "workspace-write",
    "-c",
    'approval_policy="never"',
    "--json",
    "--output-schema",
    outputSchemaPath,
    "-o",
    outputPath,
    prompt,
  ];
}

export function buildCodexResumeArgs({ sessionId, profile, prompt, outputSchemaPath, outputPath }) {
  return [
    "exec",
    "resume",
    sessionId,
    "-m",
    profile.model,
    "-c",
    `model_reasoning_effort=${tomlString(profile.model_reasoning_effort)}`,
    "-c",
    `service_tier=${tomlString(profile.service_tier)}`,
    "-c",
    `sandbox_mode=${tomlString(profile.sandbox_mode)}`,
    "-c",
    `approval_policy=${tomlString(profile.approval_policy)}`,
    "--strict-config",
    "--json",
    "--output-schema",
    outputSchemaPath,
    "-o",
    outputPath,
    prompt,
  ];
}

export function buildOpenCodeInvocation({ repoRoot, prompt, model }) {
  if (!model.startsWith("yuepu/")) throw new Error("OpenCode verifier model must remain under yuepu/");
  return {
    command: "opencode",
    args: [
      "run",
      "--pure",
      "--dir",
      repoRoot,
      "--agent",
      "plan",
      "--model",
      model,
      "--format",
      "json",
      prompt,
    ],
    env: { OPENCODE_DISABLE_EXTERNAL_SKILLS: "1" },
  };
}

function renderList(values) {
  return values.map((value) => `- ${value}`).join("\n");
}

export function renderExecutorPrompt(task) {
  return `You are the primary Codex Executor.\n\nTask ID:\n${task.task_id}\n\nGoal:\n${task.goal}\n\nAllowed paths:\n${renderList(task.allowed_paths)}\n\nForbidden paths:\n${renderList(task.forbidden_paths)}\n\nAcceptance criteria:\n${renderList(task.acceptance)}\n\nVerification commands:\n${renderList(task.verification)}\n\nThis task packet is complete and pre-approved within allowed_paths. Do not ask for confirmation or clarification for actions inside the declared scope. Make reasonable implementation assumptions that do not alter the approved Spec. If proceeding requires changing the Spec, accessing forbidden paths, performing external writes, or making an irreversible decision, return BLOCKED once with concrete evidence. Otherwise continue autonomously through implementation, tests, and commit. Make the smallest correct change. Do not perform unrelated refactors. Return JSON matching the supplied output schema.`;
}

export function renderResumePrompt(task, state) {
  return `${renderExecutorPrompt(task)}\n\nThis is a resumed execution session. Continue from the existing worktree and checkpoint; do not restart completed work. Previous runtime evidence:\n${JSON.stringify({
    run_status: state.run_status,
    blocked_reason: state.blocked_reason ?? null,
    executor_result: state.executor_result ?? null,
    verification: state.verification ?? null,
  }, null, 2)}`;
}

export function renderVerifierPrompt(task, state, executorEvidence) {
  return `You are the independent OpenCode Verifier. Use a strictly read-only process. Do not fix code and do not create or update plan files.\n\nTask ID: ${task.task_id}\nGoal: ${task.goal}\nAcceptance criteria:\n${renderList(task.acceptance)}\n\nFrozen diff: ${state.base_sha}..${state.head_sha}\nExecutor evidence:\n${JSON.stringify(executorEvidence, null, 2)}\nVerification commands:\n${renderList(task.verification)}\n\nTreat executor claims as untrusted until reproduced. Check scope drift, regressions, boundaries, forbidden paths, compatibility and rollback. Output one JSON object with task_id, base_sha, head_sha, verifier, status (PASS, FAIL, or BLOCKED), commands, findings, evidence, known_risks, and unexpected_writes. Every FAIL must include reproducible evidence.`;
}

function parseJsonLines(source) {
  return source.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

export function parseCodexJsonl(source) {
  const events = parseJsonLines(source);
  let sessionId = null;
  let lastMessage = null;
  for (const event of events) {
    if (event.type === "thread.started") sessionId = event.thread_id ?? sessionId;
    const item = event.item ?? event.data?.item;
    if (item?.type === "agent_message" && typeof item.text === "string") lastMessage = item.text;
  }
  return { events, sessionId, lastMessage };
}

function parseEmbeddedJson(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  const stripped = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(stripped);
  } catch {
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(stripped.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function collectTextCandidates(value, output = []) {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => collectTextCandidates(entry, output));
  else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (["text", "content", "message", "part", "data", "result"].includes(key)) {
        collectTextCandidates(entry, output);
      }
    }
  }
  return output;
}

export function extractOpenCodeResult(source) {
  const direct = parseEmbeddedJson(source);
  if (direct?.status) return direct;
  const events = parseJsonLines(source);
  const candidates = collectTextCandidates(events);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const parsed = parseEmbeddedJson(candidates[index]);
    if (parsed?.status) return parsed;
  }
  throw new Error("OpenCode output did not contain a machine-readable verification result");
}

function taskById(repoRoot, taskId) {
  const tasks = loadTasks(repoRoot);
  const task = tasks.find((entry) => entry.task_id === taskId);
  if (!task) throw new Error(`unknown task_id: ${taskId}`);
  return task;
}

function evidenceDirectory(repoRoot, task, attempt = task.attempt) {
  return join(runtimeStateRoot(repoRoot), "runs", safeTaskId(task.task_id), `attempt-${String(attempt)}`);
}

function changedFiles(repoRoot, baseSha, headSha) {
  const source = git(repoRoot, ["diff", "--name-only", "--diff-filter=ACMRD", `${baseSha}..${headSha}`]).stdout;
  return source.split(/\r?\n/).filter(Boolean).sort();
}

function validateChangedFiles(task, files) {
  const errors = [];
  for (const file of files) {
    if (!task.allowed_paths.some((pattern) => pathMatchesPattern(file, pattern))) {
      errors.push(`${file} is outside allowed_paths`);
    }
    if (task.forbidden_paths.some((pattern) => pathMatchesPattern(file, pattern))) {
      errors.push(`${file} matches forbidden_paths`);
    }
  }
  return errors;
}

function ensureWorktree(repoRoot, task, baseSha) {
  if (existsSync(task.worktree)) return;
  mkdirSync(dirname(task.worktree), { recursive: true });
  const branchExists = git(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${task.branch}`], { allowFailure: true }).status === 0;
  if (branchExists) git(repoRoot, ["worktree", "add", task.worktree, task.branch]);
  else git(repoRoot, ["worktree", "add", "-b", task.branch, task.worktree, baseSha]);
}

function assertTaskWorktree(task, baseSha, { allowDirty = false, requireBaseHead = false } = {}) {
  const topLevel = gitText(task.worktree, ["rev-parse", "--show-toplevel"]);
  if (realpathSync(topLevel) !== realpathSync(task.worktree)) {
    throw new Error(`task worktree root mismatch: ${topLevel}`);
  }
  const branch = gitText(task.worktree, ["branch", "--show-current"]);
  if (branch !== task.branch) throw new Error(`task worktree branch must be ${task.branch}, got ${branch || "detached"}`);
  const head = gitText(task.worktree, ["rev-parse", "HEAD"]);
  const baseIsAncestor = git(task.worktree, ["merge-base", "--is-ancestor", baseSha, head], { allowFailure: true }).status === 0;
  if (!baseIsAncestor) throw new Error(`${baseSha} is not an ancestor of task worktree HEAD`);
  if (requireBaseHead && head !== baseSha) throw new Error(`fresh dispatch requires worktree HEAD ${baseSha}, got ${head}`);
  const dirty = git(task.worktree, ["status", "--short", "--untracked-files=all"]).stdout.trim();
  if (!allowDirty && dirty) throw new Error(`task worktree must be clean before dispatch: ${dirty}`);
  return { branch, head, dirty };
}

function ensureDependencies(repoRoot, task, allTasks) {
  for (const dependencyId of task.depends_on) {
    const dependency = allTasks.find((entry) => entry.task_id === dependencyId);
    if (!dependency) throw new Error(`missing dependency task: ${dependencyId}`);
    const state = effectiveState(repoRoot, dependency);
    if (!completedDependencyStatuses.has(state.run_status)) {
      throw new Error(`dependency ${dependencyId} is ${state.run_status}, not MERGED/ARCHIVED`);
    }
  }
}

function activeTasks(repoRoot, tasks) {
  return tasks.filter((task) => activeWriterStatuses.has(effectiveState(repoRoot, task).run_status));
}

function ensureDispatchCapacity(repoRoot, task, tasks) {
  const active = activeTasks(repoRoot, tasks).filter((entry) => entry.task_id !== task.task_id);
  if (active.length >= maxParallelWriters) throw new Error(`parallel writer limit ${String(maxParallelWriters)} reached`);
  const conflicts = detectTaskConflicts([task, ...active]).filter((entry) => entry.left === task.task_id || entry.right === task.task_id);
  if (conflicts.length > 0) throw new Error(`task conflicts with active work: ${JSON.stringify(conflicts)}`);
}

function parseExecutorResult(path) {
  if (!existsSync(path)) throw new Error(`Codex did not write structured output: ${path}`);
  const result = readJson(path);
  if (!result || !["PASS", "BLOCKED"].includes(result.status)) throw new Error("invalid Codex result status");
  return result;
}

export function validateExecutorResult(result, { task, baseSha, headSha, files }) {
  const errors = [];
  if (result.task_id !== task.task_id) errors.push(`executor task_id mismatch: ${String(result.task_id)}`);
  if (result.status !== "PASS") return errors;
  if (result.base_sha !== baseSha) errors.push(`executor base_sha mismatch: ${String(result.base_sha)}`);
  if (result.head_sha !== headSha) errors.push(`executor head_sha mismatch: ${String(result.head_sha)}`);
  if (result.commit !== headSha) errors.push(`executor commit mismatch: ${String(result.commit)}`);
  const claimedFiles = Array.isArray(result.changed_files) ? [...result.changed_files].sort() : [];
  if (JSON.stringify(claimedFiles) !== JSON.stringify(files)) errors.push("executor changed_files do not match Git diff");
  if (!Array.isArray(result.tests) || result.tests.length === 0) errors.push("executor PASS requires test evidence");
  else if (result.tests.some((test) => test?.result !== "PASS")) errors.push("executor PASS contains failed or unrun tests");
  if (!Array.isArray(result.known_risks)) errors.push("executor known_risks must be an array");
  if (result.blocked_reason !== null) errors.push("executor PASS must have blocked_reason=null");
  return errors;
}

function moveToExecuting(repoRoot, task, current, { resume }) {
  if (resume && processIsAlive(current.codex_process_pid)) {
    throw new Error(`Codex process ${String(current.codex_process_pid)} is still running`);
  }
  if (resume && current.controller_pid !== process.pid && processIsAlive(current.controller_pid)) {
    throw new Error(`controller process ${String(current.controller_pid)} is still running`);
  }
  let state = current;
  if (!resume && state.run_status === "BLOCKED" && !state.codex_session_id) {
    state = transitionRuntimeState(repoRoot, task, "REWORK_READY", {
      attempt: state.attempt + 1,
      blocked_reason: null,
      next_action: "dispatch",
    });
  }
  if (resume && ["FAIL", "BLOCKED"].includes(state.run_status)) {
    state = transitionRuntimeState(repoRoot, task, "REWORK_READY", {
      attempt: state.attempt + 1,
      blocked_reason: null,
      next_action: "resume",
    });
  }
  if (["READY", "REWORK_READY"].includes(state.run_status)) {
    state = transitionRuntimeState(repoRoot, task, "DISPATCHED", {
      base_sha: state.base_sha ?? task.base_sha,
      blocked_reason: null,
    });
  }
  if (state.run_status === "DISPATCHED") {
    state = transitionRuntimeState(repoRoot, task, "EXECUTING", {
      controller_pid: process.pid,
      codex_process_pid: null,
    });
  }
  if (state.run_status !== "EXECUTING") {
    throw new Error(`cannot enter EXECUTING from ${state.run_status}`);
  }
  if (resume) {
    state = writeRuntimeState(repoRoot, task.task_id, {
      ...state,
      controller_pid: process.pid,
      codex_process_pid: null,
    });
  }
  return state;
}

async function executeCodex({ repoRoot, task, resume = false, dryRun = false }) {
  const errors = validateTaskDefinition(task, { repoRoot });
  if (errors.length > 0) throw new Error(errors.join("\n"));
  const tasks = loadTasks(repoRoot);
  const graphErrors = validateTaskGraph(tasks);
  if (graphErrors.length > 0) throw new Error(graphErrors.join("\n"));
  const whitelist = loadProfileWhitelist(join(repoRoot, "workflows/codex-profiles.json"));
  const profile = whitelist.profiles[task.execution_profile];
  let current;
  let baseSha;
  let evidenceRoot;
  let outputPath;
  let jsonlPath;
  let args;
  const releaseDispatchLock = dryRun ? null : acquireControlLock(repoRoot, "dispatch");
  try {
    current = effectiveState(repoRoot, task);
    const allowedStatuses = resume
      ? new Set(["EXECUTING", "FAIL", "BLOCKED", "REWORK_READY"])
      : new Set(["READY", "BLOCKED", "REWORK_READY"]);
    if (!allowedStatuses.has(current.run_status)) {
      throw new Error(`${resume ? "resume" : "dispatch"} cannot run from ${current.run_status}`);
    }
    if (resume && !current.codex_session_id) throw new Error("cannot resume without codex_session_id");
    if (!resume && current.run_status === "BLOCKED" && current.codex_session_id) {
      throw new Error("blocked task has a Codex session; use resume instead of dispatch");
    }
    if (!dryRun) {
      let availability;
      let catalogError = null;
      try {
        availability = inspectCodexCatalog(whitelist)[task.execution_profile];
      } catch (error) {
        catalogError = asError(error);
      }
      if (catalogError || !availability?.listed_exactly || !availability?.reasoning_supported) {
        const blockedReason = catalogError
          ? `Codex catalog check failed: ${catalogError.message}`
          : `Codex catalog does not list exact ${profile.model} with reasoning=${profile.model_reasoning_effort}`;
        if (transitions[current.run_status]?.has("BLOCKED")) {
          return transitionRuntimeState(repoRoot, task, "BLOCKED", {
            blocked_reason: blockedReason,
            next_action: "select-profile-or-retry-catalog",
          });
        }
        return writeRuntimeState(repoRoot, task.task_id, {
          ...current,
          blocked_reason: blockedReason,
          next_action: "select-profile-or-retry-catalog",
        });
      }
    }
    ensureDependencies(repoRoot, task, tasks);
    ensureDispatchCapacity(repoRoot, task, tasks);
    baseSha = current.base_sha ?? task.base_sha ?? gitText(repoRoot, ["rev-parse", "HEAD"]);
    const targetAttempt = current.attempt + (resume && ["FAIL", "BLOCKED"].includes(current.run_status) ? 1 : 0);
    evidenceRoot = evidenceDirectory(repoRoot, task, targetAttempt);
    outputPath = join(evidenceRoot, "executor-result.json");
    jsonlPath = join(evidenceRoot, "codex.jsonl");
    const prompt = resume ? renderResumePrompt(task, current) : renderExecutorPrompt(task);
    args = resume
      ? buildCodexResumeArgs({
        sessionId: current.codex_session_id,
        profile,
        prompt,
        outputSchemaPath: join(repoRoot, "workflows/executor-result.schema.json"),
        outputPath,
      })
      : buildCodexExecArgs({
        task,
        prompt,
        outputSchemaPath: join(repoRoot, "workflows/executor-result.schema.json"),
        outputPath,
      });
    if (dryRun) return { command: "codex", args, cwd: resume ? task.worktree : repoRoot };

    ensureWorktree(repoRoot, task, baseSha);
    assertTaskWorktree(task, baseSha, {
      allowDirty: resume,
      requireBaseHead: !resume && current.run_status === "READY",
    });
    moveToExecuting(repoRoot, task, current, { resume });
  } finally {
    releaseDispatchLock?.();
  }
  mkdirSync(evidenceRoot, { recursive: true });
  let result;
  try {
    result = await runJsonlProcess("codex", args, {
      cwd: resume ? task.worktree : repoRoot,
      outputPath: jsonlPath,
      onSpawn: (pid) => {
        const state = effectiveState(repoRoot, task);
        writeRuntimeState(repoRoot, task.task_id, { ...state, codex_process_pid: pid });
      },
      onEvent: (event) => {
        if (event.type !== "thread.started" || !isNonemptyString(event.thread_id)) return;
        const state = effectiveState(repoRoot, task);
        if (state.codex_session_id !== event.thread_id) {
          writeRuntimeState(repoRoot, task.task_id, { ...state, codex_session_id: event.thread_id });
        }
      },
    });
  } catch (error) {
    return transitionRuntimeState(repoRoot, task, "BLOCKED", {
      blocked_reason: `Codex process failed: ${asError(error).message}`,
      next_action: "resume",
      controller_pid: null,
      codex_process_pid: null,
    });
  }
  atomicWrite(join(evidenceRoot, "codex.stderr.log"), result.stderr ?? "");
  const parsed = parseCodexJsonl(result.stdout ?? "");
  const executing = effectiveState(repoRoot, task);
  writeRuntimeState(repoRoot, task.task_id, {
    ...executing,
    codex_session_id: parsed.sessionId ?? executing.codex_session_id,
    controller_pid: null,
    codex_process_pid: null,
  });
  if (result.status !== 0 || result.signal) {
    return transitionRuntimeState(repoRoot, task, "BLOCKED", {
      blocked_reason: (result.stderr || `codex exited ${String(result.status)}${result.signal ? ` via ${result.signal}` : ""}`).trim(),
      next_action: "resume",
    });
  }
  let executorResult;
  try {
    executorResult = parseExecutorResult(outputPath);
  } catch (error) {
    return transitionRuntimeState(repoRoot, task, "BLOCKED", {
      blocked_reason: asError(error).message,
      next_action: "resume",
    });
  }
  const reportedSessionId = isNonemptyString(executorResult.session_id) ? executorResult.session_id : null;
  if (reportedSessionId && !effectiveState(repoRoot, task).codex_session_id) {
    const state = effectiveState(repoRoot, task);
    writeRuntimeState(repoRoot, task.task_id, { ...state, codex_session_id: reportedSessionId });
  }
  const headSha = gitText(task.worktree, ["rev-parse", "HEAD"]);
  const dirty = git(task.worktree, ["status", "--short", "--untracked-files=all"]).stdout.trim();
  const files = changedFiles(task.worktree, baseSha, headSha);
  const boundaryErrors = validateChangedFiles(task, files);
  const evidenceErrors = validateExecutorResult(executorResult, { task, baseSha, headSha, files });
  if (dirty || headSha === baseSha || boundaryErrors.length > 0 || evidenceErrors.length > 0 || executorResult.status !== "PASS") {
    return transitionRuntimeState(repoRoot, task, "BLOCKED", {
      checkpoint_sha: headSha,
      head_sha: headSha,
      executor_result: executorResult,
      blocked_reason: [
        executorResult.blocked_reason,
        dirty ? `worktree is dirty: ${dirty}` : null,
        headSha === baseSha ? "Codex produced no commit" : null,
        ...boundaryErrors,
        ...evidenceErrors,
      ].filter(Boolean).join("; "),
      next_action: "resume",
    });
  }
  return transitionRuntimeState(repoRoot, task, "EXECUTOR_DONE", {
    checkpoint_sha: headSha,
    head_sha: headSha,
    changed_files: files,
    executor_result: executorResult,
    next_action: "verify",
  });
}

function defaultPlanRoots(taskWorktree) {
  return [
    join(taskWorktree, ".opencode/plans"),
    join(homedir(), ".local/share/opencode/plans"),
  ];
}

export function validateVerificationResult(result, { task, state }) {
  const errors = [];
  if (!result || typeof result !== "object" || Array.isArray(result)) return ["verification result must be an object"];
  if (result.task_id !== task.task_id) errors.push(`verifier task_id mismatch: ${String(result.task_id)}`);
  if (result.base_sha !== state.base_sha) errors.push(`verifier base_sha mismatch: ${String(result.base_sha)}`);
  if (result.head_sha !== state.head_sha) errors.push(`verifier head_sha mismatch: ${String(result.head_sha)}`);
  if (!/^[0-9a-f]{40}$/.test(result.base_sha ?? "")) errors.push("verifier base_sha must be a full lowercase SHA");
  if (!/^[0-9a-f]{40}$/.test(result.head_sha ?? "")) errors.push("verifier head_sha must be a full lowercase SHA");
  if (result.verifier?.tool !== "OpenCode"
    || !isNonemptyString(result.verifier?.model)
    || !result.verifier.model.startsWith("yuepu/")
    || result.verifier?.mode !== "read-only") {
    errors.push("verifier identity must be OpenCode + yuepu/* + read-only");
  }
  if (!["PASS", "FAIL", "BLOCKED"].includes(result.status)) errors.push(`invalid verifier status: ${String(result.status)}`);
  for (const key of ["commands", "findings", "evidence", "known_risks", "unexpected_writes"]) {
    if (!Array.isArray(result[key])) errors.push(`verifier ${key} must be an array`);
  }
  if (Array.isArray(result.commands)) {
    for (const command of result.commands) {
      if (!command || typeof command !== "object"
        || !isNonemptyString(command.command)
        || !["PASS", "FAIL", "NOT_RUN"].includes(command.result)
        || typeof command.evidence !== "string") {
        errors.push("verifier commands must contain command, PASS/FAIL/NOT_RUN result, and evidence");
        break;
      }
    }
  }
  if (result.status === "PASS") {
    if (!Array.isArray(result.commands) || result.commands.length === 0) errors.push("verifier PASS requires command evidence");
    else if (result.commands.some((command) => command?.result !== "PASS")) errors.push("verifier PASS contains failed or unrun commands");
    if (Array.isArray(result.unexpected_writes) && result.unexpected_writes.length > 0) {
      errors.push("verifier PASS contains unexpected writes");
    }
  }
  return errors;
}

function verifyTaskUnlocked({ repoRoot, task, dryRun = false }) {
  const state = effectiveState(repoRoot, task);
  if (!["EXECUTOR_DONE", "VERIFYING"].includes(state.run_status)) {
    throw new Error(`verify requires EXECUTOR_DONE/VERIFYING, got ${state.run_status}`);
  }
  if (!state.base_sha || !state.head_sha) throw new Error("verify requires frozen base_sha and head_sha");
  const model = process.env.OPENCODE_VERIFIER_MODEL || "yuepu/Deepseek-V4-Pro";
  const prompt = renderVerifierPrompt(task, state, state.executor_result ?? {});
  const invocation = buildOpenCodeInvocation({ repoRoot: task.worktree, prompt, model });
  if (dryRun) return invocation;

  const planRoots = defaultPlanRoots(task.worktree);
  const before = snapshotVerifierState({ repoRoot: task.worktree, planRoots });
  if (state.run_status === "EXECUTOR_DONE") transitionRuntimeState(repoRoot, task, "VERIFYING");
  const evidenceRoot = evidenceDirectory(repoRoot, task, state.attempt);
  mkdirSync(evidenceRoot, { recursive: true });
  const result = run(invocation.command, invocation.args, {
    cwd: task.worktree,
    env: invocation.env,
    allowFailure: true,
    timeout: Number(process.env.AGENT_FLOW_VERIFIER_TIMEOUT_MS || 1_200_000),
  });
  atomicWrite(join(evidenceRoot, "opencode.jsonl"), result.stdout ?? "");
  atomicWrite(join(evidenceRoot, "opencode.stderr.log"), result.stderr ?? "");
  const after = snapshotVerifierState({ repoRoot: task.worktree, planRoots });
  const unexpectedWrites = compareVerifierSnapshots(before, after);
  let verification;
  try {
    verification = extractOpenCodeResult(result.stdout ?? "");
  } catch (error) {
    verification = {
      task_id: task.task_id,
      base_sha: state.base_sha,
      head_sha: state.head_sha,
      verifier: { tool: "OpenCode", model, mode: "read-only" },
      status: "FAIL",
      commands: [],
      findings: [asError(error).message],
      evidence: [],
      known_risks: [],
      unexpected_writes: [],
    };
  }
  const verifierErrors = validateVerificationResult(verification, { task, state });
  verification = {
    ...verification,
    task_id: task.task_id,
    base_sha: state.base_sha,
    head_sha: state.head_sha,
    verifier: { tool: "OpenCode", model, mode: "read-only" },
    commands: Array.isArray(verification.commands) ? verification.commands : [],
    findings: [...(Array.isArray(verification.findings) ? verification.findings : []), ...verifierErrors],
    evidence: Array.isArray(verification.evidence) ? verification.evidence : [],
    known_risks: Array.isArray(verification.known_risks) ? verification.known_risks : [],
    unexpected_writes: [...new Set([
      ...(Array.isArray(verification.unexpected_writes) ? verification.unexpected_writes : []),
      ...unexpectedWrites,
    ])],
  };
  if (result.status !== 0 || result.error) {
    verification.status = "FAIL";
    verification.findings = [
      ...(verification.findings ?? []),
      result.error ? `OpenCode process error: ${result.error.message}` : `OpenCode exited ${String(result.status)}`,
    ];
  }
  if (verification.unexpected_writes.length > 0 || verifierErrors.length > 0) verification.status = "FAIL";
  const nextStatus = ["PASS", "FAIL", "BLOCKED"].includes(verification.status) ? verification.status : "FAIL";
  return transitionRuntimeState(repoRoot, task, nextStatus, {
    verification,
    blocked_reason: nextStatus === "BLOCKED" ? verification.findings?.join("; ") : null,
    next_action: nextStatus === "PASS" ? "integrate" : "rework",
  });
}

function verifyTask(options) {
  if (options.dryRun) return verifyTaskUnlocked(options);
  const releaseVerificationLock = acquireControlLock(options.repoRoot, "verification");
  try {
    return verifyTaskUnlocked(options);
  } finally {
    releaseVerificationLock();
  }
}

function verificationArtifact(task, state) {
  return {
    task_id: task.task_id,
    base_sha: state.base_sha,
    head_sha: state.head_sha,
    verifier: state.verification.verifier,
    status: state.verification.status,
    commands: state.verification.commands ?? [],
    findings: state.verification.findings ?? [],
    evidence: state.verification.evidence ?? [],
    unexpected_writes: state.verification.unexpected_writes ?? [],
    known_risks: state.verification.known_risks ?? [],
  };
}

function integrateTaskUnlocked({ repoRoot, task, dryRun = false }) {
  const state = effectiveState(repoRoot, task);
  if (state.run_status !== "PASS") throw new Error(`integrate requires PASS, got ${state.run_status}`);
  if (state.verification?.status !== "PASS") throw new Error("integrate requires verifier PASS");
  if ((state.verification.unexpected_writes ?? []).length > 0) throw new Error("integrate refuses verifier writes");
  ensureDependencies(repoRoot, task, loadTasks(repoRoot));
  const frozenWorktree = assertTaskWorktree(task, state.base_sha, { allowDirty: false });
  if (frozenWorktree.head !== state.head_sha) {
    throw new Error(`task worktree moved after verification: ${frozenWorktree.head} != ${state.head_sha}`);
  }
  const mainBranch = gitText(repoRoot, ["branch", "--show-current"]);
  if (mainBranch !== "main") throw new Error(`integration root must be on main, got ${mainBranch}`);
  const mainStatus = git(repoRoot, ["status", "--short", "--untracked-files=all"]).stdout.trim();
  if (mainStatus) throw new Error(`integration root must be clean: ${mainStatus}`);
  const mainHead = gitText(repoRoot, ["rev-parse", "HEAD"]);
  const taskFiles = state.changed_files ?? changedFiles(task.worktree, state.base_sha, state.head_sha);
  const boundaryErrors = validateChangedFiles(task, taskFiles);
  if (boundaryErrors.length > 0) throw new Error(boundaryErrors.join("\n"));
  const mainFiles = changedFiles(repoRoot, state.base_sha, mainHead);
  const overlaps = taskFiles.filter((path) => mainFiles.includes(path));
  if (overlaps.length > 0) throw new Error(`main changed task-owned paths since base: ${overlaps.join(", ")}`);
  const commits = gitText(task.worktree, ["rev-list", "--reverse", `${state.base_sha}..${state.head_sha}`])
    .split(/\r?\n/)
    .filter(Boolean);
  if (commits.length === 0) throw new Error("no task commits to integrate");
  const integrationBranch = `integrate/${safeTaskId(task.task_id).toLowerCase()}`;
  const integrationWorktree = `${task.worktree}-integration`;
  const commands = [
    ["git", ["worktree", "add", "-b", integrationBranch, integrationWorktree, mainHead]],
    ...commits.map((commit) => ["git", ["-C", integrationWorktree, "cherry-pick", commit]]),
    ["write", [join(integrationWorktree, "workflows/verifications", `${task.task_id}.json`)]],
    ["npm", ["ci"]],
    ["npm", ["run", "verify"]],
    ["git", ["merge", "--ff-only", integrationBranch]],
  ];
  if (dryRun) return { integrationBranch, integrationWorktree, commands };

  git(repoRoot, ["worktree", "add", "-b", integrationBranch, integrationWorktree, mainHead]);
  let integrated = false;
  try {
    for (const commit of commits) git(integrationWorktree, ["cherry-pick", commit]);
    const artifactPath = join(integrationWorktree, "workflows/verifications", `${task.task_id}.json`);
    atomicWrite(artifactPath, `${JSON.stringify(verificationArtifact(task, state), null, 2)}\n`);
    git(integrationWorktree, ["add", "--", relative(integrationWorktree, artifactPath)]);
    git(integrationWorktree, ["commit", "-m", `test: record ${task.task_id} verification`]);
    run("npm", ["ci"], { cwd: integrationWorktree, inherit: true });
    run("npm", ["run", "verify"], { cwd: integrationWorktree, inherit: true });
    if (gitText(repoRoot, ["rev-parse", "HEAD"]) !== mainHead) throw new Error("main moved during integration verification");
    git(repoRoot, ["merge", "--ff-only", integrationBranch]);
    integrated = true;
    const mergeSha = gitText(repoRoot, ["rev-parse", "HEAD"]);
    const mergeReady = transitionRuntimeState(repoRoot, task, "MERGE_READY", { next_action: "merge" });
    return transitionRuntimeState(repoRoot, task, "MERGED", {
      ...mergeReady,
      merge_sha: mergeSha,
      next_action: "cleanup",
    });
  } finally {
    if (integrated) {
      git(repoRoot, ["worktree", "remove", integrationWorktree]);
      git(repoRoot, ["branch", "-d", integrationBranch]);
    }
  }
}

function integrateTask(options) {
  if (options.dryRun) return integrateTaskUnlocked(options);
  const releaseIntegrationLock = acquireControlLock(options.repoRoot, "integration");
  try {
    return integrateTaskUnlocked(options);
  } finally {
    releaseIntegrationLock();
  }
}

function cleanupTask({ repoRoot, task, dryRun = false }) {
  const state = effectiveState(repoRoot, task);
  if (!["MERGED", "ARCHIVED"].includes(state.run_status)) {
    throw new Error(`cleanup requires MERGED/ARCHIVED, got ${state.run_status}`);
  }
  if (existsSync(task.worktree)) {
    const status = git(task.worktree, ["status", "--short", "--untracked-files=all"]).stdout.trim();
    if (status) throw new Error(`refusing to remove dirty worktree: ${status}`);
  }
  if (dryRun) return { worktree: task.worktree, branch: task.branch };
  if (existsSync(task.worktree)) git(repoRoot, ["worktree", "remove", task.worktree]);
  const branchExists = git(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${task.branch}`], { allowFailure: true }).status === 0;
  if (branchExists) git(repoRoot, ["branch", "-d", task.branch]);
  if (state.run_status === "ARCHIVED") return state;
  return transitionRuntimeState(repoRoot, task, "ARCHIVED", { next_action: null });
}

function parseCliArgs(args) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) positional.push(value);
    else if (["--json", "--install", "--check-catalog", "--dry-run"].includes(value)) flags[value.slice(2)] = true;
    else {
      const next = args[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${value} requires a value`);
      flags[value.slice(2)] = next;
      index += 1;
    }
  }
  return { positional, flags };
}

function output(value, jsonMode = false) {
  if (jsonMode || typeof value !== "string") process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else process.stdout.write(`${value}\n`);
}

function validateCommand(repoRoot, taskIds, jsonMode) {
  const allTasks = loadTasks(repoRoot);
  const tasks = allTasks.filter((task) => taskIds.length === 0 || taskIds.includes(task.task_id));
  if (taskIds.length > 0 && tasks.length !== taskIds.length) throw new Error("one or more task IDs were not found");
  const results = tasks.map((task) => ({
    task_id: task.task_id,
    errors: validateTaskDefinition(task, { repoRoot }),
  }));
  const graphErrors = validateTaskGraph(allTasks);
  output({
    status: results.every((result) => result.errors.length === 0) && graphErrors.length === 0 ? "PASS" : "FAIL",
    tasks: results,
    graph_errors: graphErrors,
  }, jsonMode);
  if (results.some((result) => result.errors.length > 0) || graphErrors.length > 0) process.exitCode = 1;
}

function statusCommand(repoRoot, taskIds, jsonMode) {
  const tasks = loadTasks(repoRoot).filter((task) => taskIds.length === 0 || taskIds.includes(task.task_id));
  if (taskIds.length > 0 && tasks.length !== taskIds.length) throw new Error("one or more task IDs were not found");
  output({
    max_parallel_writers: maxParallelWriters,
    graph_errors: validateTaskGraph(loadTasks(repoRoot)),
    tasks: tasks.map((task) => ({
      task_id: task.task_id,
      goal: task.goal,
      execution_profile: task.execution_profile,
      definition_status: task.run_status,
      runtime: effectiveState(repoRoot, task),
    })),
  }, jsonMode);
}

function planCommand(repoRoot, taskIds, jsonMode) {
  const allTasks = loadTasks(repoRoot);
  const selected = allTasks.filter((task) => taskIds.length === 0 || taskIds.includes(task.task_id));
  if (taskIds.length > 0 && selected.length !== taskIds.length) throw new Error("one or more task IDs were not found");
  const errors = [
    ...selected.flatMap((task) => validateTaskDefinition(task, { repoRoot }).map((error) => `${task.task_id}: ${error}`)),
    ...validateTaskGraph(allTasks),
  ];
  const conflicts = detectTaskConflicts(selected);
  const active = activeTasks(repoRoot, allTasks);
  const ready = selected.filter((task) => {
    const state = effectiveState(repoRoot, task);
    if (!["READY", "REWORK_READY"].includes(state.run_status)) return false;
    return task.depends_on.every((dependencyId) => {
      const dependency = allTasks.find((entry) => entry.task_id === dependencyId);
      return dependency && completedDependencyStatuses.has(effectiveState(repoRoot, dependency).run_status);
    });
  });
  const batch = [];
  const availableSlots = Math.max(0, maxParallelWriters - active.length);
  for (const candidate of ready) {
    if (batch.length >= availableSlots) break;
    if (detectTaskConflicts([...active, ...batch, candidate]).length === 0) batch.push(candidate);
  }
  const result = {
    status: errors.length === 0 ? "PASS" : "BLOCKED",
    errors,
    conflicts,
    active_writers: active.map((task) => task.task_id),
    next_batch: batch.map((task) => ({ task_id: task.task_id, profile: task.execution_profile })),
  };
  output(result, jsonMode);
  if (result.status !== "PASS") process.exitCode = 1;
}

export function usage() {
  return `Usage: node scripts/agent-flow.mjs <command> [task-id...] [options]\n\nCommands:\n  profiles [--install] [--check-catalog] [--codex-home PATH] [--json]\n  validate [task-id...] [--json]\n  status [task-id...] [--json]\n  plan [task-id...] [--json]\n  dispatch <task-id> [--dry-run] [--json]\n  resume <task-id> [--dry-run] [--json]\n  verify <task-id> [--dry-run] [--json]\n  integrate <task-id> [--dry-run] [--json]\n  cleanup <task-id> [--dry-run] [--json]`;
}

export async function main(args = process.argv.slice(2), repoRoot = defaultRepoRoot) {
  const [command, ...rest] = args;
  const { positional, flags } = parseCliArgs(rest);
  if (!command || command === "help" || command === "--help") {
    output(usage());
    return;
  }
  assertProjectIdentity(repoRoot);
  if (command === "profiles") {
    if (positional.length > 0) throw new Error("profiles does not accept task IDs");
    const whitelist = loadProfileWhitelist(join(repoRoot, "workflows/codex-profiles.json"));
    const installed = flags.install
      ? installCodexProfiles({ codexHome: flags["codex-home"], profilePath: join(repoRoot, "workflows/codex-profiles.json") })
      : [];
    const catalog = flags["check-catalog"] ? inspectCodexCatalog(whitelist) : null;
    output({ ...whitelist, installed, catalog }, flags.json);
    return;
  }
  if (command === "validate") return validateCommand(repoRoot, positional, flags.json);
  if (command === "status") return statusCommand(repoRoot, positional, flags.json);
  if (command === "plan") return planCommand(repoRoot, positional, flags.json);
  if (!["dispatch", "resume", "verify", "integrate", "cleanup"].includes(command)) throw new Error(`unknown command: ${command}`);
  if (positional.length !== 1) throw new Error(`${command} requires exactly one task-id`);
  const task = taskById(repoRoot, positional[0]);
  let result;
  if (command === "dispatch") result = await executeCodex({ repoRoot, task, dryRun: flags["dry-run"] });
  if (command === "resume") result = await executeCodex({ repoRoot, task, resume: true, dryRun: flags["dry-run"] });
  if (command === "verify") result = verifyTask({ repoRoot, task, dryRun: flags["dry-run"] });
  if (command === "integrate") result = integrateTask({ repoRoot, task, dryRun: flags["dry-run"] });
  if (command === "cleanup") result = cleanupTask({ repoRoot, task, dryRun: flags["dry-run"] });
  output(result, flags.json);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`[agent-flow] FAIL: ${asError(error).message}\n`);
    process.exitCode = 1;
  }
}
