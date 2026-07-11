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

Run it with:

```bash
node reference-mcp/server.mjs
```

Every business result is simulated. A successful reference call is never proof
that the production MCP, database constraints, provider references, cron, or
WeChat notification path is ready.

