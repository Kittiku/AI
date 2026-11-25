import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { bangkokDay, buildStats, taskOf } from '../server/stats.js';
import { openStore } from '../server/store.js';
import { mainModel } from '../server/providers.js';

const DAY = 86_400_000;
const now = Date.UTC(2026, 10, 24, 6, 0, 0); // 13:00 in Bangkok
const step = (over = {}) => ({ id: Math.random(), jobId: 'j1', role: 'backend', action: 'implement', provider: 'claudecode', model: 'claude-x',
  round: 0, status: 'done', startedAt: now - 60_000, endedAt: now - 30_000, inputTokens: 1000, outputTokens: 100, costUsd: 0.5, billing: 'subscription',
  error: null, ...over });

test('totals count calls by outcome and rate success over decided calls only', () => {
  const stats = buildStats([
    step(), step({ status: 'failed' }), step({ status: 'rejected' }), step({ status: 'skipped' }), step({ status: 'cancelled' }), step({ status: 'running', endedAt: null })
  ], { now, days: 7 });
  assert.equal(stats.totals.calls, 6);
  assert.equal(stats.totals.done, 1);
  assert.equal(stats.totals.failed, 2);
  assert.equal(stats.totals.skipped, 1);
  assert.equal(stats.totals.stopped, 1);
  assert.equal(stats.totals.running, 1);
  assert.equal(stats.totals.successRate, 1 / 3);
  assert.equal(stats.totals.avgMs, 30_000);
});

test('tokens ignore zero reports, cost is split by billing', () => {
  const stats = buildStats([
    step({ inputTokens: 2000, outputTokens: 50, costUsd: 1, billing: 'subscription' }),
    step({ provider: 'codex', model: 'gpt-x', inputTokens: 0, outputTokens: 0, costUsd: null }),
    step({ provider: 'gemini', model: 'gemini-x', inputTokens: 300, outputTokens: 30, costUsd: 0.25, billing: 'api' })
  ], { now, days: 7 });
  assert.equal(stats.totals.inputTokens, 2300);
  assert.equal(stats.totals.withTokens, 2);
  assert.equal(stats.totals.apiCostUsd, 0.25);
  assert.equal(stats.totals.subscriptionCostUsd, 1);
});

test('groups by AI, by model and by kind of work; unknown models and old rows stay visible', () => {
  const stats = buildStats([
    step(), step({ model: 'claude-y' }), step({ provider: 'codex', model: 'gpt-x', role: 'review', action: 'check_subtask' }),
    step({ provider: 'codex', model: null, role: 'plan', action: null })
  ], { now, days: 7, providers: ['claudecode', 'codex', 'gemini'] });
  assert.deepEqual(stats.providers.map(row => [row.provider, row.calls, row.models]), [['claudecode', 2, 2], ['codex', 2, 2], ['gemini', 0, 0]]);
  assert.ok(stats.models.some(row => row.provider === 'codex' && row.model === null && row.calls === 1));
  const tasks = Object.fromEntries(stats.tasks.map(row => [row.task, row]));
  assert.equal(tasks['backend.implement'].calls, 2);
  assert.equal(tasks.check_subtask.role, 'review');
  assert.equal(tasks.plan.calls, 1, 'a row without action falls back to its role');
  assert.deepEqual(tasks['backend.implement'].providers, { claudecode: 2 });
  assert.equal(taskOf({ role: 'frontend', action: 'subtask' }), 'frontend.subtask');
  assert.equal(taskOf({ role: 'review', action: null }), 'review');
});

test('daily series covers every day in the window, in Bangkok time, zero-filled', () => {
  const stats = buildStats([step({ startedAt: now - 2 * DAY }), step({ startedAt: now - 2 * DAY + 1000, provider: 'codex' }), step()], { now, days: 7 });
  assert.equal(stats.daily.length, 7);
  assert.equal(stats.daily.at(-1).day, bangkokDay(now));
  const twoDaysAgo = stats.daily.find(row => row.day === bangkokDay(now - 2 * DAY));
  assert.deepEqual(twoDaysAgo.byProvider, { claudecode: 1, codex: 1 });
  assert.equal(stats.daily.reduce((sum, row) => sum + row.calls, 0), 3);
  assert.equal(stats.daily.filter(row => row.calls === 0).length, 5);
});

test('per-model stats: percentiles, unknown model, null for unreported values, daily and matrix, old fields kept', () => {
  const timed = (seconds, over = {}) => step({ startedAt: now - 100_000, endedAt: now - 100_000 + seconds * 1000, ...over });
  const stats = buildStats([
    ...[10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map(seconds => timed(seconds)),
    timed(5, { status: 'failed' }),
    timed(30, { provider: 'codex', model: null, inputTokens: 0, outputTokens: 0, costUsd: null, role: 'plan', action: null }),
    timed(60, { provider: 'codex', model: null, inputTokens: null, outputTokens: null, costUsd: null, jobId: 'j2' }),
    timed(20, { startedAt: now - 2 * DAY, endedAt: now - 2 * DAY + 20_000, provider: 'codex', model: 'gpt-x', inputTokens: 10, outputTokens: 5, costUsd: 0.2, jobId: 'j2' })
  ], { now, days: 7 });
  const claude = stats.models.find(row => row.provider === 'claudecode' && row.model === 'claude-x');
  assert.equal(claude.calls, 11);
  assert.equal(claude.ok, 10);
  assert.equal(claude.failed, 1);
  assert.equal(claude.p50Ms, 50_000);
  assert.equal(claude.p90Ms, 90_000);
  assert.equal(claude.avgMs, 55_000);
  assert.equal(claude.inputTokens, 11_000);
  assert.equal(claude.costUsd, 5.5);
  const unknown = stats.models.find(row => row.provider === 'codex' && row.model === null);
  assert.equal(unknown.calls, 2);
  assert.equal(unknown.p50Ms, 30_000);
  assert.equal(unknown.inputTokens, null);
  assert.equal(unknown.outputTokens, null);
  assert.equal(unknown.costUsd, null);
  const today = stats.daily.at(-1);
  assert.equal(today.byModel['claudecode:claude-x'].calls, 11);
  assert.equal(today.byModel['codex:unknown'].tokens, null);
  const quiet = stats.daily[0];
  assert.deepEqual(quiet.byModel['claudecode:claude-x'], { calls: 0, tokens: null, costUsd: null, avgMs: null });
  const earlier = stats.daily.find(row => row.day === bangkokDay(now - 2 * DAY));
  assert.deepEqual(earlier.byModel['codex:gpt-x'], { calls: 1, tokens: 15, costUsd: 0.2, avgMs: 20_000 });
  assert.ok(stats.matrix.some(row => row.type === 'plan' && row.provider === 'codex' && row.model === null && row.count === 1));
  assert.ok(stats.matrix.some(row => row.type === 'backend.implement' && row.provider === 'claudecode' && row.model === 'claude-x' && row.count === 11));
  assert.deepEqual(stats.totals.topModel, { provider: 'claudecode', model: 'claude-x', calls: 11 });
  assert.equal(stats.totals.costPerJob, (5.5 + 0.2) / 2);
  for (const key of ['range', 'providers', 'tasks', 'failures', 'recent']) assert.ok(stats[key]);
  assert.equal(stats.totals.calls, 14);
  assert.ok('byProvider' in today && 'day' in today);
});

test('topModel ranks named models even when unknown calls are more frequent', () => {
  const stats = buildStats([
    step({ model: null }), step({ model: null }), step({ model: null }),
    step({ model: 'claude-y' }),
    step({ provider: 'codex', model: 'gpt-x' }), step({ provider: 'codex', model: 'gpt-x' })
  ], { now, days: 30 });

  assert.equal(stats.models[0].model, null);
  assert.equal(stats.models[0].calls, 3);
  assert.deepEqual(stats.totals.topModel, { provider: 'codex', model: 'gpt-x', calls: 2 });
});

test('topModel is null when no call has a named model', () => {
  const stats = buildStats([step({ model: null })], { now, days: 30 });
  assert.equal(stats.totals.topModel, null);
});

test('costPerJob is null when no call reports a cost', () => {
  const stats = buildStats([step({ costUsd: null })], { now, days: 7 });
  assert.equal(stats.totals.costPerJob, null);
});

test('calls outside the window are left out; failures and recent calls carry job titles', () => {
  const stats = buildStats([
    step({ startedAt: now - 10 * DAY }), step({ status: 'failed', error: 'boom', jobId: 'j2' }), step()
  ], { now, days: 7, jobs: new Map([['j2', 'งานที่พัง']]) });
  assert.equal(stats.totals.calls, 2);
  assert.equal(stats.failures.length, 1);
  assert.equal(stats.failures[0].jobTitle, 'งานที่พัง');
  assert.equal(stats.failures[0].error, 'boom');
  assert.equal(stats.recent.length, 2);
});

test('mainModel picks the model that did most of the work', () => {
  assert.equal(mainModel({ 'claude-haiku': { outputTokens: 10 }, 'claude-opus': { outputTokens: 900 } }), 'claude-opus');
  assert.equal(mainModel({ 'gemini-pro': { tokens: { candidates: 50 } }, 'gemini-flash': { tokens: { candidates: 5 } } }), 'gemini-pro');
  assert.equal(mainModel(null), null);
  assert.equal(mainModel({}), null);
});

test('an existing database gains the model and action columns and keeps its rows', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-stats-'));
  let store;
  // Windows keeps the database file locked until it is closed, so close before removing the folder.
  t.after(async () => { store?.close(); await rm(directory, { recursive: true, force: true }); });
  const old = new DatabaseSync(path.join(directory, 'relay.db'));
  old.exec(`CREATE TABLE steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, role TEXT NOT NULL, provider TEXT NOT NULL,
      round INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
      input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, billing TEXT, error TEXT);
    INSERT INTO steps (job_id, role, provider, status, started_at, ended_at) VALUES ('old', 'plan', 'codex', 'done', ${now - 1000}, ${now});`);
  old.close();
  store = openStore(directory);
  const id = store.startStep({ jobId: 'new', role: 'review', provider: 'gemini', round: 1, action: 'check_subtask' });
  store.finishStep(id, { status: 'done', usage: { inputTokens: 5, outputTokens: 2, costUsd: null, billing: 'subscription', model: 'gemini-x' } });
  const rows = store.stepsSince(now - DAY, Date.now() + 1);
  const fresh = rows.find(row => row.jobId === 'new');
  const legacy = rows.find(row => row.jobId === 'old');
  assert.equal(fresh.model, 'gemini-x');
  assert.equal(fresh.action, 'check_subtask');
  assert.equal(legacy.model, null);
  assert.equal(legacy.action, null);
  assert.equal(legacy.role, 'plan');
});
