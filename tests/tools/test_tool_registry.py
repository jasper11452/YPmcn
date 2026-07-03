import pytest
from contract.error_codes import ErrorCode
from tools.registry import TOOL_NAMES, ToolRegistry

EXPECTED_TOOL_NAMES = {
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
}


def test_registry_exposes_exact_tool_names() -> None:
    assert set(TOOL_NAMES) == EXPECTED_TOOL_NAMES


@pytest.mark.asyncio
async def test_unconfigured_handler_fails_safely() -> None:
    result = await ToolRegistry().invoke("search_creators", {"demand_id": "d-1"})

    assert result.success is False
    assert result.error is not None
    assert result.error.code == ErrorCode.NOT_CONFIGURED


@pytest.mark.asyncio
async def test_registered_handler_receives_payload() -> None:
    registry = ToolRegistry()

    async def handler(payload: dict[str, object]) -> dict[str, object]:
        return {"received": payload}

    registry.register("search_creators", handler)
    result = await registry.invoke("search_creators", {"demand_id": "d-1"})

    assert result.success is True
    assert result.data == {"received": {"demand_id": "d-1"}}
