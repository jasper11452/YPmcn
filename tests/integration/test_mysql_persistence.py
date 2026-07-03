import os
from uuid import uuid4

import pytest
from config import DatabaseSettings
from persistence.connection import create_database_engine
from sqlalchemy import text


@pytest.mark.asyncio
@pytest.mark.skipif(not os.environ.get("YP_TEST_MYSQL_PORT"), reason="Docker MySQL not requested")
async def test_mysql_8036_migrations_and_rollback() -> None:
    settings = DatabaseSettings.from_mapping(
        {
            "YP_DATA_HOST": "127.0.0.1",
            "YP_DATA_PORT": os.environ["YP_TEST_MYSQL_PORT"],
            "YP_DATA_USER": "root",
            "YP_DATA_PASSWORD": "root",
            "YP_DATA_DATABASE": "ypmcn",
            "YP_DATA_ENV": "test",
            "YP_DATA_SSL_MODE": "disabled",
        }
    )
    engine = create_database_engine(settings)
    marker = f"pytest-rollback-{uuid4().hex}"
    try:
        async with engine.connect() as connection:
            assert await connection.scalar(text("SELECT COUNT(*) FROM mcp_schema_migrations")) == 10
            await connection.rollback()
            transaction = await connection.begin()
            await connection.execute(
                text(
                    "INSERT INTO mcp_outbox "
                    "(aggregate_type,aggregate_id,event_type,payload_json) "
                    "VALUES ('test',:marker,'test.rollback',JSON_OBJECT())"
                ),
                {"marker": marker},
            )
            await transaction.rollback()
        async with engine.connect() as connection:
            remaining = await connection.scalar(
                text("SELECT COUNT(*) FROM mcp_outbox WHERE aggregate_id=:marker"),
                {"marker": marker},
            )
            assert remaining == 0
    finally:
        await engine.dispose()
