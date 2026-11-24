import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import {
  buildRestartSpawnSpec, busyJobs, createRestartController, defaultSelfUpdateSettings,
  normalizeSelfUpdateSettings, shouldAutoRestart
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
  child.unref = () => calls.push('unref');
  const controller = createRestartController({
    getJobs: () => jobs,
    checkSyntax: () => { calls.push('check'); },
    closeServer: () => { calls.push('close'); },
    reopenServer: () => { calls.push('reopen'); },
    spawnProcess: () => { calls.push('spawn'); return child; },
    writeMarker: marker => { calls.push(['marker', marker]); },
    exit: code => { calls.push(['exit', code]); finished.resolve(); },
    onStateChange: state => {
      changes.push(state);
      if (state.status === 'failed') failed.resolve(state);
    },
    supervised: false,
    flushMs: 0,
    verifyChildMs: 5,
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
        assert.equal(options.detached, true);
        assert.equal(options.windowsHide, false);
        assert.equal(options.stdio, 'inherit');
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
        queueMicrotask(() => child.emit(event, ...args));
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
