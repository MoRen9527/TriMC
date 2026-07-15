// ── Contract Resolver Unit Test ──
// TriMC v0.2.0 D4 exit criteria: parse at least 1 agent contract successfully.
// Target: ChiefTechnologyOfficer.contract.yaml (CTO 小狄)

import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { resolve } from 'node:path';
import { loadContract, resolveContracts } from '../src/contracts/resolver.js';
import type { AgentContract } from '../src/contracts/agent-contract.js';

// Paths relative to TriMC repo root
const TRI_COMPANY_REGISTRY = resolve('..', 'TriCompany', 'docs', 'registry');
const CTO_CONTRACT_PATH = resolve(TRI_COMPANY_REGISTRY, 'ChiefTechnologyOfficer.contract.yaml');

describe('Contract Resolver — ChiefTechnologyOfficer (CTO 小狄)', () => {
  let cto: AgentContract;

  before(() => {
    cto = loadContract(CTO_CONTRACT_PATH);
  });

  // ── Six elements structural validation ──

  it('parses agent_id and version', () => {
    assert.strictEqual(cto.agent_id, 'ChiefTechnologyOfficer');
    assert.ok(cto.version, 'version should be present');
  });

  describe('Element 1: Identity', () => {
    it('has all required identity fields', () => {
      assert.strictEqual(cto.identity.display_name, '小狄');
      assert.strictEqual(cto.identity.family, 'Role');
      assert.strictEqual(cto.identity.role, 'ChiefTechnologyOfficer');
      assert.ok(cto.identity.description.length > 0, 'description should not be empty');
      assert.strictEqual(cto.identity.user_invocable, true);
    });
  });

  describe('Element 2: Responsibilities', () => {
    it('has at least one responsibility', () => {
      assert.ok(cto.responsibilities.length > 0, 'should have at least 1 responsibility');
      cto.responsibilities.forEach((r: { description: string; priority?: string }) => {
        assert.ok(r.description.length > 0, `responsibility "${JSON.stringify(r)}" should have a description`);
      });
    });
  });

  describe('Element 3: Decision Rights', () => {
    it('has approve list', () => {
      assert.ok(cto.decision_rights.approve.length > 0, 'should have at least 1 approve item');
    });

    it('has escalate list', () => {
      assert.ok(Array.isArray(cto.decision_rights.escalate), 'escalate should be an array');
    });

    it('has forbid list', () => {
      assert.ok(Array.isArray(cto.decision_rights.forbidden), 'forbidden should be an array');
    });
  });

  describe('Element 4: Collaborators', () => {
    it('has reports_to', () => {
      assert.ok(cto.collaborators.reports_to.length > 0);
    });

    it('has peers array', () => {
      assert.ok(Array.isArray(cto.collaborators.peers));
      assert.ok(cto.collaborators.peers.length > 0, 'CTO should have at least 1 peer');
    });

    it('has supervises array', () => {
      assert.ok(Array.isArray(cto.collaborators.supervises));
    });
  });

  describe('Element 5: Tools', () => {
    it('has at least one tool', () => {
      assert.ok(cto.tools.length > 0, 'CTO should have tools');
    });

    it('every tool has a valid risk_level', () => {
      const validLevels = ['low', 'medium', 'high', 'critical'];
      cto.tools.forEach((tool: { name: string; risk_level: string }) => {
        assert.ok(
          validLevels.includes(tool.risk_level),
          `tool "${tool.name}" risk_level "${tool.risk_level}" must be one of ${validLevels.join(', ')}`
        );
      });
    });

    it('every tool has runtime_equivalent', () => {
      cto.tools.forEach((tool: { name: string; runtime_equivalent: string }) => {
        assert.ok(
          tool.runtime_equivalent.length > 0,
          `tool "${tool.name}" should have runtime_equivalent mapping`
        );
      });
    });
  });

  describe('Element 6: IO Contract', () => {
    it('has inputs array', () => {
      assert.ok(cto.io_contract.inputs.length > 0, 'should have at least 1 input');
      cto.io_contract.inputs.forEach((input: { type: string; description?: string }) => {
        assert.ok(input.type.length > 0, 'each input should have a type');
      });
    });

    it('has outputs array', () => {
      assert.ok(cto.io_contract.outputs.length > 0, 'should have at least 1 output');
      cto.io_contract.outputs.forEach((output: { type: string; description?: string }) => {
        assert.ok(output.type.length > 0, 'each output should have a type');
      });
    });
  });
});

describe('Contract Resolver — Batch resolveContracts', () => {
  it('loads multiple contracts from TriCompany registry', () => {
    const { contracts, errors } = resolveContracts(TRI_COMPANY_REGISTRY);

    console.log(`Loaded ${contracts.length} contracts from TriCompany registry`);
    errors.forEach((e: { path: string; message: string }) => console.warn(`  ⚠ Parse error: ${e.path} → ${e.message}`));

    assert.ok(contracts.length >= 3, 'should load at least 3 contracts (CEOChiefOfStaff, CPO, CTO)');
  });
});

describe('Contract Resolver — Edge cases', () => {
  it('throws on non-existent file', () => {
    assert.throws(
      () => loadContract(resolve('nonexistent.contract.yaml')),
      /failed to read or parse YAML/
    );
  });

  it('throws on empty YAML', () => {
    assert.throws(
      () => loadContract(resolve('package.json')),
      /contract.version is required/
    );
  });
});
