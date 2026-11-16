import spawn from 'cross-spawn';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

export const names = { claudecode: 'Claude Code', gemini: 'Gemini', codex: 'Codex' };
const codexBinary = process.env.RELAY_CODEX_BIN || [
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin', 'codex.exe')
].find(file => file && existsSync(file)) || 'codex';
const claudeCodeBinary = process.env.RELAY_CLAUDE_CODE_BIN || [
  process.env.USERPROFILE && path.join(process.env.USERPROFILE, '.local', 'bin', 'claude.exe'),
  process.env.HOME && path.join(process.env.HOME, '.local', 'bin', 'claude')
].find(file => file && existsSync(file)) || 'claude';
const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const geminiModel = process.env.RELAY_GEMINI_MODEL || 'gemini-3.1-flash-lite';
const codexEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:GEMINI_API_KEY|GOOGLE_API_KEY|ANTHROPIC_API_KEY|CODEX_THREAD_ID)$/i.test(key)));
// Claude Code uses the claude.ai login on this machine, so API keys and nested-session markers are removed.
const claudeCodeEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(?:GEMINI_API_KEY|GOOGLE_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CODEX_THREAD_ID|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT)$/i.test(key)));
const claudeCodeTools = 'Read,Glob,Grep';

const makeObject = fields => ({ type: 'object', properties: fields, required: Object.keys(fields), additionalProperties: false });
const string = { type: 'string' };
export const planSchema = makeObject({ backend: string, frontend: string, contract: string, acceptance: string });
export const editSchema = makeObject({
  summary: string,
  files: { type: 'array', items: makeObject({ path: string, content: string }) }
});
export const reviewSchema = makeObject({
  summary: string,
  findings: { type: 'array', items: makeObject({ owner: { type: 'string', enum: ['backend', 'frontend'] }, detail: string }) }
});

export function validate(result, schema) {
  if (schema.type === 'string') return typeof result === 'string' && (!schema.enum || schema.enum.includes(result));
  if (schema.type === 'array') return Array.isArray(result) && result.every(item => validate(item, schema.items));
  return Boolean(result && typeof result === 'object' && !Array.isArray(result) &&
    Object.keys(result).length === schema.required.length &&
    schema.required.every(key => validate(result[key], schema.properties[key])));
}

function codexRpc(cwd, signal) {
  const processHandle = spawn(codexBinary, ['app-server'], { cwd, env: codexEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
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

async function codexTurn(cwd, prompt, schema, signal) {
  return withCodex(cwd, signal, async rpc => {
    const thread = (await rpc.request('thread/start', { cwd, sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true })).thread;
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
    return completion;
  });
}

function runClaudeCode(args, { cwd, input = '', signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(claudeCodeBinary, args, { cwd, env: claudeCodeEnv, signal, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
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

async function claudeCodeTurn(cwd, prompt, schema, signal) {
  const args = ['-p', 'Complete the Relay request provided on stdin. Use the files in the current directory only as read-only reference.',
    '--output-format', 'json', '--json-schema', JSON.stringify(schema),
    '--tools', claudeCodeTools, '--allowedTools', claudeCodeTools,
    '--max-turns', String(Number(process.env.RELAY_CLAUDE_CODE_MAX_TURNS) || 40), '--no-session-persistence'];
  if (process.env.RELAY_CLAUDE_CODE_MODEL) args.push('--model', process.env.RELAY_CLAUDE_CODE_MODEL);
  const { code, stdout, stderr } = await runClaudeCode(args, { cwd, input: prompt, signal });
  let data;
  try { data = JSON.parse(stdout.trim().split('\n').at(-1)); } catch {
    throw Error(`Claude Code ไม่ได้ส่งผล JSON (exit ${code}) ${(stderr || stdout).trim().slice(0, 600)}`);
  }
  if (data.structured_output && !data.is_error) return data.structured_output;
  const message = String(data.result || data.subtype || stderr || 'ไม่มีผลลัพธ์ตาม schema').trim();
  const error = Error('Claude Code: ' + message.slice(0, 700));
  if (/usage limit|rate limit|limit reached|overloaded|429/i.test(message)) error.cooldown = 15 * 60_000;
  throw error;
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
  claudeCodeInFlight ??= (async () => {
    const { code, stdout } = await runClaudeCode(['auth', 'status'], { cwd, signal: AbortSignal.timeout(15_000) });
    let status = {};
    try { status = JSON.parse(stdout); } catch {}
    const method = status.authMethod;
    if (code !== 0 || method === 'none') throw Error('ต้องลงชื่อเข้าใช้ Claude Code ด้วย claude auth login');
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

export function quota(settings, usage, now = Date.now()) {
  const daily = settings.geminiDailyLimit;
  const used = usage[pacificDay(now)] || 0;
  return {
    claudecode: { name: names.claudecode, mode: 'Claude Code CLI', source: 'provider', ...claudeCode },
    gemini: { name: names.gemini, ready: Boolean(geminiKey), mode: 'Gemini API', source: 'estimate', updatedAt: now,
      windows: daily ? [{ label: `${used} / ${daily} คำขอต่อวัน`, remaining: Math.max(0, (daily - used) / daily * 100), resetAt: dailyReset(now) }] : [],
      note: geminiKey ? (daily ? 'นับเฉพาะคำขอจาก Relay' : 'ตั้งเพดานคำขอต่อวันในหน้าตั้งค่า') : 'ต้องตั้งค่า GEMINI_API_KEY' },
    codex: { name: names.codex, mode: 'Codex App Server', source: 'provider', ...codex }
  };
}


export async function generate(provider, cwd, prompt, schema, jobSignal, onUsage) {
  const signal = AbortSignal.any([jobSignal, AbortSignal.timeout(provider === 'claudecode' ? 900_000 : 240_000)]);
  let output;
  if (provider === 'claudecode') {
    const result = await claudeCodeTurn(cwd, prompt, schema, signal);
    if (!validate(result, schema)) throw Error(names[provider] + ' ส่งข้อมูลไม่ตรงกับรูปแบบที่กำหนด');
    return result;
  }
  if (provider === 'codex') {
    output = await codexTurn(cwd, prompt, schema, signal);
  } else {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent`, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': geminiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', responseJsonSchema: schema, maxOutputTokens: 20000 }
      })
    });
    if (response.ok) onUsage();
    const data = await response.json();
    if (!response.ok) {
      const error = Error(`${names[provider]} HTTP ${response.status}: ${data.error?.message || 'request failed'}`);
      error.cooldown = response.status === 429 ? (Number(response.headers.get('retry-after')) || 60) * 1000 : 0;
      throw error;
    }
    output = data.candidates?.[0]?.content?.parts?.filter(x => !x.thought).map(x => x.text || '').join('');
  }
  let result;
  try { result = JSON.parse(output); } catch { throw Error(names[provider] + ' ส่ง JSON ไม่สมบูรณ์'); }
  if (!validate(result, schema)) throw Error(names[provider] + ' ส่งข้อมูลไม่ตรงกับรูปแบบที่กำหนด');
  return result;
}
