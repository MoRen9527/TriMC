"""CLI entry point for IPD heartbeat checker.

Usage:
    python -m TriMC.src.heartbeat.cli           # scan all cases
    python -m TriMC.src.heartbeat.cli --case-id <id>  # scan single case
    python -m TriMC.src.heartbeat.cli --json     # JSON output for scripting
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Ensure TriMC and TriCompany-copilot-host-assets are importable
_HERE = Path(__file__).resolve().parent
_TRIMC_ROOT = _HERE.parents[2]
_HOST_ASSETS = _TRIMC_ROOT.parent / "TriCompany-copilot-host-assets"

for _p in (str(_TRIMC_ROOT / "src"), str(_HERE.parent), str(_HOST_ASSETS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from heartbeat.checker import scan_all_cases, scan_single_case  # noqa: E402
from heartbeat.models import FindingSeverity  # noqa: E402


def _format_finding(f: "Finding") -> str:  # type: ignore[name-defined]  # noqa: F821
    emoji = {"ok": "[OK]", "alert": "[ALERT]", "error": "[ERROR]"}.get(f.severity.value, "[?]")
    return f"{emoji} [{f.case_id}] {f.message}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="IPD heartbeat checker")
    parser.add_argument("--case-id", help="Scan a single case by ID")
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    parser.add_argument("--workspace-root", help="Override workspace root path")
    args = parser.parse_args(argv)

    if args.case_id:
        report = scan_single_case(args.case_id, workspace_root=args.workspace_root)
    else:
        report = scan_all_cases(workspace_root=args.workspace_root)

    if args.json:
        payload = {
            "ts": report.ts,
            "status": report.status,
            "total_cases": report.total_cases,
            "findings": [
                {
                    "case_id": f.case_id,
                    "severity": f.severity.value,
                    "reason": f.reason.value,
                    "message": f.message,
                    "detail": f.detail,
                }
                for f in report.findings
            ],
        }
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(f"\n[HEARTBEAT] IPD Heartbeat -- {report.ts}")
        print(f"   Cases: {report.total_cases}  |  Alerts: {report.alert_count}  |  Errors: {report.error_count}")
        if not report.findings:
            print("   HEARTBEAT_OK -- all cases clean\n")
        else:
            for f in report.findings:
                print(f"   {_format_finding(f)}")
            print()

    return 1 if report.error_count > 0 else 0


if __name__ == "__main__":
    raise SystemExit(main())
