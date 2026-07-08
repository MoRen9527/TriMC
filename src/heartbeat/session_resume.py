"""Session-resume hook for CEOChiefOfStaff (小贾).

Runs the IPD heartbeat check and returns a structured summary suitable
for inclusion in 小贾's session-resume narrative.

Usage:
    from TriMC.src.heartbeat.session_resume import heartbeat_on_resume

    summary = heartbeat_on_resume()
    if summary["has_issues"]:
        # Report stuck cases to CEO
        for line in summary["briefing_lines"]:
            print(line)

Design:
- Manual orchestration (小贾 invokes explicitly, no auto-trigger)
- Returns structured dict, not raw HeartbeatReport
- Non-zero findings produce briefing_lines for CEO briefing
"""

from __future__ import annotations

from datetime import datetime, timezone

from .checker import scan_all_cases
from .models import FindingSeverity


def heartbeat_on_resume(workspace_root: str | None = None) -> dict:
    """Run heartbeat check and return a session-resume summary.

    Returns a dict:
        has_issues: bool
        status: str           # "ok-empty", "sent", "failed"
        total_cases: int
        alert_count: int
        error_count: int
        briefing_lines: list[str]  # CEO-facing summary lines (empty if clean)
        findings_raw: list[dict]   # Raw finding data for tool consumption
    """
    report = scan_all_cases(workspace_root=workspace_root)

    summary: dict = {
        "has_issues": report.has_alerts,
        "status": report.status,
        "total_cases": report.total_cases,
        "alert_count": report.alert_count,
        "error_count": report.error_count,
        "briefing_lines": [],
        "findings_raw": [],
        "checked_at": datetime.now(timezone.utc).isoformat(),
    }

    if not report.findings:
        summary["briefing_lines"] = [
            f"[HEARTBEAT_OK] {report.total_cases} 个 IPD case 状态正常，无卡点。"
        ]
        return summary

    # Build CEO-facing briefing lines
    errors = [f for f in report.findings if f.severity == FindingSeverity.ERROR]
    alerts = [f for f in report.findings if f.severity == FindingSeverity.ALERT]

    summary["briefing_lines"].append(
        f"[HEARTBEAT] 扫描 {report.total_cases} 个 IPD case: "
        f"{len(errors)} 个 ERROR, {len(alerts)} 个 ALERT"
    )

    for f in errors:
        summary["briefing_lines"].append(f"  [ERROR] {f.case_id}: {f.message}")
    for f in alerts:
        summary["briefing_lines"].append(f"  [ALERT] {f.case_id}: {f.message}")

    summary["findings_raw"] = [
        {
            "case_id": f.case_id,
            "severity": f.severity.value,
            "reason": f.reason.value,
            "message": f.message,
            "detail": f.detail,
        }
        for f in report.findings
    ]

    return summary
