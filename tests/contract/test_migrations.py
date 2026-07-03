from pathlib import Path

from persistence.migrations import discover_migrations

MIGRATIONS = Path(__file__).parents[2] / "db" / "migrations"

EXPECTED_NAMES = [
    "001_mcp_schema_migrations.sql",
    "002_mcp_runtime_tables.sql",
    "003_run_batch_tables.sql",
    "004_customer_demands_draft_nullable.sql",
    "005_candidate_pool_locks.sql",
    "006_mcn_recommendation_evidence.sql",
    "007_mcn_inquiry_evidence.sql",
    "008_recommendation_item_evidence.sql",
    "009_submission_evidence.sql",
    "010_creator_category_mapping.sql",
]


def test_migrations_are_contiguous_and_named_as_designed() -> None:
    files = sorted(MIGRATIONS.glob("*.sql"))

    assert [path.name for path in files] == EXPECTED_NAMES
    assert [migration.version for migration in discover_migrations(MIGRATIONS)] == list(
        range(1, 11)
    )


def test_migrations_use_ledger_and_mysql_dialect() -> None:
    combined = "\n".join(
        path.read_text(encoding="utf-8").lower() for path in sorted(MIGRATIONS.glob("*.sql"))
    )

    assert "mcp_schema_migrations" in combined
    assert "engine=innodb" in combined
    for postgres_token in ("jsonb", "timestamptz", "gen_random_uuid", "create extension"):
        assert postgres_token not in combined
