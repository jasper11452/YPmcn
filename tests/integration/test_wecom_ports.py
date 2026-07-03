import pytest
from feedback_listener import FeedbackListener
from inquiry_notifier import InquiryNotifier
from message_router import MessageRouter


@pytest.mark.asyncio
async def test_router_dispatches_by_event_type() -> None:
    router = MessageRouter()

    async def handler(event: dict[str, object]) -> str:
        return str(event["feedback"])

    router.register("client_feedback", handler)

    assert await router.route({"event_type": "client_feedback", "feedback": "approved"}) == (
        "approved"
    )


@pytest.mark.asyncio
async def test_notifier_uses_injected_sender() -> None:
    sent: list[tuple[str, dict[str, object]]] = []

    async def sender(recipient: str, message: dict[str, object]) -> str:
        sent.append((recipient, message))
        return "message-1"

    notifier = InquiryNotifier(sender)
    message_id = await notifier.notify("inquiry-1", "mcn-1", {"deadline": "2026-07-10"})

    assert message_id == "message-1"
    assert sent[0][1]["inquiry_id"] == "inquiry-1"


@pytest.mark.asyncio
async def test_feedback_listener_rejects_missing_event_type() -> None:
    listener = FeedbackListener(MessageRouter())

    with pytest.raises(ValueError):
        await listener.receive({"feedback": "approved"})
