from collections.abc import Mapping
from typing import Any

from message_router import MessageRouter


class FeedbackListener:
    def __init__(self, router: MessageRouter) -> None:
        self._router = router

    async def receive(self, event: Mapping[str, Any]) -> Any:
        if not event.get("event_type"):
            raise ValueError("event_type is required")
        return await self._router.route(event)
