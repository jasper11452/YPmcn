from gates.base import GateConfirmation, GateType
from gates.base import confirm as _confirm

GATE_TYPE = GateType.CONFIRM_READY


def confirm(actor_id: str, note: str | None = None) -> GateConfirmation:
    return _confirm(GATE_TYPE, actor_id, note)
