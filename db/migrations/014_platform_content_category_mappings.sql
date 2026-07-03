CREATE TABLE IF NOT EXISTS platform_content_category_mappings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    platform text NOT NULL,
    platform_category text NOT NULL,
    canonical_category text NOT NULL,
    metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (platform, platform_category)
);
