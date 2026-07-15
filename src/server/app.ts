import { createServer, type Server } from 'node:http';
import type { TriMCEnv } from '../config/env.js';
import { TaskController } from '../task-controller/controller.js';
import { createModelClient, type Message } from 'trimodel';
import { agentLoop } from '../agent-loop/loop.js';
import type { AgentEvent } from '../agent-loop/loop.js';
import { assemblePipelineOptions } from '../pipeline/assemble.js';
import type { AgentContract } from '../contracts/agent-contract.js';
import type { AgentTier } from '../agent-loop/permissions.js';

export function createTriMCApp(env: TriMCEnv) {
  const taskController = new TaskController();
  const modelClient = createModelClient();
  let server: Server | null = null;

  async function handleChat(req: { body: string }): Promise<object> {
    let parsed: { model?: string; messages?: Message[] };
    try {
      parsed = JSON.parse(req.body);
    } catch {
      return { error: 'invalid_json' };
    }

    const { model, messages } = parsed;
    if (!model || !messages || !Array.isArray(messages)) {
      return { error: 'missing model or messages' };
    }

    try {
      const response = await modelClient.chat(model, messages);
      return { ok: true, ...response };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.startsWith('Unknown model')) {
        return { error: 'unknown_model', message: msg, available: modelClient.listModels() };
      }
      return { error: 'model_error', message: msg };
    }
  }

  return {
    async start(): Promise<void> {
      server = createServer(async (req, res) => {
        if (req.url === '/healthz') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, service: 'trimc' }));
          return;
        }

        if (req.url === '/hello' && req.method === 'GET') {
          try {
            const response = await modelClient.chat('deepseek-v4-flash', [
              {
                role: 'system',
                content:
                  'You are TriMetaverse AI. Greet the user warmly in 1-2 sentences. Mention you are part of the TriMetaverse ecosystem and ready to serve.',
              },
              { role: 'user', content: 'Say hello!' },
            ]);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                ok: true,
                greeting: response.content,
                model: response.model,
                usage: response.usage,
              }),
            );
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            if (msg.startsWith('Unknown model')) {
              res.writeHead(400, { 'content-type': 'application/json' });
              res.end(
                JSON.stringify({
                  error: 'unknown_model',
                  message: msg,
                  available: modelClient.listModels(),
                }),
              );
              return;
            }
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'model_error', message: msg }));
          }
          return;
        }

        if (req.url === '/internal/v1/tasks' && req.method === 'POST') {
          res.writeHead(202, { 'content-type': 'application/json' });
          res.end(JSON.stringify(taskController.acceptPlaceholder()));
          return;
        }

        if (req.url === '/internal/v1/chat' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          const body = Buffer.concat(chunks).toString('utf-8');
          const result = await handleChat({ body });
          const statusCode = 'error' in result ? (result.error === 'invalid_json' ? 400 : 422) : 200;
          res.writeHead(statusCode, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result));
          return;
        }

        if (req.url?.startsWith('/internal/v1/agent') && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          const raw = Buffer.concat(chunks).toString('utf-8');
          let parsed: {
            model?: string;
            systemPrompt?: string;
            messages?: Message[];
            maxTurns?: number;
            contract?: AgentContract;
            tier?: AgentTier;
            cwd?: string;
          };
          try {
            parsed = JSON.parse(raw);
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_json' }));
            return;
          }

          // ── Pipeline Assembly (when contract is present) ──
          let loopOptions: Parameters<typeof agentLoop>[0];
          const hasContract = !!parsed.contract;

          if (hasContract) {
            try {
              const assembly = await assemblePipelineOptions({
                contract: parsed.contract!,
                tier: parsed.tier ?? 'main',
                cwd: parsed.cwd ?? env.cwd,
                maxTurns: parsed.maxTurns ?? 25,
                model: parsed.model ?? 'deepseek-v4-pro',
                memdirPath: env.memdirPath,
                systemPromptOverride: parsed.systemPrompt,
              });
              loopOptions = {
                ...assembly.options,
                messages: parsed.messages ?? [],
              };
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              res.writeHead(500, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'pipeline_assembly_error', message: msg }));
              return;
            }
          } else {
            // ── Legacy raw mode (backward compatible) ──
            loopOptions = {
              model: parsed.model ?? 'deepseek-v4-pro',
              systemPrompt: parsed.systemPrompt ?? '',
              messages: parsed.messages ?? [],
              maxTurns: parsed.maxTurns ?? 25,
            };
          }

          // ── SSE vs JSON mode detection ──
          const urlObj = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
          const wantsSSE =
            urlObj.searchParams.get('stream') === 'true' ||
            req.headers.accept?.includes('text/event-stream');

          if (wantsSSE) {
            // ── SSE streaming mode ──
            res.writeHead(200, {
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache',
              'connection': 'keep-alive',
              'x-accel-buffering': 'no',
            });

            const writeSSE = (eventType: string, data: object) => {
              res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
            };

            try {
              for await (const event of agentLoop(loopOptions)) {
                writeSSE(event.type, event);
              }
              res.write('data: [DONE]\n\n');
              res.end();
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              writeSSE('error', { type: 'error', message: msg });
              res.write('data: [DONE]\n\n');
              res.end();
            }
            return;
          }

          // ── JSON mode ──
          const events: AgentEvent[] = [];
          try {
            for await (const event of agentLoop(loopOptions)) {
              events.push(event);
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, turns: events.filter((e) => e.type === 'loop_end').length > 0 ? 'completed' : 'no_turns', events }));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'agent_error', message: msg, events }));
          }
          return;
        }

        if (req.url === '/hello-pro' && req.method === 'GET') {
          try {
            const response = await modelClient.chat('deepseek-v4-pro', [
              {
                role: 'system',
                content:
                  'You are TriMetaverse AI Pro. Think step by step, then give a short answer in 1-2 sentences.',
              },
              { role: 'user', content: 'Explain TriMetaverse in one sentence.' },
            ]);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                ok: true,
                model: response.model,
                content: response.content,
                reasoning: response.reasoning_content,
                usage: response.usage,
              }),
            );
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'model_error', message: msg }));
          }
          return;
        }

        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
      });

      await new Promise<void>((resolve, reject) => {
        server!.on('error', reject);
        server!.listen(env.port, () => resolve());
      });

      // Read the actual port (in case port 0 was used for OS-assigned port)
      const addr = server!.address();
      if (addr && typeof addr === 'object') {
        env.port = addr.port;
      }

      console.log(`[trimc] listening on :${env.port}`);
    },
    get port(): number {
      return env.port;
    },
    async stop(): Promise<void> {
      if (server) {
        await new Promise<void>((resolve, reject) => {
          server!.close((err) => (err ? reject(err) : resolve()));
        });
        server = null;
      }
    },
  };
}