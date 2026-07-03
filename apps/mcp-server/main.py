from collections.abc import Callable
from typing import Any

from mcp.server.fastmcp import FastMCP
from tools.registry import TOOL_NAMES, ToolRegistry, default_registry


def _build_tool(tool_name: str, registry: ToolRegistry) -> Callable[..., Any]:
    async def invoke(payload: dict[str, Any]) -> dict[str, Any]:
        result = await registry.invoke(tool_name, payload)
        return result.model_dump(mode="json")

    invoke.__name__ = tool_name
    invoke.__doc__ = f"Execute the {tool_name} MCN workflow operation."
    return invoke


def create_server(registry: ToolRegistry = default_registry) -> FastMCP:
    server = FastMCP("MCN Agent Platform", json_response=True)
    for tool_name in TOOL_NAMES:
        server.add_tool(
            _build_tool(tool_name, registry),
            name=tool_name,
            description=f"Execute the {tool_name} MCN workflow operation.",
            structured_output=True,
        )
    return server


mcp = create_server()


if __name__ == "__main__":
    mcp.run(transport="streamable-http")
