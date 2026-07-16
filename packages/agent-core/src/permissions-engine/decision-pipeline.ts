// ── 7-Step Decision Pipeline ──
// CTO-003 P4T1: Absorbed from Claude Code 2.1.88 vendor (permissions.ts).
// Ordered decision pipeline that processes tool invocations through
// deny → ask → safety → mode → allow → default-deny chain.
//
// Shared between TriMC and TriLC via agent-core.

import type { DecisionResult, PermissionMode, PermissionRule } from './types.js';
import { RULE_SOURCE_PRIORITY } from './types.js';
import { runSafetyCheck } from './safety-check.js';

// ── Pipeline ──

/**
 * Run the full 7-step decision pipeline for a tool invocation.
 *
 * Steps (in order):
 *   1. Always-deny rules (highest priority)
 *   2. Always-ask rules
 *   3. Safety check (bypass-immune — fires in ALL modes)
 *   4. Mode: bypassPermissions → allow all non-safety-flagged
 *   5. Mode: acceptEdits → restrict write tools to cwd
 *   6. Always-allow rules
 *   7. Default deny (fail closed)
 *
 * @param toolName - Name of the tool being invoked
 * @param args - Tool arguments for content matching and safety checks
 * @param mode - Current permission mode
 * @param rules - Sorted rules (highest source priority first)
 * @param cwd - Current working directory for acceptEdits path checks
 */
export function runDecisionPipeline(
  toolName: string,
  args: Record<string, unknown>,
  mode: PermissionMode,
  rules: PermissionRule[],
  cwd?: string,
): DecisionResult {
  // Pre-sort rules by source priority
  const sorted = sortRulesByPriority(rules);

  // ── Step 1: Always-deny rules ──
  const denyResult = checkDenyRules(toolName, args, sorted);
  if (denyResult) return denyResult;

  // ── Step 2: Always-ask rules ──
  const askResult = checkAskRules(toolName, args, sorted);
  if (askResult) return askResult;

  // ── Step 3: Safety check (bypass-immune) ──
  const safetyResult = runSafetyCheck(toolName, args);
  if (safetyResult.triggered) {
    return {
      allowed: false,
      behavior: 'deny',
      reason: safetyResult.reason ?? 'Blocked by safety check',
      decidedBy: 'safety_check',
    };
  }

  // ── Step 4: Mode — bypassPermissions ──
  if (mode === 'bypassPermissions') {
    return {
      allowed: true,
      behavior: 'allow',
      reason: 'Permission mode: bypassPermissions',
      decidedBy: 'mode_bypass',
    };
  }

  // ── Step 5: Mode — acceptEdits ──
  if (mode === 'acceptEdits') {
    const editResult = checkAcceptEditsMode(toolName, args, cwd);
    if (editResult) return editResult;
  }

  // ── Step 6: Always-allow rules ──
  const allowResult = checkAllowRules(toolName, args, sorted);
  if (allowResult) return allowResult;

  // ── Step 7: Default deny ──
  return {
    allowed: false,
    behavior: 'deny',
    reason: `Tool "${toolName}" is not explicitly allowed. Default-deny policy.`,
    decidedBy: 'default_deny',
  };
}

// ── Rule Checking Functions ──

/** Sort rules by RULE_SOURCE_PRIORITY (highest first). */
function sortRulesByPriority(rules: PermissionRule[]): PermissionRule[] {
  return [...rules].sort((a, b) => {
    const aP = RULE_SOURCE_PRIORITY[a.source] ?? 0;
    const bP = RULE_SOURCE_PRIORITY[b.source] ?? 0;
    return bP - aP; // descending
  });
}

/** Check deny rules — first match wins. */
function checkDenyRules(
  toolName: string,
  args: Record<string, unknown>,
  rules: PermissionRule[],
): DecisionResult | null {
  for (const rule of rules) {
    if (rule.behavior !== 'deny') continue;
    if (!matchesTool(rule, toolName)) continue;
    if (rule.content && !matchesContent(rule, args)) continue;

    return {
      allowed: false,
      behavior: 'deny',
      reason: `Tool "${toolName}" denied by rule${rule.content ? ` matching "${rule.content}"` : ''} (source: ${rule.source})`,
      decidedBy: 'always_deny',
    };
  }
  return null;
}

/** Check ask rules — first match wins. */
function checkAskRules(
  toolName: string,
  args: Record<string, unknown>,
  rules: PermissionRule[],
): DecisionResult | null {
  for (const rule of rules) {
    if (rule.behavior !== 'ask') continue;
    if (!matchesTool(rule, toolName)) continue;
    if (rule.content && !matchesContent(rule, args)) continue;

    return {
      allowed: false, // 'ask' is treated as deny in Tier 1 (no interactive prompt)
      behavior: 'ask',
      reason: `Tool "${toolName}" requires confirmation${rule.content ? ` (content: "${rule.content}")` : ''} (source: ${rule.source})`,
      decidedBy: 'always_ask',
    };
  }
  return null;
}

/** Check mode: acceptEdits — restrict writes to cwd. */
function checkAcceptEditsMode(
  toolName: string,
  args: Record<string, unknown>,
  cwd?: string,
): DecisionResult | null {
  const fileWriteTools = ['write_file', 'edit_file'];
  if (!fileWriteTools.includes(toolName)) {
    // Read-only tools allowed in acceptEdits mode
    return {
      allowed: true,
      behavior: 'allow',
      reason: `Permission mode: acceptEdits (read-only tool "${toolName}")`,
      decidedBy: 'mode_accept_edits',
    };
  }

  // For write tools, check if target path is within cwd
  if (cwd) {
    const filePath = extractFilePath(args);
    if (filePath) {
      const normalizedCwd = cwd.toLowerCase().replace(/\\/g, '/');
      const normalizedPath = filePath.toLowerCase().replace(/\\/g, '/');
      const absolutePath = normalizedPath.startsWith('/') || /^[a-z]:/i.test(normalizedPath)
        ? normalizedPath
        : `${normalizedCwd}/${normalizedPath}`;

      if (absolutePath.startsWith(normalizedCwd)) {
        return {
          allowed: true,
          behavior: 'allow',
          reason: `Permission mode: acceptEdits (write tool "${toolName}" within cwd)`,
          decidedBy: 'mode_accept_edits',
        };
      }
    }
  }

  // Write tool outside cwd — deny in acceptEdits mode
  return {
    allowed: false,
    behavior: 'deny',
    reason: `Tool "${toolName}" blocked in acceptEdits mode: target path is outside cwd "${cwd ?? 'unknown'}"`,
    decidedBy: 'mode_accept_edits',
  };
}

/** Check allow rules — first match wins. */
function checkAllowRules(
  toolName: string,
  args: Record<string, unknown>,
  rules: PermissionRule[],
): DecisionResult | null {
  for (const rule of rules) {
    if (rule.behavior !== 'allow') continue;
    if (!matchesTool(rule, toolName)) continue;
    if (rule.content && !matchesContent(rule, args)) continue;

    return {
      allowed: true,
      behavior: 'allow',
      reason: `Tool "${toolName}" allowed by rule${rule.content ? ` matching "${rule.content}"` : ''} (source: ${rule.source})`,
      decidedBy: 'always_allow',
    };
  }
  return null;
}

// ── Matching Helpers ──

/** Check if a rule matches a tool name (exact match or wildcard suffix). */
function matchesTool(rule: PermissionRule, toolName: string): boolean {
  if (rule.toolName === toolName) return true;
  // Wildcard: "Bash*" matches "Bash", "BashShell", etc.
  if (rule.toolName.endsWith('*')) {
    const prefix = rule.toolName.slice(0, -1);
    return toolName.startsWith(prefix);
  }
  return false;
}

/** Check if rule's content filter matches tool arguments. */
function matchesContent(rule: PermissionRule, args: Record<string, unknown>): boolean {
  if (!rule.content) return true;

  // Serialize all args for content matching
  const argsStr = JSON.stringify(args).toLowerCase();
  const content = rule.content.toLowerCase();

  if (rule.isWildcard) {
    return argsStr.includes(content);
  }

  return argsStr.includes(content);
}

/** Extract file path from tool args (write_file, edit_file formats). */
function extractFilePath(args: Record<string, unknown>): string | undefined {
  if (typeof args.file_path === 'string') return args.file_path;
  if (typeof args.filePath === 'string') return args.filePath;
  if (typeof args.path === 'string') return args.path;
  return undefined;
}
