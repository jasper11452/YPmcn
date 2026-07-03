import json
from collections.abc import Mapping
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from persistence.idempotency import LedgerReservation, ReservationStatus


def _decode_json(value: Any) -> Any:
    if isinstance(value, str):
        return json.loads(value)
    return value


class SqlToolCallLedger:
    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def reserve(
        self,
        *,
        tool_name: str,
        trace_id: str,
        idempotency_key: str,
        request_hash: str,
    ) -> LedgerReservation:
        async with self._engine.begin() as connection:
            result = await connection.execute(
                text(
                    "SELECT request_hash, status, response_envelope_json "
                    "FROM mcp_tool_call_ledger "
                    "WHERE tool_name=:tool_name AND idempotency_key=:idempotency_key FOR UPDATE"
                ),
                {"tool_name": tool_name, "idempotency_key": idempotency_key},
            )
            row = result.mappings().first()
            if row is not None:
                if row["request_hash"] != request_hash:
                    return LedgerReservation(status=ReservationStatus.CONFLICT)
                if row["status"] == "in_progress":
                    return LedgerReservation(status=ReservationStatus.IN_PROGRESS)
                return LedgerReservation(
                    status=ReservationStatus.REPLAY,
                    response=_decode_json(row["response_envelope_json"]),
                )
            await connection.execute(
                text(
                    "INSERT INTO mcp_tool_call_ledger "
                    "(tool_name, trace_id, idempotency_key, request_hash, status) "
                    "VALUES (:tool_name, :trace_id, :idempotency_key, :request_hash, 'in_progress')"
                ),
                {
                    "tool_name": tool_name,
                    "trace_id": trace_id,
                    "idempotency_key": idempotency_key,
                    "request_hash": request_hash,
                },
            )
            return LedgerReservation(status=ReservationStatus.NEW)

    async def complete(
        self,
        *,
        tool_name: str,
        idempotency_key: str,
        response: Mapping[str, Any],
    ) -> None:
        await self._finish(
            tool_name=tool_name,
            idempotency_key=idempotency_key,
            response=response,
            status="completed",
        )

    async def fail(
        self,
        *,
        tool_name: str,
        idempotency_key: str,
        response: Mapping[str, Any],
    ) -> None:
        await self._finish(
            tool_name=tool_name,
            idempotency_key=idempotency_key,
            response=response,
            status="failed",
        )

    async def _finish(
        self,
        *,
        tool_name: str,
        idempotency_key: str,
        response: Mapping[str, Any],
        status: str,
    ) -> None:
        error = response.get("error") or {}
        async with self._engine.begin() as connection:
            await connection.execute(
                text(
                    "UPDATE mcp_tool_call_ledger SET status=:status, "
                    "response_envelope_json=:response, error_code=:error_code, "
                    "workflow_state_after_json=:workflow_state_after, "
                    "completed_at=CURRENT_TIMESTAMP(6) "
                    "WHERE tool_name=:tool_name AND idempotency_key=:idempotency_key"
                ),
                {
                    "status": status,
                    "response": json.dumps(response, ensure_ascii=False, default=str),
                    "error_code": error.get("code"),
                    "workflow_state_after": json.dumps(
                        response.get("workflow_state"),
                        ensure_ascii=False,
                        default=str,
                    )
                    if response.get("workflow_state") is not None
                    else None,
                    "tool_name": tool_name,
                    "idempotency_key": idempotency_key,
                },
            )
