from datetime import datetime
from typing import Annotated, Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

NonEmptyString = Annotated[str, Field(min_length=1)]
Identifier = NonEmptyString
Platform = Literal["xhs", "dy"]


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ReadRequest(RequestModel):
    trace_id: NonEmptyString


class WriteRequest(ReadRequest):
    idempotency_key: NonEmptyString


class RawMessage(RequestModel):
    role: Literal["client", "media", "agent", "system"]
    content: NonEmptyString
    sent_at: datetime | None = None


class ProjectContext(RequestModel):
    project_name: str | None = None
    brand: str | None = None
    product: str | None = None


class ParsedRequirement(RequestModel):
    """Host-extracted fields; every non-empty field requires exact source evidence."""

    platforms: list[Platform] = Field(default_factory=list)
    budget_min_cents: int | None = Field(default=None, ge=0)
    budget_max_cents: int | None = Field(default=None, ge=0)
    rebate_min_rate: float | None = Field(default=None, ge=0, le=1)
    rebate_max_rate: float | None = Field(default=None, ge=0, le=1)
    category_requirements: list[str] = Field(default_factory=list)
    quantity_total: int | None = Field(default=None, ge=1)
    content_formats: list[str] = Field(default_factory=list)
    cooperation_types: list[str] = Field(default_factory=list)
    creator_type_requirements: list[str] = Field(default_factory=list)
    creator_tier_requirements: list[str] = Field(default_factory=list)
    follower_min: int | None = Field(default=None, ge=0)
    follower_max: int | None = Field(default=None, ge=0)
    geo_requirements: dict[str, Any] = Field(default_factory=dict)
    audience_requirements: dict[str, Any] = Field(default_factory=dict)
    content_requirements: str | None = None
    tone_requirements: list[str] = Field(default_factory=list)
    negative_requirements: list[str] = Field(default_factory=list)
    requirements_json: dict[str, Any] = Field(default_factory=dict)
    confidence_map: dict[str, str] = Field(default_factory=dict)
    field_evidence: dict[str, Any] = Field(default_factory=dict)


class ValidateRequirementRequest(WriteRequest):
    raw_messages: list[RawMessage] = Field(min_length=1)
    parsed_requirement: ParsedRequirement
    project_context: ProjectContext | None = None
    existing_demand_id: Identifier | None = None
    existing_demand_version: int | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def validate_existing_version_pair(self) -> Self:
        if (self.existing_demand_id is None) != (self.existing_demand_version is None):
            raise ValueError(
                "existing_demand_id and existing_demand_version must be provided together"
            )
        return self


class AuthorizedRelaxation(RequestModel):
    field: NonEmptyString
    reason: NonEmptyString
    operator_id: NonEmptyString


class SearchCreatorsRequest(WriteRequest):
    demand_id: Identifier
    demand_version: int = Field(ge=1)
    authorized_relaxations: list[AuthorizedRelaxation] = Field(default_factory=list)
    write_candidate_pool: bool = True
    limit: int = Field(ge=1, le=5000)


class GateConfirmation(RequestModel):
    confirmation_type: Literal["confirm_medium_risk", "confirm_risky_submission"]
    confirmed_by: NonEmptyString
    risk_notes: NonEmptyString
    confirmed_at: datetime | None = None


class RankMcnsRequest(WriteRequest):
    demand_id: Identifier
    demand_version: int = Field(ge=1)
    platform: Platform
    minimum_mcn_count: int = Field(default=5, ge=1)
    target_multiplier: float = Field(default=20, gt=0)
    buffer_rate: float = Field(default=0.1, ge=0, le=1)
    medium_risk_confirmation: GateConfirmation | None = None
    limit: int = Field(default=20, ge=5, le=100)
    write_mcn_recommendation_items: bool = True


class RankingWeights(RequestModel):
    content_match_score: float = Field(ge=0, le=1)
    price_score: float = Field(ge=0, le=1)
    rebate_score: float = Field(ge=0, le=1)
    audience_score: float = Field(ge=0, le=1)
    data_score: float = Field(ge=0, le=1)
    mcn_score: float = Field(ge=0, le=1)

    @model_validator(mode="after")
    def validate_sum(self) -> Self:
        if abs(sum(self.model_dump().values()) - 1.0) > 1e-9:
            raise ValueError("ranking weights must sum to 1")
        return self


class RankCreatorsRequest(WriteRequest):
    demand_id: Identifier
    demand_version: int = Field(ge=1)
    ranking_strategy: Literal["default", "price_first", "content_first", "rebate_first", "manual"]
    run_type: Literal["initial", "rerun_after_requirement_change", "rerank_after_feedback"] = (
        "initial"
    )
    candidate_ids: list[Identifier] | None = None
    ranking_weights: RankingWeights | None = None
    feedback_preferences: dict[str, Any] | None = None
    exclude_submitted: bool = True
    allow_manual_sourced_in_initial_run: bool = False
    source_priority: list[
        Literal[
            "mcn_returned",
            "rate_card",
            "manual_search",
            "similar_creator",
            "historical_selected",
        ]
    ] = Field(
        default_factory=lambda: [
            "mcn_returned",
            "rate_card",
            "manual_search",
            "similar_creator",
            "historical_selected",
        ]
    )
    limit: int = Field(ge=1, le=1000)
    write_recommendation_items: bool = True

    @model_validator(mode="after")
    def validate_manual_weights(self) -> Self:
        if (self.ranking_strategy == "manual") != (self.ranking_weights is not None):
            raise ValueError("ranking_weights must be provided only for manual strategy")
        return self


class CreateSubmissionBatchRequest(WriteRequest):
    run_id: Identifier
    target_submission_count: int | None = Field(default=None, ge=1)
    recommendation_item_ids: list[Identifier] | None = None
    exclude_submitted: bool = True
    risk_confirmation: GateConfirmation | None = None
    created_by: NonEmptyString = "agent"


class McnSubmissionItem(RequestModel):
    platform: Platform
    platform_account_id: Identifier
    submitted_price_cents: int = Field(ge=0)
    submitted_rebate_rate: float | None = Field(default=None, ge=0, le=1)
    account_nickname: str | None = None
    profile_url: str | None = None
    followers_count: int | None = Field(default=None, ge=0)
    cooperation_type: str | None = None
    content_format: str | None = None
    availability_status: str | None = None
    authorization_status: str | None = None
    raw_payload_json: dict[str, Any] | None = None
    notes: str | None = None


class IngestMcnSubmissionsRequest(WriteRequest):
    inquiry_id: Identifier
    items: list[McnSubmissionItem]


class ManualOffer(RequestModel):
    # Offer validity is intentionally checked per item by the application service so one bad
    # manually sourced offer does not reject otherwise valid items in the same request.
    price_cents: int
    rebate_min_rate: float | None = None
    rebate_max_rate: float | None = None
    cooperation_type: str | None = None
    content_format: str | None = None
    availability_status: str | None = None
    valid_until: datetime | None = None


class ManualResult(RequestModel):
    platform: Platform
    platform_account_id: Identifier
    account_nickname: str | None = None
    profile_url: str | None = None
    source_channel: str | None = None
    source_keyword: str | None = None
    notes: str | None = None
    offer: ManualOffer | None = None


class SearchContext(RequestModel):
    search_method: str | None = None
    keywords: list[str] = Field(default_factory=list)
    similar_creators: list[str] = Field(default_factory=list)
    operator_id: str | None = None
    sourced_at: datetime | None = None


class ManualSourceCreatorsRequest(WriteRequest):
    demand_id: Identifier
    demand_version: int = Field(ge=1)
    search_context: SearchContext | None = None
    manual_results: list[ManualResult]


class FeedbackItem(RequestModel):
    submission_id: Identifier
    client_feedback_status: Literal["pending", "selected", "rejected", "waitlist", "need_replace"]
    client_feedback_reason: str | None = None


class RequirementChanges(RequestModel):
    platforms: list[Platform] | None = None
    budget_min_cents: int | None = Field(default=None, ge=0)
    budget_max_cents: int | None = Field(default=None, ge=0)
    rebate_min_rate: float | None = Field(default=None, ge=0, le=1)
    category_requirements: list[str] | None = None
    quantity_total: int | None = Field(default=None, ge=1)
    content_requirements: dict[str, Any] | None = None


class RecordClientFeedbackRequest(WriteRequest):
    run_id: Identifier
    feedback_items: list[FeedbackItem]
    requirement_changes: RequirementChanges | None = None


class ManualAdjustment(RequestModel):
    action: Literal["remove", "replace", "force_add", "rerank"]
    recommendation_item_id: Identifier
    platform: Platform
    platform_account_id: Identifier
    original_rank: int | None = Field(default=None, ge=1)
    rank_order: int | None = Field(default=None, ge=1)
    reason: NonEmptyString


class AuditManualAdjustmentRequest(WriteRequest):
    run_id: Identifier
    adjustments: list[ManualAdjustment]
    operator_id: NonEmptyString


class GetWorkflowStateRequest(ReadRequest):
    demand_id: Identifier | None = None
    demand_version: int | None = Field(default=None, ge=1)
    idempotency_key: str | None = None

    @model_validator(mode="after")
    def validate_lookup(self) -> Self:
        has_demand = self.demand_id is not None or self.demand_version is not None
        if has_demand and (self.demand_id is None or self.demand_version is None):
            raise ValueError("demand_id and demand_version must be provided together")
        if not has_demand and not self.trace_id and not self.idempotency_key:
            raise ValueError("a workflow lookup key is required")
        return self


class GetCreatorDetailRequest(ReadRequest):
    platform: Platform
    platform_account_id: Identifier
    include_offers: bool = True
    include_mcn: bool = True
    include_vector_text: bool = False
    include_recent_metrics: bool = True


class GetRecommendationRunDetailRequest(ReadRequest):
    run_id: Identifier
    include_submissions: bool = True
    include_creator_detail: bool = False
    include_feedback: bool = True


class CreateMcnInquiriesRequest(WriteRequest):
    demand_id: Identifier
    demand_version: int = Field(ge=1)
    platform: Platform
    mcn_ids: list[Identifier] = Field(min_length=1)
    medium_risk_confirmation: GateConfirmation | None = None
    candidate_ids_by_mcn: dict[str, list[Identifier]] = Field(default_factory=dict)
    deadline_at: datetime | None = None
    channel: Literal["wecom"] = "wecom"
    message_style: Literal["standard"] = "standard"
    auto_send: bool = False
