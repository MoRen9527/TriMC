// ── Safety Check ──
// CTO-003 P4T1: Absorbed from Claude Code 2.1.88 vendor (permissions.ts Step 1g).
// Bypass-immune safety checks that fire in ALL permission modes.
// These protect critical project infrastructure regardless of mode.

import type { SafetyCheckResult } from './types.js';

// ── Sensitive Paths ──

/** Paths/substrings that trigger bypass-immune safety check for file operations. */
const SENSITIVE_PATHS = [
  '.git/',
  '.git\\',
  '.claude/',
  '.claude\\',
];

/** Shell config files that trigger bypass-immune safety check. */
const SHELL_CONFIGS = [
  '.bashrc',
  '.bash_profile',
  '.profile',
  '.zshrc',
  '.zprofile',
  '.zshenv',
  '.config/fish/',
  'profile.ps1',
  'Microsoft.PowerShell_profile.ps1',
  'Microsoft.PowerShellISE_profile.ps1',
  'Microsoft.VSCode_profile.ps1',
];

// ── Tool-Specific Safety Checks ──

/** Tools that can modify files — subject to sensitive path safety check. */
const FILE_MODIFYING_TOOLS = new Set([
  'write_file',
  'edit_file',
]);

/** Shell execution tool name. */
const SHELL_TOOL = 'shell_exec';

/** Agent spawn tool name. */
const TASK_TOOL = 'task';

// ── Safety Check Logic ──

/**
 * Run bypass-immune safety checks for a tool invocation.
 *
 * These checks fire in ALL permission modes (including bypassPermissions).
 * They protect critical infrastructure: .git/, .claude/, shell configs.
 *
 * @returns SafetyCheckResult with triggered=true if the operation needs explicit confirmation.
 */
export function runSafetyCheck(
  toolName: string,
  args: Record<string, unknown>,
): SafetyCheckResult {
  // File-modifying tools: check for sensitive paths
  if (FILE_MODIFYING_TOOLS.has(toolName)) {
    const pathResult = checkSensitiveFilePaths(args);
    if (pathResult.triggered) return pathResult;
  }

  // C10: MCP tools — check args for sensitive paths (bypass-immune).
  // MCP tools proxy to external servers that may have write capability;
  // the safety check inspects args for .git/, .claude/, etc. substrings.
  if (toolName.startsWith('mcp__')) {
    const mcpResult = checkMcpSensitivePaths(toolName, args);
    if (mcpResult.triggered) return mcpResult;
  }

  // Shell execution: check for shell config modifications
  if (toolName === SHELL_TOOL) {
    const shellResult = checkShellConfigAccess(args);
    if (shellResult.triggered) return shellResult;
  }

  // Agent spawn: always requires extra scrutiny in any mode
  if (toolName === TASK_TOOL) {
    // In bypassPermissions mode, sub-agent spawn could lead to uncontrolled operations
    // This is a bypass-immune check: even with bypassPermissions, spawning agents always asks
    return { triggered: false }; // Tier 2: add prompt confirmation
  }

  return { triggered: false };
}

// ── C10: MCP Sensitive Path Detection ──

/** C10: Check MCP tool args for sensitive path substrings. */
function checkMcpSensitivePaths(toolName: string, args: Record<string, unknown>): SafetyCheckResult {
  const argsStr = JSON.stringify(args).toLowerCase().replace(/\\/g, '/');

  // Sensitive paths that should trigger safety check even for MCP tools
  const mcpSensitivePatterns = [
    '.git/',
    '.claude/',
    '.github/',
    '.ssh/',
    'authorized_keys',
    'id_rsa',
    'id_ed25519',
    '.env',
    'credentials',
    'secret',
    '/etc/passwd',
    '/etc/shadow',
  ];

  for (const pattern of mcpSensitivePatterns) {
    if (argsStr.includes(pattern.toLowerCase())) {
      return {
        triggered: true,
        reason: `MCP tool "${toolName}" arguments reference sensitive path/key "${pattern}". Blocked by bypass-immune safety check.`,
      };
    }
  }

  return { triggered: false };
}

// ── Sensitive File Path Detection ──

function checkSensitiveFilePaths(args: Record<string, unknown>): SafetyCheckResult {
  const filePath = extractFilePath(args);

  if (!filePath) return { triggered: false };

  const normalized = filePath.toLowerCase().replace(/\\/g, '/');

  for (const sensitive of SENSITIVE_PATHS) {
    const normalizedSensitive = sensitive.toLowerCase().replace(/\\/g, '/');
    if (normalized.includes(normalizedSensitive)) {
      return {
        triggered: true,
        reason: `Operation targets sensitive path "${sensitive}". This requires explicit confirmation in all modes (bypass-immune safety check).`,
      };
    }
  }

  return { triggered: false };
}

// ── Shell Config Access Detection ──

function checkShellConfigAccess(args: Record<string, unknown>): SafetyCheckResult {
  const command = extractShellCommand(args);

  if (!command) return { triggered: false };

  const normalized = command.toLowerCase().replace(/\\/g, '/');

  for (const config of SHELL_CONFIGS) {
    const normalizedConfig = config.toLowerCase().replace(/\\/g, '/');
    if (normalized.includes(normalizedConfig)) {
      return {
        triggered: true,
        reason: `Shell command references config file "${config}". Modifying shell configs requires explicit confirmation in all modes (bypass-immune safety check).`,
      };
    }
  }

  // Also check for dangerous shell patterns
  if (/\brm\s+-rf\s+\//.test(normalized) || /\brm\s+-rf\s+~/.test(normalized)) {
    return {
      triggered: true,
      reason: 'Shell command attempts recursive forced removal from root/home. Blocked by safety check.',
    };
  }

  return { triggered: false };
}

// ── Argument Extraction Helpers ──

/** Extract file path from tool arguments (handles common patterns). */
function extractFilePath(args: Record<string, unknown>): string | undefined {
  // write_file: { file_path, content }
  if (typeof args.file_path === 'string') return args.file_path;
  // edit_file: { file_path, old_string, new_string }
  if (typeof args.filePath === 'string') return args.filePath;
  // Generic: { path }
  if (typeof args.path === 'string') return args.path;
  return undefined;
}

/** Extract shell command from tool arguments. */
function extractShellCommand(args: Record<string, unknown>): string | undefined {
  // shell_exec: { command }
  if (typeof args.command === 'string') return args.command;
  // Generic: { cmd }
  if (typeof args.cmd === 'string') return args.cmd;
  return undefined;
}
