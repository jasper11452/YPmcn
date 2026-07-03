import logging
import os
from typing import Literal

from config import DatabaseSettings
from sqlalchemy import URL
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

logger = logging.getLogger(__name__)

Platform = Literal["xhs", "dy"]
_CREATOR_TABLES: dict[Platform, str] = {
    "xhs": "xhs_creator_accounts",
    "dy": "dy_creator_accounts",
}


def creator_account_table(platform: str) -> str:
    try:
        return _CREATOR_TABLES[platform]  # type: ignore[index]
    except KeyError as exc:
        raise ValueError(f"unsupported creator platform: {platform}") from exc


def build_database_url(settings: DatabaseSettings) -> URL:
    return URL.create(
        drivername="mysql+asyncmy",
        username=settings.user,
        password=settings.password.get_secret_value(),
        host=settings.host,
        port=settings.port,
        database=settings.database,
        query={"charset": "utf8mb4"},
    )


def create_database_engine(settings: DatabaseSettings) -> AsyncEngine:
    connect_args: dict[str, object] = {}
    if settings.ssl_mode == "disabled":
        logger.warning("MySQL TLS is disabled for the explicitly configured test environment")
    else:
        ssl: dict[str, object] = {"check_hostname": settings.ssl_mode == "verify_identity"}
        ca_path = os.environ.get("YP_DATA_SSL_CA")
        if settings.ssl_mode in {"verify_ca", "verify_identity"}:
            if not ca_path:
                raise ValueError("YP_DATA_SSL_CA is required for certificate verification")
            ssl["ca"] = ca_path
        connect_args["ssl"] = ssl

    return create_async_engine(
        build_database_url(settings),
        pool_pre_ping=True,
        pool_recycle=1800,
        connect_args=connect_args,
    )
