CREATE TABLE IF NOT EXISTS creator_accounts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    platform text NOT NULL CHECK (platform IN ('xhs', 'dy', 'ks', 'wxchannels', 'weibo')),
    platform_account_id text NOT NULL,
    display_name text NOT NULL,
    profile_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (platform, platform_account_id)
);

