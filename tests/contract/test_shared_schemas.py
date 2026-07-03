from decimal import Decimal

import pytest
from pydantic import ValidationError

from shared.constants.candidate_source_enum import CandidateSource
from shared.constants.platform_enum import Platform
from shared.schemas.formula_snapshot_schema import FormulaSnapshot
from shared.schemas.requirement_schema import Requirement
from shared.schemas.score_detail_schema import ScoreDetail


def test_requirement_normalizes_enum_values() -> None:
    requirement = Requirement(platforms=["xhs", "dy"], budget=Decimal("1000"))

    assert requirement.platforms == [Platform.XHS, Platform.DY]
    assert requirement.required_creator_count == 1


def test_requirement_rejects_unknown_platform() -> None:
    with pytest.raises(ValidationError):
        Requirement(platforms=["unknown"], budget=1000)


def test_score_detail_rejects_out_of_range_component() -> None:
    with pytest.raises(ValidationError):
        ScoreDetail(total=0.8, components={"content": 1.1})


def test_formula_snapshot_requires_weights_to_sum_to_one() -> None:
    with pytest.raises(ValidationError):
        FormulaSnapshot(strategy="default", weights={"content": 0.4, "price": 0.4})


def test_candidate_source_values_are_stable() -> None:
    assert {source.value for source in CandidateSource} == {
        "ratecard",
        "mcn_returned",
        "manual_sourced",
    }
