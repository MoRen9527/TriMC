// Built-in sub-agent definitions
// Shared between TriMC and TriLC

import type { AgentDefinition } from './types.js';

const BUILT_IN_AGENTS: Record<string, AgentDefinition> = {
  code_explorer: {
    name: 'code_explorer',
    description: 'Explores codebases to answer questions about structure, dependencies, and implementation details',
    tools: ['read_file', 'glob_search', 'search_code'],
    systemPrompt: 'You are a code exploration agent. Read and analyze code to answer questions about structure and implementation.',
    maxTurns: 20,
    tier: 'subagent',
  },
  test_runner: {
    name: 'test_runner',
    description: 'Runs tests and reports results',
    tools: ['shell_exec', 'read_file'],
    systemPrompt: 'You are a test execution agent. Run tests, analyze failures, and report results.',
    maxTurns: 15,
    tier: 'subagent',
  },
  file_processor: {
    name: 'file_processor',
    description: 'Processes files in batch — read, transform, and write',
    tools: ['read_file', 'write_file', 'edit_file', 'glob_search'],
    systemPrompt: 'You are a file processing agent. Handle batch file operations safely and efficiently.',
    maxTurns: 30,
    tier: 'main',
  },
  code_reviewer: {
    name: 'code_reviewer',
    description: 'Reviews code changes for quality, security, and best practices',
    tools: ['read_file', 'glob_search', 'search_code'],
    systemPrompt: 'You are a code review agent. Review changes for correctness, security, and adherence to best practices.',
    maxTurns: 25,
    tier: 'subagent',
  },
};

export function getBuiltInAgent(name: string): AgentDefinition | undefined {
  return BUILT_IN_AGENTS[name];
}

export function listBuiltInAgents(): AgentDefinition[] {
  return Object.values(BUILT_IN_AGENTS);
}
