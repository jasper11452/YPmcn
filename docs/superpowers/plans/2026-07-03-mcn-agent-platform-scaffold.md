# MCN Agent Platform Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and publish a testable monorepo scaffold matching the supplied MCN agent platform map.

**Architecture:** Preserve the requested service directories and configure them as independent Python import roots. Expose 13 FastMCP tools through a handler registry, keep workflow and algorithm logic pure, and represent persistence through ordered PostgreSQL migrations plus replaceable ports.

**Tech Stack:** Python 3.12, uv, FastMCP from `mcp>=1.27,<2`, Pydantic 2, pytest, Ruff, PostgreSQL 16, pgvector.

## Global Constraints

- Use `uv`; do not use `pip`.
- Preserve all service, tool, migration, schema, and test paths from the supplied tree.
- Never simulate successful database or WeCom writes when no adapter is configured.
- Keep MCP responses in `{success, data, error, trace_id}` form.
- Keep all algorithms deterministic and scores bounded to `0..1`.
- Do not commit credentials, caches, generated build artifacts, or local databases.

---

### Task 1: Project Configuration and Structure Contract

**Files:**
- Create: `pyproject.toml`
- Create: `.gitignore`
- Modify: `README.md`
- Create: `tests/contract/test_project_structure.py`

**Interfaces:**
- Consumes: the supplied directory map.
- Produces: a Python 3.12 uv project and an executable file-layout contract.

- [ ] **Step 1: Write the failing structure test**

```python
from pathlib import Path

ROOT = Path(__file__).parents[2]


def test_required_top_level_paths_exist() -> None:
    required = [
        "apps/mcp-server/main.py",
        "apps/workflow-engine/state_store.py",
        "apps/algorithm-engine/ranking_strategies.py",
        "db/migrations/020_mcp_tool_call_ledger.sql",
        "shared/schemas/requirement_schema.py",
    ]
    assert not [path for path in required if not (ROOT / path).is_file()]
```

- [ ] **Step 2: Verify RED**

Run: `uv run --with pytest pytest tests/contract/test_project_structure.py -q`

Expected: failure listing the missing requested paths.

- [ ] **Step 3: Add project metadata and create the requested directories**

Use `requires-python = ">=3.12"`, runtime dependencies `mcp>=1.27,<2` and
`pydantic>=2.8,<3`, plus a `dev` dependency group containing pytest and Ruff.
Configure pytest import roots for the three Python services and the repository
root. Document `uv sync --all-groups`, the MCP run command, and test commands.

- [ ] **Step 4: Run the test again after later tasks populate files**

Run: `uv run pytest tests/contract/test_project_structure.py -q`

Expected: `1 passed`.

- [ ] **Step 5: Commit**

```bash
git add pyproject.toml .gitignore README.md tests/contract/test_project_structure.py
git commit -m "chore: configure MCN platform monorepo"
```

### Task 2: MCP Contract and 13 Tool Surface

**Files:**
- Create: `apps/mcp-server/contract/{__init__,error_codes,response_envelope,idempotency}.py`
- Create: `apps/mcp-server/tools/{__init__,registry}.py`
- Create: the 13 requested modules under `apps/mcp-server/tools/`
- Create: `apps/mcp-server/main.py`
- Create: `tests/contract/test_response_envelope.py`
- Create: `tests/contract/test_idempotency.py`
- Create: `tests/tools/test_tool_registry.py`

**Interfaces:**
- Consumes: `dict[str, object]` tool payloads and optional injected async handlers.
- Produces: `ResponseEnvelope`, `IdempotencyStore.execute(key, payload, operation)`, and exactly 13 MCP tool registrations.

- [ ] **Step 1: Write failing envelope and registry tests**

```python
def test_error_envelope_never_contains_data() -> None:
    result = ResponseEnvelope.fail(ErrorCode.NOT_CONFIGURED, "backend missing")
    assert result.success is False
    assert result.data is None
    assert result.error.code == "NOT_CONFIGURED"


def test_registry_exposes_exact_tool_names() -> None:
    assert set(TOOL_NAMES) == EXPECTED_TOOL_NAMES
```

- [ ] **Step 2: Verify RED**

Run: `uv run pytest tests/contract/test_response_envelope.py tests/tools/test_tool_registry.py -q`

Expected: import failures because contract and registry modules do not exist.

- [ ] **Step 3: Implement the minimal contract and registry**

`ResponseEnvelope.ok(data)` sets `success=True`; `fail(code, message, details)`
sets `success=False`. `ToolRegistry.invoke()` returns `NOT_CONFIGURED` when a
handler is absent and converts unexpected exceptions to `INTERNAL_ERROR`.
Each requested tool module exports `TOOL_NAME` and `async execute(payload)`.
`main.py` registers all 13 wrappers with `FastMCP.tool(name=TOOL_NAME)`.

- [ ] **Step 4: Add and verify idempotency behavior**

```python
async def test_same_key_with_different_payload_conflicts() -> None:
    store = IdempotencyStore()
    await store.execute("k", {"a": 1}, operation)
    with pytest.raises(IdempotencyConflict):
        await store.execute("k", {"a": 2}, operation)
```

Run: `uv run pytest tests/contract tests/tools -q`

Expected: all contract and tool tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/mcp-server tests/contract tests/tools
git commit -m "feat: scaffold MCP contract and tools"
```

### Task 3: Workflow and Algorithm Engines

**Files:**
- Create: requested files under `apps/workflow-engine/phases/`
- Create: requested files under `apps/workflow-engine/gates/`
- Create: `apps/workflow-engine/state_store.py`
- Create: requested files under `apps/algorithm-engine/`
- Create: `tests/state_transition/test_state_machine.py`
- Create: `tests/algorithm/test_scoring.py`

**Interfaces:**
- Consumes: typed phase values, expected state versions, normalized scoring inputs.
- Produces: validated transitions, compare-and-set state updates, bounded scores, supply risk assessment, and deterministic ranking.

- [ ] **Step 1: Write failing transition and score tests**

```python
def test_stale_state_version_is_rejected() -> None:
    store = InMemoryStateStore()
    state = store.create("demand-1")
    store.transition("demand-1", state.version, WorkflowPhase.READY)
    with pytest.raises(VersionConflict):
        store.transition("demand-1", state.version, WorkflowPhase.CANDIDATE_POOL_READY)


def test_creator_score_matches_weighted_formula() -> None:
    score = creator_score(content=1, price=0.5, rebate=0.4, fit=0.8, delivery=0.9)
    assert score == pytest.approx(0.745)
```

- [ ] **Step 2: Verify RED**

Run: `uv run pytest tests/state_transition tests/algorithm -q`

Expected: import failures because engines do not exist.

- [ ] **Step 3: Implement minimal pure engines**

Define the linear workflow sequence `DRAFT -> READY -> CANDIDATE_POOL_READY ->
WAITING_BACKEND_INQUIRY -> RECOMMENDATION_READY -> SUBMISSION_BATCH_READY ->
CLOSED`. Gate modules expose typed confirmation records. Implement creator
weights `0.30/0.20/0.15/0.20/0.15`, MCN weights `0.10/0.70/0.20`, and subtract
a bounded risk penalty after base scoring.

- [ ] **Step 4: Verify GREEN**

Run: `uv run pytest tests/state_transition tests/algorithm -q`

Expected: all workflow and algorithm tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/workflow-engine apps/algorithm-engine tests/state_transition tests/algorithm
git commit -m "feat: add workflow and ranking cores"
```

### Task 4: Shared Schemas, Persistence Map, and Integration Ports

**Files:**
- Create: requested files under `shared/`
- Create: `db/migrations/001_*.sql` through `020_*.sql`
- Create: `db/seeds/.gitkeep`
- Create: requested WeCom integration modules
- Create: route README files under each admin-console area
- Create: `tests/contract/test_migrations.py`
- Create: `tests/contract/test_shared_schemas.py`

**Interfaces:**
- Consumes: normalized requirements, score details, formula snapshots, integration messages.
- Produces: validated shared models, ordered idempotent schema migrations, and side-effect-free integration ports.

- [ ] **Step 1: Write failing schema and migration tests**

```python
def test_migrations_are_contiguous() -> None:
    files = sorted(MIGRATIONS.glob("*.sql"))
    assert [int(path.name[:3]) for path in files] == list(range(1, 21))


def test_requirement_rejects_unknown_platform() -> None:
    with pytest.raises(ValidationError):
        Requirement(platforms=["unknown"], budget=1000)
```

- [ ] **Step 2: Verify RED**

Run: `uv run pytest tests/contract/test_migrations.py tests/contract/test_shared_schemas.py -q`

Expected: import and missing-file failures.

- [ ] **Step 3: Implement models, migrations, and ports**

Use `Platform` and `CandidateSource` string enums, Pydantic models with strict
non-negative budgets and bounded score components, `CREATE TABLE IF NOT EXISTS`
in every migration, UUID primary keys, UTC timestamps, `jsonb` for unfinalized
business payloads, and `vector(1536)` for content embeddings. WeCom modules
must receive a notifier/client callable by dependency injection and perform no
network access at import time.

- [ ] **Step 4: Verify GREEN**

Run: `uv run pytest tests/contract -q`

Expected: all contract tests pass.

- [ ] **Step 5: Commit**

```bash
git add shared db apps/wecom-integration apps/admin-console tests/contract
git commit -m "feat: add schemas migrations and integration ports"
```

### Task 5: Full Verification and Publication

**Files:**
- Modify only files identified by verification failures.

**Interfaces:**
- Consumes: the completed repository.
- Produces: a clean branch pushed to `jasper11452/YPmcn` and a draft PR to `main`.

- [ ] **Step 1: Install and lock dependencies**

Run: `uv sync --all-groups`

Expected: exit 0 and a generated `uv.lock`.

- [ ] **Step 2: Run all quality gates**

Run: `uv run pytest -q && uv run ruff check . && git diff --check`

Expected: zero test failures, zero Ruff findings, and no whitespace errors.

- [ ] **Step 3: Verify scope**

Run: `git status -sb && git diff main...HEAD --stat && git log --oneline main..HEAD`

Expected: only scaffold files, tests, docs, and lockfile are present.

- [ ] **Step 4: Commit verification changes and push**

```bash
git add uv.lock
git commit -m "chore: lock verified dependencies"
git push -u origin codex/scaffold-mcn-agent-platform
```

- [ ] **Step 5: Open the GitHub pull request**

Create a draft PR titled `[codex] scaffold MCN agent platform` against `main`.
The PR body must state the architecture, safe `NOT_CONFIGURED` behavior, test
commands, and deliberately deferred production adapters.
