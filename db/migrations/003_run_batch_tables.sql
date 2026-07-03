CREATE TABLE IF NOT EXISTS submission_batches (
    submission_batch_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    run_id BIGINT UNSIGNED NOT NULL,
    demand_id BIGINT UNSIGNED NOT NULL,
    demand_version INT UNSIGNED NOT NULL,
    batch_no INT UNSIGNED NOT NULL,
    target_submission_count INT UNSIGNED NOT NULL,
    actual_submission_count INT UNSIGNED NOT NULL DEFAULT 0,
    snapshot_json JSON NOT NULL DEFAULT (JSON_OBJECT()),
    gate_confirmation_id CHAR(32) NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'created',
    created_by VARCHAR(255) NOT NULL DEFAULT 'agent',
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    UNIQUE KEY uq_submission_batch_run_no (run_id, batch_no),
    KEY idx_submission_batch_demand (demand_id, demand_version),
    CONSTRAINT fk_submission_batch_run FOREIGN KEY (run_id, demand_id, demand_version)
        REFERENCES recommendation_runs (run_id, demand_id, demand_version),
    CONSTRAINT fk_submission_batch_gate FOREIGN KEY (gate_confirmation_id)
        REFERENCES mcp_gate_confirmations (gate_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS recommendation_run_candidates (
    run_id BIGINT UNSIGNED NOT NULL,
    candidate_id BIGINT UNSIGNED NOT NULL,
    demand_id BIGINT UNSIGNED NOT NULL,
    demand_version INT UNSIGNED NOT NULL,
    platform VARCHAR(16) NOT NULL,
    platform_account_id VARCHAR(128) NOT NULL,
    offer_id BIGINT UNSIGNED NULL,
    eligible TINYINT(1) NOT NULL DEFAULT 1,
    exclusion_reason VARCHAR(128) NULL,
    score_detail_json JSON NOT NULL DEFAULT (JSON_OBJECT()),
    rank_order INT UNSIGNED NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (run_id, candidate_id),
    KEY idx_run_candidates_account (platform, platform_account_id),
    CONSTRAINT fk_run_candidates_run FOREIGN KEY (run_id, demand_id, demand_version)
        REFERENCES recommendation_runs (run_id, demand_id, demand_version),
    CONSTRAINT fk_run_candidates_candidate FOREIGN KEY
        (candidate_id, demand_id, demand_version, platform, platform_account_id)
        REFERENCES creator_candidate_pool
        (candidate_id, demand_id, demand_version, platform, platform_account_id),
    CONSTRAINT fk_run_candidates_offer FOREIGN KEY (offer_id)
        REFERENCES creator_supply_offers (offer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
