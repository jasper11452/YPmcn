from datetime import UTC, date, datetime, timedelta

from domain.filtering import CandidateInput, DemandFilter, filter_candidate, supply_assessment


def test_expired_offer_is_rejected_but_unknown_expiry_needs_confirmation() -> None:
    demand = DemandFilter(
        platforms=["xhs"],
        budget_max_cents=100_000,
        rebate_min_rate=0.2,
        categories=["beauty"],
    )
    expired = CandidateInput(
        platform="xhs",
        price_cents=90_000,
        rebate_rate=0.3,
        categories=["beauty"],
        valid_until=date.today() - timedelta(days=1),
    )
    unknown = expired.model_copy(update={"valid_until": None})

    assert "offer_expired" in filter_candidate(demand, expired).failed_reasons
    assert filter_candidate(demand, unknown).passed is True
    assert "offer_validity_need_confirm" in filter_candidate(demand, unknown).risk_notes


def test_stale_data_gets_fifteen_point_penalty_without_rejection() -> None:
    demand = DemandFilter(
        platforms=["dy"],
        budget_max_cents=100_000,
        rebate_min_rate=0.2,
        categories=["other"],
    )
    candidate = CandidateInput(
        platform="dy",
        price_cents=80_000,
        rebate_rate=0.3,
        categories=["other"],
        valid_until=date.today() + timedelta(days=10),
        data_updated_at=datetime.now(UTC) - timedelta(days=31),
    )

    result = filter_candidate(demand, candidate)

    assert result.passed is True
    assert result.risk_penalty == 15


def test_supply_risk_uses_multiplier_not_absolute_candidate_count() -> None:
    assert supply_assessment(candidate_count=18, quantity_total=1).risk_level == "medium_risk"
    assert supply_assessment(candidate_count=18, quantity_total=2).risk_level == "high_risk"


def test_hard_filter_rule_is_enforced_without_authorized_relaxation() -> None:
    demand = DemandFilter(
        platforms=["xhs"],
        budget_max_cents=100_000,
        rebate_min_rate=0.2,
        categories=["beauty"],
        filter_rules=[
            {"field": "creator_type", "operator": "in", "value": ["koc"], "mode": "hard"}
        ],
    )
    candidate = CandidateInput(
        platform="xhs",
        price_cents=90_000,
        rebate_rate=0.3,
        categories=["beauty"],
        valid_until=date.today() + timedelta(days=1),
        facts={"creator_type": "kol"},
    )

    result = filter_candidate(demand, candidate)

    assert result.passed is False
    assert "filter_rule_mismatch:creator_type" in result.failed_reasons
