import pytest
from contract.error_codes import ErrorCode
from tools import record_client_feedback


@pytest.mark.asyncio
async def test_record_client_feedback_fails_safely_without_backend() -> None:
    result = await record_client_feedback.execute({})

    assert result.success is False
    assert result.error is not None
    assert result.error.code is ErrorCode.NOT_CONFIGURED

