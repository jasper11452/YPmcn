from scoring.common import validate_normalized

MCN_WEIGHTS = {"count": 0.10, "rebate": 0.70, "rating": 0.20}


def mcn_score(*, count: float, rebate: float, rating: float) -> float:
    values = {"count": count, "rebate": rebate, "rating": rating}
    validate_normalized(**values)
    return sum(values[name] * weight for name, weight in MCN_WEIGHTS.items())
