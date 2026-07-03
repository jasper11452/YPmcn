import pytest
from contract.error_codes import ErrorCode
from tools import validate_requirement


@pytest.mark.asyncio
async def test_validate_requirement_fails_safely_without_backend() -> None:
    result = await validate_requirement.execute({})

    assert result.success is False
    assert result.error is not None
    assert result.error.code is ErrorCode.NOT_CONFIGURED

