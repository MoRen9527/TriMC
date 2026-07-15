// ── Decision Pipeline ──
// CTO-003 P4T1: Absorbed from Claude Code 2.1.88 vendor (permissions.ts).
// Simplfied 8-step pipeline (from 15-step Claude Code pipeline) for Tier 1 MVP.
//
// Pipeline steps:
//   1. Always Deny  — check deny rules (highest priority)
//   2. Always Ask   — check ask rules
//   3. Safety Check — bypass-immune check (fires in ALL modes)
//   4. Mode Bypass  — bypassPermissions mode → skip remaining checks
//   5. Accept Edits — acceptEdits mode + edit tool + CWD check
//   6. Always Allow — check allow rules + shell prefix/wildcard match
//   7. Default Deny — final fallback

import type { DecisionContext, DecisionResult, PermissionRule } from './types.js';
import { runSafetyCheck } from './safety-check.js';

// ── Pipeline Entry Point ──

/**
 * Run the 8-step permission decision pipeline.
 *
 * @returns DecisionResult with allowed/denied/ask and audit trail.
 */
export function decide(context: DecisionContext): DecisionResult {
  // Sort rules by source priority (highest first) — defensive, engine should pre-sort
  const rules = [...context.rules].sort(
    (a, b) => (b.source === a.source ? 0 : (RULE_SOURCE_SCORE[b.source] ?? 0) - (RULE_SOURCE_SCORE[a.source] ?? 0)),
  );

  // Step 1: Always Deny rules (highest priority — deny overrides everything)
  const denyResult = checkDenyRules(context.toolName, context.toolArgs, rules);
  if (denyResult) return denyResult;

  // Step 2: Always Ask rules (second priority)
  const askResult = checkAskRules(context.toolName, context.toolArgs, rules);
  if (askResult) return askResult;

  // Step 3: Safety Check (bypass-immune — fires even in bypassPermissions mode)
  const safetyResult = runSafetyCheck(context.toolName, context.toolArgs);
  if (safetyResult.triggered) {
    return {
      allowed: false,
      behavior: 'ask',
      reason: safetyResult.reason,
      decidedBy: 'safety_check',
    };
  }

  // Step 4: Bypass Permissions mode — skip remaining checks
  if (context.mode === 'bypassPermissions') {
    return {
      allowed: true,
      behavior: 'allow',
      reason: 'Bypass permissions mode active (safety check passed).',
      decidedBy: 'mode_bypass',
    };
  }

  // Step 5: Accept Edits mode — auto-accept edit tools within CWD
  if (context.mode === 'acceptEdits') {
    const acceptResult = checkAcceptEdits(context.toolName, context.toolArgs, context.cwd);
    if (acceptResult) return acceptResult;
  }

  // Step 6: Always Allow rules — check allow rules with shell matching
  const allowResult = checkAllowRules(context.toolName, context.toolArgs, rules);
  if (allowResult) return allowResult;

  // Step 7: Default — deny by default in Tier 1 (no interactive prompt yet)
  return {
    allowed: false,
    behavior: 'deny',
    reason: `No allow rule matched for "${context.toolName}". Default deny in Tier 1.`,
    decidedBy: 'default_deny',
  };
}

// ── Rule Source Scores (for sorting) ──

const RULE_SOURCE_SCORE: Record<string, number> = {
  userSettings: 100,
  projectSettings: 90,
  localSettings: 80,
  flagSettings: 70,
  policySettings: 60,
  cliArg: 50,
  command: 40,
  session: 30,
};

// ── Rule Matching ──

/** Check if a rule matches a tool invocation by tool name + optional content filter. */
function ruleMatches(rule: PermissionRule, toolName: string, args: Record<string, unknown>): boolean {
  if (rule.toolName !== toolName) return false;

  // No content filter → matches all invocations of this tool
  if (!rule.content) return true;

  // Content filter: check if args contain the content substring
  const argsStr = JSON.stringify(args);
  if (rule.isWildcard) {
    // Wildcard match: content is a prefix (e.g., "curl " matches "curl https://...")
    return argsStr.includes(rule.content);
  }
  // Exact substring match
  return argsStr.includes(rule.content);
}

// ── Step 1: Deny Rules ──

function checkDenyRules(
  toolName: string,
  args: Record<string, unknown>,
  rules: PermissionRule[],
): DecisionResult | null {
  // Check deny rules, but allow higher-priority allow rules to override
  for (const rule of rules) {
    if (rule.behavior === 'deny' && ruleMatches(rule, toolName, args)) {
      // Check if a higher-priority allow rule also matches (source priority beats behavior)
      const denySourceScore = RULE_SOURCE_SCORE[rule.source] ?? 0;
      const hasHigherAllow = rules.some(
        (r) =>
          r.behavior === 'allow' &&
          ruleMatches(r, toolName, args) &&
          (RULE_SOURCE_SCORE[r.source] ?? 0) > denySourceScore,
      );
      if (hasHigherAllow) continue;

      return {
        allowed: false,
        behavior: 'deny',
        reason: `Deny rule from "${rule.source}"${rule.content ? ` matches "${rule.content}"` : ''}.`,
        decidedBy: 'always_deny',
      };
    }
  }
  return null;
}

// ── Step 2: Ask Rules ──

function checkAskRules(
  toolName: string,
  args: Record<string, unknown>,
  rules: PermissionRule[],
): DecisionResult | null {
  for (const rule of rules) {
    if (rule.behavior === 'ask' && ruleMatches(rule, toolName, args)) {
      // Check if a higher-priority rule overrides to allow
      const hasAllowOverride = rules.some(
        (r) =>
          r.behavior === 'allow' &&
          ruleMatches(r, toolName, args) &&
          (RULE_SOURCE_SCORE[r.source] ?? 0) > (RULE_SOURCE_SCORE[rule.source] ?? 0),
      );
      if (hasAllowOverride) continue;

      return {
        allowed: false,
        behavior: 'ask',
        reason: `Ask rule from "${rule.source}"${rule.content ? ` matches "${rule.content}"` : ''}.`,
        decidedBy: 'always_ask',
      };
    }
  }
  return null;
}

// ── Step 5: Accept Edits Mode ──

const EDIT_TOOLS = new Set(['write_file', 'edit_file']);

function checkAcceptEdits(
  toolName: string,
  args: Record<string, unknown>,
  cwd?: string,
): DecisionResult | null {
  // acceptEdits only applies to edit tools
  if (!EDIT_TOOLS.has(toolName)) return null;

  // If we have a CWD, check if the target path is within it
  if (cwd) {
    const filePath = extractFilePath(args);
    if (filePath) {
      const resolved = resolveRelativePath(filePath, cwd);
      const normalizedCwd = cwd.replace(/\\/g, '/').toLowerCase();
      const normalizedPath = resolved.replace(/\\/g, '/').toLowerCase();
      if (normalizedPath.startsWith(normalizedCwd)) {
        return {
          allowed: true,
          behavior: 'allow',
          reason: `Edit tool "${toolName}" within CWD — auto-accepted (acceptEdits mode).`,
          decidedBy: 'mode_accept_edits',
        };
      }
    }
  }

  // acceptEdits without CWD check: auto-accept all edit tools (permissive)
  return {
    allowed: true,
    behavior: 'allow',
    reason: `Edit tool "${toolName}" — auto-accepted (acceptEdits mode, no CWD boundary check).`,
    decidedBy: 'mode_accept_edits',
  };
}

// ── Step 6: Allow Rules ──

function checkAllowRules(
  toolName: string,
  args: Record<string, unknown>,
  rules: PermissionRule[],
): DecisionResult | null {
  for (const rule of rules) {
    if (rule.behavior === 'allow' && ruleMatches(rule, toolName, args)) {
      return {
        allowed: true,
        behavior: 'allow',
        reason: `Allow rule from "${rule.source}"${rule.content ? ` matches "${rule.content}"` : ''}.`,
        decidedBy: 'always_allow',
      };
    }
  }
  return null;
}

// ── Helpers ──

function extractFilePath(args: Record<string, unknown>): string | undefined {
  if (typeof args.file_path === 'string') return args.file_path;
  if (typeof args.filePath === 'string') return args.filePath;
  if (typeof args.path === 'string') return args.path;
  return undefined;
}

function resolveRelativePath(filePath: string, cwd: string): string {
  if (filePath.startsWith('/') || /^[A-Za-z]:\\/.test(filePath)) return filePath;
  // Resolve relative path against CWD
  return `${cwd.replace(/\\/g, '/')}/${filePath}`.replace(/\/+/g, '/');
}
