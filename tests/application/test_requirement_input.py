from typing import cast

import pytest
from application.common import ToolFailure
from application.service import McpToolService
from contract.error_codes import ErrorCode
from sqlalchemy.ext.asyncio import AsyncEngine
from tools.schemas import ValidateRequirementRequest


@pytest.mark.asyncio
async def test_requirement_validation_uses_typed_input_without_sampling_context() -> None:
    request = ValidateRequirementRequest.model_validate(
        {
            "trace_id": "trace-1",
            "idempotency_key": "idem-1",
            "raw_messages": [{"role": "client", "content": "小红书美妆"}],
            "parsed_requirement": {
                "platforms": ["xhs"],
                "category_requirements": ["beauty"],
                "field_evidence": {"platforms": "抖音"},
            },
        }
    )
    service = McpToolService(cast(AsyncEngine, None))

    with pytest.raises(ToolFailure) as raised:
        await service._validate_requirement(request)

    assert raised.value.code == ErrorCode.VALIDATION_ERROR
    assert str(raised.value) == "field evidence is inconsistent for platforms"
