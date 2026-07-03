import pytest
from contract.error_codes import ErrorCode
from tools import manual_source_creators


@pytest.mark.asyncio
async def test_manual_source_creators_fails_safely_without_backend() -> None:
    result = await manual_source_creators.execute({})

    assert result.success is False
    assert result.error is not None
    assert result.error.code is ErrorCode.NOT_CONFIGURED

