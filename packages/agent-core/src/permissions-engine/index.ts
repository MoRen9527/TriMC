// ── PermissionEngine ──
// CTO-003 P4T1: Absorbed from Claude Code 2.1.88 vendor (permissions.ts).
// Central permission engine with 7-step decision pipeline.
// Shared between TriMC and TriLC via agent-core.

import type { PermissionMode, PermissionRule, DecisionResult } from './types.js';
import { runDecisionPipeline } from './decision-pipeline.js';

// ── Re-exports ──
export type { PermissionMode, PermissionRule, PermissionBehavior, DecisionResult, DecisionStep, RuleSource, SafetyCheckResult } from './types.js';
export { RULE_SOURCE_PRIORITY } from './types.js';
export { parseRule, parseRules } from './rule-parser.js';
export { runSafetyCheck } from './safety-check.js';
export { runDecisionPipeline } from './decision-pipeline.js';

// ── PermissionEngineOptions ──

export interface PermissionEngineOptions {
  /** Permission mode (default: 'default') */
  mode?: PermissionMode;
  /** Permission rules (flat list — engine sorts by source priority) */
  rules?: PermissionRule[];
  /** Current working directory for acceptEdits/dontAsk mode path restriction */
  cwd?: string;
  /** C9: Additional directories to treat as within-boundary (e.g., sibling repos) */
  additionalDirectories?: string[];
}

// ── PermissionEngine ──

export class PermissionEngine {
  private mode: PermissionMode;
  private rules: PermissionRule[];
  private cwd?: string;
  private additionalDirectories: string[];

  constructor(options: PermissionEngineOptions = {}) {
    this.mode = options.mode ?? 'default';
    this.rules = options.rules ?? [];
    this.cwd = options.cwd;
    this.additionalDirectories = options.additionalDirectories ?? [];
  }

  /** Set current permission mode. */
  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  /** Get current permission mode. */
  getMode(): PermissionMode {
    return this.mode;
  }

  /** Set working directory (for acceptEdits/dontAsk mode). */
  setCwd(cwd: string): void {
    this.cwd = cwd;
  }

  /** Get working directory. */
  getCwd(): string | undefined {
    return this.cwd;
  }

  /** C9: Set additional directories for boundary checks. */
  setAdditionalDirectories(dirs: string[]): void {
    this.additionalDirectories = dirs;
  }

  /** C9: Get additional directories. */
  getAdditionalDirectories(): string[] {
    return [...this.additionalDirectories];
  }

  /** Add a single permission rule. */
  addRule(rule: PermissionRule): void {
    this.rules.push(rule);
  }

  /** Add multiple permission rules. */
  addRules(rules: PermissionRule[]): void {
    this.rules.push(...rules);
  }

  /** Get all current rules. */
  getRules(): PermissionRule[] {
    return [...this.rules];
  }

  /** Clear all rules. */
  clearRules(): void {
    this.rules = [];
  }

  /**
   * Decide whether a tool invocation is allowed.
   * Runs the full 7-step decision pipeline.
   *
   * @param toolName - Name of the tool being invoked
   * @param args - Tool arguments
   * @returns DecisionResult with allowed/behavior/reason
   */
  decide(toolName: string, args: Record<string, unknown>): DecisionResult {
    return runDecisionPipeline(
      toolName, args, this.mode, this.rules, this.cwd, this.additionalDirectories,
    );
  }

  /**
   * Assert that a tool is allowed — throws if denied.
   * Convenience wrapper around decide().
   */
  require(toolName: string, args: Record<string, unknown>): void {
    const decision = this.decide(toolName, args);
    if (!decision.allowed) {
      throw new Error(`Permission denied: ${decision.reason ?? 'unknown reason'}`);
    }
  }
}
