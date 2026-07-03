import pytest

from main import mcp
from tools.registry import TOOL_NAMES


@pytest.mark.asyncio
async def test_mcp_server_registers_all_tool_names() -> None:
    registered = await mcp.list_tools()

    assert {tool.name for tool in registered} == set(TOOL_NAMES)
