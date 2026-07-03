ALTER TABLE creator_recommendation_items
    ADD COLUMN gate_confirmation_id CHAR(32) NULL AFTER review_reason,
    ADD COLUMN review_evidence_json JSON NOT NULL DEFAULT (JSON_OBJECT())
        AFTER gate_confirmation_id,
    ADD CONSTRAINT fk_creator_rec_gate FOREIGN KEY (gate_confirmation_id)
        REFERENCES mcp_gate_confirmations (gate_id);
