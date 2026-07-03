ALTER TABLE creator_submissions
    ADD COLUMN submission_batch_id BIGINT UNSIGNED NULL AFTER submission_id,
    ADD COLUMN gate_confirmation_id CHAR(32) NULL AFTER client_feedback_reason,
    ADD COLUMN confirmed_by VARCHAR(255) NULL AFTER gate_confirmation_id,
    ADD COLUMN confirmed_at DATETIME(6) NULL AFTER confirmed_by,
    ADD COLUMN review_evidence_json JSON NOT NULL DEFAULT (JSON_OBJECT()) AFTER confirmed_at,
    ADD KEY idx_creator_sub_batch (submission_batch_id),
    ADD CONSTRAINT fk_creator_sub_batch FOREIGN KEY (submission_batch_id)
        REFERENCES submission_batches (submission_batch_id),
    ADD CONSTRAINT fk_creator_sub_gate FOREIGN KEY (gate_confirmation_id)
        REFERENCES mcp_gate_confirmations (gate_id);
