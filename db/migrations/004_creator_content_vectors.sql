CREATE TABLE IF NOT EXISTS creator_content_vectors (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_account_id uuid NOT NULL REFERENCES creator_accounts(id) ON DELETE CASCADE,
    content_id text NOT NULL,
    embedding vector(1536) NOT NULL,
    model_name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (creator_account_id, content_id, model_name)
);
