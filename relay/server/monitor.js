import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isSafePath } from './git.js';
import { names } from './providers.js';

const stageKeys = ['prepare', 'plan', 'backend', 'frontend', 'integrate', 'checks', 'review', 'delivery'];
export const liveStage = status => ['running', 'waiting', 'retrying'].includes(status);
const activeStatus = status => ['running', 'stopping', 'waiting_approval'].includes(status);
const providerId = provider => Object.hasOwn(names, provider ?? '') ? provider : null;

export function monitorFiles(files) {
  if (!Array.isArray(files)) return null;
  const relative = files.map(name => typeof name === 'string' ? name.replaceAll('\\', '/').replace(/^\.\//, '') : name);
  return [...new Set(relative.filter(isSafePath))].slice(0, 20);
}

export function recordMonitor(job, key, patch, code) {
  const monitor = job.monitor ??= { stages: {}, activities: [] };
  const stage = monitor.stages[key] = { ...monitor.stages[key], ...patch };
  if (code) {
    monitor.activities.unshift({ id: randomUUID(), at: Date.now(), stageKey: key, code, provider: providerId(stage.provider) });
    monitor.activities.length = Math.min(monitor.activities.length, 20);
  }
}

export function closeMonitorStages(job, status, at) {
  for (const [key, stage] of Object.entries(job.monitor?.stages || {})) {
    if (!liveStage(stage.status)) continue;
    if (status === 'pending') {
      delete job.monitor.stages[key];
    } else {
      recordMonitor(job, key, { status, endedAt: at, action: null, waitUntil: null }, status);
    }
  }
}

function projectStage(job, key) {
  const stage = job.monitor?.stages[key];
  const legacy = job.stages?.[key];
  const status = stage?.status ?? (legacy && !liveStage(legacy.status) ? legacy.status : 'pending');
  return {
    key, status, action: stage?.action ?? null,
    provider: providerId(stage ? stage.provider : status !== 'pending' ? legacy?.provider : null),
    branch: stage?.branch ?? null,
    round: stage?.round ?? (stage ? null : legacy?.round ?? null),
    startedAt: stage?.startedAt ?? (stage || status === 'pending' ? null : legacy?.startedAt ?? null),
    endedAt: stage?.endedAt ?? (stage || status === 'pending' ? null : legacy?.endedAt ?? null),
    waitUntil: stage?.waitUntil ?? null,
    plannedFiles: monitorFiles(job.plan?.[key + 'Files']),
    changedFiles: stage?.changedFiles ?? null
  };
}

function projectJob(job, projects) {
  const project = projects.find(item => item.path.toLowerCase() === job.repo.toLowerCase());
  const single = Boolean(job.single);
  const approval = job.status === 'waiting_approval' && job.approval;
  return {
    id: job.id, title: job.title, projectName: project?.name || path.basename(job.repo) || null,
    branch: job.branch ?? null, status: job.status, startedAt: job.startedAt ?? null, single,
    approval: approval ? { kind: approval.kind, requestedAt: approval.requestedAt } : null,
    stages: stageKeys.filter(key => !single || key !== 'frontend').map(key => projectStage(job, key)),
    activities: job.monitor?.activities.slice() ?? []
  };
}

// The live snapshot and job history share a projection. Unrelated writes do not publish new snapshots.
export function createMonitor(state, activeId) {
  const clients = new Set();
  let previous;
  let snapshot;

  function frame(event, data) { return 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'; }

  function send(res, message) {
    if (res.destroyed || res.writableEnded) return;
    if (res.writableLength > 128 * 1024) res.destroy();
    else res.write(message);
  }

  function publish() {
    let queuedCount = 0;
    let activeJob = null;
    let lastFinishedJob = null;
    const id = activeId();
    for (const job of state.jobs) {
      if (job.status === 'queued') queuedCount++;
      if (job.id === id && activeStatus(job.status)) activeJob = projectJob(job, state.projects);
      if (!activeStatus(job.status) && job.status !== 'queued' && Number.isFinite(job.finishedAt) &&
          (!lastFinishedJob || job.finishedAt >= lastFinishedJob.finishedAt)) {
        lastFinishedJob = { id: job.id, title: job.title, status: job.status, finishedAt: job.finishedAt };
      }
    }
    const data = { queuedCount, activeJob, lastFinishedJob };
    const serialized = JSON.stringify(data);
    if (serialized === previous) return;
    previous = serialized;
    // Keep separate revisions ordered even when multiple stages change in the same millisecond.
    snapshot = { updatedAt: Math.max(Date.now(), (snapshot?.updatedAt ?? 0) + 1), ...data };
    const message = frame('snapshot', snapshot);
    for (const res of clients) send(res, message);
  }

  function json(_req, res) {
    res.set('Cache-Control', 'no-store').json(snapshot);
  }

  function jobJson(req, res) {
    res.set('Cache-Control', 'no-store');
    const job = state.jobs.find(item => item.id === req.params.id);
    if (!job) return res.status(404).json({ error: 'ไม่พบงานนี้' });
    return res.json({ ...projectJob(job, state.projects), finishedAt: job.finishedAt ?? null });
  }

  function events(_req, res) {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no'
    });
    const heartbeat = setInterval(() => send(res, frame('heartbeat', { at: Date.now() })), 10_000);
    res.once('close', () => {
      clients.delete(res);
      clearInterval(heartbeat);
    });
    clients.add(res);
    send(res, frame('snapshot', snapshot));
  }

  return { publish, json, jobJson, events };
}
