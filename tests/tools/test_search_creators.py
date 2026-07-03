import pytest
from contract.error_codes import ErrorCode
from tools import search_creators


@pytest.mark.asyncio
async def test_search_creators_fails_safely_without_backend() -> None:
    result = await search_creators.execute({})

    assert result.success is False
    assert result.error is not None
    assert result.error.code is ErrorCode.NOT_CONFIGURED

