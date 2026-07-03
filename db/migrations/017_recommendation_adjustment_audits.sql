CREATE TABLE IF NOT EXISTS recommendation_adjustment_audits (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    demand_id uuid NOT NULL REFERENCES customer_demands(id) ON DELETE CASCADE,
    recommendation_run_id uuid REFERENCES recommendation_runs(id),
    actor_id text NOT NULL,
    reason text NOT NULL,
    before_json jsonb NOT NULL,
    after_json jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

