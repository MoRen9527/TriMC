export type TaskEnvelope = {
  ingressId: string;
  requestId: string;
  taskType: string;
  sourceClient: 'tripilot' | 'triavatar' | 'trimobile' | 'system';
};