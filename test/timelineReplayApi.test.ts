import assert from 'node:assert/strict';
import test from 'node:test';
import { buildContractSamples } from '../src/observability/contractSamples.js';
import { createTimelineReplayApi } from '../src/observability/timelineReplayApi.js';

function makeApi() {
  return createTimelineReplayApi(buildContractSamples());
}

test('queryTimelineBySession supports cursor + limit', () => {
  const api = makeApi();

  const first = api.queryTimelineBySession({
    sessionId: 'ses_contract_01',
    limit: 1
  });

  assert.equal(first.items.length, 1);
  assert.equal(first.pageInfo.limit, 1);
  assert.ok(first.pageInfo.nextCursor);

  const second = api.queryTimelineBySession({
    sessionId: 'ses_contract_01',
    cursorEventId: first.pageInfo.nextCursor,
    limit: 10
  });

  assert.equal(second.items.length, 2);
  assert.equal(second.pageInfo.total, 3);
});

test('queryTimelineByTrace supports pagination', () => {
  const api = makeApi();

  const page1 = api.queryTimelineByTrace({
    traceId: 'trc_contract_02',
    page: 1,
    pageSize: 1
  });
  const page2 = api.queryTimelineByTrace({
    traceId: 'trc_contract_02',
    page: 2,
    pageSize: 1
  });

  assert.equal(page1.items.length, 1);
  assert.equal(page2.items.length, 1);
  assert.equal(page1.pageInfo.total, 2);
  assert.equal(page1.pageInfo.totalPages, 2);
});

test('startReplay and stopReplay work with session scope', () => {
  const api = makeApi();

  const started = api.startReplay({
    sessionId: 'ses_contract_03',
    requestedBy: 'agent.main'
  });

  assert.equal(started.status, 'working');
  assert.match(started.replayId, /^replay_/);

  const stopped = api.stopReplay({ replayId: started.replayId });
  assert.equal(stopped?.status, 'done');
  assert.ok(stopped?.stoppedAt);

  const loaded = api.getReplay({ replayId: started.replayId });
  assert.equal(loaded?.status, 'done');
});

test('startReplay requires sessionId or traceId', () => {
  const api = makeApi();
  assert.throws(() => api.startReplay({}), /sessionId or traceId is required/);
});
