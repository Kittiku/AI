import spawn from 'cross-spawn';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

export const names = { claudecode: 'Claude Code', gemini: 'Gemini', codex: 'Codex' };
// Every AI process is started through this object, so tests can replace `spawn` with a stand-in process.
export const processes = { spawn };
const desktopCodexBin = process.platform === 'win32' && process.env.PATH?.split(path.delimiter)
  .filter(folder => /[\\/]WindowsApps[\\/]OpenAI\.Codex_[^\\/]+[\\/]app[\\/]resources[\\/]?$/i.test(folder))
  .map(folder => path.join(folder, 'codex.exe'))
  .find(file => existsSync(file));
const codexBinary = process.env.RELAY_CODEX_BIN || [
  desktopCodexBin,
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin', 'codex.exe')
].find(file => file && existsSync(file)) || 'codex';
const claudeCodeBinary = process.env.RELAY_CLAUDE_CODE_BIN || [
  process.env.USERPROFILE && path.join(process.env.USERPROFILE, '.local', 'bin', 'claude.exe'),
  process.env.HOME && path.join(process.env.HOME, '.local', 'bin', 'claude')
].find(file => file && existsSync(file)) || 'claude';
const agyBinary = process.env.RELAY_AGY_BIN || [
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe'),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'agy', 'agy.exe'),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'agy', 'agy.exe'),
  process.env.USERPROFILE && path.join(process.env.USERPROFILE, '.local', 'bin', 'agy.exe'),
  process.env.HOME && path.join(process.env.HOME, '.local', 'bin', 'agy')
].find(file => file && existsSync(file)) || 'agy';
const geminiBinary = process.env.RELAY_GEMINI_BIN || [
  process.env.APPDATA && path.join(process.env.APPDATA, 'npm', process.platform === 'win32' ? 'gemini.cmd' : 'gemini'),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'gemini-cli', 'gemini.exe'),
  process.env.USERPROFILE && path.join(process.env.USERPROFILE, '.local', 'bin', 'gemini.exe'),
  process.env.HOME && path.join(process.env.HOME, '.local', 'bin', 'gemini')
].find(file => file && existsSync(file)) || 'gemini';

const geminiMode = (process.env.RELAY_GEMINI_MODE || 'auto').toLowerCase();
const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const defaultGeminiApiModel = 'gemini-3.8-flash';
const geminiApiModel = process.env.RELAY_GEMINI_MODEL || defaultGeminiApiModel;
const geminiCliModel = process.env.RELAY_GEMINI_CLI_MODEL ||
  (process.env.RELAY_GEMINI_MODEL && !/flash-lite/i.test(process.env.RELAY_GEMINI_MODEL) ? process.env.RELAY_GEMINI_MODEL : '');
const geminiDefaultDailyLimit = Number(process.env.RELAY_GEMINI_DAILY_LIMIT) || 1500;

const codexEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:GEMINI_API_KEY|GOOGLE_API_KEY|ANTHROPIC_API_KEY|CODEX_THREAD_ID)$/i.test(key)));
// Claude Code uses the claude.ai login on this machine, so API keys and nested-session markers are removed.
const claudeCodeEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(?:GEMINI_API_KEY|GOOGLE_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CODEX_THREAD_ID|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT)$/i.test(key)));
// Antigravity CLI (agy) uses the personal Google AI Pro OAuth login when API keys are removed.
const agyCliEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(?:GEMINI_API_KEY|GOOGLE_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CODEX_THREAD_ID|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT)$/i.test(key)));
const claudeCodeTools = 'Read,Glob,Grep';

// Token and cost details ride on each result under a symbol, so schema validation (Object.keys) ignores them.
export const USAGE = Symbol('usage');
let claudeCodeBilling = 'subscription';

const makeObject = fields => ({ type: 'object', properties: fields, required: Object.keys(fields), additionalProperties: false });
const string = { type: 'string' };
const paths = { type: 'array', items: string };
// Subtasks: the lead of a role splits its work into ordered pieces; each piece gets a goal, files and its own acceptance.
const makeSubtask = requireDependencies => {
  const schema = makeObject({ title: string, goal: string, files: paths, acceptance: string });
  schema.properties.dependsOn = { type: 'array', items: { type: 'integer', minimum: 1 } };
  if (requireDependencies) schema.required.push('dependsOn');
  return schema;
};
const makePlanSchema = requireDependencies => {
  const subtasks = { type: 'array', items: makeSubtask(requireDependencies) };
  return makeObject({ backend: string, frontend: string, contract: string, acceptance: string, backendFiles: paths, frontendFiles: paths,
    complexity: { type: 'string', enum: ['simple', 'medium', 'hard'] }, backendTasks: subtasks, frontendTasks: subtasks });
};
export const planSchema = makePlanSchema(false);
// Codex's strict output schema needs every property in required. Use [] for an independent subtask.
const codexPlanSchema = makePlanSchema(true);
// The lead's check of one subtask before the next one starts.
export const subtaskCheckSchema = makeObject({ verdict: { type: 'string', enum: ['pass', 'fix'] }, summary: string, problems: { type: 'array', items: string } });
export const editSchema = makeObject({
  summary: string,
  status: { type: 'string', enum: ['done', 'no_work', 'blocked'] },
  files: { type: 'array', items: makeObject({ path: string, content: string }) },
  edits: { type: 'array', items: makeObject({ path: string, find: string, replace: string }) }
});
export const reviewSchema = makeObject({
  summary: string,
  findings: { type: 'array', items: makeObject({ owner: { type: 'string', enum: ['backend', 'frontend'] }, detail: string }) }
});

export function validate(result, schema) {
  if (schema.type === 'string') return typeof result === 'string' && (!schema.enum || schema.enum.includes(result));
  if (schema.type === 'array') return Array.isArray(result) && result.every(item => validate(item, schema.items));
  if (schema.type === 'integer') return Number.isInteger(result) && (schema.minimum === undefined || result >= schema.minimum);
  return Boolean(result && typeof result === 'object' && !Array.isArray(result) &&
    schema.required.every(key => Object.hasOwn(result, key)) &&
    Object.entries(result).every(([key, value]) => Object.hasOwn(schema.properties, key) && validate(value, schema.properties[key])));
}

function codexRpc(cwd, signal) {
  const processHandle = processes.spawn(codexBinary, ['app-server'], { cwd, env: codexEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: processHandle.stdout });
  const requests = new Map();
  let listener = () => {};
  let fail = () => {};
  let nextId = 0;
  let terminalError;
  let diagnostics = '';
  const close = () => { lines.close(); processHandle.kill(); };
  const abort = () => { stop(signal.reason); close(); };
  function stop(error) {
    if (terminalError) return;
    terminalError = error;
    for (const { reject } of requests.values()) reject(error);
    requests.clear();
    fail(error);
  }
  processHandle.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-1000); });
  processHandle.on('error', stop);
  processHandle.stdin.on('error', stop);
  processHandle.on('close', code => stop(Error(`Codex App Server ปิดการเชื่อมต่อ (${code}) ${diagnostics.trim()}`)));
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method && typeof message.id !== 'undefined') {
      processHandle.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Interactive requests are unavailable in Relay.' } }) + '\n');
      return;
    }
    const pending = requests.get(message.id);
    if (pending) {
      requests.delete(message.id);
      if (message.error) pending.reject(Error(message.error.message || 'Codex RPC error'));
      else pending.resolve(message.result);
    } else if (message.method) listener(message);
  });
  return {
    request(method, params) {
      if (terminalError) return Promise.reject(terminalError);
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        requests.set(id, { resolve, reject });
        processHandle.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      });
    },
    notify(method) { processHandle.stdin.write(JSON.stringify({ method }) + '\n'); },
    events(onMessage, onError) { listener = onMessage; fail = onError; },
    close() { signal.removeEventListener('abort', abort); close(); }
  };
}

async function withCodex(cwd, signal, task) {
  const rpc = codexRpc(cwd, signal);
  try {
    await rpc.request('initialize', { clientInfo: { name: 'relay', title: 'Relay', version: '0.1.0' } });
    rpc.notify('initialized');
    return await task(rpc);
  } finally { rpc.close(); }
}

const codexModelId = model => model?.model ?? model?.id;
const requestCodexModels = (rpc, cursor) => rpc.request('model/list', {
  includeHidden: false, limit: 50, ...(cursor ? { cursor } : {})
});

let modelListInFlight;
function listCodexModels(cwd) {
  modelListInFlight ??= withCodex(cwd, AbortSignal.timeout(12_000), async rpc => {
    const { account } = await rpc.request('account/read', { refreshToken: false });
    if (!account) return [];

    const models = new Set();
    const seenCursors = new Set();
    let cursor;
    do {
      const { data, nextCursor } = await requestCodexModels(rpc, cursor);
      if (!Array.isArray(data)) throw Error('Codex returned an invalid model list');
      for (const entry of data) {
        const id = codexModelId(entry);
        if (!entry?.hidden && typeof id === 'string' && id.trim()) models.add(id);
      }
      cursor = nextCursor;
      if (cursor && seenCursors.has(cursor)) throw Error('Codex returned a repeated model list cursor');
      seenCursors.add(cursor);
    } while (cursor);
    return [...models];
  }).catch(() => []).finally(() => { modelListInFlight = null; });
  return modelListInFlight;
}

export async function listModels(cwd) {
  return {
    claudecode: ['opus', 'sonnet', 'haiku'],
    codex: await listCodexModels(cwd),
    gemini: [defaultGeminiApiModel, 'gemini-3.1-pro-preview', 'gemini-3.5-flash-lite']
  };
}

const modelRejectionPatterns = [
  /\b(?:model_not_found|unsupported_model|invalid_model|modelNotFoundError|unsupportedModelError)\b/i,
  /\b(?:unknown model|invalid model|unsupported model|no such model|issue with the selected model)\b/i,
  /(?:no|not have|denied) access to (?:the |this |that )?model\b/i,
  /\bmodels?\b[^\r\n]*(?:not[ -](?:found|supported|available|accessible|allowed|recognized|exist|enabled)|no longer supported|unavailable)/i,
  /\bmodel\b[^\r\n]*(?:doesn't exist|may not exist|cannot be used|you may not have access|access denied)/i
];
const rejectsModel = message => modelRejectionPatterns.some(pattern => pattern.test(message));

const isModelUnavailable = error => error.code === 'RELAY_MODEL_UNAVAILABLE' || rejectsModel(error.message);

function addModelArgument(args, model, configured) {
  if (!model) return;
  if (configured && (/^-/.test(model) || model.includes('\0'))) {
    throw Object.assign(Error('Model ID cannot be passed to the CLI'), { code: 'RELAY_MODEL_UNAVAILABLE' });
  }
  args.push('--model', model);
}

// With no override, the legacy environment and default path run exactly as before.
async function runWithModel(model, legacyModel, defaultModel, run, signal, beforeModelRetry) {
  if (!model) return run(legacyModel);
  const candidates = [...new Set([model, legacyModel, defaultModel])];
  for (const [index, candidate] of candidates.entries()) {
    signal.throwIfAborted();
    try {
      return await run(candidate, true);
    } catch (error) {
      signal.throwIfAborted();
      if (!candidate || !isModelUnavailable(error)) throw error;
      const canRetry = index < candidates.length - 1;
      if (canRetry || index === 0) await beforeModelRetry?.(candidate, canRetry);
      if (!canRetry) throw error;
    }
  }
}

let lastCodexModel;
async function codexTurn(cwd, prompt, schema, signal, write, model, beforeModelRetry) {
  return withCodex(cwd, signal, async rpc => {
    if (model) {
      signal.throwIfAborted();
      try {
        return await runCodexModel(rpc, cwd, model, prompt, schema, write);
      } catch (error) {
        signal.throwIfAborted();
        if (!isModelUnavailable(error)) throw error;
        await beforeModelRetry?.(model, true);
      }
    }
    signal.throwIfAborted();
    const { data: models } = await requestCodexModels(rpc);
    const modelIds = models.map(codexModelId);
    const recommended = models.find(model => model.isDefault);
    const candidates = new Set([
      modelIds.includes(lastCodexModel) && lastCodexModel, codexModelId(recommended), ...modelIds
    ].filter(Boolean));
    candidates.delete(model);
    for (const candidate of candidates) {
      signal.throwIfAborted();
      try {
        const result = await runCodexModel(rpc, cwd, candidate, prompt, schema, write);
        lastCodexModel = candidate;
        return result;
      } catch (error) {
        if (!/model_not_found|model.+not supported when using Codex with a ChatGPT account/i.test(error.message)) throw error;
        signal.throwIfAborted();
        candidates.delete(candidate);
        if (model && candidates.size) await beforeModelRetry?.();
      }
    }
    throw Error('Codex ไม่พบโมเดลที่บัญชีนี้อนุญาตให้ใช้ ตรวจว่า Codex CLI เป็นเวอร์ชันล่าสุดแล้วลองอีกครั้ง');
  });
}

// write: Codex may change files inside cwd (its workspace-write sandbox); otherwise it can only read.
async function runCodexModel(rpc, cwd, model, prompt, schema, write = false) {
  const { thread, model: threadModel } = await rpc.request('thread/start', {
    cwd, model, sandbox: write ? 'workspace-write' : 'read-only', approvalPolicy: 'never', ephemeral: true
  });
  let output = '';
  const completion = new Promise((resolve, reject) => {
    rpc.events(({ method, params }) => {
      if (params?.threadId !== thread.id) return;
      if (method === 'item/completed' && params.item?.type === 'agentMessage') output = params.item.text;
      if (method === 'turn/completed') {
        if (params.turn.status === 'completed') resolve(output);
        else reject(Error(params.turn.error?.message || 'Codex turn: ' + params.turn.status));
      }
    }, reject);
  });
  completion.catch(() => {});
  await rpc.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: prompt }], outputSchema: schema });
  return { output: await completion, model: threadModel || model };
}

function runClaudeCode(args, { cwd, input = '', signal }) {
  return new Promise((resolve, reject) => {
    const child = processes.spawn(claudeCodeBinary, args, { cwd, env: claudeCodeEnv, signal, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    child.on('error', error => reject(error.code === 'ENOENT' ? Error('ไม่พบคำสั่ง claude ติดตั้ง Claude Code หรือตั้งค่า RELAY_CLAUDE_CODE_BIN') : error));
    child.stdin.on('error', () => {});
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

// write: Claude Code may also use Edit and Write on files in cwd; it still has no shell.
async function claudeCodeTurn(cwd, prompt, schema, signal, write, model, configured) {
  const tools = write ? claudeCodeTools + ',Edit,Write' : claudeCodeTools;
  const args = ['-p', write ? 'Complete the Relay request provided on stdin. Edit files only inside the current directory.' :
    'Complete the Relay request provided on stdin. Use the files in the current directory only as read-only reference.',
    '--output-format', 'json', '--json-schema', JSON.stringify(schema),
    '--tools', tools, '--allowedTools', tools, ...(write ? ['--permission-mode', 'acceptEdits'] : []),
    '--max-turns', String(Number(process.env.RELAY_CLAUDE_CODE_MAX_TURNS) || 40), '--no-session-persistence'];
  addModelArgument(args, model, configured);
  const { code, stdout, stderr } = await runClaudeCode(args, { cwd, input: prompt, signal });
  let data;
  try { data = JSON.parse(stdout.trim().split('\n').at(-1)); } catch {
    const error = Error(`Claude Code ไม่ได้ส่งผล JSON (exit ${code}) ${(stderr || stdout).trim().slice(0, 600)}`);
    if (configured && model && rejectsModel(stderr || stdout)) error.code = 'RELAY_MODEL_UNAVAILABLE';
    throw error;
  }
  if (data.structured_output && !data.is_error) {
    const tokens = data.usage || {};
    data.structured_output[USAGE] = {
      inputTokens: (tokens.input_tokens || 0) + (tokens.cache_read_input_tokens || 0) + (tokens.cache_creation_input_tokens || 0),
      outputTokens: tokens.output_tokens || 0,
      costUsd: Number.isFinite(data.total_cost_usd) ? data.total_cost_usd : null,
      billing: claudeCodeBilling,
      model: mainModel(data.modelUsage) || model || null
    };
    return data.structured_output;
  }
  const message = String(data.result || data.subtype || stderr || 'ไม่มีผลลัพธ์ตาม schema').trim();
  const error = Error('Claude Code: ' + message.slice(0, 700));
  if (configured && model && (rejectsModel(message) || rejectsModel(stderr))) error.code = 'RELAY_MODEL_UNAVAILABLE';
  if (/usage limit|rate limit|limit reached|overloaded|429/i.test(message)) error.cooldown = 15 * 60_000;
  throw error;
}

function runCliBinary(binary, args, { cwd, env, input = '', signal, notFoundMessage, stopOnResult = false }) {
  return new Promise((resolve, reject) => {
    const child = processes.spawn(binary, args, { cwd, env, signal, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    child.on('error', error => reject(error.code === 'ENOENT' ? Error(notFoundMessage) : error));
    child.stdin.on('error', () => {});
    child.on('close', code => resolve({ code, stdout, stderr }));
    if (stopOnResult) {
      const lines = createInterface({ input: child.stdout });
      lines.on('line', line => {
        let event;
        try { event = JSON.parse(line); } catch { return; }
        if (event.event !== 'result') return;
        resolve({ code: 0, stdout: line, stderr });
        lines.close();
        child.kill();
      });
    }
    child.stdin.end(input);
  });
}

function extractJsonObject(raw) {
  const text = String(raw || '').trim();
  if (!text) throw Error('ไม่มีข้อมูลตอบกลับ');
  try { return JSON.parse(text); } catch {}
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(text.slice(first, last + 1)); } catch {}
    for (let i = text.lastIndexOf('{', last); i >= first; i = text.lastIndexOf('{', i - 1)) {
      try { return JSON.parse(text.slice(i, last + 1)); } catch {}
      if (i === 0) break;
    }
  }
  throw Error('ไม่ได้ส่งผลเป็น JSON ที่ถูกต้อง');
}

// The model that did most of the work, from a usage map keyed by model id (Claude Code's modelUsage, Gemini CLI's stats.models).
export function mainModel(usageByModel) {
  if (!usageByModel || typeof usageByModel !== 'object') return null;
  const size = value => {
    const tokens = value?.tokens || value || {};
    return Number(tokens.outputTokens ?? tokens.output_tokens ?? tokens.candidates ?? tokens.total ?? tokens.costUSD ?? 0) || 0;
  };
  const entries = Object.entries(usageByModel);
  if (!entries.length) return null;
  return entries.sort((a, b) => size(b[1]) - size(a[1]))[0][0];
}

// Token totals from Gemini CLI's stats.models, when present.
function geminiCliTokens(models) {
  if (!models || typeof models !== 'object') return null;
  let input = 0, output = 0, seen = false;
  for (const value of Object.values(models)) {
    const tokens = value?.tokens;
    if (!tokens) continue;
    seen = true;
    input += Number(tokens.prompt ?? tokens.input ?? 0) || 0;
    output += Number(tokens.candidates ?? tokens.output ?? 0) || 0;
  }
  return seen ? { inputTokens: input, outputTokens: output } : null;
}

function parseCliJsonOutput(stdout, meta = {}) {
  const outer = extractJsonObject(stdout);
  if (outer && typeof outer === 'object') {
    const models = outer.stats?.models;
    if (models) { meta.model = mainModel(models); Object.assign(meta, geminiCliTokens(models)); }
    if (typeof outer.model === 'string') meta.model ??= outer.model;
    if (outer.error) {
      const errMsg = typeof outer.error === 'string' ? outer.error : (outer.error.message || JSON.stringify(outer.error));
      throw Error(errMsg);
    }
    if (outer.structured_output && typeof outer.structured_output === 'object') return outer.structured_output;
    if (typeof outer.response === 'string') return extractJsonObject(outer.response);
    if (typeof outer.result === 'string') return extractJsonObject(outer.result);
  }
  return outer;
}

function parseAgyOutput(stdout, meta = {}) {
  for (const line of stdout.trimEnd().split('\n').reverse()) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.event !== 'result') continue;
    if (event.result?.status !== 'SUCCESS') throw Error(event.result?.error || 'Antigravity CLI ไม่ได้ทำงานจนเสร็จ');
    return parseCliJsonOutput(JSON.stringify(event.result), meta);
  }
  throw Error('Antigravity CLI ไม่ส่งผลลัพธ์กลับ');
}

let geminiCli = { ready: false, backend: null, updatedAt: null, note: 'กำลังตรวจการเชื่อมต่อ Gemini / Antigravity CLI' };
let geminiCliInFlight;

// Keep the entire encoded CLI request below the size that has caused silent truncation.
// `encode` turns a context string into the exact stdin text; its UTF-8 size is what is measured.
// Integrated reviews can shorten the diff while retaining their plan and checks.
// Required files the snapshot could not include (too large or past its budget) are not an error: they are listed
// first in omittedPaths. Only when the required files that are present, with nothing optional, still exceed the
// limit does this throw RELAY_CONTEXT_TOO_LARGE so the caller can move on to the next AI.
export function fitGeminiCliInput(context, encode, limit = 88_000, trimReviewDiff = false) {
  const fits = text => Buffer.byteLength(text, 'utf8') <= limit;
  const oversized = () => Object.assign(
    Error('บริบทเกินขนาดที่ส่งให้ Gemini CLI ได้ (' + limit + ' ไบต์) ระบบจะลอง AI ตัวถัดไปที่พร้อมใช้'),
    { code: 'RELAY_CONTEXT_TOO_LARGE' }
  );
  const input = encode(context);
  if (fits(input)) return input;
  let data = null;
  try { data = context ? JSON.parse(context) : null; } catch {}
  if (trimReviewDiff && typeof data?.diff === 'string' && data.diff.length) {
    const packDiff = count => encode(JSON.stringify({
      ...data, diff: data.diff.slice(0, count).replace(/[\uD800-\uDBFF]$/, ''), truncated: true
    }));
    if (!fits(packDiff(0))) throw oversized();
    return largest(0, data.diff.length - 1, packDiff);
  }
  const repo = data?.repo;
  if (!repo || !Array.isArray(repo.files)) throw oversized();

  const key = name => String(name).replaceAll('\\', '/').toLowerCase();
  const requiredPaths = Array.isArray(repo.requiredPaths) ? repo.requiredPaths : [];
  const needed = new Set(requiredPaths.map(key));
  const present = new Set(repo.files.map(file => key(file.path)));
  const required = repo.files.filter(file => needed.has(key(file.path)));
  const optional = repo.files.filter(file => !needed.has(key(file.path)));
  const missingRequired = [...new Set(requiredPaths.filter(name => !present.has(key(name))))];
  const earlierOmitted = Array.isArray(repo.omittedPaths) ? repo.omittedPaths : [];
  const omittedBase = Number.isFinite(repo.omitted) ? repo.omitted : 0;

  // count: optional files kept (in snapshot order). listed: entries kept in omittedPaths (missing required files first).
  function pack(count, listed) {
    const omittedPaths = [...new Set([...missingRequired, ...optional.slice(count).map(file => file.path), ...earlierOmitted])]
      .slice(0, Math.max(listed, 0));
    return encode(JSON.stringify({ ...data, repo: {
      ...repo, files: [...required, ...optional.slice(0, count)], omitted: omittedBase + optional.length - count, omittedPaths
    } }));
  }
  // Largest n in [low, high] for which make(n) fits; make(low) must already fit.
  function largest(low, high, make) {
    let best = make(low);
    while (low < high) {
      const middle = Math.floor((low + high + 1) / 2);
      const candidate = make(middle);
      if (fits(candidate)) { low = middle; best = candidate; } else high = middle - 1;
    }
    return best;
  }

  const fullList = 100;
  if (fits(pack(0, fullList))) return largest(0, optional.length, count => pack(count, fullList));
  // No optional file fits: shorten omittedPaths, but keep the required files that are missing listed.
  const minimum = Math.min(missingRequired.length, fullList);
  if (!fits(pack(0, minimum))) throw oversized();
  return largest(minimum, fullList, listed => pack(0, listed));
}

const withContext = (prompt, context) => context ? prompt + '\nCONTEXT\n' + context : prompt;

const geminiCliInstruction = schema => [
  'Complete the Relay request below using only the supplied CONTEXT. Do not call tools, read or modify files, or run shell commands.',
  'Return ONLY a single valid JSON object conforming to this exact JSON Schema (no markdown code fences, no explanation):',
  JSON.stringify(schema)
].join(' ');

// The exact stdin text for the Gemini / Antigravity CLI: plain prompt text, or one stream-json user event for agy.
export function geminiCliEncoder(prompt, schema, stream) {
  const instruction = geminiCliInstruction(schema);
  return packed => stream
    ? JSON.stringify({ event: 'user', message: { content: instruction + '\n\n' + withContext(prompt, packed) } }) + '\n'
    : withContext(prompt, packed);
}

async function geminiCliTurn(cwd, prompt, context, schema, signal, onUsage, model, configured, trimReviewDiff) {
  const backend = geminiCli.backend || 'agy';
  const binary = backend === 'agy' ? agyBinary : geminiBinary;
  const label = backend === 'agy' ? 'Antigravity CLI (agy)' : 'Gemini CLI';
  const useStream = backend === 'agy';
  const args = useStream
    ? ['--input-format', 'stream-json', '--output-format', 'stream-json', '--json-schema', JSON.stringify(schema), '--disable-slash-commands']
    : ['-p', geminiCliInstruction(schema), '--output-format', 'json'];
  const encode = geminiCliEncoder(prompt, schema, useStream);
  const input = fitGeminiCliInput(context, encode, undefined, trimReviewDiff);
  addModelArgument(args, model, configured);
  const { code, stdout, stderr } = await runCliBinary(binary, args, {
    cwd,
    env: backend === 'agy' ? agyCliEnv : process.env,
    input,
    signal,
    stopOnResult: useStream,
    notFoundMessage: `ไม่พบคำสั่ง ${backend} ติดตั้ง Antigravity CLI (irm https://antigravity.google/cli/install.ps1 | iex) หรือตั้งค่า GEMINI_API_KEY`
  });
  if (code === 0 && !configured) onUsage?.();
  try {
    if (code !== 0) throw Error(stderr.trim() || `exit ${code}`);
    const meta = {};
    const result = useStream ? parseAgyOutput(stdout, meta) : parseCliJsonOutput(stdout, meta);
    if (configured) onUsage?.();
    if (result && typeof result === 'object') {
      result[USAGE] = { inputTokens: meta.inputTokens ?? null, outputTokens: meta.outputTokens ?? null, costUsd: null, billing: 'subscription',
        model: meta.model || model || (backend === 'agy' ? 'agy (ค่าเริ่มต้น)' : 'gemini-cli (ค่าเริ่มต้น)') };
    }
    return { result, diffTruncated: trimReviewDiff && input !== encode(context) };
  } catch (parseError) {
    const detail = String(stderr || stdout || parseError.message || `exit ${code}`).trim();
    const error = Error(`${label} (exit ${code}): ${detail.slice(0, 700)}`);
    if (configured && model && [detail, parseError.message, stdout].some(text => rejectsModel(text))) {
      error.code = 'RELAY_MODEL_UNAVAILABLE';
      throw error;
    }
    if (code === 0 && configured) onUsage?.();
    if (/auth|login|credential|unauthenticated|sign in|no longer supported/i.test(detail)) {
      geminiCli = {
        ready: false,
        backend,
        updatedAt: Date.now(),
        note: 'ต้องลงชื่อเข้าใช้ด้วยคำสั่ง agy ใน PowerShell (หรือตั้งค่า GEMINI_API_KEY ใน .env)'
      };
    }
    if (/usage limit|rate limit|quota|resource_exhausted|overloaded|429/i.test(detail)) error.cooldown = 15 * 60_000;
    throw error;
  }
}

export function refreshGemini(cwd = process.cwd()) {
  if (geminiMode === 'api') {
    geminiCli = { ready: Boolean(geminiKey), backend: 'api', updatedAt: Date.now(), note: geminiKey ? '' : 'ต้องตั้งค่า GEMINI_API_KEY' };
    return Promise.resolve();
  }
  geminiCliInFlight ??= (async () => {
    // 1. Check Antigravity CLI (agy) — Google's official CLI for Google AI Pro OAuth since June 2026
    const agyCheck = await runCliBinary(agyBinary, ['--version'], {
      cwd,
      env: agyCliEnv,
      signal: AbortSignal.timeout(8_000),
      notFoundMessage: 'ไม่พบ agy'
    }).catch(() => ({ code: -1 }));
    if (agyCheck.code === 0) {
      geminiCli = { ready: true, backend: 'agy', updatedAt: Date.now(), note: '' };
      return;
    }
    // 2. If GEMINI_API_KEY is set, use direct Gemini API (or Gemini CLI with API key)
    if (geminiKey) {
      geminiCli = { ready: true, backend: 'api', updatedAt: Date.now(), note: '' };
      return;
    }
    // 3. Fallback: check standalone gemini CLI
    const gemCheck = await runCliBinary(geminiBinary, ['--version'], {
      cwd,
      env: process.env,
      signal: AbortSignal.timeout(8_000),
      notFoundMessage: 'ไม่พบ gemini'
    }).catch(() => ({ code: -1 }));
    if (gemCheck.code === 0) {
      geminiCli = {
        ready: false,
        backend: 'gemini',
        updatedAt: Date.now(),
        note: 'Gemini CLI ยกเลิกล็อกอินบัญชี AI Pro แล้ว ให้ติดตั้ง Antigravity CLI (agy) หรือใส่ GEMINI_API_KEY ใน .env'
      };
      return;
    }
    geminiCli = {
      ready: false,
      backend: null,
      updatedAt: Date.now(),
      note: 'ติดตั้ง Antigravity CLI (irm https://antigravity.google/cli/install.ps1 | iex) หรือใส่ GEMINI_API_KEY ใน .env'
    };
  })().finally(() => { geminiCliInFlight = null; });
  return geminiCliInFlight;
}

let claudeCode = { ready: false, windows: [], updatedAt: null, note: 'กำลังตรวจการเชื่อมต่อ' };
let claudeCodeInFlight;
const claudeCodeLimitLabels = { session: '5 ชม.', weekly_all: '7 วัน' };

// "/usage" is a local Claude Code command: it reads plan limits without calling the model.
async function readClaudeCodeLimits(cwd) {
  const { stdout } = await runClaudeCode(['-p', '/usage', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'],
    { cwd, signal: AbortSignal.timeout(20_000) });
  for (const line of stdout.split('\n')) {
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    const limits = message.usage_report?.rate_limits?.limits;
    if (Array.isArray(limits)) return limits.filter(limit => claudeCodeLimitLabels[limit.kind] && Number.isFinite(limit.percent)).map(limit => ({
      label: claudeCodeLimitLabels[limit.kind],
      remaining: Math.max(0, Math.min(100, 100 - limit.percent)),
      resetAt: Date.parse(limit.resets_at) || null
    }));
  }
  return null;
}

export function refreshClaudeCode(cwd) {
  void refreshGemini(cwd);
  claudeCodeInFlight ??= (async () => {
    const { code, stdout } = await runClaudeCode(['auth', 'status'], { cwd, signal: AbortSignal.timeout(15_000) });
    let status = {};
    try { status = JSON.parse(stdout); } catch {}
    const method = status.authMethod;
    if (code !== 0 || method === 'none') throw Error('ต้องลงชื่อเข้าใช้ Claude Code ด้วย claude auth login');
    claudeCodeBilling = method === 'claude.ai' ? 'subscription' : 'api';
    if (method && method !== 'claude.ai') {
      claudeCode = { ready: true, windows: [], updatedAt: Date.now(), note: 'ลงชื่อเข้าใช้แบบ ' + method + ' (อาจคิดค่าบริการตาม API)' };
      return;
    }
    const windows = await readClaudeCodeLimits(cwd).catch(() => null);
    claudeCode = { ready: true, windows: windows || [], updatedAt: Date.now(),
      note: windows?.length ? '' : 'ยังอ่านโควตาจาก Claude Code ไม่ได้' };
  })().catch(error => { claudeCode = { ...claudeCode, ready: false, note: error.message }; })
    .finally(() => { claudeCodeInFlight = null; });
  return claudeCodeInFlight;
}

let codex = { ready: false, windows: [], updatedAt: null, note: 'กำลังตรวจการเชื่อมต่อ' };
let refreshInFlight;
export function refreshCodex(cwd) {
  refreshInFlight ??= withCodex(cwd, AbortSignal.timeout(12_000), async rpc => {
    const { account } = await rpc.request('account/read', { refreshToken: false });
    if (!account) throw Error('ต้องลงชื่อเข้าใช้ Codex');
    const data = await rpc.request('account/rateLimits/read').catch(() => null);
    const buckets = data?.rateLimitsByLimitId;
    const limit = buckets?.codex || data?.rateLimits;
    codex = { ready: true, windows: [limit?.primary, limit?.secondary].filter(x => Number.isFinite(x?.usedPercent)).map(x => ({
      label: x.windowDurationMins ? `${x.windowDurationMins / 60} ชม.` : 'รอบปัจจุบัน',
      remaining: Math.max(0, 100 - x.usedPercent), resetAt: x.resetsAt ? x.resetsAt * 1000 : null
    })), updatedAt: Date.now(), note: limit ? '' : 'ยังไม่มีข้อมูลโควตาจาก Codex' };
  }).catch(error => { codex = { ...codex, note: error.message }; }).finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

void refreshGemini();

const quotaDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
export const pacificDay = date => quotaDate.format(date);
function dailyReset(now) {
  const day = pacificDay(now);
  let low = now;
  let high = now + 26 * 3600_000;
  while (high - low > 1000) {
    const time = Math.floor((low + high) / 2);
    if (pacificDay(time) === day) low = time;
    else high = time;
  }
  return high;
}

function shouldUseCli() {
  if (geminiMode === 'api') return false;
  if (geminiMode === 'cli' || geminiMode === 'agy') return true;
  if (geminiCli.backend === 'agy' && geminiCli.ready) return true;
  if (geminiKey) return false;
  return geminiCli.ready;
}

export function quota(settings, usage, now = Date.now()) {
  const useCli = shouldUseCli();
  const daily = settings.geminiDailyLimit || ((useCli || geminiKey) ? geminiDefaultDailyLimit : 0);
  const used = usage[pacificDay(now)] || 0;
  const ready = useCli ? geminiCli.ready : Boolean(geminiKey);
  const mode = useCli
    ? (geminiCli.backend === 'agy' ? 'Antigravity CLI (Google AI Pro)' : 'Gemini CLI')
    : 'Gemini API';
  const note = useCli
    ? (geminiCli.ready
      ? (settings.geminiDailyLimit ? 'นับเฉพาะคำขอจาก Relay' : `โควตา AI Pro ${daily} คำขอ/วัน (นับเฉพาะ Relay)`)
      : geminiCli.note)
    : (geminiKey ? (settings.geminiDailyLimit ? 'นับเฉพาะคำขอจาก Relay' : `เพดานเริ่มต้น ${daily} คำขอ/วัน (นับเฉพาะ Relay)`) : geminiCli.note || 'ต้องตั้งค่า GEMINI_API_KEY');
  return {
    claudecode: { name: names.claudecode, mode: 'Claude Code CLI', source: 'provider', ...claudeCode },
    gemini: {
      name: names.gemini,
      ready,
      mode,
      source: 'estimate',
      updatedAt: now,
      windows: (ready && daily) ? [{ label: `${used} / ${daily} คำขอต่อวัน`, remaining: Math.max(0, (daily - used) / daily * 100), resetAt: dailyReset(now) }] : [],
      note
    },
    codex: { name: names.codex, mode: 'Codex App Server', source: 'provider', ...codex }
  };
}

async function geminiApiTurn(prompt, schema, signal, onUsage, model) {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', 'x-goog-api-key': geminiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', responseJsonSchema: schema, maxOutputTokens: 20000 }
    })
  });
  if (response.ok) onUsage?.();
  const data = await response.json();
  if (!response.ok) {
    const error = Error(`Gemini HTTP ${response.status}: ${data.error?.message || 'request failed'}`);
    if (response.status === 404) error.code = 'RELAY_MODEL_UNAVAILABLE';
    error.cooldown = response.status === 429 ? (Number(response.headers.get('retry-after')) || 60) * 1000 : 0;
    throw error;
  }
  return {
    output: data.candidates?.[0]?.content?.parts?.filter(x => !x.thought).map(x => x.text || '').join(''),
    usage: { inputTokens: data.usageMetadata?.promptTokenCount || 0,
      outputTokens: (data.usageMetadata?.candidatesTokenCount || 0) + (data.usageMetadata?.thoughtsTokenCount || 0), costUsd: null, billing: 'api',
      model: data.modelVersion || model }
  };
}

// geminiCliContext replaces context on the Gemini / Antigravity CLI path, for example a snapshot built for its size limit.
export async function generate(provider, cwd, prompt, schema, jobSignal, onUsage, {
  write = false, context, geminiCliContext, model, beforeModelRetry, onReviewDiffTruncated
} = {}) {
  if (provider === 'gemini' && !geminiCli.updatedAt) await refreshGemini(cwd);
  const useCli = provider === 'gemini' && shouldUseCli();
  // Agents that read the repo themselves (Claude Code, Codex, Gemini CLI) get 15 minutes; one-shot API calls get 4.
  const timeoutMs = (provider === 'claudecode' || provider === 'codex' || useCli) ? 900_000 : 240_000;
  const signal = AbortSignal.any([jobSignal, AbortSignal.timeout(timeoutMs)]);
  const fullPrompt = withContext(prompt, context);
  const tryModel = (legacyModel, defaultModel, run) => runWithModel(model, legacyModel, defaultModel, run, signal, beforeModelRetry);

  let result, diffTruncated;
  if (provider === 'claudecode') {
    result = await tryModel(process.env.RELAY_CLAUDE_CODE_MODEL || '', '', (selected, configured) =>
      claudeCodeTurn(cwd, fullPrompt, schema, signal, write, selected, configured));
  } else if (useCli) {
    ({ result, diffTruncated } = await tryModel(geminiCliModel, '', (selected, configured) =>
      geminiCliTurn(cwd, prompt, geminiCliContext ?? context, schema, signal, onUsage, selected, configured,
        Boolean(onReviewDiffTruncated))));
  } else {
    let output, usage;
    if (provider === 'codex') {
      const turn = await codexTurn(cwd, fullPrompt, schema === planSchema ? codexPlanSchema : schema, signal, write,
        model || process.env.RELAY_CODEX_MODEL, beforeModelRetry);
      output = turn.output;
      usage = { inputTokens: null, outputTokens: null, costUsd: null, billing: 'subscription', model: turn.model };
    } else {
      ({ output, usage } = await tryModel(geminiApiModel, defaultGeminiApiModel, selected =>
        geminiApiTurn(fullPrompt, schema, signal, onUsage, selected)));
    }
    try { result = JSON.parse(output); } catch { throw Error(names[provider] + ' ส่ง JSON ไม่สมบูรณ์'); }
    if (result && typeof result === 'object') result[USAGE] = usage;
  }
  if (!validate(result, schema)) throw Error(names[provider] + ' ส่งข้อมูลไม่ตรงกับรูปแบบที่กำหนด');
  if (diffTruncated) onReviewDiffTruncated();
  return result;
}
