CREATE TABLE IF NOT EXISTS mcn_inquiries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    demand_id uuid NOT NULL REFERENCES customer_demands(id) ON DELETE CASCADE,
    mcn_agency_id uuid NOT NULL REFERENCES mcn_agencies(id),
    status text NOT NULL DEFAULT 'pending',
    request_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    response_json jsonb,
    sent_at timestamptz,
    responded_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
