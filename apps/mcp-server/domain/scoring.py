from collections.abc import Mapping
from dataclasses import dataclass
from statistics import fmean

DEFAULT_RANKING_WEIGHTS = {
    "content_match_score": 0.30,
    "price_score": 0.20,
    "rebate_score": 0.15,
    "audience_score": 0.15,
    "data_score": 0.10,
    "mcn_score": 0.10,
}

RANKING_WEIGHTS = {
    "default": DEFAULT_RANKING_WEIGHTS,
    "price_first": {
        "content_match_score": 0.20,
        "price_score": 0.30,
        "rebate_score": 0.15,
        "audience_score": 0.15,
        "data_score": 0.10,
        "mcn_score": 0.10,
    },
    "content_first": {
        "content_match_score": 0.40,
        "price_score": 0.15,
        "rebate_score": 0.10,
        "audience_score": 0.15,
        "data_score": 0.10,
        "mcn_score": 0.10,
    },
    "rebate_first": {
        "content_match_score": 0.20,
        "price_score": 0.15,
        "rebate_score": 0.40,
        "audience_score": 0.10,
        "data_score": 0.05,
        "mcn_score": 0.10,
    },
}


def _clamp(value: float) -> float:
    return min(100.0, max(0.0, float(value)))


def content_score(*, tag: float | None, keyword: float | None, vector: float | None) -> float:
    components = ((tag, 0.40), (keyword, 0.30), (vector, 0.30))
    available = [(value, weight) for value, weight in components if value is not None]
    if not available:
        return 50.0
    total_weight = sum(weight for _, weight in available)
    return sum(_clamp(value) * weight for value, weight in available) / total_weight


def price_score(*, price_cents: int, budget_min_cents: int | None, budget_max_cents: int) -> float:
    minimum = 0 if budget_min_cents is None else budget_min_cents
    if budget_max_cents <= minimum:
        return 100.0 if price_cents <= budget_max_cents else 0.0
    score = _clamp((budget_max_cents - price_cents) / (budget_max_cents - minimum) * 100)
    return round(score, 6)


def rebate_score(*, rate: float, minimum: float, maximum: float = 1.0) -> float:
    if maximum <= minimum:
        return 100.0 if rate >= minimum else 0.0
    score = _clamp((rate - minimum) / (maximum - minimum) * 100)
    return round(score, 6)


def audience_score(declared_matches: list[float]) -> float:
    if not declared_matches:
        return 50.0
    return _clamp(fmean(_clamp(value) for value in declared_matches))


def data_percentile_score(metrics: list[tuple[float, list[float]]]) -> float:
    percentiles: list[float] = []
    for value, population in metrics:
        valid = [float(item) for item in population if item is not None]
        if not valid:
            continue
        percentiles.append(sum(item <= value for item in valid) / len(valid) * 100)
    return _clamp(fmean(percentiles)) if percentiles else 50.0


def mcn_rating_score(
    *,
    policy: float | None,
    project_feedback: float | None,
    settlement: float | None,
) -> float:
    return (
        _clamp(50 if policy is None else policy) * 0.50
        + _clamp(50 if project_feedback is None else project_feedback) * 0.30
        + _clamp(50 if settlement is None else settlement) * 0.20
    )


@dataclass(frozen=True, slots=True)
class FinalScore:
    raw_score: float
    risk_penalty: float
    applied_penalty: float
    final_score: float


def creator_final_score(
    scores: Mapping[str, float],
    weights: Mapping[str, float],
    *,
    risk_penalty: float,
) -> FinalScore:
    if set(scores) != set(weights):
        raise ValueError("score components must match ranking weights")
    if abs(sum(weights.values()) - 1.0) > 1e-9:
        raise ValueError("ranking weights must sum to one")
    raw = sum(_clamp(scores[name]) * weight for name, weight in weights.items())
    penalty = _clamp(risk_penalty)
    applied = min(penalty, raw)
    return FinalScore(
        raw_score=raw,
        risk_penalty=penalty,
        applied_penalty=applied,
        final_score=max(0.0, raw - applied),
    )
