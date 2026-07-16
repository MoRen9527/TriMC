// AgentContract Schema v1 — shared between TriMC and TriLC
import { z } from 'zod';

export const ContractMetadataSchema = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string().optional(),
  author: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const ContractCapabilitySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  tools: z.array(z.string()).optional(),
  subAgents: z.array(z.string()).optional(),
  permissions: z.array(z.string()).optional(),
});

export const ContractInstanceSchema = z.object({
  id: z.string(),
  contractId: z.string(),
  capability: z.string(),
  config: z.record(z.unknown()).optional(),
  status: z.enum(['active', 'inactive', 'error']).optional(),
});

export const AgentContractSchema = z.object({
  metadata: ContractMetadataSchema,
  capabilities: z.array(ContractCapabilitySchema).optional(),
  instances: z.array(ContractInstanceSchema).optional(),
  rules: z.array(z.string()).optional(),
});

export type ContractMetadata = z.infer<typeof ContractMetadataSchema>;
export type ContractCapability = z.infer<typeof ContractCapabilitySchema>;
export type ContractInstance = z.infer<typeof ContractInstanceSchema>;
export type AgentContract = z.infer<typeof AgentContractSchema>;
