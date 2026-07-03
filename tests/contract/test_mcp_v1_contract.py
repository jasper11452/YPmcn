import pytest
from config import DatabaseSettings
from contract.error_codes import ErrorCode
from contract.response_envelope import ResponseEnvelope


def test_success_envelope_contains_workflow_and_allowed_actions() -> None:
    result = ResponseEnvelope.ok(
        {"demand_id": "1"},
        trace_id="trace-1",
        workflow_state={"phase": "requirement_ready", "state_version": 1},
        allowed_actions=["search_creators"],
        idempotency_key="idem-1",
    )

    assert result.model_dump(mode="json", exclude_none=True) == {
        "success": True,
        "data": {"demand_id": "1"},
        "trace_id": "trace-1",
        "workflow_state": {"phase": "requirement_ready", "state_version": 1},
        "allowed_actions": ["search_creators"],
        "idempotency_key": "idem-1",
    }


def test_error_envelope_uses_singular_detail_and_retriable() -> None:
    result = ResponseEnvelope.fail(
        ErrorCode.INVALID_PHASE,
        "phase mismatch",
        trace_id="trace-2",
        detail={"current_phase": "requirement_draft", "expected_phase": ["requirement_ready"]},
        retriable=False,
    )

    assert result.error is not None
    assert result.error.detail["current_phase"] == "requirement_draft"
    assert result.error.retriable is False
    assert not hasattr(result.error, "details")
    assert result.allowed_actions == []


def test_database_settings_require_explicit_test_tls_exception() -> None:
    with pytest.raises(ValueError, match="TLS"):
        DatabaseSettings.from_mapping(
            {
                "YP_DATA_PASSWORD": "secret",
                "YP_DATA_ENV": "production",
                "YP_DATA_SSL_MODE": "disabled",
            }
        )

    settings = DatabaseSettings.from_mapping(
        {
            "YP_DATA_PASSWORD": "secret",
            "YP_DATA_ENV": "test",
            "YP_DATA_SSL_MODE": "disabled",
        }
    )
    assert settings.host == "d-oa-test.eshypdata.com"
    assert settings.database == "ypmcn"
    assert settings.password.get_secret_value() == "secret"
