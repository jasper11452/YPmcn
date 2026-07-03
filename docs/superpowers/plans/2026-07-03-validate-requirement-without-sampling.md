# Validate Requirement Without Sampling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `validate_requirement` callable from MCP clients that do not implement Sampling by requiring the host Agent to pass a typed `parsed_requirement` object.

**Architecture:** Move the existing extraction model into the public request-schema module, pass it through FastMCP, and invoke deterministic requirement rules directly in the application service. Remove the obsolete Sampling adapter while preserving persistence, idempotency, workflow, and the other 11 public tools.

**Tech Stack:** Python 3.12, FastMCP, Pydantic v2, SQLAlchemy async, pytest, Ruff, uv.

## Global Constraints

- Keep exactly 12 Agent-visible MCP tools.
- Keep `raw_messages` as the evidence source and require exact evidence snippets.
- Do not add a model provider, model credential, or parser fallback to the server.
- Do not change the database schema or stored requirement format.
- Use `uv` for every Python dependency and command.

---

### Task 1: Define the public parsed-requirement contract

**Files:**
- Modify: `tests/tools/test_public_tool_schemas.py`
- Modify: `apps/mcp-server/tools/schemas.py`
- Modify: `apps/mcp-server/main.py`

**Interfaces:**
- Produces: `ParsedRequirement(RequestModel)` and `ValidateRequirementRequest.parsed_requirement: ParsedRequirement`.
- Produces: FastMCP `validate_requirement(..., parsed_requirement: ParsedRequirement, ...)`.

- [ ] **Step 1: Write failing schema and introspection tests**

```python
def test_validate_requirement_requires_parsed_requirement() -> None:
    with pytest.raises(ValidationError):
        ValidateRequirementRequest.model_validate({
            "trace_id": "t1",
            "idempotency_key": "i1",
            "raw_messages": [{"role": "client", "content": "小红书美妆"}],
        })

@pytest.mark.asyncio
async def test_validate_requirement_exposes_parsed_requirement() -> None:
    tool = next(item for item in await mcp.list_tools() if item.name == "validate_requirement")
    assert "parsed_requirement" in tool.inputSchema["required"]
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `uv run pytest tests/tools/test_public_tool_schemas.py -q`

Expected: FAIL because `parsed_requirement` is absent from the current request and MCP schemas.

- [ ] **Step 3: Add the nested Pydantic model and FastMCP argument**

Add the complete public model, add it to `ValidateRequirementRequest`, and pass the same typed object from the FastMCP function into the request model:

```python
class ParsedRequirement(RequestModel):
    platforms: list[Platform] = Field(default_factory=list)
    budget_min_cents: int | None = Field(default=None, ge=0)
    budget_max_cents: int | None = Field(default=None, ge=0)
    rebate_min_rate: float | None = Field(default=None, ge=0, le=1)
    rebate_max_rate: float | None = Field(default=None, ge=0, le=1)
    category_requirements: list[str] = Field(default_factory=list)
    quantity_total: int | None = Field(default=None, ge=1)
    content_formats: list[str] = Field(default_factory=list)
    cooperation_types: list[str] = Field(default_factory=list)
    creator_type_requirements: list[str] = Field(default_factory=list)
    creator_tier_requirements: list[str] = Field(default_factory=list)
    follower_min: int | None = Field(default=None, ge=0)
    follower_max: int | None = Field(default=None, ge=0)
    geo_requirements: dict[str, Any] = Field(default_factory=dict)
    audience_requirements: dict[str, Any] = Field(default_factory=dict)
    content_requirements: str | None = None
    tone_requirements: list[str] = Field(default_factory=list)
    negative_requirements: list[str] = Field(default_factory=list)
    requirements_json: dict[str, Any] = Field(default_factory=dict)
    confidence_map: dict[str, str] = Field(default_factory=dict)
    field_evidence: dict[str, Any] = Field(default_factory=dict)
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `uv run pytest tests/tools/test_public_tool_schemas.py -q`

Expected: PASS.

- [ ] **Step 5: Commit the public contract**

```bash
git add apps/mcp-server/tools/schemas.py apps/mcp-server/main.py tests/tools/test_public_tool_schemas.py
git commit -m "feat: accept parsed requirements from MCP hosts"
```

### Task 2: Remove runtime Sampling from validation

**Files:**
- Create: `tests/application/test_requirement_input.py`
- Modify: `tests/domain/test_requirement_rules.py`
- Delete: `tests/tools/test_sampling_parser.py`
- Delete: `apps/mcp-server/sampling.py`
- Modify: `apps/mcp-server/domain/requirements.py`
- Modify: `apps/mcp-server/application/service.py`

**Interfaces:**
- Consumes: `ValidateRequirementRequest.parsed_requirement`.
- Produces: `McpToolService._validate_requirement(request: ValidateRequirementRequest) -> ServiceResult` with no MCP context.

- [ ] **Step 1: Write a failing service test**

```python
@pytest.mark.asyncio
async def test_requirement_validation_uses_typed_input_without_sampling_context() -> None:
    request = ValidateRequirementRequest.model_validate({
        "trace_id": "trace-1",
        "idempotency_key": "idem-1",
        "raw_messages": [{"role": "client", "content": "小红书美妆"}],
        "parsed_requirement": {
            "platforms": ["xhs"],
            "category_requirements": ["beauty"],
            "field_evidence": {"platforms": "抖音"},
        },
    })
    service = McpToolService(cast(AsyncEngine, None))
    with pytest.raises(ToolFailure) as raised:
        await service._validate_requirement(request)
    assert raised.value.code == ErrorCode.VALIDATION_ERROR
```

The invalid evidence must be rejected before database access; this proves deterministic validation receives the parsed object without a Sampling context.

- [ ] **Step 2: Run focused test and verify RED**

Run: `uv run pytest tests/application/test_requirement_input.py -q`

Expected: FAIL because `_validate_requirement` still requires a context and invokes Sampling.

- [ ] **Step 3: Wire deterministic validation directly**

```python
async def _validate_requirement(self, request: ValidateRequirementRequest) -> ServiceResult:
    try:
        source_text = "\n".join(message.content for message in request.raw_messages)
        validated = validate_requirement_extraction(request.parsed_requirement, source_text)
    except InvalidRequirement as exc:
        raise ToolFailure(ErrorCode.VALIDATION_ERROR, str(exc)) from exc
```

Remove the special context branch from `_invoke_once`, import `ParsedRequirement` in domain rules, delete `sampling.py`, and replace domain-test imports.

- [ ] **Step 4: Run requirement tests and verify GREEN**

Run: `uv run pytest tests/application/test_requirement_input.py tests/domain/test_requirement_rules.py tests/tools/test_public_tool_schemas.py -q`

Expected: PASS.

- [ ] **Step 5: Commit the runtime change**

```bash
git add apps/mcp-server tests
git commit -m "refactor: remove MCP sampling requirement"
```

### Task 3: Update documentation and verify the branch

**Files:**
- Modify: `README.md`

**Interfaces:**
- Documents: host extraction, evidence requirements, and direct client compatibility.

- [ ] **Step 1: Replace Sampling guidance**

Document that the host Agent supplies `parsed_requirement`, evidence is copied from `raw_messages`, and server-side validation remains deterministic.

- [ ] **Step 2: Run complete verification**

```bash
uv sync --all-groups --locked
uv run ruff check .
uv run python -m compileall -q apps shared scripts
uv run pytest -q
git diff --check
git status --short
```

Expected: dependency sync, Ruff, compileall, pytest, and diff check exit 0; status contains only intentional changes before the final commit.

- [ ] **Step 3: Inspect MCP introspection**

Run a short `uv run python` program that calls `mcp.list_tools()` and asserts 12 tools, required `parsed_requirement`, and no Agent-visible `create_mcn_inquiries`.

Expected: all assertions pass.

- [ ] **Step 4: Commit and push existing PR branch**

```bash
git add README.md docs/superpowers/plans/2026-07-03-validate-requirement-without-sampling.md
git commit -m "docs: explain host-parsed requirements"
git push origin codex/implement-mcp-tools
```
