// ── Session Initializer Unit Test (v2 contracts) ──
// 6.4: TriMC server-side employee session initialization from same-source v2 contracts.
// Uses a self-built fixture — does not depend on the TriCompany repo path.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSession, loadV2Contracts, SessionInitError } from '../src/onboarding/session-initializer.js';

describe('Session Initializer (v2 contracts)', () => {
  let sourceAgentsDir: string | undefined;
  let workspaceRoot: string | undefined;

  before(async () => {
    sourceAgentsDir = await mkdtemp(join(tmpdir(), 'trimc-session-init-'));
    const agentDir = join(sourceAgentsDir, 'sample-agent');
    await mkdir(agentDir);

    await Promise.all([
      writeFile(join(agentDir, 'soul.agent.md'), 'Sample soul', 'utf-8'),
      writeFile(join(agentDir, 'agent-body.agent.md'), 'Sample body', 'utf-8'),
      writeFile(join(agentDir, 'agent-frontmatter.agent.md'), 'tools:\n  - read', 'utf-8'),
      writeFile(join(agentDir, 'memory.agent.md'), 'Sample memory', 'utf-8'),
      writeFile(join(agentDir, 'colleagues-social.agent.md'), 'Sample colleagues', 'utf-8'),
      writeFile(
        join(agentDir, 'sample-agent.contract.yaml'),
        [
          'contract:',
          '  version: "2.0"',
          '  agent_id: sample-agent',
          '  family: Role',
          'paths:',
          '  soul: sample-agent/soul.agent.md',
          '  agent_body: sample-agent/agent-body.agent.md',
          '  agent_frontmatter: sample-agent/agent-frontmatter.agent.md',
          '  memory: sample-agent/memory.agent.md',
          '  colleagues_social: sample-agent/colleagues-social.agent.md',
          'decision_rights:',
          '  approve:',
          '    - release',
          '  forbidden:',
          '    - skip tests',
          'runtime_baseline:',
          '  host: tri-mc',
        ].join('\n'),
        'utf-8',
      ),
    ]);
  });

  after(async () => {
    for (const dir of [sourceAgentsDir, workspaceRoot]) {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads v2 contracts from a source-agents directory', () => {
    const contracts = loadV2Contracts(sourceAgentsDir!);
    assert.equal(contracts.length, 1);
    assert.equal(contracts[0].agentId, 'sample-agent');
    assert.equal(contracts[0].systemPrompt, 'Sample soul\n\nSample body');
    assert.deepEqual(contracts[0].decisionRights, {
      approve: ['release'],
      freeze: [],
      escalate: [],
      forbidden: ['skip tests'],
    });
    assert.deepEqual(contracts[0].toolControl, { tools: ['read'] });
  });

  it('initializes a session with workspace ready under workspaceRoot/<agentId>', async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'trimc-session-ws-'));
    const config = initializeSession('sample-agent', {
      sourceAgentsDir: sourceAgentsDir!,
      workspaceRoot,
    });

    assert.equal(config.agentId, 'sample-agent');
    assert.match(config.readyAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(config.workspaceRoot.endsWith(join('sample-agent')), 'workspace is per-agent');

    // Workspace directory created and writable
    await access(config.workspaceRoot, constants.W_OK);
  });

  it('throws SessionInitError for an unknown agent', () => {
    assert.throws(
      () => initializeSession('no-such-agent', {
        sourceAgentsDir: sourceAgentsDir!,
        workspaceRoot: tmpdir(),
      }),
      (err: unknown) => err instanceof SessionInitError && err.agentId === 'no-such-agent',
    );
  });
});
