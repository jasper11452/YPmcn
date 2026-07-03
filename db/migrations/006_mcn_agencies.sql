CREATE TABLE IF NOT EXISTS mcn_agencies (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    status text NOT NULL DEFAULT 'active',
    rating numeric(5, 4) CHECK (rating BETWEEN 0 AND 1),
    contact_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE creator_supply_offers
    ADD COLUMN IF NOT EXISTS mcn_agency_id uuid REFERENCES mcn_agencies(id);

