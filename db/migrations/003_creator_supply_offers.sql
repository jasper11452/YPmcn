CREATE TABLE IF NOT EXISTS creator_supply_offers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_account_id uuid NOT NULL REFERENCES creator_accounts(id),
    source text NOT NULL CHECK (source IN ('ratecard', 'mcn_returned', 'manual_sourced')),
    quoted_price numeric(14, 2) NOT NULL CHECK (quoted_price >= 0),
    rebate_rate numeric(7, 6) CHECK (rebate_rate BETWEEN 0 AND 1),
    valid_from date,
    valid_until date,
    metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

