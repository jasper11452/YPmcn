from typing import Self

from pydantic import BaseModel, ConfigDict, Field, model_validator


class ScoreDetail(BaseModel):
    model_config = ConfigDict(extra="forbid")

    total: float = Field(ge=0, le=1)
    components: dict[str, float]
    risk_penalty: float = Field(default=0, ge=0, le=1)

    @model_validator(mode="after")
    def components_are_normalized(self) -> Self:
        invalid = {name: value for name, value in self.components.items() if not 0 <= value <= 1}
        if invalid:
            raise ValueError(f"score components must be between 0 and 1: {invalid}")
        return self

