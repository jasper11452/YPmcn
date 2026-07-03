from typing import Any

from contract.response_envelope import ResponseEnvelope

from tools.registry import ToolRegistry, default_registry

TOOL_NAME = "rank_creators"


async def execute(
    payload: dict[str, Any],
    registry: ToolRegistry = default_registry,
) -> ResponseEnvelope:
    return await registry.invoke(TOOL_NAME, payload)

