import type { ToolRiskLevel, ToolSpec } from '../contracts/agent-contract.js';

export type PolicyDecision = {
  allowed: boolean;
  reason?: string;
};

/**
 * Policy-gate behavior by risk level:
 *   low      → auto-allow (read/search)
 *   medium   → allow with audit log (edit on non-critical paths)
 *   high     → require approval (execute, edit on src/)
 *   critical → deny without explicit override (network/funds/keys — nobody holds yet)
 */
const RISK_POLICY: Record<ToolRiskLevel, { allowed: boolean; reason: string }> = {
  low: { allowed: true, reason: 'auto_allowed' },
  medium: { allowed: true, reason: 'allowed_with_audit' },
  high: { allowed: false, reason: 'approval_required' },
  critical: { allowed: false, reason: 'denied_no_override' }
};

export class PolicyGateService {
  /**
   * Evaluate a tool spec against the risk-level policy.
   * v0.2.0: now driven by agent contract ToolSpec instead of hardcoded string matching.
   */
  evaluateTool(tool: ToolSpec): PolicyDecision {
    return { ...RISK_POLICY[tool.risk_level] };
  }

  /**
   * v0.1.0 legacy API — kept for backward compat with existing callers.
   * @deprecated Use evaluateTool(tool: ToolSpec) for v0.2.0 contract-driven evaluation.
   */
  evaluate(taskType: string, riskLevel: string): PolicyDecision {
    // Map legacy string riskLevel to the new contract-driven model
    if (riskLevel === 'high' || riskLevel === 'critical') {
      return { allowed: false, reason: riskLevel === 'critical' ? 'denied_no_override' : 'approval_required' };
    }

    return { allowed: true };
  }
}