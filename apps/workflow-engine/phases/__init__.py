from enum import StrEnum


class WorkflowPhase(StrEnum):
    DRAFT = "draft"
    READY = "ready"
    CANDIDATE_POOL_READY = "candidate_pool_ready"
    WAITING_BACKEND_INQUIRY = "waiting_backend_inquiry"
    RECOMMENDATION_READY = "recommendation_ready"
    SUBMISSION_BATCH_READY = "submission_batch_ready"
    CLOSED = "closed"


PHASE_SEQUENCE = tuple(WorkflowPhase)

__all__ = ["PHASE_SEQUENCE", "WorkflowPhase"]

