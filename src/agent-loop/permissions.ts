// ── TriMC Tool Permission System ──
// Absorbed from Claude Code 2.1.88 vendor pattern (constants/tools.ts).
// Defines agent tiers and tool access rules to prevent recursive/unsafe tool usage.

import type { ToolDefinition } from 'trimodel';

// ── Agent Tiers ──

/** Agent execution tier determines which tools are available */
export type AgentTier = 'main' | 'subagent' | 'coordinator';

// ── Tool Permission Metadata ──

/**
 * Maps tool names to the set of tiers that can access them.
 * Default: if a tool is not listed here, it's main-only.
 */
const TOOL_TIER_ALLOWLIST: Record<string, Set<AgentTier>> = {
  // Read-only tools — main + subagent (coordinator only dispatches, doesn't read)
  read_file: new Set(['main', 'subagent']),
  glob_search: new Set(['main', 'subagent']),

  // Write tools — main + subagent only
  write_file: new Set(['main', 'subagent']),
  edit_file: new Set(['main', 'subagent']),

  // Shell — main + subagent only
  shell_exec: new Set(['main', 'subagent']),

  // Agent spawn — main + coordinator only (NOT subagent: prevents recursion)
  task: new Set(['main', 'coordinator']),
};

// ── Tier Descriptions ──

/** Human-readable tier descriptions for debugging/logging */
export const TIER_DESCRIPTIONS: Record<AgentTier, string> = {
  main: 'All tools available. Full access for the primary agent loop.',
  subagent: 'Restricted tool set. Read + write + shell, but cannot spawn sub-agents (prevents recursion).',
  coordinator: 'Minimal tool set. Only task (spawn sub-agents). No file I/O or shell. Pure orchestrator mode.',
};

// ── Tier Composition Helpers ──

/** Tools allowed for each tier (computed from TOOL_TIER_ALLOWLIST) */
export function getToolNamesForTier(tier: AgentTier): Set<string> {
  const tools = new Set<string>();
  for (const [toolName, tiers] of Object.entries(TOOL_TIER_ALLOWLIST)) {
    if (tiers.has(tier)) {
      tools.add(toolName);
    }
  }
  return tools;
}

/** Filter tool definitions to only those allowed for a given tier */
export function filterToolsForTier(
  tools: ToolDefinition[],
  tier: AgentTier,
): ToolDefinition[] {
  if (tier === 'main') return tools; // Main gets everything

  const allowed = getToolNamesForTier(tier);
  return tools.filter((t) => allowed.has(t.function.name));
}

// ── Permission Check ──

export interface PermissionResult {
  allowed: boolean;
  reason?: string;
}

/** Check whether a specific tool can be used at a given tier */
export function canUseTool(toolName: string, tier: AgentTier): PermissionResult {
  if (tier === 'main') return { allowed: true };

  const toolTiers = TOOL_TIER_ALLOWLIST[toolName];
  if (!toolTiers) {
    return {
      allowed: false,
      reason: `tool "${toolName}" is not registered in TOOL_TIER_ALLOWLIST (defaults to main-only)`,
    };
  }

  if (!toolTiers.has(tier)) {
    return {
      allowed: false,
      reason: `tool "${toolName}" is not allowed at tier "${tier}". Allowed tiers: ${[...toolTiers].join(', ')}`,
    };
  }

  return { allowed: true };
}

// ── Tool Count Summary ──

/** Debug utility: count available tools per tier */
export function getTierSummary(): Record<AgentTier, { count: number; tools: string[] }> {
  const tiers: AgentTier[] = ['main', 'subagent', 'coordinator'];
  const summary = {} as Record<AgentTier, { count: number; tools: string[] }>;

  for (const tier of tiers) {
    const names = [...getToolNamesForTier(tier)].sort();
    summary[tier] = { count: names.length, tools: names };
  }

  return summary;
}
