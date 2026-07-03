from datetime import UTC, datetime
from typing import Self

from pydantic import BaseModel, ConfigDict, Field, model_validator


class FormulaSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")

    strategy: str = Field(min_length=1)
    weights: dict[str, float]
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

    @model_validator(mode="after")
    def weights_are_valid(self) -> Self:
        if not self.weights:
            raise ValueError("weights cannot be empty")
        if any(weight < 0 for weight in self.weights.values()):
            raise ValueError("weights cannot be negative")
        if abs(sum(self.weights.values()) - 1.0) > 1e-9:
            raise ValueError("weights must sum to one")
        return self
