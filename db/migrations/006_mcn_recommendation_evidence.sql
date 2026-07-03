ALTER TABLE mcn_recommendation_items
    ADD COLUMN mcn_run_id CHAR(32) NOT NULL DEFAULT 'legacy' AFTER item_id,
    ADD COLUMN rating_inputs_json JSON NOT NULL DEFAULT (JSON_OBJECT()) AFTER formula_snapshot_json,
    ADD COLUMN gate_confirmation_id CHAR(32) NULL AFTER risk_notes,
    ADD COLUMN confirmed_by VARCHAR(255) NULL AFTER gate_confirmation_id,
    ADD COLUMN confirmed_at DATETIME(6) NULL AFTER confirmed_by,
    ADD COLUMN review_evidence_json JSON NOT NULL DEFAULT (JSON_OBJECT()) AFTER review_reason,
    DROP INDEX uq_mcn_rec_demand_platform_mcn,
    ADD UNIQUE KEY uq_mcn_rec_run_platform_mcn (mcn_run_id, platform, mcn_id),
    ADD CONSTRAINT fk_mcn_rec_gate FOREIGN KEY (gate_confirmation_id)
        REFERENCES mcp_gate_confirmations (gate_id);
