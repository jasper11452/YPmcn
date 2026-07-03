from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum


class GateType(StrEnum):
    CONFIRM_READY = "confirm_ready"
    CONFIRM_MEDIUM_RISK = "confirm_medium_risk"
    CONFIRM_RISKY_SUBMISSION = "confirm_risky_submission"
    CONFIRM_MCN_SELECTION = "confirm_mcn_selection"
    AUTHORIZE_RELAXATION = "authorize_relaxation"
    MANUAL_REVIEW_RESUME = "manual_review_resume"


@dataclass(frozen=True, slots=True)
class GateConfirmation:
    gate_type: GateType
    actor_id: str
    note: str | None = None
    confirmed_at: datetime = field(default_factory=lambda: datetime.now(UTC))


def confirm(gate_type: GateType, actor_id: str, note: str | None = None) -> GateConfirmation:
    if not actor_id.strip():
        raise ValueError("actor_id is required")
    return GateConfirmation(gate_type=gate_type, actor_id=actor_id, note=note)
