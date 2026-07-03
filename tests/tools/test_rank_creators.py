import pytest
from contract.error_codes import ErrorCode
from tools import rank_creators


@pytest.mark.asyncio
async def test_rank_creators_fails_safely_without_backend() -> None:
    result = await rank_creators.execute({})

    assert result.success is False
    assert result.error is not None
    assert result.error.code is ErrorCode.NOT_CONFIGURED
