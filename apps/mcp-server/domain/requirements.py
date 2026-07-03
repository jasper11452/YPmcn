import hashlib
import json
from dataclasses import dataclass
from typing import Any, Literal

from tools.schemas import ParsedRequirement

BLOCKING_FIELDS = (
    "platforms",
    "budget_max_cents",
    "rebate_min_rate",
    "category_requirements",
    "quantity_total",
)

FILTER_FIELDS = frozenset(
    {
        "platform",
        "creator_type",
        "creator_tier",
        "followers_count",
        "categories",
        "content_format",
        "cooperation_type",
        "price_cents",
        "rebate_rate",
        "country",
        "province",
        "city",
        "gender",
        "age",
        "cpm_cents",
        "cpe_cents",
        "availability_status",
    }
)
FILTER_OPERATORS = frozenset(
    {"eq", "ne", "in", "not_in", "gte", "lte", "between", "contains", "intersects"}
)
FILTER_MODES = frozenset({"hard", "soft", "bonus", "display"})
Confidence = Literal["high", "medium", "low", "missing"]


class InvalidRequirement(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class ValidatedRequirement:
    status: Literal["draft", "ready"]
    missing_fields: list[str]
    blocking_fields: list[str]
    clarifying_questions: list[str]
    confidence_map: dict[str, Confidence]
    requirements_json: dict[str, Any]
    version_fingerprint: str


_QUESTIONS = {
    "platforms": "请确认本次投放平台（小红书或抖音）。",
    "budget_max_cents": "请确认单个达人或本次需求的预算上限。",
    "rebate_min_rate": "请确认可接受的最低返点比例。",
    "category_requirements": "请确认需要匹配的内容品类。",
    "quantity_total": "请确认本次需要的达人数量。",
}


def _is_missing(field: str, extraction: ParsedRequirement) -> bool:
    value = getattr(extraction, field)
    return value is None or value == [] or value == ""


def _validate_filter_rules(requirements_json: dict[str, Any]) -> None:
    rules = requirements_json.get("filter_rules", [])
    if not isinstance(rules, list):
        raise InvalidRequirement("filter_rules must be an array")
    for rule in rules:
        if not isinstance(rule, dict):
            raise InvalidRequirement("each filter rule must be an object")
        if rule.get("field") not in FILTER_FIELDS:
            raise InvalidRequirement(f"filter field is not allowed: {rule.get('field')!r}")
        if rule.get("operator") not in FILTER_OPERATORS:
            raise InvalidRequirement(f"filter operator is not allowed: {rule.get('operator')!r}")
        if rule.get("mode") not in FILTER_MODES:
            raise InvalidRequirement(f"filter mode is not allowed: {rule.get('mode')!r}")


def _validate_evidence(extraction: ParsedRequirement, source_text: str) -> None:
    for field, evidence in extraction.field_evidence.items():
        snippets = evidence if isinstance(evidence, list) else [evidence]
        for snippet in snippets:
            if not isinstance(snippet, str) or snippet not in source_text:
                raise InvalidRequirement(f"field evidence is inconsistent for {field}")


def validate_requirement_extraction(
    extraction: ParsedRequirement,
    source_text: str,
) -> ValidatedRequirement:
    if extraction.budget_min_cents is not None and extraction.budget_max_cents is not None:
        if extraction.budget_min_cents > extraction.budget_max_cents:
            raise InvalidRequirement("budget minimum cannot exceed maximum")
    if extraction.rebate_min_rate is not None and extraction.rebate_max_rate is not None:
        if extraction.rebate_min_rate > extraction.rebate_max_rate:
            raise InvalidRequirement("rebate minimum cannot exceed maximum")
    if extraction.follower_min is not None and extraction.follower_max is not None:
        if extraction.follower_min > extraction.follower_max:
            raise InvalidRequirement("follower minimum cannot exceed maximum")

    requirements_json = json.loads(json.dumps(extraction.requirements_json))
    if extraction.creator_type_requirements:
        requirements_json["creator_type_requirements"] = extraction.creator_type_requirements
    if extraction.creator_tier_requirements:
        requirements_json["creator_tier_requirements"] = extraction.creator_tier_requirements
    _validate_filter_rules(requirements_json)
    _validate_evidence(extraction, source_text)

    creator_types = requirements_json.get("creator_type_requirements", [])
    if "koc" in creator_types and "creator_tier_requirements" not in requirements_json:
        requirements_json.pop("creator_tier_requirements", None)

    missing = [field for field in BLOCKING_FIELDS if _is_missing(field, extraction)]
    confidence_map: dict[str, Confidence] = {}
    valid_confidences = {"high", "medium", "low", "missing"}
    confidence_fields = [
        field
        for field in type(extraction).model_fields
        if field not in {"confidence_map", "field_evidence", "requirements_json"}
    ]
    for field in confidence_fields:
        supplied = extraction.confidence_map.get(field)
        if supplied is not None and supplied not in valid_confidences:
            raise InvalidRequirement(f"invalid confidence value for {field}")
        field_missing = _is_missing(field, extraction)
        confidence_map[field] = "missing" if field_missing else supplied or "low"
        if confidence_map[field] == "missing" and not field_missing:
            raise InvalidRequirement(f"confidence says missing but {field} has a value")

    fingerprint_payload = extraction.model_dump(
        mode="json",
        exclude={"confidence_map", "field_evidence"},
    )
    canonical = json.dumps(fingerprint_payload, sort_keys=True, separators=(",", ":"))
    fingerprint = hashlib.sha256(canonical.encode()).hexdigest()
    return ValidatedRequirement(
        status="draft" if missing else "ready",
        missing_fields=missing,
        blocking_fields=missing,
        clarifying_questions=[_QUESTIONS[field] for field in missing],
        confidence_map=confidence_map,
        requirements_json=requirements_json,
        version_fingerprint=fingerprint,
    )
