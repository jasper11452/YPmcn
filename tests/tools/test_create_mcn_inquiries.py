import pytest
from contract.error_codes import ErrorCode
from tools import create_mcn_inquiries


@pytest.mark.asyncio
async def test_create_mcn_inquiries_fails_safely_without_backend() -> None:
    result = await create_mcn_inquiries.execute({})

    assert result.success is False
    assert result.error is not None
    assert result.error.code is ErrorCode.NOT_CONFIGURED

