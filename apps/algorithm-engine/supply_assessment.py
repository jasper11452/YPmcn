from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class SupplyAssessment:
    multiplier: float
    high_risk: bool


def assess_supply(*, available_count: int, required_count: int) -> SupplyAssessment:
    if available_count < 0:
        raise ValueError("available_count cannot be negative")
    if required_count <= 0:
        raise ValueError("required_count must be positive")

    multiplier = min(available_count / required_count, 1.0)
    return SupplyAssessment(multiplier=multiplier, high_risk=multiplier < 0.5)
