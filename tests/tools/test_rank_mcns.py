import pytest
from contract.error_codes import ErrorCode
from tools import rank_mcns


@pytest.mark.asyncio
async def test_rank_mcns_fails_safely_without_backend() -> None:
    result = await rank_mcns.execute({})

    assert result.success is False
    assert result.error is not None
    assert result.error.code is ErrorCode.NOT_CONFIGURED

