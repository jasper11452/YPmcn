import pytest
from main import mcp
from pydantic import ValidationError
from tools.registry import AGENT_TOOL_NAMES, INTERNAL_TOOL_NAMES
from tools.schemas import (
    AuditManualAdjustmentRequest,
    CreateSubmissionBatchRequest,
    GetCreatorDetailRequest,
    GetRecommendationRunDetailRequest,
    GetWorkflowStateRequest,
    IngestMcnSubmissionsRequest,
    ManualSourceCreatorsRequest,
    RankCreatorsRequest,
    RankMcnsRequest,
    RecordClientFeedbackRequest,
    SearchCreatorsRequest,
    ValidateRequirementRequest,
    WriteRequest,
)

EXPECTED_AGENT_TOOLS = {
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
}


def test_registry_exposes_twelve_agent_tools_and_one_internal_service() -> None:
    assert set(AGENT_TOOL_NAMES) == EXPECTED_AGENT_TOOLS
    assert INTERNAL_TOOL_NAMES == ("create_mcn_inquiries",)
    assert "create_mcn_inquiries" not in AGENT_TOOL_NAMES


@pytest.mark.asyncio
async def test_fastmcp_uses_explicit_top_level_schemas() -> None:
    tools = await mcp.list_tools()

    assert {tool.name for tool in tools} == EXPECTED_AGENT_TOOLS
    for tool in tools:
        properties = tool.inputSchema["properties"]
        assert "payload" not in properties
        assert "trace_id" in properties
    write_tool = next(tool for tool in tools if tool.name == "search_creators")
    assert "idempotency_key" in write_tool.inputSchema["properties"]


@pytest.mark.parametrize(
    "request_type,payload",
    [
        (ValidateRequirementRequest, {"raw_messages": []}),
        (SearchCreatorsRequest, {"demand_id": "1", "demand_version": 1, "limit": 10}),
        (RankMcnsRequest, {"demand_id": "1", "demand_version": 1, "platform": "xhs"}),
        (
            RankCreatorsRequest,
            {
                "demand_id": "1",
                "demand_version": 1,
                "ranking_strategy": "default",
                "limit": 10,
            },
        ),
        (CreateSubmissionBatchRequest, {"run_id": "1"}),
        (IngestMcnSubmissionsRequest, {"inquiry_id": "1", "items": []}),
        (
            ManualSourceCreatorsRequest,
            {"demand_id": "1", "demand_version": 1, "manual_results": []},
        ),
        (RecordClientFeedbackRequest, {"run_id": "1", "feedback_items": []}),
        (AuditManualAdjustmentRequest, {"run_id": "1", "adjustments": [], "operator_id": "u1"}),
    ],
)
def test_write_requests_require_trace_and_idempotency(
    request_type: type[WriteRequest], payload: dict
) -> None:
    with pytest.raises(ValidationError):
        request_type.model_validate(payload)


def test_validate_requirement_requires_existing_id_and_version_together() -> None:
    with pytest.raises(ValidationError):
        ValidateRequirementRequest.model_validate(
            {
                "trace_id": "trace-1",
                "idempotency_key": "idem-1",
                "raw_messages": [{"role": "client", "content": "小红书美妆需求"}],
                "existing_demand_id": "1",
            }
        )


@pytest.mark.parametrize(
    "request_type,payload",
    [
        (GetCreatorDetailRequest, {"platform": "xhs", "platform_account_id": "a"}),
        (GetRecommendationRunDetailRequest, {"run_id": "1"}),
        (GetWorkflowStateRequest, {"demand_id": "1", "demand_version": 1}),
    ],
)
def test_read_requests_require_trace_id(request_type: type, payload: dict) -> None:
    with pytest.raises(ValidationError):
        request_type.model_validate(payload)
