// ── Sub-Agent Module Unit Tests ──
// CTO-003 P3T1: Tests for agent definitions, tools resolution, and spawn engine.
// Covers: built-in agents, tools-resolve, spawnAgent, agent type routing.

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  getBuiltInAgents,
  getBuiltInAgent,
  buildAgentCatalog,
  CLAUDE_TOOL_MAP,
  resolveAgentTools,
  filterToolsForAgent,
  buildToolCatalog,
  spawnAgent,
  spawnAgentAndCollect,
} from '../../src/agent-loop/sub-agent/index.js';
import type { AgentDefinition, AgentType, AgentSpawnConfig } from '../../src/agent-loop/sub-agent/types.js';

// ── Built-in Agents Tests ──

describe('Built-in Agents', () => {
  it('has exactly 4 built-in agents', () => {
    const agents = getBuiltInAgents();
    assert.equal(agents.length, 4);
  });

  it('all 4 agent types are unique', () => {
    const agents = getBuiltInAgents();
    const types = new Set(agents.map(a => a.agentType));
    assert.equal(types.size, 4);
  });

  it('getBuiltInAgent returns correct agent by type', () => {
    const gp = getBuiltInAgent('general-purpose');
    assert.ok(gp);
    assert.equal(gp!.agentType, 'general-purpose');
    assert.equal(gp!.tools[0], '*');
  });

  it('getBuiltInAgent returns undefined for unknown type', () => {
    const unknown = getBuiltInAgent('super-agent');
    assert.equal(unknown, undefined);
  });

  it('GeneralPurpose agent has all tools (wildcard)', () => {
    const agent = getBuiltInAgent('general-purpose');
    assert.ok(agent);
    assert.equal(agent!.tools[0], '*');
    assert.equal(agent!.maxTurns, 10);
  });

  it('Explore agent is read-only', () => {
    const agent = getBuiltInAgent('explore');
    assert.ok(agent);
    assert.deepStrictEqual(agent!.tools, ['Read', 'Glob']);
    assert.ok(agent!.disallowedTools);
    assert.ok(agent!.disallowedTools!.includes('Write'));
    assert.ok(agent!.disallowedTools!.includes('Bash'));
    assert.equal(agent!.permissionMode, 'acceptEdits');
    assert.equal(agent!.omitContext, true);
  });

  it('Plan agent is read-only with planning instructions', () => {
    const agent = getBuiltInAgent('plan');
    assert.ok(agent);
    assert.deepStrictEqual(agent!.tools, ['Read', 'Glob']);
    assert.ok(agent!.systemPrompt.includes('step-by-step'));
  });

  it('Verification agent has all tools and runs in background', () => {
    const agent = getBuiltInAgent('verification');
    assert.ok(agent);
    assert.equal(agent!.tools[0], '*');
    assert.equal(agent!.background, true);
    assert.ok(agent!.systemPrompt.includes('PASS'));
    assert.ok(agent!.systemPrompt.includes('FAIL'));
    assert.ok(agent!.systemPrompt.includes('PARTIAL'));
  });

  it('buildAgentCatalog returns all 4 agents formatted', () => {
    const catalog = buildAgentCatalog();
    assert.ok(catalog.includes('general-purpose'));
    assert.ok(catalog.includes('explore'));
    assert.ok(catalog.includes('plan'));
    assert.ok(catalog.includes('verification'));
  });

  it('CLAUDE_TOOL_MAP has correct mappings', () => {
    assert.equal(CLAUDE_TOOL_MAP['Read'], 'read_file');
    assert.equal(CLAUDE_TOOL_MAP['Bash'], 'shell_exec');
    assert.equal(CLAUDE_TOOL_MAP['Glob'], 'glob_search');
    assert.equal(CLAUDE_TOOL_MAP['Write'], 'write_file');
    assert.equal(CLAUDE_TOOL_MAP['Edit'], 'edit_file');
    assert.equal(CLAUDE_TOOL_MAP['Task'], 'task');
  });
});

// ── Tools Resolution Tests ──

describe('resolveAgentTools', () => {
  it("resolves '*' to all subagent-tier tools", () => {
    const agentDef: AgentDefinition = {
      agentType: 'general-purpose',
      whenToUse: 'test',
      systemPrompt: 'test',
      tools: ['*'],
    };
    const tools = resolveAgentTools(agentDef);
    // Subagent tier has 5 tools: read_file, write_file, edit_file, shell_exec, glob_search
    assert.equal(tools.length, 5);
    const names = tools.map(t => t.function.name);
    assert.ok(names.includes('read_file'));
    assert.ok(names.includes('write_file'));
    assert.ok(names.includes('edit_file'));
    assert.ok(names.includes('shell_exec'));
    assert.ok(names.includes('glob_search'));
    // task should NOT be in subagent tier (recursion prevention)
    assert.ok(!names.includes('task'));
  });

  it("resolves '*' with disallowedTools filter", () => {
    const agentDef: AgentDefinition = {
      agentType: 'explore',
      whenToUse: 'test',
      systemPrompt: 'test',
      tools: ['*'],
      disallowedTools: ['Write', 'Edit', 'Bash'],
    };
    const tools = resolveAgentTools(agentDef);
    const names = tools.map(t => t.function.name);
    // Only read_file and glob_search should remain
    assert.ok(names.includes('read_file'));
    assert.ok(names.includes('glob_search'));
    assert.ok(!names.includes('write_file'));
    assert.ok(!names.includes('edit_file'));
    assert.ok(!names.includes('shell_exec'));
  });

  it('resolves explicit Claude Code tool names', () => {
    const agentDef: AgentDefinition = {
      agentType: 'explore',
      whenToUse: 'test',
      systemPrompt: 'test',
      tools: ['Read', 'Glob'],
    };
    const tools = resolveAgentTools(agentDef);
    const names = tools.map(t => t.function.name);
    assert.equal(names.length, 2);
    assert.ok(names.includes('read_file'));
    assert.ok(names.includes('glob_search'));
  });

  it('resolves Bash as shell_exec', () => {
    const agentDef: AgentDefinition = {
      agentType: 'general-purpose',
      whenToUse: 'test',
      systemPrompt: 'test',
      tools: ['Bash'],
    };
    const tools = resolveAgentTools(agentDef);
    assert.equal(tools.length, 1);
    assert.equal(tools[0].function.name, 'shell_exec');
  });

  it('resolves Write as write_file', () => {
    const agentDef: AgentDefinition = {
      agentType: 'general-purpose',
      whenToUse: 'test',
      systemPrompt: 'test',
      tools: ['Write'],
    };
    const tools = resolveAgentTools(agentDef);
    assert.equal(tools.length, 1);
    assert.equal(tools[0].function.name, 'write_file');
  });

  it('resolves Edit as edit_file', () => {
    const agentDef: AgentDefinition = {
      agentType: 'general-purpose',
      whenToUse: 'test',
      systemPrompt: 'test',
      tools: ['Edit'],
    };
    const tools = resolveAgentTools(agentDef);
    assert.equal(tools.length, 1);
    assert.equal(tools[0].function.name, 'edit_file');
  });

  it('strips sub-command syntax from Bash(git:*)', () => {
    const agentDef: AgentDefinition = {
      agentType: 'general-purpose',
      whenToUse: 'test',
      systemPrompt: 'test',
      tools: ['Bash(git:*)'],
    };
    const tools = resolveAgentTools(agentDef);
    assert.equal(tools.length, 1);
    assert.equal(tools[0].function.name, 'shell_exec');
  });

  it('strips sub-command syntax from Bash(npm:*)', () => {
    const agentDef: AgentDefinition = {
      agentType: 'general-purpose',
      whenToUse: 'test',
      systemPrompt: 'test',
      tools: ['Bash(npm:*)'],
    };
    const tools = resolveAgentTools(agentDef);
    assert.equal(tools.length, 1);
    assert.equal(tools[0].function.name, 'shell_exec');
  });

  it('handles already-resolved TriMC tool names passed through', () => {
    const agentDef: AgentDefinition = {
      agentType: 'general-purpose',
      whenToUse: 'test',
      systemPrompt: 'test',
      tools: ['read_file', 'shell_exec'],
    };
    const tools = resolveAgentTools(agentDef);
    const names = tools.map(t => t.function.name);
    assert.equal(names.length, 2);
    assert.ok(names.includes('read_file'));
    assert.ok(names.includes('shell_exec'));
  });

  it('case-insensitive fallback for tool names', () => {
    const agentDef: AgentDefinition = {
      agentType: 'general-purpose',
      whenToUse: 'test',
      systemPrompt: 'test',
      tools: ['read', 'bash'],
    };
    const tools = resolveAgentTools(agentDef);
    const names = tools.map(t => t.function.name);
    assert.equal(names.length, 2);
    assert.ok(names.includes('read_file'));
    assert.ok(names.includes('shell_exec'));
  });

  it('returns empty array for unrecognized tool names', () => {
    const agentDef: AgentDefinition = {
      agentType: 'general-purpose',
      whenToUse: 'test',
      systemPrompt: 'test',
      tools: ['UnknownTool', 'FakeThing'],
    };
    const tools = resolveAgentTools(agentDef);
    assert.equal(tools.length, 0);
  });
});

// ── filterToolsForAgent Tests ──

describe('filterToolsForAgent', () => {
  it('returns tools unchanged when no disallowedTools', () => {
    const agentDef: AgentDefinition = {
      agentType: 'general-purpose',
      whenToUse: 'test',
      systemPrompt: 'test',
      tools: ['*'],
    };
    const tools = resolveAgentTools(agentDef);
    const filtered = filterToolsForAgent(tools, agentDef);
    assert.equal(filtered.length, tools.length);
  });

  it('filters disallowed tools from resolved list', () => {
    const agentDef: AgentDefinition = {
      agentType: 'explore',
      whenToUse: 'test',
      systemPrompt: 'test',
      tools: ['*'],
      disallowedTools: ['Write', 'Edit', 'Bash'],
    };
    const allTools = resolveAgentTools({ ...agentDef, disallowedTools: undefined });
    const filtered = filterToolsForAgent(allTools, agentDef);
    const names = filtered.map(t => t.function.name);
    assert.ok(!names.includes('write_file'));
    assert.ok(!names.includes('edit_file'));
    assert.ok(!names.includes('shell_exec'));
  });
});

// ── buildToolCatalog Tests ──

describe('buildToolCatalog', () => {
  it('returns human-readable tool list', () => {
    const agentDef: AgentDefinition = {
      agentType: 'explore',
      whenToUse: 'test',
      systemPrompt: 'test',
      tools: ['Read', 'Glob'],
    };
    const tools = resolveAgentTools(agentDef);
    const catalog = buildToolCatalog(tools);
    assert.ok(catalog.includes('read_file'));
    assert.ok(catalog.includes('glob_search'));
    assert.ok(catalog.includes('Available tools:'));
  });

  it('returns empty message for no tools', () => {
    const catalog = buildToolCatalog([]);
    assert.equal(catalog, 'No tools available.');
  });
});

// ── spawnAgent Tests (unit — no actual LLM calls) ──

describe('spawnAgent', () => {
  it('errors immediately for unknown agent type', async () => {
    const config: AgentSpawnConfig = {
      agentType: 'nonexistent' as AgentType,
      prompt: 'test task',
      description: 'test',
    };

    let errorCount = 0;
    for await (const event of spawnAgent(config)) {
      if (event.type === 'subagent_error') {
        errorCount++;
        assert.ok(event.error.includes('Unknown agent type'));
        assert.ok(event.error.includes('nonexistent'));
      }
      // Should not get a subagent_done event
      assert.notEqual(event.type, 'subagent_done');
    }
    assert.equal(errorCount, 1);
  });

  it('emits subagent_start event with correct metadata', async () => {
    const config: AgentSpawnConfig = {
      agentType: 'explore',
      prompt: 'Find all TypeScript files',
      description: 'search ts files',
      maxTurns: 2,  // Keep it short for test
    };

    let gotStart = false;
    for await (const event of spawnAgent(config)) {
      if (event.type === 'subagent_start') {
        gotStart = true;
        assert.equal(event.agentType, 'explore');
        assert.equal(event.description, 'search ts files');
        assert.ok(event.agentId);
        assert.ok(event.agentId.startsWith('ex-'));
      }
      // Break early — we only care about the start event
      if (event.type !== 'subagent_start') break;
    }
    assert.equal(gotStart, true);
  });

  it('uses correct agent prefix IDs', async () => {
    const prefixes: Record<AgentType, string> = {
      'general-purpose': 'gp-',
      'explore': 'ex-',
      'plan': 'pl-',
      'verification': 'vf-',
    };

    for (const [agentType, prefix] of Object.entries(prefixes) as [AgentType, string][]) {
      const config: AgentSpawnConfig = {
        agentType,
        prompt: 'test',
        description: 'test',
        maxTurns: 1,
      };
      for await (const event of spawnAgent(config)) {
        if (event.type === 'subagent_start') {
          assert.ok(event.agentId.startsWith(prefix), `${agentType} ID should start with ${prefix}, got ${event.agentId}`);
          break;
        }
        break;
      }
    }
  });
});

// ── spawnAgentAndCollect Tests ──

describe('spawnAgentAndCollect', () => {
  it('returns error result for unknown agent type', async () => {
    const config: AgentSpawnConfig = {
      agentType: 'nonexistent' as AgentType,
      prompt: 'test task',
      description: 'test',
    };

    const result = await spawnAgentAndCollect(config);
    assert.equal(result.agentType, 'nonexistent');
    assert.ok(result.error);
    assert.ok(result.error!.includes('Unknown agent type'));
    assert.equal(result.toolCallsMade, 0);
  });
});
