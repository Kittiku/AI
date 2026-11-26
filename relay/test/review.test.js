import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, test } from 'node:test';

const serverDirectory = new URL('../server/', import.meta.url);
const indexUrl = new URL('index.js', serverDirectory).href;
const storeUrl = new URL('store.js', serverDirectory).href;
const gitUrl = new URL('git.js', serverDirectory).href;
const inline = source => 'data:text/javascript,' + encodeURIComponent(source);
const fixtureUrl = inline('export const fixture = { reviews: [], gitCalls: [], mergeCalls: [], diff: "", exitCode: 0, head: "base", branchTip: "result-tip" };');
const { fixture } = await import(fixtureUrl);
const providersUrl = inline(`
  import { fixture } from ${JSON.stringify(fixtureUrl)};
  export const names = { claudecode: 'Claude Code', gemini: 'Gemini', codex: 'Codex' };
  export const USAGE = Symbol('usage');
  export const editSchema = 'edit', planSchema = 'plan', reviewSchema = 'review', subtaskCheckSchema = 'check';
  export const refreshClaudeCode = async () => {}, refreshCodex = async () => {};
  export const listModels = () => [], pacificDay = () => 'test-day';
  export const quota = () => Object.fromEntries(Object.keys(names).map(id => [id, {
    ready: !fixture.cliOnly || id === 'gemini', windows: []
  }]));
  export async function generate(provider, _cwd, prompt, schema, _signal, _onUsage, { context, onReviewDiffTruncated }) {
    if (schema === 'plan') return { backend: 'Update text', frontend: 'none', backendFiles: ['file.txt'], frontendFiles: [] };
    if (schema === 'edit') return { status: 'done', summary: 'Edited', files: [], edits: [] };
    if (schema !== reviewSchema) throw Error('Unexpected schema: ' + schema);
    const evidence = JSON.parse(context);
    if (fixture.cliReviewTooLarge) throw Object.assign(Error('Review request too large'), { code: 'RELAY_CONTEXT_TOO_LARGE' });
    if (fixture.cliOnly && evidence.diff.length > fixture.cliDiffLimit) {
      evidence.diff = evidence.diff.slice(0, fixture.cliDiffLimit);
      evidence.truncated = true;
      onReviewDiffTruncated();
    }
    fixture.reviews.push({ provider, prompt, context: evidence });
    return { summary: 'No defects observed', findings: [] };
  }
`);
const gitMockUrl = inline(`
  export * from ${JSON.stringify(gitUrl)};
  import { fixture } from ${JSON.stringify(fixtureUrl)};
  export const repository = async cwd => ({ root: cwd, base: 'base' });
  export const snapshot = async () => '{"trackedPaths":[]}';
  export const editContexts = async (_cwd, fields) => ({ context: JSON.stringify(fields) });
  export const applyFiles = async () => {}, applyEdits = async () => {};
  export const checkpoint = async () => null, removeWorktreeFolder = async () => {};
  export async function git(cwd, cmd, ...args) {
    fixture.gitCalls.push([cmd, ...args]);
    if (cmd === 'rev-parse') {
      if (args.at(-1) === 'MERGE_HEAD') throw Object.assign(Error('No merge in progress'), { code: 1 });
      if (args.includes('--verify')) throw Error('Branch does not exist yet');
      if (args.includes('--abbrev-ref')) return fixture.target ?? 'main';
      if (args[0].startsWith('relay/')) return fixture.branchTip;
      return cwd === fixture.repo ? fixture.head : 'result-tip';
    }
    if (cmd === 'merge-base' && args[0] === '--is-ancestor') {
      if (args[1] === 'base' || args[1] === args[2] || (args[1] === 'result-tip' && args[2] === 'new-tip')) return '';
      throw Object.assign(Error('Not an ancestor'), { code: 1 });
    }
    if (cmd === 'status') return fixture.repoStatus ?? '';
    if (cmd === 'config' || cmd === 'branch') return '';
    if (cmd === 'diff' && args.includes('--shortstat')) return '1 file changed';
    if (cmd === 'diff') {
      if (args.includes('--name-only')) return 'file.txt\\0';
      if (args.includes('--numstat')) return '1\\t1\\tfile.txt\\0';
      return fixture.diff;
    }
    if (cmd === 'worktree') return '';
    throw Error('Unexpected git command: ' + cmd);
  }
`);
const childProcessUrl = inline(`
  import { EventEmitter } from 'node:events';
  import { PassThrough } from 'node:stream';
  import { fixture } from ${JSON.stringify(fixtureUrl)};
  export function execFile(file, args, _options, callback) {
    if (file !== 'git' || !args.includes('merge')) throw Error('Unexpected Git write');
    fixture.mergeCalls.push(args);
    queueMicrotask(() => {
      fixture.head = args.at(-1);
      callback(null, { stdout: '', stderr: '' });
    });
  }
  export function spawn() {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    queueMicrotask(() => {
      child.stdout.end(fixture.output);
      child.stderr.end();
      child.emit('close', fixture.exitCode);
    });
    return child;
  }
`);
const expressUrl = inline(`
  const noop = () => {};
  export const routes = new Map();
  const register = method => (path, handler) => routes.set(method + ' ' + path, handler);
  export default Object.assign(() => ({
    disable: noop, use: noop, get: register('GET'), post: register('POST'), put: noop, patch: noop, delete: noop,
    listen(port, _host, callback) {
      queueMicrotask(callback);
      return { address: () => ({ port }) };
    }
  }), { json: noop, static: noop });
`);
const fsUrl = inline("export * from 'node:fs'; export const mkdirSync = () => {}, existsSync = () => false, readdirSync = () => [], rmSync = () => {};");
const npmUrl = inline(`export { spawn as default } from ${JSON.stringify(childProcessUrl)};`);
const sqliteUrl = inline(`
  import { DatabaseSync as SQLite } from 'node:sqlite';
  export class DatabaseSync extends SQLite { constructor() { super(':memory:'); } }
`);

let server;
let routes;

before(async () => {
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === './providers.js' && context.parentURL?.startsWith(serverDirectory.href)) {
        return nextResolve(providersUrl, context);
      }
      if (context.parentURL === indexUrl) {
        const mocks = {
          express: expressUrl, 'cross-spawn': npmUrl,
          './git.js': gitMockUrl, 'node:child_process': childProcessUrl, 'node:fs': fsUrl
        };
        if (Object.hasOwn(mocks, specifier)) return nextResolve(mocks[specifier], context);
      }
      if (context.parentURL === storeUrl && specifier === 'node:sqlite') return nextResolve(sqliteUrl, context);
      if (context.parentURL === storeUrl && specifier === 'node:fs') return nextResolve(fsUrl, context);
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (url !== indexUrl) return loaded;
      return { ...loaded, source: loaded.source.toString() + '\nexport { collectCheckOutput, createJob, drain, recoverJobs, state, store, serverReady };' };
    }
  });
  try {
    server = await import(indexUrl);
    await server.serverReady;
    ({ routes } = await import(expressUrl));
    Object.assign(server.state.settings, { agentEdits: false, maxRounds: 0 });
  } finally {
    hooks.deregister();
  }
});

after(() => server?.store?.close());

const earlyFailure = [
  'TAP version 13', '# Subtest: keeps default selection', 'not ok 1 - keeps default selection', '  ---',
  "  error: 'Expected the default selection'", '  code: ERR_ASSERTION', '  ...'
].join('\r\n');
const expectedFailure = { name: 'keeps default selection', error: 'Expected the default selection' };

test('reads TAP names and diagnostics across chunks before the check tail is cut', () => {
  const child = { stdout: new PassThrough(), stderr: new PassThrough() };
  const result = server.collectCheckOutput(child, 'test');
  for (const chunk of earlyFailure.match(/[\s\S]{1,11}/g)) {
    child.stdout.write(chunk);
    child.stderr.write('unrelated log\n');
  }
  child.stdout.end('\r\n    not ok 2 - Thai output\r\n      ---\r\n      error: |-\r\n' +
    '        ค่าที่ได้ผิด\r\n        not ok in an error message\r\n      ...\r\n' +
    'not ok 3 - known issue # TODO later\r\nok 4 - success\r\n' + '# filler\r\n'.repeat(1000));
  child.stderr.end();
  const check = result(1);
  assert.deepEqual(check.failedTests, [
    expectedFailure, { name: 'Thai output', error: 'ค่าที่ได้ผิด\nnot ok in an error message' }
  ]);
  assert.equal(check.output.length, 6000);
  assert.doesNotMatch(check.output, /keeps default selection/);
});

test('bounds the serialized TAP details and handles an unterminated final line', () => {
  const child = { stdout: new PassThrough(), stderr: new PassThrough() };
  const result = server.collectCheckOutput(child, 'test');
  child.stdout.end(Array.from({ length: 100 }, (_, index) =>
    'not ok ' + (index + 1) + ' - case ' + index + '\n  ---\n  message: ' + 'x'.repeat(7000) + '\n  ...\n').join('') +
    'not ok - final case');
  child.stderr.end();
  const { failedTests } = result(1);
  assert.equal(failedTests[0].name, 'case 0');
  assert.equal(failedTests[0].error.length, 1200);
  assert.equal(failedTests.at(-1).name, 'final case');
  assert.ok(JSON.stringify(failedTests).length <= 4000);
});

async function runJob(checkOptions = {}) {
  fixture.reviews.length = 0;
  fixture.gitCalls.length = 0;
  const job = await server.createJob({ title: 'Review evidence', prompt: 'Update text', repo: path.resolve('fixture-review'), ...checkOptions });
  await server.drain();
  assert.equal(fixture.reviews.length, 1, job.error);
  return job;
}

async function request(method, route, id, body) {
  const response = { statusCode: 200, body: null };
  const res = {
    status(code) { response.statusCode = code; return this; },
    json(value) { response.body = JSON.parse(JSON.stringify(value)); return this; }
  };
  await routes.get(method + ' ' + route)({ params: { id }, query: {}, body }, res);
  return response;
}

async function get(route, id) {
  return (await request('GET', route, id)).body;
}

test('sends early TAP failures to the reviewer and exposes the stored details on both job APIs', async () => {
  fixture.diff = 'small patch';
  fixture.output = earlyFailure + '\r\n' + '# filler\r\n'.repeat(1000);
  fixture.exitCode = 1;
  const job = await runJob({ runChecks: true, extraChecks: ['example test command'] });
  const [{ context }] = fixture.reviews;
  assert.deepEqual(context.checks[0].failedTests, [expectedFailure]);
  assert.doesNotMatch(context.checks[0].output, /keeps default selection/);
  assert.equal(job.status, 'needs_review');
  assert.match(job.review.findings[0].detail, /keeps default selection\nExpected the default selection/);

  const { jobs } = await get('/api/state');
  const summary = await get('/api/jobs/:id/summary', job.id);
  const saved = server.store.load().jobs.find(item => item.id === job.id);
  for (const result of [jobs.find(item => item.id === job.id), summary, saved]) {
    assert.deepEqual(result.checks[0].failedTests, [expectedFailure]);
  }
});

test('a diff over the review limit requires manual review even with clean checks and no findings', async () => {
  fixture.output = 'TAP version 13\nok 1 - passes\n1..1\n';
  fixture.exitCode = 0;
  fixture.diff = 'x'.repeat(105_000);
  const checkOptions = { runChecks: true, extraChecks: ['example test command'] };
  const exact = await runJob(checkOptions);
  assert.equal(exact.status, 'complete');
  assert.equal(exact.review.ok, true);
  assert.equal(fixture.reviews[0].context.truncated, false);

  fixture.diff += 'omitted';
  const partial = await runJob(checkOptions);
  const [{ context, prompt }] = fixture.reviews;
  assert.equal(context.truncated, true);
  assert.equal(context.diff, fixture.diff.slice(0, 105_000));
  for (const requirement of [/defaults/i, /error, cancellation and restart/i, /without new fields/i, /race/i, /paths the tests do not cover/i]) {
    assert.match(prompt, requirement);
  }
  assert.equal(partial.status, 'needs_review');
  assert.equal(partial.review.partial, true);
  assert.equal(partial.review.ok, false);
  assert.deepEqual(partial.review.findings, []);
  assert.equal(partial.reviewHistory[0].partial, true);
  assert.ok(partial.events.some(event => event.title === 'รีวิวบางส่วน'));
  assert.equal(partial.merged, undefined);
  assert.equal(fixture.gitCalls.some(([command]) => command === 'merge'), false);
  assert.equal((await get('/api/jobs/:id/summary', partial.id)).review.partial, true);
});

test('Gemini CLI can mark a diff below the normal limit as partial', async t => {
  Object.assign(fixture, { cliOnly: true, cliDiffLimit: 20_000, diff: 'ก'.repeat(30_000) });
  t.after(() => { fixture.cliOnly = false; });
  const job = await runJob();
  const [{ provider, context }] = fixture.reviews;
  assert.equal(provider, 'gemini');
  assert.equal(context.diff, fixture.diff.slice(0, fixture.cliDiffLimit));
  assert.equal(context.truncated, true);
  assert.equal(job.review.partial, true);
  assert.equal(job.reviewHistory[0].partial, true);
  assert.equal(job.status, 'needs_review');
  assert.equal(job.merged, undefined);
});

test('an unsendable review request still delivers the branch for manual review', async t => {
  Object.assign(fixture, { cliOnly: true, cliReviewTooLarge: true, diff: 'x'.repeat(105_001) });
  t.after(() => Object.assign(fixture, { cliOnly: false, cliReviewTooLarge: false }));
  const job = await server.createJob({ title: 'Review evidence', prompt: 'Update text', repo: path.resolve('fixture-review') });
  await server.drain();
  assert.equal(job.status, 'needs_review');
  assert.equal(job.review.partial, true);
  assert.equal(job.review.ok, false);
  assert.equal(job.stages.review.status, 'failed');
  assert.ok(job.events.some(event => event.title === 'รีวิวบางส่วน'));
  assert.equal(job.merged, undefined);
});

const mergePath = '/api/jobs/:id/merge';
const approvePath = '/api/jobs/:id/approve';

async function runCard(approvals, { diff = 'small patch', exitCode = 0 } = {}) {
  const repo = path.resolve('fixture-review');
  Object.assign(fixture, { repo, diff, exitCode, output: 'TAP version 13\nok 1 - passes\n1..1\n',
    head: 'base', branchTip: 'result-tip', target: 'main', repoStatus: '', mergeCalls: [], gitCalls: [], reviews: [] });
  const { statusCode, body } = await request('POST', '/api/cards', undefined, {
    card: {
      title: 'Merge gate', project: repo, goal: 'Update text', ...(approvals && { approvals }),
      acceptance: [{ text: 'Run checks', check: 'command', command: 'example test command' }]
    }
  });
  assert.equal(statusCode, 201);
  await server.drain();
  const job = await get('/api/jobs/:id/summary', body.id);
  assert.equal(fixture.reviews.length, 1, job.error);
  return job;
}

test('a before_merge card waits after checks and review and merges once after approval', async () => {
  const schema = await get('/api/cards/schema');
  assert.deepEqual(schema.properties.approvals.items.enum, ['after_plan', 'before_merge']);

  const job = await runCard(['before_merge']);
  assert.equal(job.status, 'waiting_approval');
  assert.equal(job.approval.kind, 'before_merge');
  assert.equal(job.mergeCommand, null);
  assert.equal(job.review.ok, true);
  assert.equal(job.checks[0].code, 0);
  assert.equal(fixture.mergeCalls.length, 0);
  const state = await get('/api/state');
  assert.equal(state.activeJobs.find(item => item.id === job.id)?.approval.kind, 'before_merge');

  const saved = server.store.load().jobs.find(item => item.id === job.id);
  const approval = structuredClone(saved.approval);
  server.recoverJobs([saved]);
  assert.equal(saved.status, 'waiting_approval');
  assert.deepEqual(saved.approval, approval);

  assert.equal((await request('POST', mergePath, job.id, { target: 'main' })).statusCode, 409);
  assert.equal((await request('POST', approvePath, job.id, {
    decision: 'approve', kind: 'plan', requestedAt: job.approval.requestedAt
  })).statusCode, 409);
  const [approved, duplicate, cancel] = await Promise.all([
    request('POST', approvePath, job.id, { decision: 'approve', note: 'Reviewed', kind: 'before_merge', requestedAt: job.approval.requestedAt }),
    request('POST', approvePath, job.id, { decision: 'approve' }),
    request('POST', '/api/jobs/:id/cancel', job.id)
  ]);
  assert.deepEqual(approved.body, { ok: true, id: job.id, status: 'complete' });
  assert.equal(duplicate.statusCode, 409);
  assert.equal(cancel.statusCode, 409);
  assert.equal(fixture.mergeCalls.length, 1);
  assert.equal(fixture.reviews.length, 1);
  const merged = await get('/api/jobs/:id/summary', job.id);
  assert.equal(merged.merged.into, 'main');
  assert.equal(merged.merged.tip, 'result-tip');
  assert.equal(merged.approval, null);
});

test('rejecting before_merge keeps the job and branch and blocks a direct merge', async () => {
  const job = await runCard(['before_merge']);
  const rejection = await request('POST', approvePath, job.id, { decision: 'reject', note: 'Keep for later' });
  assert.deepEqual(rejection.body, { ok: true, id: job.id, status: 'cancelled' });
  const result = await get('/api/jobs/:id/summary', job.id);
  assert.equal(result.branch, job.branch);
  assert.equal(result.merged, null);
  assert.equal(result.approval, null);
  assert.ok(result.events.some(event => event.title === 'ปฏิเสธ merge' && event.detail.includes('Keep for later')));
  assert.equal((await request('POST', mergePath, job.id, { target: 'main' })).statusCode, 409);
  assert.equal(fixture.mergeCalls.length, 0);
  assert.equal(fixture.gitCalls.some(([command]) => command === 'branch'), false);

  const { statusCode, body } = await request('POST', '/api/jobs', undefined, {
    title: job.title, prompt: 'Update text', repo: job.repo, approvals: [], cardFrom: job.id
  });
  assert.equal(statusCode, 201);
  assert.deepEqual(body.approvalGates, ['before_merge']);
  await server.drain();
  assert.equal((await get('/api/jobs/:id/summary', body.id)).approval.kind, 'before_merge');
  await request('POST', approvePath, body.id, { decision: 'reject' });
});

test('cards without before_merge can still finish and merge without the approval endpoint', async () => {
  const job = await runCard(undefined);
  assert.equal(job.status, 'complete');
  assert.equal(job.approval, null);
  const merge = await request('POST', mergePath, job.id, { target: 'main' });
  assert.equal(merge.statusCode, 200);
  assert.equal(merge.body.merged.into, 'main');
  assert.equal(fixture.mergeCalls.length, 1);
});

test('partial review still requires manual review and an explicit merge request opens the gate', async () => {
  const job = await runCard(['before_merge'], { diff: 'x'.repeat(105_001) });
  assert.equal(job.status, 'needs_review');
  assert.equal(job.review.partial, true);
  assert.equal(job.approval, null);
  const pending = await request('POST', mergePath, job.id, { target: 'main' });
  assert.equal(pending.body.status, 'waiting_approval');
  assert.equal(pending.body.approval.kind, 'before_merge');
  assert.equal(fixture.mergeCalls.length, 0);
  await request('POST', approvePath, job.id, { decision: 'approve' });
  assert.equal(fixture.mergeCalls.length, 1);
});

test('a staged file blocks merge and the same approval can be retried', async () => {
  const job = await runCard(['before_merge']);
  const decision = { decision: 'approve', kind: 'before_merge', requestedAt: job.approval.requestedAt };
  fixture.repoStatus = 'M  staged.txt\0';
  const response = await request('POST', approvePath, job.id, decision);
  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.body.check.staged, ['staged.txt']);
  const waiting = await get('/api/jobs/:id/summary', job.id);
  assert.equal(waiting.status, 'waiting_approval');
  assert.deepEqual(waiting.approval, job.approval);
  assert.equal(fixture.mergeCalls.length, 0);
  fixture.repoStatus = '';
  const retried = await request('POST', approvePath, job.id, decision);
  assert.equal(retried.body.status, 'complete');
  assert.equal(fixture.mergeCalls.length, 1);
});

for (const change of [{ branchTip: 'new-tip' }, { target: 'release' }]) {
  test('merge approval is renewed when checkout state changes to ' + Object.values(change)[0], async () => {
    const job = await runCard(['before_merge']);
    const decision = { decision: 'approve', kind: 'before_merge', requestedAt: job.approval.requestedAt };
    Object.assign(fixture, change);
    const response = await request('POST', approvePath, job.id, decision);
    assert.equal(response.statusCode, 409);
    assert.equal(fixture.mergeCalls.length, 0);
    const waiting = await get('/api/jobs/:id/summary', job.id);
    assert.equal(waiting.status, 'waiting_approval');
    assert.equal(waiting.branch, job.branch);
    assert.equal(waiting.approval.target, fixture.target);
    assert.equal(waiting.approval.tip, fixture.branchTip);
    assert.ok(waiting.approval.requestedAt > job.approval.requestedAt);
    assert.equal((await request('POST', approvePath, job.id, decision)).statusCode, 409);
    await request('POST', approvePath, job.id, { ...decision, requestedAt: waiting.approval.requestedAt });
    assert.equal(fixture.mergeCalls.length, 1);
  });
}

test('a previous merge still requires approval for a new commit or destination and permits cleanup', async () => {
  const job = await runCard(['before_merge']);
  await request('POST', approvePath, job.id, { decision: 'approve' });
  assert.equal(fixture.mergeCalls.length, 1);

  fixture.branchTip = 'new-tip';
  const newer = await request('POST', mergePath, job.id, { target: 'main' });
  assert.equal(newer.body.approval.tip, 'new-tip');
  assert.equal(newer.body.merged.tip, 'result-tip');
  assert.equal(fixture.mergeCalls.length, 1);
  await request('POST', approvePath, job.id, { decision: 'approve' });
  assert.equal(fixture.mergeCalls.length, 2);

  Object.assign(fixture, { target: 'release', head: 'base' });
  const other = await request('POST', mergePath, job.id, { target: 'release' });
  assert.equal(other.body.approval.target, 'release');
  assert.equal(other.body.merged.into, 'main');
  assert.equal(fixture.mergeCalls.length, 2);
  await request('POST', approvePath, job.id, { decision: 'approve' });
  assert.equal(fixture.mergeCalls.length, 3);

  const cleaned = await request('POST', mergePath, job.id, { target: 'release', cleanup: true });
  assert.equal(cleaned.body.status, 'complete');
  assert.equal(cleaned.body.approval, null);
  assert.equal(cleaned.body.worktree, null);
  assert.equal(cleaned.body.merged.tip, 'new-tip');
  assert.equal(fixture.mergeCalls.length, 3);
});

test('the recorded rebase can be cleaned up without another approval', async () => {
  const { id } = await runCard(['before_merge']);
  const job = server.state.jobs.find(item => item.id === id);
  fixture.head = 'rebased-tip';
  Object.assign(job, {
    status: 'complete', approval: null,
    merged: { into: 'main', tip: 'result-tip', rebasedTip: 'rebased-tip', before: 'base', commit: fixture.head }
  });

  const cleaned = await request('POST', mergePath, id, { target: 'main', cleanup: true });
  assert.equal(cleaned.statusCode, 200);
  assert.equal(cleaned.body.worktree, null);
  assert.equal(cleaned.body.branchKept, true);
  assert.equal(cleaned.body.approval, null);
  assert.equal(cleaned.body.merged.rebasedTip, 'rebased-tip');
  assert.equal(fixture.mergeCalls.length, 0);
});
