from enum import StrEnum


class CandidateSource(StrEnum):
    RATECARD = "ratecard"
    MCN_RETURNED = "mcn_returned"
    MANUAL_SOURCED = "manual_sourced"
