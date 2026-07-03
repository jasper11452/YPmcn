from contract.error_codes import ErrorCode
from contract.response_envelope import ResponseEnvelope


def test_success_envelope_contains_data_and_trace_id() -> None:
    result = ResponseEnvelope.ok({"creator_id": "creator-1"}, trace_id="trace-1")

    assert result.model_dump() == {
        "success": True,
        "data": {"creator_id": "creator-1"},
        "error": None,
        "trace_id": "trace-1",
    }


def test_error_envelope_never_contains_data() -> None:
    result = ResponseEnvelope.fail(
        ErrorCode.NOT_CONFIGURED,
        "backend missing",
        trace_id="trace-2",
    )

    assert result.success is False
    assert result.data is None
    assert result.error is not None
    assert result.error.code == ErrorCode.NOT_CONFIGURED
    assert result.trace_id == "trace-2"
