// Aggregates for the AI stats page, built from the steps table (one row per AI call).
// Pure functions: the server passes rows and job titles in, so this is testable without a database.

const DAY_MS = 86_400_000;
const failedStatuses = new Set(['failed', 'rejected']);
const stoppedStatuses = new Set(['cancelled', 'interrupted']);

// Calendar day in Bangkok time, as YYYY-MM-DD.
export const bangkokDay = time => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(time);

function emptyBucket() {
  return { calls: 0, done: 0, failed: 0, skipped: 0, stopped: 0, running: 0, durationMs: 0, timed: 0,
    inputTokens: 0, outputTokens: 0, withTokens: 0, apiCostUsd: 0, subscriptionCostUsd: 0 };
}

function add(bucket, step) {
  bucket.calls++;
  if (step.status === 'done') bucket.done++;
  else if (failedStatuses.has(step.status)) bucket.failed++;
  else if (step.status === 'skipped') bucket.skipped++;
  else if (stoppedStatuses.has(step.status)) bucket.stopped++;
  else if (step.status === 'running') bucket.running++;
  // Average time counts successful calls only, like the router does.
  if (step.status === 'done' && step.endedAt && step.startedAt) { bucket.durationMs += step.endedAt - step.startedAt; bucket.timed++; }
  if (step.inputTokens != null || step.outputTokens != null) {
    // Codex and some CLIs do not report tokens; zeros from them are not real counts.
    if ((step.inputTokens || 0) + (step.outputTokens || 0) > 0) {
      bucket.withTokens++;
      bucket.inputTokens += step.inputTokens || 0;
      bucket.outputTokens += step.outputTokens || 0;
    }
  }
  if (Number.isFinite(step.costUsd)) bucket[step.billing === 'api' ? 'apiCostUsd' : 'subscriptionCostUsd'] += step.costUsd;
}

function finish(bucket) {
  const decided = bucket.done + bucket.failed;
  return { calls: bucket.calls, done: bucket.done, failed: bucket.failed, skipped: bucket.skipped, stopped: bucket.stopped, running: bucket.running,
    successRate: decided ? bucket.done / decided : null, avgMs: bucket.timed ? Math.round(bucket.durationMs / bucket.timed) : null,
    inputTokens: bucket.inputTokens, outputTokens: bucket.outputTokens, withTokens: bucket.withTokens,
    apiCostUsd: bucket.apiCostUsd, subscriptionCostUsd: bucket.subscriptionCostUsd };
}

function group(steps, keyOf) {
  const map = new Map();
  for (const step of steps) {
    const key = keyOf(step);
    if (!map.has(key)) map.set(key, { key, bucket: emptyBucket(), providers: {} });
    const entry = map.get(key);
    add(entry.bucket, step);
    entry.providers[step.provider] = (entry.providers[step.provider] || 0) + 1;
  }
  return [...map.values()].map(entry => ({ key: entry.key, providers: entry.providers, ...finish(entry.bucket) }))
    .sort((a, b) => b.calls - a.calls || String(a.key).localeCompare(String(b.key)));
}

// The kind of work a call did. Older rows have no action; their role is the best description.
// Implementation work is split by role (Backend / Frontend); planning and reviewing are the same work whoever's branch it is.
const roleSpecific = new Set(['implement', 'subtask', 'fix_subtask', 'fix_review']);
export const taskOf = step => !step.action ? step.role : roleSpecific.has(step.action) ? step.role + '.' + step.action : step.action;

// Nearest-rank percentile of an ascending list.
const percentile = (sorted, p) => sorted.length ? sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] : null;

// Per-model figures where anything the AI did not report is null, never 0.
function modelDetail(rows) {
  const times = rows.filter(step => step.status === 'done' && step.endedAt && step.startedAt)
    .map(step => step.endedAt - step.startedAt).sort((a, b) => a - b);
  const withTokens = rows.filter(step => (step.inputTokens || 0) + (step.outputTokens || 0) > 0);
  const costs = rows.filter(step => Number.isFinite(step.costUsd));
  return {
    p50Ms: percentile(times, 0.5), p90Ms: percentile(times, 0.9),
    avgMs: times.length ? Math.round(times.reduce((sum, value) => sum + value, 0) / times.length) : null,
    inputTokens: withTokens.length ? withTokens.reduce((sum, step) => sum + (step.inputTokens || 0), 0) : null,
    outputTokens: withTokens.length ? withTokens.reduce((sum, step) => sum + (step.outputTokens || 0), 0) : null,
    costUsd: costs.length ? costs.reduce((sum, step) => sum + step.costUsd, 0) : null
  };
}

export function buildStats(steps, { jobs = new Map(), now = Date.now(), days = 30, providers = [] } = {}) {
  const since = now - days * DAY_MS;
  const inRange = steps.filter(step => step.startedAt >= since && step.startedAt <= now);
  const total = emptyBucket();
  for (const step of inRange) add(total, step);

  const byProvider = group(inRange, step => step.provider).map(({ key, providers: _, ...rest }) => ({ provider: key, ...rest,
    models: new Set(inRange.filter(step => step.provider === key).map(step => step.model || null)).size }));
  // Keep every known AI on the page, even with no calls in the window.
  for (const provider of providers) {
    if (!byProvider.some(row => row.provider === provider)) byProvider.push({ provider, ...finish(emptyBucket()), models: 0 });
  }

  const byModel = group(inRange, step => step.provider + '\u0000' + (step.model || '')).map(({ key, providers: _, ...rest }) => {
    const [provider, model] = key.split('\u0000');
    const rows = inRange.filter(step => step.provider === provider && (step.model || '') === model);
    const detail = modelDetail(rows);
    return { provider, model: model || null, ...rest, ok: rest.done, ...detail };
  });
  const modelKey = step => step.provider + ':' + (step.model || 'unknown');
  const modelKeys = [...new Set(inRange.map(modelKey))];

  const byTask = group(inRange, step => taskOf(step)).map(({ key, ...rest }) => ({
    task: key, role: inRange.find(step => taskOf(step) === key)?.role || key, ...rest }));

  // One bar per day in the window, zero-filled, split by AI.
  const daily = [];
  const index = new Map();
  for (let time = now - (days - 1) * DAY_MS; time <= now; time += DAY_MS) {
    const day = bangkokDay(time);
    if (index.has(day)) continue;
    const row = { day, date: day, calls: 0, byProvider: {},
      byModel: Object.fromEntries(modelKeys.map(key => [key, { calls: 0, tokens: null, costUsd: null, avgMs: null }])) };
    index.set(day, row);
    daily.push(row);
  }
  for (const step of inRange) {
    const row = index.get(bangkokDay(step.startedAt));
    if (!row) continue;
    row.calls++;
    row.byProvider[step.provider] = (row.byProvider[step.provider] || 0) + 1;
  }
  // Per provider:model metrics for each day; days without calls keep calls = 0 and null metrics.
  const perDayModel = new Map();
  for (const step of inRange) {
    const key = bangkokDay(step.startedAt) + '|' + modelKey(step);
    if (!perDayModel.has(key)) perDayModel.set(key, []);
    perDayModel.get(key).push(step);
  }
  for (const row of daily) {
    for (const key of modelKeys) {
      const rows = perDayModel.get(row.day + '|' + key);
      if (!rows) continue;
      const detail = modelDetail(rows);
      row.byModel[key] = {
        calls: rows.length,
        tokens: detail.inputTokens == null && detail.outputTokens == null ? null : (detail.inputTokens || 0) + (detail.outputTokens || 0),
        costUsd: detail.costUsd, avgMs: detail.avgMs
      };
    }
  }

  const matrixMap = new Map();
  for (const step of inRange) {
    const key = [taskOf(step), step.provider, step.model ?? ''].join('\u0000');
    matrixMap.set(key, (matrixMap.get(key) || 0) + 1);
  }
  const matrix = [...matrixMap].map(([key, count]) => {
    const [type, provider, model] = key.split('\u0000');
    return { type, provider, model: model || null, count };
  }).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));

  const top = byModel[0];
  const costed = inRange.filter(step => Number.isFinite(step.costUsd));
  const costJobs = new Set(costed.map(step => step.jobId)).size;
  const costPerJob = costJobs ? costed.reduce((sum, step) => sum + step.costUsd, 0) / costJobs : null;

  const describe = step => ({ id: step.id, at: step.startedAt, endedAt: step.endedAt || null, provider: step.provider, model: step.model || null,
    task: taskOf(step), role: step.role, status: step.status, round: step.round || 0,
    durationMs: step.endedAt ? step.endedAt - step.startedAt : null,
    inputTokens: step.inputTokens ?? null, outputTokens: step.outputTokens ?? null, costUsd: step.costUsd ?? null, billing: step.billing || null,
    jobId: step.jobId, jobTitle: jobs.get(step.jobId) || null, error: step.error ? String(step.error).slice(0, 300) : null });

  return {
    range: { since, until: now, days },
    totals: { ...finish(total), jobs: new Set(inRange.map(step => step.jobId)).size,
      recordedModels: inRange.filter(step => step.model).length, recordedTasks: inRange.filter(step => step.action).length,
      topModel: top ? { provider: top.provider, model: top.model, calls: top.calls } : null, costPerJob },
    providers: byProvider,
    models: byModel,
    tasks: byTask,
    matrix,
    daily,
    failures: inRange.filter(step => failedStatuses.has(step.status)).slice(0, 12).map(describe),
    recent: inRange.slice(0, 30).map(describe)
  };
}
