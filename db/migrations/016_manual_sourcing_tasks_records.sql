CREATE TABLE IF NOT EXISTS manual_sourcing_tasks_records (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    demand_id uuid NOT NULL REFERENCES customer_demands(id) ON DELETE CASCADE,
    assignee_id text,
    status text NOT NULL DEFAULT 'open',
    request_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    result_json jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz
);

