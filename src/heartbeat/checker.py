"""IPD case heartbeat checker.

Scans all IPD cases for stuck states and returns structured findings
for CEOChiefOfStaff to report on session resume.

Design follows openclaw's heartbeat-events.ts event emitter pattern:
- Scan → emit findings → report summary
- "HEARTBEAT_OK" equivalent: no findings = clean report

Usage:
    from TriMC.src.heartbeat.checker import scan_all_cases

    report = scan_all_cases(workspace_root="/path/to/workspace")
    if report.has_alerts:
        for finding in report.findings:
            print(f"[{finding.severity.value}] {finding.message}")
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .models import (
    CaseSnapshot,
    Finding,
    FindingSeverity,
    HeartbeatReport,
    SlotStatus,
    StageStatus,
    StuckReason,
)

# ── Thresholds ──────────────────────────────────────────────────────────
# How long a pending intake approval can sit before it's flagged as stuck.
INTAKE_STUCK_HOURS = 24

# How long a submitted stage can wait for approval before alerting.
STAGE_APPROVAL_STUCK_HOURS = 48

# How long an in-progress stage can go without output before alerting.
STAGE_NO_OUTPUT_STUCK_HOURS = 72


def scan_all_cases(workspace_root: str | None = None) -> HeartbeatReport:
    """Scan all IPD cases and return a heartbeat report.

    Args:
        workspace_root: Path to the TriCompany workspace root.
            Defaults to the TriCompany-copilot-host-assets sibling of TriMetaverse.

    Returns:
        HeartbeatReport with findings for any stuck cases.
    """
    cases_root = _resolve_cases_root(workspace_root)
    report = HeartbeatReport()

    if not cases_root.exists():
        return report

    case_dirs = sorted(cases_root.iterdir())
    report.total_cases = len(case_dirs)

    for case_dir in case_dirs:
        case_json = case_dir / "case.json"
        if not case_json.exists():
            continue
        try:
            case_payload = json.loads(case_json.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue

        snapshot = _build_snapshot(case_payload)
        findings = _inspect_case(snapshot)
        report.findings.extend(findings)

    _set_report_status(report)
    return report


def scan_single_case(case_id: str, workspace_root: str | None = None) -> HeartbeatReport:
    """Scan a single IPD case."""
    cases_root = _resolve_cases_root(workspace_root)
    report = HeartbeatReport(total_cases=1)

    case_json = cases_root / case_id / "case.json"
    if not case_json.exists():
        return report

    case_payload = json.loads(case_json.read_text(encoding="utf-8"))
    snapshot = _build_snapshot(case_payload)
    report.findings = _inspect_case(snapshot)
    _set_report_status(report)
    return report


# ── Internal helpers ────────────────────────────────────────────────────


def _resolve_cases_root(workspace_root: str | None) -> Path:
    """Resolve the IPD cases root directory.

    Priority:
    1. Explicit workspace_root
    2. Import from chief_of_staff_wiki_paths if available
    3. Fallback to default path relative to TriMC module
    """
    if workspace_root:
        return Path(workspace_root)

    # Resolve project root (TriMetaverse) — 3 levels up from checker.py
    _project_root = Path(__file__).resolve().parents[3]

    # Try to import the canonical path from the IPD engine's wiki paths module
    try:
        import sys
        _host_assets = _project_root / "TriCompany-copilot-host-assets"
        if str(_host_assets) not in sys.path:
            sys.path.insert(0, str(_host_assets))
        from runtime.cognition.chief_of_staff_wiki_paths import (  # type: ignore[import-not-found]
            chief_of_staff_ipd_cases_root,
        )
        return Path(chief_of_staff_ipd_cases_root())
    except Exception:
        pass

    # Fallback: default cases path under copilot-host-assets
    base = _project_root / "TriCompany-copilot-host-assets"
    return base / "knowledge" / "employees" / "ceo-chief-of-staff" / "workbench" / "ipd" / "cases"


def _build_snapshot(case_payload: dict[str, Any]) -> CaseSnapshot:
    """Build a CaseSnapshot from raw case.json payload."""
    intake = case_payload.get("intake", {})
    intake_approvals = [
        SlotStatus(
            role=str(a.get("role", "")),
            status=str(a.get("status", "pending")),
            note=str(a.get("note", "")),
            updated_at=str(a.get("updatedAt", "")),
        )
        for a in intake.get("approvals", [])
    ]

    stages: list[StageStatus] = []
    for s in case_payload.get("stages", []):
        stage_approvals = [
            SlotStatus(
                role=str(a.get("role", "")),
                status=str(a.get("status", "pending")),
                note=str(a.get("note", "")),
                updated_at=str(a.get("updatedAt", "")),
            )
            for a in s.get("approvals", [])
        ]
        stages.append(
            StageStatus(
                stage_key=str(s.get("stageKey", "")),
                title=str(s.get("title", "")),
                owner_role=str(s.get("ownerRole", "")),
                status=str(s.get("status", "pending")),
                approvals=stage_approvals,
                submitted_at=str(s.get("submittedAt", "")),
                completed_at=str(s.get("completedAt", "")),
                activated_at=str(s.get("activatedAt", "")),
            )
        )

    return CaseSnapshot(
        case_id=str(case_payload.get("caseId", "")),
        title=str(case_payload.get("title", "")),
        status=str(case_payload.get("status", "")),
        priority=str(case_payload.get("priority", "")),
        created_at=str(case_payload.get("createdAt", "")),
        updated_at=str(case_payload.get("updatedAt", "")),
        current_stage_key=str(case_payload.get("currentStageKey", "")),
        current_owner_role="",
        completed_stage_count=sum(1 for s in stages if s.status == "completed"),
        total_stage_count=len(stages),
        intake_approvals=intake_approvals,
        stages=stages,
    )


def _inspect_case(snapshot: CaseSnapshot) -> list[Finding]:
    """Inspect a single case snapshot for stuck conditions."""
    findings: list[Finding] = []

    # ── 1. Intake approval stuck ────────────────────────────────────────
    pending = snapshot.pending_intake_slots
    if pending and snapshot.status == "awaiting-intake-approvals":
        # Check if it's been stuck too long
        if _is_stuck_since(snapshot.updated_at, hours=INTAKE_STUCK_HOURS):
            roles = ", ".join(s.role for s in pending)
            findings.append(
                Finding(
                    case_id=snapshot.case_id,
                    severity=FindingSeverity.ALERT,
                    reason=StuckReason.INTAKE_PENDING,
                    message=f"Intake 审批卡点: {roles} 尚未签核（已超 {INTAKE_STUCK_HOURS}h）",
                    detail={
                        "pending_roles": [s.role for s in pending],
                        "case_status": snapshot.status,
                        "created_at": snapshot.created_at,
                        "updated_at": snapshot.updated_at,
                    },
                )
            )

    # ── 2. Stage approval stuck ─────────────────────────────────────────
    for stage in snapshot.stages:
        if stage.status != "in-progress":
            continue
        pending_slots = stage.pending_slots
        rejected_slots = stage.rejected_slots

        # Rejected approvals are ERROR severity
        if rejected_slots:
            roles = ", ".join(s.role for s in rejected_slots)
            findings.append(
                Finding(
                    case_id=snapshot.case_id,
                    severity=FindingSeverity.ERROR,
                    reason=StuckReason.REJECTED,
                    message=f"阶段 {stage.title} 审批被驳回: {roles}",
                    detail={
                        "stage_key": stage.stage_key,
                        "rejected_roles": [s.role for s in rejected_slots],
                    },
                )
            )

        # Submitted but pending approval too long
        if stage.submitted_at and pending_slots:
            if _is_stuck_since(stage.submitted_at, hours=STAGE_APPROVAL_STUCK_HOURS):
                roles = ", ".join(s.role for s in pending_slots)
                findings.append(
                    Finding(
                        case_id=snapshot.case_id,
                        severity=FindingSeverity.ALERT,
                        reason=StuckReason.STAGE_APPROVAL_PENDING,
                        message=f"阶段 {stage.title} 已提交但 {roles} 未签核（已超 {STAGE_APPROVAL_STUCK_HOURS}h）",
                        detail={
                            "stage_key": stage.stage_key,
                            "owner_role": stage.owner_role,
                            "pending_roles": [s.role for s in pending_slots],
                            "submitted_at": stage.submitted_at,
                        },
                    )
                )

        # In-progress but no output for too long
        if not stage.submitted_at and stage.activated_at:
            if _is_stuck_since(stage.activated_at, hours=STAGE_NO_OUTPUT_STUCK_HOURS):
                findings.append(
                    Finding(
                        case_id=snapshot.case_id,
                        severity=FindingSeverity.ALERT,
                        reason=StuckReason.STAGE_NO_OUTPUT,
                        message=f"阶段 {stage.title}（{stage.owner_role}）已启动但 {STAGE_NO_OUTPUT_STUCK_HOURS}h 内无产出",
                        detail={
                            "stage_key": stage.stage_key,
                            "owner_role": stage.owner_role,
                            "activated_at": stage.activated_at,
                        },
                    )
                )

    return findings


def _is_stuck_since(iso_timestamp: str, *, hours: int) -> bool:
    """Check if a timestamp is older than the given number of hours."""
    if not iso_timestamp:
        return False
    try:
        ts = datetime.fromisoformat(iso_timestamp)
    except ValueError:
        return False
    return datetime.now(timezone.utc) - ts > timedelta(hours=hours)


def _set_report_status(report: HeartbeatReport) -> None:
    """Set report status based on findings, mirroring openclaw event states."""
    if not report.findings:
        report.status = "ok-empty"
    elif any(f.severity == FindingSeverity.ERROR for f in report.findings):
        report.status = "failed"
    elif report.has_alerts:
        report.status = "sent"
    else:
        report.status = "ok-empty"
