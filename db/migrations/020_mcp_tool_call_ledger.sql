CREATE TABLE IF NOT EXISTS mcp_tool_call_ledger (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tool_name text NOT NULL,
    trace_id text NOT NULL UNIQUE,
    idempotency_key text,
    request_hash text NOT NULL,
    response_envelope_json jsonb,
    success boolean,
    started_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    UNIQUE (tool_name, idempotency_key)
);
