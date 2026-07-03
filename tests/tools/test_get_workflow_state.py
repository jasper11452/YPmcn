import pytest
from contract.error_codes import ErrorCode
from tools import get_workflow_state


@pytest.mark.asyncio
async def test_get_workflow_state_fails_safely_without_backend() -> None:
    result = await get_workflow_state.execute({})

    assert result.success is False
    assert result.error is not None
    assert result.error.code is ErrorCode.NOT_CONFIGURED
