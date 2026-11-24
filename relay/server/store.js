// SQLite storage for Relay. The app keeps working state in memory and persists it here:
// settings and Gemini usage as key/value rows, projects and jobs as JSON documents,
// and one row per AI step so tokens, cost and duration can be queried.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';

export function openStore(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, 'relay.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, doc TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at INTEGER NOT NULL, doc TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, role TEXT NOT NULL, provider TEXT NOT NULL,
      round INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
      input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, billing TEXT, error TEXT);
    CREATE INDEX IF NOT EXISTS steps_job ON steps (job_id);
  `);
  // Added later: the model an AI used and the kind of work (plan, subtask, lead check, review fix...). Older rows keep NULL.
  const stepColumns = new Set(db.prepare('PRAGMA table_info(steps)').all().map(column => column.name));
  if (!stepColumns.has('model')) db.exec('ALTER TABLE steps ADD COLUMN model TEXT');
  if (!stepColumns.has('action')) db.exec('ALTER TABLE steps ADD COLUMN action TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS steps_started ON steps (started_at)');
  const written = new Map();

  function load(fallback) {
    const settings = db.prepare('SELECT value FROM kv WHERE key = ?').get('settings');
    if (!settings) return migrateJson(fallback);
    const usage = db.prepare('SELECT value FROM kv WHERE key = ?').get('usage');
    const projects = db.prepare('SELECT doc FROM projects').all().map(row => JSON.parse(row.doc));
    const jobs = db.prepare('SELECT doc FROM jobs ORDER BY created_at').all().map(row => JSON.parse(row.doc));
    const state = { settings: JSON.parse(settings.value), usage: usage ? JSON.parse(usage.value) : {}, projects, jobs };
    remember(state);
    return state;
  }

  // First run after the SQLite switch: import state.json once and keep the old file as a backup.
  function migrateJson(fallback) {
    const file = path.join(dataDir, 'state.json');
    let state = fallback;
    if (existsSync(file)) {
      state = { ...fallback, ...JSON.parse(readFileSync(file, 'utf8')) };
      persist(state);
      renameSync(file, file + '.migrated');
    }
    return state;
  }

  function remember(state) {
    written.clear();
    written.set('kv:settings', JSON.stringify(state.settings));
    written.set('kv:usage', JSON.stringify(state.usage || {}));
    for (const project of state.projects || []) written.set('project:' + project.id, JSON.stringify(project));
    for (const job of state.jobs || []) written.set('job:' + job.id, JSON.stringify(job));
  }

  // Writes only rows whose JSON changed since the last save, and removes deleted ones.
  function persist(state) {
    const live = new Set();
    const upsertKv = db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    const upsertProject = db.prepare('INSERT INTO projects (id, doc) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET doc = excluded.doc');
    const upsertJob = db.prepare('INSERT INTO jobs (id, status, created_at, doc) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, doc = excluded.doc');
    db.exec('BEGIN');
    try {
      for (const [key, value] of [['settings', state.settings], ['usage', state.usage || {}]]) {
        const text = JSON.stringify(value);
        live.add('kv:' + key);
        if (written.get('kv:' + key) !== text) { upsertKv.run(key, text); written.set('kv:' + key, text); }
      }
      for (const project of state.projects || []) {
        const key = 'project:' + project.id;
        const text = JSON.stringify(project);
        live.add(key);
        if (written.get(key) !== text) { upsertProject.run(project.id, text); written.set(key, text); }
      }
      for (const job of state.jobs || []) {
        const key = 'job:' + job.id;
        const text = JSON.stringify(job);
        live.add(key);
        if (written.get(key) !== text) { upsertJob.run(job.id, job.status, job.createdAt || Date.now(), text); written.set(key, text); }
      }
      for (const key of [...written.keys()]) {
        if (live.has(key)) continue;
        const [kind, id] = key.split(/:(.*)/s);
        if (kind === 'project') db.prepare('DELETE FROM projects WHERE id = ?').run(id);
        if (kind === 'job') { db.prepare('DELETE FROM jobs WHERE id = ?').run(id); db.prepare('DELETE FROM steps WHERE job_id = ?').run(id); }
        written.delete(key);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function startStep({ jobId, role, provider, round, action }) {
    return Number(db.prepare('INSERT INTO steps (job_id, role, provider, round, status, started_at, action) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(jobId, role, provider, round || 0, 'running', Date.now(), action || null).lastInsertRowid);
  }

  function finishStep(id, { status, usage, error }) {
    db.prepare('UPDATE steps SET status = ?, ended_at = ?, input_tokens = ?, output_tokens = ?, cost_usd = ?, billing = ?, error = ?, model = COALESCE(?, model) WHERE id = ?')
      .run(status, Date.now(), usage?.inputTokens ?? null, usage?.outputTokens ?? null, usage?.costUsd ?? null, usage?.billing ?? null,
        error ? String(error).slice(0, 1000) : null, usage?.model ? String(usage.model).slice(0, 120) : null, id);
  }

  // Steps left "running" by a crash are closed so totals stay honest.
  function closeOpenSteps() {
    db.prepare("UPDATE steps SET status = 'interrupted', ended_at = ? WHERE status = 'running'").run(Date.now());
  }

  // Spend since a time, for the daily budget. Subscription rows count only when asked to.
  function spendSince(since, includeSubscription) {
    const row = db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM steps WHERE started_at >= ? AND (billing = 'api' OR ?)")
      .get(since, includeSubscription ? 1 : 0);
    return row.total;
  }

  // Per AI and role: how many finished steps, how many succeeded, and the average time of the successful ones.
  // The router uses this once a pair has enough samples; interrupted and cancelled steps say nothing about the AI.
  function providerStats(since) {
    const rows = db.prepare(`SELECT provider, role, COUNT(*) AS n, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
        AVG(CASE WHEN status = 'done' THEN ended_at - started_at END) AS avg_ms
      FROM steps WHERE ended_at IS NOT NULL AND status IN ('done', 'failed', 'rejected') AND started_at >= ? GROUP BY provider, role`).all(since);
    return new Map(rows.map(row => [row.provider + ':' + row.role, { n: row.n, done: row.done, avgMs: row.avg_ms }]));
  }

  // Every AI step in a time window, newest first, for the stats page. Aggregation happens in stats.js.
  function stepsSince(since, until = Date.now()) {
    return db.prepare(`SELECT id, job_id AS jobId, role, action, provider, model, round, status, started_at AS startedAt, ended_at AS endedAt,
        input_tokens AS inputTokens, output_tokens AS outputTokens, cost_usd AS costUsd, billing, error
      FROM steps WHERE started_at >= ? AND started_at < ? ORDER BY started_at DESC`).all(since, until);
  }

  function steps(jobId) {
    return db.prepare('SELECT * FROM steps WHERE job_id = ? ORDER BY id').all(jobId);
  }

  function close() {
    db.close();
  }

  return { load, persist, startStep, finishStep, closeOpenSteps, steps, stepsSince, spendSince, providerStats, close };
}
