CREATE TABLE IF NOT EXISTS creator_tier_rules (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    platform text NOT NULL,
    tier_name text NOT NULL,
    min_followers bigint NOT NULL CHECK (min_followers >= 0),
    max_followers bigint CHECK (max_followers >= min_followers),
    rule_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (platform, tier_name)
);
