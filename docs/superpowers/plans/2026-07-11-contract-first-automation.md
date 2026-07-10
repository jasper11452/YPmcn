# YPmcn Contract-First Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a fail-closed, contract-first YPmcn control plane with safe local simulation, reproducible verification, and no automatic production downgrade.

**Architecture:** Approved JSON specs define the v2 target and observed legacy profile. Small TypeScript modules load contracts, guard calls, project recoverable session state, and adapt OpenClaw events; a network-free reference MCP exercises the complete target flow while a separate read-only provider checker reports production drift.

**Tech Stack:** Node.js 22, TypeScript 5.9, OpenClaw Plugin SDK 2026.6.11, Node test runner, Python stdlib unittest through `uv`, JSON/MCP 2024-11-05.

## Global Constraints

- Preserve the five existing modified `doc/*.md的替身` files byte-for-byte and never stage them.
- Use `uv`, never `pip`, for every Python command.
- Never print or commit credential values; secret diagnostics may print only file, rule, and line number.
- `mvp-v2` is the only writable target profile; `legacy-1.9.4` is detection-only and never an automatic fallback.
- No production network, database, WeCom, or credential side effect in tests or the reference MCP.
- A successful distribution does not enter `waiting_return` until `sync_mcn_inquiry_status` succeeds.
- Ordinary messages do not clear recovery state.
- The provider contract check is read-only (`initialize` and `tools/list` only).
- Production readiness remains failed until the target provider and database invariants are externally proven.

---

### Task 1: Security stop-loss and secret release gate

**Files:**
- Create: `scripts/scan-secrets.mjs`
- Create: `tests/secret_scan.test.mjs`
- Modify: `mock-mcp.mjs`
- Modify: `scripts/build-vector-index.mjs`
- Modify: `scripts/test-wecom-send.mjs`
- Modify: `vector-mcp/tests/hitrate-briefs.mjs`
- Modify: `vector-mcp/tests/recall-baseline.mjs`
- Modify: `vector-mcp/向量库使用指南.md`
- Modify: `YPmcn/src/index.ts`
- Delete: `YPmcn/mock-mcp.mjs`

**Interfaces:**
- Consumes: tracked files or an npm tarball path.
- Produces: `scanPaths(paths): Finding[]`, where a finding contains only `file`, `rule`, and `line`.

- [ ] **Step 1: Write failing security tests**

Assert that the scanner catches synthetic API keys and literal DB passwords without including the secret in JSON output. Assert that `YPmcn/src/index.ts` has no `fork`, `startMcpServer`, `YPMCN_START_LOCAL_MCP`, or customer Brief preview log.

```js
assert.equal(findings[0].rule, "generic-api-key");
assert.equal(JSON.stringify(findings).includes(secret), false);
assert.doesNotMatch(indexSource, /startMcpServer|raw_messages_preview/);
```

- [ ] **Step 2: Run RED**

Run: `node --test tests/secret_scan.test.mjs`

Expected: FAIL because the scanner does not exist and the plugin still auto-forks the mock.

- [ ] **Step 3: Implement the scanner and sanitize current files**

Replace literals with required environment reads. A missing credential must throw or return a failed health result; it must never fall back to a real-looking default. Remove package-local mock and all mock-fork code from plugin runtime.

- [ ] **Step 4: Run GREEN and scan tracked content**

Run: `node --test tests/secret_scan.test.mjs`

Run: `node scripts/scan-secrets.mjs --tracked`

Expected: both exit 0, zero findings, and no credential value printed.

- [ ] **Step 5: Commit**

```bash
git add scripts tests mock-mcp.mjs vector-mcp YPmcn/src/index.ts YPmcn/mock-mcp.mjs
git commit -m "security: fail closed and block credential packaging"
```

### Task 2: Machine-readable profiles, workflow, database boundaries, and errors

**Files:**
- Create: `YPmcn/spec/profiles/mvp-v2.json`
- Create: `YPmcn/spec/profiles/legacy-1.9.4.json`
- Create: `YPmcn/spec/workflow.json`
- Create: `YPmcn/spec/database.json`
- Create: `YPmcn/spec/errors.json`
- Create: `YPmcn/src/contract/types.ts`
- Create: `YPmcn/src/contract/loader.ts`
- Create: `YPmcn/src/contract/validator.ts`
- Create: `YPmcn/tests/contract.test.mjs`
- Modify: `YPmcn/tsconfig.json`

**Interfaces:**
- Consumes: JSON files from `YPmcn/spec`.
- Produces: `loadContractProfile(name)`, `validateToolParams(tool, params)`, `validateFieldSelection(result)`, `expectedRequiredTools(profile)`.

- [ ] **Step 1: Write failing contract tests**

Cover exact v2 IDs and reject legacy payloads:

```js
assert.deepEqual(validateToolParams("search_creators", { requirement_id: "req-1" }), []);
assert.match(validateToolParams("search_creators", { demand_id: "d-1", demand_version: 1 })[0].code, /SCHEMA_MISMATCH/);
assert.deepEqual(validateToolParams("sync_mcn_inquiry_status", {
  mcn_recommendation_id: "mcnr-1",
  requirement_id: "req-1"
}), []);
```

Assert writer ownership (`sync_mcn_inquiry_status` is the only `mcn_inquiries` writer), required unique constraints, error code uniqueness, complete state transitions, and legacy detection-only status.

- [ ] **Step 2: Run RED**

Run: `cd YPmcn && npm run build && node --test tests/contract.test.mjs`

Expected: FAIL because specs and loaders do not exist.

- [ ] **Step 3: Add complete specs and minimal loader/validator**

No placeholders. Include all 14 target tool cards, optional `get_workflow_state`, explicit input properties, forbidden legacy fields, side effects, retry policy, success evidence, writers, state transitions, and external readiness invariants.

- [ ] **Step 4: Run GREEN**

Run: `cd YPmcn && npm run build && node --test tests/contract.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add YPmcn/spec YPmcn/src/contract YPmcn/tests/contract.test.mjs YPmcn/tsconfig.json
git commit -m "feat: add approved runtime contracts"
```

### Task 3: Modular fail-closed hooks and recoverable state projection

**Files:**
- Create: `YPmcn/src/hooks/types.ts`
- Create: `YPmcn/src/hooks/runtime-state.ts`
- Create: `YPmcn/src/hooks/guards.ts`
- Create: `YPmcn/src/hooks/results.ts`
- Create: `YPmcn/src/hooks/register.ts`
- Modify: `YPmcn/src/index.ts`
- Create: `YPmcn/tests/guards.test.mjs`
- Create: `YPmcn/tests/runtime-flow.test.mjs`
- Create: `YPmcn/tests/registration.test.mjs`
- Delete: `YPmcn/tests/hooks.test.mjs`

**Interfaces:**
- Consumes: OpenClaw `before_tool_call`, `after_tool_call`, `tool_result_persist`, `message_received`, `agent_turn_prepare`, and `session_end` events.
- Produces: `createRuntimeStateStore`, `runBeforeToolCallGuards`, `applyToolResult`, `registerHooks`, `resetRuntimeStateForTests`.

- [ ] **Step 1: Write state-flow tests first**

Table-drive the mandatory sequence and negative paths:

```text
rank_mcns -> select -> create -> sync -> waiting
waiting -> explicit manual intent -> sync -> ingest(manual) -> sync -> recovered -> rank
waiting -> cron run -> sync -> ingest(scheduled) -> sync -> recovered
```

Required negative assertions:

- Missing session, role, toolCallId, gate, or field selection blocks send.
- `preview_only=true` blocks in v2.
- send success followed by sync failure remains `distribution_sync_pending`.
- plain messages do not unlock.
- scheduled ingest outside `ctx.trigger=cron` blocks.
- ingest without a current successful sync blocks.
- rank before final recovered sync blocks.
- duplicate terminal recovery does not invoke ingest.

- [ ] **Step 2: Run RED**

Run: `cd YPmcn && npm run build && node --test tests/guards.test.mjs tests/runtime-flow.test.mjs tests/registration.test.mjs`

Expected: FAIL because modules and new transitions do not exist.

- [ ] **Step 3: Implement focused modules**

Use the v2 Spec for parameter validation. Runtime state is a TTL-bound projection keyed by session; clear it on `session_end`. Persist only IDs, field-selection proof, last sync evidence, phase, and confirmation timestamps. Never log payload bodies.

- [ ] **Step 4: Run GREEN and old-regression check**

Run: `cd YPmcn && npm test`

Expected: all new hook tests pass and no TAP output contains customer Brief text.

- [ ] **Step 5: Commit**

```bash
git add YPmcn/src YPmcn/tests
git commit -m "refactor: enforce the v2 workflow in modular hooks"
```

### Task 4: Network-free reference MCP and read-only provider checker

**Files:**
- Create: `reference-mcp/state.mjs`
- Create: `reference-mcp/server.mjs`
- Create: `reference-mcp/README.md`
- Create: `tests/reference_mcp.test.mjs`
- Create: `scripts/check-provider-contract.mjs`
- Create: `tests/provider_contract.test.mjs`

**Interfaces:**
- Reference MCP consumes JSON-RPC MCP 2024-11-05 on stdio and produces deterministic `tools/list`/`tools/call` results marked `simulated=true`.
- Provider checker consumes `--url` or `--snapshot` and produces `{status, detectedProfile, missingTools, schemaDiffs, schemaHash}`.

- [ ] **Step 1: Write failing scenario and comparator tests**

The scenario test must exercise the complete v2 path, prove repeated sync/ingest is idempotent, and prove no network function is called. The comparator must identify a legacy fixture and report exactly the three missing target tools.

- [ ] **Step 2: Run RED**

Run: `node --test tests/reference_mcp.test.mjs tests/provider_contract.test.mjs`

Expected: FAIL because server and checker do not exist.

- [ ] **Step 3: Implement deterministic state and SSE/stdio clients**

Use stable incrementing IDs and a fake clock. `create_with_distributions` creates simulated provider references only; `sync_mcn_inquiry_status` owns inquiry state; ingest owns submission items only. The remote checker sends only initialize, initialized notification, and tools/list.

- [ ] **Step 4: Run GREEN and current provider audit**

Run: `node --test tests/reference_mcp.test.mjs tests/provider_contract.test.mjs`

Run: `node scripts/check-provider-contract.mjs --url https://mcp.eshypdata.com/sse`

Expected: tests PASS; current provider command exits nonzero with detected legacy profile and no write calls.

- [ ] **Step 5: Commit**

```bash
git add reference-mcp scripts/check-provider-contract.mjs tests/reference_mcp.test.mjs tests/provider_contract.test.mjs
git commit -m "feat: add safe MCP simulation and provider preflight"
```

### Task 5: Skill, tool cards, CSV, and human/Agent documentation

**Files:**
- Modify: `YPmcn/skills/media-assistant/SKILL.md`
- Modify: `YPmcn/skills/media-assistant/references/*.md`
- Modify: `YPmcn/skills/media-assistant/references/tools/*.md`
- Create: `YPmcn/skills/media-assistant/references/tools/select_inquiry_form_fields.md`
- Create: `YPmcn/skills/media-assistant/references/tools/sync_mcn_inquiry_status.md`
- Modify: `YPmcn/skills/media-assistant/references/creator_candidate_pool_schema.csv`
- Modify: `README.md`
- Modify: `YPmcn/README.md`
- Create: `AGENTS.md`
- Modify: `tests/test_skill_package.py`

**Interfaces:**
- Consumes: approved Spec names and state transitions.
- Produces: Agent routing instructions that fail with `integration_required` on profile mismatch and never expose simulated success as production evidence.

- [ ] **Step 1: Replace brittle string tests with spec-derived failing tests**

Assert all required tools have cards, all cards contain input/success/stop/error sections, all documented IDs match the v2 profile, the CSV hash/count is the supplied 153-field authority, and forbidden legacy phrases are absent.

- [ ] **Step 2: Run RED**

Run: `PYTHONDONTWRITEBYTECODE=1 uv run --no-project python -B -m unittest -v tests/test_skill_package.py`

Expected: FAIL on missing cards and old preview/candidate-pool recovery language.

- [ ] **Step 3: Rewrite guidance from the Spec**

Keep `SKILL.md` under 180 lines. Put detail in references. State that field selection is the final send confirmation, ordinary messages do not clear waiting, manual/scheduled recovery share `sync -> ingest -> sync`, and production mismatch is a hard integration error.

- [ ] **Step 4: Run GREEN**

Run: `PYTHONDONTWRITEBYTECODE=1 uv run --no-project python -B -m unittest -v tests/test_skill_package.py`

Expected: all package contract tests pass.

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md README.md YPmcn/README.md YPmcn/skills tests/test_skill_package.py
git commit -m "docs: align agents and operators with the v2 contract"
```

### Task 6: Vector MCP correctness and reproducible tests

**Files:**
- Modify: `vector-mcp/src/providers/siliconflow-embedding.ts`
- Modify: `vector-mcp/src/providers/siliconflow-reranker.ts`
- Modify: `vector-mcp/src/vector/qdrant.ts`
- Modify: `vector-mcp/src/vector/sync.ts`
- Modify: `vector-mcp/src/tools/handlers.ts`
- Modify: `vector-mcp/src/server.ts`
- Modify: `vector-mcp/package.json`
- Create: `vector-mcp/tests/rrf.test.mjs`
- Create: `vector-mcp/tests/sync.test.mjs`
- Create: `vector-mcp/tests/reliability.test.mjs`
- Modify: `.gitignore`
- Delete: `vector-mcp/dist/**`

**Interfaces:**
- Embedding/rerank providers accept `timeoutMs`, bounded retries, and batch size.
- Fake persistence uses atomic replacement and exposes corruption as a health error.
- Real initialization is represented by a single shared Promise.

- [ ] **Step 1: Restore tests to source and add failing reliability tests**

Test concurrent initialization calls one loader, geo filtering leaves shared points unchanged on success and failure, aborted fetch maps to a typed timeout error, and persistence writes by temp-file rename.

- [ ] **Step 2: Run RED**

Run: `cd vector-mcp && npm run build && npm test`

Expected: FAIL on missing source tests and unsafe behavior.

- [ ] **Step 3: Implement minimal reliability changes**

Do not redesign ranking. Keep existing algorithms and public tools; fix only the evidenced concurrency, timeout, mutation, persistence, health, dependency, and generated-dist problems.

- [ ] **Step 4: Run GREEN**

Run: `cd vector-mcp && npm ci --registry=https://registry.npmmirror.com && npm run build && npm test`

Expected: all vector tests pass from source-owned tests.

- [ ] **Step 5: Commit**

```bash
git add .gitignore vector-mcp
git commit -m "fix: harden vector MCP reliability"
```

### Task 7: Unified verification, reproducible package, and CI

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `YPmcn/package.json`
- Modify: `YPmcn/package-lock.json`
- Modify: `YPmcn/openclaw.plugin.json`
- Modify: `YPmcn/.claude-plugin/plugin.json`
- Modify: `YPmcn/mcp.json`
- Create: `scripts/verify.mjs`
- Create: `scripts/prepare-package.mjs`
- Create: `tests/package_release.test.mjs`
- Create: `.github/workflows/verify.yml`

**Interfaces:**
- `npm run verify` is the single offline acceptance entry.
- `npm run verify:provider` is the separate read-only production compatibility check.
- `npm run pack:yp` verifies, cleans, builds, stages only current vector dist, scans, then packs.

- [ ] **Step 1: Write failing metadata and package tests**

Assert all version fields equal `3.0.0`, package metadata uses nested `openclaw.extensions`, dependencies are exact/owned, pack content has no source/tests/mock/secrets, and the Spec directory is present.

- [ ] **Step 2: Run RED**

Run: `node --test tests/package_release.test.mjs`

Expected: FAIL on version drift, invalid metadata, and stale package contents.

- [ ] **Step 3: Implement verify and package pipelines**

Use `spawnSync` with explicit cwd and inherited stdio. Stop on first failure and report the exact stage. `prepare-package` removes the prior staged vector directory before copying the freshly built dist.

- [ ] **Step 4: Run full verification from clean dependencies**

Run: `npm ci --registry=https://registry.npmmirror.com`

Run: `npm ci --prefix YPmcn --registry=https://registry.npmmirror.com`

Run: `npm ci --prefix vector-mcp --registry=https://registry.npmmirror.com`

Run: `npm run verify`

Run: `npm run pack:yp`

Expected: offline verification exits 0; the new tarball passes secret/content scan.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json YPmcn/package.json YPmcn/package-lock.json YPmcn/openclaw.plugin.json YPmcn/.claude-plugin/plugin.json YPmcn/mcp.json scripts tests .github
git commit -m "build: add one-command verification and safe packaging"
```

### Task 8: Independent review and integration readiness report

**Files:**
- Create: `docs/integration-readiness.md`
- Modify: any owned file required by verified review findings

**Interfaces:**
- Produces: `PASS/FAIL + evidence` for repository acceptance and a separate production readiness result.

- [ ] **Step 1: Run independent read-only code review**

Reviewer checks the complete diff against the design, focusing on fail-open sends, state recovery, secret exposure, untested generated files, and provider downgrade paths.

- [ ] **Step 2: Run independent verification**

Run: `npm run verify`

Run: `npm run verify:provider`

Expected: repository verification PASS; current production provider readiness FAIL with the documented three missing tools and legacy ID schema.

- [ ] **Step 3: Fix actionable repository findings and rerun**

No production readiness failure may be hidden or weakened to make the command green.

- [ ] **Step 4: Record readiness without secrets or absolute paths**

Document repository evidence, current provider gaps, database/provider invariants still owned externally, credential rotation requirement, and the exact next rollout gate.

- [ ] **Step 5: Commit**

```bash
git add docs/integration-readiness.md
git commit -m "docs: record integration readiness and rollout gates"
```

