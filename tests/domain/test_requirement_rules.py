import pytest
from domain.requirements import InvalidRequirement, validate_requirement_extraction
from sampling import RequirementExtraction


def test_missing_blockers_produce_draft_and_questions() -> None:
    extraction = RequirementExtraction(
        platforms=["xhs"],
        category_requirements=["beauty"],
        quantity_total=5,
        confidence_map={
            "platforms": "high",
            "category_requirements": "high",
            "quantity_total": "high",
            "budget_max_cents": "missing",
            "rebate_min_rate": "missing",
        },
        field_evidence={
            "platforms": "小红书",
            "category_requirements": "美妆",
            "quantity_total": "5位",
        },
    )

    result = validate_requirement_extraction(extraction, "小红书美妆，找5位")

    assert result.status == "draft"
    assert result.blocking_fields == ["budget_max_cents", "rebate_min_rate"]
    assert len(result.clarifying_questions) == 2
    assert len(result.version_fingerprint) == 64


def test_koc_does_not_imply_nano_tier() -> None:
    extraction = RequirementExtraction(
        platforms=["xhs"],
        budget_max_cents=100_000,
        rebate_min_rate=0.2,
        category_requirements=["beauty"],
        quantity_total=5,
        requirements_json={"creator_type_requirements": ["koc"]},
        confidence_map={},
        field_evidence={},
    )

    result = validate_requirement_extraction(extraction, "找5位小红书美妆KOC")

    assert result.status == "ready"
    assert result.requirements_json["creator_type_requirements"] == ["koc"]
    assert "creator_tier_requirements" not in result.requirements_json


def test_filter_rule_fields_and_modes_are_whitelisted() -> None:
    extraction = RequirementExtraction(
        platforms=["xhs"],
        budget_max_cents=100_000,
        rebate_min_rate=0.2,
        category_requirements=["beauty"],
        quantity_total=5,
        requirements_json={
            "filter_rules": [
                {"field": "sql_expression", "operator": "eq", "value": "1=1", "mode": "hard"}
            ]
        },
    )

    with pytest.raises(InvalidRequirement, match="filter field"):
        validate_requirement_extraction(extraction, "完整需求")
