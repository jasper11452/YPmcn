CREATE TABLE IF NOT EXISTS demand_budget_rules (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL UNIQUE,
    min_budget numeric(14, 2) NOT NULL CHECK (min_budget >= 0),
    max_budget numeric(14, 2) CHECK (max_budget >= min_budget),
    rule_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
