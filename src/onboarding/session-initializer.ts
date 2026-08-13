// ── Employee Session Initializer (v2 contracts) ──
// 6.4 会话初始化器（服务器 TriMC 端）：以 v2 合同（TriCompany/source-agents/*.contract.yaml）
// 为基础装配员工会话运行时配置，与本地 TriLC 侧（src/company/session-initializer.ts）同构，
// 互为 fallback 拉员工上岗。
//
// O2 口径（CTO 2026-08-13 裁决）：本模块不依赖 @tricompany/agent-core 的 zod schema
// （死形状，零生产消费方）；解析逻辑与 TriLC contract-resolver 同构，以 v2 合同
// （contract/paths/decision_rights/runtime_baseline）为真源。现有 v1 resolver
// （src/contracts/resolver.ts，docs/registry v1 合同）并存不替换；O2-A 收敛时统一。

import { readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parse as parseYaml } from 'yaml';

// ── Types (mirror TriLC src/company/session-initializer.ts SessionConfig) ──

export interface V2DecisionRights {
  approve: string[];
  freeze: string[];
  escalate: string[];
  forbidden: string[];
}

/** Employee session runtime config assembled from a v2 contract. */
export interface V2SessionConfig {
  agentId: string;
  family: 'Role' | 'Registry';
  systemPrompt: string;
  decisionRights: V2DecisionRights;
  toolControl: Record<string, unknown>;
  workspaceRoot: string;
  readyAt: string;
}

interface ContractYamlV2 {
  contract: {
    version?: string;
    agent_id: string;
    family?: string;
  };
  paths: Record<string, string>;
  decision_rights?: {
    approve?: string[];
    freeze?: string[];
    escalate?: string[];
    forbidden?: string[];
  };
  runtime_baseline?: Record<string, unknown>;
}

export class SessionInitError extends Error {
  constructor(
    message: string,
    public agentId: string,
  ) {
    super(`[session-initializer] ${agentId}: ${message}`);
    this.name = 'SessionInitError';
  }
}

// ── v2 Contract Loading (mirrors TriLC AgentContractResolver.loadOne) ──

/** Normalize paths with colleagues_social (merged field) → colleagues + social. */
function normalizePaths(rawPaths: Record<string, string>): Record<string, string> {
  const paths = { ...rawPaths };
  if (paths.colleagues_social) {
    if (!paths.colleagues) paths.colleagues = paths.colleagues_social;
    if (!paths.social) paths.social = paths.colleagues_social;
  }
  return paths;
}

function readFileSafe(filePath: string): string {
  try {
    if (existsSync(filePath)) {
      return readFileSync(filePath, 'utf-8');
    }
  } catch { /* ignore */ }
  return '';
}

/** Parse tool config from YAML frontmatter (mirrors TriLC parseFrontmatter). */
function parseFrontmatter(text: string): Record<string, unknown> {
  if (!text) return {};
  const trimmed = text.trim();
  if (!trimmed) return {};
  let yamlText = trimmed;
  if (trimmed.startsWith('---')) {
    const lines = trimmed.split(/\r?\n/);
    const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (closingIndex < 0) return {};
    yamlText = lines.slice(1, closingIndex).join('\n').trim();
    if (!yamlText) return {};
  }
  try {
    const parsed = parseYaml(yamlText) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/** Load one v2 contract file into a session config fragment. */
function loadV2Contract(contractPath: string, sourceRoot: string): V2SessionConfig | null {
  const yamlText = readFileSync(contractPath, 'utf-8');
  const parsed = parseYaml(yamlText) as unknown as ContractYamlV2;

  const agentId = parsed.contract?.agent_id;
  if (!agentId || !parsed.paths) return null;

  const paths = normalizePaths(parsed.paths);
  const family = (parsed.contract.family as 'Role' | 'Registry') || 'Role';

  const soul = readFileSafe(resolve(sourceRoot, paths.soul || ''));
  const agentBody = readFileSafe(resolve(sourceRoot, paths.agent_body || ''));
  const agentFrontmatter = readFileSafe(resolve(sourceRoot, paths.agent_frontmatter || ''));

  // Assemble system prompt: soul + agent body (mirrors TriLC)
  const systemPrompt = [soul, agentBody].filter(Boolean).join('\n\n');

  const explicitToolControl = parseFrontmatter(agentFrontmatter);
  const bodyToolControl = parseFrontmatter(agentBody);
  const toolControl = Object.keys(explicitToolControl).length > 0
    ? explicitToolControl
    : bodyToolControl;

  const decisionRights: V2DecisionRights = {
    approve: parsed.decision_rights?.approve || [],
    freeze: parsed.decision_rights?.freeze || [],
    escalate: parsed.decision_rights?.escalate || [],
    forbidden: parsed.decision_rights?.forbidden || [],
  };

  return {
    agentId,
    family,
    systemPrompt,
    decisionRights,
    toolControl,
    workspaceRoot: '',  // filled by initializeSession
    readyAt: '',
  };
}

/**
 * Scan a source-agents directory for v2 contracts:
 * `<sourceAgentsDir>/<agent-dir>/<agent-dir>.contract.yaml` (mirrors TriLC loadAll).
 */
export function loadV2Contracts(sourceAgentsDir: string): V2SessionConfig[] {
  const contracts: V2SessionConfig[] = [];
  const root = resolve(sourceAgentsDir);

  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return contracts;
  }

  for (const name of entries) {
    const contractPath = join(root, name, `${name}.contract.yaml`);
    if (!existsSync(contractPath)) continue;

    try {
      const contract = loadV2Contract(contractPath, root);
      if (contract) contracts.push(contract);
    } catch (err) {
      console.warn(`[session-initializer] failed to load ${contractPath}:`, (err as Error).message);
    }
  }

  return contracts;
}

// ── Session Initialization ──

/**
 * Employee session initialization on the TriMC (server) side:
 * 1. Contract load — v2 contract from the same-source TriCompany/source-agents
 * 2. Five-piece assembly — systemPrompt (soul + agent_body), decisionRights, toolControl
 * 3. Workspace ready — workspaceRoot/<agentId> created (idempotent)
 *
 * Throws SessionInitError when the agent contract is absent or unloadable.
 */
export function initializeSession(
  agentId: string,
  opts: { sourceAgentsDir: string; workspaceRoot: string },
): V2SessionConfig {
  const contracts = loadV2Contracts(opts.sourceAgentsDir);
  const contract = contracts.find((c) => c.agentId === agentId);
  if (!contract || !contract.systemPrompt) {
    throw new SessionInitError('v2 contract not loaded', agentId);
  }

  const workspaceRoot = resolve(opts.workspaceRoot, agentId);
  mkdirSync(workspaceRoot, { recursive: true });

  return {
    ...contract,
    workspaceRoot,
    readyAt: new Date().toISOString(),
  };
}
