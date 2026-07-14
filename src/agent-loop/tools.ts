// ── TriMC Agent Loop: Built-in Tool Registry ──
// Phase 1 tools absorbed from Claude Code vendor pattern.
// Tool definitions follow Anthropic-compatible schema (used by TriModel → DeepSeek/OpenAI format).
// CTO-008: Added tier-based permission system (filterToolsForTier).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import type { ToolDefinition, Message } from 'trimodel';
import { agentLoop } from './loop.js';
import { filterToolsForTier, type AgentTier } from './permissions.js';

const execAsync = promisify(execCb);

// ── Tool Result Types ──

export interface ToolResult {
  tool_call_id: string;
  content: string;
  is_error?: boolean;
}

// ── Tool Handler Type ──

export type ToolHandler = (args: Record<string, unknown>) => Promise<string>;

// ── Built-in Tool Registry ──

const toolRegistry = new Map<string, { definition: ToolDefinition; handler: ToolHandler }>();

function register(def: ToolDefinition, handler: ToolHandler) {
  toolRegistry.set(def.function.name, { definition: def, handler: handler });
}

export function getToolDefinitions(tier?: AgentTier): ToolDefinition[] {
  const allDefs = Array.from(toolRegistry.values()).map((t) => t.definition);
  if (!tier || tier === 'main') return allDefs;
  return filterToolsForTier(allDefs, tier);
}

export async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  const entry = toolRegistry.get(name);
  if (!entry) return JSON.stringify({ error: `unknown tool: ${name}` });
  try {
    return await entry.handler(args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ error: msg });
  }
}

// ── Tool: read_file ──

register(
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file at the given path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the file to read.' },
        },
        required: ['path'],
      },
    },
  },
  async (args) => {
    const path = args.path as string;
    if (!path) return JSON.stringify({ error: 'path is required' });
    const content = await readFile(path, 'utf-8');
    return JSON.stringify({ path, content, size: content.length });
  },
);

// ── Tool: write_file ──

register(
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file, creating parent directories if needed.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the file to write.' },
          content: { type: 'string', description: 'Content to write to the file.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  async (args) => {
    const path = args.path as string;
    const content = args.content as string;
    if (!path || content === undefined) return JSON.stringify({ error: 'path and content are required' });
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf-8');
    return JSON.stringify({ path, written: content.length, ok: true });
  },
);

// ── Tool: edit_file ──

register(
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Replace a specific string in a file. The old_str must match exactly one occurrence.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the file to edit.' },
          old_str: { type: 'string', description: 'The exact string to replace.' },
          new_str: { type: 'string', description: 'The replacement string.' },
        },
        required: ['path', 'old_str', 'new_str'],
      },
    },
  },
  async (args) => {
    const path = args.path as string;
    const oldStr = args.old_str as string;
    const newStr = args.new_str as string;
    if (!path || oldStr === undefined || newStr === undefined) {
      return JSON.stringify({ error: 'path, old_str, and new_str are required' });
    }
    const content = await readFile(path, 'utf-8');
    const count = content.split(oldStr).length - 1;
    if (count === 0) return JSON.stringify({ error: 'old_str not found in file', path });
    if (count > 1) return JSON.stringify({ error: `old_str matches ${count} occurrences — must be unique`, path });
    const newContent = content.replace(oldStr, newStr);
    await writeFile(path, newContent, 'utf-8');
    return JSON.stringify({ path, replaced: true, ok: true });
  },
);

// ── Tool: shell_exec ──
// Phase 2: policy gate with allowlist/denylist

const DEFAULT_ALLOWLIST = [
  'echo', 'ls', 'dir', 'cat', 'type', 'find', 'grep', 'findstr',
  'node', 'npm', 'npx', 'tsx', 'tsc',
  'git', 'python', 'pip', 'go', 'cargo', 'rustc',
  'mkdir', 'rmdir', 'mv', 'move', 'cp', 'copy',
  'wc', 'head', 'tail', 'sort', 'uniq', 'cut', 'awk', 'sed',
  'curl', 'wget', 'nslookup', 'ping',
  'npx', 'pnpm', 'yarn',
  'where', 'which', 'whoami', 'hostname', 'date', 'time', 'pwd', 'cd',
  'printenv', 'env', 'set',
];

const DEFAULT_DENYLIST = [
  'rm -rf', 'rm -r', 'del /s', 'del /q', 'rd /s', 'rd /q',
  'format', 'shutdown', 'reboot', 'init', 'poweroff', 'halt',
  'chmod 777', 'chown',
  'sudo', 'su',
  ':(){ :|:& };:', // fork bomb
  'dd if=', 'mkfs', 'fdisk', 'parted',
  '> /dev/sda', '> /dev/nvme',
  'net user', 'net localgroup',
  'reg add', 'reg delete',
  'sc stop', 'sc config',
  'taskkill', 'Stop-Process',
];

function parsePolicyList(envVar: string | undefined): string[] {
  if (!envVar) return [];
  return envVar.split(',').map((s) => s.trim()).filter(Boolean);
}

function checkShellPolicy(command: string): { allowed: boolean; reason?: string } {
  const allowlistStr = process.env.TRIMC_SHELL_ALLOWLIST;
  const denylistStr = process.env.TRIMC_SHELL_DENYLIST;

  const allowlist = allowlistStr ? parsePolicyList(allowlistStr) : DEFAULT_ALLOWLIST;
  const denylist = denylistStr ? parsePolicyList(denylistStr) : DEFAULT_DENYLIST;

  const cmdLower = command.toLowerCase().trim();
  const baseCmd = cmdLower.split(/\s+/)[0];

  // 1. Denylist check (exact or pattern match)
  for (const blocked of denylist) {
    if (cmdLower === blocked || cmdLower.startsWith(blocked + ' ')) {
      return { allowed: false, reason: `blocked by denylist: "${blocked}"` };
    }
  }

  // 2. Allowlist check (base command match)
  const inAllowlist = allowlist.some(
    (allowed) => baseCmd === allowed || baseCmd.endsWith(`\\${allowed}`) || baseCmd.endsWith(`/${allowed}`)
  );

  if (!inAllowlist) {
    return { allowed: false, reason: `command "${baseCmd}" not in allowlist` };
  }

  return { allowed: true };
}

register(
  {
    type: 'function',
    function: {
      name: 'shell_exec',
      description:
        'Execute a shell command and return stdout+stderr. Commands are validated against a security policy (allowlist/denylist). Capped at 30s timeout.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute.' },
          cwd: { type: 'string', description: 'Working directory for the command.' },
        },
        required: ['command'],
      },
    },
  },
  async (args) => {
    const command = args.command as string;
    const cwd = (args.cwd as string) || process.cwd();
    if (!command) return JSON.stringify({ error: 'command is required' });

    // ── Policy gate check ──
    const policy = checkShellPolicy(command);
    if (!policy.allowed) {
      return JSON.stringify({ error: policy.reason, command: command.slice(0, 200) });
    }

    try {
      const { stdout, stderr } = await execAsync(command, { cwd, timeout: 30_000, maxBuffer: 1024 * 1024 });
      return JSON.stringify({
        stdout: stdout.slice(0, 50_000),
        stderr: stderr.slice(0, 10_000),
        exit_code: 0,
      });
    } catch (err: unknown) {
      const execErr = err as { stdout?: string; stderr?: string; code?: number; message?: string };
      return JSON.stringify({
        stdout: (execErr.stdout || '').slice(0, 50_000),
        stderr: (execErr.stderr || execErr.message || '').slice(0, 10_000),
        exit_code: execErr.code ?? 1,
      });
    }
  },
);

// ── Tool: glob_search ──

register(
  {
    type: 'function',
    function: {
      name: 'glob_search',
      description: 'Search for files matching a glob pattern in a directory.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern to match (e.g. **/*.ts).' },
          path: { type: 'string', description: 'Directory to search in (defaults to cwd).' },
        },
        required: ['pattern'],
      },
    },
  },
  async (args) => {
    const pattern = args.pattern as string;
    const basePath = (args.path as string) || process.cwd();
    if (!pattern) return JSON.stringify({ error: 'pattern is required' });

    const results: string[] = [];
    const parts = pattern.replace(/\\/g, '/').split('/');

    function walk(dir: string, partIndex: number) {
      if (partIndex >= parts.length) return;
      const part = parts[partIndex];

      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (part === '**') {
            if (partIndex === parts.length - 1) {
              results.push(relative(basePath, resolve(dir, entry.name)));
            } else {
              const nextPart = parts[partIndex + 1];
              if (entry.name === nextPart || nextPart === '*') {
                walk(resolve(dir, entry.name), partIndex + 2);
              }
            }
            if (entry.isDirectory()) {
              walk(resolve(dir, entry.name), partIndex);
            }
          } else if (part === '*') {
            if (partIndex === parts.length - 1) {
              results.push(relative(basePath, resolve(dir, entry.name)));
            } else if (entry.isDirectory() && entry.name === parts[partIndex + 1]) {
              walk(resolve(dir, entry.name), partIndex + 2);
            }
          } else if (entry.name === part) {
            if (partIndex === parts.length - 1) {
              results.push(relative(basePath, resolve(dir, entry.name)));
            } else if (entry.isDirectory()) {
              walk(resolve(dir, entry.name), partIndex + 1);
            }
          }
        }
      } catch {
        // Directory doesn't exist — no results
      }
    }

    walk(basePath, 0);
    return JSON.stringify({ pattern, base: basePath, matches: results.slice(0, 200) });
  },
);

// ── Tool: task (sub-agent dispatch) ──

register(
  {
    type: 'function',
    function: {
      name: 'task',
      description:
        'Launch a sub-agent to handle a complex multi-step task autonomously. The sub-agent runs with restricted permissions (5 tools: read/write/edit, shell, glob — no task to prevent recursion) for up to 10 turns. Returns the sub-agent final result.',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'Short description of the task (3-5 words).' },
          prompt: { type: 'string', description: 'The full task description for the sub-agent.' },
          subagent_type: { type: 'string', description: 'Optional type hint for the sub-agent (e.g. "explore", "plan", "code").' },
        },
        required: ['description', 'prompt'],
      },
    },
  },
  async (args) => {
    const description = args.description as string;
    const prompt = args.prompt as string;
    if (!description || !prompt) {
      return JSON.stringify({ error: 'description and prompt are required' });
    }

    const subMessages: Message[] = [{ role: 'user', content: prompt }];
    const events: Array<{ type: string; content?: string }> = [];
    let finalContent: string | null = null;
    let toolCallsMade = 0;
    let errorMessage: string | null = null;

    try {
      for await (const event of agentLoop({
        model: 'deepseek-v4-pro',
        tier: 'subagent', // CTO-009: enforce subagent tool restrictions
        systemPrompt: `You are a sub-agent executing a specific task. Focus only on completing the assigned task. When done, return your final result concisely. Do not ask follow-up questions — just complete the task.`,
        messages: subMessages,
        maxTurns: 10,
      })) {
        events.push({ type: event.type, ...(event as Record<string, unknown>) } as never);
        if (event.type === 'assistant_message' && event.content) {
          finalContent = event.content;
        }
        if (event.type === 'tool_call') {
          toolCallsMade++;
        }
        if (event.type === 'tool_blocked') {
          errorMessage = `[tier:subagent] blocked tool "${event.tool_name}": ${event.reason}`;
        }
        if (event.type === 'error') {
          errorMessage = event.message;
        }
      }

      return JSON.stringify({
        ok: true,
        description,
        tool_calls_made: toolCallsMade,
        events_count: events.length,
        content: finalContent ?? '(no output)',
        error: errorMessage,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({
        error: `sub-agent failed: ${msg}`,
        description,
        content: finalContent,
      });
    }
  },
);
