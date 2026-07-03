# MCN Agent Platform Scaffold Design

## Goal

Create a production-oriented, testable monorepo scaffold matching the supplied
MCN agent platform directory map. The scaffold must make architectural
boundaries executable without inventing database credentials, WeCom APIs, or
unfinished business decisions.

## Scope

The first increment includes:

- the 13 requested MCP tool modules and a runnable FastMCP v1 server;
- a uniform response envelope, error codes, trace IDs, and idempotency port;
- workflow phases, allowed transitions, human gate types, and an optimistic
  versioned in-memory state store;
- deterministic creator/MCN scoring, risk penalties, filters, supply
  assessment, and ranking strategies;
- shared Pydantic schemas and enums;
- 20 ordered PostgreSQL migrations, including pgvector support;
- explicit integration ports for WeCom and admin-console placeholder routes;
- tests proving package structure, contracts, state transitions, algorithms,
  MCP tool registration, and migration ordering.

Out of scope are production persistence adapters, actual WeCom network calls,
authentication, customer-specific scoring calibration, and a styled admin UI.

## Approaches Considered

1. **Exact service layout with independent import roots (selected).** Preserve
   `apps/mcp-server`, `apps/workflow-engine`, and the other requested paths.
   A root `pyproject.toml` configures the service roots for tests. This has the
   highest fidelity to the supplied architecture and keeps future extraction
   into deployable services straightforward.
2. **Single `src/mcn_agent_platform` Python package.** This gives cleaner Python
   imports but materially diverges from the requested tree and blurs service
   ownership.
3. **Immediately containerize every service.** This gives stronger runtime
   isolation but adds deployment machinery before any persistence or API
   contract has been finalized.

## Architecture

Each application owns its implementation and depends only on shared schemas or
small explicit ports. The MCP server exposes 13 stable tool names. Each tool
delegates to an injected handler registry; without a handler it returns a
structured `NOT_CONFIGURED` error rather than silently simulating business
work. This lets the protocol surface run now while preserving a safe boundary
for later database-backed implementations.

The workflow engine is a pure state machine. Its store performs compare-and-set
updates using `state_version`, so later PostgreSQL adapters can retain the same
interface. Human approvals are typed gate records rather than hidden branches
inside tool functions.

The algorithm engine is stateless and deterministic. It consumes normalized
numeric inputs and emits bounded scores. Formula weights live in code for this
increment and are also representable through `formula_snapshot_schema.py` for
auditable recommendation runs.

PostgreSQL migrations are append-only and ordered from `001` through `020`.
Foreign keys encode ownership where the supplied domain map is unambiguous;
flexible business payloads use `jsonb` until detailed schemas are approved.

## Data Flow

1. An MCP client calls one of the registered tools with a JSON payload.
2. The tool wrapper creates a trace ID and validates the request boundary.
3. The registry resolves the configured application handler.
4. The handler reads or updates workflow state, invokes algorithms, and writes
   through infrastructure adapters in later increments.
5. The wrapper returns `{success, data, error, trace_id}` consistently.

## Error Handling

Domain failures use stable codes: `INVALID_PHASE`, `VERSION_CONFLICT`,
`VALIDATION_ERROR`, `IDEMPOTENCY_CONFLICT`, `NOT_FOUND`, `NOT_CONFIGURED`, and
`INTERNAL_ERROR`. Unknown exceptions are not exposed directly through the MCP
response. State writes reject stale versions. Duplicate idempotency keys return
the original result only when their request fingerprints match.

## Testing and Success Criteria

The scaffold is complete when:

- `uv sync --all-groups` succeeds on Python 3.12+;
- `uv run pytest` passes with tests for contracts, algorithms, transitions,
  registration, migrations, and every requested path;
- `uv run ruff check .` reports no findings;
- importing `apps/mcp-server/main.py` creates a server containing exactly the
  13 requested tool names;
- the Git diff contains no credentials, generated build output, or unrelated
  files.

The MCP dependency is constrained to `mcp>=1.27,<2` because v2 is not yet the
stable line as of 2026-07-03.
