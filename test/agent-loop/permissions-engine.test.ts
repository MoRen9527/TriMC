// ── PermissionEngine Unit Tests ──
// CTO-003 P4T1: Comprehensive test coverage for the permissions engine.
// Tests: rule parsing, safety checks, decision pipeline (all modes), engine class, edge cases.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionEngine } from '../../src/agent-loop/permissions-engine/index.js';
import { parseRule, parseRules } from '../../src/agent-loop/permissions-engine/rule-parser.js';
import { runSafetyCheck } from '../../src/agent-loop/permissions-engine/safety-check.js';
import { decide } from '../../src/agent-loop/permissions-engine/decision-pipeline.js';
import type { DecisionContext } from '../../src/agent-loop/permissions-engine/types.js';

// ── Rule Parser Tests ──

describe('parseRule', () => {
  it('parses tool-level rule (no content filter)', () => {
    const rule = parseRule('write_file', 'allow', 'userSettings');
    assert.equal(rule.toolName, 'write_file');
    assert.equal(rule.behavior, 'allow');
    assert.equal(rule.source, 'userSettings');
    assert.equal(rule.content, undefined);
  });

  it('parses rule with content filter', () => {
    const rule = parseRule('write_file(src/main.ts)', 'allow', 'projectSettings');
    assert.equal(rule.toolName, 'write_file');
    assert.equal(rule.content, 'src/main.ts');
    assert.equal(rule.behavior, 'allow');
  });

  it('parses Bash() as tool-level rule', () => {
    const rule = parseRule('Bash()', 'deny', 'cliArg');
    assert.equal(rule.toolName, 'Bash');
    assert.equal(rule.content, undefined);
  });

  it('parses Bash(*) as tool-level rule', () => {
    const rule = parseRule('Bash(*)', 'deny', 'cliArg');
    assert.equal(rule.toolName, 'Bash');
    assert.equal(rule.content, undefined);
  });

  it('parses Bash exact command match', () => {
    const rule = parseRule('Bash(git push)', 'allow', 'userSettings');
    assert.equal(rule.toolName, 'Bash');
    assert.equal(rule.content, 'git push');
    assert.equal(rule.isWildcard, undefined);
  });

  it('parses Bash wildcard prefix match', () => {
    const rule = parseRule('Bash(curl *)', 'allow', 'userSettings');
    assert.equal(rule.toolName, 'Bash');
    assert.equal(rule.content, 'curl ');
    assert.equal(rule.isWildcard, true);
  });

  it('parses Bash python prefix with wildcard', () => {
    const rule = parseRule('Bash(python:*)', 'allow', 'userSettings');
    assert.equal(rule.toolName, 'Bash');
    assert.equal(rule.content, 'python:');
    assert.equal(rule.isWildcard, true);
  });

  it('resolves legacy alias FileRead → read_file', () => {
    const rule = parseRule('FileRead(src/data.json)', 'allow', 'userSettings');
    assert.equal(rule.toolName, 'read_file');
  });

  it('resolves legacy alias FileWrite → write_file', () => {
    const rule = parseRule('FileWrite', 'deny', 'projectSettings');
    assert.equal(rule.toolName, 'write_file');
  });

  it('resolves legacy alias Task → task', () => {
    const rule = parseRule('Task', 'allow', 'userSettings');
    assert.equal(rule.toolName, 'task');
  });

  it('resolves legacy alias Grep → glob_search', () => {
    const rule = parseRule('Grep(something)', 'allow', 'userSettings');
    assert.equal(rule.toolName, 'glob_search');
  });

  it('handles escaped parentheses in content', () => {
    const rule = parseRule('Bash(echo \\(test\\))', 'allow', 'userSettings');
    assert.equal(rule.content, 'echo (test)');
  });

  it('handles empty string rule', () => {
    const rule = parseRule('', 'allow', 'session');
    assert.equal(rule.toolName, '');
    assert.equal(rule.content, undefined);
  });
});

describe('parseRules (batch)', () => {
  it('parses multiple rules with same behavior and source', () => {
    const rules = parseRules(['write_file', 'shell_exec(cmd)', 'Bash(git *)'], 'deny', 'cliArg');
    assert.equal(rules.length, 3);
    assert.equal(rules[0].toolName, 'write_file');
    assert.equal(rules[1].toolName, 'shell_exec');
    assert.equal(rules[1].content, 'cmd');
    assert.equal(rules[2].toolName, 'Bash');
    assert.equal(rules[2].isWildcard, true);
  });
});

// ── Safety Check Tests ──

describe('runSafetyCheck', () => {
  it('triggers for write_file targeting .git/', () => {
    const result = runSafetyCheck('write_file', { file_path: '.git/config' });
    assert.equal(result.triggered, true);
    assert.ok(result.reason?.includes('.git/'));
  });

  it('triggers for edit_file targeting .claude/', () => {
    const result = runSafetyCheck('edit_file', { file_path: '.claude/settings.json' });
    assert.equal(result.triggered, true);
    assert.ok(result.reason?.includes('.claude/'));
  });

  it('does NOT trigger for write_file targeting regular file', () => {
    const result = runSafetyCheck('write_file', { file_path: 'src/index.ts' });
    assert.equal(result.triggered, false);
  });

  it('does NOT trigger for read tools (not in FILE_MODIFYING_TOOLS)', () => {
    const result = runSafetyCheck('read_file', { file_path: '.git/config' });
    assert.equal(result.triggered, false);
  });

  it('triggers for shell_exec modifying .bashrc', () => {
    const result = runSafetyCheck('shell_exec', { command: 'echo "alias" >> ~/.bashrc' });
    assert.equal(result.triggered, true);
    assert.ok(result.reason?.includes('.bashrc'));
  });

  it('triggers for shell_exec rm -rf /', () => {
    const result = runSafetyCheck('shell_exec', { command: 'rm -rf / --no-preserve-root' });
    assert.equal(result.triggered, true);
    assert.ok(result.reason?.includes('recursive'));
  });

  it('does NOT trigger for safe shell command', () => {
    const result = runSafetyCheck('shell_exec', { command: 'npm run build' });
    assert.equal(result.triggered, false);
  });

  it('does NOT trigger for no-args case', () => {
    const result = runSafetyCheck('write_file', {});
    assert.equal(result.triggered, false);
  });
});

// ── Decision Pipeline Tests: Default Mode ──

describe('Decision Pipeline: default mode', () => {
  const baseContext: DecisionContext = {
    mode: 'default',
    rules: [],
    toolName: 'write_file',
    toolArgs: { file_path: 'src/app.ts', content: '// test' },
    cwd: '/project',
  };

  it('defaults to deny when no rules are configured', () => {
    const result = decide({ ...baseContext });
    assert.equal(result.allowed, false);
    assert.equal(result.behavior, 'deny');
    assert.equal(result.decidedBy, 'default_deny');
  });

  it('allows tool with matching allow rule', () => {
    const ctx: DecisionContext = {
      ...baseContext,
      rules: [{ toolName: 'write_file', behavior: 'allow', source: 'userSettings' }],
    };
    const result = decide(ctx);
    assert.equal(result.allowed, true);
    assert.equal(result.behavior, 'allow');
    assert.equal(result.decidedBy, 'always_allow');
  });

  it('denies tool with matching deny rule (overrides allow of same priority)', () => {
    const ctx: DecisionContext = {
      ...baseContext,
      rules: [
        { toolName: 'write_file', behavior: 'deny', source: 'userSettings' },
        { toolName: 'write_file', behavior: 'allow', source: 'userSettings' },
      ],
    };
    const result = decide(ctx);
    assert.equal(result.allowed, false);
    assert.equal(result.decidedBy, 'always_deny');
  });

  it('higher-priority allow overrides lower-priority deny', () => {
    const ctx: DecisionContext = {
      ...baseContext,
      rules: [
        { toolName: 'write_file', behavior: 'allow', source: 'userSettings' },  // priority 100
        { toolName: 'write_file', behavior: 'deny', source: 'projectSettings' }, // priority 90
      ],
    };
    const result = decide(ctx);
    assert.equal(result.allowed, true);
    assert.equal(result.decidedBy, 'always_allow');
  });

  it('content-filtered rule only matches when args contain content', () => {
    const ctx: DecisionContext = {
      ...baseContext,
      toolArgs: { file_path: 'src/app.ts', content: 'console.log("hello")' },
      rules: [
        { toolName: 'write_file', content: 'console.log', behavior: 'allow', source: 'userSettings' },
      ],
    };
    const result = decide(ctx);
    assert.equal(result.allowed, true);
  });

  it('content-filtered rule does NOT match when args do not contain content', () => {
    const ctx: DecisionContext = {
      ...baseContext,
      toolArgs: { file_path: 'src/app.ts', content: 'const x = 1' },
      rules: [
        { toolName: 'write_file', content: 'console.log', behavior: 'allow', source: 'userSettings' },
      ],
    };
    const result = decide(ctx);
    assert.equal(result.allowed, false);
    assert.equal(result.decidedBy, 'default_deny');
  });

  it('safety check blocks write to .git/ even with allow rule', () => {
    const ctx: DecisionContext = {
      ...baseContext,
      toolArgs: { file_path: '.git/config' },
      rules: [
        { toolName: 'write_file', behavior: 'allow', source: 'userSettings' },
      ],
    };
    const result = decide(ctx);
    assert.equal(result.allowed, false);
    assert.equal(result.behavior, 'ask');
    assert.equal(result.decidedBy, 'safety_check');
  });
});

// ── Decision Pipeline Tests: bypassPermissions Mode ──

describe('Decision Pipeline: bypassPermissions mode', () => {
  const baseContext: DecisionContext = {
    mode: 'bypassPermissions',
    rules: [],
    toolName: 'shell_exec',
    toolArgs: { command: 'npm install' },
    cwd: '/project',
  };

  it('allows any tool in bypassPermissions mode', () => {
    const result = decide({ ...baseContext });
    assert.equal(result.allowed, true);
    assert.equal(result.decidedBy, 'mode_bypass');
  });

  it('still blocks via safety check (bypass-immune)', () => {
    const ctx: DecisionContext = {
      ...baseContext,
      toolName: 'write_file',
      toolArgs: { file_path: '.git/config' },
    };
    const result = decide(ctx);
    assert.equal(result.allowed, false);
    assert.equal(result.decidedBy, 'safety_check');
  });

  it('still honors deny rules even in bypass mode (deny is highest priority)', () => {
    const ctx: DecisionContext = {
      ...baseContext,
      rules: [
        { toolName: 'shell_exec', behavior: 'deny', source: 'userSettings' },
      ],
    };
    const result = decide(ctx);
    assert.equal(result.allowed, false);
    assert.equal(result.decidedBy, 'always_deny');
  });
});

// ── Decision Pipeline Tests: acceptEdits Mode ──

describe('Decision Pipeline: acceptEdits mode', () => {
  it('auto-accepts write_file within CWD', () => {
    const ctx: DecisionContext = {
      mode: 'acceptEdits',
      rules: [],
      toolName: 'write_file',
      toolArgs: { file_path: 'src/components/Button.tsx', content: '// test' },
      cwd: '/project/src',
    };
    const result = decide(ctx);
    assert.equal(result.allowed, true);
    assert.equal(result.decidedBy, 'mode_accept_edits');
  });

  it('auto-accepts edit_file within CWD', () => {
    const ctx: DecisionContext = {
      mode: 'acceptEdits',
      rules: [],
      toolName: 'edit_file',
      toolArgs: { file_path: 'src/utils.ts', old_string: 'a', new_string: 'b' },
      cwd: '/project',
    };
    const result = decide(ctx);
    assert.equal(result.allowed, true);
    assert.equal(result.decidedBy, 'mode_accept_edits');
  });

  it('does NOT auto-accept non-edit tools in acceptEdits mode', () => {
    const ctx: DecisionContext = {
      mode: 'acceptEdits',
      rules: [],
      toolName: 'shell_exec',
      toolArgs: { command: 'npm test' },
      cwd: '/project',
    };
    const result = decide(ctx);
    assert.equal(result.allowed, false);
    assert.equal(result.decidedBy, 'default_deny');
  });

  it('auto-accepts edit tools even without CWD (permissive fallback)', () => {
    const ctx: DecisionContext = {
      mode: 'acceptEdits',
      rules: [],
      toolName: 'write_file',
      toolArgs: { file_path: '/somewhere/else.ts' },
      // no cwd
    };
    const result = decide(ctx);
    assert.equal(result.allowed, true);
    assert.equal(result.decidedBy, 'mode_accept_edits');
  });

  it('safety check still fires in acceptEdits mode', () => {
    const ctx: DecisionContext = {
      mode: 'acceptEdits',
      rules: [],
      toolName: 'write_file',
      toolArgs: { file_path: '.git/config' },
      cwd: '/project',
    };
    const result = decide(ctx);
    assert.equal(result.allowed, false);
    assert.equal(result.decidedBy, 'safety_check');
  });
});

// ── PermissionEngine Class Tests ──

describe('PermissionEngine', () => {
  it('defaults to default mode with no rules', () => {
    const engine = new PermissionEngine();
    assert.equal(engine.getMode(), 'default');
    assert.equal(engine.getRules().length, 0);
  });

  it('accepts initial mode and rules', () => {
    const engine = new PermissionEngine({
      mode: 'bypassPermissions',
      rules: [{ toolName: 'write_file', behavior: 'allow', source: 'userSettings' }],
    });
    assert.equal(engine.getMode(), 'bypassPermissions');
    assert.equal(engine.getRules().length, 1);
  });

  it('addRule parses raw strings and sorts by priority', () => {
    const engine = new PermissionEngine();
    engine.addRule('write_file', 'allow', 'projectSettings');  // priority 90
    engine.addRule('shell_exec', 'deny', 'userSettings');       // priority 100

    const rules = engine.getRules();
    assert.equal(rules.length, 2);
    // userSettings (100) should come before projectSettings (90)
    assert.equal(rules[0].source, 'userSettings');
    assert.equal(rules[1].source, 'projectSettings');
  });

  it('addRules batch adds multiple rules', () => {
    const engine = new PermissionEngine();
    engine.addRules(['write_file', 'edit_file', 'read_file'], 'allow', 'userSettings');
    assert.equal(engine.getRules().length, 3);
  });

  it('addParsedRule adds pre-parsed rule', () => {
    const engine = new PermissionEngine();
    engine.addParsedRule({ toolName: 'write_file', behavior: 'allow', source: 'session' });
    assert.equal(engine.getRules().length, 1);
  });

  it('removeRulesBySource removes all rules from a source', () => {
    const engine = new PermissionEngine();
    engine.addRule('write_file', 'allow', 'userSettings');
    engine.addRule('shell_exec', 'deny', 'userSettings');
    engine.addRule('read_file', 'allow', 'projectSettings');

    const removed = engine.removeRulesBySource('userSettings');
    assert.equal(removed, 2);
    assert.equal(engine.getRules().length, 1);
    assert.equal(engine.getRules()[0].source, 'projectSettings');
  });

  it('clearRules removes everything', () => {
    const engine = new PermissionEngine();
    engine.addRule('write_file', 'allow', 'userSettings');
    engine.clearRules();
    assert.equal(engine.getRules().length, 0);
  });

  it('setMode changes the permission mode', () => {
    const engine = new PermissionEngine({ mode: 'default' });
    engine.setMode('bypassPermissions');
    assert.equal(engine.getMode(), 'bypassPermissions');
  });

  it('decide delegates to pipeline', () => {
    const engine = new PermissionEngine({
      mode: 'default',
      rules: [{ toolName: 'write_file', behavior: 'allow', source: 'userSettings' }],
    });
    const result = engine.decide('write_file', { file_path: 'src/app.ts' });
    assert.equal(result.allowed, true);
    assert.equal(result.decidedBy, 'always_allow');
  });

  it('decideAll returns map of results', () => {
    const engine = new PermissionEngine({
      mode: 'bypassPermissions',
    });
    const results = engine.decideAll([
      { id: 'tc1', name: 'write_file', arguments: { file_path: 'src/a.ts' } },
      { id: 'tc2', name: 'shell_exec', arguments: { command: 'ls' } },
    ]);
    assert.equal(results.size, 2);
    assert.equal(results.get('tc1')!.allowed, true);
    assert.equal(results.get('tc2')!.allowed, true);
  });

  it('summarize returns correct state', () => {
    const engine = new PermissionEngine({ mode: 'acceptEdits' });
    engine.addRule('write_file', 'allow', 'userSettings');
    engine.addRule('shell_exec', 'deny', 'projectSettings');

    const summary = engine.summarize();
    assert.equal(summary.mode, 'acceptEdits');
    assert.equal(summary.ruleCount, 2);
    assert.equal(summary.rulesByBehavior.allow, 1);
    assert.equal(summary.rulesByBehavior.deny, 1);
  });
});

// ── Edge Cases ──

describe('Decision Pipeline: edge cases', () => {
  it('ask rules return ask behavior (Tier 1: treated as blocked)', () => {
    const ctx: DecisionContext = {
      mode: 'default',
      rules: [{ toolName: 'shell_exec', behavior: 'ask', source: 'userSettings' }],
      toolName: 'shell_exec',
      toolArgs: { command: 'npm publish' },
    };
    const result = decide(ctx);
    assert.equal(result.allowed, false);
    assert.equal(result.behavior, 'ask');
    assert.equal(result.decidedBy, 'always_ask');
  });

  it('wildcard allow rule matches partial content', () => {
    const ctx: DecisionContext = {
      mode: 'default',
      rules: [
        { toolName: 'shell_exec', content: 'git ', behavior: 'allow', source: 'userSettings', isWildcard: true },
      ],
      toolName: 'shell_exec',
      toolArgs: { command: 'git push origin main' },
    };
    const result = decide(ctx);
    assert.equal(result.allowed, true);
  });

  it('empty rules array + default mode = deny', () => {
    const ctx: DecisionContext = {
      mode: 'default',
      rules: [],
      toolName: 'read_file',
      toolArgs: { file_path: 'README.md' },
    };
    const result = decide(ctx);
    assert.equal(result.allowed, false);
    assert.equal(result.decidedBy, 'default_deny');
  });

  it('conflicting same-priority rules: deny wins over ask, allow wins based on pipeline order', () => {
    const ctx: DecisionContext = {
      mode: 'default',
      rules: [
        { toolName: 'shell_exec', behavior: 'deny', source: 'userSettings' },
        { toolName: 'shell_exec', behavior: 'allow', source: 'userSettings' },
      ],
      toolName: 'shell_exec',
      toolArgs: { command: 'npm test' },
    };
    const result = decide(ctx);
    // Deny check (step 1) runs first → deny wins
    assert.equal(result.allowed, false);
    assert.equal(result.decidedBy, 'always_deny');
  });

  it('task tool does not trigger safety check by default', () => {
    const result = runSafetyCheck('task', { description: 'build something' });
    assert.equal(result.triggered, false);
  });
});
