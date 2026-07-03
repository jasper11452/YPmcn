from typing import Any, Self
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, model_validator

from contract.error_codes import ErrorCode


class ErrorDetail(BaseModel):
    model_config = ConfigDict(frozen=True)

    code: ErrorCode
    message: str
    details: dict[str, Any] | None = None


class ResponseEnvelope(BaseModel):
    model_config = ConfigDict(frozen=True)

    success: bool
    data: Any | None = None
    error: ErrorDetail | None = None
    trace_id: str

    @model_validator(mode="after")
    def validate_shape(self) -> Self:
        if self.success and self.error is not None:
            raise ValueError("successful responses cannot contain an error")
        if not self.success and (self.data is not None or self.error is None):
            raise ValueError("failed responses require an error and cannot contain data")
        return self

    @classmethod
    def ok(cls, data: Any = None, *, trace_id: str | None = None) -> Self:
        return cls(success=True, data=data, trace_id=trace_id or uuid4().hex)

    @classmethod
    def fail(
        cls,
        code: ErrorCode,
        message: str,
        *,
        details: dict[str, Any] | None = None,
        trace_id: str | None = None,
    ) -> Self:
        return cls(
            success=False,
            error=ErrorDetail(code=code, message=message, details=details),
            trace_id=trace_id or uuid4().hex,
        )
