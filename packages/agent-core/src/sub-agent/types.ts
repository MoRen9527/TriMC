// Sub-agent types — shared between TriMC and TriLC

import type { AgentTier } from '../permissions.js';

export type SubAgentStatus = 'idle' | 'running' | 'completed' | 'error' | 'cancelled';

export interface AgentDefinition {
  name: string;
  description: string;
  tools?: string[];
  systemPrompt?: string;
  model?: string;
  maxTurns?: number;
  /** Agent execution tier: 'main' (full), 'subagent' (restricted), 'coordinator' (task-only). */
  tier?: AgentTier;
}

export interface SpawnConfig {
  agent: AgentDefinition;
  task: string;
  context?: string;
  parentId?: string;
  timeout?: number;
  maxTurns?: number;
}

export interface SubAgentEvent {
  type: 'start' | 'tool_call' | 'tool_result' | 'tool_blocked' | 'message' | 'done' | 'error';
  agentId: string;
  agentName: string;
  timestamp: number;
  data?: unknown;
}
