# Validate Requirement Without MCP Sampling

## Decision

`validate_requirement` no longer asks the MCP client to execute
`sampling/createMessage`. The host Agent extracts the requirement with its current
model and supplies the result as a required, explicitly typed
`parsed_requirement` object. The MCP server remains responsible for deterministic
validation, evidence checking, version fingerprints, idempotency, persistence, and
workflow transitions.

This keeps the existing 12-tool public surface and removes a client capability that
is not consistently available in Codex, WorkBuddy, and generic MCP clients.

## Public Interface

The write envelope remains unchanged: `trace_id`, `idempotency_key`,
`raw_messages`, optional `project_context`, and the optional existing demand ID and
version pair.

`parsed_requirement` is required and contains the existing extraction contract:

- platforms, budgets, rebate bounds, categories, quantity;
- content/cooperation formats, creator types and tiers, follower range;
- geography, audience, content, tone, and exclusion requirements;
- `requirements_json`, `confidence_map`, and `field_evidence`.

The host must copy evidence snippets exactly from `raw_messages`, must not infer
missing blockers, and must use cents, 0-1 rebate rates, and `xhs`/`dy` platform
values. Pydantic rejects unknown fields and invalid primitive ranges before any
business write.

## Data Flow

1. The host Agent reads the customer messages and builds `parsed_requirement`.
2. FastMCP validates the explicit nested schema.
3. The service reserves the idempotency key.
4. Deterministic rules validate evidence, blockers, ranges, KOC semantics, filter
   rules, confidence values, and the version fingerprint.
5. The existing transaction writes or versions `customer_demands` and advances the
   workflow.

No model provider, model credential, or fallback parser is added to the server.

## Error Handling

- Missing or malformed `parsed_requirement` is a request validation error.
- Evidence not found verbatim in `raw_messages` is `VALIDATION_ERROR`.
- Missing blocker values still produce a successful `draft` demand with clarifying
  questions.
- `SAMPLING_UNAVAILABLE` is removed from this execution path but may remain in the
  shared error-code enum for backward compatibility during this phase.

## Compatibility and Scope

This is an intentional breaking input change for `validate_requirement`; the other
11 tools and response envelopes do not change. There is no database migration and
no change to stored requirement JSON. The obsolete Sampling adapter and its tests
are removed so the codebase has one requirement-ingestion path.

## Verification

- MCP introspection exposes required `parsed_requirement` and no generic payload.
- A request can execute without a Sampling context.
- Existing evidence, blocker, confidence, KOC, filter, fingerprint, persistence,
  and idempotency tests continue to pass.
- MCP introspection still lists exactly 12 public tools.
- Ruff, compileall, full pytest, and MySQL integration tests pass.
