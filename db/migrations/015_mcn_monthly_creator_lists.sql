CREATE TABLE IF NOT EXISTS mcn_monthly_creator_lists (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    mcn_agency_id uuid NOT NULL REFERENCES mcn_agencies(id) ON DELETE CASCADE,
    creator_account_id uuid NOT NULL REFERENCES creator_accounts(id),
    platform text NOT NULL CHECK (platform IN ('xhs', 'dy', 'ks', 'wxchannels', 'weibo')),
    list_month date NOT NULL,
    offer_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (mcn_agency_id, creator_account_id, list_month)
);
