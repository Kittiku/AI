import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Two copies of the module: one where Gemini uses the API, one where it uses Antigravity CLI (agy).
// Settings are read when the module loads, so the environment is set before each import.
for (const name of ['GOOGLE_API_KEY', 'RELAY_GEMINI_CLI_MODEL', 'RELAY_GEMINI_MODEL']) delete process.env[name];
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
  child.reply = text => {
    child.stdout.once('end', () => { if (!child.closed) { child.closed = true; child.emit('close', 0); } });
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

test('Codex gets prompt + CONTEXT + context, byte for byte', async () => {
  const sent = [];
  api.processes.spawn = () => {
    const child = fakeProcess();
    const send = message => child.stdout.write(JSON.stringify(message) + '\n');
    createInterface({ input: child.stdin }).on('line', line => {
      const message = JSON.parse(line);
      if (message.method === 'initialize') send({ id: message.id, result: {} });
      else if (message.method === 'model/list') send({ id: message.id, result: { data: [{ model: 'test-model', isDefault: true }] } });
      else if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread-1' } } });
      else if (message.method === 'turn/start') {
        sent.push(message.params.input[0].text);
        send({ id: message.id, result: {} });
        send({ method: 'item/completed', params: { threadId: 'thread-1', item: { type: 'agentMessage', text: JSON.stringify(answer) } } });
        send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { status: 'completed' } } });
      }
    });
    return child;
  };
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
