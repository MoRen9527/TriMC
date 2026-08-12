// ── 10-Step Decision Pipeline (C8 extended) ──
// CTO-003 P4T1: Absorbed from Claude Code 2.1.88 vendor (permissions.ts).
// Ordered decision pipeline that processes tool invocations through
// deny → ask → safety → mode(bypass/auto/dontAsk/plan/acceptEdits) → allow → default-deny chain.
//
// Non-interactive modes (dontAsk, plan, auto): 'ask' rules are treated as deterministic deny
// because there is no user interaction channel to resolve the confirmation.
//
// Shared between TriMC and TriLC via agent-core.

import type { DecisionResult, PermissionMode, PermissionRule } from './types.js';
import { RULE_SOURCE_PRIORITY } from './types.js';
import { runSafetyCheck } from './safety-check.js';

// ── Pipeline ──

/**
 * Run the full decision pipeline for a tool invocation.
 *
 * Steps (in order):
 *   1. Always-deny rules (highest priority)
 *   2. Always-ask rules (non-interactive modes → deny)
 *   3. Safety check (bypass-immune — fires in ALL modes)
 *   4. Mode: bypassPermissions → allow all non-safety-flagged
 *   5. Mode: auto → same as bypassPermissions
 *   6. Mode: dontAsk → auto-allow within cwd, deny shell + outside-cwd writes
 *   7. Mode: plan → read-only (deny writes, allow reads)
 *   8. Mode: acceptEdits → restrict write tools to cwd
 *   9. Always-allow rules
 *  10. Default deny (fail closed)
 *
 * Non-interactive guarantee (C8): In dontAsk/plan/auto modes, matched 'ask'
 * rules are converted to deterministic 'deny' because there is no user
 * interaction channel to resolve the confirmation.
 *
 * @param toolName - Name of the tool being invoked
 * @param args - Tool arguments for content matching and safety checks
 * @param mode - Current permission mode
 * @param rules - Sorted rules (highest source priority first)
 * @param cwd - Current working directory for acceptEdits/dontAsk path checks
 */
export function runDecisionPipeline(
  toolName: string,
  args: Record<string, unknown>,
  mode: PermissionMode,
  rules: PermissionRule[],
  cwd?: string,
  additionalDirectories?: string[],
): DecisionResult {
  // Pre-sort rules by source priority
  const sorted = sortRulesByPriority(rules);

  // ── Step 1: Always-deny rules ──
  const denyResult = checkDenyRules(toolName, args, sorted);
  if (denyResult) return denyResult;

  // ── Step 2: Always-ask rules ──
  // C8: In non-interactive modes, 'ask' rules cannot be resolved because
  // there is no user interaction channel → convert to deterministic 'deny'.
  const askResult = checkAskRules(toolName, args, sorted);
  if (askResult) {
    const nonInteractiveModes: PermissionMode[] = ['dontAsk', 'plan', 'auto'];
    if (nonInteractiveModes.includes(mode)) {
      const decidedBy = (
        mode === 'dontAsk' ? 'mode_dont_ask' :
        mode === 'plan' ? 'mode_plan' : 'mode_auto'
      ) as DecisionResult['decidedBy'];
      return {
        allowed: false,
        behavior: 'deny',
        reason: `Tool "${toolName}" requires confirmation but mode "${mode}" is non-interactive — denied (ask rule: ${askResult.reason})`,
        decidedBy,
      };
    }
    return askResult;
  }

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

  // ── Step 5: Mode — auto (C8) ──
  // Same behavior as bypassPermissions: allow all non-safety-flagged tools.
  // Semantically distinct for audit trail (decidedBy: mode_auto vs mode_bypass).
  if (mode === 'auto') {
    return {
      allowed: true,
      behavior: 'allow',
      reason: 'Permission mode: auto',
      decidedBy: 'mode_auto',
    };
  }

  // ── Step 6: Mode — dontAsk (C8) ──
  // Non-interactive, cwd-scoped. Auto-allow within cwd/additionalDirs;
  // deny shell + outside-boundary file tools.
  if (mode === 'dontAsk') {
    const dontAskResult = checkDontAskMode(toolName, args, cwd, additionalDirectories);
    if (dontAskResult) return dontAskResult;
  }

  // ── Step 7: Mode — plan (C8) ──
  // Non-interactive, read-only. All write tools blocked; read/search tools allowed.
  if (mode === 'plan') {
    const planResult = checkPlanMode(toolName, args);
    if (planResult) return planResult;
  }

  // ── Step 8: Mode — acceptEdits ──
  if (mode === 'acceptEdits') {
    const editResult = checkAcceptEditsMode(toolName, args, cwd, additionalDirectories);
    if (editResult) return editResult;
  }

  // ── Step 9: Always-allow rules ──
  const allowResult = checkAllowRules(toolName, args, sorted);
  if (allowResult) return allowResult;

  // ── Step 10: Default deny ──
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

/** C9: Normalize a path for case-insensitive boundary comparison (Windows-safe). */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

/** C9: Check if a tool's file target is within the allowed boundary (cwd + additionalDirs). */
function isPathInBoundary(
  filePath: string,
  cwd: string,
  additionalDirectories?: string[],
): boolean {
  const normalizedTarget = normalizePath(filePath);
  const absoluteTarget = normalizedTarget.startsWith('/') || /^[a-z]:/i.test(normalizedTarget)
    ? normalizedTarget
    : `${normalizePath(cwd)}/${normalizedTarget}`;

  const boundaries = [normalizePath(cwd), ...(additionalDirectories ?? []).map(normalizePath)];
  return boundaries.some((b) => absoluteTarget.startsWith(b));
}

/** Check mode: acceptEdits — restrict writes to cwd + additionalDirs. */
function checkAcceptEditsMode(
  toolName: string,
  args: Record<string, unknown>,
  cwd?: string,
  additionalDirectories?: string[],
): DecisionResult | null {
  const fileWriteTools = ['write_file', 'edit_file'];
  if (!fileWriteTools.includes(toolName)) {
    return {
      allowed: true,
      behavior: 'allow',
      reason: `Permission mode: acceptEdits (read-only tool "${toolName}")`,
      decidedBy: 'mode_accept_edits',
    };
  }

  if (cwd) {
    const filePath = extractFilePath(args);
    if (filePath && isPathInBoundary(filePath, cwd, additionalDirectories)) {
      return {
        allowed: true,
        behavior: 'allow',
        reason: `Permission mode: acceptEdits (write tool "${toolName}" within boundary)`,
        decidedBy: 'mode_accept_edits',
      };
    }
  }

  return {
    allowed: false,
    behavior: 'deny',
    reason: `Tool "${toolName}" blocked in acceptEdits mode: target path is outside boundary (cwd: "${cwd ?? 'unknown'}")`,
    decidedBy: 'mode_accept_edits',
  };
}

/** C8/C9: Mode dontAsk — cwd-scoped auto-allow, deterministic non-interactive. */
function checkDontAskMode(
  toolName: string,
  args: Record<string, unknown>,
  cwd?: string,
  additionalDirectories?: string[],
): DecisionResult | null {
  // Shell tools always blocked — no boundary guarantee possible
  const shellTools = ['shell_exec', 'Bash'];
  if (shellTools.includes(toolName)) {
    return {
      allowed: false,
      behavior: 'deny',
      reason: `Tool "${toolName}" blocked in dontAsk mode: shell commands require interactive confirmation`,
      decidedBy: 'mode_dont_ask',
    };
  }

  // All file tools (read + write): check boundary
  const fileTools = [
    'write_file', 'edit_file', 'Write', 'Edit', 'replace_in_file',
    'Read', 'Glob', 'Grep', 'LS',
  ];
  if (fileTools.includes(toolName) && cwd) {
    const filePath = extractFilePath(args);
    if (filePath) {
      if (isPathInBoundary(filePath, cwd, additionalDirectories)) {
        return {
          allowed: true,
          behavior: 'allow',
          reason: `Permission mode: dontAsk (tool "${toolName}" within boundary)`,
          decidedBy: 'mode_dont_ask',
        };
      }
      return {
        allowed: false,
        behavior: 'deny',
        reason: `Tool "${toolName}" blocked in dontAsk mode: target path is outside boundary (cwd: "${cwd}")`,
        decidedBy: 'mode_dont_ask',
      };
    }
  }

  // C10: MCP tools that suggest file operations — boundary-check by args.
  // Fall through to auto-allow if not file-like (e.g., mcp__slack__send_message).
  if (isMcpFileTool(toolName) && cwd) {
    const mcpFilePath = extractFilePath(args);
    if (mcpFilePath && isPathInBoundary(mcpFilePath, cwd, additionalDirectories)) {
      return {
        allowed: true,
        behavior: 'allow',
        reason: `Permission mode: dontAsk (MCP file tool "${toolName}" within boundary)`,
        decidedBy: 'mode_dont_ask',
      };
    }
    return {
      allowed: false,
      behavior: 'deny',
      reason: `MCP tool "${toolName}" blocked in dontAsk mode: file operation outside boundary or path not extractable (cwd: "${cwd}")`,
      decidedBy: 'mode_dont_ask',
    };
  }

  // Non-file tools (TaskCreate, SendMessage, etc.): auto-allow
  return {
    allowed: true,
    behavior: 'allow',
    reason: `Permission mode: dontAsk`,
    decidedBy: 'mode_dont_ask',
  };
}

// ── C10: MCP tool classification heuristics ──

/** C10: Check if an MCP tool name suggests write/mutate capability. */
function isMcpWriteTool(toolName: string): boolean {
  if (!toolName.startsWith('mcp__')) return false;
  const bareName = toolName.slice(5).toLowerCase(); // strip 'mcp__' prefix to avoid false matches (e.g. 'cp' in 'mcp__')
  const writeKeywords = ['write', 'edit', 'delete', 'create', 'update', 'remove', 'mkdir', 'rm', 'mv', 'cp', 'rename', 'move', 'copy'];
  return writeKeywords.some((kw) => bareName.includes(kw));
}

/** C10: Check if an MCP tool name suggests file operation capability. */
function isMcpFileTool(toolName: string): boolean {
  if (!toolName.startsWith('mcp__')) return false;
  const bareName = toolName.slice(5).toLowerCase(); // strip 'mcp__' prefix
  const fileKeywords = ['file', 'read', 'write', 'dir', 'path', 'glob', 'grep', 'search', 'list', 'open', 'save'];
  return fileKeywords.some((kw) => bareName.includes(kw));
}

/** C8: Mode plan — read-only, deterministic non-interactive. */
function checkPlanMode(
  toolName: string,
  _args: Record<string, unknown>,
): DecisionResult | null {
  // All write/mutate tools blocked
  const writeTools = [
    'write_file', 'edit_file', 'Write', 'Edit', 'replace_in_file',
    'shell_exec', 'Bash',
  ];
  if (writeTools.includes(toolName)) {
    return {
      allowed: false,
      behavior: 'deny',
      reason: `Tool "${toolName}" blocked in plan mode: write/mutate operations not allowed (read-only mode)`,
      decidedBy: 'mode_plan',
    };
  }

  // C10: MCP tools — classify by name heuristics (conservative: deny on write keywords)
  if (isMcpWriteTool(toolName)) {
    return {
      allowed: false,
      behavior: 'deny',
      reason: `MCP tool "${toolName}" classified as write operation — blocked in plan mode (read-only)`,
      decidedBy: 'mode_plan',
    };
  }

  // Read/search/plan tools allowed
  return {
    allowed: true,
    behavior: 'allow',
    reason: `Permission mode: plan (read-only)`,
    decidedBy: 'mode_plan',
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
