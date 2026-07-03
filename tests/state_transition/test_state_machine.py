import pytest
from state_store import (
    InMemoryStateStore,
    InvalidPhase,
    VersionConflict,
    WorkflowPhase,
)


def test_happy_path_reaches_closed() -> None:
    store = InMemoryStateStore()
    state = store.create("demand-1")

    for phase in (
        WorkflowPhase.READY,
        WorkflowPhase.CANDIDATE_POOL_READY,
        WorkflowPhase.WAITING_BACKEND_INQUIRY,
        WorkflowPhase.RECOMMENDATION_READY,
        WorkflowPhase.SUBMISSION_BATCH_READY,
        WorkflowPhase.CLOSED,
    ):
        state = store.transition("demand-1", state.version, phase)

    assert state.phase is WorkflowPhase.CLOSED
    assert state.version == 6


def test_stale_state_version_is_rejected() -> None:
    store = InMemoryStateStore()
    state = store.create("demand-1")
    store.transition("demand-1", state.version, WorkflowPhase.READY)

    with pytest.raises(VersionConflict):
        store.transition(
            "demand-1",
            state.version,
            WorkflowPhase.CANDIDATE_POOL_READY,
        )


def test_skipping_a_phase_is_rejected() -> None:
    store = InMemoryStateStore()
    state = store.create("demand-1")

    with pytest.raises(InvalidPhase):
        store.transition(
            "demand-1",
            state.version,
            WorkflowPhase.RECOMMENDATION_READY,
        )

