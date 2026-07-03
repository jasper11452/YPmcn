CREATE TABLE IF NOT EXISTS mcn_recommendation_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    demand_id uuid NOT NULL REFERENCES customer_demands(id) ON DELETE CASCADE,
    mcn_agency_id uuid NOT NULL REFERENCES mcn_agencies(id),
    rank integer NOT NULL CHECK (rank > 0),
    score numeric(7, 6) NOT NULL CHECK (score BETWEEN 0 AND 1),
    score_detail_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (demand_id, mcn_agency_id)
);

