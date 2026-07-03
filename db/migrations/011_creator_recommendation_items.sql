CREATE TABLE IF NOT EXISTS creator_recommendation_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    recommendation_run_id uuid NOT NULL REFERENCES recommendation_runs(id) ON DELETE CASCADE,
    creator_account_id uuid NOT NULL REFERENCES creator_accounts(id),
    rank integer NOT NULL CHECK (rank > 0),
    score numeric(7, 6) NOT NULL CHECK (score BETWEEN 0 AND 1),
    score_detail_json jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (recommendation_run_id, creator_account_id)
);

