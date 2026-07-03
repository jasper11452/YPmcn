CREATE TABLE IF NOT EXISTS submission_batches (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    demand_id uuid NOT NULL REFERENCES customer_demands(id) ON DELETE CASCADE,
    recommendation_run_id uuid REFERENCES recommendation_runs(id),
    status text NOT NULL DEFAULT 'draft',
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    closed_at timestamptz
);
