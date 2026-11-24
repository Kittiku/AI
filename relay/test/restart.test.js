import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:net';
import { registerHooks } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  buildRestartSpawnSpec, busyJobs, createRestartController, defaultSelfUpdateSettings,
  normalizeSelfUpdateSettings, restartMessages, shouldAutoRestart
} from '../server/restart.js';

const envFlag = '--env-file-if-exists=.env';
const statuses = ['queued', 'running', 'stopping', 'waiting_approval'];
const job = status => ({ id: status, title: `Job ${status}`, status });

test('automatic restart is disabled by default and requires an eligible self-update', () => {
  assert.deepEqual(defaultSelfUpdateSettings, { autoRestart: false });
  for (const saved of [undefined, null, {}, { autoRestart: false }, { autoRestart: 'true' }]) {
    assert.deepEqual(normalizeSelfUpdateSettings(saved), { autoRestart: false });
  }
  const settings = { selfUpdate: normalizeSelfUpdateSettings({ autoRestart: true }) };
  const update = { restart: true, error: '', dependencies: false };
  assert.equal(shouldAutoRestart(update, settings), true);
  assert.equal(shouldAutoRestart(update, { selfUpdate: defaultSelfUpdateSettings }), false);
  assert.equal(shouldAutoRestart(update, {}), false);
  assert.equal(shouldAutoRestart(null, settings), false);
  for (const ineligible of [{ restart: false }, { restart: 'true' }, { error: 'build failed' }, { dependencies: true }]) {
    assert.equal(shouldAutoRestart({ ...update, ...ineligible }, settings), false);
  }
});

test('the spawn specification keeps the invocation and environment and disables opening the browser', () => {
  const current = {
    execPath: 'node.exe', execArgv: [envFlag, '--trace-warnings'],
    argv: ['node.exe', 'server/index.js', '--test-arg'], cwd: () => 'D:/AI/relay',
    env: { RELAY_PORT: '4783', RELAY_NO_BROWSER: '0' }
  };
  assert.deepEqual(buildRestartSpawnSpec(current), {
    command: current.execPath, args: [envFlag, '--trace-warnings', 'server/index.js', '--test-arg'],
    cwd: current.cwd(), env: { RELAY_PORT: '4783', RELAY_NO_BROWSER: '1' }
  });
  assert.deepEqual(buildRestartSpawnSpec({ ...current, execArgv: ['--trace-warnings'] }).args,
    [envFlag, '--trace-warnings', 'server/index.js', '--test-arg']);
  assert.deepEqual(buildRestartSpawnSpec({ ...current, execArgv: ['--env-file-if-exists', '.env'] }).args,
    ['--env-file-if-exists', '.env', 'server/index.js', '--test-arg']);
  assert.equal(current.env.RELAY_NO_BROWSER, '0');
});

function setup(options = {}) {
  const jobs = [];
  const calls = [];
  const changes = [];
  const finished = Promise.withResolvers();
  const failed = Promise.withResolvers();
  const child = new EventEmitter();
  child.pid = 123;
  child.connected = true;
  child.ready = () => child.emit('message', { type: restartMessages.ready });
  child.disconnect = () => { child.connected = false; };
  child.stop = (code, signal) => {
    child.exitCode = code;
    child.signalCode = signal;
    child.emit('exit', code, signal);
  };
  child.kill = signal => { calls.push(['kill', signal]); child.stop(null, signal); };
  child.unref = () => calls.push('unref');
  const controller = createRestartController({
    getJobs: () => jobs,
    checkSyntax: () => { calls.push('check'); },
    closeServer: () => { calls.push('close'); },
    reopenServer: () => { calls.push('reopen'); },
    spawnProcess: () => { calls.push('spawn'); queueMicrotask(child.ready); return child; },
    writeMarker: marker => { calls.push(['marker', marker]); },
    exit: code => { calls.push(['exit', code]); finished.resolve(); },
    onStateChange: state => {
      changes.push(state);
      if (state.status === 'failed') failed.resolve(state);
    },
    supervised: false,
    flushMs: 0,
    readyTimeoutMs: 500,
    ...options
  });
  return { controller, jobs, calls, changes, child, finished: finished.promise, failed: failed.promise };
}

test('all four busy statuses hold the request until the last job finishes', { timeout: 3000 }, async () => {
  const { controller, jobs, calls, changes, finished } = setup();
  jobs.push(...statuses.map(status => ({ ...job(status), settings: 'private' })), job('complete'), job('failed'));
  assert.deepEqual(busyJobs(jobs), statuses.map(job));
  assert.deepEqual(controller.getState(), {
    status: 'idle', source: null, reason: null, requestedAt: null, updatedAt: null, error: null,
    busyCount: 4, busyJobs: statuses.map(job)
  });

  const waiting = await controller.requestRestart({ source: 'auto', reason: 'merge' });
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.busyCount, 4);
  assert.equal(waiting.source, 'auto');
  assert.equal(waiting.reason, 'merge');
  assert.equal(typeof waiting.requestedAt, 'number');
  assert.deepEqual(await controller.requestRestart({ source: 'manual' }), waiting);
  assert.equal(changes.length, 1);
  for (const busyCount of [3, 2, 1]) {
    jobs.shift();
    const state = await controller.onJobsChanged();
    assert.equal(state.status, 'waiting');
    assert.equal(state.busyCount, busyCount);
    assert.equal(state.requestedAt, waiting.requestedAt);
    assert.deepEqual(calls, []);
  }

  jobs.shift();
  const restarting = await controller.onJobsChanged();
  assert.equal(restarting.status, 'restarting');
  assert.equal(restarting.busyCount, 0);
  assert.equal(restarting.requestedAt, waiting.requestedAt);
  assert.deepEqual(changes.map(state => [state.status, state.busyCount]), [
    ['waiting', 4], ['waiting', 3], ['waiting', 2], ['waiting', 1], ['restarting', 0]
  ]);
  await finished;
  assert.deepEqual(calls, ['check', 'close', 'spawn', 'unref', ['exit', 0]]);
});

test('cancelling a waiting restart clears its request even after the jobs finish', async () => {
  const { controller, jobs, calls } = setup();
  jobs.push(job('queued'));
  assert.equal((await controller.requestRestart()).status, 'waiting');
  const cancelled = controller.cancelRestart();
  assert.equal(cancelled.status, 'idle');
  assert.equal(cancelled.source, null);
  assert.equal(cancelled.requestedAt, null);
  jobs.pop();
  assert.equal((await controller.onJobsChanged()).status, 'idle');
  assert.deepEqual(calls, []);
});

test('cancelling while preflight is pending invalidates the in-flight check', async () => {
  const check = Promise.withResolvers();
  const { controller, jobs, calls } = setup({ checkSyntax: () => check.promise });
  jobs.push(job('running'));
  await controller.requestRestart();
  jobs.pop();
  const starting = controller.onJobsChanged();
  await Promise.resolve();
  assert.equal(controller.cancelRestart().status, 'idle');
  check.resolve();
  assert.equal((await starting).status, 'idle');
  assert.deepEqual(calls, []);
});

test('a job added during preflight keeps Relay waiting', { timeout: 3000 }, async () => {
  const check = Promise.withResolvers();
  const { controller, jobs, calls, finished } = setup({ checkSyntax: () => check.promise });
  const starting = controller.requestRestart();
  await Promise.resolve();
  jobs.push(job('queued'));
  check.resolve();
  assert.equal((await starting).status, 'waiting');
  assert.deepEqual(calls, []);
  jobs.pop();
  assert.equal((await controller.onJobsChanged()).status, 'restarting');
  await finished;
});

test('a write completed during preflight invalidates that syntax check', { timeout: 3000 }, async () => {
  const firstCheck = Promise.withResolvers();
  let checks = 0;
  const { controller, calls, changes } = setup({
    checkSyntax() {
      if (++checks === 1) return firstCheck.promise;
      throw Error('invalid syntax after merge');
    }
  });
  const restarting = controller.requestRestart();
  await Promise.resolve();
  assert.equal(checks, 1);
  await controller.runWrite(() => assert.equal(controller.getState().status, 'waiting'));
  firstCheck.resolve();
  assert.match((await restarting).error, /invalid syntax after merge/);
  assert.equal(checks, 2);
  assert.deepEqual(changes.map(state => state.status), ['waiting', 'failed']);
  assert.deepEqual(calls, []);
});

test('a job added while flushing the response defers server closure', { timeout: 3000 }, async () => {
  const waiting = Promise.withResolvers();
  const { controller, jobs, calls } = setup({
    onStateChange(state) { if (state.status === 'waiting') waiting.resolve(state); }
  });
  assert.equal((await controller.requestRestart()).status, 'restarting');
  jobs.push(job('running'));
  assert.deepEqual((await waiting.promise).busyJobs, [job('running')]);
  assert.deepEqual(calls, ['check']);
  assert.equal(controller.cancelRestart().status, 'idle');
});

for (const supervised of [false, true]) {
  test(`${supervised ? 'supervised' : 'direct'} restart waits for the port to close`, { timeout: 3000 }, async () => {
    const closing = Promise.withResolvers();
    const releasePort = Promise.withResolvers();
    const { controller, calls, child, finished } = setup({
      supervised,
      markerPath: 'restart.flag',
      async closeServer() {
        calls.push('closing');
        closing.resolve();
        await releasePort.promise;
        calls.push('closed');
      },
      spawnProcess(command, args, options) {
        calls.push('spawn');
        assert.equal(command, process.execPath);
        assert.deepEqual(args, buildRestartSpawnSpec().args);
        assert.equal(options.cwd, process.cwd());
        assert.equal(options.env.RELAY_NO_BROWSER, '1');
        assert.equal(options.env.RELAY_RESTART_HANDOFF, '1');
        assert.equal(options.detached, true);
        assert.equal(options.windowsHide, false);
        assert.deepEqual(options.stdio, ['inherit', 'inherit', 'inherit', 'ipc']);
        queueMicrotask(child.ready);
        return child;
      }
    });
    const [first, duplicate] = await Promise.all([controller.requestRestart(), controller.requestRestart()]);
    assert.equal(first.status, 'restarting');
    assert.deepEqual(duplicate, first);
    assert.deepEqual(controller.cancelRestart(), first);
    assert.deepEqual(calls, ['check']);
    await closing.promise;
    assert.deepEqual(calls, ['check', 'closing']);
    releasePort.resolve();
    await finished;
    assert.deepEqual(calls, ['check', 'closing', 'closed',
      ...(supervised ? [['marker', 'restart.flag']] : ['spawn', 'unref']), ['exit', 0]]);
  });
}

test('a failed preflight keeps the original server open and lets the caller retry', { timeout: 3000 }, async () => {
  let valid = false;
  const { controller, calls, finished } = setup({
    async checkSyntax() { if (!valid) throw Error('SyntaxError in server'); }
  });
  const failure = await controller.requestRestart();
  assert.equal(failure.status, 'failed');
  assert.match(failure.error, /SyntaxError in server/);
  assert.deepEqual(calls, []);
  valid = true;
  assert.equal((await controller.requestRestart()).status, 'restarting');
  await finished;
});

test('supervised preflight rejects a missing marker path before closing the server', async () => {
  const { controller, calls } = setup({ supervised: true, markerPath: '' });
  const failed = await controller.requestRestart();
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /RELAY_RESTART_MARKER/);
  assert.deepEqual(calls, []);
  assert.equal(controller.cancelRestart().status, 'idle');
});

for (const [name, event, args, error] of [
  ['a spawn error', 'error', [Error('ENOENT')], /ENOENT/],
  ['an early successful exit', 'exit', [0, null], /exit 0/],
  ['an early signal', 'exit', [null, 'SIGTERM'], /SIGTERM/]
]) {
  test(`${name} reopens the original server before publishing failure`, { timeout: 3000 }, async () => {
    const reopening = Promise.withResolvers();
    const restored = Promise.withResolvers();
    const { controller, failed, calls, child } = setup({
      spawnProcess() {
        calls.push('spawn');
        queueMicrotask(() => {
          if (event === 'exit') child.stop(...args);
          else {
            child.pid = undefined;
            child.emit(event, ...args);
          }
        });
        return child;
      },
      async reopenServer() {
        calls.push('reopen');
        reopening.resolve();
        await restored.promise;
      }
    });
    await controller.requestRestart();
    await reopening.promise;
    assert.equal(controller.getState().status, 'restarting');
    restored.resolve();
    const state = await failed;
    assert.match(state.error, error);
    assert.deepEqual(calls, ['check', 'close', 'spawn', 'reopen']);
    assert.equal(child.listenerCount('exit'), 0);
    assert.equal(child.listenerCount('error'), 0);
  });
}

test('a live replacement must signal readiness before the original process exits', { timeout: 3000 }, async () => {
  const spawned = Promise.withResolvers();
  const { controller, calls, child, finished } = setup({
    spawnProcess() { spawned.resolve(); return child; }
  });
  await controller.requestRestart();
  await spawned.promise;
  child.emit('message', { type: 'unrelated' });
  await delay(20);
  assert.deepEqual(calls, ['check', 'close']);
  assert.equal(child.connected, true);
  child.ready();
  await finished;
  assert.equal(child.connected, false);
  assert.deepEqual(calls, ['check', 'close', 'unref', ['exit', 0]]);
});

for (const startupError of [null, 'SQLite could not open']) {
  test(`a replacement that ${startupError ? 'reports a startup error' : 'times out'} must exit before recovery`, { timeout: 3000 }, async () => {
    const spawned = Promise.withResolvers();
    const killed = Promise.withResolvers();
    const { controller, calls, child, failed } = setup({
      readyTimeoutMs: startupError ? 500 : 20,
      spawnProcess() { spawned.resolve(); return child; }
    });
    child.kill = signal => killed.resolve(signal);
    await controller.requestRestart();
    await spawned.promise;
    if (startupError) child.emit('message', { type: restartMessages.failed, error: startupError });
    assert.equal(await killed.promise, 'SIGKILL');
    assert.equal(controller.getState().status, 'restarting');
    assert.deepEqual(calls, ['check', 'close']);
    child.stop(null, 'SIGKILL');
    assert.match((await failed).error, startupError ? /SQLite could not open/ : /หมดเวลา/);
    assert.deepEqual(calls, ['check', 'close', 'reopen']);
  });
}

for (const [name, hook, expected, supervised] of [
  ['close fails', 'closeServer', ['check', 'reopen'], false],
  ['spawn throws', 'spawnProcess', ['check', 'close', 'reopen'], false],
  ['marker write fails', 'writeMarker', ['check', 'close', 'reopen'], true]
]) {
  test(`${name} and the original server is reopened`, { timeout: 3000 }, async () => {
    const { controller, failed, calls } = setup({ supervised, markerPath: 'restart.flag',
      [hook]() { throw Error(name); }
    });
    assert.equal((await controller.requestRestart()).status, 'restarting');
    assert.match((await failed).error, new RegExp(name));
    assert.deepEqual(calls, expected);
  });
}

test('the restart API reports boot and queue state and restores HTTP, SSE and SQLite after a failed restart', { timeout: 10_000 }, async t => {
  const serverDir = new URL('../server/', import.meta.url);
  const indexUrl = new URL('index.js?restart-api', serverDir).href;
  const storeUrl = new URL('store.js?restart-api', serverDir).href;
  const inlineModule = source => 'data:text/javascript,' + encodeURIComponent(source);
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  const providersUrl = inlineModule(`
    export const names = { claudecode: 'Claude Code', gemini: 'Gemini', codex: 'Codex' };
    export const USAGE = Symbol('usage');
    export const editSchema = {}, planSchema = {}, reviewSchema = {}, subtaskCheckSchema = {};
    export const refreshClaudeCode = async () => {}, refreshCodex = async () => {};
    export const pacificDay = () => 'test-day', quota = () => ({});
    export const generate = () => { throw Error('Unexpected AI call'); };
  `);
  const fsUrl = inlineModule("export * from 'node:fs'; export const mkdirSync = () => {}; export const existsSync = () => false;");
  const sqliteUrl = inlineModule(`
    import { DatabaseSync as SQLite } from 'node:sqlite';
    export class DatabaseSync extends SQLite { constructor() { super(':memory:'); } }
  `);
  const storeFixtureUrl = inlineModule(`
    import { openStore as open } from ${JSON.stringify(storeUrl)};
    export const opened = [];
    export function openStore(dataDir) {
      const store = open(dataDir);
      opened.push(store);
      if (opened.length !== 1) return store;
      return { ...store, load(fallback) {
        const { selfUpdate, ...settings } = fallback.settings;
        const common = { repo: ${JSON.stringify(repo)}, status: 'complete', events: [], branchKept: true, base: 'base' };
        store.persist({ ...fallback, settings, jobs: [
          { ...common, id: 'merged', title: 'Relay server change', branch: 'relay/merged', selfUpdate: { at: 1, restart: true } },
          { ...common, id: 'ui', title: 'Relay UI change', selfUpdate: { at: 1, ui: true, restart: false } }
        ] });
        return store.load(fallback);
      } };
    }
  `);
  const gitUrl = inlineModule(`
    export * from ${JSON.stringify(new URL('git.js', serverDir).href)};
    export const gitFixture = {};
    export async function git(_cwd, command, ...args) {
      switch (command) {
        case 'rev-parse':
          if (!args.includes('--abbrev-ref')) return 'commit';
          await gitFixture.beforeMergeCheck?.();
          return 'main';
        case 'status': case 'merge-base': return '';
        case 'diff': return args.includes('--name-only') ? 'relay/server/index.js\\0' : '';
        default: throw Error('Unexpected git command: ' + command);
      }
    }
  `);
  const controllerUrl = inlineModule(`
    export * from ${JSON.stringify(new URL('restart.js', serverDir).href)};
    import { createRestartController as create } from ${JSON.stringify(new URL('restart.js', serverDir).href)};
    export const fake = { ready: false, checks: 0 };
    export function createRestartController(options) {
      return create({ ...options, flushMs: 800,
        checkSyntax: () => { fake.checks++; if (!fake.ready) throw Error('test preflight failure'); },
        writeMarker: (...args) => fake.writeMarker(...args),
        exit: () => { throw Error('Unexpected exit'); }
      });
    }
  `);
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const parent = context.parentURL;
      if (specifier === './providers.js' && parent?.startsWith(serverDir.href)) return nextResolve(providersUrl, context);
      if (parent === indexUrl) {
        const mocks = { './store.js': storeFixtureUrl, './restart.js': controllerUrl, './git.js': gitUrl, 'node:fs': fsUrl };
        if (Object.hasOwn(mocks, specifier)) return nextResolve(mocks[specifier], context);
      }
      if (parent === storeUrl && specifier === 'node:sqlite') return nextResolve(sqliteUrl, context);
      if (parent === storeUrl && specifier === 'node:fs') return nextResolve(fsUrl, context);
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (url !== indexUrl) return loaded;
      return { ...loaded, source: loaded.source.toString() + '\nexport { serverReady, state, save, httpServer, closeServer };' };
    }
  });
  const portHolder = createServer().listen(0, '127.0.0.1');
  await once(portHolder, 'listening');
  t.after(() => { if (portHolder.listening) portHolder.close(); });
  const env = { RELAY_PORT: String(portHolder.address().port), RELAY_SUPERVISED: '1', RELAY_RESTART_MARKER: 'test-marker' };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  let api;
  let fake;
  let opened;
  try {
    api = await import(indexUrl);
    ({ fake } = await import(controllerUrl));
    ({ opened } = await import(storeFixtureUrl));
    await delay(150);
    assert.equal(opened.length, 0, 'a server waiting for the port must not open SQLite');
    await new Promise(resolve => portHolder.close(resolve));
    await api.serverReady;
  } finally {
    hooks.deregister();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  t.after(() => api.closeServer());
  const base = 'http://127.0.0.1:' + api.httpServer.address().port;
  async function request(route, method = 'GET', body) {
    const response = await fetch(base + route, {
      method, signal: AbortSignal.timeout(2000),
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    });
    return { status: response.status, cache: response.headers.get('cache-control'), body: await response.json() };
  }
  const restartPath = '/api/system/restart';
  const idle = {
    status: 'idle', source: null, reason: null, requestedAt: null, updatedAt: null,
    busyCount: 0, busyJobs: [], error: null
  };
  const state = (await request('/api/state')).body;
  const server = state.server;
  assert.match(server.bootId, /^[\da-f-]{36}$/);
  assert.ok(Number.isFinite(server.startedAt));
  assert.equal(server.supervised, true);
  assert.deepEqual(state.restart, idle);
  assert.deepEqual(state.settings.selfUpdate, { autoRestart: false });
  assert.deepEqual(state.jobs.find(item => item.id === 'merged').selfUpdate,
    { at: 1, restart: true, restarted: true, restartedAt: server.startedAt });
  assert.equal(state.jobs.find(item => item.id === 'ui').selfUpdate.restarted, undefined);
  assert.deepEqual(await request('/api/health'), { status: 200, cache: 'no-store', body: { ok: true, ...server, restart: idle } });
  assert.deepEqual(await request(restartPath), { status: 200, cache: 'no-store', body: { server, restart: idle } });
  assert.deepEqual((await request('/api/monitor')).body.restart, idle);

  const enabled = await request('/api/settings', 'PUT', { ...state.settings, selfUpdate: { autoRestart: true } });
  assert.equal(enabled.status, 200);
  assert.deepEqual(enabled.body.selfUpdate, { autoRestart: true });
  const { selfUpdate: _omitted, ...oldClientSettings } = enabled.body;
  assert.deepEqual((await request('/api/settings', 'PUT', oldClientSettings)).body.selfUpdate, { autoRestart: true });
  assert.deepEqual(opened[0].load().settings.selfUpdate, { autoRestart: true });

  const stream = await fetch(base + '/api/monitor/events', { signal: AbortSignal.timeout(9000) });
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let frames = '';
  async function nextSnapshot(predicate) {
    for (;;) {
      const end = frames.indexOf('\n\n');
      if (end !== -1) {
        const frame = frames.slice(0, end);
        frames = frames.slice(end + 2);
        if (frame.startsWith('event: snapshot\n')) {
          const snapshot = JSON.parse(frame.split('\n')[1].slice('data: '.length));
          if (predicate(snapshot.restart)) return snapshot.restart;
        }
        continue;
      }
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      frames += decoder.decode(chunk.value, { stream: true });
    }
  }
  assert.deepEqual(await nextSnapshot(() => true), idle);

  const busy = { id: 'busy', title: 'Pending approval', status: 'waiting_approval' };
  api.state.jobs.push({ ...busy, repo, events: [] });
  api.save();
  const waiting = await request(restartPath, 'POST', { jobId: busy.id });
  assert.equal(waiting.status, 202);
  assert.equal(waiting.body.ok, true);
  assert.deepEqual(waiting.body.server, server);
  assert.equal(waiting.body.restart.status, 'waiting');
  assert.equal(waiting.body.restart.source, 'manual');
  assert.equal(waiting.body.restart.reason, busy.title);
  assert.equal(waiting.body.restart.busyCount, 1);
  assert.deepEqual(waiting.body.restart.busyJobs, [busy]);
  assert.deepEqual(await nextSnapshot(value => value.status === 'waiting'), waiting.body.restart);

  const cancelled = await request(restartPath + '/cancel', 'POST');
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.restart.status, 'idle');
  const merged = await request('/api/jobs/merged/merge', 'POST', { target: 'main' });
  assert.equal(merged.status, 200);
  assert.ok(merged.body.selfUpdate.at >= server.startedAt);
  assert.equal(merged.body.selfUpdate.restarted, undefined);
  const automatic = await nextSnapshot(value => value.source === 'auto');
  assert.equal(automatic.status, 'waiting');
  assert.equal(automatic.busyCount, 1);
  assert.equal(opened.length, 1);

  const stopped = await request('/api/jobs/busy/cancel', 'POST', {});
  assert.equal(stopped.body.status, 'cancelled');
  const failed = await nextSnapshot(value => value.status === 'failed');
  assert.equal(failed.busyCount, 0);
  assert.match(failed.error, /test preflight failure/);
  const manualFailure = await request(restartPath, 'POST');
  assert.equal(manualFailure.status, 500);
  assert.equal(manualFailure.body.ok, false);
  assert.equal(manualFailure.body.error, manualFailure.body.restart.error);
  assert.equal(manualFailure.body.restart.source, 'manual');
  assert.equal((await request(restartPath + '/cancel', 'POST')).body.restart.status, 'idle');

  const { gitFixture } = await import(gitUrl);
  const mergeEntered = Promise.withResolvers();
  const finishMerge = Promise.withResolvers();
  gitFixture.beforeMergeCheck = () => {
    mergeEntered.resolve();
    return finishMerge.promise;
  };
  fake.ready = true;
  const mergeInFlight = request('/api/jobs/merged/merge', 'POST', { target: 'main' });
  await mergeEntered.promise;
  const priorChecks = fake.checks;
  try {
    const waitingForMerge = await request(restartPath, 'POST');
    assert.equal(waitingForMerge.status, 202);
    assert.equal(waitingForMerge.body.restart.status, 'waiting');
    assert.equal(waitingForMerge.body.restart.busyCount, 0);
    assert.equal((await request('/api/health')).body.restart.status, 'waiting');
    assert.equal(fake.checks, priorChecks);
    await nextSnapshot(value => value.status === 'waiting' && value.busyCount === 0);
  } finally {
    fake.ready = false;
    finishMerge.resolve();
  }
  assert.equal((await mergeInFlight).status, 200);
  const postMergeFailure = await nextSnapshot(value => value.status !== 'waiting');
  assert.equal(postMergeFailure.status, 'failed');
  assert.match(postMergeFailure.error, /test preflight failure/);
  assert.equal(fake.checks, priorChecks + 1);
  assert.equal((await request('/api/health')).body.bootId, server.bootId);
  assert.equal(opened.length, 1);

  fake.ready = true;
  fake.writeMarker = marker => {
    assert.equal(marker, 'test-marker');
    assert.equal(api.httpServer.listening, false);
    assert.throws(() => opened[0].steps('busy'), /database is not open/i);
    throw Error('test marker failure');
  };
  const restarting = await request(restartPath, 'POST');
  assert.equal(restarting.status, 202);
  assert.equal(restarting.body.restart.status, 'restarting');
  const [duplicate, conflict, newJob, newCard, newFix] = await Promise.all([
    request(restartPath, 'POST'), request(restartPath + '/cancel', 'POST'),
    request('/api/jobs', 'POST', {}), request('/api/cards', 'POST', {}), request('/api/jobs/merged/fix', 'POST', {})
  ]);
  assert.deepEqual(duplicate.body, restarting.body);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error, 'Relay กำลังรีสตาร์ทอยู่ ไม่สามารถยกเลิกได้');
  for (const response of [newJob, newCard, newFix]) assert.equal(response.status, 503);
  assert.deepEqual(await nextSnapshot(value => value.status === 'restarting'), restarting.body.restart);

  // Closing the old HTTP connections may end the stream normally or reset its socket.
  while (!(await reader.read().catch(() => ({ done: true }))).done) {}
  let recovered;
  for (let attempt = 0; attempt < 30; attempt++) {
    recovered = await request('/api/health').catch(() => null);
    if (recovered?.body.restart.status === 'failed') break;
    await delay(50);
  }
  assert.equal(recovered?.status, 200);
  assert.equal(recovered.body.bootId, server.bootId);
  assert.match(recovered.body.restart.error, /test marker failure/);
  assert.equal(opened.length, 2);
  assert.deepEqual((await request('/api/jobs/busy/steps')).body, []);
  assert.deepEqual((await request('/api/monitor')).body.restart, recovered.body.restart);
  const reconnected = await fetch(base + '/api/monitor/events', { signal: AbortSignal.timeout(2000) });
  const reopenedStream = reconnected.body.getReader();
  const firstFrame = new TextDecoder().decode((await reopenedStream.read()).value);
  assert.match(firstFrame, /event: snapshot/);
  assert.match(firstFrame, /test marker failure/);
  await reopenedStream.cancel();
});
