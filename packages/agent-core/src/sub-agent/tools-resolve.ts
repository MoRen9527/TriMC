// Claude Code → TriMC tool name resolver
// Shared between TriMC and TriLC

import type { ToolDefinition } from 'trimodel';
import { getToolDefinitions } from '../tools.js';
import type { AgentTier } from '../permissions.js';

// Claude Code tool names → TriMC tool names mapping
const CLAUDE_TO_TRIMC_TOOL_MAP: Record<string, string> = {
  Read: 'read_file',
  Write: 'write_file',
  Edit: 'edit_file',
  Bash: 'shell_exec',
  Glob: 'glob_search',
  Grep: 'search_code',
  Task: 'task',
  WebSearch: 'web_search',
  WebFetch: 'web_fetch',
  NotebookRead: 'notebook_read',
  NotebookEdit: 'notebook_edit',
};

/**
 * Resolve Claude Code tool names to TriMC tool names.
 * Returns the mapped name or the original if no mapping exists.
 */
export function resolveToolName(claudeName: string): string {
  return CLAUDE_TO_TRIMC_TOOL_MAP[claudeName] ?? claudeName;
}

/**
 * Get available tool definitions for a sub-agent, filtered by allowed tools.
 */
export function resolveSubAgentTools(
  allowedTools: string[],
  tier?: AgentTier,
): ToolDefinition[] {
  const resolved = allowedTools.map(resolveToolName);
  const allTools = getToolDefinitions(tier);
  return allTools.filter((t) => resolved.includes(t.function.name));
}
