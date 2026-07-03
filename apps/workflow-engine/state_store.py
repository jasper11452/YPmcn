from dataclasses import dataclass, replace

from phases import PHASE_SEQUENCE, WorkflowPhase


class VersionConflict(RuntimeError):
    pass


class InvalidPhase(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class WorkflowState:
    demand_id: str
    phase: WorkflowPhase
    version: int


class InMemoryStateStore:
    def __init__(self) -> None:
        self._states: dict[str, WorkflowState] = {}

    def create(self, demand_id: str) -> WorkflowState:
        if demand_id in self._states:
            raise ValueError(f"workflow already exists: {demand_id}")
        state = WorkflowState(demand_id=demand_id, phase=WorkflowPhase.DRAFT, version=0)
        self._states[demand_id] = state
        return state

    def get(self, demand_id: str) -> WorkflowState:
        try:
            return replace(self._states[demand_id])
        except KeyError as exc:
            raise KeyError(f"workflow not found: {demand_id}") from exc

    def transition(
        self,
        demand_id: str,
        expected_version: int,
        target_phase: WorkflowPhase,
    ) -> WorkflowState:
        current = self.get(demand_id)
        if current.version != expected_version:
            raise VersionConflict(
                f"expected version {expected_version}, current version is {current.version}"
            )

        current_index = PHASE_SEQUENCE.index(current.phase)
        expected_target = (
            PHASE_SEQUENCE[current_index + 1]
            if current_index + 1 < len(PHASE_SEQUENCE)
            else None
        )
        if target_phase is not expected_target:
            raise InvalidPhase(f"cannot transition from {current.phase} to {target_phase}")

        updated = WorkflowState(
            demand_id=demand_id,
            phase=target_phase,
            version=current.version + 1,
        )
        self._states[demand_id] = updated
        return updated
