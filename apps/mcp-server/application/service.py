# SQL statements are kept next to their transaction logic; several safe, parameterized fragments
# are intentionally wider than the project's prose line length.
# ruff: noqa: E501

import hashlib
import logging
from collections import Counter, defaultdict
from collections.abc import Mapping
from datetime import UTC, date, datetime
from typing import Any
from uuid import uuid4

from contract.error_codes import ErrorCode
from contract.idempotency import IdempotencyConflict
from contract.response_envelope import ResponseEnvelope
from domain.filtering import CandidateInput, DemandFilter, filter_candidate, supply_assessment
from domain.requirements import InvalidRequirement, validate_requirement_extraction
from domain.scoring import (
    RANKING_WEIGHTS,
    audience_score,
    content_score,
    creator_final_score,
    data_percentile_score,
    mcn_rating_score,
    price_score,
    rebate_score,
)
from persistence.connection import creator_account_table
from persistence.idempotency import DatabaseIdempotencyExecutor, IdempotencyInProgress
from persistence.ledger import SqlToolCallLedger
from persistence.uow import MySqlUnitOfWork
from pydantic import ValidationError
from sampling import (
    InvalidSamplingResponse,
    SamplingUnavailable,
    parse_requirement_with_sampling,
)
from sqlalchemy import bindparam, text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine
from tools.registry import AGENT_TOOL_NAMES
from tools.schemas import (
    AuditManualAdjustmentRequest,
    CreateMcnInquiriesRequest,
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
)

from application.common import (
    ServiceResult,
    ToolFailure,
    as_float,
    json_text,
    json_value,
    rfc3339,
)

logger = logging.getLogger(__name__)

_DEMAND_COPY_COLUMNS = (
    "project_name",
    "brand",
    "product",
    "raw_messages_json",
    "platforms",
    "content_formats",
    "cooperation_types",
    "project_start_start",
    "project_start_end",
    "submission_deadline_at",
    "submission_deadline_raw",
    "budget_min_cents",
    "budget_max_cents",
    "budget_raw",
    "rebate_min_rate",
    "rebate_max_rate",
    "rebate_raw",
    "quantity_total",
    "category_requirements",
    "creator_type_requirements",
    "creator_tier_requirements",
    "follower_min",
    "follower_max",
    "geo_requirements",
    "audience_requirements",
    "content_requirements",
    "tone_requirements",
    "negative_requirements",
    "requirements_json",
    "missing_fields",
    "status",
)

_WRITE_REQUESTS = {
    "validate_requirement": ValidateRequirementRequest,
    "search_creators": SearchCreatorsRequest,
    "rank_mcns": RankMcnsRequest,
    "rank_creators": RankCreatorsRequest,
    "create_submission_batch": CreateSubmissionBatchRequest,
    "ingest_mcn_submissions": IngestMcnSubmissionsRequest,
    "manual_source_creators": ManualSourceCreatorsRequest,
    "record_client_feedback": RecordClientFeedbackRequest,
    "audit_manual_adjustment": AuditManualAdjustmentRequest,
}
_READ_REQUESTS = {
    "get_workflow_state": GetWorkflowStateRequest,
    "get_creator_detail": GetCreatorDetailRequest,
    "get_recommendation_run_detail": GetRecommendationRunDetailRequest,
}

_ALLOWED_ACTIONS = {
    "requirement_draft": ["validate_requirement"],
    "requirement_ready": ["search_creators"],
    "candidate_pool_ready": [
        "search_creators",
        "rank_mcns",
        "rank_creators",
        "manual_source_creators",
    ],
    "waiting_backend_inquiry": [
        "ingest_mcn_submissions",
        "manual_source_creators",
        "rank_creators",
    ],
    "recommendation_ready": ["create_submission_batch", "audit_manual_adjustment"],
    "submission_batch_ready": ["create_submission_batch", "record_client_feedback"],
    "closed": [],
}


class McpToolService:
    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine
        self._idempotency = DatabaseIdempotencyExecutor(SqlToolCallLedger(engine))

    async def invoke(self, tool_name: str, payload: Mapping[str, Any]) -> ResponseEnvelope:
        if tool_name not in AGENT_TOOL_NAMES:
            return ResponseEnvelope.fail(
                ErrorCode.VALIDATION_ERROR,
                f"unknown MCP tool: {tool_name}",
                trace_id=str(payload.get("trace_id") or uuid4().hex),
            )
        request_type = _WRITE_REQUESTS.get(tool_name) or _READ_REQUESTS[tool_name]
        clean_payload = {key: value for key, value in payload.items() if key != "_mcp_context"}
        try:
            request = request_type.model_validate(clean_payload)
        except ValidationError as exc:
            return ResponseEnvelope.fail(
                ErrorCode.VALIDATION_ERROR,
                "request validation failed",
                trace_id=str(payload.get("trace_id") or uuid4().hex),
                detail={"errors": exc.errors(include_url=False)},
                idempotency_key=payload.get("idempotency_key"),
            )

        if tool_name in _READ_REQUESTS:
            return await self._invoke_once(tool_name, request, payload)

        async def operation() -> dict[str, Any]:
            response = await self._invoke_once(tool_name, request, payload)
            return response.model_dump(mode="json")

        try:
            stored = await self._idempotency.execute(
                tool_name=tool_name,
                trace_id=request.trace_id,
                idempotency_key=request.idempotency_key,
                payload=clean_payload,
                operation=operation,
            )
            return ResponseEnvelope.model_validate(stored)
        except (IdempotencyConflict, IdempotencyInProgress) as exc:
            return ResponseEnvelope.fail(
                ErrorCode.IDEMPOTENCY_CONFLICT,
                str(exc),
                trace_id=request.trace_id,
                idempotency_key=request.idempotency_key,
                retriable=isinstance(exc, IdempotencyInProgress),
            )

    async def _invoke_once(
        self,
        tool_name: str,
        request: Any,
        raw_payload: Mapping[str, Any],
    ) -> ResponseEnvelope:
        try:
            method = getattr(self, f"_{tool_name}")
            if tool_name == "validate_requirement":
                result = await method(request, raw_payload.get("_mcp_context"))
            else:
                result = await method(request)
            return ResponseEnvelope.ok(
                result.data,
                trace_id=request.trace_id,
                workflow_state=result.workflow_state,
                allowed_actions=result.allowed_actions,
                idempotency_key=getattr(request, "idempotency_key", None),
            )
        except ToolFailure as exc:
            return ResponseEnvelope.fail(
                exc.code,
                exc.message,
                trace_id=request.trace_id,
                detail=exc.detail,
                retriable=exc.retriable,
                idempotency_key=getattr(request, "idempotency_key", None),
            )
        except Exception:
            logger.exception("MCP tool %s failed", tool_name)
            return ResponseEnvelope.fail(
                ErrorCode.INTERNAL_ERROR,
                "tool execution failed",
                trace_id=request.trace_id,
                retriable=True,
                idempotency_key=getattr(request, "idempotency_key", None),
            )

    async def _get_demand(
        self,
        connection: AsyncConnection,
        demand_id: str,
        demand_version: int,
        *,
        for_update: bool = False,
    ) -> Mapping[str, Any]:
        suffix = " FOR UPDATE" if for_update else ""
        result = await connection.execute(
            text(
                "SELECT * FROM customer_demands "
                "WHERE demand_id=:demand_id AND demand_version=:demand_version" + suffix
            ),
            {"demand_id": int(demand_id), "demand_version": demand_version},
        )
        row = result.mappings().first()
        if row is None:
            raise ToolFailure(ErrorCode.NOT_FOUND, "demand version was not found")
        return row

    async def _workflow(
        self,
        connection: AsyncConnection,
        demand_id: str,
        demand_version: int,
        *,
        for_update: bool = False,
        fallback_status: str | None = None,
    ) -> dict[str, Any]:
        suffix = " FOR UPDATE" if for_update else ""
        result = await connection.execute(
            text(
                "SELECT * FROM mcp_workflow_states "
                "WHERE demand_id=:demand_id AND demand_version=:demand_version" + suffix
            ),
            {"demand_id": int(demand_id), "demand_version": demand_version},
        )
        row = result.mappings().first()
        if row is None:
            phase = "requirement_ready" if fallback_status == "ready" else "requirement_draft"
            return {
                "demand_id": str(demand_id),
                "demand_version": demand_version,
                "phase": phase,
                "state_version": 0,
                "pending_gate": None,
                "platform_states": {},
            }
        return {
            "demand_id": str(row["demand_id"]),
            "demand_version": int(row["demand_version"]),
            "phase": row["phase"],
            "state_version": int(row["state_version"]),
            "pending_gate": row["pending_gate"],
            "platform_states": json_value(row["platform_states_json"], {}),
            "resolved_run_id": str(row["resolved_run_id"]) if row["resolved_run_id"] else None,
            "resolved_batch_no": row["resolved_batch_no"],
        }

    @staticmethod
    def _assert_phase(state: Mapping[str, Any], expected: set[str]) -> None:
        if state["phase"] not in expected:
            raise ToolFailure(
                ErrorCode.INVALID_PHASE,
                "workflow phase does not allow this operation",
                detail={"current_phase": state["phase"], "expected_phase": sorted(expected)},
            )

    async def _set_workflow(
        self,
        connection: AsyncConnection,
        *,
        demand_id: str,
        demand_version: int,
        phase: str,
        current_version: int,
        pending_gate: str | None = None,
        resolved_run_id: int | None = None,
        resolved_batch_no: int | None = None,
        platform_states: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        new_version = current_version + 1
        await connection.execute(
            text(
                "INSERT INTO mcp_workflow_states "
                "(demand_id,demand_version,phase,state_version,pending_gate,platform_states_json,"
                "resolved_run_id,resolved_batch_no) VALUES "
                "(:demand_id,:demand_version,:phase,:state_version,:pending_gate,:platform_states,"
                ":resolved_run_id,:resolved_batch_no) AS incoming "
                "ON DUPLICATE KEY UPDATE phase=incoming.phase, "
                "state_version=incoming.state_version, pending_gate=incoming.pending_gate, "
                "platform_states_json=incoming.platform_states_json, "
                "resolved_run_id=COALESCE(incoming.resolved_run_id,"
                "mcp_workflow_states.resolved_run_id), "
                "resolved_batch_no=COALESCE(incoming.resolved_batch_no,"
                "mcp_workflow_states.resolved_batch_no)"
            ),
            {
                "demand_id": int(demand_id),
                "demand_version": demand_version,
                "phase": phase,
                "state_version": new_version,
                "pending_gate": pending_gate,
                "platform_states": json_text(platform_states or {}),
                "resolved_run_id": resolved_run_id,
                "resolved_batch_no": resolved_batch_no,
            },
        )
        return {
            "demand_id": str(demand_id),
            "demand_version": demand_version,
            "phase": phase,
            "state_version": new_version,
            "pending_gate": pending_gate,
            "platform_states": dict(platform_states or {}),
            "resolved_run_id": str(resolved_run_id) if resolved_run_id else None,
            "resolved_batch_no": resolved_batch_no,
        }

    async def _validate_requirement(
        self,
        request: ValidateRequirementRequest,
        context: object | None,
    ) -> ServiceResult:
        if context is None:
            raise ToolFailure(
                ErrorCode.SAMPLING_UNAVAILABLE,
                "MCP client does not provide a Sampling context",
            )
        try:
            extraction = await parse_requirement_with_sampling(request.raw_messages, context)
            source_text = "\n".join(message.content for message in request.raw_messages)
            validated = validate_requirement_extraction(extraction, source_text)
        except SamplingUnavailable as exc:
            raise ToolFailure(ErrorCode.SAMPLING_UNAVAILABLE, str(exc)) from exc
        except InvalidSamplingResponse as exc:
            raise ToolFailure(ErrorCode.INVALID_RESPONSE_CONTRACT, str(exc)) from exc
        except InvalidRequirement as exc:
            raise ToolFailure(ErrorCode.VALIDATION_ERROR, str(exc)) from exc

        requirement_json = dict(validated.requirements_json)
        requirement_json.update(
            {
                "confidence_map": validated.confidence_map,
                "blocking_fields": validated.blocking_fields,
                "clarifying_questions": validated.clarifying_questions,
                "field_evidence": extraction.field_evidence,
                "version_fingerprint": validated.version_fingerprint,
            }
        )
        async with MySqlUnitOfWork(self._engine) as uow:
            connection = uow.require_connection()
            if request.existing_demand_id is not None:
                await self._get_demand(
                    connection,
                    request.existing_demand_id,
                    request.existing_demand_version,
                    for_update=True,
                )
                latest = await connection.scalar(
                    text("SELECT MAX(demand_version) FROM customer_demands WHERE demand_id=:id"),
                    {"id": int(request.existing_demand_id)},
                )
                if int(latest) != request.existing_demand_version:
                    raise ToolFailure(
                        ErrorCode.VERSION_CONFLICT,
                        "demand version is stale",
                        detail={"latest_demand_version": int(latest)},
                    )
                demand_id: int | None = int(request.existing_demand_id)
                demand_version = request.existing_demand_version + 1
            else:
                demand_id = None
                demand_version = 1

            project = request.project_context
            values = {
                "demand_id": demand_id,
                "demand_version": demand_version,
                "project_name": project.project_name if project else None,
                "brand": project.brand if project else None,
                "product": project.product if project else None,
                "raw_messages": json_text(
                    [item.model_dump(mode="json") for item in request.raw_messages]
                ),
                "platforms": json_text(extraction.platforms),
                "content_formats": json_text(extraction.content_formats),
                "cooperation_types": json_text(extraction.cooperation_types),
                "budget_min": extraction.budget_min_cents,
                "budget_max": extraction.budget_max_cents,
                "rebate_min": extraction.rebate_min_rate,
                "rebate_max": extraction.rebate_max_rate,
                "quantity": extraction.quantity_total,
                "categories": json_text(extraction.category_requirements),
                "creator_types": json_text(extraction.creator_type_requirements),
                "creator_tiers": json_text(extraction.creator_tier_requirements),
                "follower_min": extraction.follower_min,
                "follower_max": extraction.follower_max,
                "geo": json_text(extraction.geo_requirements),
                "audience": json_text(extraction.audience_requirements),
                "content_requirements": extraction.content_requirements,
                "tone": json_text(extraction.tone_requirements),
                "negative": json_text(extraction.negative_requirements),
                "requirements": json_text(requirement_json),
                "missing": json_text(validated.missing_fields),
                "status": validated.status,
            }
            columns = ""
            id_values = ""
            if demand_id is not None:
                columns = "demand_id,"
                id_values = ":demand_id,"
            result = await connection.execute(
                text(
                    f"INSERT INTO customer_demands ({columns}demand_version,project_name,brand,product,"
                    "raw_messages_json,platforms,content_formats,cooperation_types,"
                    "budget_min_cents,budget_max_cents,"
                    "rebate_min_rate,rebate_max_rate,quantity_total,category_requirements,"
                    "creator_type_requirements,creator_tier_requirements,follower_min,follower_max,"
                    "geo_requirements,audience_requirements,content_requirements,tone_requirements,"
                    "negative_requirements,"
                    "requirements_json,missing_fields,status) VALUES "
                    f"({id_values}:demand_version,:project_name,:brand,:product,:raw_messages,"
                    ":platforms,:content_formats,:cooperation_types,:budget_min,:budget_max,"
                    ":rebate_min,:rebate_max,:quantity,:categories,:creator_types,:creator_tiers,"
                    ":follower_min,:follower_max,:geo,:audience,:content_requirements,:tone,:negative,"
                    ":requirements,:missing,:status)"
                ),
                values,
            )
            if demand_id is None:
                demand_id = int(result.lastrowid)
            phase = "requirement_ready" if validated.status == "ready" else "requirement_draft"
            state = await self._set_workflow(
                connection,
                demand_id=str(demand_id),
                demand_version=demand_version,
                phase=phase,
                current_version=0,
            )

        data = {
            "demand_id": str(demand_id),
            "demand_version": demand_version,
            "status": validated.status,
            "requirement_parsed": extraction.model_dump(mode="json"),
            "confidence_map": validated.confidence_map,
            "missing_fields": validated.missing_fields,
            "blocking_fields": validated.blocking_fields,
            "clarifying_questions": validated.clarifying_questions,
            "version_fingerprint": validated.version_fingerprint,
        }
        return ServiceResult(data, state, _ALLOWED_ACTIONS[phase])

    async def _load_offer_candidates(
        self,
        connection: AsyncConnection,
        platforms: list[str],
    ) -> list[dict[str, Any]]:
        candidates: list[dict[str, Any]] = []
        for platform in platforms:
            table = creator_account_table(platform)
            account_id = "xhs_account_id" if platform == "xhs" else "dy_account_id"
            result = await connection.execute(
                text(
                    f"SELECT o.*,a.account_nickname,a.profile_url,a.followers_count,"
                    "a.creator_type,a.creator_tier,a.gender,a.province,a.city,"
                    f"a.canonical_categories,a.data_updated_at FROM creator_supply_offers o "
                    f"JOIN {table} a ON a.{account_id}=o.platform_account_id "
                    "WHERE o.platform=:platform"
                ),
                {"platform": platform},
            )
            candidates.extend(dict(row) for row in result.mappings())
        return candidates

    async def _search_creators(self, request: SearchCreatorsRequest) -> ServiceResult:
        async with MySqlUnitOfWork(self._engine) as uow:
            connection = uow.require_connection()
            demand = await self._get_demand(
                connection, request.demand_id, request.demand_version, for_update=True
            )
            state = await self._workflow(
                connection,
                request.demand_id,
                request.demand_version,
                for_update=True,
                fallback_status=demand["status"],
            )
            self._assert_phase(state, {"requirement_ready", "candidate_pool_ready"})
            platforms = json_value(demand["platforms"], [])
            requirements_json = json_value(demand["requirements_json"], {})
            relaxations = {item.field for item in request.authorized_relaxations}
            demand_filter = DemandFilter(
                platforms=platforms,
                budget_max_cents=demand["budget_max_cents"],
                rebate_min_rate=as_float(demand["rebate_min_rate"], 0),
                categories=json_value(demand["category_requirements"], []),
                authorized_relaxations=relaxations,
                filter_rules=requirements_json.get("filter_rules", []),
            )
            raw_candidates = await self._load_offer_candidates(connection, platforms)
            passed_by_account: dict[tuple[str, str], dict[str, Any]] = {}
            excluded_reasons: Counter[str] = Counter()
            excluded_candidate_count = 0
            for row in raw_candidates:
                evaluated = filter_candidate(
                    demand_filter,
                    CandidateInput(
                        platform=row["platform"],
                        price_cents=row["price_cents"],
                        rebate_rate=as_float(row["rebate_min_rate"]),
                        categories=json_value(row["canonical_categories"], ["other"]),
                        valid_until=row["valid_until"],
                        data_updated_at=row["data_updated_at"],
                        availability_status=row["availability_status"] or "need_confirm",
                        facts={
                            "creator_type": row["creator_type"],
                            "creator_tier": row["creator_tier"],
                            "followers_count": row["followers_count"],
                            "gender": row["gender"],
                            "province": row["province"],
                            "city": row["city"],
                            "cooperation_type": row["cooperation_type"],
                            "content_format": row["content_format"],
                        },
                    ),
                )
                if not evaluated.passed:
                    excluded_candidate_count += 1
                    excluded_reasons.update(evaluated.failed_reasons)
                    continue
                source = (
                    "manual_search"
                    if row["manual_sourced"]
                    else "mcn_returned"
                    if row["mcn_id"]
                    else "rate_card"
                )
                item = {
                    **row,
                    "candidate_source": source,
                    "risk_penalty": evaluated.risk_penalty,
                    "risk_notes_list": evaluated.risk_notes,
                    "categories": json_value(row["canonical_categories"], ["other"]),
                }
                key = (row["platform"], row["platform_account_id"])
                existing = passed_by_account.get(key)
                item_rebate = as_float(row["rebate_min_rate"], 0) or 0
                existing_rebate = as_float(existing["rebate_min_rate"], 0) if existing else -1
                if existing is None or (item_rebate, -row["price_cents"]) > (
                    existing_rebate,
                    -existing["price_cents"],
                ):
                    passed_by_account[key] = item

            selected = list(passed_by_account.values())[: request.limit]
            if not selected:
                raise ToolFailure(
                    ErrorCode.NO_RESULT_STRICT,
                    "no creators passed the strict filters",
                    detail={"excluded_reasons_summary": dict(excluded_reasons)},
                )
            output: list[dict[str, Any]] = []
            if request.write_candidate_pool:
                for item in selected:
                    existing_id = await connection.scalar(
                        text(
                            "SELECT candidate_id FROM creator_candidate_pool WHERE "
                            "demand_id=:demand_id AND demand_version=:demand_version "
                            "AND platform=:platform AND platform_account_id=:account_id "
                            "ORDER BY candidate_id LIMIT 1 FOR UPDATE"
                        ),
                        {
                            "demand_id": int(request.demand_id),
                            "demand_version": request.demand_version,
                            "platform": item["platform"],
                            "account_id": item["platform_account_id"],
                        },
                    )
                    matched = {
                        "authorized_relaxations": [
                            relaxation.model_dump(mode="json")
                            for relaxation in request.authorized_relaxations
                        ],
                        "score_detail": {"risk_penalty": item["risk_penalty"]},
                    }
                    values = {
                        "demand_id": int(request.demand_id),
                        "demand_version": request.demand_version,
                        "platform": item["platform"],
                        "account_id": item["platform_account_id"],
                        "offer_id": item["offer_id"],
                        "mcn_id": item["mcn_id"],
                        "source": item["candidate_source"],
                        "matched": json_text(matched),
                        "risk_notes": "; ".join(item["risk_notes_list"]) or None,
                    }
                    if existing_id:
                        await connection.execute(
                            text(
                                "UPDATE creator_candidate_pool SET offer_id=:offer_id,mcn_id=:mcn_id,"
                                "candidate_source=:source,hard_filter_passed=1,matched_json=:matched,"
                                "risk_notes=:risk_notes WHERE candidate_id=:candidate_id"
                            ),
                            {**values, "candidate_id": existing_id},
                        )
                        candidate_id = existing_id
                    else:
                        inserted = await connection.execute(
                            text(
                                "INSERT INTO creator_candidate_pool "
                                "(demand_id,demand_version,platform,platform_account_id,offer_id,mcn_id,"
                                "candidate_source,hard_filter_passed,matched_json,risk_notes) VALUES "
                                "(:demand_id,:demand_version,:platform,:account_id,:offer_id,:mcn_id,"
                                ":source,1,:matched,:risk_notes)"
                            ),
                            values,
                        )
                        candidate_id = inserted.lastrowid
                    item["candidate_id"] = candidate_id
            for item in selected:
                output.append(
                    {
                        "candidate_id": str(item.get("candidate_id"))
                        if item.get("candidate_id")
                        else None,
                        "platform": item["platform"],
                        "platform_account_id": item["platform_account_id"],
                        "name": item["account_nickname"],
                        "followers_count": item["followers_count"],
                        "categories": item["categories"],
                        "price_cents": item["price_cents"],
                        "rebate_min_rate": as_float(item["rebate_min_rate"]),
                        "rebate_max_rate": as_float(item["rebate_max_rate"]),
                        "match_score": 100.0,
                        "risk_notes": item["risk_notes_list"],
                    }
                )
            rate_card_count = len(
                {
                    (item["platform"], item["platform_account_id"])
                    for item in passed_by_account.values()
                    if item["candidate_source"] == "rate_card"
                }
            )
            assessment = supply_assessment(
                candidate_count=rate_card_count,
                quantity_total=demand["quantity_total"],
            )
            if request.write_candidate_pool:
                state = await self._set_workflow(
                    connection,
                    demand_id=request.demand_id,
                    demand_version=request.demand_version,
                    phase="candidate_pool_ready",
                    current_version=state["state_version"],
                    platform_states={platform: "candidate_pool_ready" for platform in platforms},
                )

        data = {
            "creators": output,
            "total_matched": len(passed_by_account),
            "applied_filters": demand_filter.model_dump(mode="json"),
            "relaxed_fields": sorted(relaxations),
            "excluded_count": excluded_candidate_count,
            "excluded_reasons_summary": dict(excluded_reasons),
            "supply_assessment": assessment.model_dump(mode="json"),
            "candidate_pool_written": request.write_candidate_pool,
        }
        return ServiceResult(data, state, _ALLOWED_ACTIONS[state["phase"]])

    async def _rank_mcns(self, request: RankMcnsRequest) -> ServiceResult:
        async with MySqlUnitOfWork(self._engine) as uow:
            connection = uow.require_connection()
            demand = await self._get_demand(
                connection, request.demand_id, request.demand_version, for_update=True
            )
            state = await self._workflow(
                connection,
                request.demand_id,
                request.demand_version,
                for_update=True,
                fallback_status=demand["status"],
            )
            self._assert_phase(state, {"candidate_pool_ready", "waiting_backend_inquiry"})
            supplier_result = await connection.execute(
                text(
                    "SELECT * FROM core_supplier WHERE is_active=1 AND cooperation_status='active'"
                )
            )
            suppliers = [dict(row) for row in supplier_result.mappings()]
            if not suppliers:
                raise ToolFailure(ErrorCode.NO_MCN_MATCHED, "no active MCN supplier matched")
            list_result = await connection.execute(
                text(
                    "SELECT mcn_id,platform,platform_account_id,submitted_rebate_rate "
                    "FROM mcn_monthly_creator_lists WHERE platform=:platform"
                ),
                {"platform": request.platform},
            )
            coverage: dict[str, set[tuple[str, str]]] = defaultdict(set)
            list_rebates: dict[str, list[float]] = defaultdict(list)
            for row in list_result.mappings():
                if row["mcn_id"]:
                    coverage[row["mcn_id"]].add((row["platform"], row["platform_account_id"]))
                    list_rebates[row["mcn_id"]].append(as_float(row["submitted_rebate_rate"], 0))
            max_count = max((len(coverage[item["id"]]) for item in suppliers), default=0)
            ranked: list[dict[str, Any]] = []
            policy_map = {"a": 100.0, "b": 80.0, "c": 60.0, "d": 40.0}
            for supplier in suppliers:
                profiles = json_value(supplier["platform_profiles_json"], {})
                profile = profiles.get(request.platform, {}) if isinstance(profiles, dict) else {}
                count = len(coverage[supplier["id"]])
                count_score = count / max_count * 100 if max_count else 0.0
                rebates = list_rebates[supplier["id"]]
                avg_rebate = (
                    sum(rebates) / len(rebates)
                    if rebates
                    else as_float(supplier["default_rebate_rate"], 0) or 0
                )
                demand_min = as_float(demand["rebate_min_rate"], 0) or 0
                rebate_component = rebate_score(
                    rate=avg_rebate,
                    minimum=demand_min,
                    maximum=1.0,
                )
                policy = profile.get("policy_rating_score")
                if policy is None:
                    policy = policy_map.get(str(supplier["policy_rating"]).lower())
                project_feedback = profile.get("project_feedback_score")
                if project_feedback is None and supplier["selected_rate"] is not None:
                    project_feedback = as_float(supplier["selected_rate"], 0) * 100
                settlement = profile.get("settlement_cooperation_score")
                if settlement is None and supplier["response_rate"] is not None:
                    settlement = as_float(supplier["response_rate"], 0) * 100
                rating_inputs = {
                    "policy_rating_score": 50 if policy is None else policy,
                    "project_feedback_score": 50 if project_feedback is None else project_feedback,
                    "settlement_cooperation_score": 50 if settlement is None else settlement,
                }
                rating = mcn_rating_score(
                    policy=policy,
                    project_feedback=project_feedback,
                    settlement=settlement,
                )
                score = count_score * 0.10 + rebate_component * 0.70 + rating * 0.20
                ranked.append(
                    {
                        "mcn_id": supplier["id"],
                        "agency_name": supplier["name"],
                        "estimated_creator_count": count,
                        "creator_count_score": round(count_score, 4),
                        "avg_rebate_rate": round(avg_rebate, 6),
                        "rebate_score": round(rebate_component, 4),
                        "rating_score": round(rating, 4),
                        "rating_inputs": rating_inputs,
                        "mcn_rank_score": round(score, 4),
                        "recommend_reason": "fixed-v1 MCN score",
                        "risk_notes": [],
                    }
                )
            ranked.sort(
                key=lambda item: (
                    item["mcn_rank_score"],
                    item["avg_rebate_rate"],
                    item["estimated_creator_count"],
                    item["rating_score"],
                ),
                reverse=True,
            )
            ranked = ranked[: request.limit]
            base_result = await connection.execute(
                text(
                    "SELECT platform,platform_account_id FROM creator_candidate_pool WHERE "
                    "demand_id=:demand_id AND demand_version=:demand_version "
                    "AND platform=:platform AND hard_filter_passed=1"
                ),
                {
                    "demand_id": int(request.demand_id),
                    "demand_version": request.demand_version,
                    "platform": request.platform,
                },
            )
            union = {
                (row["platform"], row["platform_account_id"]) for row in base_result.mappings()
            }
            selected_details = []
            selected_ids = []
            buffered_target = request.target_multiplier * (1 + request.buffer_rate)
            for rank_order, item in enumerate(ranked, 1):
                item["rank_order"] = rank_order
                union.update(coverage[item["mcn_id"]])
                multiplier = len(union) / demand["quantity_total"]
                selected_ids.append(item["mcn_id"])
                selected_details.append(
                    {
                        "mcn_id": item["mcn_id"],
                        "cumulative_candidate_count_after_added": len(union),
                        "cumulative_multiplier_after_added": multiplier,
                    }
                )
                if len(selected_ids) >= request.minimum_mcn_count and multiplier >= buffered_target:
                    break
            multiplier = len(union) / demand["quantity_total"]
            risk = (
                "high_risk" if multiplier < 10 else "medium_risk" if multiplier < 20 else "low_risk"
            )
            can_send = risk == "low_risk" or (
                risk == "medium_risk" and request.medium_risk_confirmation is not None
            )
            pending_gate = (
                "supply_high_risk"
                if risk == "high_risk"
                else "confirm_medium_risk"
                if risk == "medium_risk" and not can_send
                else None
            )
            gate_id = None
            if request.medium_risk_confirmation is not None:
                confirmation = request.medium_risk_confirmation
                if confirmation.confirmation_type != "confirm_medium_risk":
                    raise ToolFailure(
                        ErrorCode.GATE_REQUIRED,
                        "medium-risk confirmation has the wrong type",
                        detail={"required_gate": "confirm_medium_risk"},
                    )
                gate_id = uuid4().hex
                await connection.execute(
                    text(
                        "INSERT INTO mcp_gate_confirmations "
                        "(gate_id,demand_id,demand_version,confirmation_type,confirmed_by,risk_notes,"
                        "confirmation_payload_json,confirmed_at) VALUES "
                        "(:gate_id,:demand_id,:version,:type,:by,:notes,:payload,:at)"
                    ),
                    {
                        "gate_id": gate_id,
                        "demand_id": int(request.demand_id),
                        "version": request.demand_version,
                        "type": confirmation.confirmation_type,
                        "by": confirmation.confirmed_by,
                        "notes": confirmation.risk_notes,
                        "payload": json_text(confirmation.model_dump(mode="json")),
                        "at": confirmation.confirmed_at or datetime.now(UTC),
                    },
                )
            formula = {
                "formula": "creator_count_score*0.10+rebate_score*0.70+rating_score*0.20",
                "weights": {"creator_count": 0.10, "rebate": 0.70, "rating": 0.20},
                "tie_break": ["avg_rebate_rate", "estimated_creator_count", "rating_score"],
                "rating_formula": "policy*0.50+project_feedback*0.30+settlement*0.20",
                "buffer_rate": request.buffer_rate,
                "rule_version": "mcn-v1",
            }
            mcn_run_id = uuid4().hex
            if request.write_mcn_recommendation_items:
                for item in ranked:
                    await connection.execute(
                        text(
                            "INSERT INTO mcn_recommendation_items "
                            "(mcn_run_id,demand_id,demand_version,platform,mcn_id,estimated_creator_count,"
                            "creator_count_score,avg_rebate_rate,rebate_score,rating_score,mcn_rank_score,"
                            "formula_snapshot_json,rating_inputs_json,rank_order,recommend_reason,risk_notes,"
                            "gate_confirmation_id,confirmed_by,confirmed_at) VALUES "
                            "(:run,:demand,:version,:platform,:mcn,:count,:count_score,:rebate,"
                            ":rebate_score,:rating,:score,:formula,:rating_inputs,:rank_order,:reason,"
                            ":risk_notes,:gate,:confirmed_by,:confirmed_at)"
                        ),
                        {
                            "run": mcn_run_id,
                            "demand": int(request.demand_id),
                            "version": request.demand_version,
                            "platform": request.platform,
                            "mcn": item["mcn_id"],
                            "count": item["estimated_creator_count"],
                            "count_score": item["creator_count_score"],
                            "rebate": item["avg_rebate_rate"],
                            "rebate_score": item["rebate_score"],
                            "rating": item["rating_score"],
                            "score": item["mcn_rank_score"],
                            "formula": json_text(formula),
                            "rating_inputs": json_text(item["rating_inputs"]),
                            "rank_order": item["rank_order"],
                            "reason": item["recommend_reason"],
                            "risk_notes": "; ".join(item["risk_notes"]) or None,
                            "gate": gate_id,
                            "confirmed_by": request.medium_risk_confirmation.confirmed_by
                            if request.medium_risk_confirmation
                            else None,
                            "confirmed_at": request.medium_risk_confirmation.confirmed_at
                            or datetime.now(UTC)
                            if request.medium_risk_confirmation
                            else None,
                        },
                    )
                state = await self._set_workflow(
                    connection,
                    demand_id=request.demand_id,
                    demand_version=request.demand_version,
                    phase="waiting_backend_inquiry",
                    current_version=state["state_version"],
                    pending_gate=pending_gate,
                    platform_states={request.platform: "mcn_ranked"},
                )
        advice = {
            "selected_mcn_ids": selected_ids,
            "selected_mcn_details": selected_details,
            "cumulative_candidate_count": len(union),
            "cumulative_supply_multiplier": multiplier,
            "minimum_multiplier_met": multiplier >= 10,
            "target_multiplier_met": multiplier >= request.target_multiplier,
            "buffered_target_multiplier": buffered_target,
            "supply_risk_level": risk,
            "requires_media_confirmation": risk == "medium_risk",
            "can_send": can_send and risk != "high_risk",
            "should_continue_adding": multiplier < buffered_target,
            "message_template_key": "mcn_inquiry_standard_v1",
            "message_template_variables": {
                "demand_id": request.demand_id,
                "demand_version": request.demand_version,
            },
        }
        data = {
            "mcn_run_id": mcn_run_id,
            "mcns": ranked,
            "total_matched": len(ranked),
            "formula_snapshot": formula,
            "inquiry_advice": advice,
            "minimum_mcn_count_met": len(ranked) >= request.minimum_mcn_count,
        }
        return ServiceResult(data, state, _ALLOWED_ACTIONS[state["phase"]])

    async def _load_rank_accounts(
        self,
        connection: AsyncConnection,
        candidates: list[Mapping[str, Any]],
    ) -> dict[tuple[str, str], dict[str, Any]]:
        accounts: dict[tuple[str, str], dict[str, Any]] = {}
        for platform in ("xhs", "dy"):
            ids = [row["platform_account_id"] for row in candidates if row["platform"] == platform]
            if not ids:
                continue
            table = creator_account_table(platform)
            account_id = "xhs_account_id" if platform == "xhs" else "dy_account_id"
            statement = text(
                f"SELECT {account_id} AS platform_account_id,account_nickname,followers_count,"
                "canonical_categories,gender,province,city,valid_followers_rate,avg_interactions,"
                f"viral_post_rate,data_updated_at,profile_url FROM {table} "
                f"WHERE {account_id} IN :account_ids"
            ).bindparams(bindparam("account_ids", expanding=True))
            result = await connection.execute(statement, {"account_ids": sorted(set(ids))})
            for row in result.mappings():
                accounts[(platform, row["platform_account_id"])] = dict(row)
        return accounts

    async def _rank_creators(self, request: RankCreatorsRequest) -> ServiceResult:
        async with MySqlUnitOfWork(self._engine) as uow:
            connection = uow.require_connection()
            demand = await self._get_demand(
                connection,
                request.demand_id,
                request.demand_version,
                for_update=True,
            )
            state = await self._workflow(
                connection,
                request.demand_id,
                request.demand_version,
                for_update=True,
                fallback_status=demand["status"],
            )
            self._assert_phase(
                state,
                {"candidate_pool_ready", "waiting_backend_inquiry", "recommendation_ready"},
            )
            candidate_sql = (
                "SELECT c.*,o.price_cents,o.rebate_min_rate,o.rebate_max_rate,"
                "o.availability_status,o.valid_until,o.cooperation_type,o.content_format "
                "FROM creator_candidate_pool c JOIN creator_supply_offers o ON o.offer_id=c.offer_id "
                "WHERE c.demand_id=:demand_id AND c.demand_version=:demand_version "
                "AND c.hard_filter_passed=1 AND c.offer_id IS NOT NULL"
            )
            parameters: dict[str, Any] = {
                "demand_id": int(request.demand_id),
                "demand_version": request.demand_version,
            }
            statement = text(candidate_sql)
            if request.candidate_ids:
                statement = text(
                    candidate_sql + " AND c.candidate_id IN :candidate_ids"
                ).bindparams(bindparam("candidate_ids", expanding=True))
                parameters["candidate_ids"] = [int(value) for value in request.candidate_ids]
            result = await connection.execute(statement, parameters)
            candidates = [dict(row) for row in result.mappings()]
            if not candidates:
                raise ToolFailure(
                    ErrorCode.NO_ELIGIBLE_CANDIDATES,
                    "no hard-filtered candidates with valid offers were found",
                )
            submitted: set[tuple[str, str]] = set()
            if request.exclude_submitted:
                submitted_result = await connection.execute(
                    text(
                        "SELECT platform,platform_account_id FROM creator_submissions "
                        "WHERE demand_id=:demand_id AND demand_version=:demand_version"
                    ),
                    parameters,
                )
                submitted = {
                    (row["platform"], row["platform_account_id"])
                    for row in submitted_result.mappings()
                }
            source_order = {source: index for index, source in enumerate(request.source_priority)}
            grouped: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
            excluded_reasons: Counter[str] = Counter()
            for candidate in candidates:
                key = (candidate["platform"], candidate["platform_account_id"])
                if key in submitted:
                    excluded_reasons["already_submitted"] += 1
                    continue
                if (
                    request.run_type == "initial"
                    and candidate["candidate_source"] == "manual_search"
                    and not request.allow_manual_sourced_in_initial_run
                ):
                    excluded_reasons["manual_search_not_allowed_in_initial_run"] += 1
                    continue
                if candidate["valid_until"] and candidate["valid_until"] < date.today():
                    excluded_reasons["offer_expired"] += 1
                    continue
                grouped[key].append(candidate)
            deduplicated: list[dict[str, Any]] = []
            for choices in grouped.values():
                choices.sort(
                    key=lambda row: (
                        -source_order.get(row["candidate_source"], len(source_order)),
                        as_float(row["rebate_min_rate"], 0) or 0,
                        -row["price_cents"],
                    ),
                    reverse=True,
                )
                deduplicated.append(choices[0])
            if not deduplicated:
                raise ToolFailure(
                    ErrorCode.NO_ELIGIBLE_CANDIDATES,
                    "all candidates were excluded before ranking",
                    detail={"excluded_reasons_summary": dict(excluded_reasons)},
                )
            accounts = await self._load_rank_accounts(connection, deduplicated)
            interaction_population = [
                value
                for account in accounts.values()
                if (value := as_float(account["avg_interactions"])) is not None and value > 0
            ]
            valid_fans_population = [
                value
                for account in accounts.values()
                if (value := as_float(account["valid_followers_rate"])) is not None and value > 0
            ]
            viral_population = [
                value
                for account in accounts.values()
                if (value := as_float(account["viral_post_rate"])) is not None and value > 0
            ]
            weights = (
                request.ranking_weights.model_dump()
                if request.ranking_weights is not None
                else RANKING_WEIGHTS[request.ranking_strategy]
            )
            authorized_relaxations: list[dict[str, Any]] = []
            scored: list[dict[str, Any]] = []
            for candidate in deduplicated:
                account = accounts.get(
                    (candidate["platform"], candidate["platform_account_id"]), {}
                )
                matched = json_value(candidate["matched_json"], {})
                authorized_relaxations.extend(matched.get("authorized_relaxations", []))
                candidate_categories = json_value(account.get("canonical_categories"), ["other"])
                requested_categories = json_value(demand["category_requirements"], [])
                tag_score = (
                    100.0 if set(candidate_categories).intersection(requested_categories) else 0.0
                )
                content_component = content_score(
                    tag=tag_score,
                    keyword=matched.get("keyword_score"),
                    vector=matched.get("vector_score"),
                )
                price_component = price_score(
                    price_cents=candidate["price_cents"],
                    budget_min_cents=demand["budget_min_cents"],
                    budget_max_cents=demand["budget_max_cents"],
                )
                effective_rebate = as_float(candidate["rebate_min_rate"], 0) or 0
                rebate_component = rebate_score(
                    rate=effective_rebate,
                    minimum=as_float(demand["rebate_min_rate"], 0) or 0,
                    maximum=as_float(demand["rebate_max_rate"], 1) or 1,
                )
                declared_matches: list[float] = []
                audience = json_value(demand["audience_requirements"], {})
                geo = json_value(demand["geo_requirements"], {})
                if audience.get("gender"):
                    declared_matches.append(
                        100 if account.get("gender") in audience["gender"] else 0
                    )
                if geo.get("province"):
                    declared_matches.append(
                        100 if account.get("province") in geo["province"] else 0
                    )
                if geo.get("city"):
                    declared_matches.append(100 if account.get("city") in geo["city"] else 0)
                audience_component = audience_score(declared_matches)
                interaction = as_float(account.get("avg_interactions"), 0) or 0
                valid_fans = as_float(account.get("valid_followers_rate"), 0) or 0
                viral = as_float(account.get("viral_post_rate"), 0) or 0
                metric_inputs = []
                if interaction > 0 and interaction_population:
                    metric_inputs.append((interaction, interaction_population))
                if valid_fans > 0 and valid_fans_population:
                    metric_inputs.append((valid_fans, valid_fans_population))
                if viral > 0 and viral_population:
                    metric_inputs.append((viral, viral_population))
                data_component = data_percentile_score(metric_inputs)
                mcn_component = 50.0
                if candidate["mcn_id"]:
                    supplier = await connection.execute(
                        text("SELECT policy_rating FROM core_supplier WHERE id=:mcn_id"),
                        {"mcn_id": candidate["mcn_id"]},
                    )
                    policy = supplier.scalar_one_or_none()
                    mcn_component = {
                        "a": 100.0,
                        "b": 80.0,
                        "c": 60.0,
                        "d": 40.0,
                    }.get(str(policy).lower(), 50.0)
                components = {
                    "content_match_score": content_component,
                    "price_score": price_component,
                    "rebate_score": rebate_component,
                    "audience_score": audience_component,
                    "data_score": data_component,
                    "mcn_score": mcn_component,
                }
                risk_penalty = float(matched.get("score_detail", {}).get("risk_penalty", 0))
                final = creator_final_score(components, weights, risk_penalty=risk_penalty)
                score_detail = {
                    "inputs": {
                        "candidate_categories": candidate_categories,
                        "requested_categories": requested_categories,
                        "price_cents": candidate["price_cents"],
                        "effective_rebate_rate": effective_rebate,
                    },
                    "components": components,
                    "raw_score": final.raw_score,
                    "risk_penalty": final.risk_penalty,
                    "applied_penalty": final.applied_penalty,
                }
                scored.append(
                    {
                        **candidate,
                        **components,
                        "final_score": final.final_score,
                        "score_detail": score_detail,
                        "risk_notes_list": [candidate["risk_notes"]]
                        if candidate["risk_notes"]
                        else [],
                    }
                )
            scored.sort(
                key=lambda row: (
                    row["final_score"],
                    as_float(row["rebate_min_rate"], 0) or 0,
                    -row["price_cents"],
                    -row["candidate_id"],
                ),
                reverse=True,
            )
            scored = scored[: request.limit]
            run_insert = await connection.execute(
                text(
                    "INSERT INTO recommendation_runs "
                    "(demand_id,demand_version,run_type,algorithm_version,rule_version,tag_version,"
                    "ranking_strategy,ranking_weights_json,candidate_pool_snapshot_at,"
                    "metric_snapshot_date,parameters_json,status,created_by,finished_at) VALUES "
                    "(:demand_id,:version,:run_type,'creator-ranking-v1','business-rules-v1',"
                    "'unmapped-v1',:strategy,:weights,CURRENT_TIMESTAMP(6),CURRENT_DATE(),"
                    ":parameters,'completed','agent',CURRENT_TIMESTAMP(6))"
                ),
                {
                    "demand_id": int(request.demand_id),
                    "version": request.demand_version,
                    "run_type": request.run_type,
                    "strategy": request.ranking_strategy,
                    "weights": json_text(weights),
                    "parameters": json_text(
                        {
                            "authorized_relaxations": authorized_relaxations,
                            "feedback_preferences": request.feedback_preferences,
                            "source_priority": request.source_priority,
                        }
                    ),
                },
            )
            run_id = int(run_insert.lastrowid)
            items: list[dict[str, Any]] = []
            for rank_order, item in enumerate(scored, 1):
                await connection.execute(
                    text(
                        "INSERT INTO recommendation_run_candidates "
                        "(run_id,candidate_id,demand_id,demand_version,platform,platform_account_id,"
                        "offer_id,eligible,score_detail_json,rank_order) VALUES "
                        "(:run,:candidate,:demand,:version,:platform,:account,:offer,1,:score,:rank)"
                    ),
                    {
                        "run": run_id,
                        "candidate": item["candidate_id"],
                        "demand": int(request.demand_id),
                        "version": request.demand_version,
                        "platform": item["platform"],
                        "account": item["platform_account_id"],
                        "offer": item["offer_id"],
                        "score": json_text(item["score_detail"]),
                        "rank": rank_order,
                    },
                )
                recommendation_item_id = None
                if request.write_recommendation_items:
                    inserted = await connection.execute(
                        text(
                            "INSERT INTO creator_recommendation_items "
                            "(run_id,demand_id,demand_version,candidate_id,platform,"
                            "platform_account_id,mcn_id,offer_id,candidate_source,submitted_price_cents,"
                            "submitted_rebate_rate,availability_status,content_match_score,price_score,"
                            "rebate_score,audience_score,data_score,mcn_score,final_score,score_detail_json,"
                            "original_rank,rank_order,agent_reason,recommend_reason,risk_notes) VALUES "
                            "(:run,:demand,:version,:candidate,:platform,:account,:mcn,:offer,:source,"
                            ":price,:rebate,:availability,:content_score,:price_score,:rebate_score,"
                            ":audience_score,:data_score,:mcn_score,:final_score,:detail,:original_rank,"
                            ":rank_order,:agent_reason,:recommend_reason,:risk_notes)"
                        ),
                        {
                            "run": run_id,
                            "demand": int(request.demand_id),
                            "version": request.demand_version,
                            "candidate": item["candidate_id"],
                            "platform": item["platform"],
                            "account": item["platform_account_id"],
                            "mcn": item["mcn_id"],
                            "offer": item["offer_id"],
                            "source": item["candidate_source"],
                            "price": item["price_cents"],
                            "rebate": as_float(item["rebate_min_rate"], 0),
                            "availability": item["availability_status"],
                            "content_score": item["content_match_score"],
                            "price_score": item["price_score"],
                            "rebate_score": item["rebate_score"],
                            "audience_score": item["audience_score"],
                            "data_score": item["data_score"],
                            "mcn_score": item["mcn_score"],
                            "final_score": item["final_score"],
                            "detail": json_text(item["score_detail"]),
                            "original_rank": rank_order,
                            "rank_order": rank_order,
                            "agent_reason": "deterministic creator-ranking-v1 formula",
                            "recommend_reason": "hard filters passed; ranked by fixed v1 score",
                            "risk_notes": "; ".join(item["risk_notes_list"]) or None,
                        },
                    )
                    recommendation_item_id = int(inserted.lastrowid)
                    await connection.execute(
                        text(
                            "UPDATE creator_candidate_pool SET is_locked=1,locked_by_run_id=:run,"
                            "locked_at=CURRENT_TIMESTAMP(6) WHERE candidate_id=:candidate"
                        ),
                        {"run": run_id, "candidate": item["candidate_id"]},
                    )
                items.append(
                    {
                        "recommendation_item_id": str(recommendation_item_id)
                        if recommendation_item_id
                        else None,
                        "candidate_id": str(item["candidate_id"]),
                        "offer_id": str(item["offer_id"]),
                        "platform": item["platform"],
                        "platform_account_id": item["platform_account_id"],
                        "availability_status": item["availability_status"],
                        "content_match_score": item["content_match_score"],
                        "price_score": item["price_score"],
                        "rebate_score": item["rebate_score"],
                        "audience_score": item["audience_score"],
                        "data_score": item["data_score"],
                        "mcn_score": item["mcn_score"],
                        "final_score": item["final_score"],
                        "original_rank": rank_order,
                        "rank_order": rank_order,
                        "agent_reason": "deterministic creator-ranking-v1 formula",
                        "recommend_reason": "hard filters passed; ranked by fixed v1 score",
                        "risk_notes": item["risk_notes_list"],
                        "score_detail": item["score_detail"],
                    }
                )
            state = await self._set_workflow(
                connection,
                demand_id=request.demand_id,
                demand_version=request.demand_version,
                phase="recommendation_ready",
                current_version=state["state_version"],
                resolved_run_id=run_id,
            )
        data = {
            "run_id": str(run_id),
            "run_snapshot": {
                "algorithm_version": "creator-ranking-v1",
                "rule_version": "business-rules-v1",
                "tag_version": "unmapped-v1",
                "candidate_pool_snapshot_at": rfc3339(datetime.now(UTC)),
                "metric_snapshot_date": date.today().isoformat(),
                "ranking_weights_json": weights,
                "parameters_json": {
                    "authorized_relaxations": authorized_relaxations,
                    "feedback_preferences": request.feedback_preferences,
                },
            },
            "items": items,
            "total_ranked": len(items),
            "excluded_count": sum(excluded_reasons.values()),
            "excluded_reasons_summary": dict(excluded_reasons),
            "deduplication_summary": {
                "duplicate_creator_count": len(candidates) - len(grouped),
                "selected_offer_count": len(deduplicated),
                "selection_rule": "source_priority > rebate DESC > price ASC",
            },
            "ranking_weights_snapshot": weights,
            "write_status": "written" if request.write_recommendation_items else "skipped",
        }
        return ServiceResult(data, state, _ALLOWED_ACTIONS[state["phase"]])

    async def _create_submission_batch(
        self,
        request: CreateSubmissionBatchRequest,
    ) -> ServiceResult:
        async with MySqlUnitOfWork(self._engine) as uow:
            connection = uow.require_connection()
            run_result = await connection.execute(
                text("SELECT * FROM recommendation_runs WHERE run_id=:run_id FOR UPDATE"),
                {"run_id": int(request.run_id)},
            )
            run = run_result.mappings().first()
            if run is None:
                raise ToolFailure(
                    ErrorCode.NO_RECOMMENDATION_POOL, "recommendation run was not found"
                )
            demand = await self._get_demand(
                connection,
                str(run["demand_id"]),
                run["demand_version"],
                for_update=True,
            )
            state = await self._workflow(
                connection,
                str(run["demand_id"]),
                run["demand_version"],
                for_update=True,
                fallback_status=demand["status"],
            )
            self._assert_phase(state, {"recommendation_ready", "submission_batch_ready"})
            target = request.target_submission_count or demand["quantity_total"] * 2
            maximum = demand["quantity_total"] * 3
            if target > maximum:
                raise ToolFailure(
                    ErrorCode.VALIDATION_ERROR,
                    "target submission count exceeds quantity_total * 3",
                    detail={"maximum_target_submission_count": maximum},
                )
            item_sql = (
                "SELECT i.* FROM creator_recommendation_items i WHERE i.run_id=:run_id "
                "AND i.review_status<>'removed'"
            )
            params: dict[str, Any] = {"run_id": int(request.run_id)}
            statement = text(item_sql)
            if request.recommendation_item_ids:
                statement = text(item_sql + " AND i.item_id IN :item_ids").bindparams(
                    bindparam("item_ids", expanding=True)
                )
                params["item_ids"] = [int(value) for value in request.recommendation_item_ids]
            result = await connection.execute(statement, params)
            items = [dict(row) for row in result.mappings()]
            if request.exclude_submitted:
                already_result = await connection.execute(
                    text(
                        "SELECT platform,platform_account_id FROM creator_submissions "
                        "WHERE demand_id=:demand_id AND demand_version=:version"
                    ),
                    {"demand_id": run["demand_id"], "version": run["demand_version"]},
                )
                already = {
                    (row["platform"], row["platform_account_id"])
                    for row in already_result.mappings()
                }
                items = [
                    item
                    for item in items
                    if (item["platform"], item["platform_account_id"]) not in already
                ]
            risky = [item for item in items if item["availability_status"] == "need_confirm"]
            gate_id = None
            if risky and request.risk_confirmation is None:
                items = [item for item in items if item["availability_status"] != "need_confirm"]
            elif risky:
                confirmation = request.risk_confirmation
                if confirmation.confirmation_type != "confirm_risky_submission":
                    raise ToolFailure(
                        ErrorCode.GATE_REQUIRED,
                        "risky submissions require an explicit confirmation",
                        detail={"required_gate": "confirm_risky_submission"},
                    )
                gate_id = uuid4().hex
                await connection.execute(
                    text(
                        "INSERT INTO mcp_gate_confirmations "
                        "(gate_id,demand_id,demand_version,run_id,confirmation_type,confirmed_by,"
                        "risk_notes,confirmation_payload_json,confirmed_at) VALUES "
                        "(:gate,:demand,:version,:run,:type,:by,:notes,:payload,:at)"
                    ),
                    {
                        "gate": gate_id,
                        "demand": run["demand_id"],
                        "version": run["demand_version"],
                        "run": run["run_id"],
                        "type": confirmation.confirmation_type,
                        "by": confirmation.confirmed_by,
                        "notes": confirmation.risk_notes,
                        "payload": json_text(confirmation.model_dump(mode="json")),
                        "at": confirmation.confirmed_at or datetime.now(UTC),
                    },
                )
            items.sort(key=lambda item: item["rank_order"])
            selected = items[:target]
            if len(selected) < target:
                raise ToolFailure(
                    ErrorCode.INSUFFICIENT_RECOMMENDATION_ITEMS,
                    "the recommendation pool cannot satisfy the requested batch size",
                    detail={"requested": target, "available": len(selected)},
                )
            batch_no = int(
                await connection.scalar(
                    text(
                        "SELECT COALESCE(MAX(batch_no),0)+1 FROM submission_batches WHERE run_id=:run"
                    ),
                    {"run": run["run_id"]},
                )
            )
            snapshot = {
                "algorithm_version": run["algorithm_version"],
                "rule_version": run["rule_version"],
                "tag_version": run["tag_version"],
                "ranking_weights_json": json_value(run["ranking_weights_json"], {}),
                "parameters_json": json_value(run["parameters_json"], {}),
            }
            batch_result = await connection.execute(
                text(
                    "INSERT INTO submission_batches "
                    "(run_id,demand_id,demand_version,batch_no,target_submission_count,"
                    "actual_submission_count,snapshot_json,gate_confirmation_id,created_by) VALUES "
                    "(:run,:demand,:version,:batch,:target,:actual,:snapshot,:gate,:created_by)"
                ),
                {
                    "run": run["run_id"],
                    "demand": run["demand_id"],
                    "version": run["demand_version"],
                    "batch": batch_no,
                    "target": target,
                    "actual": len(selected),
                    "snapshot": json_text(snapshot),
                    "gate": gate_id,
                    "created_by": request.created_by,
                },
            )
            submission_batch_id = int(batch_result.lastrowid)
            submissions = []
            for item in selected:
                inserted = await connection.execute(
                    text(
                        "INSERT INTO creator_submissions "
                        "(submission_batch_id,run_id,batch_no,recommendation_item_id,demand_id,"
                        "demand_version,platform,platform_account_id,mcn_id,submitted_price_cents,"
                        "submitted_rebate_rate,availability_status,gate_confirmation_id,confirmed_by,"
                        "confirmed_at,submitted_at) VALUES "
                        "(:batch_id,:run,:batch_no,:item,:demand,:version,:platform,:account,:mcn,"
                        ":price,:rebate,:availability,:gate,:confirmed_by,:confirmed_at,"
                        "CURRENT_TIMESTAMP(6))"
                    ),
                    {
                        "batch_id": submission_batch_id,
                        "run": run["run_id"],
                        "batch_no": batch_no,
                        "item": item["item_id"],
                        "demand": run["demand_id"],
                        "version": run["demand_version"],
                        "platform": item["platform"],
                        "account": item["platform_account_id"],
                        "mcn": item["mcn_id"],
                        "price": item["submitted_price_cents"],
                        "rebate": item["submitted_rebate_rate"],
                        "availability": item["availability_status"],
                        "gate": gate_id,
                        "confirmed_by": request.risk_confirmation.confirmed_by
                        if request.risk_confirmation
                        else None,
                        "confirmed_at": request.risk_confirmation.confirmed_at or datetime.now(UTC)
                        if request.risk_confirmation
                        else None,
                    },
                )
                submissions.append(
                    {
                        "submission_id": str(inserted.lastrowid),
                        "recommendation_item_id": str(item["item_id"]),
                        "platform": item["platform"],
                        "platform_account_id": item["platform_account_id"],
                        "submitted_price_cents": item["submitted_price_cents"],
                        "submitted_rebate_rate": as_float(item["submitted_rebate_rate"]),
                        "availability_status": item["availability_status"],
                        "recommend_reason": item["recommend_reason"],
                        "risk_notes": item["risk_notes"],
                    }
                )
            state = await self._set_workflow(
                connection,
                demand_id=str(run["demand_id"]),
                demand_version=run["demand_version"],
                phase="submission_batch_ready",
                current_version=state["state_version"],
                resolved_run_id=run["run_id"],
                resolved_batch_no=batch_no,
            )
        data = {
            "run_id": request.run_id,
            "submission_batch_id": str(submission_batch_id),
            "batch_no": batch_no,
            "submissions": submissions,
            "target_submission_count": target,
            "actual_submission_count": len(submissions),
            "snapshot": snapshot,
        }
        return ServiceResult(data, state, _ALLOWED_ACTIONS[state["phase"]])

    async def _ensure_creator_account(
        self,
        connection: AsyncConnection,
        *,
        platform: str,
        platform_account_id: str,
        account_nickname: str | None,
        profile_url: str | None,
        followers_count: int | None = None,
    ) -> None:
        table = creator_account_table(platform)
        account_id = "xhs_account_id" if platform == "xhs" else "dy_account_id"
        await connection.execute(
            text(
                f"INSERT INTO {table} ({account_id},account_nickname,profile_url,followers_count) "
                "VALUES (:account_id,:nickname,:profile_url,:followers) AS incoming "
                "ON DUPLICATE KEY UPDATE "
                f"account_nickname=COALESCE(incoming.account_nickname,{table}.account_nickname),"
                f"profile_url=COALESCE(incoming.profile_url,{table}.profile_url),"
                f"followers_count=COALESCE(incoming.followers_count,{table}.followers_count)"
            ),
            {
                "account_id": platform_account_id,
                "nickname": account_nickname,
                "profile_url": profile_url,
                "followers": followers_count,
            },
        )

    async def _upsert_offer(
        self,
        connection: AsyncConnection,
        *,
        platform: str,
        platform_account_id: str,
        mcn_id: str | None,
        price_cents: int,
        rebate_min_rate: float | None,
        rebate_max_rate: float | None,
        cooperation_type: str | None,
        content_format: str | None,
        availability_status: str | None,
        valid_until: date | None,
        manual_sourced: bool,
        source_channel: str | None,
        notes: str | None,
    ) -> tuple[int, bool]:
        cooperation = cooperation_type or "unknown"
        content = content_format or "mixed"
        existing = await connection.scalar(
            text(
                "SELECT offer_id FROM creator_supply_offers WHERE platform=:platform "
                "AND platform_account_id=:account AND mcn_id <=> :mcn "
                "AND cooperation_type=:cooperation AND content_format=:content "
                "ORDER BY offer_id DESC LIMIT 1 FOR UPDATE"
            ),
            {
                "platform": platform,
                "account": platform_account_id,
                "mcn": mcn_id,
                "cooperation": cooperation,
                "content": content,
            },
        )
        values = {
            "platform": platform,
            "account": platform_account_id,
            "mcn": mcn_id,
            "cooperation": cooperation,
            "content": content,
            "price": price_cents,
            "rebate_min": rebate_min_rate,
            "rebate_max": rebate_max_rate,
            "availability": availability_status or "need_confirm",
            "valid_until": valid_until,
            "manual": manual_sourced,
            "source_channel": source_channel or "unknown",
            "notes": notes,
        }
        if existing:
            await connection.execute(
                text(
                    "UPDATE creator_supply_offers SET price_cents=:price,"
                    "rebate_min_rate=:rebate_min,rebate_max_rate=:rebate_max,"
                    "availability_status=:availability,valid_until=:valid_until,"
                    "manual_sourced=:manual,source_channel=:source_channel,notes=:notes "
                    "WHERE offer_id=:offer_id"
                ),
                {**values, "offer_id": existing},
            )
            return int(existing), False
        result = await connection.execute(
            text(
                "INSERT INTO creator_supply_offers "
                "(platform,platform_account_id,mcn_id,cooperation_type,content_format,price_cents,"
                "rebate_min_rate,rebate_max_rate,availability_status,valid_until,manual_sourced,"
                "source_channel,notes) VALUES "
                "(:platform,:account,:mcn,:cooperation,:content,:price,:rebate_min,:rebate_max,"
                ":availability,:valid_until,:manual,:source_channel,:notes)"
            ),
            values,
        )
        return int(result.lastrowid), True

    async def _upsert_candidate(
        self,
        connection: AsyncConnection,
        *,
        demand_id: int,
        demand_version: int,
        platform: str,
        platform_account_id: str,
        offer_id: int | None,
        mcn_id: str | None,
        source: str,
        passed: bool,
        failed_reasons: list[str],
        source_detail: Mapping[str, Any],
        matched: Mapping[str, Any],
        risk_notes: list[str],
    ) -> tuple[int, bool]:
        existing = await connection.scalar(
            text(
                "SELECT candidate_id FROM creator_candidate_pool WHERE demand_id=:demand "
                "AND demand_version=:version AND platform=:platform AND platform_account_id=:account "
                "ORDER BY candidate_id LIMIT 1 FOR UPDATE"
            ),
            {
                "demand": demand_id,
                "version": demand_version,
                "platform": platform,
                "account": platform_account_id,
            },
        )
        values = {
            "demand": demand_id,
            "version": demand_version,
            "platform": platform,
            "account": platform_account_id,
            "offer": offer_id,
            "mcn": mcn_id,
            "source": source,
            "passed": passed,
            "failed": json_text(failed_reasons),
            "source_detail": json_text(source_detail),
            "matched": json_text(matched),
            "risk_notes": "; ".join(risk_notes) or None,
        }
        if existing:
            await connection.execute(
                text(
                    "UPDATE creator_candidate_pool SET offer_id=:offer,mcn_id=:mcn,"
                    "candidate_source=:source,source_detail_json=:source_detail,"
                    "hard_filter_passed=:passed,hard_filter_failed_reasons=:failed,"
                    "matched_json=:matched,risk_notes=:risk_notes WHERE candidate_id=:candidate"
                ),
                {**values, "candidate": existing},
            )
            return int(existing), False
        result = await connection.execute(
            text(
                "INSERT INTO creator_candidate_pool "
                "(demand_id,demand_version,platform,platform_account_id,offer_id,mcn_id,"
                "candidate_source,source_detail_json,hard_filter_passed,hard_filter_failed_reasons,"
                "matched_json,risk_notes) VALUES "
                "(:demand,:version,:platform,:account,:offer,:mcn,:source,:source_detail,"
                ":passed,:failed,:matched,:risk_notes)"
            ),
            values,
        )
        return int(result.lastrowid), True

    async def _account_categories(
        self,
        connection: AsyncConnection,
        platform: str,
        platform_account_id: str,
    ) -> tuple[list[str], date | None]:
        table = creator_account_table(platform)
        account_id = "xhs_account_id" if platform == "xhs" else "dy_account_id"
        result = await connection.execute(
            text(
                f"SELECT canonical_categories,data_updated_at FROM {table} "
                f"WHERE {account_id}=:account_id"
            ),
            {"account_id": platform_account_id},
        )
        row = result.mappings().one()
        return json_value(row["canonical_categories"], ["other"]), row["data_updated_at"]

    async def _ingest_mcn_submissions(
        self,
        request: IngestMcnSubmissionsRequest,
    ) -> ServiceResult:
        async with MySqlUnitOfWork(self._engine) as uow:
            connection = uow.require_connection()
            inquiry_result = await connection.execute(
                text("SELECT * FROM mcn_inquiries WHERE inquiry_id=:id FOR UPDATE"),
                {"id": int(request.inquiry_id)},
            )
            inquiry = inquiry_result.mappings().first()
            if inquiry is None:
                raise ToolFailure(ErrorCode.INQUIRY_NOT_FOUND, "MCN inquiry was not found")
            demand = await self._get_demand(
                connection,
                str(inquiry["demand_id"]),
                inquiry["demand_version"],
                for_update=True,
            )
            state = await self._workflow(
                connection,
                str(inquiry["demand_id"]),
                inquiry["demand_version"],
                for_update=True,
                fallback_status=demand["status"],
            )
            self._assert_phase(state, {"waiting_backend_inquiry", "candidate_pool_ready"})
            demand_filter = DemandFilter(
                platforms=json_value(demand["platforms"], []),
                budget_max_cents=demand["budget_max_cents"],
                rebate_min_rate=as_float(demand["rebate_min_rate"], 0),
                categories=json_value(demand["category_requirements"], []),
                filter_rules=json_value(demand["requirements_json"], {}).get("filter_rules", []),
            )
            accepted = []
            rejected = []
            created_offers = 0
            updated_offers = 0
            created_candidates = 0
            for index, item in enumerate(request.items):
                if item.submitted_rebate_rate is None:
                    rejected.append(
                        {"item_index": index, "invalid_reason": "submitted_rebate_rate is required"}
                    )
                    continue
                duplicate = await connection.scalar(
                    text(
                        "SELECT submission_item_id FROM mcn_submission_items WHERE inquiry_id=:inquiry "
                        "AND platform=:platform AND platform_account_id=:account "
                        "AND cooperation_type=:cooperation AND content_format=:content"
                    ),
                    {
                        "inquiry": inquiry["inquiry_id"],
                        "platform": item.platform,
                        "account": item.platform_account_id,
                        "cooperation": item.cooperation_type or "unknown",
                        "content": item.content_format or "mixed",
                    },
                )
                if duplicate:
                    rejected.append(
                        {"item_index": index, "invalid_reason": "duplicate creator submission"}
                    )
                    continue
                await self._ensure_creator_account(
                    connection,
                    platform=item.platform,
                    platform_account_id=item.platform_account_id,
                    account_nickname=item.account_nickname,
                    profile_url=item.profile_url,
                    followers_count=item.followers_count,
                )
                offer_id, created = await self._upsert_offer(
                    connection,
                    platform=item.platform,
                    platform_account_id=item.platform_account_id,
                    mcn_id=inquiry["mcn_id"],
                    price_cents=item.submitted_price_cents,
                    rebate_min_rate=item.submitted_rebate_rate,
                    rebate_max_rate=item.submitted_rebate_rate,
                    cooperation_type=item.cooperation_type,
                    content_format=item.content_format,
                    availability_status=item.availability_status,
                    valid_until=None,
                    manual_sourced=False,
                    source_channel="mcn_returned",
                    notes=item.notes,
                )
                created_offers += int(created)
                updated_offers += int(not created)
                categories, data_updated_at = await self._account_categories(
                    connection, item.platform, item.platform_account_id
                )
                evaluated = filter_candidate(
                    demand_filter,
                    CandidateInput(
                        platform=item.platform,
                        price_cents=item.submitted_price_cents,
                        rebate_rate=item.submitted_rebate_rate,
                        categories=categories,
                        valid_until=None,
                        data_updated_at=data_updated_at,
                        availability_status=item.availability_status or "need_confirm",
                        facts={
                            "cooperation_type": item.cooperation_type or "unknown",
                            "content_format": item.content_format or "mixed",
                            "followers_count": item.followers_count,
                        },
                    ),
                )
                submission_result = await connection.execute(
                    text(
                        "INSERT INTO mcn_submission_items "
                        "(inquiry_id,demand_id,demand_version,mcn_id,platform,platform_account_id,"
                        "offer_id,submitted_price_cents,submitted_rebate_rate,cooperation_type,"
                        "content_format,availability_status,authorization_status,validity_status,"
                        "invalid_reason,raw_payload_json,notes) VALUES "
                        "(:inquiry,:demand,:version,:mcn,:platform,:account,:offer,:price,:rebate,"
                        ":cooperation,:content,:availability,:authorization,:validity,:invalid,"
                        ":raw_payload,:notes)"
                    ),
                    {
                        "inquiry": inquiry["inquiry_id"],
                        "demand": inquiry["demand_id"],
                        "version": inquiry["demand_version"],
                        "mcn": inquiry["mcn_id"],
                        "platform": item.platform,
                        "account": item.platform_account_id,
                        "offer": offer_id,
                        "price": item.submitted_price_cents,
                        "rebate": item.submitted_rebate_rate,
                        "cooperation": item.cooperation_type or "unknown",
                        "content": item.content_format or "mixed",
                        "availability": item.availability_status or "need_confirm",
                        "authorization": item.authorization_status or "need_confirm",
                        "validity": "valid" if evaluated.passed else "invalid",
                        "invalid": None
                        if evaluated.passed
                        else "; ".join(evaluated.failed_reasons),
                        "raw_payload": json_text(
                            item.raw_payload_json or item.model_dump(mode="json")
                        ),
                        "notes": item.notes,
                    },
                )
                candidate_id = None
                if evaluated.passed:
                    candidate_id, candidate_created = await self._upsert_candidate(
                        connection,
                        demand_id=inquiry["demand_id"],
                        demand_version=inquiry["demand_version"],
                        platform=item.platform,
                        platform_account_id=item.platform_account_id,
                        offer_id=offer_id,
                        mcn_id=inquiry["mcn_id"],
                        source="mcn_returned",
                        passed=True,
                        failed_reasons=[],
                        source_detail={"inquiry_id": request.inquiry_id},
                        matched={"score_detail": {"risk_penalty": evaluated.risk_penalty}},
                        risk_notes=evaluated.risk_notes,
                    )
                    created_candidates += int(candidate_created)
                accepted.append(
                    {
                        "submission_item_id": str(submission_result.lastrowid),
                        "validity_status": "valid" if evaluated.passed else "invalid",
                        "candidate_id": str(candidate_id) if candidate_id else None,
                    }
                )
            await connection.execute(
                text(
                    "UPDATE mcn_inquiries SET response_status='submitted',"
                    "returned_count=:returned,valid_returned_count=:valid,"
                    "invalid_returned_count=:invalid,submitted_at=CURRENT_TIMESTAMP(6),"
                    "response_at=CURRENT_TIMESTAMP(6) WHERE inquiry_id=:inquiry"
                ),
                {
                    "returned": len(request.items),
                    "valid": sum(item["validity_status"] == "valid" for item in accepted),
                    "invalid": len(rejected)
                    + sum(item["validity_status"] == "invalid" for item in accepted),
                    "inquiry": inquiry["inquiry_id"],
                },
            )
            state = await self._set_workflow(
                connection,
                demand_id=str(inquiry["demand_id"]),
                demand_version=inquiry["demand_version"],
                phase="candidate_pool_ready",
                current_version=state["state_version"],
            )
        data = {
            "accepted_items": accepted,
            "rejected_items": rejected,
            "summary": {
                "returned_count": len(request.items),
                "valid_returned_count": sum(
                    item["validity_status"] == "valid" for item in accepted
                ),
                "invalid_returned_count": len(rejected)
                + sum(item["validity_status"] == "invalid" for item in accepted),
                "created_offer_count": created_offers,
                "updated_offer_count": updated_offers,
                "created_candidate_count": created_candidates,
            },
        }
        return ServiceResult(data, state, _ALLOWED_ACTIONS[state["phase"]])

    @staticmethod
    def _manual_offer_error(offer: Any) -> str | None:
        if offer is None:
            return None
        if offer.price_cents < 0:
            return "price_cents must be non-negative"
        for field in ("rebate_min_rate", "rebate_max_rate"):
            value = getattr(offer, field)
            if value is not None and not 0 <= value <= 1:
                return f"{field} must be between 0 and 1"
        if (
            offer.rebate_min_rate is not None
            and offer.rebate_max_rate is not None
            and offer.rebate_max_rate < offer.rebate_min_rate
        ):
            return "rebate_max_rate cannot be lower than rebate_min_rate"
        return None

    async def _manual_source_creators(
        self,
        request: ManualSourceCreatorsRequest,
    ) -> ServiceResult:
        if not request.manual_results:
            raise ToolFailure(ErrorCode.MISSING_MANUAL_RESULTS, "manual_results cannot be empty")
        async with MySqlUnitOfWork(self._engine) as uow:
            connection = uow.require_connection()
            demand = await self._get_demand(
                connection,
                request.demand_id,
                request.demand_version,
                for_update=True,
            )
            state = await self._workflow(
                connection,
                request.demand_id,
                request.demand_version,
                for_update=True,
                fallback_status=demand["status"],
            )
            self._assert_phase(
                state,
                {"candidate_pool_ready", "waiting_backend_inquiry", "recommendation_ready"},
            )
            demand_filter = DemandFilter(
                platforms=json_value(demand["platforms"], []),
                budget_max_cents=demand["budget_max_cents"],
                rebate_min_rate=as_float(demand["rebate_min_rate"], 0),
                categories=json_value(demand["category_requirements"], []),
                filter_rules=json_value(demand["requirements_json"], {}).get("filter_rules", []),
            )
            imported = duplicate_count = created_offers = candidate_count = 0
            items = []
            rejected_items = []
            for index, item in enumerate(request.manual_results):
                offer_error = self._manual_offer_error(item.offer)
                if offer_error:
                    rejected_items.append({"item_index": index, "invalid_reason": offer_error})
                    continue
                await self._ensure_creator_account(
                    connection,
                    platform=item.platform,
                    platform_account_id=item.platform_account_id,
                    account_nickname=item.account_nickname,
                    profile_url=item.profile_url,
                )
                offer_id = None
                if item.offer is not None:
                    offer_id, created = await self._upsert_offer(
                        connection,
                        platform=item.platform,
                        platform_account_id=item.platform_account_id,
                        mcn_id=None,
                        price_cents=item.offer.price_cents,
                        rebate_min_rate=item.offer.rebate_min_rate,
                        rebate_max_rate=item.offer.rebate_max_rate,
                        cooperation_type=item.offer.cooperation_type,
                        content_format=item.offer.content_format,
                        availability_status=item.offer.availability_status,
                        valid_until=item.offer.valid_until.date()
                        if item.offer.valid_until
                        else None,
                        manual_sourced=True,
                        source_channel=item.source_channel,
                        notes=item.notes,
                    )
                    created_offers += int(created)
                categories, data_updated_at = await self._account_categories(
                    connection, item.platform, item.platform_account_id
                )
                if item.offer is None:
                    passed = False
                    failed_reasons = ["valid_offer_required_for_recommendation"]
                    risk_notes = []
                    risk_penalty = 0.0
                else:
                    evaluated = filter_candidate(
                        demand_filter,
                        CandidateInput(
                            platform=item.platform,
                            price_cents=item.offer.price_cents,
                            rebate_rate=item.offer.rebate_min_rate,
                            categories=categories,
                            valid_until=item.offer.valid_until.date()
                            if item.offer.valid_until
                            else None,
                            data_updated_at=data_updated_at,
                            availability_status=item.offer.availability_status or "need_confirm",
                            facts={
                                "cooperation_type": item.offer.cooperation_type or "unknown",
                                "content_format": item.offer.content_format or "mixed",
                            },
                        ),
                    )
                    passed = evaluated.passed
                    failed_reasons = evaluated.failed_reasons
                    risk_notes = evaluated.risk_notes
                    risk_penalty = evaluated.risk_penalty
                candidate_id, created_candidate = await self._upsert_candidate(
                    connection,
                    demand_id=int(request.demand_id),
                    demand_version=request.demand_version,
                    platform=item.platform,
                    platform_account_id=item.platform_account_id,
                    offer_id=offer_id,
                    mcn_id=None,
                    source="manual_search",
                    passed=passed,
                    failed_reasons=failed_reasons,
                    source_detail={
                        "source_channel": item.source_channel,
                        "source_keyword": item.source_keyword,
                        "search_context": request.search_context.model_dump(mode="json")
                        if request.search_context
                        else None,
                    },
                    matched={"score_detail": {"risk_penalty": risk_penalty}},
                    risk_notes=risk_notes,
                )
                candidate_count += int(created_candidate)
                duplicate_count += int(not created_candidate)
                imported += 1
                items.append(
                    {
                        "candidate_id": str(candidate_id),
                        "offer_id": str(offer_id) if offer_id else None,
                        "recommendation_eligible": passed and offer_id is not None,
                        "initial_run_eligible": False,
                        "duplicate_with_mcn_offer": False,
                        "failed_reasons": failed_reasons,
                    }
                )
            state = await self._set_workflow(
                connection,
                demand_id=request.demand_id,
                demand_version=request.demand_version,
                phase=state["phase"],
                current_version=state["state_version"],
            )
        data = {
            "import_summary": {
                "imported_count": imported,
                "rejected_count": len(rejected_items),
                "duplicate_count": duplicate_count,
                "created_offer_count": created_offers,
                "candidate_created_count": candidate_count,
                "excluded_from_initial_run_count": imported,
            },
            "items": items,
            "rejected_items": rejected_items,
        }
        return ServiceResult(data, state, _ALLOWED_ACTIONS[state["phase"]])

    async def _record_client_feedback(
        self,
        request: RecordClientFeedbackRequest,
    ) -> ServiceResult:
        async with MySqlUnitOfWork(self._engine) as uow:
            connection = uow.require_connection()
            run_result = await connection.execute(
                text("SELECT * FROM recommendation_runs WHERE run_id=:run FOR UPDATE"),
                {"run": int(request.run_id)},
            )
            run = run_result.mappings().first()
            if run is None:
                raise ToolFailure(ErrorCode.RUN_NOT_FOUND, "recommendation run was not found")
            demand = await self._get_demand(
                connection,
                str(run["demand_id"]),
                run["demand_version"],
                for_update=True,
            )
            state = await self._workflow(
                connection,
                str(run["demand_id"]),
                run["demand_version"],
                for_update=True,
                fallback_status=demand["status"],
            )
            self._assert_phase(state, {"submission_batch_ready"})
            summary: Counter[str] = Counter()
            feedback_preferences: dict[str, Any] = {"rejected_reasons": []}
            for feedback in request.feedback_items:
                submission = await connection.scalar(
                    text(
                        "SELECT submission_id FROM creator_submissions WHERE submission_id=:id "
                        "AND run_id=:run FOR UPDATE"
                    ),
                    {"id": int(feedback.submission_id), "run": int(request.run_id)},
                )
                if submission is None:
                    raise ToolFailure(
                        ErrorCode.SUBMISSION_NOT_FOUND,
                        "feedback references a submission outside this run",
                        detail={"submission_id": feedback.submission_id},
                    )
                await connection.execute(
                    text(
                        "UPDATE creator_submissions SET client_feedback_status=:status,"
                        "client_feedback_reason=:reason WHERE submission_id=:id"
                    ),
                    {
                        "status": feedback.client_feedback_status,
                        "reason": feedback.client_feedback_reason,
                        "id": int(feedback.submission_id),
                    },
                )
                summary[feedback.client_feedback_status] += 1
                if (
                    feedback.client_feedback_status == "rejected"
                    and feedback.client_feedback_reason
                ):
                    feedback_preferences["rejected_reasons"].append(feedback.client_feedback_reason)
            new_version = None
            core_changes = (
                request.requirement_changes.model_dump(exclude_none=True)
                if request.requirement_changes
                else {}
            )
            if core_changes:
                latest = int(
                    await connection.scalar(
                        text(
                            "SELECT MAX(demand_version) FROM customer_demands WHERE demand_id=:id"
                        ),
                        {"id": run["demand_id"]},
                    )
                )
                if latest != run["demand_version"]:
                    raise ToolFailure(
                        ErrorCode.VERSION_CONFLICT,
                        "a newer demand version already exists",
                        detail={"latest_demand_version": latest},
                    )
                new_version = latest + 1
                copied = {column: demand[column] for column in _DEMAND_COPY_COLUMNS}
                json_columns = {
                    "platforms",
                    "category_requirements",
                    "requirements_json",
                    "content_requirements",
                }
                for field, value in core_changes.items():
                    copied[field] = json_text(value) if field in json_columns else value
                column_sql = ",".join(_DEMAND_COPY_COLUMNS)
                value_sql = ",".join(f":{column}" for column in _DEMAND_COPY_COLUMNS)
                await connection.execute(
                    text(
                        "INSERT INTO customer_demands (demand_id,demand_version,"
                        f"{column_sql}) VALUES (:demand_id,:demand_version,{value_sql})"
                    ),
                    {
                        "demand_id": run["demand_id"],
                        "demand_version": new_version,
                        **copied,
                    },
                )
                state = await self._set_workflow(
                    connection,
                    demand_id=str(run["demand_id"]),
                    demand_version=new_version,
                    phase="requirement_ready",
                    current_version=0,
                )
                next_action = "rerun_after_requirement_change"
            else:
                total_selected = int(
                    await connection.scalar(
                        text(
                            "SELECT COUNT(*) FROM creator_submissions WHERE demand_id=:demand "
                            "AND demand_version=:version AND client_feedback_status='selected'"
                        ),
                        {"demand": run["demand_id"], "version": run["demand_version"]},
                    )
                )
                if total_selected >= demand["quantity_total"]:
                    next_action = "close_demand"
                    state = await self._set_workflow(
                        connection,
                        demand_id=str(run["demand_id"]),
                        demand_version=run["demand_version"],
                        phase="closed",
                        current_version=state["state_version"],
                        resolved_run_id=run["run_id"],
                    )
                elif summary["need_replace"] or summary["rejected"]:
                    next_action = "continue_next_batch"
                elif feedback_preferences["rejected_reasons"]:
                    next_action = "rerank_after_feedback"
                else:
                    next_action = "manual_review_required"
        data = {
            "updated_count": len(request.feedback_items),
            "feedback_summary": {
                "selected_count": summary["selected"],
                "rejected_count": summary["rejected"],
                "waitlist_count": summary["waitlist"],
                "need_replace_count": summary["need_replace"],
            },
            "next_action": next_action,
            "demand_id": str(run["demand_id"]),
            "new_demand_version": new_version,
            "feedback_preferences": feedback_preferences,
            "explain": "next action derived from versioned requirement and submission feedback",
        }
        return ServiceResult(data, state, _ALLOWED_ACTIONS[state["phase"]])

    async def _audit_manual_adjustment(
        self,
        request: AuditManualAdjustmentRequest,
    ) -> ServiceResult:
        async with MySqlUnitOfWork(self._engine) as uow:
            connection = uow.require_connection()
            run_result = await connection.execute(
                text("SELECT * FROM recommendation_runs WHERE run_id=:run FOR UPDATE"),
                {"run": int(request.run_id)},
            )
            run = run_result.mappings().first()
            if run is None:
                raise ToolFailure(ErrorCode.RUN_NOT_FOUND, "recommendation run was not found")
            demand = await self._get_demand(
                connection,
                str(run["demand_id"]),
                run["demand_version"],
            )
            state = await self._workflow(
                connection,
                str(run["demand_id"]),
                run["demand_version"],
                for_update=True,
                fallback_status=demand["status"],
            )
            self._assert_phase(state, {"recommendation_ready", "submission_batch_ready"})
            items_result = await connection.execute(
                text(
                    "SELECT * FROM creator_recommendation_items WHERE run_id=:run "
                    "ORDER BY rank_order FOR UPDATE"
                ),
                {"run": int(request.run_id)},
            )
            current_items = {int(row["item_id"]): dict(row) for row in items_result.mappings()}
            audit_records = []
            adjusted_items = []
            adjusted_at = datetime.now(UTC)
            for adjustment in request.adjustments:
                item_id = int(adjustment.recommendation_item_id)
                item = current_items.get(item_id)
                if item is None:
                    raise ToolFailure(
                        ErrorCode.NOT_FOUND,
                        "recommendation item was not found in the run",
                        detail={"recommendation_item_id": adjustment.recommendation_item_id},
                    )
                if adjustment.action == "force_add":
                    eligible = await connection.scalar(
                        text(
                            "SELECT COUNT(*) FROM creator_candidate_pool WHERE candidate_id=:candidate "
                            "AND hard_filter_passed=1 AND offer_id IS NOT NULL"
                        ),
                        {"candidate": item["candidate_id"]},
                    )
                    if not eligible:
                        raise ToolFailure(
                            ErrorCode.GATE_REQUIRED,
                            "force_add cannot bypass hard filters or offer validity",
                            detail={"required_gate": "authorize_relaxation"},
                        )
                before_rank = item["rank_order"]
                after_rank = adjustment.rank_order or before_rank
                status = "removed" if adjustment.action in {"remove", "replace"} else "approved"
                log = json_value(item["adjustment_log_json"], [])
                audit_id = uuid4().hex
                entry = {
                    "audit_id": audit_id,
                    "action": adjustment.action,
                    "operator_id": request.operator_id,
                    "reason": adjustment.reason,
                    "rank_order_before": before_rank,
                    "rank_order_after": after_rank,
                    "adjusted_at": rfc3339(adjusted_at),
                }
                log.append(entry)
                await connection.execute(
                    text(
                        "UPDATE creator_recommendation_items SET rank_order=:rank,review_status=:status,"
                        "human_adjustment_reason=:reason,adjustment_log_json=:log "
                        "WHERE item_id=:item"
                    ),
                    {
                        "rank": after_rank,
                        "status": status,
                        "reason": adjustment.reason,
                        "log": json_text(log),
                        "item": item_id,
                    },
                )
                item["rank_order"] = after_rank
                item["review_status"] = status
                audit_records.append(
                    {
                        "audit_id": audit_id,
                        "action": adjustment.action,
                        "operator_id": request.operator_id,
                        "adjusted_at": rfc3339(adjusted_at),
                    }
                )
                adjusted_items.append(
                    {
                        "recommendation_item_id": str(item_id),
                        "action": adjustment.action,
                        "rank_order_before": before_rank,
                        "rank_order_after": after_rank,
                    }
                )
            active = sorted(
                (item for item in current_items.values() if item["review_status"] != "removed"),
                key=lambda item: (item["rank_order"], item["item_id"]),
            )
            rank_map: dict[str, int] = {}
            for rank_order, item in enumerate(active, 1):
                await connection.execute(
                    text(
                        "UPDATE creator_recommendation_items SET rank_order=:rank WHERE item_id=:item"
                    ),
                    {"rank": rank_order, "item": item["item_id"]},
                )
                rank_map[str(item["item_id"])] = rank_order
            snapshot = {
                "run_id": request.run_id,
                "item_count": len(active),
                "rank_order_map": rank_map,
            }
            snapshot_hash = hashlib.sha256(json_text(snapshot).encode()).hexdigest()
        data = {
            "audit_records": audit_records,
            "adjusted_items": adjusted_items,
            "rank_order_snapshot": snapshot,
            "snapshot_hash": snapshot_hash,
            "written_count": len(audit_records),
        }
        return ServiceResult(data, state, _ALLOWED_ACTIONS[state["phase"]])

    async def _get_workflow_state(self, request: GetWorkflowStateRequest) -> ServiceResult:
        async with self._engine.connect() as connection:
            demand_id = request.demand_id
            demand_version = request.demand_version
            ledger_response = None
            if demand_id is None:
                conditions = ["trace_id=:trace_id"]
                params: dict[str, Any] = {"trace_id": request.trace_id}
                if request.idempotency_key:
                    conditions.append("idempotency_key=:idempotency_key")
                    params["idempotency_key"] = request.idempotency_key
                result = await connection.execute(
                    text(
                        "SELECT response_envelope_json FROM mcp_tool_call_ledger WHERE "
                        + " OR ".join(conditions)
                        + " ORDER BY call_id DESC LIMIT 1"
                    ),
                    params,
                )
                ledger_response = result.scalar_one_or_none()
                envelope = json_value(ledger_response, {})
                resolved_state = envelope.get("workflow_state") if envelope else None
                if resolved_state:
                    demand_id = resolved_state.get("demand_id")
                    demand_version = resolved_state.get("demand_version")
            if demand_id is None or demand_version is None:
                return ServiceResult(
                    {
                        "workflow_state": None,
                        "allowed_actions": [],
                        "known_facts": {},
                        "recent_errors": [],
                    },
                    None,
                    [],
                )
            demand_status = await connection.scalar(
                text(
                    "SELECT status FROM customer_demands "
                    "WHERE demand_id=:demand AND demand_version=:version"
                ),
                {"demand": int(demand_id), "version": demand_version},
            )
            state = await self._workflow(
                connection,
                demand_id,
                demand_version,
                fallback_status=demand_status,
            )
            gates_result = await connection.execute(
                text(
                    "SELECT gate_id,confirmation_type,confirmed_by,confirmed_at "
                    "FROM mcp_gate_confirmations WHERE demand_id=:demand AND demand_version=:version "
                    "ORDER BY confirmed_at"
                ),
                {"demand": int(demand_id), "version": demand_version},
            )
            gates = [
                {
                    "gate_id": row["gate_id"],
                    "confirmation_type": row["confirmation_type"],
                    "confirmed_by": row["confirmed_by"],
                    "confirmed_at": rfc3339(row["confirmed_at"]),
                }
                for row in gates_result.mappings()
            ]
            errors_result = await connection.execute(
                text(
                    "SELECT trace_id,error_code,completed_at FROM mcp_tool_call_ledger "
                    "WHERE status='failed' AND JSON_UNQUOTE(JSON_EXTRACT("
                    "response_envelope_json,'$.workflow_state.demand_id'))=:demand_id "
                    "ORDER BY call_id DESC LIMIT 10"
                ),
                {"demand_id": str(demand_id)},
            )
            recent_errors = [
                {
                    "trace_id": row["trace_id"],
                    "error_code": row["error_code"],
                    "completed_at": rfc3339(row["completed_at"]),
                }
                for row in errors_result.mappings()
            ]
        allowed = _ALLOWED_ACTIONS.get(state["phase"], [])
        data = {
            "workflow_state": state,
            "allowed_actions": allowed,
            "known_facts": {
                "confirmed_gates": gates,
                "resolved_demand_id": str(demand_id),
                "resolved_demand_version": demand_version,
                "resolved_run_id": state.get("resolved_run_id"),
                "resolved_batch_no": state.get("resolved_batch_no"),
                "resolved_platform_states": state.get("platform_states", {}),
            },
            "recent_errors": recent_errors,
        }
        return ServiceResult(data, state, allowed)

    async def _get_creator_detail(self, request: GetCreatorDetailRequest) -> ServiceResult:
        table = creator_account_table(request.platform)
        account_id = "xhs_account_id" if request.platform == "xhs" else "dy_account_id"
        async with self._engine.connect() as connection:
            result = await connection.execute(
                text(f"SELECT * FROM {table} WHERE {account_id}=:account_id"),
                {"account_id": request.platform_account_id},
            )
            row = result.mappings().first()
            if row is None:
                raise ToolFailure(ErrorCode.CREATOR_NOT_FOUND, "creator account was not found")
            creator = dict(row)
            creator["platform"] = request.platform
            creator["platform_account_id"] = creator.pop(account_id)
            creator["canonical_categories"] = json_value(
                creator.get("canonical_categories"), ["other"]
            )
            creator["data_updated_at"] = rfc3339(creator.get("data_updated_at"))
            if not request.include_vector_text:
                creator.pop("vector_text", None)
            offers = []
            if request.include_offers:
                offer_result = await connection.execute(
                    text(
                        "SELECT * FROM creator_supply_offers WHERE platform=:platform "
                        "AND platform_account_id=:account ORDER BY updated_at DESC"
                    ),
                    {"platform": request.platform, "account": request.platform_account_id},
                )
                for offer_row in offer_result.mappings():
                    offer = dict(offer_row)
                    offer["offer_id"] = str(offer["offer_id"])
                    offer["rebate_min_rate"] = as_float(offer["rebate_min_rate"])
                    offer["rebate_max_rate"] = as_float(offer["rebate_max_rate"])
                    offer["valid_from"] = rfc3339(offer["valid_from"])
                    offer["valid_until"] = rfc3339(offer["valid_until"])
                    offer["created_at"] = rfc3339(offer["created_at"])
                    offer["updated_at"] = rfc3339(offer["updated_at"])
                    offers.append(offer)
            creator["offers"] = offers
            if request.include_mcn:
                mcn_ids = sorted({offer["mcn_id"] for offer in offers if offer.get("mcn_id")})
                creator["mcn_ids"] = mcn_ids
            risk_notes = []
            updated = row["data_updated_at"]
            if updated and (date.today() - updated).days > 30:
                risk_notes.append("creator_data_stale_over_30_days")
            creator["risk_notes"] = risk_notes
        return ServiceResult({"creator": creator}, None, [])

    async def _get_recommendation_run_detail(
        self,
        request: GetRecommendationRunDetailRequest,
    ) -> ServiceResult:
        async with self._engine.connect() as connection:
            run_result = await connection.execute(
                text("SELECT * FROM recommendation_runs WHERE run_id=:run"),
                {"run": int(request.run_id)},
            )
            run_row = run_result.mappings().first()
            if run_row is None:
                raise ToolFailure(ErrorCode.RUN_NOT_FOUND, "recommendation run was not found")
            run = dict(run_row)
            run["run_id"] = str(run["run_id"])
            run["demand_id"] = str(run["demand_id"])
            for field in ("ranking_weights_json", "parameters_json"):
                run[field] = json_value(run[field], {})
            for field in ("candidate_pool_snapshot_at", "created_at", "finished_at"):
                run[field] = rfc3339(run[field])
            run["metric_snapshot_date"] = rfc3339(run["metric_snapshot_date"])
            item_result = await connection.execute(
                text(
                    "SELECT * FROM creator_recommendation_items WHERE run_id=:run ORDER BY rank_order"
                ),
                {"run": int(request.run_id)},
            )
            items = []
            for item_row in item_result.mappings():
                item = dict(item_row)
                for field in ("item_id", "candidate_id", "offer_id"):
                    item[field] = str(item[field])
                item["score_detail_json"] = json_value(item["score_detail_json"], {})
                item["adjustment_log_json"] = json_value(item["adjustment_log_json"], [])
                item["created_at"] = rfc3339(item["created_at"])
                item["updated_at"] = rfc3339(item["updated_at"])
                items.append(item)
            submissions_by_batch: dict[str, list[dict[str, Any]]] = defaultdict(list)
            if request.include_submissions:
                submission_result = await connection.execute(
                    text(
                        "SELECT * FROM creator_submissions WHERE run_id=:run "
                        "ORDER BY batch_no,submission_id"
                    ),
                    {"run": int(request.run_id)},
                )
                for submission_row in submission_result.mappings():
                    submission = dict(submission_row)
                    for field in ("submission_id", "recommendation_item_id"):
                        submission[field] = str(submission[field])
                    submission["submitted_at"] = rfc3339(submission["submitted_at"])
                    submission["created_at"] = rfc3339(submission["created_at"])
                    if not request.include_feedback:
                        submission.pop("client_feedback_status", None)
                        submission.pop("client_feedback_reason", None)
                    submissions_by_batch[str(submission["batch_no"])].append(submission)
            state = await self._workflow(
                connection,
                str(run_row["demand_id"]),
                run_row["demand_version"],
            )
        data = {
            "run": {**run, "items": items},
            "submissions": submissions_by_batch,
        }
        return ServiceResult(data, state, _ALLOWED_ACTIONS.get(state["phase"], []))

    async def create_mcn_inquiries(self, payload: Mapping[str, Any]) -> ResponseEnvelope:
        try:
            request = CreateMcnInquiriesRequest.model_validate(payload)
        except ValidationError as exc:
            return ResponseEnvelope.fail(
                ErrorCode.VALIDATION_ERROR,
                "request validation failed",
                trace_id=str(payload.get("trace_id") or uuid4().hex),
                detail={"errors": exc.errors(include_url=False)},
                idempotency_key=payload.get("idempotency_key"),
            )

        async def operation() -> dict[str, Any]:
            response = await self._invoke_internal_inquiries(request)
            return response.model_dump(mode="json")

        try:
            stored = await self._idempotency.execute(
                tool_name="create_mcn_inquiries",
                trace_id=request.trace_id,
                idempotency_key=request.idempotency_key,
                payload=request.model_dump(mode="json"),
                operation=operation,
            )
            return ResponseEnvelope.model_validate(stored)
        except (IdempotencyConflict, IdempotencyInProgress) as exc:
            return ResponseEnvelope.fail(
                ErrorCode.IDEMPOTENCY_CONFLICT,
                str(exc),
                trace_id=request.trace_id,
                idempotency_key=request.idempotency_key,
                retriable=isinstance(exc, IdempotencyInProgress),
            )

    async def _invoke_internal_inquiries(
        self,
        request: CreateMcnInquiriesRequest,
    ) -> ResponseEnvelope:
        try:
            async with MySqlUnitOfWork(self._engine) as uow:
                connection = uow.require_connection()
                demand = await self._get_demand(
                    connection,
                    request.demand_id,
                    request.demand_version,
                    for_update=True,
                )
                state = await self._workflow(
                    connection,
                    request.demand_id,
                    request.demand_version,
                    for_update=True,
                    fallback_status=demand["status"],
                )
                self._assert_phase(state, {"waiting_backend_inquiry"})
                confirmation = request.medium_risk_confirmation
                if state.get("pending_gate") == "supply_high_risk":
                    raise ToolFailure(
                        ErrorCode.SUPPLY_RISK_NOT_CONFIRMED,
                        "high-risk supply cannot send MCN inquiries",
                        detail={"supply_risk_level": "high_risk"},
                    )
                if state.get("pending_gate") == "confirm_medium_risk" and confirmation is None:
                    raise ToolFailure(
                        ErrorCode.GATE_REQUIRED,
                        "medium-risk inquiry requires media confirmation",
                        detail={"required_gate": "confirm_medium_risk"},
                    )
                gate_id = None
                if confirmation is not None:
                    if confirmation.confirmation_type != "confirm_medium_risk":
                        raise ToolFailure(
                            ErrorCode.GATE_REQUIRED,
                            "medium-risk confirmation has the wrong type",
                            detail={"required_gate": "confirm_medium_risk"},
                        )
                    gate_id = uuid4().hex
                    await connection.execute(
                        text(
                            "INSERT INTO mcp_gate_confirmations "
                            "(gate_id,demand_id,demand_version,confirmation_type,confirmed_by,"
                            "risk_notes,confirmation_payload_json,confirmed_at) VALUES "
                            "(:gate,:demand,:version,:type,:by,:notes,:payload,:at)"
                        ),
                        {
                            "gate": gate_id,
                            "demand": int(request.demand_id),
                            "version": request.demand_version,
                            "type": confirmation.confirmation_type,
                            "by": confirmation.confirmed_by,
                            "notes": confirmation.risk_notes,
                            "payload": json_text(confirmation.model_dump(mode="json")),
                            "at": confirmation.confirmed_at or datetime.now(UTC),
                        },
                    )
                inquiry_batch_id = uuid4().hex
                inquiries = []
                for mcn_id in request.mcn_ids:
                    result = await connection.execute(
                        text(
                            "SELECT item.item_id,agency.name AS agency_name "
                            "FROM mcn_recommendation_items item "
                            "JOIN core_supplier agency ON agency.id=item.mcn_id "
                            "WHERE item.demand_id=:demand AND item.demand_version=:version "
                            "AND item.platform=:platform AND item.mcn_id=:mcn "
                            "ORDER BY item.item_id DESC LIMIT 1 FOR UPDATE"
                        ),
                        {
                            "demand": int(request.demand_id),
                            "version": request.demand_version,
                            "platform": request.platform,
                            "mcn": mcn_id,
                        },
                    )
                    recommendation = result.mappings().first()
                    if recommendation is None:
                        raise ToolFailure(
                            ErrorCode.MCN_NOT_FOUND,
                            "MCN has no recommendation item in this demand run",
                            detail={"mcn_id": mcn_id},
                        )
                    candidate_ids = request.candidate_ids_by_mcn.get(mcn_id, [])
                    variables = {
                        "project_name": demand["project_name"] or "未命名项目",
                        "platform": request.platform,
                        "quantity_total": demand["quantity_total"],
                        "deadline_at": rfc3339(request.deadline_at),
                    }
                    message = (
                        f"【{variables['project_name']}】{request.platform} 达人询价："
                        f"需求 {demand['quantity_total']} 位，请按标准表单回填报价与返点。"
                    )
                    inserted = await connection.execute(
                        text(
                            "INSERT INTO mcn_inquiries "
                            "(inquiry_batch_id,demand_id,demand_version,mcn_id,"
                            "mcn_recommendation_item_id,gate_confirmation_id,confirmed_by,confirmed_at,"
                            "candidate_count_sent,candidate_ids_sent,sent_message,channel,deadline_at,"
                            "response_status,message_template_key,message_template_variables_json) VALUES "
                            "(:batch,:demand,:version,:mcn,:item,:gate,:confirmed_by,:confirmed_at,"
                            ":count,:candidate_ids,:message,:channel,:deadline,'not_sent',:template,"
                            ":variables)"
                        ),
                        {
                            "batch": inquiry_batch_id,
                            "demand": int(request.demand_id),
                            "version": request.demand_version,
                            "mcn": mcn_id,
                            "item": recommendation["item_id"],
                            "gate": gate_id,
                            "confirmed_by": confirmation.confirmed_by if confirmation else None,
                            "confirmed_at": confirmation.confirmed_at or datetime.now(UTC)
                            if confirmation
                            else None,
                            "count": len(candidate_ids),
                            "candidate_ids": json_text(candidate_ids),
                            "message": message,
                            "channel": request.channel,
                            "deadline": request.deadline_at,
                            "template": "mcn_inquiry_standard_v1",
                            "variables": json_text(variables),
                        },
                    )
                    inquiry_id = int(inserted.lastrowid)
                    fill_form_url = f"ypmcn://mcn-inquiries/{inquiry_id}"
                    await connection.execute(
                        text("UPDATE mcn_inquiries SET fill_form_url=:url WHERE inquiry_id=:id"),
                        {"url": fill_form_url, "id": inquiry_id},
                    )
                    await connection.execute(
                        text(
                            "INSERT INTO mcp_outbox "
                            "(aggregate_type,aggregate_id,event_type,payload_json) VALUES "
                            "('mcn_inquiry',:aggregate_id,'mcn.inquiry.created',:payload)"
                        ),
                        {
                            "aggregate_id": str(inquiry_id),
                            "payload": json_text(
                                {
                                    "inquiry_id": str(inquiry_id),
                                    "mcn_id": mcn_id,
                                    "channel": request.channel,
                                    "auto_send_requested": request.auto_send,
                                }
                            ),
                        },
                    )
                    inquiries.append(
                        {
                            "inquiry_id": str(inquiry_id),
                            "mcn_id": mcn_id,
                            "agency_name": recommendation["agency_name"],
                            "sent_message": message,
                            "fill_form_url": fill_form_url,
                            "response_status": "not_sent",
                        }
                    )
                state = await self._set_workflow(
                    connection,
                    demand_id=request.demand_id,
                    demand_version=request.demand_version,
                    phase="waiting_backend_inquiry",
                    current_version=state["state_version"],
                    pending_gate=None,
                )
            return ResponseEnvelope.ok(
                {
                    "inquiry_batch_id": inquiry_batch_id,
                    "inquiries": inquiries,
                    "created_count": len(inquiries),
                    "sent_count": 0,
                },
                trace_id=request.trace_id,
                workflow_state=state,
                allowed_actions=_ALLOWED_ACTIONS[state["phase"]],
                idempotency_key=request.idempotency_key,
            )
        except ToolFailure as exc:
            return ResponseEnvelope.fail(
                exc.code,
                exc.message,
                trace_id=request.trace_id,
                detail=exc.detail,
                retriable=exc.retriable,
                idempotency_key=request.idempotency_key,
            )
