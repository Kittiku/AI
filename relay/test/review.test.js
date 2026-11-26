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
const fixtureUrl = inline('export const fixture = { reviews: [], gitCalls: [], diff: "", exitCode: 0 };');
const { fixture } = await import(fixtureUrl);
const providersUrl = inline(`
  import { fixture } from ${JSON.stringify(fixtureUrl)};
  export const names = { claudecode: 'Claude Code', gemini: 'Gemini', codex: 'Codex' };
  export const USAGE = Symbol('usage');
  export const editSchema = 'edit', planSchema = 'plan', reviewSchema = 'review', subtaskCheckSchema = 'check';
  export const refreshClaudeCode = async () => {}, refreshCodex = async () => {};
  export const listModels = () => [], pacificDay = () => 'test-day';
  export const quota = () => Object.fromEntries(Object.keys(names).map(id => [id, { ready: true, windows: [] }]));
  export async function generate(_provider, _cwd, prompt, schema, _signal, _onUsage, { context }) {
    if (schema === 'plan') return { backend: 'Update text', frontend: 'none', backendFiles: ['file.txt'], frontendFiles: [] };
    if (schema === 'edit') return { status: 'done', summary: 'Edited', files: [], edits: [] };
    if (schema !== reviewSchema) throw Error('Unexpected schema: ' + schema);
    fixture.reviews.push({ prompt, context: JSON.parse(context) });
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
  export async function git(_cwd, cmd, ...args) {
    fixture.gitCalls.push([cmd, ...args]);
    if (cmd === 'rev-parse') {
      if (args.includes('--verify')) throw Error('Branch does not exist yet');
      return args.includes('--abbrev-ref') ? 'main' : 'base';
    }
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
  export function execFile() { throw Error('Unexpected Git write'); }
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
    disable: noop, use: noop, get: register('GET'), post: noop, put: noop, patch: noop, delete: noop,
    listen(port, _host, callback) {
      queueMicrotask(callback);
      return { address: () => ({ port }) };
    }
  }), { json: noop, static: noop });
`);
const fsUrl = inline("export * from 'node:fs'; export const mkdirSync = () => {}, existsSync = () => false, readdirSync = () => [];");
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
      return { ...loaded, source: loaded.source.toString() + '\nexport { collectCheckOutput, createJob, drain, state, store, serverReady };' };
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

async function get(route, id) {
  let body;
  const res = { json(value) { body = JSON.parse(JSON.stringify(value)); return this; } };
  await routes.get('GET ' + route)({ params: { id }, query: {} }, res);
  return body;
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
