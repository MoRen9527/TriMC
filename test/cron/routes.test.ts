/**
 * routes tests — supertest over the cron route handler for every endpoint:
 * add / list / update / remove / run / log / status + validation paths.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import { overrideConfigDir, resetConfigDir, invalidateJobStoreCache } from '@tricompany/agent-core';
import { createCronService, type CronService } from '../../src/cron/service.js';
import { createCronRouteHandler } from '../../src/cron/routes.js';

describe('cron routes', () => {
  let tmpDir: string;
  let service: CronService;
  let server: http.Server;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trimc-cron-routes-'));
    overrideConfigDir(tmpDir);
    invalidateJobStoreCache();
    service = createCronService({
      logDir: path.join(tmpDir, 'cron', 'logs'),
      handler: async () => {
        /* no-op */
      },
    });
    const handle = createCronRouteHandler(service);
    server = http.createServer(async (req, res) => {
      const handled = await handle(req, res);
      if (!handled) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
      }
    });
  });

  afterEach(() => {
    service.stop();
    resetConfigDir();
    invalidateJobStoreCache();
  });

  const jobBody = {
    name: 'weekly-plane-shift',
    schedule: { kind: 'cron', cron: '0 23 * * 0', timezone: 'Asia/Shanghai' },
    payload: { command: 'echo hi', cwd: '/srv/fleet', runAs: 'fleet' },
  };

  it('POST jobs → 201 with persisted job', async () => {
    const res = await request(server).post('/internal/v1/cron/jobs').send(jobBody).expect(201);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.job.id);
    assert.equal(res.body.job.schedule.cron, '0 23 * * 0');
    assert.ok(res.body.job.state.nextRunAtMs, 'nextRunAtMs computed');
  });

  it('POST jobs validation: missing payload → 400, invalid cron → 400, bad json → 400', async () => {
    await request(server)
      .post('/internal/v1/cron/jobs')
      .send({ name: 'x', schedule: { kind: 'cron', cron: '0 23 * * 0' } })
      .expect(400);

    await request(server)
      .post('/internal/v1/cron/jobs')
      .send({
        name: 'x',
        schedule: { kind: 'cron', cron: 'not a cron' },
        payload: { command: 'echo hi', cwd: '/tmp' },
      })
      .expect(400);

    await request(server)
      .post('/internal/v1/cron/jobs')
      .set('content-type', 'application/json')
      .send('{not json')
      .expect(400);
  });

  it('GET jobs → list with count', async () => {
    await request(server).post('/internal/v1/cron/jobs').send(jobBody).expect(201);
    const res = await request(server).get('/internal/v1/cron/jobs').expect(200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.count, 1);
    assert.equal(res.body.jobs[0].name, 'weekly-plane-shift');
  });

  it('PATCH jobs/{id} → update; unknown id → 404', async () => {
    const created = await request(server).post('/internal/v1/cron/jobs').send(jobBody);
    const id = created.body.job.id as string;

    const patched = await request(server)
      .patch(`/internal/v1/cron/jobs/${id}`)
      .send({ enabled: false })
      .expect(200);
    assert.equal(patched.body.job.enabled, false);

    await request(server).patch('/internal/v1/cron/jobs/nope').send({ enabled: true }).expect(404);
  });

  it('DELETE jobs/{id} → removed; second delete → 404', async () => {
    const created = await request(server).post('/internal/v1/cron/jobs').send(jobBody);
    const id = created.body.job.id as string;

    const res = await request(server).delete(`/internal/v1/cron/jobs/${id}`).expect(200);
    assert.equal(res.body.removed, true);
    await request(server).delete(`/internal/v1/cron/jobs/${id}`).expect(404);
  });

  it('POST jobs/{id}/run → runs; disabled job refused without force; unknown → 404', async () => {
    const created = await request(server).post('/internal/v1/cron/jobs').send(jobBody);
    const id = created.body.job.id as string;

    const ran = await request(server).post(`/internal/v1/cron/jobs/${id}/run`).send({}).expect(200);
    assert.equal(ran.body.ran, true);
    assert.equal(ran.body.reason, 'status=ok');

    await request(server).patch(`/internal/v1/cron/jobs/${id}`).send({ enabled: false }).expect(200);
    const refused = await request(server).post(`/internal/v1/cron/jobs/${id}/run`).send({}).expect(200);
    assert.equal(refused.body.ran, false);
    assert.equal(refused.body.reason, 'disabled');

    const forced = await request(server).post(`/internal/v1/cron/jobs/${id}/run`).send({ force: true }).expect(200);
    assert.equal(forced.body.ran, true);

    await request(server).post('/internal/v1/cron/jobs/nope/run').send({}).expect(404);
  });

  it('GET cron/log → empty list before any run', async () => {
    const res = await request(server).get('/internal/v1/cron/log').expect(200);
    assert.equal(res.body.ok, true);
    assert.deepEqual(res.body.logs, []);
    assert.equal(res.body.count, 0);
  });

  it('GET cron/status → status shape', async () => {
    const res = await request(server).get('/internal/v1/cron/status').expect(200);
    assert.equal(res.body.ok, true);
    assert.equal(typeof res.body.status.running, 'boolean');
    assert.equal(typeof res.body.status.degraded, 'boolean');
    assert.equal(res.body.status.consecutiveFailures, 0);
    assert.equal(res.body.status.jobCount, 0);
  });

  it('non-cron URLs are not handled (returns false → caller 404s)', async () => {
    await request(server).get('/other/path').expect(404);
  });
});
