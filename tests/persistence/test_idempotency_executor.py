from typing import Any

import pytest
from contract.idempotency import IdempotencyConflict
from persistence.idempotency import (
    DatabaseIdempotencyExecutor,
    LedgerReservation,
    ReservationStatus,
)


class FakeLedger:
    def __init__(self) -> None:
        self.reservation = LedgerReservation(status=ReservationStatus.NEW)
        self.completed: list[dict[str, Any]] = []
        self.failed: list[dict[str, Any]] = []

    async def reserve(self, **_: Any) -> LedgerReservation:
        return self.reservation

    async def complete(self, **values: Any) -> None:
        self.completed.append(values)

    async def fail(self, **values: Any) -> None:
        self.failed.append(values)


@pytest.mark.asyncio
async def test_first_idempotent_execution_persists_complete_response() -> None:
    ledger = FakeLedger()
    executor = DatabaseIdempotencyExecutor(ledger)
    calls = 0

    async def operation() -> dict[str, Any]:
        nonlocal calls
        calls += 1
        return {"success": True, "data": {"id": "1"}}

    result = await executor.execute(
        tool_name="search_creators",
        trace_id="trace-1",
        idempotency_key="idem-1",
        payload={"demand_id": "1"},
        operation=operation,
    )

    assert result["data"]["id"] == "1"
    assert calls == 1
    assert ledger.completed[0]["response"] == result


@pytest.mark.asyncio
async def test_replay_returns_stored_response_without_calling_operation() -> None:
    ledger = FakeLedger()
    ledger.reservation = LedgerReservation(
        status=ReservationStatus.REPLAY,
        response={"success": True, "data": {"id": "existing"}},
    )
    executor = DatabaseIdempotencyExecutor(ledger)

    async def operation() -> dict[str, Any]:
        raise AssertionError("replayed operations must not execute")

    result = await executor.execute(
        tool_name="search_creators",
        trace_id="trace-2",
        idempotency_key="idem-1",
        payload={"demand_id": "1"},
        operation=operation,
    )

    assert result["data"]["id"] == "existing"


@pytest.mark.asyncio
async def test_conflicting_idempotency_payload_is_rejected() -> None:
    ledger = FakeLedger()
    ledger.reservation = LedgerReservation(status=ReservationStatus.CONFLICT)
    executor = DatabaseIdempotencyExecutor(ledger)

    async def operation() -> dict[str, Any]:
        return {}

    with pytest.raises(IdempotencyConflict):
        await executor.execute(
            tool_name="search_creators",
            trace_id="trace-3",
            idempotency_key="idem-1",
            payload={"demand_id": "2"},
            operation=operation,
        )
