from application.service import McpToolService
from tools.schemas import ManualSourceCreatorsRequest


def test_invalid_manual_offer_is_parsed_for_per_item_rejection() -> None:
    request = ManualSourceCreatorsRequest.model_validate(
        {
            "trace_id": "trace-1",
            "idempotency_key": "idem-1",
            "demand_id": "1",
            "demand_version": 1,
            "manual_results": [
                {
                    "platform": "xhs",
                    "platform_account_id": "creator-1",
                    "offer": {"price_cents": -1, "rebate_min_rate": 1.2},
                },
                {
                    "platform": "xhs",
                    "platform_account_id": "creator-2",
                    "offer": {"price_cents": 1000, "rebate_min_rate": 0.2},
                },
            ],
        }
    )

    assert McpToolService._manual_offer_error(request.manual_results[0].offer) is not None
    assert McpToolService._manual_offer_error(request.manual_results[1].offer) is None
