import { createServer } from 'node:http';
import type { TriMCEnv } from '../config/env.js';
import { TaskController } from '../task-controller/controller.js';

export function createTriMCApp(env: TriMCEnv) {
  const taskController = new TaskController();

  return {
    async start(): Promise<void> {
      const server = createServer((req, res) => {
        if (req.url === '/healthz') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, service: 'trimc' }));
          return;
        }

        if (req.url === '/internal/v1/tasks' && req.method === 'POST') {
          res.writeHead(202, { 'content-type': 'application/json' });
          res.end(JSON.stringify(taskController.acceptPlaceholder()));
          return;
        }

        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
      });

      await new Promise<void>((resolve) => {
        server.listen(env.port, () => resolve());
      });

      console.log(`[trimc] listening on :${env.port}`);
    }
  };
}