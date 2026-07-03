CREATE TABLE IF NOT EXISTS recommendation_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    demand_id uuid NOT NULL REFERENCES customer_demands(id) ON DELETE CASCADE,
    run_type text NOT NULL CHECK (run_type IN ('mcn', 'creator')),
    strategy text NOT NULL DEFAULT 'default',
    formula_snapshot_json jsonb NOT NULL,
    input_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);
