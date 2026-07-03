from collections.abc import Awaitable, Callable, Mapping
from typing import Any

MessageHandler = Callable[[dict[str, Any]], Awaitable[Any]]


class MessageRouter:
    def __init__(self) -> None:
        self._handlers: dict[str, MessageHandler] = {}

    def register(self, event_type: str, handler: MessageHandler) -> None:
        if not event_type.strip():
            raise ValueError("event_type is required")
        self._handlers[event_type] = handler

    async def route(self, event: Mapping[str, Any]) -> Any:
        event_type = event.get("event_type")
        if not isinstance(event_type, str) or not event_type:
            raise ValueError("event_type is required")
        try:
            handler = self._handlers[event_type]
        except KeyError as exc:
            raise LookupError(f"no handler registered for {event_type}") from exc
        return await handler(dict(event))

