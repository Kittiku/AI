import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { taskCardSchema } from '../server/cards.js';
import { checkpoint, git, worktreePaths } from '../server/git.js';

const serverUrl = new URL('../server/', import.meta.url);
const indexUrl = new URL('index.js', serverUrl).href;
const storeUrl = new URL('store.js', serverUrl).href;
const inlineModule = source => 'data:text/javascript,' + encodeURIComponent(source);
const providersUrl = inlineModule(`
  export const names = { claudecode: 'Claude Code', gemini: 'Gemini', codex: 'Codex' };
  export const USAGE = Symbol('usage');
  export const planSchema = 'plan', editSchema = 'edit', reviewSchema = 'review', subtaskCheckSchema = 'check';
  export const refreshClaudeCode = async () => {}, refreshCodex = async () => {};
  export const listModels = () => { throw Error('Unexpected model listing'); };
  export const pacificDay = () => 'test-day';
  export const fake = {};
  export const quota = () => Object.fromEntries(Object.keys(names).map(provider =>
    [provider, { ready: fake.ready.includes(provider), windows: [] }]));
  export async function generate(provider, cwd, prompt, schema, signal, onUsage, { context }) {
    const answer = await fake.respond({ provider, cwd, prompt, kind: schema, context: JSON.parse(context) });
    onUsage();
    return { ...answer, [USAGE]: { inputTokens: 1, outputTokens: 1, billing: 'subscription' } };
  }
`);
const expressUrl = inlineModule(`
  const noop = () => {};
  export const routes = new Map();
  const register = method => (path, handler) => routes.set(method + ' ' + path, handler);
  export default Object.assign(() => ({
    disable: noop, use: noop, get: register('GET'), post: register('POST'), put: register('PUT'), patch: noop, delete: noop, listen: (port, _host, callback) => {
      queueMicrotask(callback);
      return { address: () => ({ port }) };
    }
  }), { json: noop, static: noop });
`);
const sqliteUrl = inlineModule(`
  import { DatabaseSync as SQLite } from 'node:sqlite';
  export class DatabaseSync extends SQLite {
    constructor() { super(':memory:'); }
  }
`);

let root;
let server;
let fake;
let routes;

// Exercise the server's queue, workflow, monitor and SQLite statements without listening
// on a port, launching AI processes or opening a database file.
before(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'relay-team-')));
  const priorDataDir = process.env.RELAY_DATA_DIR;
  process.env.RELAY_DATA_DIR = path.join(root, 'data');
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === './providers.js' && context.parentURL?.startsWith(serverUrl.href)) {
        return nextResolve(providersUrl, context);
      }
      if (context.parentURL === indexUrl) {
        if (specifier === 'express') return nextResolve(expressUrl, context);
        if (specifier === 'cross-spawn') return nextResolve(inlineModule('export default () => {};'), context);
      }
      if (context.parentURL === storeUrl && specifier === 'node:sqlite') return nextResolve(sqliteUrl, context);
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (url !== indexUrl) return loaded;
      return { ...loaded, source: loaded.source.toString() + '\nexport { createJob, drain, defaults, state, store, monitor, serverReady };' };
    }
  });
  try {
    server = await import(indexUrl);
    await server.serverReady;
    ({ fake } = await import(providersUrl));
    ({ routes } = await import(expressUrl));
  } finally {
    hooks.deregister();
    if (priorDataDir === undefined) delete process.env.RELAY_DATA_DIR;
    else process.env.RELAY_DATA_DIR = priorDataDir;
  }
});

after(async () => {
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

async function requestRoute(method, route, body, params = {}) {
  const res = {
    statusCode: 200,
    body: undefined,
    set() { return this; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = structuredClone(value); return this; }
  };
  const handler = routes.get(method + ' ' + route);
  assert.equal(typeof handler, 'function', 'Registered route: ' + method + ' ' + route);
  await handler({ body, params }, res);
  return res;
}

function monitorStream() {
  const res = new EventEmitter();
  const frames = [];
  const headers = {};
  res.set = values => Object.assign(headers, values);
  res.write = frame => frames.push(frame);
  const close = () => res.emit('close');
  routes.get('GET /api/monitor/events')({}, res);
  return {
    close, headers,
    snapshots: () => frames.filter(frame => frame.startsWith('event: snapshot\n'))
      .map(frame => JSON.parse(frame.split('\n')[1].slice('data: '.length)))
  };
}

function subtask(file, dependsOn = []) {
  return { title: 'Update ' + file, goal: 'Edit ' + file, files: [file], acceptance: 'The file contains the update', dependsOn };
}

const cardTask = (file, dependsOn = [], role = 'backend') => ({ role, ...subtask(file, dependsOn) });

function planFor(backendTasks, complexity = 'medium') {
  return {
    backend: 'Update the backend files', frontend: 'ไม่มี', contract: 'Use plain text', acceptance: 'Files contain the updates',
    backendFiles: [...new Set(backendTasks.flatMap(task => task.files))], frontendFiles: [],
    complexity, backendTasks, frontendTasks: []
  };
}

const change = (path, content) => ({ status: 'done', summary: 'Updated ' + path, files: [{ path, content }], edits: [] });
const pass = { verdict: 'pass', summary: 'Subtask passed', problems: [] };
const approve = { summary: 'Integrated review passed', findings: [] };
const stepLog = job => server.store.steps(job.id).map(({ role, round, status }) => [role, round, status]);
const snapshotFile = (context, name) => context.repo.files.find(file => file.path === name)?.content;

async function runJob({ plan, card, contents, respond, parallel = 2, check = 'always', mode = 'auto', routing = 'fixed', status = 'complete' }) {
  const repo = await mkdtemp(path.join(root, 'repo-'));
  await git(repo, 'init', '--quiet', '--initial-branch=main');
  await git(repo, 'config', 'core.autocrlf', 'false');
  for (const [name, content] of Object.entries(contents)) await writeFile(path.join(repo, name), content);
  await git(repo, 'add', '--force', '--', ...Object.keys(contents));
  const base = await checkpoint(repo, 'Initial files');

  const settings = structuredClone(server.defaults);
  Object.assign(settings, { agentEdits: false, maxRounds: 1 });
  Object.assign(settings.auto, { allProviders: false, retries: 0, waitMinutes: 0 });
  Object.assign(settings.team, { parallel, check, mode });
  settings.routing.mode = routing;
  server.state.settings = settings;
  fake.ready = ['claudecode', 'codex', 'gemini'];
  const calls = [];
  let job;
  fake.respond = request => {
    const { kind, prompt } = request;
    const role = kind === 'edit' ? /Implement only the (backend|frontend) part/.exec(prompt)?.[1] : kind;
    assert.ok(role, 'AI call has an identifiable role');
    const call = { ...request, role };
    calls.push(call);
    return kind === 'plan' ? plan : respond(call, job, calls);
  };
  if (card) {
    const { statusCode, body } = await requestRoute('POST', '/api/cards', {
      card: { title: 'Team integration', project: repo, goal: 'Update the project', ...card }
    });
    assert.equal(statusCode, 201, body?.error);
    job = server.state.jobs.find(item => item.id === body.id);
  } else {
    job = await server.createJob({ title: 'Team integration', prompt: 'Update the project', repo, type: 'feature' });
  }
  await server.drain();
  assert.equal(job.status, status, job.error);
  return { job, repo: job.repo, base, calls };
}

async function checkedTip(call) {
  assert.equal(call.kind, 'check');
  assert.ok(call.context.diff.trim(), 'lead reviews a real Git diff');
  return git(call.cwd, 'rev-parse', 'HEAD');
}

function projectedStage(job, key) {
  const res = { set() { return this; }, json(value) { return value; } };
  return server.monitor.jobJson({ params: { id: job.id } }, res).stages.find(stage => stage.key === key);
}

async function assertCleanWorktrees(job) {
  assert.deepEqual((await worktreePaths(job.repo)).map(entry => path.resolve(entry)).sort(),
    [job.repo, job.worktree].sort());
  assert.deepEqual(await readdir(path.dirname(job.worktree)), [path.basename(job.worktree)]);
  assert.deepEqual(await git(job.repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'),
    ['main', job.branch, job.branch + '-backend'].join('\n'));
  assert.equal(await git(job.worktree, 'status', '--porcelain'), '');
  assert.equal(await git(job.repo, 'rev-parse', 'HEAD'), job.base);
}

function waitFor(promise) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error('The second subtask did not reach its check while the first was running')), 20_000);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

test('independent subtasks use detached worktrees and merge in plan order before releasing a dependent', async () => {
  const plan = planFor([subtask('one.txt'), subtask('two.txt'), subtask('three.txt', [1, 2])]);
  const secondChecked = Promise.withResolvers();
  const tips = new Map();
  const startingPoints = new Map();
  const { job, repo, base, calls } = await runJob({
    plan, contents: { 'one.txt': 'base\n', 'two.txt': 'base\n', 'three.txt': 'base\n' },
    async respond(call, job) {
      if (call.kind === 'review') return approve;
      const number = call.context.subtask.number;
      if (call.kind === 'check') {
        tips.set(number, await checkedTip(call));
        if (number === 2) secondChecked.resolve();
        return pass;
      }

      startingPoints.set(number, await git(call.cwd, 'rev-parse', 'HEAD'));
      assert.equal(await git(call.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD');
      if (number === 1) await waitFor(secondChecked.promise);
      if (number === 2) {
        assert.equal(job.team.backend[2].status, 'waiting');
        assert.deepEqual(job.team.backend[2].waitingOn, [1, 2]);
      }
      if (number === 3) {
        assert.equal(job.team.backend[0].status, 'passed');
        assert.equal(job.team.backend[1].status, 'passed');
        assert.equal(snapshotFile(call.context, 'one.txt'), 'change 1\n');
        assert.equal(snapshotFile(call.context, 'two.txt'), 'change 2\n');
      }
      return change(call.context.subtask.files[0], 'change ' + number + '\n');
    }
  });

  const edits = calls.filter(call => call.kind === 'edit');
  assert.equal(new Set(edits.map(call => call.cwd)).size, 3);
  assert.deepEqual([...tips.keys()], [2, 1, 3]);
  assert.equal(startingPoints.get(1), base);
  assert.equal(startingPoints.get(2), base);
  const roleBranch = job.branch + '-backend';
  const [first, merge, third, ...extra] = (await git(repo, 'rev-list', '--first-parent', '--reverse', base + '..' + roleBranch)).split('\n');
  assert.equal(first, tips.get(1));
  assert.equal(third, tips.get(3));
  assert.deepEqual(extra, []);
  assert.equal(startingPoints.get(3), merge);
  assert.equal(await git(repo, 'rev-list', '--parents', '-1', merge), [merge, first, tips.get(2)].join(' '));
  assert.equal(await git(repo, 'rev-parse', job.branch), third);
  assert.deepEqual(job.team.backend[2].waitingOn, []);
  assert.deepEqual(job.changedFiles, ['one.txt', 'three.txt', 'two.txt']);
  await assertCleanWorktrees(job);
});

test('a real merge conflict is aborted before the subtask reruns on the role branch', async () => {
  const plan = planFor([subtask('shared.txt'), subtask('shared.txt'), subtask('dependent.txt', [2])]);
  const secondChecked = Promise.withResolvers();
  let abandonedTip;
  let conflictedWorktree;
  let reruns = 0;
  const { job, repo, base, calls } = await runJob({
    plan, contents: { 'shared.txt': 'base\n', 'dependent.txt': 'base\n' },
    async respond(call, job) {
      if (call.kind === 'review') return approve;
      const number = call.context.subtask.number;
      const branch = job.branch + '-backend';
      if (call.kind === 'check') {
        const tip = await checkedTip(call);
        if (number === 2 && call.cwd === conflictedWorktree) {
          abandonedTip = tip;
          secondChecked.resolve();
        }
        return pass;
      }

      if (number === 1) {
        await waitFor(secondChecked.promise);
        return change('shared.txt', 'first\n');
      }
      if (number === 3) {
        assert.equal(snapshotFile(call.context, 'shared.txt'), 'first\nsecond\n');
        assert.equal(job.team.backend[1].status, 'passed');
        return change('dependent.txt', 'depends on the rerun\n');
      }
      if (!conflictedWorktree) {
        conflictedWorktree = call.cwd;
        assert.equal(snapshotFile(call.context, 'shared.txt'), 'base\n');
        return change('shared.txt', 'second\n');
      }

      reruns++;
      assert.equal(await git(call.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), branch);
      assert.equal(await git(call.cwd, 'status', '--porcelain'), '');
      await assert.rejects(git(call.cwd, 'rev-parse', '--verify', '-q', 'MERGE_HEAD'), { code: 1 });
      assert.ok(!(await worktreePaths(job.repo)).map(entry => path.resolve(entry)).includes(conflictedWorktree));
      assert.equal(snapshotFile(call.context, 'shared.txt'), 'first\n');
      assert.deepEqual(job.team.backend[2].waitingOn, [2]);
      return change('shared.txt', 'first\nsecond\n');
    }
  });

  assert.equal(reruns, 1);
  assert.equal(calls.filter(call => call.kind === 'check' && call.context.subtask.number === 2).length, 2);
  assert.ok(job.events.some(event => event.title === 'รวมงาน' && event.detail.includes('งานย่อย #2 แก้ไฟล์ชนกัน')));
  const roleBranch = job.branch + '-backend';
  await assert.rejects(git(repo, 'merge-base', '--is-ancestor', abandonedTip, roleBranch), { code: 1 });
  assert.equal(await git(repo, 'rev-list', '--count', base + '..' + roleBranch), '3');
  assert.equal(await git(repo, 'show', job.branch + ':shared.txt'), 'first\nsecond');
  assert.equal(await git(repo, 'show', job.branch + ':dependent.txt'), 'depends on the rerun');
  await assertCleanWorktrees(job);
});

test('a skipped Frontend stage has no AI usage until review assigns it a fix on the integrated worktree', async () => {
  const plan = { ...planFor([], 'simple'), backendFiles: ['backend.txt'] };
  const finding = { owner: 'frontend', detail: 'Update frontend.txt to match backend.txt' };
  const { job, calls, repo } = await runJob({
    plan, contents: { 'backend.txt': 'base\n', 'frontend.txt': 'base\n' },
    async respond(call, job, calls) {
      if (call.role === 'backend') return change('backend.txt', 'backend update\n');
      if (call.role === 'frontend') {
        assert.equal(job.round, 1);
        assert.equal(job.monitor.stages.frontend.action, 'fix_review');
        assert.deepEqual(call.context.findings, [finding]);
        assert.equal(call.cwd, job.worktree);
        assert.equal(await git(call.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), job.branch);
        assert.equal(snapshotFile(call.context, 'backend.txt'), 'backend update\n');
        return change('frontend.txt', 'frontend fix\n');
      }
      assert.equal(call.kind, 'review');
      if (job.round === 0) {
        assert.deepEqual(calls.map(item => item.role), ['plan', 'backend', 'review']);
        assert.deepEqual(stepLog(job), [['plan', 0, 'done'], ['backend', 0, 'done'], ['review', 0, 'running']]);
        const saved = server.store.load().jobs.find(item => item.id === job.id);
        for (const stage of [saved.stages.frontend, saved.monitor.stages.frontend, projectedStage(job, 'frontend')]) {
          assert.equal(stage.status, 'skipped');
          assert.equal(stage.note, 'แผนไม่มีงานส่วนนี้');
          assert.equal(stage.provider, null);
        }
        assert.equal(job.usage.calls, 2);
        const integrated = projectedStage(job, 'integrate');
        assert.equal(integrated.status, 'done');
        assert.deepEqual(integrated.changedFiles, ['backend.txt']);
        assert.match(call.context.diff, /^\+backend update$/m);
        return { summary: 'Frontend fix required', findings: [finding] };
      }
      assert.match(call.context.diff, /^\+backend update$/m);
      assert.match(call.context.diff, /^\+frontend fix$/m);
      return approve;
    }
  });

  assert.deepEqual(calls.map(call => call.role), ['plan', 'backend', 'review', 'frontend', 'review']);
  assert.deepEqual(stepLog(job), [
    ['plan', 0, 'done'], ['backend', 0, 'done'], ['review', 0, 'done'],
    ['frontend', 1, 'done'], ['review', 1, 'done']
  ]);
  assert.equal(job.usage.calls, 5);
  assert.equal(projectedStage(job, 'frontend').status, 'done');
  assert.equal(projectedStage(job, 'frontend').note, '');
  assert.equal(projectedStage(job, 'review').status, 'done');
  assert.equal(await git(repo, 'show', job.branch + ':frontend.txt'), 'frontend fix');
  await assertCleanWorktrees(job);
});

for (const parallel of [1, 2, 3]) {
  test(`one planned subtask uses the normal role edit with team.parallel=${parallel}`, async () => {
    const plan = planFor([subtask('backend.txt')], 'hard');
    const { job, calls, repo } = await runJob({
      plan, parallel, contents: { 'backend.txt': 'base\n' },
      async respond(call, job) {
        if (call.kind === 'review') return approve;
        assert.equal(call.role, 'backend');
        assert.equal(call.context.subtask, undefined);
        assert.equal(await git(call.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), job.branch + '-backend');
        return change('backend.txt', 'backend update\n');
      }
    });

    assert.deepEqual(calls.map(call => call.kind), ['plan', 'edit', 'review']);
    assert.deepEqual(stepLog(job), [['plan', 0, 'done'], ['backend', 0, 'done'], ['review', 0, 'done']]);
    assert.equal(job.team.backend, undefined);
    assert.equal(await git(repo, 'show', job.branch + ':backend.txt'), 'backend update');
    await assertCleanWorktrees(job);
  });
}

test('serial work waits for a forward dependency to pass its check on the role branch', async () => {
  const plan = planFor([subtask('one.txt', [2]), subtask('two.txt')]);
  const { job, calls } = await runJob({
    plan, parallel: 1, contents: { 'one.txt': 'base\n', 'two.txt': 'base\n' },
    async respond(call, job) {
      if (call.kind === 'review') return approve;
      const { number, files } = call.context.subtask;
      assert.equal(await git(call.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), job.branch + '-backend');
      if (number === 2) assert.deepEqual(job.team.backend[0].waitingOn, [2]);
      if (call.kind === 'check') return pass;
      if (number === 1) {
        assert.equal(job.team.backend[1].status, 'passed');
        assert.deepEqual(job.team.backend[0].waitingOn, []);
        assert.equal(snapshotFile(call.context, 'two.txt'), 'change 2\n');
      }
      return change(files[0], 'change ' + number + '\n');
    }
  });
  assert.deepEqual(calls.filter(call => call.context.subtask).map(call => [call.kind, call.context.subtask.number]),
    [['edit', 2], ['check', 2], ['edit', 1], ['check', 1]]);
  await assertCleanWorktrees(job);
});

test('serial work blocks a dependent when its prerequisite fails both checks', async () => {
  const plan = planFor([subtask('one.txt'), subtask('two.txt', [1])]);
  const { job, calls } = await runJob({
    plan, parallel: 1, status: 'failed', contents: { 'one.txt': 'base\n', 'two.txt': 'base\n' },
    respond(call) {
      if (call.kind === 'check') return { verdict: 'fix', summary: 'Still broken', problems: ['Update one.txt'] };
      const { number } = call.context.subtask;
      assert.equal(number, 1);
      return change('one.txt', call.context.problems?.length ? 'attempted fix\n' : 'first attempt\n');
    }
  });
  assert.match(job.error, /#1 ยังไม่ผ่านการตรวจ/);
  assert.deepEqual(calls.map(call => call.kind), ['plan', 'edit', 'check', 'edit', 'check']);
  assert.equal(job.team.backend[0].status, 'warning');
  assert.equal(job.team.backend[0].fixes, 1);
});

test('a dependency removed by the subtask cap blocks implementation in both roles', async () => {
  const plan = {
    ...planFor([subtask('backend.txt')]),
    frontend: 'Update frontend files',
    frontendTasks: [subtask('ui.txt', [5]), ...Array.from({ length: 4 }, () => subtask('ui.txt'))]
  };
  const { job, calls } = await runJob({
    plan, status: 'failed', contents: { 'backend.txt': 'base\n', 'ui.txt': 'base\n' },
    respond: () => assert.fail('implementation must wait for a valid plan')
  });
  assert.match(job.error, /Frontend งานย่อย #1 ต้องรอ #5.*เพดานงานย่อย 4 ชิ้น/);
  assert.deepEqual(calls.map(call => call.kind), ['plan']);
  assert.deepEqual(stepLog(job), [['plan', 0, 'done']]);
  assert.equal(await git(job.worktree, 'rev-parse', 'HEAD'), job.base);
});

for (const { check, complexity, expected } of [
  { check: 'always', complexity: 'medium', expected: [1, 2] },
  { check: 'hard', complexity: 'medium', expected: [] },
  { check: 'hard', complexity: 'hard', expected: [1, 2] },
  { check: 'off', complexity: 'hard', expected: [] }
]) {
  test(`team.check=${check} with a ${complexity} plan checks ${expected.length} subtasks and still reviews the integrated diff`, async () => {
    const plan = planFor([subtask('one.txt'), subtask('two.txt', [1])], complexity);
    const { job, calls } = await runJob({
      plan, parallel: 1, check, contents: { 'one.txt': 'base\n', 'two.txt': 'base\n' },
      async respond(call, job) {
        if (call.kind === 'check') {
          await checkedTip(call);
          return pass;
        }
        if (call.kind === 'review') {
          assert.match(call.context.diff, /^\+change 1$/m);
          assert.match(call.context.diff, /^\+change 2$/m);
          return approve;
        }
        const { number, files } = call.context.subtask;
        assert.equal(await git(call.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), job.branch + '-backend');
        if (number === 2) assert.equal(snapshotFile(call.context, 'one.txt'), 'change 1\n');
        return change(files[0], 'change ' + number + '\n');
      }
    });
    assert.deepEqual(calls.filter(call => call.kind === 'check').map(call => call.context.subtask.number), expected);
    assert.equal(new Set(calls.filter(call => call.kind === 'edit').map(call => call.cwd)).size, 1);
    assert.equal(calls.filter(call => call.kind === 'review').length, 1);
    assert.deepEqual(job.team.backend.map(item => item.checker), [1, 2].map(number => expected.includes(number) ? 'codex' : null));
    assert.equal(stepLog(job).filter(([role, , status]) => role === 'review' && status === 'done').length, expected.length + 1);
    await assertCleanWorktrees(job);
  });
}

test('the API rejects invalid card dependencies and the configured per-role cap before queuing', async () => {
  const settings = structuredClone(server.defaults);
  settings.team.maxSubtasks = 2;
  assert.equal((await requestRoute('PUT', '/api/settings', settings)).statusCode, 200);
  const originalCount = server.state.jobs.length;
  const cases = [
    { tasks: [cardTask('one.txt', [3]), cardTask('two.txt')], error: /backend #1.*dependsOn.*#3 นอกช่วง/ },
    { tasks: [cardTask('one.txt', [0])], error: /dependsOn\[0\].*ต้องไม่น้อยกว่า 1/ },
    { tasks: [cardTask('one.txt', [1])], error: /backend #1.*dependsOn.*อ้างถึงตัวเอง/ },
    {
      tasks: [cardTask('one.txt', [2]), cardTask('two.txt', [1])],
      error: /backend.*dependsOn.*วงจร.*#1 → #2 → #1/
    },
    {
      tasks: [cardTask('one.txt', [2]), cardTask('ui-one.txt', [], 'frontend'), cardTask('ui-two.txt', [], 'frontend')],
      error: /backend #1.*dependsOn.*#2 นอกช่วงของฝั่งเดียวกัน/
    },
    ...['backend', 'frontend'].map(role => ({
      tasks: ['one.txt', 'two.txt', 'three.txt'].map(file => cardTask(file, [], role)),
      error: new RegExp(role + ' มี 3 รายการ.*maxSubtasks.*2 รายการต่อฝั่ง')
    }))
  ];
  for (const { tasks, error } of cases) {
    const card = { title: 'Invalid card', project: 'Example', goal: 'Update the project', subtasks: tasks };
    const { statusCode, body } = await requestRoute('POST', '/api/cards', { card });
    assert.equal(statusCode, 400);
    assert.match(body.error, /^Task Card ไม่ถูกต้อง/);
    assert.match(body.error, error);
    assert.equal(server.state.jobs.length, originalCount);
  }
});

test('MCP tools/list exposes the same optional subtask schema as the HTTP API', async () => {
  const { body: schema } = await requestRoute('GET', '/api/cards/schema');
  const output = execFileSync(process.execPath, [fileURLToPath(new URL('../mcp/server.js', import.meta.url))], {
    input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n',
    encoding: 'utf8', timeout: 10_000, windowsHide: true
  });
  const { result } = JSON.parse(output);
  const createTask = result.tools.find(tool => tool.name === 'relay_create_task');
  assert.deepEqual(schema, taskCardSchema);
  assert.deepEqual(createTask.inputSchema.properties.card, taskCardSchema);
  assert.ok(!schema.required.includes('subtasks'));
  const subtasks = schema.properties.subtasks;
  assert.equal(subtasks.type, 'array');
  assert.deepEqual(subtasks.items.required, ['role', 'title', 'goal', 'files', 'acceptance']);
  assert.deepEqual(subtasks.items.properties.prefer.enum, ['claudecode', 'codex', 'gemini']);
  assert.equal(subtasks.items.properties.dependsOn.items.minimum, 1);
});

for (const { mode, complexity, routing, fallback } of [
  { mode: 'off', complexity: 'medium', routing: 'fixed', fallback: true },
  { mode: 'auto', complexity: 'simple', routing: 'auto', fallback: false }
]) {
  test('card subtasks run with team.mode=' + mode + ' and complexity=' + complexity + ' using ' + routing + ' routing', async () => {
    const plannerTask = subtask('planner.txt');
    const plan = planFor([plannerTask], complexity);
    const one = { ...cardTask('one.txt'), prefer: 'gemini' };
    const two = cardTask('two.txt', [1]);
    const ui = cardTask('ui.txt', [], 'frontend');
    const card = { subtasks: [one, ui, two], routing: { prefer: { backend: 'codex' } } };
    const stream = monitorStream();
    try {
      assert.equal(stream.headers['Content-Type'], 'text/event-stream');
      const { job, calls, repo } = await runJob({
        plan, card, mode, routing, parallel: 1, check: 'off',
        contents: { 'one.txt': 'base\n', 'two.txt': 'base\n', 'ui.txt': 'base\n', 'planner.txt': 'base\n' },
        async respond(call, job) {
          if (call.kind === 'review') return approve;
          const { number, files: [file] } = call.context.subtask;
          if (call.role === 'backend' && number === 1) {
            const { body } = await requestRoute('GET', '/api/monitor');
            assert.equal(body.activeJob.id, job.id);
            assert.deepEqual(body.activeJob.team.backend, [
              { index: 1, title: one.title, status: 'running', provider: call.provider, prefer: 'gemini', dependsOn: [], waitingOn: [] },
              { index: 2, title: two.title, status: 'waiting', provider: null, prefer: null, dependsOn: [1], waitingOn: [1] }
            ]);
            if (fallback && call.provider === 'gemini') throw Error('Preferred provider failed');
          }
          if (call.role === 'backend' && number === 2) {
            assert.equal(snapshotFile(call.context, 'one.txt'), 'change to one.txt\n');
          }
          return change(file, 'change to ' + file + '\n');
        }
      });

      assert.equal(job.plan.subtasksFromCard, true);
      assert.equal(job.plan.complexity, complexity);
      assert.equal(job.plan.contract, plan.contract);
      assert.equal(job.plan.acceptance, plan.acceptance);
      assert.deepEqual(job.plan.backendFiles, ['planner.txt', 'one.txt', 'two.txt']);
      assert.deepEqual(job.plan.frontendFiles, ['ui.txt']);
      assert.deepEqual(job.plan.backendTasks, job.cardSubtasks.backend);
      assert.deepEqual(job.plan.frontendTasks, job.cardSubtasks.frontend);
      assert.match(calls[0].prompt, /## Subtasks/);
      assert.deepEqual(calls.filter(call => call.role === 'backend').map(call => [call.context.subtask.number, call.provider]),
        fallback ? [[1, 'gemini'], [1, 'codex'], [2, 'codex']] : [[1, 'gemini'], [2, 'codex']]);
      assert.deepEqual(calls.filter(call => call.role === 'frontend').map(call => call.context.subtask.title), [ui.title]);
      assert.deepEqual(job.changedFiles, ['one.txt', 'two.txt', 'ui.txt']);
      assert.equal(await git(repo, 'show', job.branch + ':two.txt'), 'change to two.txt');

      const snapshots = stream.snapshots();
      const active = snapshots.map(snapshot => snapshot.activeJob).filter(snapshot => snapshot?.id === job.id);
      assert.ok(active.length > 0 && active[0].team === null);
      const teams = active.map(snapshot => snapshot.team).filter(Boolean);
      assert.ok(teams.every(team => team.fromCard));
      const runningWith = provider => teams.findIndex(({ backend }) =>
        backend[0]?.status === 'running' && backend[0].provider === provider &&
        backend[1]?.status === 'waiting' && backend[1].waitingOn[0] === 1);
      const preferred = runningWith('gemini');
      assert.ok(preferred >= 0, 'SSE publishes the preferred provider and dependency wait');
      if (fallback) assert.ok(runningWith('codex') > preferred, 'SSE publishes the provider change after fallback');
      const released = teams.findIndex(({ backend }) =>
        backend[0]?.status === 'passed' && backend[1]?.status === 'running' && backend[1].waitingOn.length === 0);
      assert.ok(released > preferred, 'SSE publishes the dependent running after its prerequisite passes');
      const { body: historical } = await requestRoute('GET', '/api/monitor/jobs/:id', undefined, { id: job.id });
      assert.deepEqual(teams.at(-1), historical.team);
      assert.deepEqual(historical.team.backend.map(item => [item.status, item.provider, item.prefer, item.waitingOn]), [
        ['passed', fallback ? 'codex' : 'gemini', 'gemini', []], ['passed', 'codex', null, []]
      ]);
      assert.deepEqual(historical.team.frontend.map(item => [item.index, item.title, item.status]), [[1, ui.title, 'passed']]);
      assert.equal(snapshots.at(-1).activeJob, null);
    } finally {
      stream.close();
    }
  });
}

test('the legacy card intake keeps planner subtasks and the normal whole-role path', async () => {
  const plan = planFor([subtask('legacy.txt')], 'medium');
  const { job, calls, repo } = await runJob({
    plan, card: {}, contents: { 'legacy.txt': 'base\n' },
    respond(call) {
      if (call.kind === 'review') return approve;
      assert.equal(call.context.subtask, undefined);
      return change('legacy.txt', 'legacy change\n');
    }
  });
  assert.equal(Object.hasOwn(job, 'cardSubtasks'), false);
  assert.equal(Object.hasOwn(job.card, 'subtasks'), false);
  assert.deepEqual(structuredClone(job.plan), plan);
  assert.doesNotMatch(calls[0].prompt, /## Subtasks/);
  assert.deepEqual(calls.map(call => call.kind), ['plan', 'edit', 'review']);
  const { body } = await requestRoute('GET', '/api/monitor/jobs/:id', undefined, { id: job.id });
  assert.equal(body.team, null);
  assert.equal(await git(repo, 'show', job.branch + ':legacy.txt'), 'legacy change');
  await assertCleanWorktrees(job);
});
