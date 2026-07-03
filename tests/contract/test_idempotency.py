import pytest
from contract.idempotency import IdempotencyConflict, IdempotencyStore


@pytest.mark.asyncio
async def test_same_key_and_payload_returns_original_result() -> None:
    store = IdempotencyStore()
    calls = 0

    async def operation() -> dict[str, int]:
        nonlocal calls
        calls += 1
        return {"calls": calls}

    first = await store.execute("key-1", {"creator": "a"}, operation)
    second = await store.execute("key-1", {"creator": "a"}, operation)

    assert first == second == {"calls": 1}
    assert calls == 1


@pytest.mark.asyncio
async def test_same_key_with_different_payload_conflicts() -> None:
    store = IdempotencyStore()

    async def operation() -> str:
        return "ok"

    await store.execute("key-1", {"creator": "a"}, operation)

    with pytest.raises(IdempotencyConflict):
        await store.execute("key-1", {"creator": "b"}, operation)

