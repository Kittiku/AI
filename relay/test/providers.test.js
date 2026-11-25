import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Each copy freezes the Gemini mode and environment at module load.
for (const name of ['GOOGLE_API_KEY', 'RELAY_GEMINI_CLI_MODEL', 'RELAY_GEMINI_MODEL', 'RELAY_CLAUDE_CODE_MODEL', 'RELAY_CODEX_MODEL']) {
  delete process.env[name];
}
process.env.RELAY_AGY_BIN = path.join(tmpdir(), 'relay-test-missing-agy.exe');
process.env.RELAY_GEMINI_BIN = path.join(tmpdir(), 'relay-test-missing-gemini.exe');
process.env.RELAY_GEMINI_MODE = 'api';
process.env.GEMINI_API_KEY = 'test-key';
const api = await import('../server/providers.js?mode=api');
delete process.env.GEMINI_API_KEY;
process.env.RELAY_GEMINI_MODE = 'agy';
const cli = await import('../server/providers.js?mode=cli');
// Let the start-up connection check (which fails: the binaries do not exist) finish before faking processes.
await cli.refreshGemini();

const { fitGeminiCliInput, geminiCliEncoder, reviewSchema } = api;
const thai = 'ข้อความภาษาไทยสำหรับทดสอบ';
const prompt = 'คำสั่งของงาน: แก้ไฟล์ตามแผน\nUSER TASK\nทดสอบ';
const bytes = text => Buffer.byteLength(text, 'utf8');
const file = (name, repeat) => ({ path: name, content: thai.repeat(repeat) });

function contextOf({ files, requiredPaths, omittedPaths = [], omitted = 0 }) {
  return JSON.stringify({ plan: { backend: 'แผน ' + thai }, subtask: { title: 'งานย่อย' },
    repo: { trackedPaths: files.map(item => item.path), files, requiredPaths, omitted, omittedPaths } });
}

const encoders = { text: geminiCliEncoder(prompt, reviewSchema, false), stream: geminiCliEncoder(prompt, reviewSchema, true) };
function unpack(input, mode) {
  const text = mode === 'stream' ? JSON.parse(input).message.content : input;
  return JSON.parse(text.slice(text.indexOf('\nCONTEXT\n') + '\nCONTEXT\n'.length));
}

for (const mode of ['text', 'stream']) {
  const encode = encoders[mode];

  test(`${mode}: context that fits is sent unchanged`, () => {
    const context = contextOf({ files: [file('a.js', 20), file('b.js', 20)], requiredPaths: ['a.js'] });
    const input = fitGeminiCliInput(context, encode, 88_000);
    assert.equal(input, encode(context));
    assert.ok(bytes(input) <= 88_000);
    if (mode === 'stream') assert.ok(input.endsWith('\n') && JSON.parse(input).event === 'user');
    else assert.equal(input, prompt + '\nCONTEXT\n' + context);
  });

  test(`${mode}: size is measured in UTF-8 bytes and optional files are trimmed`, () => {
    // Each file is about 7.5 KB of Thai text (3 bytes per character, about 2.5 KB of characters).
    const files = [file('required.js', 100), ...Array.from({ length: 8 }, (_, index) => file('optional' + index + '.js', 100))];
    const context = contextOf({ files, requiredPaths: ['required.js'], omittedPaths: ['big.css'], omitted: 2 });
    const limit = 40_000;
    assert.ok(encode(context).length < limit, 'the character count alone would fit');
    assert.ok(bytes(encode(context)) > limit, 'the encoded bytes do not fit');
    const input = fitGeminiCliInput(context, encode, limit);
    assert.ok(bytes(input) <= limit);
    const repo = unpack(input, mode).repo;
    assert.equal(repo.files[0].path, 'required.js');
    assert.equal(repo.files[0].content, thai.repeat(100));
    const kept = repo.files.slice(1).map(item => item.path);
    assert.ok(kept.length > 0 && kept.length < 8);
    assert.deepEqual(kept, files.slice(1, 1 + kept.length).map(item => item.path), 'optional files keep their order');
    const dropped = files.slice(1 + kept.length).map(item => item.path);
    assert.deepEqual(repo.omittedPaths, [...dropped, 'big.css']);
    assert.equal(repo.omitted, 2 + dropped.length);
    // As many optional files as possible: one more would not fit.
    const more = JSON.parse(JSON.stringify(unpack(input, mode)));
    more.repo.files.push(files[1 + kept.length]);
    more.repo.omittedPaths.shift();
    assert.ok(bytes(encode(JSON.stringify(more))) > limit);
  });

  test(`${mode}: required files missing from the snapshot do not block sending`, () => {
    const small = contextOf({ files: [file('a.js', 10)], requiredPaths: ['a.js', 'missing.js'], omittedPaths: ['missing.js'] });
    assert.equal(fitGeminiCliInput(small, encode, 88_000), encode(small));

    const files = [file('a.js', 100), file('b.js', 100), file('c.js', 100)];
    const context = contextOf({ files, requiredPaths: ['A.js', 'missing.js'], omittedPaths: ['other.md'] });
    const limit = 20_000;
    const input = fitGeminiCliInput(context, encode, limit);
    assert.ok(bytes(input) <= limit);
    const repo = unpack(input, mode).repo;
    assert.deepEqual(repo.files.map(item => item.path), ['a.js', 'b.js']);
    assert.equal(repo.omittedPaths[0], 'missing.js', 'a missing required file is listed first');
    assert.deepEqual(repo.omittedPaths, ['missing.js', 'c.js', 'other.md']);
  });

  test(`${mode}: omittedPaths is shortened when only the required files fit`, () => {
    const omittedPaths = Array.from({ length: 100 }, (_, index) => 'src/ส่วนที่ไม่ได้ส่ง/' + 'ไฟล์'.repeat(10) + index + '.js');
    const context = contextOf({ files: [file('a.js', 400), file('b.js', 50)], requiredPaths: ['a.js', 'gone.js'], omittedPaths });
    const required = bytes(encode(contextOf({ files: [file('a.js', 400)], requiredPaths: ['a.js', 'gone.js'], omittedPaths: ['gone.js'] })));
    const limit = required + 3_000;
    const input = fitGeminiCliInput(context, encode, limit);
    assert.ok(bytes(input) <= limit);
    const repo = unpack(input, mode).repo;
    assert.deepEqual(repo.files.map(item => item.path), ['a.js']);
    assert.equal(repo.omittedPaths[0], 'gone.js');
    assert.equal(repo.omittedPaths[1], 'b.js');
    assert.ok(repo.omittedPaths.length > 2 && repo.omittedPaths.length < 100);
  });

  test(`${mode}: required files over the limit raise RELAY_CONTEXT_TOO_LARGE`, () => {
    const context = contextOf({ files: [file('a.js', 2_000), file('b.js', 10)], requiredPaths: ['a.js'] });
    assert.throws(() => fitGeminiCliInput(context, encode, 30_000), error => error.code === 'RELAY_CONTEXT_TOO_LARGE');
    assert.throws(() => fitGeminiCliInput(thai.repeat(2_000), encode, 30_000), error => error.code === 'RELAY_CONTEXT_TOO_LARGE');
  });
}

// --- Messages sent to each AI, checked byte for byte with stand-in processes ---

const answer = { summary: 'ตรวจแล้ว ' + thai, findings: [] };
const bigContext = contextOf({ files: Array.from({ length: 20 }, (_, index) => file('f' + index + '.js', 300)), requiredPaths: ['f0.js'] });
const cliContext = contextOf({ files: [file('f0.js', 300)], requiredPaths: ['f0.js'] });
const expected = prompt + '\nCONTEXT\n' + bigContext;
// Results carry token usage under a symbol key; compare only the JSON fields.
const plain = value => JSON.parse(JSON.stringify(value));

function fakeProcess() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    if (!child.closed) { child.closed = true; setImmediate(() => child.emit('close', null)); }
    return true;
  };
  child.reply = (text, code = 0) => {
    child.stdout.once('end', () => { if (!child.closed) { child.closed = true; child.emit('close', code); } });
    child.stdout.end(text);
  };
  return child;
}

function withStdin(onInput) {
  const calls = [];
  const spawn = (binary, args) => {
    const child = fakeProcess();
    const chunks = [];
    child.stdin.on('data', chunk => chunks.push(chunk));
    child.stdin.on('end', () => {
      const input = Buffer.concat(chunks);
      calls.push({ binary, args, input });
      child.reply(onInput(input));
    });
    return child;
  };
  return { spawn, calls };
}

const run = (module, provider, options) => module.generate(provider, tmpdir(), prompt, reviewSchema, new AbortController().signal, () => {}, options);

test('Claude Code gets prompt + CONTEXT + context, byte for byte', async () => {
  const fake = withStdin(() => JSON.stringify({ structured_output: answer, is_error: false, usage: {} }) + '\n');
  api.processes.spawn = fake.spawn;
  const result = await run(api, 'claudecode', { context: bigContext, geminiCliContext: cliContext });
  assert.deepEqual(plain(result), answer);
  assert.equal(fake.calls.length, 1);
  assert.ok(fake.calls[0].input.equals(Buffer.from(expected, 'utf8')));
});

function fakeCodex(module, {
  models = [{ model: 'test-model', isDefault: true }], rejected = new Set(),
  account = { type: 'chatgpt' }, list = () => ({ data: models })
} = {}) {
  const requests = [];
  const sent = [];
  const attempted = [];
  const args = [];
  module.processes.spawn = (_binary, flags) => {
    args.push(flags);
    const child = fakeProcess();
    const send = message => child.stdout.write(JSON.stringify(message) + '\n');
    const threads = new Map();
    createInterface({ input: child.stdin }).on('line', line => {
      const message = JSON.parse(line);
      const { method, id, params } = message;
      requests.push({ method, params });
      if (method === 'initialize') send({ id, result: {} });
      else if (method === 'account/read') send({ id, result: { account } });
      else if (method === 'model/list') {
        const result = list(params);
        if (result instanceof Error) send({ id, error: { message: result.message } });
        else send({ id, result });
      } else if (message.method === 'thread/start') {
        const { model } = message.params;
        attempted.push(model);
        const id = 'thread-' + attempted.length;
        threads.set(id, model);
        send({ id: message.id, result: { thread: { id } } });
      } else if (message.method === 'turn/start') {
        const { threadId, input } = message.params;
        sent.push(input[0].text);
        send({ id: message.id, result: {} });
        if (rejected.has(threads.get(threadId))) {
          send({ method: 'turn/completed', params: { threadId,
            turn: { status: 'failed', error: { message: 'model_not_found' } } } });
        } else {
          send({ method: 'item/completed', params: { threadId, item: { type: 'agentMessage', text: JSON.stringify(answer) } } });
          send({ method: 'turn/completed', params: { threadId, turn: { status: 'completed' } } });
        }
      }
    });
    return child;
  };
  return { sent, attempted, args, requests };
}

test('model suggestions list selectable Codex IDs across pages without starting a turn', async () => {
  const { requests, args } = fakeCodex(api, {
    list: ({ cursor }) => cursor === 'more'
      ? { data: [{ model: 'account-first' }, { model: 'account-third' }], nextCursor: null }
      : { data: [{ id: 'entry-id', model: 'account-first' }, { id: 'account-second' },
        { model: 'hidden', hidden: true }, { model: '' }, { model: 42 }, null], nextCursor: 'more' }
  });
  const [models, concurrent] = await Promise.all([api.listModels(tmpdir()), api.listModels(tmpdir())]);
  assert.deepEqual(models, {
    claudecode: ['opus', 'sonnet', 'haiku'],
    codex: ['account-first', 'account-second', 'account-third'],
    gemini: ['gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-3.5-flash-lite']
  });
  assert.deepEqual(concurrent, models);
  assert.deepEqual(args, [['app-server']]);
  assert.deepEqual(requests.map(({ method }) => method), ['initialize', 'initialized', 'account/read', 'model/list', 'model/list']);
  assert.deepEqual(requests.slice(2).map(({ params }) => params), [
    { refreshToken: false },
    { includeHidden: false, limit: 50 },
    { includeHidden: false, limit: 50, cursor: 'more' }
  ]);
});

test('model suggestions survive missing Codex, a signed-out account and a failed model list', async () => {
  const unavailable = {
    claudecode: ['opus', 'sonnet', 'haiku'],
    codex: [],
    gemini: ['gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-3.5-flash-lite']
  };
  api.processes.spawn = () => {
    const child = fakeProcess();
    queueMicrotask(() => child.emit('error', Object.assign(Error('Missing Codex binary'), { code: 'ENOENT' })));
    return child;
  };
  assert.deepEqual(await api.listModels(tmpdir()), unavailable);

  const signedOut = fakeCodex(api, { account: null });
  assert.deepEqual(await api.listModels(tmpdir()), unavailable);
  assert.ok(!signedOut.requests.some(({ method }) => method === 'model/list'));

  fakeCodex(api, { list: () => Error('Catalog unavailable') });
  assert.deepEqual(await api.listModels(tmpdir()), unavailable);

  fakeCodex(api, { models: [{ id: 'available-again' }] });
  assert.deepEqual(await api.listModels(tmpdir()), { ...unavailable, codex: ['available-again'] });
});

test('Codex gets prompt + CONTEXT + context, byte for byte', async () => {
  const { sent } = fakeCodex(api);
  const result = await run(api, 'codex', { context: bigContext, geminiCliContext: cliContext });
  assert.deepEqual(plain(result), answer);
  assert.equal(sent.length, 1);
  assert.ok(Buffer.from(sent[0], 'utf8').equals(Buffer.from(expected, 'utf8')));
});

test('Gemini API gets prompt + CONTEXT + context, byte for byte', async t => {
  const bodies = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, headers: new Headers(),
      json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }], usageMetadata: {} }) };
  };
  const result = await run(api, 'gemini', { context: bigContext, geminiCliContext: cliContext });
  assert.deepEqual(plain(result), answer);
  assert.equal(bodies.length, 1);
  assert.ok(Buffer.from(bodies[0].contents[0].parts[0].text, 'utf8').equals(Buffer.from(expected, 'utf8')));
});

test('Antigravity CLI gets geminiCliContext as stream JSON within the limit', async () => {
  const fake = withStdin(() => JSON.stringify({ event: 'result', result: { status: 'SUCCESS', structured_output: answer } }) + '\n');
  cli.processes.spawn = fake.spawn;
  const result = await run(cli, 'gemini', { context: bigContext, geminiCliContext: cliContext });
  assert.deepEqual(plain(result), answer);
  assert.equal(fake.calls.length, 1);
  const input = fake.calls[0].input;
  assert.ok(input.equals(Buffer.from(cli.geminiCliEncoder(prompt, reviewSchema, true)(cliContext), 'utf8')));
  assert.ok(input.length <= 88_000);
  assert.ok(fake.calls[0].args.includes('stream-json'));
});

test('Antigravity CLI trims the normal context when no CLI context is given', async () => {
  const fake = withStdin(() => JSON.stringify({ event: 'result', result: { status: 'SUCCESS', structured_output: answer } }) + '\n');
  cli.processes.spawn = fake.spawn;
  assert.ok(bytes(cli.geminiCliEncoder(prompt, reviewSchema, true)(bigContext)) > 88_000);
  await run(cli, 'gemini', { context: bigContext });
  const input = fake.calls[0].input;
  assert.ok(input.length <= 88_000);
  const repo = unpack(input.toString('utf8'), 'stream').repo;
  assert.equal(repo.files[0].path, 'f0.js');
  assert.ok(repo.files.length < 20);
});

test('Antigravity CLI is not started when even the required files are too large', async () => {
  const fake = withStdin(() => '');
  cli.processes.spawn = fake.spawn;
  const huge = contextOf({ files: [file('f0.js', 4_000)], requiredPaths: ['f0.js'] });
  await assert.rejects(run(cli, 'gemini', { context: huge }), error => error.code === 'RELAY_CONTEXT_TOO_LARGE');
  assert.equal(fake.calls.length, 0);
});

const claudeArgs = [
  '-p', 'Complete the Relay request provided on stdin. Use the files in the current directory only as read-only reference.',
  '--output-format', 'json', '--json-schema', JSON.stringify(reviewSchema),
  '--tools', 'Read,Glob,Grep', '--allowedTools', 'Read,Glob,Grep',
  '--max-turns', String(Number(process.env.RELAY_CLAUDE_CODE_MAX_TURNS) || 40), '--no-session-persistence'
];
const agyArgs = ['--input-format', 'stream-json', '--output-format', 'stream-json',
  '--json-schema', JSON.stringify(reviewSchema), '--disable-slash-commands'];
const claudeResult = JSON.stringify({ structured_output: answer, is_error: false, usage: {} });
const agyResult = JSON.stringify({ event: 'result', result: { status: 'SUCCESS', structured_output: answer } }) + '\n';

test('Claude and Antigravity retain their full argument lists when the call uses automatic model selection', async t => {
  const claude = withStdin(() => claudeResult);
  const agy = withStdin(() => agyResult);
  api.processes.spawn = claude.spawn;
  cli.processes.spawn = agy.spawn;
  for (const options of [undefined, { model: '' }]) {
    await run(api, 'claudecode', options);
    await run(cli, 'gemini', options);
  }
  assert.deepEqual(claude.calls.map(call => call.args), [claudeArgs, claudeArgs]);
  assert.deepEqual(agy.calls.map(call => call.args), [agyArgs, agyArgs]);

  process.env.RELAY_CLAUDE_CODE_MODEL = 'test-claude-env';
  process.env.RELAY_GEMINI_CLI_MODEL = 'test-gemini-cli-env';
  process.env.RELAY_GEMINI_MODEL = 'test-gemini-api-env';
  t.after(() => {
    delete process.env.RELAY_CLAUDE_CODE_MODEL;
    delete process.env.RELAY_GEMINI_CLI_MODEL;
    delete process.env.RELAY_GEMINI_MODEL;
  });
  const fromEnv = await import('../server/providers.js?mode=cli-model-env');
  await fromEnv.refreshGemini();
  fromEnv.processes.spawn = agy.spawn;
  for (const options of [undefined, { model: '' }, { model: 'role-model' }, undefined]) {
    await run(api, 'claudecode', options);
    await run(fromEnv, 'gemini', options);
  }
  assert.deepEqual(claude.calls.slice(2).map(call => call.args), ['test-claude-env', 'test-claude-env', 'role-model', 'test-claude-env']
    .map(model => [...claudeArgs, '--model', model]));
  assert.deepEqual(agy.calls.slice(2).map(call => call.args), ['test-gemini-cli-env', 'test-gemini-cli-env', 'role-model', 'test-gemini-cli-env']
    .map(model => [...agyArgs, '--model', model]));
});

test('Claude Code and Antigravity retry rejected models with the default CLI arguments', async () => {
  const rejected = 'unavailable-pinned-model';
  for (const { module, provider, baseArgs, failure, success } of [
    { module: api, provider: 'claudecode', baseArgs: claudeArgs, success: claudeResult,
      failure: JSON.stringify({ is_error: true, result: 'There is an issue with the selected model. It may not exist.' }) },
    { module: cli, provider: 'gemini', baseArgs: agyArgs, success: agyResult,
      failure: JSON.stringify({ event: 'result', result: { status: 'ERROR', error: 'ModelNotFoundError' } }) + '\n' }
  ]) {
    const warnings = [];
    let tries = 0;
    let counted = 0;
    const fake = withStdin(() => ++tries === 1 ? failure : success);
    module.processes.spawn = fake.spawn;
    const result = await module.generate(provider, tmpdir(), prompt, reviewSchema, new AbortController().signal, () => { counted++; }, {
      model: rejected, beforeModelRetry: model => { warnings.push(model); assert.equal(counted, 0); }
    });
    assert.deepEqual(plain(result), answer);
    assert.deepEqual(warnings, [rejected]);
    assert.deepEqual(fake.calls.map(call => call.args), [[...baseArgs, '--model', rejected], baseArgs]);
    assert.notEqual(result[module.USAGE].model, rejected);
    assert.equal(counted, provider === 'gemini' ? 1 : 0);
  }
});

test('Codex keeps its automatic model order and an override only affects that call', async t => {
  const preferred = { model: 'preferred', isDefault: true };
  const alternate = { id: 'alternate' };
  const rejected = new Set(['preferred']);
  const { attempted, args } = fakeCodex(api, { models: [preferred, alternate], rejected });
  const automatic = await run(api, 'codex');
  assert.deepEqual(attempted.splice(0), ['preferred', 'alternate']);
  assert.equal(automatic[api.USAGE].model, 'alternate');
  rejected.clear();

  const pinned = await run(api, 'codex', { model: 'role-model' });
  assert.equal(pinned[api.USAGE].model, 'role-model');
  await run(api, 'codex', { model: '' });
  assert.deepEqual(attempted.splice(0), ['role-model', 'alternate']);

  process.env.RELAY_CODEX_MODEL = 'env-model';
  t.after(() => { delete process.env.RELAY_CODEX_MODEL; });
  const warnings = [];
  rejected.add('env-model');
  await run(api, 'codex', { model: 'another-role-model' });
  const fallback = await run(api, 'codex', { beforeModelRetry: model => warnings.push(model) });
  assert.equal(fallback[api.USAGE].model, 'alternate');
  assert.deepEqual(warnings, ['env-model']);
  assert.deepEqual(attempted.splice(0), ['another-role-model', 'env-model', 'alternate']);

  rejected.add('alternate');
  const afterRejection = await run(api, 'codex', { model: 'alternate', beforeModelRetry: model => warnings.push(model) });
  assert.equal(afterRejection[api.USAGE].model, 'preferred');
  assert.deepEqual(attempted, ['alternate', 'preferred']);
  assert.deepEqual(warnings, ['env-model', 'alternate']);
  assert.ok(args.every(flags => flags.length === 1 && flags[0] === 'app-server'));
});

test('Gemini API uses the override and falls back to the legacy API environment model', async t => {
  process.env.RELAY_GEMINI_MODE = 'api';
  process.env.GEMINI_API_KEY = 'test-key';
  process.env.RELAY_GEMINI_MODEL = 'test-gemini-env';
  t.after(() => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.RELAY_GEMINI_MODEL;
    process.env.RELAY_GEMINI_MODE = 'agy';
  });
  const fromEnv = await import('../server/providers.js?mode=api-model-env');
  const models = [];
  const warnings = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async url => {
    const model = new URL(url).pathname.split('/').at(-1).replace(':generateContent', '');
    models.push(model);
    const ok = model !== 'rejected';
    return { ok, status: ok ? 200 : 404, headers: new Headers(),
      json: async () => ok ? { modelVersion: model + '-actual', candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] }
        : { error: { status: 'NOT_FOUND', message: 'Unknown model' } } };
  };
  await run(fromEnv, 'gemini', { model: 'role-model' });
  const result = await run(fromEnv, 'gemini', { model: 'rejected', beforeModelRetry: model => warnings.push(model) });
  await run(fromEnv, 'gemini', { model: '' });
  assert.deepEqual(models, ['role-model', 'rejected', 'test-gemini-env', 'test-gemini-env']);
  assert.deepEqual(warnings, ['rejected']);
  assert.equal(result[fromEnv.USAGE].model, 'test-gemini-env-actual');
});

test('standalone Gemini CLI adds a model argument only when configured for the call', async () => {
  const standalone = await import('../server/providers.js?mode=standalone');
  await standalone.refreshGemini();
  const cliCalls = withStdin(() => JSON.stringify({ response: JSON.stringify(answer) }));
  standalone.processes.spawn = (binary, args) => {
    if (args[0] !== '--version') return cliCalls.spawn(binary, args);
    const child = fakeProcess();
    child.stdin.on('data', () => {});
    child.stdin.on('end', () => child.reply('test-version', binary === process.env.RELAY_GEMINI_BIN ? 0 : 1));
    return child;
  };
  await standalone.refreshGemini();
  const legacyArgs = ['-p',
    'Complete the Relay request below using only the supplied CONTEXT. Do not call tools, read or modify files, or run shell commands. ' +
    'Return ONLY a single valid JSON object conforming to this exact JSON Schema (no markdown code fences, no explanation): ' +
    JSON.stringify(reviewSchema), '--output-format', 'json'];
  for (const options of [undefined, { model: 'gemini-role' }, { model: '' }]) {
    await run(standalone, 'gemini', options);
  }
  assert.deepEqual(cliCalls.calls.map(call => call.args), [legacyArgs, [...legacyArgs, '--model', 'gemini-role'], legacyArgs]);
});
