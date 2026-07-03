from types import SimpleNamespace

import pytest
from mcp.shared.exceptions import McpError
from mcp.types import ErrorData
from sampling import RequirementExtraction, SamplingUnavailable, parse_requirement_with_sampling
from tools.schemas import RawMessage


class UnsupportedSession:
    async def create_message(self, **_: object) -> object:
        raise NotImplementedError


class UnsupportedContext:
    session = UnsupportedSession()


@pytest.mark.asyncio
async def test_sampling_unavailable_fails_closed() -> None:
    with pytest.raises(SamplingUnavailable):
        await parse_requirement_with_sampling(
            [RawMessage(role="client", content="小红书美妆需求")],
            UnsupportedContext(),
        )


class MethodNotFoundSession:
    async def create_message(self, **_: object) -> object:
        raise McpError(ErrorData(code=-32601, message="sampling/createMessage is not supported"))


class MethodNotFoundContext:
    session = MethodNotFoundSession()


@pytest.mark.asyncio
async def test_sampling_method_not_found_fails_closed() -> None:
    with pytest.raises(SamplingUnavailable):
        await parse_requirement_with_sampling(
            [RawMessage(role="client", content="小红书美妆需求")],
            MethodNotFoundContext(),
        )


class JsonSession:
    async def create_message(self, **_: object) -> object:
        return SimpleNamespace(
            content=SimpleNamespace(
                type="text",
                text='{"platforms":["xhs"],"budget_max_cents":300000,"rebate_min_rate":0.2,"category_requirements":["beauty"],"quantity_total":10,"confidence_map":{},"field_evidence":{}}',
            )
        )


class JsonContext:
    session = JsonSession()


@pytest.mark.asyncio
async def test_sampling_result_is_validated_as_structured_extraction() -> None:
    result = await parse_requirement_with_sampling(
        [RawMessage(role="client", content="预算3000，数量10位，小红书美妆，返点20%")],
        JsonContext(),
    )

    assert isinstance(result, RequirementExtraction)
    assert result.budget_max_cents == 300000
    assert result.quantity_total == 10
