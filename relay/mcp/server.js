#!/usr/bin/env node
// Relay MCP server (stdio). Lets Claude Desktop or Claude Code send Task Cards to a running Relay
// and read job status and results back. It only talks to Relay's local HTTP API.
// Register with Claude Code:  claude mcp add relay -- node D:\AI\relay\mcp\server.js
import { createInterface } from 'node:readline';
import { taskCardSchema } from '../server/cards.js';

const relayUrl = (process.env.RELAY_URL || 'http://127.0.0.1:' + (process.env.RELAY_PORT || 4782)).replace(/\/$/, '');

async function relay(pathname, method = 'GET', body) {
  let response;
  try {
    response = await fetch(relayUrl + '/api' + pathname, method === 'GET' ? {} : {
      method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {})
    });
  } catch {
    throw Error(`Relay is not running at ${relayUrl}. Start it with start-relay.bat, then try again.`);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(data.error || `Relay returned HTTP ${response.status}`);
  return data;
}

const brief = job => ({ id: job.id, title: job.title, status: job.status, repo: job.repo, createdAt: new Date(job.createdAt).toISOString(),
  stages: Object.fromEntries(Object.entries(job.stages || {}).map(([key, stage]) => [key, stage.status + (stage.provider ? ' (' + stage.provider + ')' : '')])) });

const tools = [
  {
    name: 'relay_list_projects',
    description: 'List the projects saved in Relay (name, folder, test commands). Use a project name from here in a Task Card.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => (await relay('/state')).projects.map(project => ({ name: project.name, path: project.path, checks: project.checks || [] }))
  },
  {
    name: 'relay_create_task',
    description: 'Queue a Task Card in Relay, which plans, implements, tests and reviews it with several AIs on a separate Git branch. ' +
      'Call this ONLY after you have shown the complete card to the user and they explicitly confirmed it in this conversation. ' +
      'Prefer acceptance items with check "command" whenever a criterion can be verified by a shell command.',
    inputSchema: { type: 'object', properties: { card: taskCardSchema }, required: ['card'], additionalProperties: false },
    run: async ({ card }) => {
      const job = await relay('/cards', 'POST', { card: { ...card, source: card.source || { kind: 'chat' } } });
      return { queued: true, job_id: job.id, title: job.title, repo: job.repo, branch: job.branch, test_commands: job.checkCommands || [],
        dashboard: relayUrl, next: 'Use relay_job_status with this job_id to follow progress.' };
    }
  },
  {
    name: 'relay_job_status',
    description: 'Status of one Relay job (stages, review, test results, recent events), or of the latest jobs when job_id is omitted.',
    inputSchema: { type: 'object', properties: { job_id: { type: 'string' } }, additionalProperties: false },
    run: async ({ job_id: id } = {}) => {
      if (!id) return (await relay('/state')).jobs.slice(-10).reverse().map(brief);
      const { diff: _diff, ...summary } = await relay('/jobs/' + encodeURIComponent(id) + '/summary?diffChars=0');
      return summary;
    }
  },
  {
    name: 'relay_job_result',
    description: 'Full result of a finished Relay job: review findings, test output, token usage, the branch and merge command, and the Git diff.',
    inputSchema: { type: 'object', properties: { job_id: { type: 'string' }, diff_chars: { type: 'integer', minimum: 0, maximum: 200000 } }, required: ['job_id'], additionalProperties: false },
    run: async ({ job_id: id, diff_chars: chars = 20000 }) => relay('/jobs/' + encodeURIComponent(id) + '/summary?diffChars=' + chars)
  },
  {
    name: 'relay_approve',
    description: 'Answer a Relay job that is waiting for approval (status "waiting_approval"; relay_job_status shows the plan or budget question). ' +
      'decision: "approve", "revise" (plan only; note says what to change) or "reject" (stops the job). ' +
      'Only call after the user decided in this conversation; never approve on your own judgment.',
    inputSchema: { type: 'object', properties: { job_id: { type: 'string' }, decision: { type: 'string', enum: ['approve', 'revise', 'reject'] }, note: { type: 'string', maxLength: 4000 } },
      required: ['job_id', 'decision'], additionalProperties: false },
    run: async ({ job_id: id, decision, note }) => {
      await relay('/jobs/' + encodeURIComponent(id) + '/approve', 'POST', { decision, note });
      return { ok: true, decision, next: 'Use relay_job_status to follow the job.' };
    }
  },
  {
    name: 'relay_cancel_job',
    description: 'Stop a queued or running Relay job. Only call when the user asks to stop it.',
    inputSchema: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'], additionalProperties: false },
    run: async ({ job_id: id }) => brief(await relay('/jobs/' + encodeURIComponent(id) + '/cancel', 'POST'))
  },
  {
    name: 'relay_quota',
    description: 'Remaining quota and connection status of each AI Relay can use.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => Object.fromEntries(Object.entries((await relay('/state')).quotas).map(([id, info]) => [id, {
      ready: info.ready, note: info.note || '', windows: (info.windows || []).map(window => ({ window: window.label, remainingPercent: Math.round(window.remaining),
        resetsAt: window.resetAt ? new Date(window.resetAt).toISOString() : null }))
    }]))
  }
];

function send(message) { process.stdout.write(JSON.stringify(message) + '\n'); }

async function handle(message) {
  const { id, method, params } = message;
  if (id === undefined || id === null) return; // notifications need no reply
  try {
    if (method === 'initialize') {
      return send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} }, serverInfo: { name: 'relay', version: '0.2.0' },
        instructions: 'Relay runs coding tasks with several AIs on a separate Git branch. Draft a Task Card with the user, show it, and call relay_create_task only after they confirm.' } });
    }
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: tools.map(({ run: _run, ...tool }) => tool) } });
    if (method === 'tools/call') {
      const tool = tools.find(item => item.name === params?.name);
      if (!tool) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown tool: ' + params?.name } });
      try {
        const result = await tool.run(params.arguments || {});
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } });
      } catch (error) {
        return send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: error.message }] } });
      }
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
  } catch (error) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: error.message } });
  }
}

createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
  void handle(message);
});
