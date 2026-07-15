// ── Sub-Agent Module ──
// P3T1: Agent spawn system absorbed from Claude Code Phase 3 Tier 1.
// Public API for spawning and managing sub-agents.

export type {
  AgentType,
  AgentDefinition,
  AgentSpawnConfig,
  AgentSpawnResult,
  SubAgentEvent,
} from './types.js';

export {
  getBuiltInAgents,
  getBuiltInAgent,
  getAgentDisplayInfo,
  buildAgentCatalog,
  CLAUDE_TOOL_MAP,
} from './built-in.js';

export {
  resolveAgentTools,
  filterToolsForAgent,
  buildToolCatalog,
} from './tools-resolve.js';

export {
  spawnAgent,
  spawnAgentAndCollect,
} from './spawn.js';
