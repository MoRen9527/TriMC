// ── Agent Tier & Tool Permission System ──
// CTO-003 P4T1: Absorbed from Claude Code / TriMC agent-loop.
// Defines three agent tiers and which tools each tier may access.
// Shared between TriMC and TriLC via agent-core.

import type { ToolDefinition } from 'trimodel';

// ── AgentTier ──

/**
 * Agent execution tier — determines tool access permissions.
 *
 * - `main`: Primary agent with full tool access (read, write, shell, agents).
 * - `subagent`: Delegated agent with restricted access (read-only by default, no shell).
 * - `coordinator`: Overseer agent — manages sub-agents, no direct tool execution.
 * - `heartbeat`: Scheduled/background agent — read + write allowed, NO shell.
 *   REQ-20260805-006: onboarding/heartbeat agents assemble company skeleton
 *   (write files) without shell access.
 */
export type AgentTier = 'main' | 'subagent' | 'coordinator' | 'heartbeat';

// ── Tool Tier Allowlist ──

/**
 * Maps tool names to the minimum AgentTier required.
 * Used by filterToolsForTier and canUseTool.
 */
const TIER_LEVEL: Record<AgentTier, number> = {
  coordinator: 0,
  subagent: 1,
  heartbeat: 2,
  main: 3,
};

export const TOOL_TIER_ALLOWLIST: Record<string, AgentTier> = {
  // Read-only tools — available to subagent+
  read_file: 'subagent',
  list_directory: 'subagent',
  search_code: 'subagent',
  glob_search: 'subagent',
  read_lints: 'subagent',

  // Task/Agent management — coordinator+
  // Note: anti-recursion guard in canUseTool explicitly blocks subagent
  // from using task regardless of tier level.
  task: 'coordinator',

  // Write tools — heartbeat+ (REQ-006: scheduled agents assemble skeleton)
  write_file: 'heartbeat',
  edit_file: 'heartbeat',
  replace_in_file: 'heartbeat',

  // Shell — main only (heartbeat must NOT run shell)
  shell_exec: 'main',
};

// ── Tier Utilities ──

/**
 * Get a human-readable summary of an agent tier.
 */
export function getTierSummary(tier: AgentTier): string {
  return `Agent tier: ${tier} (level ${TIER_LEVEL[tier]})`;
}

/**
 * Calculate tool counts per tier from a set of tool definitions.
 * Used by loop.ts to emit loop_start metadata.
 */
export function getTierToolCounts(
  tools: ToolDefinition[],
): Record<AgentTier, { count: number }> {
  return {
    coordinator: { count: filterToolsForTier(tools, 'coordinator').length },
    subagent: { count: filterToolsForTier(tools, 'subagent').length },
    heartbeat: { count: filterToolsForTier(tools, 'heartbeat').length },
    main: { count: filterToolsForTier(tools, 'main').length },
  };
}

/**
 * Filter tool definitions to only those accessible at the given tier.
 */
export function filterToolsForTier(
  tools: ToolDefinition[],
  tier: AgentTier,
): ToolDefinition[] {
  return tools.filter((t) => canUseTool(t.function.name, tier).allowed);
}

/** Result of a tool permission check. */
export interface PermissionResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Check if a specific tool can be used at the given tier.
 */
export function canUseTool(toolName: string, tier: AgentTier): PermissionResult {
  // Anti-recursion: subagent must never spawn sub-sub-agents
  if (toolName === 'task' && tier === 'subagent') {
    return {
      allowed: false,
      reason: 'subagent tier is not allowed to spawn sub-agents (anti-recursion guard)',
    };
  }

  const required = TOOL_TIER_ALLOWLIST[toolName] ?? 'main';
  const allowed = TIER_LEVEL[required] <= TIER_LEVEL[tier];
  if (!allowed) {
    const requiredTier = Object.entries(TIER_LEVEL).find(([, v]) => v === TIER_LEVEL[required])?.[0] ?? required;
    return {
      allowed: false,
      reason: `tool "${toolName}" requires tier "${requiredTier}" or higher (current: "${tier}")`,
    };
  }
  return { allowed: true };
}

