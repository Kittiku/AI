import assert from 'node:assert/strict';
import { mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
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
  export default Object.assign(() => ({
    disable: noop, use: noop, get: noop, post: noop, put: noop, delete: noop, listen: noop
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
      return { ...loaded, source: loaded.source.toString() + '\nexport { createJob, drain, defaults, state, store, monitor };' };
    }
  });
  try {
    server = await import(indexUrl);
    ({ fake } = await import(providersUrl));
  } finally {
    hooks.deregister();
    if (priorDataDir === undefined) delete process.env.RELAY_DATA_DIR;
    else process.env.RELAY_DATA_DIR = priorDataDir;
  }
});

after(async () => {
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

function subtask(file, dependsOn = []) {
  return { title: 'Update ' + file, goal: 'Edit ' + file, files: [file], acceptance: 'The file contains the update', dependsOn };
}

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

async function runJob({ plan, contents, respond, parallel = 2, check = 'always' }) {
  const repo = await mkdtemp(path.join(root, 'repo-'));
  await git(repo, 'init', '--quiet', '--initial-branch=main');
  await git(repo, 'config', 'core.autocrlf', 'false');
  for (const [name, content] of Object.entries(contents)) await writeFile(path.join(repo, name), content);
  await git(repo, 'add', '--force', '--', ...Object.keys(contents));
  const base = await checkpoint(repo, 'Initial files');

  const settings = structuredClone(server.defaults);
  Object.assign(settings, { agentEdits: false, maxRounds: 1 });
  Object.assign(settings.auto, { allProviders: false, retries: 0, waitMinutes: 0 });
  Object.assign(settings.team, { parallel, check });
  settings.routing.mode = 'fixed';
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
  job = await server.createJob({ title: 'Team integration', prompt: 'Update the project', repo, type: 'feature' });
  await server.drain();
  assert.equal(job.status, 'complete', job.error);
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

test('a skipped UX/UI stage has no AI usage until review assigns it a fix on the integrated worktree', async () => {
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
        return { summary: 'UX/UI fix required', findings: [finding] };
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
