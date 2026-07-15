// ── Task Envelope (v0.1.0 legacy, kept for backward compat) ──
export type TaskEnvelope = {
  ingressId: string;
  requestId: string;
  taskType: string;
  sourceClient: 'tripilot' | 'triavatar' | 'trimobile' | 'system';
};

// ── Agent Contract types (v0.2.0) ──
export type {
  AgentContract,
  AgentFamily,
  AgentIdentity,
  AgentResponsibility,
  Collaborators,
  DecisionRights,
  DecisionVerdict,
  IOContract,
  IOContractEntry,
  ToolRiskLevel,
  ToolSpec
} from './agent-contract.js';

export { loadContract, resolveContracts, ContractValidationError } from './resolver.js';