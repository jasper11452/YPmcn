import pytest
from contract.error_codes import ErrorCode
from tools import audit_manual_adjustment


@pytest.mark.asyncio
async def test_audit_manual_adjustment_fails_safely_without_backend() -> None:
    result = await audit_manual_adjustment.execute({})

    assert result.success is False
    assert result.error is not None
    assert result.error.code is ErrorCode.NOT_CONFIGURED
