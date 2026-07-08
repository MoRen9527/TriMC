"""IPD heartbeat data models.

Mirrors the event emitter pattern from openclaw's heartbeat-events.ts
but adapted for Python + IPD case engine integration.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any


class FindingSeverity(str, Enum):
    """Severity levels matching openclaw's HeartbeatIndicatorType."""

    OK = "ok"
    ALERT = "alert"
    ERROR = "error"


class StuckReason(str, Enum):
    """Reasons a case might be stuck."""

    INTAKE_PENDING = "intake_pending"
    STAGE_APPROVAL_PENDING = "stage_approval_pending"
    STAGE_NO_OUTPUT = "stage_no_output"
    STAGE_LONG_RUNNING = "stage_long_running"
    REJECTED = "rejected"


@dataclass
class SlotStatus:
    """Status of a single approval slot."""

    role: str
    status: str  # pending / approved / rejected
    note: str = ""
    updated_at: str = ""

    @property
    def is_pending(self) -> bool:
        return self.status == "pending"

    @property
    def is_approved(self) -> bool:
        return self.status == "approved"

    @property
    def is_rejected(self) -> bool:
        return self.status == "rejected"


@dataclass
class StageStatus:
    """Status of a single IPD stage."""

    stage_key: str
    title: str
    owner_role: str
    status: str  # pending / in-progress / completed
    approvals: list[SlotStatus] = field(default_factory=list)
    submitted_at: str = ""
    completed_at: str = ""
    activated_at: str = ""

    @property
    def pending_slots(self) -> list[SlotStatus]:
        return [s for s in self.approvals if s.is_pending]

    @property
    def rejected_slots(self) -> list[SlotStatus]:
        return [s for s in self.approvals if s.is_rejected]

    @property
    def is_stalled(self) -> bool:
        """Stage is active but has pending approvals or no output."""
        if self.status == "completed":
            return False
        if self.status == "in-progress" and self.submitted_at:
            # Submitted but awaiting approval
            return any(s.is_pending for s in self.approvals)
        return False


@dataclass
class CaseSnapshot:
    """Snapshot of an IPD case for heartbeat inspection."""

    case_id: str
    title: str
    status: str
    priority: str
    created_at: str
    updated_at: str
    current_stage_key: str
    current_owner_role: str
    completed_stage_count: int
    total_stage_count: int
    intake_approvals: list[SlotStatus] = field(default_factory=list)
    stages: list[StageStatus] = field(default_factory=list)

    @property
    def pending_intake_slots(self) -> list[SlotStatus]:
        return [s for s in self.intake_approvals if s.is_pending]

    @property
    def active_stage(self) -> StageStatus | None:
        for stage in self.stages:
            if stage.status in ("in-progress",):
                return stage
        return None


@dataclass
class Finding:
    """A single heartbeat finding — one stuck or noteworthy item."""

    case_id: str
    severity: FindingSeverity
    reason: StuckReason
    message: str
    detail: dict[str, Any] = field(default_factory=dict)

    # Timestamp matching openclaw's HeartbeatEventPayload.ts
    ts: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


@dataclass
class HeartbeatReport:
    """Result of one heartbeat scan over all IPD cases."""

    ts: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    total_cases: int = 0
    findings: list[Finding] = field(default_factory=list)
    status: str = "ok-empty"  # ok-empty | ok-token | alert

    @property
    def has_alerts(self) -> bool:
        return any(f.severity in (FindingSeverity.ALERT, FindingSeverity.ERROR) for f in self.findings)

    @property
    def alert_count(self) -> int:
        return sum(1 for f in self.findings if f.severity == FindingSeverity.ALERT)

    @property
    def error_count(self) -> int:
        return sum(1 for f in self.findings if f.severity == FindingSeverity.ERROR)
