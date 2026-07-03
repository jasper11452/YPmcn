from scoring.common import validate_normalized

RISK_WEIGHTS = {"data_gap": 0.40, "price_volatility": 0.30, "delivery_risk": 0.30}


def risk_penalty(*, data_gap: float, price_volatility: float, delivery_risk: float) -> float:
    values = {
        "data_gap": data_gap,
        "price_volatility": price_volatility,
        "delivery_risk": delivery_risk,
    }
    validate_normalized(**values)
    return sum(values[name] * weight for name, weight in RISK_WEIGHTS.items())


def apply_risk_penalty(base_score: float, penalty: float) -> float:
    validate_normalized(base_score=base_score, penalty=penalty)
    return max(0.0, base_score - penalty)

