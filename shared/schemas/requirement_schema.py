from decimal import Decimal
from typing import Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from shared.constants.platform_enum import Platform


class Requirement(BaseModel):
    model_config = ConfigDict(extra="forbid")

    platforms: list[Platform] = Field(min_length=1)
    budget: Decimal = Field(gt=0)
    required_creator_count: int = Field(default=1, gt=0)
    constraints: dict[str, object] = Field(default_factory=dict)

    @model_validator(mode="after")
    def platforms_are_unique(self) -> Self:
        if len(self.platforms) != len(set(self.platforms)):
            raise ValueError("platforms must be unique")
        return self

