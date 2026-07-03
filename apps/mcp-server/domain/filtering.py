from datetime import UTC, date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class DemandFilter(BaseModel):
    model_config = ConfigDict(extra="forbid")

    platforms: list[Literal["xhs", "dy"]]
    budget_max_cents: int
    rebate_min_rate: float
    categories: list[str]
    authorized_relaxations: set[str] = Field(default_factory=set)
    filter_rules: list[dict[str, Any]] = Field(default_factory=list)


class CandidateInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    platform: Literal["xhs", "dy"]
    price_cents: int | None
    rebate_rate: float | None
    categories: list[str]
    valid_until: date | None
    data_updated_at: datetime | date | None = None
    availability_status: str = "need_confirm"
    facts: dict[str, Any] = Field(default_factory=dict)


class FilterResult(BaseModel):
    passed: bool
    failed_reasons: list[str]
    risk_notes: list[str]
    risk_penalty: float


def _matches_rule(actual: Any, operator: str, expected: Any) -> bool:
    if operator == "eq":
        return actual == expected
    if operator == "ne":
        return actual != expected
    if operator == "in":
        expected_values = expected if isinstance(expected, list) else [expected]
        return actual in expected_values
    if operator == "not_in":
        expected_values = expected if isinstance(expected, list) else [expected]
        return actual not in expected_values
    if operator == "gte":
        return actual is not None and actual >= expected
    if operator == "lte":
        return actual is not None and actual <= expected
    if operator == "between":
        return (
            actual is not None
            and isinstance(expected, list)
            and len(expected) == 2
            and expected[0] <= actual <= expected[1]
        )
    if operator == "contains":
        return actual is not None and expected in actual
    if operator == "intersects":
        actual_values = actual if isinstance(actual, list) else [actual]
        expected_values = expected if isinstance(expected, list) else [expected]
        return bool(set(actual_values).intersection(expected_values))
    raise ValueError(f"unsupported filter operator: {operator}")


def filter_candidate(demand: DemandFilter, candidate: CandidateInput) -> FilterResult:
    failed: list[str] = []
    risks: list[str] = []
    relaxed = demand.authorized_relaxations
    if candidate.platform not in demand.platforms and "platform" not in relaxed:
        failed.append("platform_mismatch")
    category_matches = set(candidate.categories).intersection(demand.categories)
    if not category_matches and "categories" not in relaxed:
        failed.append("category_mismatch")
    if candidate.price_cents is None:
        failed.append("price_missing")
    elif candidate.price_cents > demand.budget_max_cents and "price_cents" not in relaxed:
        failed.append("over_budget")
    if candidate.rebate_rate is None:
        failed.append("rebate_missing")
    elif candidate.rebate_rate < demand.rebate_min_rate and "rebate_rate" not in relaxed:
        failed.append("rebate_below_minimum")
    facts = {
        "platform": candidate.platform,
        "categories": candidate.categories,
        "price_cents": candidate.price_cents,
        "rebate_rate": candidate.rebate_rate,
        "availability_status": candidate.availability_status,
        **candidate.facts,
    }
    for rule in demand.filter_rules:
        if rule.get("mode") != "hard":
            continue
        field = rule["field"]
        if field in relaxed:
            continue
        if not _matches_rule(facts.get(field), rule["operator"], rule.get("value")):
            failed.append(f"filter_rule_mismatch:{field}")
    if candidate.valid_until is None:
        risks.append("offer_validity_need_confirm")
    elif candidate.valid_until < date.today():
        failed.append("offer_expired")

    penalty = 0.0
    if candidate.data_updated_at is not None:
        updated = candidate.data_updated_at
        if isinstance(updated, datetime):
            if updated.tzinfo is None:
                updated = updated.replace(tzinfo=UTC)
            updated_date = updated.date()
        else:
            updated_date = updated
        if (date.today() - updated_date).days > 30:
            penalty = 15.0
            risks.append("creator_data_stale_over_30_days")
    return FilterResult(
        passed=not failed,
        failed_reasons=failed,
        risk_notes=risks,
        risk_penalty=penalty,
    )


class SupplyAssessment(BaseModel):
    candidate_count: int
    quantity_total: int
    supply_multiplier: float
    risk_level: Literal["high_risk", "medium_risk", "low_risk"]
    should_expand_mcn_scope: bool
    should_start_manual_sourcing: bool


def supply_assessment(*, candidate_count: int, quantity_total: int) -> SupplyAssessment:
    if candidate_count < 0 or quantity_total <= 0:
        raise ValueError("candidate_count must be non-negative and quantity_total must be positive")
    multiplier = candidate_count / quantity_total
    if multiplier < 10:
        risk = "high_risk"
    elif multiplier < 20:
        risk = "medium_risk"
    else:
        risk = "low_risk"
    return SupplyAssessment(
        candidate_count=candidate_count,
        quantity_total=quantity_total,
        supply_multiplier=multiplier,
        risk_level=risk,
        should_expand_mcn_scope=risk != "low_risk",
        should_start_manual_sourcing=risk == "high_risk",
    )
