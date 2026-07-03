from collections.abc import Awaitable, Callable, Mapping
from typing import Any

SendMessage = Callable[[str, dict[str, Any]], Awaitable[str]]


class InquiryNotifier:
    def __init__(self, send_message: SendMessage) -> None:
        self._send_message = send_message

    async def notify(
        self,
        inquiry_id: str,
        recipient: str,
        payload: Mapping[str, Any],
    ) -> str:
        if not inquiry_id or not recipient:
            raise ValueError("inquiry_id and recipient are required")
        message = {
            "event_type": "mcn_inquiry",
            "inquiry_id": inquiry_id,
            "payload": dict(payload),
        }
        return await self._send_message(recipient, message)

