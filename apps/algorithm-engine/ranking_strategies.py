from collections.abc import Iterable, Mapping
from enum import StrEnum
from typing import Any

from scoring.common import validate_normalized


class RankingStrategy(StrEnum):
    DEFAULT = "default"
    PRICE_FIRST = "price_first"
    CONTENT_FIRST = "content_first"


def _strategy_score(item: Mapping[str, Any], strategy: RankingStrategy) -> float:
    score = float(item.get("score", 0))
    price_score = float(item.get("price_score", 0))
    content_score = float(item.get("content_score", 0))
    validate_normalized(score=score, price_score=price_score, content_score=content_score)

    if strategy is RankingStrategy.PRICE_FIRST:
        return price_score * 0.7 + score * 0.3
    if strategy is RankingStrategy.CONTENT_FIRST:
        return content_score * 0.7 + score * 0.3
    return score


def rank_items(
    items: Iterable[dict[str, Any]],
    strategy: RankingStrategy = RankingStrategy.DEFAULT,
) -> list[dict[str, Any]]:
    return sorted(items, key=lambda item: _strategy_score(item, strategy), reverse=True)
