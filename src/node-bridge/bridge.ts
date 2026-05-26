export type NodeOfferRequest = {
  taskId: string;
  targetNodeId: string;
  payload: Record<string, unknown>;
};

export class NodeBridge {
  async offerTask(request: NodeOfferRequest): Promise<void> {
    console.log('[trimc/node-bridge] offer task', request.taskId, request.targetNodeId);
  }
}