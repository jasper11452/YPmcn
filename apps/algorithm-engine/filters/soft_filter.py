from collections.abc import Iterable


def weighted_preference_score(preferences: Iterable[tuple[float, float]]) -> float:
    items = list(preferences)
    if not items:
        return 0.0

    for score, weight in items:
        if not 0 <= score <= 1:
            raise ValueError("preference scores must be between 0 and 1")
        if weight < 0:
            raise ValueError("preference weights cannot be negative")

    total_weight = sum(weight for _, weight in items)
    if total_weight == 0:
        return 0.0
    return sum(score * weight for score, weight in items) / total_weight
