// Tool registry — abstract tool registration and execution
// Shared between TriMC and TriLC via agent-core.
// Concrete tools are registered by the consuming module.
//
// Registry-only framework: no built-in tools. Consumers call
// register() to add tools before starting the agent loop.

import type { ToolDefinition } from 'trimodel';
import { filterToolsForTier, type AgentTier } from './permissions.js';

// ── Types ──

/** Tool execution context (REQ-014b: agent cwd for file/shell tools). */
export interface ToolContext {
  /** Working directory of the agent loop (NOT process.cwd()). */
  cwd?: string;
}

/** Tool handler function: receives args (+ optional ctx), returns JSON string result. */
export type ToolHandler = (args: Record<string, unknown>, ctx?: ToolContext) => Promise<string>;

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
  ctx?: ToolContext,
): Promise<string> {
  const tool = toolRegistry.get(name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return tool.handler(args, ctx);
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
 * Unregister a single tool by name.
 * C10: used by McpClientManager.disconnectServer() for per-tool cleanup.
 */
export function unregister(name: string): void {
  toolRegistry.delete(name);
}

/**
 * Clear all registered tools.
 */
export function clearRegistry(): void {
  toolRegistry.clear();
}

