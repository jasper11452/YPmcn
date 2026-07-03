from pathlib import Path

MIGRATIONS = Path(__file__).parents[2] / "db" / "migrations"

EXPECTED_NAMES = [
    "001_customer_demands.sql",
    "002_creator_accounts.sql",
    "003_creator_supply_offers.sql",
    "004_creator_content_vectors.sql",
    "005_creator_candidate_pool.sql",
    "006_mcn_agencies.sql",
    "007_mcn_recommendation_items.sql",
    "008_mcn_inquiries.sql",
    "009_mcn_submission_items.sql",
    "010_recommendation_runs.sql",
    "011_creator_recommendation_items.sql",
    "012_submission_batches.sql",
    "013_creator_submissions.sql",
    "014_platform_content_category_mappings.sql",
    "015_mcn_monthly_creator_lists.sql",
    "016_manual_sourcing_tasks_records.sql",
    "017_recommendation_adjustment_audits.sql",
    "018_demand_budget_rules.sql",
    "019_creator_tier_rules.sql",
    "020_mcp_tool_call_ledger.sql",
]


def test_migrations_are_contiguous_and_named_as_designed() -> None:
    files = sorted(MIGRATIONS.glob("*.sql"))

    assert [path.name for path in files] == EXPECTED_NAMES
    assert [int(path.name[:3]) for path in files] == list(range(1, 21))


def test_every_migration_is_idempotent_at_table_boundary() -> None:
    files = sorted(MIGRATIONS.glob("*.sql"))

    missing_guard = [
        path.name
        for path in files
        if "CREATE TABLE IF NOT EXISTS" not in path.read_text(encoding="utf-8")
    ]

    assert not missing_guard


def test_vector_migration_uses_pgvector() -> None:
    bootstrap = (MIGRATIONS / EXPECTED_NAMES[0]).read_text(encoding="utf-8")
    vectors = (MIGRATIONS / EXPECTED_NAMES[3]).read_text(encoding="utf-8")

    assert "CREATE EXTENSION IF NOT EXISTS vector" in bootstrap
    assert "vector(1536)" in vectors

