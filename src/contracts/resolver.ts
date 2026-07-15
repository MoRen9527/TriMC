// ── Agent Contract Resolver ──
// TriMC v0.2.0: Parses .contract.yaml files into typed AgentContract objects
// Validates all six Schema v1 elements are present

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type {
  AgentContract,
  AgentFamily,
  DecisionRights,
  IOContract,
  RuntimeBaselineItem,
  ToolRiskLevel,
  ToolSpec
} from './agent-contract.js';

// ── YAML Raw Shape (pre-validation) ──

interface ContractYamlRaw {
  contract: { version: string; type: string; agent_id: string };
  identity: {
    display_name: string;
    family: string;
    role: string;
    description: string;
    user_invocable?: boolean;
  };
  responsibilities: { description?: string; priority?: string }[] | string[];
  decision_rights: {
    approve?: string[];
    freeze?: string[];
    escalate?: string[];
    forbidden?: string[];
  };
  collaborators: {
    reports_to: string;
    peers?: string[];
    supervises?: string[];
  };
  tools?: {
    name: string;
    scope?: string[];
    risk_level?: string;
    requires_approval?: boolean;
    runtime_equivalent?: string;
  }[];
  io_contract: {
    inputs?: { type: string; description: string; source?: string }[];
    outputs?: { type: string; description: string; source?: string }[];
  };
  instructions?: string;
  runtime_baseline?: { name: string; description: string }[];
}

// ── Validation ──

const VALID_FAMILIES: readonly string[] = ['Role', 'Registry'];
const VALID_RISK_LEVELS: readonly string[] = ['low', 'medium', 'high', 'critical'];
const VALID_PRIORITIES: readonly string[] = ['high', 'medium', 'low'];

class ContractValidationError extends Error {
  constructor(
    message: string,
    public agentId: string
  ) {
    super(`[ContractResolver] ${agentId}: ${message}`);
    this.name = 'ContractValidationError';
  }
}

function validateFamily(value: string, agentId: string): AgentFamily {
  if (!VALID_FAMILIES.includes(value)) {
    throw new ContractValidationError(
      `identity.family must be one of [${VALID_FAMILIES.join(', ')}], got "${value}"`,
      agentId
    );
  }
  return value as AgentFamily;
}

function validateRiskLevel(value: string | undefined, agentId: string, toolName: string): ToolRiskLevel {
  if (!value || !VALID_RISK_LEVELS.includes(value)) {
    throw new ContractValidationError(
      `tool "${toolName}" risk_level must be one of [${VALID_RISK_LEVELS.join(', ')}], got "${value}"`,
      agentId
    );
  }
  return value as ToolRiskLevel;
}

function validateRequiredFields(raw: ContractYamlRaw): void {
  const id = raw.contract?.agent_id ?? 'unknown';

  if (!raw.contract?.version) throw new ContractValidationError('contract.version is required', id);
  if (!raw.contract?.agent_id) throw new ContractValidationError('contract.agent_id is required', id);
  if (!raw.identity?.display_name) throw new ContractValidationError('identity.display_name is required', id);
  if (!raw.identity?.family) throw new ContractValidationError('identity.family is required', id);
  if (!raw.identity?.role) throw new ContractValidationError('identity.role is required', id);
  if (!raw.identity?.description) throw new ContractValidationError('identity.description is required', id);
  if (!raw.responsibilities || (Array.isArray(raw.responsibilities) && raw.responsibilities.length === 0)) {
    throw new ContractValidationError('responsibilities must be a non-empty array', id);
  }
  if (!raw.decision_rights) throw new ContractValidationError('decision_rights is required', id);
  if (!raw.collaborators?.reports_to) throw new ContractValidationError('collaborators.reports_to is required', id);
  if (!raw.io_contract) throw new ContractValidationError('io_contract is required', id);
  if (!raw.io_contract.inputs || raw.io_contract.inputs.length === 0) {
    throw new ContractValidationError('io_contract.inputs must be a non-empty array', id);
  }
  if (!raw.io_contract.outputs || raw.io_contract.outputs.length === 0) {
    throw new ContractValidationError('io_contract.outputs must be a non-empty array', id);
  }
}

function normalizeResponsibilities(
  raw: (string | { description?: string; priority?: string })[]
): { description: string; priority?: 'high' | 'medium' | 'low' }[] {
  return raw.map((item) => {
    if (typeof item === 'string') {
      return { description: item };
    }
    const priority = item.priority && VALID_PRIORITIES.includes(item.priority)
      ? (item.priority as 'high' | 'medium' | 'low')
      : undefined;
    return { description: item.description ?? '', priority };
  });
}

function normalizeTools(rawTools: ContractYamlRaw['tools'], agentId: string): ToolSpec[] {
  if (!rawTools || rawTools.length === 0) return [];
  return rawTools.map((t) => ({
    name: t.name,
    scope: t.scope ?? [],
    risk_level: validateRiskLevel(t.risk_level, agentId, t.name),
    requires_approval: t.requires_approval ?? false,
    runtime_equivalent: t.runtime_equivalent ?? ''
  }));
}

// ── Public API ──

/**
 * Load and parse a .contract.yaml file into a validated AgentContract.
 * Throws ContractValidationError if any Schema v1 element is missing or invalid.
 */
export function loadContract(contractPath: string): AgentContract {
  const fullPath = resolve(contractPath);

  let raw: ContractYamlRaw;
  try {
    const content = readFileSync(fullPath, 'utf-8');
    raw = parseYaml(content) as ContractYamlRaw;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ContractValidationError(`failed to read or parse YAML: ${message}`, contractPath);
  }

  const id = raw.contract?.agent_id ?? 'unknown';
  validateRequiredFields(raw);
  validateFamily(raw.identity.family, id);

  const decisionRights: DecisionRights = {
    approve: raw.decision_rights.approve ?? [],
    freeze: raw.decision_rights.freeze ?? [],
    escalate: raw.decision_rights.escalate ?? [],
    forbidden: raw.decision_rights.forbidden ?? []
  };

  const tools = normalizeTools(raw.tools, id);

  const ioContract: IOContract = {
    inputs: (raw.io_contract.inputs ?? []).map((i) => ({
      type: i.type,
      description: i.description,
      source: i.source
    })),
    outputs: (raw.io_contract.outputs ?? []).map((o) => ({
      type: o.type,
      description: o.description,
      source: o.source
    }))
  };

  const instructions: string | undefined = raw.instructions;
  const runtimeBaseline: RuntimeBaselineItem[] | undefined = raw.runtime_baseline?.map((b) => ({
    name: b.name,
    description: b.description
  }));

  return {
    agent_id: id,
    version: raw.contract.version,
    identity: {
      display_name: raw.identity.display_name,
      family: validateFamily(raw.identity.family, id),
      role: raw.identity.role,
      description: raw.identity.description,
      user_invocable: raw.identity.user_invocable ?? true
    },
    responsibilities: normalizeResponsibilities(raw.responsibilities),
    decision_rights: decisionRights,
    collaborators: {
      reports_to: raw.collaborators.reports_to,
      peers: raw.collaborators.peers ?? [],
      supervises: raw.collaborators.supervises ?? []
    },
    tools,
    io_contract: ioContract,
    instructions,
    runtime_baseline: runtimeBaseline
  };
}

/**
 * Resolve all contract YAML files from a directory.
 * Scans for *.contract.yaml, parses each, returns successfully loaded contracts.
 * Failed parses are collected and reported — does not throw on individual failures.
 */
export function resolveContracts(
  registryDir: string
): { contracts: AgentContract[]; errors: { path: string; message: string }[] } {
  const contracts: AgentContract[] = [];
  const errors: { path: string; message: string }[] = [];

  let entries: string[];
  try {
    entries = readdirSync(resolve(registryDir));
  } catch {
    return { contracts, errors: [{ path: registryDir, message: 'directory not readable' }] };
  }

  for (const entry of entries) {
    if (!entry.endsWith('.contract.yaml')) continue;

    const fullPath = join(registryDir, entry);
    try {
      contracts.push(loadContract(fullPath));
    } catch (err: unknown) {
      errors.push({
        path: entry,
        message: err instanceof Error ? err.message : String(err)
      });
    }
  }

  return { contracts, errors };
}

export { ContractValidationError };
