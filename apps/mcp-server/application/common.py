import json
from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

from contract.error_codes import ErrorCode


class ToolFailure(RuntimeError):
    def __init__(
        self,
        code: ErrorCode,
        message: str,
        *,
        detail: dict[str, Any] | None = None,
        retriable: bool = False,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail
        self.retriable = retriable


@dataclass(frozen=True, slots=True)
class ServiceResult:
    data: dict[str, Any]
    workflow_state: dict[str, Any] | None
    allowed_actions: list[str]


def json_value(value: Any, default: Any = None) -> Any:
    if value is None:
        return default
    return json.loads(value) if isinstance(value, str) else value


def json_text(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)


def as_float(value: Any, default: float | None = None) -> float | None:
    if value is None:
        return default
    if isinstance(value, Decimal):
        return float(value)
    return float(value)


def rfc3339(value: datetime | date | None) -> str | None:
    if value is None:
        return None
    if isinstance(value, date) and not isinstance(value, datetime):
        return value.isoformat()
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.isoformat().replace("+00:00", "Z")
