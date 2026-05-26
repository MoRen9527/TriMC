export type PolicyDecision = {
  allowed: boolean;
  reason?: string;
};

export class PolicyGateService {
  evaluate(taskType: string, riskLevel: string): PolicyDecision {
    if (taskType === 'node_execution_task' && riskLevel === 'high') {
      return { allowed: false, reason: 'approval_required' };
    }

    return { allowed: true };
  }
}