// Task Card: the structured hand-off from a chat (or any client) to Relay.
// The same JSON Schema is served to MCP clients, so Claude sees exactly what Relay accepts.
const providerIds = ['claudecode', 'codex', 'gemini'];
const roleIds = ['plan', 'backend', 'frontend', 'review'];

export const taskCardSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'project', 'goal'],
  properties: {
    version: { type: 'integer', enum: [1], description: 'Card format version. Use 1.' },
    title: { type: 'string', maxLength: 100, description: 'Short job name.' },
    project: { type: 'string', maxLength: 500, description: 'Name of a project saved in Relay, or the absolute path of a Git repository.' },
    type: { type: 'string', enum: ['feature', 'bugfix', 'refactor', 'docs', 'other'] },
    goal: { type: 'string', maxLength: 4000, description: 'What should be true when the job is done.' },
    context: { type: 'string', maxLength: 8000, description: 'Decisions and background agreed in the conversation.' },
    scope: {
      type: 'object', additionalProperties: false,
      properties: {
        include: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 300 }, description: 'Paths or globs the work should touch.' },
        exclude: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 300 }, description: 'Paths or globs that must not change.' }
      }
    },
    acceptance: {
      type: 'array', maxItems: 30,
      items: {
        type: 'object', additionalProperties: false, required: ['text'],
        properties: {
          text: { type: 'string', maxLength: 500 },
          check: { type: 'string', enum: ['command', 'review', 'manual'], description: 'command: Relay runs `command` and needs exit code 0. review: the reviewing AI checks it. manual: the user checks it after delivery.' },
          command: { type: 'string', maxLength: 300 }
        }
      }
    },
    constraints: { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 500 } },
    routing: {
      type: 'object', additionalProperties: false,
      properties: {
        prefer: { type: 'object', additionalProperties: false, properties: Object.fromEntries(roleIds.map(role => [role, { type: 'string', enum: providerIds }])) },
        profile: { type: 'string', enum: ['balanced', 'fast', 'cheap'], description: 'How automatic routing weighs speed and cost for this job.' },
        budget_usd: { type: 'number', minimum: 0, description: 'Budget for this job in USD. Relay pauses for approval when it is reached.' }
      }
    },
    approvals: {
      type: 'array', maxItems: 3, items: { type: 'string', enum: ['after_plan'] },
      description: 'after_plan: Relay stops after planning and waits for the user to approve, revise or reject the plan.'
    },
    source: {
      type: 'object', additionalProperties: false,
      properties: { kind: { type: 'string', maxLength: 40 }, note: { type: 'string', maxLength: 500 } }
    }
  }
};

// Small JSON Schema checker for the subset used above; returns the first problem as text.
function check(value, schema, where) {
  if (schema.enum && !schema.enum.includes(value)) return `${where} ต้องเป็นค่าใดค่าหนึ่งใน ${schema.enum.join(', ')}`;
  if (schema.type === 'string') {
    if (typeof value !== 'string') return `${where} ต้องเป็นข้อความ`;
    if (schema.maxLength && value.length > schema.maxLength) return `${where} ยาวเกิน ${schema.maxLength} ตัวอักษร`;
    return '';
  }
  if (schema.type === 'integer' || schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))) return `${where} ต้องเป็นตัวเลข`;
    if (schema.minimum !== undefined && value < schema.minimum) return `${where} ต้องไม่น้อยกว่า ${schema.minimum}`;
    return '';
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return `${where} ต้องเป็นรายการ`;
    if (schema.maxItems && value.length > schema.maxItems) return `${where} มีได้ไม่เกิน ${schema.maxItems} รายการ`;
    for (const [index, item] of value.entries()) { const problem = check(item, schema.items, `${where}[${index}]`); if (problem) return problem; }
    return '';
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return `${where} ต้องเป็น object`;
  for (const key of schema.required || []) if (value[key] === undefined || value[key] === '') return `${where}.${key} จำเป็นต้องมี`;
  for (const [key, item] of Object.entries(value)) {
    if (!schema.properties[key]) { if (schema.additionalProperties === false) return `${where}.${key} ไม่รู้จักฟิลด์นี้`; continue; }
    const problem = check(item, schema.properties[key], `${where}.${key}`);
    if (problem) return problem;
  }
  return '';
}

export function validateCard(card) {
  const problem = check(card, taskCardSchema, 'card');
  if (problem) return problem;
  if (!card.title.trim() || !card.goal.trim() || !card.project.trim()) return 'card ต้องมี title, project และ goal ที่ไม่ว่าง';
  const commandless = (card.acceptance || []).find(item => item.check === 'command' && !item.command?.trim());
  if (commandless) return 'เกณฑ์ "' + commandless.text + '" เป็นแบบ command แต่ไม่มีคำสั่ง';
  return '';
}

// Turns a card into the fields of a Relay job. The prompt keeps every part of the card readable for the AIs.
export function cardToJob(card, settings) {
  const lines = ['# ' + card.title.trim(), '', '## Goal', card.goal.trim()];
  if (card.type) lines.push('', 'Type: ' + card.type);
  if (card.context?.trim()) lines.push('', '## Context (agreed with the user)', card.context.trim());
  const include = card.scope?.include || [];
  const exclude = card.scope?.exclude || [];
  if (include.length || exclude.length) {
    lines.push('', '## Scope');
    if (include.length) lines.push('Work in: ' + include.join(', '));
    if (exclude.length) lines.push('Do not change: ' + exclude.join(', '));
  }
  if (card.constraints?.length) lines.push('', '## Constraints', ...card.constraints.map(item => '- ' + item));
  const acceptance = card.acceptance || [];
  if (acceptance.length) {
    lines.push('', '## Acceptance criteria');
    for (const item of acceptance) {
      const kind = item.check || 'review';
      lines.push('- [' + kind + '] ' + item.text + (kind === 'command' ? ' (Relay runs: `' + item.command + '`)' : kind === 'manual' ? ' (the user checks this after delivery)' : ''));
    }
  }
  const prompt = lines.join('\n');
  const commands = acceptance.filter(item => item.check === 'command').map(item => item.command.trim());

  let routes;
  const prefer = card.routing?.prefer || {};
  if (Object.keys(prefer).length) {
    routes = structuredClone(settings.routes);
    for (const [role, provider] of Object.entries(prefer)) {
      const [primary, fallback] = routes[role];
      routes[role] = [provider, primary !== provider ? primary : fallback === provider ? '' : fallback];
    }
  }
  const scope = include.length || exclude.length ? { include, exclude } : null;
  return { title: card.title.trim(), prompt, commands, routes, budgetUsd: card.routing?.budget_usd ?? null,
    type: card.type || 'feature', scope, approvals: card.approvals || [], pinned: prefer, profile: card.routing?.profile || null };
}

// Scope check for changed paths. A pattern without wildcards matches that file or everything under that folder;
// "*" stays inside one folder, "**" crosses folders. Matching ignores case, like Windows paths.
function matcher(pattern) {
  let glob = pattern.replaceAll('\\', '/').replace(/^\.\//, '').trim();
  if (glob.endsWith('/')) glob += '**';
  if (!/[*?]/.test(glob)) { const lower = glob.toLowerCase(); return name => name === lower || name.startsWith(lower + '/'); }
  let source = '';
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (char === '*' && glob[index + 1] === '*') { source += '.*'; index++; if (glob[index + 1] === '/') index++; }
    else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const regex = new RegExp('^' + source + '$', 'i');
  return name => regex.test(name);
}

export function outOfScope(scope, paths) {
  if (!scope) return [];
  const include = (scope.include || []).map(matcher);
  const exclude = (scope.exclude || []).map(matcher);
  return paths.filter(name => {
    const lower = name.replaceAll('\\', '/').toLowerCase();
    return exclude.some(test => test(lower)) || (include.length > 0 && !include.some(test => test(lower)));
  });
}
