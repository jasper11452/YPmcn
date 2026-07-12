# YPmcn reference MCP

This is a deterministic, network-free implementation of the approved `mvp-v2`
tool contract. It is intended for integration tests, Agent rehearsal, and schema
validation only.

- Transport: newline-delimited JSON-RPC over stdio
- MCP protocol: `2024-11-05`
- IDs: stable incrementing reference IDs
- Persistence: in-memory only
- Provider/network calls: none
- Tool-call marker: `result._meta.simulated=true` and
  `result._meta.productionEvidence=false`
- Business results: exact `spec/mcp.json` envelopes with no simulation marker in
  `data`
- Workflow authority: closed-world combinations from `spec/workflow.json`, with
  monotonic `state_version` and derived `allowed_actions`

Run it with:

```bash
node reference-mcp/server.mjs
```

Every business result is simulated. A successful reference call is never proof
that the production MCP, database constraints, provider references, cron, or
WeChat notification path is ready.

The reference workflow enforces the approved recovery order:

```text
sync_mcn_inquiry_status (refresh)
→ ingest_mcn_submissions (request)
→ sync_mcn_inquiry_status (finalize)
```

`manual` and `scheduled` are audit origins for the same idempotent recovery
operation; they do not grant recovery authority. Requirement validation also
enforces canonical raw-message equality, the approved dictionary identity,
budget and rebate bounds, ordered timezone-qualified deadlines, and the
closed-world constraint grammar. Replaying the same canonical requirement
reuses its stable result without advancing workflow state; a different intake
in the same in-memory workflow fails closed.

Selection, send, snapshot, recovery, recommendation, and submission identities
are stable for one process. Frozen artifacts are copied on output and are not
rewritten by later manual data. The reference implementation does not fabricate
offer-promotion events or production deployment evidence.
