import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isSafePath } from './git.js';
import { names } from './providers.js';

const stageKeys = ['prepare', 'plan', 'backend', 'frontend', 'integrate', 'checks', 'review', 'delivery'];
export const liveStage = status => ['running', 'waiting', 'retrying'].includes(status);
const activeStatus = status => ['running', 'stopping', 'waiting_approval'].includes(status);
const providerId = provider => Object.hasOwn(names, provider ?? '') ? provider : null;
const publicRound = round => Number.isInteger(round) && round > 0 ? round : 1;
// Worker and SQLite rounds count fixes from zero. Monitor activities and roundHistory start at one.
const workerRound = round => Number.isInteger(round) && round >= 0 ? round + 1 : 1;

export function monitorFiles(files) {
  if (!Array.isArray(files)) return null;
  const relative = files.map(name => typeof name === 'string' ? name.replaceAll('\\', '/').replace(/^\.\//, '') : name);
  return [...new Set(relative.filter(isSafePath))].slice(0, 20);
}

export function recordMonitor(job, key, patch, code) {
  const monitor = job.monitor ??= { stages: {}, activities: [] };
  const previous = monitor.stages[key];
  const previousRound = previous ? previous.round : job.stages?.[key]?.round;
  const round = patch.round ?? previous?.round ?? job.round ?? 0;
  const sameRound = workerRound(previousRound) === workerRound(round);
  if (!sameRound) rememberFinishedStage(projectStage(job, key));
  const stage = monitor.stages[key] = { ...(sameRound ? previous : {}), ...patch, round };
  rememberFinishedStage({ ...stage, key });
  if (code) {
    (monitor.activities ??= []).unshift({
      id: randomUUID(), at: Date.now(),
      round: workerRound(round), stageKey: key, code, provider: providerId(stage.provider), model: stage.model ?? null
    });
  }

  function rememberFinishedStage(item) {
    if (!Number.isFinite(item.endedAt)) return;
    const rounds = monitor.roundStages ??= {};
    const stages = rounds[workerRound(item.round)] ??= {};
    stages[key] = timelineStep(key, item);
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
  // A job created with tests off never runs the checks stage; show it as skipped, not as waiting forever.
  const notPlanned = key === 'checks' && job.runChecks === false ? 'skipped' : 'pending';
  const status = stage?.status ?? (legacy && !liveStage(legacy.status) ? legacy.status : notPlanned);
  return {
    key, status, action: stage?.action ?? null, note: stage?.note ?? legacy?.note ?? null,
    provider: providerId(stage ? stage.provider : status !== 'pending' ? legacy?.provider : null),
    model: stage?.model ?? (stage ? null : legacy?.model ?? null),
    branch: stage?.branch ?? null,
    round: stage?.round ?? (stage ? null : legacy?.round ?? null),
    startedAt: stage?.startedAt ?? (stage || status === 'pending' ? null : legacy?.startedAt ?? null),
    endedAt: stage?.endedAt ?? (stage || status === 'pending' ? null : legacy?.endedAt ?? null),
    waitUntil: stage?.waitUntil ?? null,
    plannedFiles: monitorFiles(job.plan?.[key + 'Files']),
    changedFiles: stage?.changedFiles ?? null
  };
}

function timelineStep(key, { role, provider, model, startedAt, endedAt, status }) {
  return { key, ...(role && { role }), provider: provider ?? null, model: model ?? null,
    startedAt: startedAt ?? endedAt, endedAt: endedAt ?? null, status };
}

// Monitor job payloads expose activities (newest first) and roundHistory (oldest round first).
// Each round carries its review findings and, for fixes, the reason from the preceding review or user note.
function projectRoundHistory(job, activities, stages, steps) {
  const rounds = new Map();
  function getRound(round) {
    if (!rounds.has(round)) rounds.set(round, { round, start: Infinity, end: -Infinity, steps: [], sqlKeys: new Set() });
    return rounds.get(round);
  }
  function includeTime(entry, startedAt, endedAt) {
    if (Number.isFinite(startedAt)) entry.start = Math.min(entry.start, startedAt);
    if (Number.isFinite(endedAt)) entry.end = Math.max(entry.end, endedAt);
  }
  function addStep(entry, step) {
    entry.steps.push(step);
    includeTime(entry, step.startedAt, step.endedAt);
  }

  for (const activity of activities) includeTime(getRound(activity.round), activity.at, activity.at);
  const liveStages = new Map(stages.map(stage => [stage.key, stage]));
  for (const step of steps) {
    const entry = getRound(workerRound(step.round));
    const stage = liveStages.get(step.role);
    const sameAttempt = stage && workerRound(stage.round) === entry.round && step.endedAt == null &&
      step.startedAt === stage.startedAt && step.provider === stage.provider;
    const key = step.action === 'check_subtask' ? step.action : step.role;
    addStep(entry, timelineStep(key, { ...step, model: step.model ?? (sameAttempt ? stage.model : null) }));
    entry.sqlKeys.add(key);
  }

  const stageHistory = new Map(Object.entries(job.monitor?.roundStages ?? {})
    .map(([round, saved]) => [Number(round), { ...saved }]));
  for (const stage of stages) {
    if (!Number.isFinite(stage.startedAt) && !Number.isFinite(stage.endedAt)) continue;
    const round = workerRound(stage.round);
    if (!stageHistory.has(round)) stageHistory.set(round, {});
    stageHistory.get(round)[stage.key] = stage;
  }
  for (const [round, saved] of stageHistory) {
    const entry = getRound(round);
    for (const stage of Object.values(saved)) {
      if (job.single && stage.key === 'frontend') continue;
      includeTime(entry, stage.startedAt, stage.endedAt);
      if (!entry.sqlKeys.has(stage.key)) addStep(entry, timelineStep(stage.key, stage));
    }
  }

  const reviews = new Map();
  const history = job.reviewHistory ?? [];
  const last = history.at(-1);
  // Older jobs can have a first recorded review after an unrecorded initial review.
  const offset = last ? Math.max(0, workerRound(job.lastReviewedRound) - publicRound(last.round)) : 0;
  for (const review of history) reviews.set(publicRound(review.round) + offset, review);
  if (job.monitorLegacyReview) reviews.set(job.monitorLegacyReview.round, job.monitorLegacyReview);
  else if (!last && job.review) {
    const round = job.fixRequest ? workerRound(job.fixRequest.round - 1) : workerRound(job.lastReviewedRound ?? job.round);
    reviews.set(round, { ...job.review, startedAt: job.fixRequest ? null : job.startedAt, at: job.finishedAt });
  }
  for (const [round, review] of reviews) includeTime(getRound(round), review.startedAt ?? review.at, review.at);

  const current = Math.max(workerRound(job.fixRequest?.round ?? job.round), ...rounds.keys());
  getRound(current);
  return [...rounds.values()].sort((a, b) => a.round - b.round).map(({ round, start, end, steps }) => {
    const review = reviews.get(round);
    const previous = reviews.get(round - 1);
    const request = round === current ? job.fixRequest : null;
    const findings = review?.findings ?? [];
    const priorFinding = previous?.findings?.[0];
    const reason = round === 1 ? null : review?.userNote || request?.note ||
      (priorFinding && (previous.summary || (typeof priorFinding === 'string' ? priorFinding : priorFinding.detail))) || null;
    const status = round === current ? job.status : review?.ok === false || findings.length ? 'needs_review' : 'complete';
    const startedAt = Number.isFinite(start) ? start : request?.at ?? job.startedAt ?? job.createdAt ?? 0;
    const endedAt = round === current && (activeStatus(status) || status === 'queued') ? null :
      Number.isFinite(end) ? end : round === current ? job.finishedAt ?? null : null;
    return { round, status, startedAt, endedAt, reason, findings, steps: steps.sort((a, b) => a.startedAt - b.startedAt) };
  });
}

const subtaskNumbers = numbers => Array.isArray(numbers) ? numbers.filter(number => Number.isInteger(number) && number > 0) : [];

function projectSubtasks(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item, index) => ({
    index: Number.isInteger(item.id) && item.id > 0 ? item.id : index + 1,
    title: item.title ?? '',
    status: item.status ?? 'pending',
    provider: providerId(item.provider),
    prefer: providerId(item.prefer),
    dependsOn: subtaskNumbers(item.dependsOn),
    waitingOn: subtaskNumbers(item.waitingOn)
  }));
}

function projectTeam(job) {
  const backend = projectSubtasks(job.team?.backend);
  const frontend = projectSubtasks(job.team?.frontend);
  if (!backend.length && !frontend.length) return null;
  return { fromCard: job.plan?.subtasksFromCard === true, backend, frontend };
}

function projectJob(job, projects, steps) {
  const project = projects.find(item => item.path.toLowerCase() === job.repo.toLowerCase());
  const single = Boolean(job.single);
  const approval = job.status === 'waiting_approval' && job.approval;
  const stages = stageKeys.filter(key => !single || key !== 'frontend').map(key => projectStage(job, key));
  const activities = (job.monitor?.activities ?? []).map(activity => ({ ...activity, round: publicRound(activity.round) }));
  return {
    id: job.id, title: job.title, projectName: project?.name || path.basename(job.repo) || null,
    branch: job.branch ?? null, status: job.status, startedAt: job.startedAt ?? null, single,
    approval: approval ? { kind: approval.kind, requestedAt: approval.requestedAt } : null,
    stages, activities, roundHistory: projectRoundHistory(job, activities, stages, steps),
    team: projectTeam(job)
  };
}

// The live snapshot and job history share a projection. Unrelated writes do not publish new snapshots.
export function createMonitor(state, activeIds, getRestartState, getWait = () => ({}), getSteps = () => []) {
  const clients = new Map();
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
    const activeJobs = [];
    const queuedJobs = [];
    let lastFinishedJob = null;
    const ids = new Set(activeIds());
    for (const job of state.jobs) {
      const wait = getWait(job);
      if (job.status === 'queued' || wait.waitReason === 'merge_lock') {
        queuedCount++;
        queuedJobs.push({ id: job.id, title: job.title, status: job.status, ...wait });
      }
      if (ids.has(job.id) && activeStatus(job.status)) {
        activeJobs.push({ ...projectJob(job, state.projects, getSteps(job.id)), ...wait });
      }
      if (!activeStatus(job.status) && job.status !== 'queued' && Number.isFinite(job.finishedAt) &&
          (!lastFinishedJob || job.finishedAt >= lastFinishedJob.finishedAt)) {
        lastFinishedJob = { id: job.id, title: job.title, status: job.status, finishedAt: job.finishedAt };
      }
    }
    const data = { queuedCount, queuedJobs, activeJob: activeJobs[0] ?? null, activeJobs, lastFinishedJob, restart: getRestartState?.() };
    const serialized = JSON.stringify(data);
    if (serialized === previous) return;
    previous = serialized;
    // Keep separate revisions ordered even when multiple stages change in the same millisecond.
    snapshot = { updatedAt: Math.max(Date.now(), (snapshot?.updatedAt ?? 0) + 1), ...data };
    const message = frame('snapshot', snapshot);
    for (const res of clients.keys()) send(res, message);
  }

  function json(_req, res) {
    res.set('Cache-Control', 'no-store').json(snapshot);
  }

  function jobJson(req, res) {
    res.set('Cache-Control', 'no-store');
    const job = state.jobs.find(item => item.id === req.params.id);
    if (!job) return res.status(404).json({ error: 'ไม่พบงานนี้' });
    return res.json({ ...projectJob(job, state.projects, getSteps(job.id)), ...getWait(job), finishedAt: job.finishedAt ?? null });
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
    clients.set(res, heartbeat);
    send(res, frame('snapshot', snapshot));
  }

  function close() {
    for (const [res, heartbeat] of clients) {
      clearInterval(heartbeat);
      res.end();
    }
    clients.clear();
  }

  return { publish, json, jobJson, events, close };
}
