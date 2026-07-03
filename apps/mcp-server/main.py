import os
from typing import Any

from mcp.server.fastmcp import FastMCP
from runtime import configure_registry
from tools.registry import ToolRegistry, default_registry
from tools.schemas import (
    AuditManualAdjustmentRequest,
    AuthorizedRelaxation,
    CreateSubmissionBatchRequest,
    FeedbackItem,
    GateConfirmation,
    GetCreatorDetailRequest,
    GetRecommendationRunDetailRequest,
    GetWorkflowStateRequest,
    IngestMcnSubmissionsRequest,
    ManualAdjustment,
    ManualResult,
    ManualSourceCreatorsRequest,
    McnSubmissionItem,
    ParsedRequirement,
    ProjectContext,
    RankCreatorsRequest,
    RankingWeights,
    RankMcnsRequest,
    RawMessage,
    RecordClientFeedbackRequest,
    RequirementChanges,
    SearchContext,
    SearchCreatorsRequest,
    ValidateRequirementRequest,
)


async def _dispatch(registry: ToolRegistry, tool_name: str, request: Any) -> dict[str, Any]:
    payload = request.model_dump(mode="json", exclude_none=True)
    result = await registry.invoke(tool_name, payload, trace_id=request.trace_id)
    return result.model_dump(mode="json")


def create_server(registry: ToolRegistry = default_registry) -> FastMCP:
    server = FastMCP("MCN Agent Platform", json_response=True)

    @server.tool(name="validate_requirement", structured_output=True)
    async def validate_requirement(
        raw_messages: list[RawMessage],
        parsed_requirement: ParsedRequirement,
        trace_id: str,
        idempotency_key: str,
        project_context: ProjectContext | None = None,
        existing_demand_id: str | None = None,
        existing_demand_version: int | None = None,
    ) -> dict[str, Any]:
        """Validate and persist a host-parsed requirement.

        Extract parsed_requirement from raw_messages, copy exact source snippets into
        field_evidence for every non-empty field, and leave missing fields unset.
        """
        request = ValidateRequirementRequest(
            raw_messages=raw_messages,
            parsed_requirement=parsed_requirement,
            trace_id=trace_id,
            idempotency_key=idempotency_key,
            project_context=project_context,
            existing_demand_id=existing_demand_id,
            existing_demand_version=existing_demand_version,
        )
        payload = request.model_dump(mode="json", exclude_none=True)
        result = await registry.invoke("validate_requirement", payload, trace_id=trace_id)
        return result.model_dump(mode="json")

    @server.tool(name="search_creators", structured_output=True)
    async def search_creators(
        demand_id: str,
        demand_version: int,
        limit: int,
        trace_id: str,
        idempotency_key: str,
        authorized_relaxations: list[AuthorizedRelaxation] | None = None,
        write_candidate_pool: bool = True,
    ) -> dict[str, Any]:
        """Apply hard filters and write the deduplicated creator candidate pool."""
        request = SearchCreatorsRequest(
            demand_id=demand_id,
            demand_version=demand_version,
            limit=limit,
            trace_id=trace_id,
            idempotency_key=idempotency_key,
            authorized_relaxations=authorized_relaxations or [],
            write_candidate_pool=write_candidate_pool,
        )
        return await _dispatch(registry, "search_creators", request)

    @server.tool(name="rank_mcns", structured_output=True)
    async def rank_mcns(
        demand_id: str,
        demand_version: int,
        platform: str,
        trace_id: str,
        idempotency_key: str,
        minimum_mcn_count: int = 5,
        target_multiplier: float = 20,
        buffer_rate: float = 0.1,
        medium_risk_confirmation: GateConfirmation | None = None,
        limit: int = 20,
        write_mcn_recommendation_items: bool = True,
    ) -> dict[str, Any]:
        """Rank platform-specific MCNs and produce supply-race inquiry advice."""
        request = RankMcnsRequest(
            demand_id=demand_id,
            demand_version=demand_version,
            platform=platform,
            trace_id=trace_id,
            idempotency_key=idempotency_key,
            minimum_mcn_count=minimum_mcn_count,
            target_multiplier=target_multiplier,
            buffer_rate=buffer_rate,
            medium_risk_confirmation=medium_risk_confirmation,
            limit=limit,
            write_mcn_recommendation_items=write_mcn_recommendation_items,
        )
        return await _dispatch(registry, "rank_mcns", request)

    @server.tool(name="rank_creators", structured_output=True)
    async def rank_creators(
        demand_id: str,
        demand_version: int,
        ranking_strategy: str,
        limit: int,
        trace_id: str,
        idempotency_key: str,
        run_type: str = "initial",
        candidate_ids: list[str] | None = None,
        ranking_weights: RankingWeights | None = None,
        feedback_preferences: dict[str, Any] | None = None,
        exclude_submitted: bool = True,
        allow_manual_sourced_in_initial_run: bool = False,
        source_priority: list[str] | None = None,
        write_recommendation_items: bool = True,
    ) -> dict[str, Any]:
        """Score, deduplicate, rank, and snapshot eligible creator candidates."""
        values: dict[str, Any] = {
            "demand_id": demand_id,
            "demand_version": demand_version,
            "ranking_strategy": ranking_strategy,
            "limit": limit,
            "trace_id": trace_id,
            "idempotency_key": idempotency_key,
            "run_type": run_type,
            "candidate_ids": candidate_ids,
            "ranking_weights": ranking_weights,
            "feedback_preferences": feedback_preferences,
            "exclude_submitted": exclude_submitted,
            "allow_manual_sourced_in_initial_run": allow_manual_sourced_in_initial_run,
            "write_recommendation_items": write_recommendation_items,
        }
        if source_priority is not None:
            values["source_priority"] = source_priority
        request = RankCreatorsRequest.model_validate(values)
        return await _dispatch(registry, "rank_creators", request)

    @server.tool(name="create_submission_batch", structured_output=True)
    async def create_submission_batch(
        run_id: str,
        trace_id: str,
        idempotency_key: str,
        target_submission_count: int | None = None,
        recommendation_item_ids: list[str] | None = None,
        exclude_submitted: bool = True,
        risk_confirmation: GateConfirmation | None = None,
        created_by: str = "agent",
    ) -> dict[str, Any]:
        """Create the next immutable client-submission batch from a recommendation run."""
        request = CreateSubmissionBatchRequest(
            run_id=run_id,
            trace_id=trace_id,
            idempotency_key=idempotency_key,
            target_submission_count=target_submission_count,
            recommendation_item_ids=recommendation_item_ids,
            exclude_submitted=exclude_submitted,
            risk_confirmation=risk_confirmation,
            created_by=created_by,
        )
        return await _dispatch(registry, "create_submission_batch", request)

    @server.tool(name="ingest_mcn_submissions", structured_output=True)
    async def ingest_mcn_submissions(
        inquiry_id: str,
        items: list[McnSubmissionItem],
        trace_id: str,
        idempotency_key: str,
    ) -> dict[str, Any]:
        """Normalize MCN return data into offers and a hard-filtered candidate pool."""
        request = IngestMcnSubmissionsRequest(
            inquiry_id=inquiry_id,
            items=items,
            trace_id=trace_id,
            idempotency_key=idempotency_key,
        )
        return await _dispatch(registry, "ingest_mcn_submissions", request)

    @server.tool(name="manual_source_creators", structured_output=True)
    async def manual_source_creators(
        demand_id: str,
        demand_version: int,
        manual_results: list[ManualResult],
        trace_id: str,
        idempotency_key: str,
        search_context: SearchContext | None = None,
    ) -> dict[str, Any]:
        """Import manually sourced creator accounts and independently validate each offer."""
        request = ManualSourceCreatorsRequest(
            demand_id=demand_id,
            demand_version=demand_version,
            manual_results=manual_results,
            trace_id=trace_id,
            idempotency_key=idempotency_key,
            search_context=search_context,
        )
        return await _dispatch(registry, "manual_source_creators", request)

    @server.tool(name="record_client_feedback", structured_output=True)
    async def record_client_feedback(
        run_id: str,
        feedback_items: list[FeedbackItem],
        trace_id: str,
        idempotency_key: str,
        requirement_changes: RequirementChanges | None = None,
    ) -> dict[str, Any]:
        """Persist submission feedback and decide the sole next workflow action."""
        request = RecordClientFeedbackRequest(
            run_id=run_id,
            feedback_items=feedback_items,
            trace_id=trace_id,
            idempotency_key=idempotency_key,
            requirement_changes=requirement_changes,
        )
        return await _dispatch(registry, "record_client_feedback", request)

    @server.tool(name="audit_manual_adjustment", structured_output=True)
    async def audit_manual_adjustment(
        run_id: str,
        adjustments: list[ManualAdjustment],
        operator_id: str,
        trace_id: str,
        idempotency_key: str,
    ) -> dict[str, Any]:
        """Apply allowed recommendation adjustments and append a tamper-evident audit snapshot."""
        request = AuditManualAdjustmentRequest(
            run_id=run_id,
            adjustments=adjustments,
            operator_id=operator_id,
            trace_id=trace_id,
            idempotency_key=idempotency_key,
        )
        return await _dispatch(registry, "audit_manual_adjustment", request)

    @server.tool(name="get_workflow_state", structured_output=True)
    async def get_workflow_state(
        trace_id: str,
        demand_id: str | None = None,
        demand_version: int | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        """Read the current workflow state without advancing it or writing data."""
        request = GetWorkflowStateRequest(
            trace_id=trace_id,
            demand_id=demand_id,
            demand_version=demand_version,
            idempotency_key=idempotency_key,
        )
        return await _dispatch(registry, "get_workflow_state", request)

    @server.tool(name="get_creator_detail", structured_output=True)
    async def get_creator_detail(
        platform: str,
        platform_account_id: str,
        trace_id: str,
        include_offers: bool = True,
        include_mcn: bool = True,
        include_vector_text: bool = False,
        include_recent_metrics: bool = True,
    ) -> dict[str, Any]:
        """Read canonical platform creator details, metrics, offers, and MCN association."""
        request = GetCreatorDetailRequest(
            platform=platform,
            platform_account_id=platform_account_id,
            trace_id=trace_id,
            include_offers=include_offers,
            include_mcn=include_mcn,
            include_vector_text=include_vector_text,
            include_recent_metrics=include_recent_metrics,
        )
        return await _dispatch(registry, "get_creator_detail", request)

    @server.tool(name="get_recommendation_run_detail", structured_output=True)
    async def get_recommendation_run_detail(
        run_id: str,
        trace_id: str,
        include_submissions: bool = True,
        include_creator_detail: bool = False,
        include_feedback: bool = True,
    ) -> dict[str, Any]:
        """Read an immutable recommendation-run snapshot and grouped submissions."""
        request = GetRecommendationRunDetailRequest(
            run_id=run_id,
            trace_id=trace_id,
            include_submissions=include_submissions,
            include_creator_detail=include_creator_detail,
            include_feedback=include_feedback,
        )
        return await _dispatch(registry, "get_recommendation_run_detail", request)

    return server


runtime = configure_registry(default_registry)
mcp = create_server()


if __name__ == "__main__":
    transport = os.environ.get("YP_MCP_TRANSPORT", "stdio")
    if transport not in {"stdio", "streamable-http"}:
        raise ValueError("YP_MCP_TRANSPORT must be stdio or streamable-http")
    mcp.run(transport=transport)
