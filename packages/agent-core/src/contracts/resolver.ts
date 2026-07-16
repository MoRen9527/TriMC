// Contract Resolver — YAML contract loading and validation
// Shared between TriMC and TriLC

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { AgentContractSchema, type AgentContract } from './agent-contract.js';

export interface ContractResolveResult {
  success: boolean;
  contract?: AgentContract;
  errors?: string[];
  path?: string;
}

export class ContractResolver {
  private contractCache: Map<string, AgentContract> = new Map();
  private basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  /**
   * Resolve a contract from a YAML file path (relative to basePath).
   */
  async resolve(filePath: string): Promise<ContractResolveResult> {
    const fullPath = resolve(this.basePath, filePath);

    // Check cache
    const cached = this.contractCache.get(fullPath);
    if (cached) {
      return { success: true, contract: cached, path: fullPath };
    }

    try {
      const content = await readFile(fullPath, 'utf-8');
      const parsed = parseYaml(content);
      const result = AgentContractSchema.safeParse(parsed);

      if (result.success) {
        this.contractCache.set(fullPath, result.data);
        return { success: true, contract: result.data, path: fullPath };
      }

      return {
        success: false,
        errors: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        path: fullPath,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, errors: [message], path: fullPath };
    }
  }

  /**
   * Resolve multiple contracts from a directory (non-recursive, *.yaml / *.yml).
   */
  async resolveDirectory(dirPath: string): Promise<ContractResolveResult[]> {
    const fullPath = resolve(this.basePath, dirPath);
    const { readdir } = await import('node:fs/promises');

    try {
      const entries = await readdir(fullPath, { withFileTypes: true });
      const yamlFiles = entries
        .filter((e) => e.isFile() && (e.name.endsWith('.yaml') || e.name.endsWith('.yml')))
        .map((e) => e.name);

      const results = await Promise.all(
        yamlFiles.map((f) => this.resolve(`${dirPath}/${f}`)),
      );
      return results;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return [{ success: false, errors: [message], path: fullPath }];
    }
  }

  /**
   * Get a cached contract by its metadata name.
   */
  getByName(name: string): AgentContract | undefined {
    for (const contract of this.contractCache.values()) {
      if (contract.metadata.name === name) return contract;
    }
    return undefined;
  }

  /**
   * List all cached contracts.
   */
  list(): AgentContract[] {
    return [...this.contractCache.values()];
  }

  /**
   * Clear the cache.
   */
  clearCache(): void {
    this.contractCache.clear();
  }

  /**
   * Set the base path for contract resolution.
   */
  setBasePath(basePath: string): void {
    this.basePath = basePath;
  }
}
