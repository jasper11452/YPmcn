import pytest
from contract.error_codes import ErrorCode
from tools import create_submission_batch


@pytest.mark.asyncio
async def test_create_submission_batch_fails_safely_without_backend() -> None:
    result = await create_submission_batch.execute({})

    assert result.success is False
    assert result.error is not None
    assert result.error.code is ErrorCode.NOT_CONFIGURED

