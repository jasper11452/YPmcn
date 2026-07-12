import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
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
    execution_profile: "executor-sol-max-fast",
    profile_reason: "test fixture",
    depends_on: [],
    conflicts_with: [],
    allowed_paths: ["scripts/**", "tests/**"],
    forbidden_paths: ["spec/**"],
    acceptance: ["controller returns deterministic evidence"],
    verification: ["node --test tests/agent_flow.test.mjs"],
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
  it("pins exactly three case-sensitive Codex execution profiles", () => {
    const source = json(profilePath);
    const claudeInstructions = readFileSync(join(repoRoot, "CLAUDE.md"), "utf8");
    assert.equal(source.schema_version, 1);
    assert.deepEqual(source.profiles, {
      "executor-sol-max-fast": {
        model: "gpt-5.6-sol",
        model_reasoning_effort: "max",
        service_tier: "fast",
        sandbox_mode: "workspace-write",
        approval_policy: "never",
      },
      "executor-terra-max-fast": {
        model: "gpt-5.6-terra",
        model_reasoning_effort: "max",
        service_tier: "fast",
        sandbox_mode: "workspace-write",
        approval_policy: "never",
      },
      "executor-terra-medium-fast": {
        model: "gpt-5.6-Terra",
        model_reasoning_effort: "medium",
        service_tier: "fast",
        sandbox_mode: "workspace-write",
        approval_policy: "never",
      },
    });
    assert.notEqual(
      source.profiles["executor-terra-max-fast"].model,
      source.profiles["executor-terra-medium-fast"].model,
      "model case must not be normalized",
    );
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
      "task_id",
      "status",
      "session_id",
      "base_sha",
      "head_sha",
      "commit",
      "changed_files",
      "tests",
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
    assert.equal(installed.length, 3);
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
        "executor-unapproved": whitelist.profiles["executor-sol-max-fast"],
      },
    })}\n`);
    assert.throws(() => loadProfileWhitelist(driftedPath), /must contain exactly/);

    const catalogStatus = assessProfileCatalog([
      { slug: "gpt-5.6-sol", supported_reasoning_levels: [{ effort: "max" }] },
      { slug: "gpt-5.6-terra", supported_reasoning_levels: [{ effort: "max" }, { effort: "medium" }] },
    ], whitelist);
    assert.equal(catalogStatus["executor-sol-max-fast"].reasoning_supported, true);
    assert.equal(catalogStatus["executor-terra-max-fast"].reasoning_supported, true);
    assert.equal(catalogStatus["executor-terra-medium-fast"].listed_exactly, false);
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
      prompt: "bounded prompt",
      outputSchemaPath: "/repo/workflows/executor-result.schema.json",
      outputPath: "/state/executor.json",
    });
    assert.deepEqual(execArgs.slice(0, 5), [
      "exec",
      "-C",
      currentTask.worktree,
      "--profile",
      currentTask.execution_profile,
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
    assert.ok(resumeArgs.includes('model_reasoning_effort="max"'));
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
    const { validateExecutorResult, validateVerificationResult } = await controller();
    const currentTask = task();
    const baseSha = "0123456789012345678901234567890123456789";
    const headSha = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
    const executor = {
      task_id: currentTask.task_id,
      status: "PASS",
      session_id: "session-1",
      base_sha: baseSha,
      head_sha: headSha,
      commit: headSha,
      changed_files: ["scripts/agent-flow.mjs"],
      tests: [{ command: "node --test", result: "PASS", evidence: "green" }],
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
    writeRuntimeState(fixture, state.task_id, state);
    const root = runtimeStateRoot(fixture);
    const commonDir = git(fixture, "rev-parse", "--path-format=absolute", "--git-common-dir");
    assert.equal(realpathSync(dirname(root)), realpathSync(commonDir), root);
    assert.equal(readRuntimeState(fixture, state.task_id).run_status, "EXECUTING");
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

  it("uses the native pure OpenCode plan invocation with a yuepu verifier", async () => {
    const { buildOpenCodeInvocation } = await controller();
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
    assert.deepEqual(Object.keys(JSON.parse(result.stdout).profiles), [
      "executor-sol-max-fast",
      "executor-terra-max-fast",
      "executor-terra-medium-fast",
    ]);

    const validation = spawnSync(process.execPath, [
      controllerPath,
      "validate",
      "CHG-2026-005-AGENT-FLOW",
      "--json",
    ], { cwd: repoRoot, encoding: "utf8" });
    assert.equal(validation.status, 0, validation.stderr);
    assert.equal(JSON.parse(validation.stdout).status, "PASS");
  });
});
