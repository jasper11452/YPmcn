import pytest
from domain.scoring import (
    DEFAULT_RANKING_WEIGHTS,
    audience_score,
    content_score,
    creator_final_score,
    data_percentile_score,
    mcn_rating_score,
    price_score,
    rebate_score,
)


def test_content_score_reweights_missing_components() -> None:
    assert content_score(tag=80, keyword=None, vector=60) == pytest.approx(71.428571, rel=1e-5)


def test_price_and_rebate_scores_are_linear_in_valid_range() -> None:
    assert price_score(price_cents=150, budget_min_cents=100, budget_max_cents=200) == 50
    assert rebate_score(rate=0.6, minimum=0.2, maximum=1.0) == 50


def test_audience_and_data_scores_have_neutral_empty_defaults() -> None:
    assert audience_score([]) == 50
    assert audience_score([100, 50, 0]) == 50
    assert data_percentile_score([]) == 50
    assert data_percentile_score([(20, [10, 20, 30, 40])]) == 50


def test_mcn_rating_uses_fixed_formula_and_missing_values_are_neutral() -> None:
    assert mcn_rating_score(policy=100, project_feedback=None, settlement=0) == 65


def test_final_score_applies_only_explicit_penalty_and_never_goes_negative() -> None:
    scores = {
        "content_match_score": 100,
        "price_score": 100,
        "rebate_score": 100,
        "audience_score": 100,
        "data_score": 100,
        "mcn_score": 100,
    }
    result = creator_final_score(scores, DEFAULT_RANKING_WEIGHTS, risk_penalty=115)

    assert result.raw_score == 100
    assert result.applied_penalty == 100
    assert result.final_score == 0
