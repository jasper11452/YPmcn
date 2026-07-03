import hashlib
import json
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Protocol, TypeVar

from contract.idempotency import IdempotencyConflict

T = TypeVar("T", bound=Mapping[str, Any])


class ReservationStatus(StrEnum):
    NEW = "new"
    REPLAY = "replay"
    CONFLICT = "conflict"
    IN_PROGRESS = "in_progress"


@dataclass(frozen=True, slots=True)
class LedgerReservation:
    status: ReservationStatus
    response: dict[str, Any] | None = None


class LedgerPort(Protocol):
    async def reserve(
        self,
        *,
        tool_name: str,
        trace_id: str,
        idempotency_key: str,
        request_hash: str,
    ) -> LedgerReservation: ...

    async def complete(
        self,
        *,
        tool_name: str,
        idempotency_key: str,
        response: Mapping[str, Any],
    ) -> None: ...

    async def fail(
        self,
        *,
        tool_name: str,
        idempotency_key: str,
        response: Mapping[str, Any],
    ) -> None: ...


class IdempotencyInProgress(RuntimeError):
    pass


class DatabaseIdempotencyExecutor:
    def __init__(self, ledger: LedgerPort) -> None:
        self._ledger = ledger

    async def execute(
        self,
        *,
        tool_name: str,
        trace_id: str,
        idempotency_key: str,
        payload: Mapping[str, Any],
        operation: Callable[[], Awaitable[T]],
    ) -> T:
        request_hash = self.fingerprint(payload)
        reservation = await self._ledger.reserve(
            tool_name=tool_name,
            trace_id=trace_id,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
        )
        if reservation.status == ReservationStatus.CONFLICT:
            message = f"idempotency key {idempotency_key!r} has a different payload"
            raise IdempotencyConflict(message)
        if reservation.status == ReservationStatus.IN_PROGRESS:
            raise IdempotencyInProgress(f"idempotency key {idempotency_key!r} is already running")
        if reservation.status == ReservationStatus.REPLAY:
            if reservation.response is None:
                raise RuntimeError("replay reservation is missing its stored response")
            return reservation.response  # type: ignore[return-value]

        try:
            response = await operation()
        except Exception:
            raise
        if response.get("success") is False:
            await self._ledger.fail(
                tool_name=tool_name,
                idempotency_key=idempotency_key,
                response=response,
            )
        else:
            await self._ledger.complete(
                tool_name=tool_name,
                idempotency_key=idempotency_key,
                response=response,
            )
        return response

    @staticmethod
    def fingerprint(payload: Mapping[str, Any]) -> str:
        semantic_payload = {
            key: value
            for key, value in payload.items()
            if key not in {"trace_id", "idempotency_key"}
        }
        canonical = json.dumps(
            semantic_payload,
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        )
        return hashlib.sha256(canonical.encode()).hexdigest()
