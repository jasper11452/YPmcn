import pytest
from filters.hard_filter import hard_filter_passed
from filters.soft_filter import weighted_preference_score
from ranking_strategies import RankingStrategy, rank_items
from scoring.creator_score import creator_score
from scoring.mcn_score import mcn_score
from scoring.risk_penalty import apply_risk_penalty, risk_penalty
from supply_assessment import assess_supply


def test_creator_score_matches_weighted_formula() -> None:
    score = creator_score(content=1, price=0.5, rebate=0.4, fit=0.8, delivery=0.9)

    assert score == pytest.approx(0.755)


def test_mcn_score_matches_weighted_formula() -> None:
    assert mcn_score(count=0.5, rebate=0.8, rating=0.9) == pytest.approx(0.79)


def test_risk_penalty_is_bounded_and_subtracted() -> None:
    penalty = risk_penalty(data_gap=1, price_volatility=0.5, delivery_risk=0)

    assert penalty == pytest.approx(0.55)
    assert apply_risk_penalty(0.8, penalty) == pytest.approx(0.25)


def test_filters_require_all_hard_rules_and_weight_soft_rules() -> None:
    assert hard_filter_passed(True, True, True) is True
    assert hard_filter_passed(True, False, True) is False
    assert weighted_preference_score([(1, 0.7), (0.5, 0.3)]) == pytest.approx(0.85)


def test_supply_assessment_flags_thin_supply() -> None:
    assessment = assess_supply(available_count=4, required_count=10)

    assert assessment.multiplier == pytest.approx(0.4)
    assert assessment.high_risk is True


def test_price_first_strategy_changes_order() -> None:
    items = [
        {"id": "content", "score": 0.9, "price_score": 0.2, "content_score": 1.0},
        {"id": "price", "score": 0.7, "price_score": 1.0, "content_score": 0.4},
    ]

    ranked = rank_items(items, RankingStrategy.PRICE_FIRST)

    assert [item["id"] for item in ranked] == ["price", "content"]


def test_normalized_inputs_are_validated() -> None:
    with pytest.raises(ValueError):
        creator_score(content=1.1, price=0.5, rebate=0.4, fit=0.8, delivery=0.9)
