ALTER TABLE creator_candidate_pool
    ADD COLUMN is_locked TINYINT(1) NOT NULL DEFAULT 0 AFTER risk_notes,
    ADD COLUMN locked_by_run_id BIGINT UNSIGNED NULL AFTER is_locked,
    ADD COLUMN locked_at DATETIME(6) NULL AFTER locked_by_run_id,
    ADD KEY idx_candidate_lock (is_locked, locked_by_run_id),
    ADD CONSTRAINT fk_candidate_locked_run FOREIGN KEY (locked_by_run_id)
        REFERENCES recommendation_runs (run_id);
