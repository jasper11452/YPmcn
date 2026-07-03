ALTER TABLE xhs_creator_accounts
    ADD COLUMN canonical_categories JSON NOT NULL DEFAULT (JSON_ARRAY('other'))
        AFTER grow_category,
    ADD COLUMN category_mapping_version VARCHAR(64) NOT NULL DEFAULT 'unmapped-v1'
        AFTER canonical_categories;

ALTER TABLE dy_creator_accounts
    ADD COLUMN canonical_categories JSON NOT NULL DEFAULT (JSON_ARRAY('other'))
        AFTER industry_tags,
    ADD COLUMN category_mapping_version VARCHAR(64) NOT NULL DEFAULT 'unmapped-v1'
        AFTER canonical_categories;

UPDATE xhs_creator_accounts
SET canonical_categories = JSON_ARRAY('other'), category_mapping_version = 'unmapped-v1'
WHERE canonical_categories IS NULL OR JSON_LENGTH(canonical_categories) = 0;

UPDATE dy_creator_accounts
SET canonical_categories = JSON_ARRAY('other'), category_mapping_version = 'unmapped-v1'
WHERE canonical_categories IS NULL OR JSON_LENGTH(canonical_categories) = 0;
