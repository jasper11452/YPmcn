import asyncio
import copy
import hashlib
import json
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any, TypeVar

T = TypeVar("T")


class IdempotencyConflict(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class _Entry:
    fingerprint: str
    result: Any


class IdempotencyStore:
    def __init__(self) -> None:
        self._entries: dict[str, _Entry] = {}
        self._lock = asyncio.Lock()

    async def execute(
        self,
        key: str,
        payload: Mapping[str, Any],
        operation: Callable[[], Awaitable[T]],
    ) -> T:
        fingerprint = self._fingerprint(payload)
        async with self._lock:
            existing = self._entries.get(key)
            if existing is not None:
                if existing.fingerprint != fingerprint:
                    raise IdempotencyConflict(f"idempotency key {key!r} has a different payload")
                return copy.deepcopy(existing.result)

            result = await operation()
            self._entries[key] = _Entry(fingerprint=fingerprint, result=copy.deepcopy(result))
            return result

    @staticmethod
    def _fingerprint(payload: Mapping[str, Any]) -> str:
        canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
        return hashlib.sha256(canonical.encode()).hexdigest()
