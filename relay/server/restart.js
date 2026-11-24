import { execFile, spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const defaultSelfUpdateSettings = Object.freeze({ autoRestart: false });
export const restartMessages = { ready: 'relay:ready', failed: 'relay:startup-error' };

export function normalizeSelfUpdateSettings(selfUpdate) {
  return { autoRestart: selfUpdate?.autoRestart === true };
}

export function shouldAutoRestart(selfUpdate, settings) {
  return settings?.selfUpdate?.autoRestart === true && selfUpdate?.restart === true &&
    !selfUpdate.error && !selfUpdate.dependencies;
}

const busyStatuses = new Set(['queued', 'running', 'stopping', 'waiting_approval']);

export function busyJobs(jobs = []) {
  return jobs.filter(job => busyStatuses.has(job.status))
    .map(({ id, title, status }) => ({ id, title, status }));
}

// Repeat the original invocation exactly. `npm start` already passes --env-file-if-exists=.env in execArgv;
// adding it to a direct launch could move the replacement to a RELAY_PORT the open tab does not use.
export function buildRestartSpawnSpec(current = process) {
  return {
    command: current.execPath,
    args: [...current.execArgv, ...current.argv.slice(1)],
    cwd: current.cwd(),
    env: { ...current.env, RELAY_NO_BROWSER: '1' }
  };
}

const execute = promisify(execFile);

async function checkRelaySyntax() {
  // Check modules without starting Relay or importing code that can open the database or listen.
  const scripts = new Set([process.argv[1]]);
  for (const directory of [new URL('./', import.meta.url), new URL('../mcp/', import.meta.url)]) {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      if (entry.isFile() && /\.[cm]?js$/.test(entry.name)) scripts.add(path.join(entry.parentPath, entry.name));
    }
  }
  for (const script of scripts) {
    await execute(process.execPath, ['--check', script], { windowsHide: true, timeout: 5000 }).catch(error => {
      throw Error(error.stderr?.trim() || error.message);
    });
  }
}

function spawnRelay(command, args, options) {
  if (process.platform !== 'win32') return spawn(command, args, options);
  // A detached Windows process can lose its console output. Keep its startup log in Relay's data directory.
  const dataDir = options.env.RELAY_DATA_DIR || fileURLToPath(new URL('../.relay', import.meta.url));
  const logPath = path.resolve(options.cwd, dataDir, 'restart.log');
  const log = openSync(logPath, 'a', 0o600);
  try {
    console.log('Relay · บันทึกของโปรเซสใหม่อยู่ที่ ' + logPath);
    return spawn(command, args, { ...options, stdio: ['ignore', log, log, 'ipc'] });
  } finally {
    try { closeSync(log); } catch (error) { console.error(errorMessage(error)); }
  }
}

function waitForChildReady(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => failed(Error('หมดเวลารอให้ Relay ตัวใหม่เปิด HTTP และ SQLite')), timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      child.off('error', failed);
      child.off('exit', exited);
      child.off('disconnect', disconnected);
      child.off('message', received);
    }
    function failed(error) {
      cleanup();
      reject(error);
    }
    function exited(code, signal) {
      failed(Error(`Relay ตัวใหม่หยุดก่อนเริ่มทำงาน (${signal || `exit ${code}`})`));
    }
    function disconnected() {
      failed(Error('การเชื่อมต่อกับ Relay ตัวใหม่ปิดก่อนส่งสัญญาณพร้อม'));
    }
    function received(message) {
      if (message?.type === restartMessages.failed) return failed(Error(message.error));
      if (message?.type !== restartMessages.ready) return;
      cleanup();
      resolve();
    }
    child.once('error', failed);
    child.once('exit', exited);
    child.once('disconnect', disconnected);
    child.on('message', received);
    if (child.exitCode != null || child.signalCode != null) exited(child.exitCode, child.signalCode);
  });
}

function stopChild(child) {
  if (!child.pid || child.exitCode != null || child.signalCode != null) return;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(Error('ยืนยันการหยุด Relay ตัวใหม่ไม่ได้')), 2000);
    function finish(error) {
      clearTimeout(timer);
      child.off('exit', exited);
      child.off('error', finish);
      if (error) reject(error);
      else resolve();
    }
    function exited() { finish(); }
    child.once('exit', exited);
    child.once('error', finish);
    try { child.kill('SIGKILL'); } catch (error) { finish(error); }
  });
}

const idle = { status: 'idle', source: null, reason: null, requestedAt: null, error: null };
const errorMessage = error => error?.message || String(error);

export function createRestartController({
  getJobs, closeServer, reopenServer,
  checkSyntax = checkRelaySyntax, spawnProcess = spawnRelay,
  writeMarker = marker => writeFile(marker, '', { flag: 'wx' }), exit = code => process.exit(code),
  supervised = process.env.RELAY_SUPERVISED === '1', markerPath = process.env.RELAY_RESTART_MARKER,
  onStateChange, flushMs = 200, readyTimeoutMs = 10_000
}) {
  let state = { ...idle, updatedAt: null };
  let request;
  let lastWaitingJobs = [];
  let pendingWrites = 0;
  let writeRevision = 0;

  function getState(jobs = busyJobs(getJobs())) {
    return { ...state, busyCount: jobs.length, busyJobs: jobs };
  }

  function publish(patch, jobs) {
    state = { ...state, ...patch, updatedAt: Date.now() };
    const snapshot = getState(jobs);
    onStateChange?.(snapshot);
    return snapshot;
  }

  function waitForJobs(pending, jobs) {
    if (state.status === 'waiting' && lastWaitingJobs.length === jobs.length && jobs.every((job, index) => {
      const previous = lastWaitingJobs[index];
      return job.id === previous.id && job.title === previous.title && job.status === previous.status;
    })) return getState(jobs);
    lastWaitingJobs = jobs;
    return publish({ ...pending.details, status: 'waiting', error: null }, jobs);
  }

  function fail(pending, error) {
    request = undefined;
    return publish({ ...pending.details, status: 'failed', error });
  }

  async function finishRestart(pending) {
    await delay(flushMs);
    // A request already in flight can finish adding a job during the HTTP response flush.
    const jobs = busyJobs(getJobs());
    if (jobs.length || pendingWrites) {
      waitForJobs(pending, jobs);
      return;
    }

    let child;
    try {
      await closeServer();
      if (supervised) {
        await writeMarker(markerPath);
      } else {
        const { command, args, cwd, env } = buildRestartSpawnSpec();
        child = spawnProcess(command, args, {
          cwd, env: { ...env, RELAY_RESTART_HANDOFF: '1' }, detached: true, windowsHide: false,
          stdio: ['inherit', 'inherit', 'inherit', 'ipc']
        });
        await waitForChildReady(child, readyTimeoutMs);
        if (!child.connected) throw Error('การเชื่อมต่อกับ Relay ตัวใหม่ปิดก่อนส่งมอบงาน');
        child.disconnect();
        child.unref();
      }
      exit(0);
    } catch (error) {
      let message = `รีสตาร์ท Relay ไม่สำเร็จ · ${errorMessage(error)}`;
      // A close that throws may already have released some resources.
      try {
        if (child) await stopChild(child);
        await reopenServer();
      } catch (reopenError) {
        message += ` · เปิด Relay ตัวเดิมกลับไม่สำเร็จ · ${errorMessage(reopenError)}`;
        console.error(message);
      }
      fail(pending, message);
    }
  }

  async function preflight(pending) {
    try {
      while (request === pending) {
        const jobs = busyJobs(getJobs());
        if (jobs.length || pendingWrites) return waitForJobs(pending, jobs);
        const checkedRevision = writeRevision;
        let failure;
        try {
          if (supervised && !markerPath) throw Error('ไม่พบ RELAY_RESTART_MARKER');
          if (await checkSyntax() === false) throw Error('ตรวจ syntax ไม่ผ่าน');
        } catch (error) {
          failure = `ตรวจความพร้อมก่อนรีสตาร์ท Relay ไม่ผ่าน · ${errorMessage(error)}`;
        }
        if (request !== pending) break;
        // A merge admitted during the check can change files the check has already read.
        if (writeRevision !== checkedRevision) continue;
        const remaining = busyJobs(getJobs());
        if (remaining.length) return waitForJobs(pending, remaining);
        if (failure) return fail(pending, failure);
        const snapshot = publish({ ...pending.details, status: 'restarting', error: null }, remaining);
        void finishRestart(pending);
        return snapshot;
      }
      return getState();
    } finally {
      pending.preflight = null;
    }
  }

  async function onJobsChanged() {
    const pending = request;
    if (!pending || state.status === 'restarting') return getState();
    const jobs = busyJobs(getJobs());
    if (jobs.length || pendingWrites) return waitForJobs(pending, jobs);
    pending.preflight ??= Promise.resolve().then(() => preflight(pending));
    return pending.preflight;
  }

  // Track admitted writes through completion, even if the client disconnects.
  async function runWrite(write) {
    pendingWrites++;
    writeRevision++;
    void onJobsChanged();
    try { return await write(); }
    finally {
      pendingWrites--;
      void onJobsChanged();
    }
  }

  // A request returns when it must wait or after preflight. Shutdown lets the response flush first.
  function requestRestart({ source = 'manual', reason = null } = {}) {
    request ??= { details: { source, reason, requestedAt: Date.now() } };
    return onJobsChanged();
  }

  // A returned 'restarting' state means the cancellation was refused.
  function cancelRestart() {
    if (state.status === 'restarting') return getState();
    request = undefined;
    if (state.status === 'idle') return getState();
    return publish(idle);
  }

  return { getState, requestRestart, cancelRestart, onJobsChanged, runWrite };
}
