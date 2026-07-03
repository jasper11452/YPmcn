from scoring.common import validate_normalized

CREATOR_WEIGHTS = {
    "content": 0.30,
    "price": 0.20,
    "rebate": 0.15,
    "fit": 0.20,
    "delivery": 0.15,
}


def creator_score(
    *,
    content: float,
    price: float,
    rebate: float,
    fit: float,
    delivery: float,
) -> float:
    values = {
        "content": content,
        "price": price,
        "rebate": rebate,
        "fit": fit,
        "delivery": delivery,
    }
    validate_normalized(**values)
    return sum(values[name] * weight for name, weight in CREATOR_WEIGHTS.items())
