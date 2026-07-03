import json
from typing import Any

from mcp.shared.exceptions import McpError
from mcp.types import SamplingMessage, TextContent
from pydantic import BaseModel, ConfigDict, Field
from tools.schemas import Platform, RawMessage


class SamplingUnavailable(RuntimeError):
    pass


class InvalidSamplingResponse(ValueError):
    pass


class RequirementExtraction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    platforms: list[Platform] = Field(default_factory=list)
    budget_min_cents: int | None = Field(default=None, ge=0)
    budget_max_cents: int | None = Field(default=None, ge=0)
    rebate_min_rate: float | None = Field(default=None, ge=0, le=1)
    rebate_max_rate: float | None = Field(default=None, ge=0, le=1)
    category_requirements: list[str] = Field(default_factory=list)
    quantity_total: int | None = Field(default=None, ge=1)
    content_formats: list[str] = Field(default_factory=list)
    cooperation_types: list[str] = Field(default_factory=list)
    creator_type_requirements: list[str] = Field(default_factory=list)
    creator_tier_requirements: list[str] = Field(default_factory=list)
    follower_min: int | None = Field(default=None, ge=0)
    follower_max: int | None = Field(default=None, ge=0)
    geo_requirements: dict[str, Any] = Field(default_factory=dict)
    audience_requirements: dict[str, Any] = Field(default_factory=dict)
    content_requirements: str | None = None
    tone_requirements: list[str] = Field(default_factory=list)
    negative_requirements: list[str] = Field(default_factory=list)
    requirements_json: dict[str, Any] = Field(default_factory=dict)
    confidence_map: dict[str, str] = Field(default_factory=dict)
    field_evidence: dict[str, Any] = Field(default_factory=dict)


def _extract_text(response: object) -> str:
    content = getattr(response, "content", None)
    if isinstance(content, list):
        text_parts = [
            getattr(part, "text", "") for part in content if getattr(part, "type", None) == "text"
        ]
        text = "\n".join(part for part in text_parts if part)
    elif getattr(content, "type", None) == "text":
        text = getattr(content, "text", "")
    else:
        text = ""
    if not text:
        raise InvalidSamplingResponse("sampling response did not contain text")
    stripped = text.strip()
    if stripped.startswith("```"):
        lines = stripped.splitlines()
        if len(lines) >= 3 and lines[-1].strip() == "```":
            stripped = "\n".join(lines[1:-1])
    return stripped


async def parse_requirement_with_sampling(
    raw_messages: list[RawMessage],
    context: object,
) -> RequirementExtraction:
    source = "\n".join(f"[{item.role}] {item.content}" for item in raw_messages)
    schema = json.dumps(RequirementExtraction.model_json_schema(), ensure_ascii=False)
    prompt = (
        "Extract the MCN creator campaign requirement from the source messages. "
        "Return one JSON object only. Preserve evidence for every extracted field "
        "in field_evidence. Do not infer missing blocking fields. Monetary values are "
        "integer cents, rebate rates are 0-1, "
        "and platforms are xhs or dy. KOC means creator_type koc and must not imply a follower "
        "tier unless the source explicitly gives a follower range.\n\nJSON SCHEMA:\n"
        f"{schema}\n\nSOURCE MESSAGES:\n{source}"
    )
    try:
        response = await context.session.create_message(
            messages=[
                SamplingMessage(
                    role="user",
                    content=TextContent(type="text", text=prompt),
                )
            ],
            max_tokens=2400,
            temperature=0,
            include_context="none",
        )
    except (AttributeError, NotImplementedError) as exc:
        raise SamplingUnavailable("MCP client does not support Sampling") from exc
    except McpError as exc:
        if exc.error.code == -32601:
            raise SamplingUnavailable("MCP client does not support Sampling") from exc
        raise

    try:
        payload = json.loads(_extract_text(response))
        return RequirementExtraction.model_validate(payload)
    except (json.JSONDecodeError, TypeError, ValueError) as exc:
        if isinstance(exc, InvalidSamplingResponse):
            raise
        message = "sampling response is not a valid requirement extraction"
        raise InvalidSamplingResponse(message) from exc
