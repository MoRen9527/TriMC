// Tool registry — abstract tool registration and execution
// Shared between TriMC and TriLC via agent-core.
// Concrete tools are registered by the consuming module.
//
// Registry-only framework: no built-in tools. Consumers call
// register() to add tools before starting the agent loop.

import type { ToolDefinition } from 'trimodel';
import { filterToolsForTier, type AgentTier } from './permissions.js';

// ── Types ──

/** Tool handler function: receives args, returns JSON string result. */
export type ToolHandler = (args: Record<string, unknown>) => Promise<string>;

interface ToolRegistration {
  definition: ToolDefinition;
  handler: ToolHandler;
}

// ── Registry ──

const toolRegistry: Map<string, ToolRegistration> = new Map();

// ── Public API ──

/**
 * Register a tool definition and its handler.
 * If a tool with the same name exists, it is overwritten.
 */
export function register(def: ToolDefinition, handler: ToolHandler): void {
  if (toolRegistry.has(def.function.name)) {
    console.warn(`[agent-core] Tool "${def.function.name}" is being overwritten`);
  }
  toolRegistry.set(def.function.name, { definition: def, handler });
}

/**
 * Get all registered tool definitions, optionally filtered by agent tier.
 * Returns trimodel-compatible ToolDefinition[] for passing to modelClient.stream().
 */
export function getToolDefinitions(tier?: AgentTier): ToolDefinition[] {
  const allDefs = [...toolRegistry.values()].map((r) => r.definition);
  if (tier) {
    return filterToolsForTier(allDefs, tier);
  }
  return allDefs;
}

/**
 * Execute a registered tool by name.
 * Returns the handler's result (JSON string).
 * Throws if the tool is not registered.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const tool = toolRegistry.get(name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return tool.handler(args);
}

/**
 * Check if a tool is registered.
 */
export function hasTool(name: string): boolean {
  return toolRegistry.has(name);
}

/**
 * List all registered tool names.
 */
export function listTools(): string[] {
  return [...toolRegistry.keys()];
}

/**
 * Clear all registered tools.
 */
export function clearRegistry(): void {
  toolRegistry.clear();
}

