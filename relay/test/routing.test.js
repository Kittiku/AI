import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

const serverUrl = new URL('../server/', import.meta.url);
const indexUrl = new URL('index.js', serverUrl).href;
const storeUrl = new URL('store.js', serverUrl).href;
const moduleUrl = source => 'data:text/javascript,' + encodeURIComponent(source);
const providersUrl = moduleUrl(`
  export const names = { claudecode: 'Claude Code', gemini: 'Gemini', codex: 'Codex' };
  export const USAGE = Symbol('usage');
  export const editSchema = {}, planSchema = {}, reviewSchema = {}, subtaskCheckSchema = {};
  export const refreshClaudeCode = async () => {}, refreshCodex = async () => {};
  export const pacificDay = () => 'test-day';
  export const fake = {};
  export const generate = (...args) => fake.generate(...args);
  export const quota = (settings, usage) => ({
    claudecode: { ready: fake.claudeReady, windows: [] },
    gemini: { ready: true, windows: [{ remaining: 100 * (1 - (usage[pacificDay()] || 0) / settings.geminiDailyLimit) }] },
    codex: { ready: false, windows: [] }
  });
`);
const expressUrl = moduleUrl(`
  const noop = () => {};
  export default Object.assign(() => ({
    disable: noop, use: noop, get: noop, post: noop, put: noop, delete: noop, listen: (port, _host, callback) => {
      queueMicrotask(callback);
      return { address: () => ({ port }) };
    }
  }), { json: noop, static: noop });
`);
const fsUrl = moduleUrl("export * from 'node:fs'; export const mkdirSync = () => {}; export const existsSync = () => false;");
const sqliteUrl = moduleUrl(`
  import { DatabaseSync as SQLite } from 'node:sqlite';
  let db;
  export class DatabaseSync extends SQLite {
    constructor() {
      super(':memory:');
      db = this;
    }
  }
  export function resetDatabase() {
    db.exec('DELETE FROM steps; DELETE FROM jobs;');
  }
`);

// Load the real routing, store and monitor together without launching a server, provider processes or creating files.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './providers.js' && context.parentURL?.startsWith(serverUrl.href)) {
      return nextResolve(providersUrl, context);
    }
    if (context.parentURL === indexUrl) {
      if (specifier === 'express') return nextResolve(expressUrl, context);
      if (specifier === 'cross-spawn') return nextResolve(moduleUrl('export default () => {};'), context);
      if (specifier === 'node:fs') return nextResolve(fsUrl, context);
    }
    if (context.parentURL === storeUrl) {
      if (specifier === 'node:sqlite') return nextResolve(sqliteUrl, context);
      if (specifier === 'node:fs') return nextResolve(fsUrl, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url !== indexUrl) return loaded;
    return { ...loaded, source: loaded.source.toString() + '\nexport { call, defaults, state, store, publicQuotas, serverReady };' };
  }
});
const priorDelay = process.env.RELAY_RETRY_DELAY_MS;
process.env.RELAY_RETRY_DELAY_MS = '1';
const { call, defaults, state, store, publicQuotas, serverReady } = await import(indexUrl).finally(() => {
  hooks.deregister();
  if (priorDelay === undefined) delete process.env.RELAY_RETRY_DELAY_MS;
  else process.env.RELAY_RETRY_DELAY_MS = priorDelay;
});
await serverReady;
const { fake, pacificDay } = await import(providersUrl);
const { resetDatabase } = await import(sqliteUrl);

const role = 'backend';
const contextError = Object.assign(Error('บริบทเกินขนาดที่ส่งให้ Gemini CLI ได้'), { code: 'RELAY_CONTEXT_TOO_LARGE' });
const success = { summary: 'สำรองทำงานสำเร็จ' };
const skip = { provider: 'gemini', reason: contextError.message };
const activities = job => job.monitor.activities.map(activity => activity.code);
let nextJobId = 0;

function prepare({ mode = 'auto', retries = 2, claudeReady = true, fallback = () => ({ ...success }) } = {}) {
  resetDatabase();
  const settings = structuredClone(defaults);
  settings.routes[role] = ['gemini', 'claudecode'];
  settings.routing.mode = mode;
  settings.auto = { ...settings.auto, retries, waitMinutes: 0, allProviders: false };
  settings.geminiDailyLimit = 20;
  const job = { id: String(++nextJobId), status: 'running', settings, pinned: { [role]: 'gemini' }, events: [], prompt: 'ทดสอบ' };
  const controller = new AbortController();
  const calls = [];
  fake.claudeReady = claudeReady;
  fake.generate = async provider => {
    calls.push(provider);
    if (provider === 'gemini') throw contextError;
    assert.equal(provider, 'claudecode');
    // The monitor and quota should already be correct while the fallback is running.
    assert.equal(job.monitor.stages[role].status, 'running');
    assert.equal(state.usage[pacificDay()], 4);
    return fallback();
  };
  state.jobs = [job];
  state.settings = settings;
  state.usage = { [pacificDay()]: 4 };
  return { job, controller, calls, run: () => call(job, role, '.', 'ทำงาน', '{}', {}, controller.signal) };
}

for (const mode of ['auto', 'fixed']) {
  test(mode + ': an oversized Gemini context is skipped and the fallback succeeds', async () => {
    const { job, calls, run } = prepare({ mode });
    const quotaBefore = publicQuotas().gemini.windows[0].remaining;
    const result = await run();
    assert.equal(result.summary, success.summary);
    assert.deepEqual(calls, ['gemini', 'claudecode']);

    const saved = store.load().jobs.find(item => item.id === job.id);
    assert.deepEqual(saved.routing, job.routing);
    const [routing] = saved.routing;
    assert.equal(routing.mode, mode);
    assert.deepEqual(routing.attempts, ['claudecode']);
    assert.equal(routing.chosen, 'claudecode');
    assert.deepEqual(routing.skipped.filter(item => item.provider === 'gemini'), [skip]);
    assert.ok(job.events.some(event => event.provider === 'gemini' && event.detail.includes(contextError.message)));

    const steps = store.steps(job.id);
    assert.deepEqual(Array.from(steps, step => [step.provider, step.status, step.error]),
      [['gemini', 'skipped', contextError.message], ['claudecode', 'done', null]]);
    const stats = store.providerStats(0);
    assert.equal(stats.has('gemini:' + role), false);
    assert.equal(stats.get('claudecode:' + role).n, 1);
    assert.equal(stats.get('claudecode:' + role).done, 1);
    assert.equal(publicQuotas().gemini.windows[0].remaining, quotaBefore);
    assert.ok(!activities(job).includes('failed'));
    assert.ok(!activities(job).includes('retry_scheduled'));
  });
}

test('exhausting the eligible providers returns the context error without retrying the skip', async () => {
  const { job, calls, run } = prepare({ claudeReady: false });
  await assert.rejects(run(), { code: contextError.code, message: contextError.message });
  assert.deepEqual(calls, ['gemini']);
  assert.equal(job.routing.length, 1);
  assert.deepEqual(job.routing[0].attempts, []);
  assert.equal(job.routing[0].chosen, undefined);
  assert.ok(job.routing[0].skipped.some(item => item.provider === skip.provider && item.reason === skip.reason));
  assert.deepEqual(Array.from(store.steps(job.id), step => step.status), ['skipped']);
  assert.equal(store.providerStats(0).size, 0);
  assert.equal(state.usage[pacificDay()], 4);
  assert.equal(job.monitor.stages[role].status, 'failed');
  assert.equal(activities(job).filter(code => code === 'failed').length, 1);
  assert.ok(!activities(job).includes('retry_scheduled'));
});

test('a genuine fallback failure counts and is retried without reattempting Gemini', async () => {
  const failure = Error('provider สำรองล้มเหลว');
  const { job, calls, run } = prepare({ retries: 1, fallback: () => { throw failure; } });
  await assert.rejects(run(), { message: failure.message });
  assert.deepEqual(calls, ['gemini', 'claudecode', 'claudecode']);
  assert.deepEqual(job.routing.map(entry => entry.attempts), [['claudecode'], ['claudecode']]);
  for (const entry of job.routing) {
    assert.deepEqual(entry.skipped.filter(item => item.provider === 'gemini'), [skip]);
  }
  assert.deepEqual(Array.from(store.steps(job.id), step => [step.status, step.error]),
    [['skipped', contextError.message], ['failed', failure.message], ['failed', failure.message]]);
  const stats = store.providerStats(0);
  assert.deepEqual(stats.get('claudecode:' + role), { n: 2, done: 0, avgMs: null });
  assert.equal(stats.has('gemini:' + role), false);
  assert.equal(state.usage[pacificDay()], 4);
  assert.equal(activities(job).filter(code => code === 'failed').length, 2);
  assert.equal(activities(job).filter(code => code === 'retry_scheduled').length, 1);
});

test('cancellation takes precedence over a context error', async () => {
  const { job, controller, run } = prepare();
  const cancelled = Error('ผู้ใช้หยุดงาน');
  const calls = [];
  fake.generate = async provider => {
    calls.push(provider);
    controller.abort(cancelled);
    throw contextError;
  };
  await assert.rejects(run(), { message: cancelled.message });
  assert.deepEqual(calls, ['gemini']);
  assert.deepEqual(job.routing[0].attempts, ['gemini']);
  assert.ok(!job.routing[0].skipped.some(item => item.provider === 'gemini'));
  assert.deepEqual(Array.from(store.steps(job.id), step => step.status), ['cancelled']);
  assert.equal(state.usage[pacificDay()], 4);
  assert.ok(!activities(job).includes('failed'));
});
