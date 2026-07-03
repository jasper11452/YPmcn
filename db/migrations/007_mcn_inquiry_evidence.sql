ALTER TABLE mcn_inquiries
    ADD COLUMN inquiry_batch_id CHAR(32) NOT NULL DEFAULT 'legacy' AFTER inquiry_id,
    ADD COLUMN gate_confirmation_id CHAR(32) NULL AFTER mcn_recommendation_item_id,
    ADD COLUMN confirmed_by VARCHAR(255) NULL AFTER gate_confirmation_id,
    ADD COLUMN confirmed_at DATETIME(6) NULL AFTER confirmed_by,
    ADD COLUMN message_template_key VARCHAR(128) NULL AFTER candidate_ids_sent,
    ADD COLUMN message_template_variables_json JSON NOT NULL DEFAULT (JSON_OBJECT())
        AFTER message_template_key,
    ADD COLUMN review_evidence_json JSON NOT NULL DEFAULT (JSON_OBJECT()) AFTER notes,
    ADD KEY idx_mcn_inq_batch (inquiry_batch_id),
    ADD CONSTRAINT fk_mcn_inq_gate FOREIGN KEY (gate_confirmation_id)
        REFERENCES mcp_gate_confirmations (gate_id);
