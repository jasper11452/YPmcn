from collections.abc import Mapping
from os import environ
from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, SecretStr


class DatabaseSettings(BaseModel):
    model_config = ConfigDict(frozen=True)

    host: str = "d-oa-test.eshypdata.com"
    port: int = Field(default=3306, ge=1, le=65535)
    user: str = "ypmcn"
    password: SecretStr
    database: str = "ypmcn"
    environment: str = "production"
    ssl_mode: Literal["required", "verify_ca", "verify_identity", "disabled"] = "required"

    @classmethod
    def from_mapping(cls, values: Mapping[str, str] | None = None) -> Self:
        source = environ if values is None else values
        settings = cls(
            host=source.get("YP_DATA_HOST", "d-oa-test.eshypdata.com"),
            port=int(source.get("YP_DATA_PORT", "3306")),
            user=source.get("YP_DATA_USER", "ypmcn"),
            password=SecretStr(source.get("YP_DATA_PASSWORD", "")),
            database=source.get("YP_DATA_DATABASE", "ypmcn"),
            environment=source.get("YP_DATA_ENV", "production"),
            ssl_mode=source.get("YP_DATA_SSL_MODE", "required"),
        )
        if not settings.password.get_secret_value():
            raise ValueError("YP_DATA_PASSWORD is required")
        if settings.ssl_mode == "disabled" and settings.environment != "test":
            raise ValueError("TLS may only be disabled when YP_DATA_ENV=test")
        return settings
