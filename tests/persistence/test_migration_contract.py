from pathlib import Path

import pytest
from config import DatabaseSettings
from persistence.connection import build_database_url, creator_account_table
from persistence.migrations import discover_migrations, split_sql_statements

MIGRATIONS = Path(__file__).parents[2] / "db" / "migrations"


def test_migrations_are_contiguous_mysql_incrementals() -> None:
    migrations = discover_migrations(MIGRATIONS)

    assert [migration.version for migration in migrations] == list(range(1, len(migrations) + 1))
    combined = "\n".join(migration.sql.lower() for migration in migrations)
    postgres_tokens = (
        "jsonb",
        "timestamptz",
        "gen_random_uuid",
        "create extension",
        "vector(",
    )
    for postgres_token in postgres_tokens:
        assert postgres_token not in combined
    assert "mcp_schema_migrations" in combined
    assert "mcp_tool_call_ledger" in combined


def test_migration_checksum_is_stable_and_statement_splitter_ignores_comments() -> None:
    first = discover_migrations(MIGRATIONS)[0]
    again = discover_migrations(MIGRATIONS)[0]

    assert first.checksum == again.checksum
    assert len(first.checksum) == 64
    assert split_sql_statements("-- comment\nSELECT 1;\n\nSELECT 'a;b';") == [
        "SELECT 1",
        "SELECT 'a;b'",
    ]


def test_database_url_uses_asyncmy_without_exposing_password() -> None:
    settings = DatabaseSettings.from_mapping(
        {
            "YP_DATA_PASSWORD": "very-secret",
            "YP_DATA_ENV": "test",
            "YP_DATA_SSL_MODE": "disabled",
        }
    )

    url = build_database_url(settings)

    assert url.drivername == "mysql+asyncmy"
    assert url.password == "very-secret"
    assert "very-secret" not in url.render_as_string(hide_password=True)


def test_creator_table_names_are_strictly_whitelisted() -> None:
    assert creator_account_table("xhs") == "xhs_creator_accounts"
    assert creator_account_table("dy") == "dy_creator_accounts"
    with pytest.raises(ValueError):
        creator_account_table("xhs_creator_accounts; DROP TABLE customer_demands")
