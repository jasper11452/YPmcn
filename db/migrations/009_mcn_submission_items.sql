CREATE TABLE IF NOT EXISTS mcn_submission_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    inquiry_id uuid NOT NULL REFERENCES mcn_inquiries(id) ON DELETE CASCADE,
    creator_account_id uuid NOT NULL REFERENCES creator_accounts(id),
    quoted_price numeric(14, 2) CHECK (quoted_price >= 0),
    rebate_rate numeric(7, 6) CHECK (rebate_rate BETWEEN 0 AND 1),
    payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (inquiry_id, creator_account_id)
);
