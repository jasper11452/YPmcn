CREATE TABLE IF NOT EXISTS mcp_tool_call_ledger (
    call_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tool_name VARCHAR(64) NOT NULL,
    trace_id VARCHAR(128) NOT NULL,
    idempotency_key VARCHAR(255) NOT NULL,
    request_hash CHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'in_progress',
    response_envelope_json JSON NULL,
    error_code VARCHAR(64) NULL,
    workflow_state_before_json JSON NULL,
    workflow_state_after_json JSON NULL,
    started_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    completed_at DATETIME(6) NULL,
    UNIQUE KEY uq_mcp_ledger_tool_key (tool_name, idempotency_key),
    UNIQUE KEY uq_mcp_ledger_trace (trace_id),
    KEY idx_mcp_ledger_status_started (status, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS mcp_workflow_states (
    demand_id BIGINT UNSIGNED NOT NULL,
    demand_version INT UNSIGNED NOT NULL,
    phase VARCHAR(64) NOT NULL,
    state_version INT UNSIGNED NOT NULL DEFAULT 1,
    pending_gate VARCHAR(64) NULL,
    platform_states_json JSON NOT NULL DEFAULT (JSON_OBJECT()),
    resolved_run_id BIGINT UNSIGNED NULL,
    resolved_batch_no INT UNSIGNED NULL,
    context_json JSON NOT NULL DEFAULT (JSON_OBJECT()),
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (demand_id, demand_version),
    CONSTRAINT fk_mcp_workflow_demand FOREIGN KEY (demand_id, demand_version)
        REFERENCES customer_demands (demand_id, demand_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS mcp_gate_confirmations (
    gate_id CHAR(32) NOT NULL PRIMARY KEY,
    demand_id BIGINT UNSIGNED NOT NULL,
    demand_version INT UNSIGNED NOT NULL,
    run_id BIGINT UNSIGNED NULL,
    inquiry_id BIGINT UNSIGNED NULL,
    confirmation_type VARCHAR(64) NOT NULL,
    confirmed_by VARCHAR(255) NOT NULL,
    risk_notes TEXT NOT NULL,
    confirmation_payload_json JSON NOT NULL DEFAULT (JSON_OBJECT()),
    confirmed_at DATETIME(6) NOT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    UNIQUE KEY uq_mcp_gate_scope (demand_id, demand_version, confirmation_type, gate_id),
    KEY idx_mcp_gate_run (run_id),
    KEY idx_mcp_gate_inquiry (inquiry_id),
    CONSTRAINT fk_mcp_gate_demand FOREIGN KEY (demand_id, demand_version)
        REFERENCES customer_demands (demand_id, demand_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS mcp_outbox (
    outbox_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    aggregate_type VARCHAR(64) NOT NULL,
    aggregate_id VARCHAR(128) NOT NULL,
    event_type VARCHAR(128) NOT NULL,
    payload_json JSON NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'pending',
    attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
    available_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    claimed_at DATETIME(6) NULL,
    processed_at DATETIME(6) NULL,
    last_error TEXT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    UNIQUE KEY uq_mcp_outbox_event (aggregate_type, aggregate_id, event_type),
    KEY idx_mcp_outbox_dispatch (status, available_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
