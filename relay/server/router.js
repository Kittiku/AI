// Automatic AI routing: Relay scores every AI that is ready for a step and picks the best one.
// No AI is called to decide. The score mixes a fixed fit per role, remaining quota, real success rate and speed
// from the steps Relay has already run, and cost. The numbers below are starting points that real statistics take over.

export const PROFILES = {
  balanced: { label: 'สมดุล', weights: { fit: 0.35, quota: 0.25, success: 0.2, speed: 0.1, cost: 0.1 } },
  fast: { label: 'เร็วที่สุด', weights: { fit: 0.25, quota: 0.15, success: 0.15, speed: 0.35, cost: 0.1 } },
  cheap: { label: 'ประหยัดที่สุด', weights: { fit: 0.25, quota: 0.3, success: 0.15, speed: 0.05, cost: 0.25 } }
};

// How well each AI suits each role before any history exists. Claude Code and Codex read the repo and edit files
// themselves; Gemini through the API only sees what Relay sends, so it fits code-editing roles less.
const FIT = {
  plan: { claudecode: 0.9, codex: 0.8, gemini: 0.6 },
  backend: { claudecode: 0.85, codex: 0.85, gemini: 0.5 },
  frontend: { claudecode: 0.85, codex: 0.8, gemini: 0.7 },
  review: { claudecode: 0.85, codex: 0.85, gemini: 0.65 }
};
const SPEED_PRIOR = { claudecode: 0.8, codex: 0.5, gemini: 0.6 };
const NEUTRAL_QUOTA = 0.6;
const NEUTRAL_SUCCESS = 0.75;
const REVIEW_SAME_AI = 0.2;
const PARALLEL_SAME_AI = 0.08;

const factorNames = {
  fit: 'เหมาะกับขั้นนี้', quota: 'โควตาเหลือมากกว่า', success: 'อัตราสำเร็จสูงกว่า', speed: 'เร็วกว่า', cost: 'ต้นทุนต่ำกว่า'
};

const round2 = value => Math.round(value * 100) / 100;

function quotaFacts(info, reserve, now) {
  const windows = (info?.windows || []).filter(window => !window.resetAt || window.resetAt > now);
  if (!windows.length) return { remaining: null, score: NEUTRAL_QUOTA };
  const remaining = Math.min(...windows.map(window => window.remaining));
  return { remaining, score: Math.min(1, Math.max(0, remaining - reserve) / Math.max(1, 100 - reserve)) };
}

function statFacts(stats, provider, role, minSamples) {
  const row = stats.get(provider + ':' + role);
  if (!row || row.n < minSamples) return null;
  return { n: row.n, done: row.done, avgMs: row.avgMs, success: (row.done + 1) / (row.n + 2) };
}

// candidates: provider ids that are ready now. context: { implementers, siblings, pinned }.
export function rank({ role, candidates, quotas, settings, stats = new Map(), context = {}, now = Date.now() }) {
  const routing = settings.routing || {};
  const profile = PROFILES[routing.profile] || PROFILES.balanced;
  const minSamples = routing.minSamples || 5;
  const facts = new Map(candidates.map(provider => [provider, {
    quota: quotaFacts(quotas[provider], role === 'review' ? 0 : settings.reserve?.[provider] ?? 0, now),
    stat: statFacts(stats, provider, role, minSamples)
  }]));

  const rows = candidates.map(provider => {
    const { quota, stat } = facts.get(provider);
    const parts = {
      fit: FIT[role]?.[provider] ?? 0.5,
      quota: quota.score,
      success: stat ? stat.success : NEUTRAL_SUCCESS,
      // Measured speed on an absolute scale (a 2-minute average scores 0.5), so one AI with data is not "fastest" by default.
      speed: stat?.avgMs > 0 ? 1 / (1 + stat.avgMs / 120_000) : SPEED_PRIOR[provider] ?? 0.5,
      cost: provider === 'gemini' && /API/.test(quotas[provider]?.mode || '') ? 0.6 : 1
    };
    let score = Object.entries(profile.weights).reduce((sum, [key, weight]) => sum + weight * parts[key], 0);
    const adjust = {};
    if (role === 'review' && context.implementers?.has(provider)) { adjust.independence = -REVIEW_SAME_AI; score += adjust.independence; }
    if (context.siblings?.has(provider)) { adjust.spread = -PARALLEL_SAME_AI; score += adjust.spread; }
    return { provider, score, parts, adjust, facts: { remaining: quota.remaining, stat, usedStats: Boolean(stat) } };
  });

  rows.sort((a, b) => b.score - a.score || Object.keys(FIT.plan).indexOf(a.provider) - Object.keys(FIT.plan).indexOf(b.provider));
  if (context.pinned) {
    const index = rows.findIndex(row => row.provider === context.pinned);
    if (index > 0) rows.unshift(...rows.splice(index, 1));
  }
  const pinnedFirst = Boolean(context.pinned && rows[0]?.provider === context.pinned);
  rows.forEach((row, index) => { row.rank = index + 1; });
  if (rows[0]) rows[0].reason = explain(rows[0], rows[1], profile, pinnedFirst);
  return rows.map(row => ({ ...row, score: round2(row.score), parts: Object.fromEntries(Object.entries(row.parts).map(([key, value]) => [key, round2(value)])) }));
}

function explain(top, second, profile, pinned) {
  if (pinned) return 'ตามที่ Task Card กำหนด';
  if (!second) return 'เป็นตัวเดียวที่พร้อมใช้ตอนนี้';
  const reasons = [];
  if (second.adjust.independence && !top.adjust.independence) reasons.push('ต่างจาก AI ที่เขียนโค้ด');
  if (top.adjust.spread == null && second.adjust.spread) reasons.push('ไม่ซ้ำกับส่วนที่ทำพร้อมกัน');
  const gains = Object.entries(profile.weights)
    .map(([key, weight]) => [key, (top.parts[key] - second.parts[key]) * weight])
    .filter(([, gain]) => gain > 0.005)
    .sort((a, b) => b[1] - a[1]);
  for (const [key] of gains.slice(0, 2)) {
    if (key === 'quota' && top.facts.remaining != null) reasons.push('โควตาเหลือ ' + Math.round(top.facts.remaining) + '% (มากกว่า)');
    else if (key === 'success' && top.facts.stat) reasons.push('อัตราสำเร็จสูง ' + top.facts.stat.done + '/' + top.facts.stat.n);
    else if (key === 'speed' && top.facts.stat?.avgMs) reasons.push('เร็วกว่า เฉลี่ย ' + Math.round(top.facts.stat.avgMs / 1000) + ' วิ');
    else reasons.push(factorNames[key]);
  }
  return reasons.length ? reasons.join(' · ') : 'คะแนนรวมสูงสุด';
}
