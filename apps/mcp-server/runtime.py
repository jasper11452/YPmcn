import asyncio
import os
from collections.abc import Mapping
from typing import Any

from application.service import McpToolService
from config import DatabaseSettings
from contract.error_codes import ErrorCode
from contract.response_envelope import ResponseEnvelope
from persistence.connection import create_database_engine
from tools.registry import AGENT_TOOL_NAMES, ToolRegistry


class LazyRuntime:
    def __init__(self) -> None:
        self._service: McpToolService | None = None
        self._lock = asyncio.Lock()

    async def service(self) -> McpToolService:
        if self._service is not None:
            return self._service
        async with self._lock:
            if self._service is None:
                settings = DatabaseSettings.from_mapping(os.environ)
                self._service = McpToolService(create_database_engine(settings))
        return self._service

    async def invoke(self, tool_name: str, payload: Mapping[str, Any]) -> ResponseEnvelope:
        try:
            service = await self.service()
        except ValueError as exc:
            return ResponseEnvelope.fail(
                ErrorCode.NOT_CONFIGURED,
                str(exc),
                trace_id=str(payload.get("trace_id") or "runtime-not-configured"),
                idempotency_key=payload.get("idempotency_key"),
            )
        if tool_name == "create_mcn_inquiries":
            return await service.create_mcn_inquiries(payload)
        return await service.invoke(tool_name, payload)


def configure_registry(registry: ToolRegistry, runtime: LazyRuntime | None = None) -> LazyRuntime:
    selected_runtime = runtime or LazyRuntime()
    for tool_name in (*AGENT_TOOL_NAMES, "create_mcn_inquiries"):

        async def handler(payload: dict[str, Any], name: str = tool_name) -> ResponseEnvelope:
            return await selected_runtime.invoke(name, payload)

        registry.register(tool_name, handler)
    return selected_runtime
