from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from contract.error_codes import ErrorCode
from contract.response_envelope import ResponseEnvelope

TOOL_NAMES = (
    "validate_requirement",
    "search_creators",
    "rank_mcns",
    "rank_creators",
    "create_submission_batch",
    "ingest_mcn_submissions",
    "manual_source_creators",
    "record_client_feedback",
    "audit_manual_adjustment",
    "get_workflow_state",
    "get_creator_detail",
    "get_recommendation_run_detail",
    "create_mcn_inquiries",
)

ToolHandler = Callable[[dict[str, Any]], Awaitable[Any]]


class ToolRegistry:
    def __init__(self) -> None:
        self._handlers: dict[str, ToolHandler] = {}

    def register(self, tool_name: str, handler: ToolHandler) -> None:
        if tool_name not in TOOL_NAMES:
            raise ValueError(f"unknown MCP tool: {tool_name}")
        self._handlers[tool_name] = handler

    async def invoke(
        self,
        tool_name: str,
        payload: Mapping[str, Any],
        *,
        trace_id: str | None = None,
    ) -> ResponseEnvelope:
        if tool_name not in TOOL_NAMES:
            return ResponseEnvelope.fail(
                ErrorCode.VALIDATION_ERROR,
                f"unknown MCP tool: {tool_name}",
                trace_id=trace_id,
            )

        handler = self._handlers.get(tool_name)
        if handler is None:
            return ResponseEnvelope.fail(
                ErrorCode.NOT_CONFIGURED,
                f"no application handler configured for {tool_name}",
                trace_id=trace_id,
            )

        try:
            data = await handler(dict(payload))
        except Exception:
            return ResponseEnvelope.fail(
                ErrorCode.INTERNAL_ERROR,
                "tool execution failed",
                trace_id=trace_id,
            )
        return ResponseEnvelope.ok(data, trace_id=trace_id)


default_registry = ToolRegistry()
