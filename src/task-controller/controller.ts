export type AcceptedTaskPlaceholder = {
  taskId: string;
  controller: 'trimc-main';
  status: 'accepted';
  queueStatus: 'queued';
};

export class TaskController {
  acceptPlaceholder(): AcceptedTaskPlaceholder {
    return {
      taskId: `task_${Date.now()}`,
      controller: 'trimc-main',
      status: 'accepted',
      queueStatus: 'queued'
    };
  }
}