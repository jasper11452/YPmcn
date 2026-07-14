import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const profilePath = join(repoRoot, "workflows/codex-profiles.json");
const agentFlowSchemaPath = join(repoRoot, "workflows/agent-flow.schema.json");
const executorSchemaPath = join(repoRoot, "workflows/executor-result.schema.json");
const controllerPath = join(repoRoot, "scripts/agent-flow.mjs");
const hookPath = join(repoRoot, "scripts/agent-flow-hook.mjs");

function json(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function controller() {
  return import(`${new URL("../scripts/agent-flow.mjs", import.meta.url).href}?test=${Date.now()}`);
}

function createGitFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "ypmcn-agent-flow-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Agent Flow Test");
  git(root, "config", "user.email", "agent-flow@example.invalid");
  writeFileSync(join(root, "README.md"), "fixture\n");
  git(root, "add", "README.md");
  git(root, "commit", "-q", "-m", "baseline");
  return root;
}

function task(overrides = {}) {
  return {
    schema_version: "2.2",
    task_id: "CHG-2099-001-UNIT",
    change_id: "CHG-2099-001",
    change_type: "developer-tooling",
    change_status: "SPEC_APPROVED",
    run_status: "READY",
    goal: "Exercise the agent flow controller",
    approved_spec_version: "mvp-v2 / schemaVersion 1",
    change_proposal: "changes/CHG-2099-001.md",
    impact_analysis: "changes/CHG-2099-001-impact.md",
    risk_level: "low",
    lane: "standard-low",
    route_reason: { matched: ["test fixture"], excluded: [] },
    upgrade_triggers: ["test failure"],
    independent_verifier: "on_trigger",
    human_approval: "not_required",
    execution_profile: "executor-sol-low",
    profile_reason: "test fixture",
    depends_on: [],
    conflicts_with: [],
    allowed_paths: ["scripts/**", "tests/**"],
    forbidden_paths: ["spec/**"],
    acceptance: ["controller returns deterministic evidence"],
    verification: ["node --test tests/agent_flow.test.mjs"],
    required_context: [{ ref: "README.md", required: true }],
    stop_conditions: ["scope expansion required"],
    rollback: "revert fixture",
    attempt: 1,
    branch: "codex/chg-2099-001-unit",
    worktree: "/tmp/chg-2099-001-unit",
    base_sha: "0123456789012345678901234567890123456789",
    next_action: "dispatch",
    ...overrides,
  };
}

describe("cross-session agent control plane", () => {
  it("pins the project-only Claude model and single Codex execution profile", () => {
    const source = json(profilePath);
    const claudeInstructions = readFileSync(join(repoRoot, "CLAUDE.md"), "utf8");
    const claudeSettings = json(join(repoRoot, ".claude/settings.json"));
    assert.equal(source.schema_version, "2.2");
    assert.deepEqual(source.profiles, {
      "executor-sol-low": {
        model: "gpt-5.6-sol",
        model_reasoning_effort: "low",
        service_tier: "fast",
        sandbox_mode: "workspace-write",
        approval_policy: "never",
      },
    });
    assert.deepEqual({ model: claudeSettings.model, effortLevel: claudeSettings.effortLevel }, { model: "fable", effortLevel: "medium" });
    assert.equal(claudeSettings.env.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME, "gpt-5.6-sol");
    for (const [name, profile] of Object.entries(source.profiles)) {
      assert.match(claudeInstructions, new RegExp(`${name}.*${profile.model}`));
    }
  });

  it("separates runtime contracts from the strict Codex output schema", () => {
    const flowSchema = json(agentFlowSchemaPath);
    const executorSchema = json(executorSchemaPath);
    assert.equal(flowSchema.oneOf.length, 3);
    assert.ok(flowSchema.$defs.taskDefinition);
    assert.ok(flowSchema.$defs.runtimeState);
    assert.ok(flowSchema.$defs.verificationResult);
    assert.equal(executorSchema.additionalProperties, false);
    assert.deepEqual(executorSchema.required, [
      "schema_version",
      "task_id",
      "status",
      "session_id",
      "base_sha",
      "head_sha",
      "commit",
      "changed_files",
      "tests",
      "evidence_paths",
      "context_expansions",
      "known_risks",
      "blocked_reason",
    ]);
  });

  it("renders and installs profiles without touching unrelated Codex config", async (t) => {
    const {
      assessProfileCatalog,
      installCodexProfiles,
      loadProfileWhitelist,
      renderCodexProfile,
    } = await controller();
    const codexHome = mkdtempSync(join(tmpdir(), "ypmcn-codex-home-"));
    t.after(() => rmSync(codexHome, { recursive: true, force: true }));
    const sentinel = join(codexHome, "yuepu.config.toml");
    writeFileSync(sentinel, "model = \"keep-me\"\n");

    const whitelist = loadProfileWhitelist(profilePath);
    const installed = installCodexProfiles({ codexHome, profilePath });
    assert.equal(installed.length, 1);
    assert.equal(readFileSync(sentinel, "utf8"), "model = \"keep-me\"\n");
    for (const [profileName, config] of Object.entries(whitelist.profiles)) {
      const installedPath = join(codexHome, `${profileName}.config.toml`);
      assert.equal(existsSync(installedPath), true, installedPath);
      assert.equal(readFileSync(installedPath, "utf8"), renderCodexProfile(config));
    }

    const driftedPath = join(codexHome, "drifted.json");
    writeFileSync(driftedPath, `${JSON.stringify({
      ...whitelist,
      profiles: {
        ...whitelist.profiles,
        "executor-unapproved": whitelist.profiles["executor-sol-low"],
      },
    })}\n`);
    assert.throws(() => loadProfileWhitelist(driftedPath), /must contain exactly/);

    const catalogStatus = assessProfileCatalog([
      { slug: "gpt-5.6-sol", supported_reasoning_levels: [{ effort: "low" }] },
    ], whitelist);
    assert.equal(catalogStatus["executor-sol-low"].reasoning_supported, true);
  });

  it("validates task definitions and rejects unknown profiles or unsafe states", async (t) => {
    const { assertProjectIdentity, validateTaskDefinition } = await controller();
    assert.deepEqual(validateTaskDefinition(task()), []);
    assert.match(
      validateTaskDefinition(task({ execution_profile: "executor-unlisted" })).join("\n"),
      /unknown execution_profile/,
    );
    assert.match(
      validateTaskDefinition(task({ change_status: "DRAFT" })).join("\n"),
      /change_status must be SPEC_APPROVED/,
    );
    assert.match(
      validateTaskDefinition(task({ lane: "critical", human_approval: "not_required", independent_verifier: "required" })).join("\n"),
      /critical requires human_approval=approved/,
    );
    assert.match(
      validateTaskDefinition(task({ lane: "standard-high", independent_verifier: "on_trigger" })).join("\n"),
      /standard-high requires independent_verifier=required/,
    );
    assert.match(
      validateTaskDefinition(task({ allowed_paths: ["spec/**"] })).join("\n"),
      /allowed_paths overlaps forbidden_paths/,
    );
    assert.match(
      validateTaskDefinition(task({ allowed_paths: ["../outside/**"] })).join("\n"),
      /repository-relative patterns/,
    );
    assert.match(
      validateTaskDefinition(task({ worktree: "/Users/jasper/Documents/YPmcn-skill" })).join("\n"),
      /worktree must not equal repository root/,
    );

    const unrelated = createGitFixture(t);
    mkdirSync(join(unrelated, "spec"));
    writeFileSync(join(unrelated, "package.json"), '{"name":"unrelated"}\n');
    writeFileSync(join(unrelated, "spec/manifest.json"), '{"schemaVersion":1,"profile":"mvp-v2","status":"approved"}\n');
    writeFileSync(join(unrelated, "CLAUDE.md"), "npm run agent-flow -- status --json\n");
    assert.throws(() => assertProjectIdentity(unrelated), /project identity check failed/);
  });

  it("detects conservative path conflicts before parallel dispatch", async () => {
    const { detectTaskConflicts, validateTaskGraph } = await controller();
    const first = task({ task_id: "A", allowed_paths: ["scripts/**"] });
    const second = task({ task_id: "B", allowed_paths: ["scripts/agent-flow.mjs"] });
    const third = task({ task_id: "C", allowed_paths: ["docs/**"] });
    const adjacent = task({ task_id: "E", allowed_paths: ["scripts-extra/**"] });
    assert.deepEqual(detectTaskConflicts([first, second]), [
      { left: "A", right: "B", paths: ["scripts/** <> scripts/agent-flow.mjs"] },
    ]);
    assert.deepEqual(detectTaskConflicts([first, third]), []);
    assert.deepEqual(detectTaskConflicts([first, adjacent]), []);
    assert.match(
      detectTaskConflicts([
        first,
        task({ task_id: "D", depends_on: ["A"], allowed_paths: ["docs/**"] }),
      ])[0].paths[0],
      /dependency/,
    );
    assert.match(validateTaskGraph([
      task({ task_id: "A", depends_on: ["B"] }),
      task({ task_id: "B", depends_on: ["A"] }),
    ]).join("\n"), /dependency cycle: A -> B -> A/);
    assert.match(validateTaskGraph([
      task({ task_id: "A", depends_on: ["MISSING"] }),
    ]).join("\n"), /missing dependency MISSING/);
  });

  it("builds fail-closed Codex exec and resume commands", async () => {
    const { buildCodexExecArgs, buildCodexResumeArgs, loadProfileWhitelist } = await controller();
    const currentTask = task();
    const profile = loadProfileWhitelist(profilePath).profiles[currentTask.execution_profile];
    const execArgs = buildCodexExecArgs({
      task: currentTask,
      profile,
      prompt: "bounded prompt",
      outputSchemaPath: "/repo/workflows/executor-result.schema.json",
      outputPath: "/state/executor.json",
    });
    assert.deepEqual(execArgs.slice(0, 5), [
      "exec",
      "-C",
      currentTask.worktree,
      "-m",
      "gpt-5.6-sol",
    ]);
    assert.ok(execArgs.includes("workspace-write"));
    assert.ok(execArgs.includes('approval_policy="never"'));
    assert.ok(execArgs.includes("--json"));
    assert.equal(execArgs.includes("--dangerously-bypass-approvals-and-sandbox"), false);

    const resumeArgs = buildCodexResumeArgs({
      sessionId: "01900000-0000-7000-8000-000000000001",
      profile,
      prompt: "resume bounded task",
      outputSchemaPath: "/repo/workflows/executor-result.schema.json",
      outputPath: "/state/executor.json",
    });
    assert.deepEqual(resumeArgs.slice(0, 3), [
      "exec",
      "resume",
      "01900000-0000-7000-8000-000000000001",
    ]);
    assert.ok(resumeArgs.includes("gpt-5.6-sol"));
    assert.ok(resumeArgs.includes('model_reasoning_effort="low"'));
    assert.ok(resumeArgs.includes('service_tier="fast"'));
    assert.ok(resumeArgs.includes('sandbox_mode="workspace-write"'));
    assert.ok(resumeArgs.includes('approval_policy="never"'));
  });

  it("streams JSONL and checkpoints session events before process completion", async (t) => {
    const { runJsonlProcess } = await controller();
    const root = mkdtempSync(join(tmpdir(), "ypmcn-agent-jsonl-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const outputPath = join(root, "events.jsonl");
    const events = [];
    const result = await runJsonlProcess(process.execPath, [
      "-e",
      'process.stdout.write("{\\"type\\":\\"thread.started\\",\\"thread_id\\":\\"session-1\\"}\\n"); process.stdout.write("{\\"type\\":\\"turn.completed\\"}\\n");',
    ], {
      outputPath,
      onEvent: (event) => events.push(event),
    });
    assert.equal(result.status, 0);
    assert.equal(events[0].thread_id, "session-1");
    assert.match(readFileSync(outputPath, "utf8"), /thread\.started/);
  });

  it("rejects untrusted executor and verifier PASS claims", async () => {
    const {
      renderVerifierPrompt,
      validateExecutorResult,
      validateVerificationResult,
    } = await controller();
    const currentTask = task();
    const baseSha = "0123456789012345678901234567890123456789";
    const headSha = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
    const executor = {
      schema_version: "2.2",
      task_id: currentTask.task_id,
      status: "PASS",
      session_id: "session-1",
      base_sha: baseSha,
      head_sha: headSha,
      commit: headSha,
      changed_files: ["scripts/agent-flow.mjs"],
      tests: [{ command: "node --test", result: "PASS", evidence: "green" }],
      evidence_paths: ["tests/agent_flow.test.mjs"],
      context_expansions: [],
      known_risks: [],
      blocked_reason: null,
    };
    assert.deepEqual(validateExecutorResult(executor, {
      task: currentTask,
      baseSha,
      headSha,
      files: ["scripts/agent-flow.mjs"],
    }), []);
    assert.match(validateExecutorResult({ ...executor, commit: baseSha }, {
      task: currentTask,
      baseSha,
      headSha,
      files: ["scripts/agent-flow.mjs"],
    }).join("\n"), /commit mismatch/);

    const verification = {
      task_id: currentTask.task_id,
      base_sha: baseSha,
      head_sha: headSha,
      verifier: { tool: "OpenCode", model: "yuepu/Deepseek-V4-Pro", mode: "read-only" },
      status: "PASS",
      commands: [{ command: "node --test", result: "PASS", evidence: "green" }],
      findings: [],
      evidence: ["tests passed"],
      known_risks: [],
      unexpected_writes: [],
    };
    assert.deepEqual(validateVerificationResult(verification, {
      task: currentTask,
      state: { base_sha: baseSha, head_sha: headSha },
    }), []);
    assert.match(validateVerificationResult({ ...verification, head_sha: baseSha }, {
      task: currentTask,
      state: { base_sha: baseSha, head_sha: headSha },
    }).join("\n"), /head_sha mismatch/);
    const verifierPrompt = renderVerifierPrompt(
      currentTask,
      { base_sha: baseSha, head_sha: headSha },
      executor,
      "yuepu/Deepseek-V4-Pro",
    );
    assert.match(verifierPrompt, /result exactly PASS\/FAIL\/NOT_RUN/);
    assert.match(verifierPrompt, /arrays of strings only; never use objects/);
    assert.match(verifierPrompt, /"tool": "OpenCode"/);
  });

  it("stores mutable runtime state in the shared Git common dir", async (t) => {
    const { effectiveState, readRuntimeState, runtimeStateRoot, writeRuntimeState } = await controller();
    const fixture = createGitFixture(t);
    const state = {
      task_id: "CHG-2099-001-UNIT",
      run_status: "EXECUTING",
      codex_session_id: "session-1",
      checkpoint_sha: git(fixture, "rev-parse", "HEAD"),
      attempt: 1,
    };
    const written = writeRuntimeState(fixture, state.task_id, state);
    const root = runtimeStateRoot(fixture);
    const commonDir = git(fixture, "rev-parse", "--path-format=absolute", "--git-common-dir");
    assert.equal(realpathSync(dirname(root)), realpathSync(commonDir), root);
    assert.equal(readRuntimeState(fixture, state.task_id).run_status, "EXECUTING");
    assert.equal(written.schema_version, "2.2");
    assert.equal(written.state_revision, 1);
    assert.throws(
      () => writeRuntimeState(fixture, state.task_id, { ...written, run_status: "BLOCKED" }, { expectedRevision: 0 }),
      /stale state revision/,
    );
    assert.match(
      readFileSync(join(root, "events/task-events.jsonl"), "utf8"),
      /"event_type":"state.transitioned"/,
    );
    assert.equal(git(fixture, "status", "--short"), "", "runtime state must not dirty the worktree");

    const archivedTask = task({ task_id: "CHG-2099-002-ARCHIVED" });
    const verificationRoot = join(fixture, "workflows/verifications");
    mkdirSync(verificationRoot, { recursive: true });
    writeFileSync(join(verificationRoot, `${archivedTask.task_id}.json`), `${JSON.stringify({
      task_id: archivedTask.task_id,
      status: "PASS",
      base_sha: state.checkpoint_sha,
      head_sha: state.checkpoint_sha,
      verifier: { tool: "OpenCode", model: "yuepu/Deepseek-V4-Pro", mode: "read-only" },
      commands: [{ command: "node --test", result: "PASS", evidence: "green" }],
      findings: [],
      evidence: ["green"],
      known_risks: [],
      unexpected_writes: [],
    })}\n`);
    assert.equal(effectiveState(fixture, archivedTask).run_status, "ARCHIVED");
  });

  it("hashes context, preserves immutable results, and rejects realpath escape", async (t) => {
    const {
      createTaskContextSnapshot,
      persistImmutableResult,
      validateTaskRealpaths,
    } = await controller();
    const fixture = createGitFixture(t);
    const boundedTask = task({
      task_id: "CHG-2099-003-CONTEXT",
      change_proposal: "README.md",
      impact_analysis: "README.md",
      required_context: [{ ref: "README.md", required: true }],
      allowed_paths: ["src/**"],
    });
    const snapshot = createTaskContextSnapshot(fixture, boundedTask);
    assert.match(snapshot.snapshot_id, /^ctx-/);
    assert.equal(snapshot.sources.every((source) => /^[0-9a-f]{64}$/.test(source.content_sha256)), true);
    const first = persistImmutableResult(fixture, boundedTask.task_id, "executor", { status: "PASS" });
    const second = persistImmutableResult(fixture, boundedTask.task_id, "executor", { status: "PASS" });
    assert.equal(first.result_id, second.result_id);

    const outside = mkdtempSync(join(tmpdir(), "ypmcn-agent-outside-"));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    symlinkSync(outside, join(fixture, "escape"));
    assert.match(
      validateTaskRealpaths(fixture, { ...boundedTask, allowed_paths: ["escape/**"] }).join("\n"),
      /outside task worktree/,
    );
  });

  it("serializes state-changing controller decisions with recoverable locks", async (t) => {
    const { acquireControlLock } = await controller();
    const fixture = createGitFixture(t);
    const release = acquireControlLock(fixture, "dispatch");
    assert.throws(() => acquireControlLock(fixture, "dispatch"), /held by PID/);
    release();
    const releaseAgain = acquireControlLock(fixture, "dispatch");
    releaseAgain();
    assert.equal(git(fixture, "status", "--short"), "");
  });

  it("detects verifier mutations in Git and plan directories", async (t) => {
    const { compareVerifierSnapshots, snapshotVerifierState } = await controller();
    const fixture = createGitFixture(t);
    const planRoot = mkdtempSync(join(tmpdir(), "ypmcn-agent-plans-"));
    t.after(() => rmSync(planRoot, { recursive: true, force: true }));
    const before = snapshotVerifierState({ repoRoot: fixture, planRoots: [planRoot] });
    writeFileSync(join(planRoot, "unexpected.md"), "mutation\n");
    const afterPlanMutation = snapshotVerifierState({ repoRoot: fixture, planRoots: [planRoot] });
    assert.deepEqual(compareVerifierSnapshots(before, afterPlanMutation), [
      `plan files changed under ${planRoot}`,
    ]);

    writeFileSync(join(fixture, "unexpected.txt"), "mutation\n");
    const afterGitMutation = snapshotVerifierState({ repoRoot: fixture, planRoots: [planRoot] });
    assert.match(compareVerifierSnapshots(before, afterGitMutation).join("\n"), /Git status changed/);
  });

  it("applies the project-only Claude PreToolUse write gate", () => {
    function invokeHook(payload) {
      return spawnSync(process.execPath, [hookPath], {
        cwd: repoRoot,
        env: { ...process.env, CLAUDE_PROJECT_DIR: repoRoot },
        input: JSON.stringify(payload),
        encoding: "utf8",
      });
    }
    const deniedFile = invokeHook({ tool_name: "Write", tool_input: { file_path: join(repoRoot, "src/forbidden.mjs") } });
    assert.equal(deniedFile.status, 0, deniedFile.stderr);
    assert.equal(JSON.parse(deniedFile.stdout).hookSpecificOutput.permissionDecision, "deny");
    const allowedTask = invokeHook({ tool_name: "Write", tool_input: { file_path: join(repoRoot, "workflows/tasks/new.yaml") } });
    assert.equal(allowedTask.stdout, "");
    const deniedShell = invokeHook({ tool_name: "Bash", tool_input: { command: "git commit -am unsafe" } });
    assert.equal(JSON.parse(deniedShell.stdout).hookSpecificOutput.permissionDecision, "deny");
    const allowedShell = invokeHook({ tool_name: "Bash", tool_input: { command: "git status --short" } });
    assert.equal(allowedShell.stdout, "");
  });

  it("uses the native pure OpenCode plan invocation with a yuepu verifier", async () => {
    const { buildOpenCodeInvocation, requiresIndependentVerifier } = await controller();
    const invocation = buildOpenCodeInvocation({
      repoRoot: "/repo",
      prompt: "verify frozen diff",
      model: "yuepu/Deepseek-V4-Pro",
    });
    assert.equal(invocation.command, "opencode");
    assert.deepEqual(invocation.args.slice(0, 6), [
      "run",
      "--pure",
      "--dir",
      "/repo",
      "--agent",
      "plan",
    ]);
    assert.ok(invocation.args.includes("--format"));
    assert.ok(invocation.args.includes("json"));
    assert.equal(invocation.args.includes("--auto"), false);
    assert.equal(invocation.env.OPENCODE_DISABLE_EXTERNAL_SKILLS, "1");
    const fallback = buildOpenCodeInvocation({
      repoRoot: "/repo",
      prompt: "fallback verify",
      model: "yuepu/gpt-5.6-sol",
      variant: "medium",
    });
    assert.deepEqual(fallback.args.slice(-3, -1), ["--variant", "medium"]);
    assert.equal(requiresIndependentVerifier(task(), { attempt: 1 }), false);
    assert.equal(requiresIndependentVerifier(task(), { attempt: 2 }), true);
    assert.equal(requiresIndependentVerifier(task({ lane: "standard-high", independent_verifier: "required" }), {}), true);
    assert.throws(
      () => buildOpenCodeInvocation({ repoRoot: "/repo", prompt: "x", model: "openai/gpt" }),
      /must remain under yuepu/,
    );
  });

  it("exposes deterministic CLI status and profile inspection", () => {
    const result = spawnSync(process.execPath, [controllerPath, "profiles", "--json"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const profileResult = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(profileResult.profiles), [
      "executor-sol-low",
    ]);

    const validation = spawnSync(process.execPath, [
      controllerPath,
      "validate",
      "CHG-2026-005-AGENT-FLOW",
      "--json",
    ], { cwd: repoRoot, encoding: "utf8" });
    assert.equal(validation.status, 0, validation.stderr);
    assert.equal(JSON.parse(validation.stdout).status, "PASS");

    const status = spawnSync(process.execPath, [controllerPath, "status", "--json"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).max_parallel_writers, 5);
  });
});
