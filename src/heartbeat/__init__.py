"""TriMC heartbeat — IPD case stuck-state detection.

Design follows openclaw's heartbeat event emitter pattern:
- Scan → emit findings → report summary
- "HEARTBEAT_OK" equivalent: no findings = clean scan
- Manual orchestration by CEOChiefOfStaff for Phase 1 debugging
"""

from .checker import scan_all_cases, scan_single_case
from .models import (
    CaseSnapshot,
    Finding,
    FindingSeverity,
    HeartbeatReport,
    SlotStatus,
    StageStatus,
    StuckReason,
)

__all__ = [
    "scan_all_cases",
    "scan_single_case",
    "CaseSnapshot",
    "Finding",
    "FindingSeverity",
    "HeartbeatReport",
    "SlotStatus",
    "StageStatus",
    "StuckReason",
]
