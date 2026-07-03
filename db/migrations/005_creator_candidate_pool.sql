CREATE TABLE IF NOT EXISTS creator_candidate_pool (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    demand_id uuid NOT NULL REFERENCES customer_demands(id) ON DELETE CASCADE,
    creator_account_id uuid NOT NULL REFERENCES creator_accounts(id),
    candidate_source text NOT NULL,
    hard_filter_passed boolean NOT NULL DEFAULT false,
    score_detail_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (demand_id, creator_account_id)
);

