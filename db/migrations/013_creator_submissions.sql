CREATE TABLE IF NOT EXISTS creator_submissions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    submission_batch_id uuid NOT NULL REFERENCES submission_batches(id) ON DELETE CASCADE,
    creator_account_id uuid NOT NULL REFERENCES creator_accounts(id),
    status text NOT NULL DEFAULT 'submitted',
    submission_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    client_feedback_json jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (submission_batch_id, creator_account_id)
);
