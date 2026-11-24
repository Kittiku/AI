import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const serverDir = new URL('../server/', import.meta.url);
const indexUrl = new URL('index.js', serverDir).href;
const storeUrl = new URL('store.js', serverDir).href;
const gitUrl = new URL('git.js', serverDir).href;
const repo = fileURLToPath(new URL('fixture-job-detail', import.meta.url));
const inline = source => 'data:text/javascript,' + encodeURIComponent(source);
const providersUrl = inline(String.raw`
export const names = { claudecode: 'Claude Code', codex: 'Codex', gemini: 'Gemini' };
export const USAGE = Symbol('usage');
export const editSchema = 'edit', planSchema = 'plan', reviewSchema = 'review', subtaskCheckSchema = 'check';
export const pacificDay = () => 'test-day';
export const refreshClaudeCode = async () => {}, refreshCodex = async () => {};
export const quota = () => Object.fromEntries(Object.keys(names).map(id => [id, { ready: true, windows: [] }]));
export const mock = {};
export async function generate(provider, _cwd, prompt, kind, _signal, onUsage, { context }) {
  const result = await mock.respond({ provider, prompt, kind, context: JSON.parse(context) });
  onUsage();
  return structuredClone(result);
}
`);
const expressUrl = inline(String.raw`
const noop = () => {};
export const routes = new Map();
const register = method => (path, handler) => routes.set(method + ' ' + path, handler);
export default Object.assign(() => ({ disable: noop, use: noop, get: register('GET'), post: register('POST'),
  put: register('PUT'), patch: register('PATCH'), delete: register('DELETE'), listen(port, _host, callback) {
    queueMicrotask(callback);
    return { address: () => ({ port }) };
  }
}), { json: noop, static: noop });
`);
const gitMockUrl = inline(String.raw`
export * from ${JSON.stringify(gitUrl)};
export const fixture = {};
export const repository = async cwd => ({ root: cwd, base: 'base' });
export const snapshot = async () => '{"trackedPaths":[]}';
export const worktreePaths = async () => [];
export const removeWorktreeFolder = async () => {};
export const editContexts = async (_cwd, fields) => ({ context: JSON.stringify(fields) });
export const applyFiles = async () => {}, applyEdits = async () => {};
export const checkpoint = async (_cwd, _message, paths) => paths.length ? 'tip' : null;
export async function git(_cwd, cmd, ...args) {
  if (cmd === 'diff') {
    if (args.includes('--numstat')) return fixture.numstat;
    if (args.includes('--name-only')) return 'current.txt\0icon.bin\0';
    if (args.includes('--stat')) return '2 files changed';
    return 'the patch';
  }
  if (cmd === 'rev-parse') return args.includes('--abbrev-ref') ? 'main' : 'tip';
  if (cmd === 'check-ignore' || cmd === 'worktree' || cmd === '-c') return '';
  throw Error('Unexpected git command: ' + cmd);
}
`);
const fsUrl = inline("export * from 'node:fs'; export const mkdirSync = () => {}, existsSync = () => false, readdirSync = () => [];");
const sqliteUrl = inline("import { DatabaseSync as SQLite } from 'node:sqlite'; export class DatabaseSync extends SQLite { constructor() { super(':memory:'); } }");

let server;
let routes;
let mock;
let fixture;

before(async () => {
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const parent = context.parentURL;
      if (specifier === './providers.js' && parent?.startsWith(serverDir.href)) return nextResolve(providersUrl, context);
      if (parent === indexUrl) {
        const mocks = { express: expressUrl, 'cross-spawn': inline('export default () => {};'), './git.js': gitMockUrl, 'node:fs': fsUrl };
        if (Object.hasOwn(mocks, specifier)) return nextResolve(mocks[specifier], context);
      }
      if (parent === storeUrl && specifier === 'node:sqlite') return nextResolve(sqliteUrl, context);
      if (parent === storeUrl && specifier === 'node:fs') return nextResolve(fsUrl, context);
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (url !== indexUrl) return loaded;
      return { ...loaded, source: loaded.source.toString() + '\nexport { defaults, drain, save, state, store, serverReady };' };
    }
  });
  try {
    server = await import(indexUrl);
    await server.serverReady;
    ({ routes } = await import(expressUrl));
    ({ mock } = await import(providersUrl));
    ({ fixture } = await import(gitMockUrl));
    const settings = structuredClone(server.defaults);
    Object.assign(settings, { agentEdits: false, maxRounds: 2, routing: { ...settings.routing, mode: 'fixed' } });
    Object.assign(settings.auto, { allProviders: false, waitMinutes: 0, retries: 0 });
    server.state.settings = settings;
  } finally {
    hooks.deregister();
  }
});

after(() => server?.store?.close());

async function request(method, route, body, id) {
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = JSON.parse(JSON.stringify(payload)); return this; }
  };
  const handler = routes.get(method + ' ' + route);
  assert.equal(typeof handler, 'function', method + ' ' + route);
  await handler({ body, params: { id }, query: {} }, res);
  return res;
}

const plan = { backend: 'Update the text', frontend: 'none', backendFiles: ['current.txt'], frontendFiles: [],
  contract: '', acceptance: 'Updated text', complexity: 'simple' };
const change = { status: 'done', summary: 'Updated text', files: [{ path: 'current.txt', content: 'new\n' }], edits: [] };
const pass = { summary: 'Passed', findings: [] };
const backendFinding = { owner: 'backend', detail: 'Update current.txt' };
const frontendFinding = { owner: 'frontend', detail: 'Update copy in the interface' };
const withoutTime = history => history.map(({ at, ...round }) => {
  assert.ok(Number.isInteger(at) && at > 0);
  return round;
});

async function startJob(type = 'feature') {
  const { statusCode, body } = await request('POST', '/api/jobs', { title: 'Job detail', prompt: 'Update text', repo, type });
  assert.equal(statusCode, 201, body.error);
  assert.deepEqual(body.reviewHistory, []);
  assert.equal(body.diffStat, null);
  await server.drain();
  return body.id;
}

async function assertSavedDetails(id) {
  const { body: state } = await request('GET', '/api/state');
  const { body: summary, statusCode } = await request('GET', '/api/jobs/:id/summary', undefined, id);
  assert.equal(statusCode, 200);
  const publicJob = state.jobs.find(job => job.id === id);
  const saved = server.store.load().jobs.find(job => job.id === id);
  for (const key of ['reviewHistory', 'diffStat', 'review']) {
    assert.deepEqual(summary[key], publicJob[key], key + ' matches /api/state');
    assert.deepEqual(summary[key], saved[key], key + ' is saved in SQLite');
  }
  return summary;
}

test('records all integrated reviews and attributes automated fixes to the rounds with findings', async () => {
  const reviews = [
    { summary: 'Two issues', findings: [backendFinding, frontendFinding] },
    { summary: 'One issue remains', findings: [backendFinding] },
    pass
  ];
  fixture.numstat = ['3\t1\t', 'old.txt', 'current.txt', '-\t-\ticon.bin', ''].join('\0');
  mock.respond = ({ kind }) => kind === 'plan' ? plan : kind === 'review' ? reviews.shift() : change;

  const summary = await assertSavedDetails(await startJob());
  assert.equal(summary.status, 'complete', summary.error);
  assert.deepEqual(reviews, []);
  assert.deepEqual(withoutTime(summary.reviewHistory), [
    { round: 1, trigger: 'initial', provider: 'codex', ok: false, userNote: null, summary: 'Two issues',
      findings: [backendFinding, frontendFinding], fixedBy: [
        { role: 'backend', provider: 'claudecode' }, { role: 'frontend', provider: 'gemini' }
      ] },
    { round: 2, trigger: 'auto_fix', provider: 'codex', ok: false, userNote: null, summary: 'One issue remains',
      findings: [backendFinding], fixedBy: [{ role: 'backend', provider: 'claudecode' }] },
    { round: 3, trigger: 'auto_fix', provider: 'codex', ok: true, userNote: null, summary: 'Passed', findings: [], fixedBy: [] }
  ]);
  assert.deepEqual(summary.review, { ...pass, ok: true });
  assert.deepEqual(summary.diffStat, { files: 2, additions: 3, deletions: 1 });
  assert.equal(summary.diff, 'the patch');
});

test('a manual fix keeps the note and successful fallback provider and reviews exactly once', async () => {
  fixture.numstat = '';
  mock.respond = ({ kind }) => kind === 'plan' ? plan : kind === 'review' ? pass : change;
  const id = await startJob('bugfix');
  assert.deepEqual((await assertSavedDetails(id)).diffStat, { files: 0, additions: 0, deletions: 0 });

  const note = 'เพิ่มข้อความอธิบาย';
  const actions = [];
  mock.respond = ({ kind, provider, context }) => {
    actions.push([kind, provider]);
    if (kind === 'review') return { summary: 'Still needs review', findings: [backendFinding] };
    assert.equal(kind, 'edit');
    assert.equal(context.userNote, note);
    if (provider === 'gemini') throw Error('Provider unavailable');
    return change;
  };
  fixture.numstat = '5\t2\tcurrent.txt\0';
  const { statusCode, body } = await request('POST', '/api/jobs/:id/fix', { note: '  ' + note + '  ', provider: 'gemini' }, id);
  assert.equal(statusCode, 200, body.error);
  await server.drain();

  const summary = await assertSavedDetails(id);
  assert.equal(summary.status, 'needs_review', summary.error);
  assert.deepEqual(actions, [['edit', 'gemini'], ['edit', 'claudecode'], ['review', 'codex']]);
  assert.equal(summary.reviewHistory.length, 2);
  assert.deepEqual(withoutTime(summary.reviewHistory).at(-1), {
    round: 2, trigger: 'manual_fix', provider: 'codex', ok: false, userNote: note,
    summary: 'Still needs review', findings: [backendFinding], fixedBy: [{ role: 'single', provider: 'claudecode' }]
  });
  assert.deepEqual(summary.diffStat, { files: 1, additions: 5, deletions: 2 });
});

test('a legacy job exposes its existing review and can record a new manual review', async () => {
  const legacyReview = { summary: 'Legacy review', findings: ['Update current.txt'] };
  const legacy = {
    id: 'legacy-detail', repo, base: 'base', branch: 'relay/legacy-detail', title: 'Legacy job',
    prompt: 'Update text', plan, settings: structuredClone(server.state.settings), single: true,
    status: 'needs_review', branchKept: true, round: 0, review: legacyReview, events: [],
    stages: { backend: { status: 'done' } }, createdAt: 1, finishedAt: 2
  };
  server.state.jobs.push(legacy);
  server.save();
  const { body: state } = await request('GET', '/api/state');
  const { body: summary, statusCode } = await request('GET', '/api/jobs/:id/summary', undefined, legacy.id);
  assert.equal(statusCode, 200);
  for (const result of [state.jobs.find(job => job.id === legacy.id), summary]) {
    assert.deepEqual(result.review, legacyReview);
    assert.deepEqual(result.reviewHistory, []);
    assert.equal(result.diffStat, null);
  }
  assert.equal(summary.diff, 'the patch');
  assert.equal(Object.hasOwn(server.store.load().jobs.find(job => job.id === legacy.id), 'reviewHistory'), false);

  mock.respond = ({ kind, context }) => {
    if (kind === 'review') return pass;
    assert.deepEqual(context.findings, [backendFinding]);
    return change;
  };
  assert.equal((await request('POST', '/api/jobs/:id/fix', {}, legacy.id)).statusCode, 200);
  await server.drain();
  const updated = await assertSavedDetails(legacy.id);
  assert.equal(updated.status, 'complete', updated.error);
  assert.deepEqual(withoutTime(updated.reviewHistory), [
    { round: 1, trigger: 'manual_fix', userNote: null, provider: 'codex', ok: true,
      summary: 'Passed', findings: [], fixedBy: [{ role: 'single', provider: 'claudecode' }] }
  ]);
});

test('resuming a manual round keeps its attribution and skips fixes that already finished', async () => {
  fixture.numstat = '1\t0\tcurrent.txt\0';
  mock.respond = ({ kind }) => kind === 'plan' ? plan : kind === 'review' ? pass : change;
  const id = await startJob('bugfix');
  const note = 'เก็บหมายเหตุเมื่อเริ่มใหม่';
  let checkpoint;
  mock.respond = ({ kind }) => {
    if (kind === 'edit') return change;
    checkpoint ??= server.store.load().jobs.find(job => job.id === id);
    throw Error('Review was interrupted');
  };
  assert.equal((await request('POST', '/api/jobs/:id/fix', { note }, id)).statusCode, 200);
  await server.drain();
  assert.equal(checkpoint.status, 'running');
  assert.equal(checkpoint.reviewHistory.length, 1);
  assert.equal(checkpoint.fixRequest.note, note);
  assert.deepEqual(checkpoint.fixRequest.fixedBy, [{ role: 'single', provider: 'claudecode' }]);

  // Restore the persisted job as a queued resume, as boot recovery does for a running job.
  const index = server.state.jobs.findIndex(job => job.id === id);
  server.state.jobs[index] = { ...checkpoint, status: 'queued', resuming: true };
  server.store.closeOpenSteps();
  server.save();
  mock.respond = ({ kind }) => {
    assert.equal(kind, 'review');
    return pass;
  };
  await server.drain();

  const summary = await assertSavedDetails(id);
  assert.equal(summary.status, 'complete', summary.error);
  assert.deepEqual(withoutTime(summary.reviewHistory).map(({ round, trigger }) => [round, trigger]), [
    [1, 'initial'], [2, 'manual_fix']
  ]);
  assert.equal(summary.reviewHistory[1].userNote, note);
  assert.deepEqual(summary.reviewHistory[1].fixedBy, [{ role: 'single', provider: 'claudecode' }]);
});
