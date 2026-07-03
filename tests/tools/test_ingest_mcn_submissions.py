import pytest
from contract.error_codes import ErrorCode
from tools import ingest_mcn_submissions


@pytest.mark.asyncio
async def test_ingest_mcn_submissions_fails_safely_without_backend() -> None:
    result = await ingest_mcn_submissions.execute({})

    assert result.success is False
    assert result.error is not None
    assert result.error.code is ErrorCode.NOT_CONFIGURED

