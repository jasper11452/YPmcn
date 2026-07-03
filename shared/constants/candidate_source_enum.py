from enum import StrEnum


class CandidateSource(StrEnum):
    RATE_CARD = "rate_card"
    MCN_RETURNED = "mcn_returned"
    MANUAL_SEARCH = "manual_search"
