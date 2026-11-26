import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity, Check, CircleCheck, ClipboardList, Clock, FlaskConical, GitBranch, TriangleAlert, Wrench, X
} from 'lucide-react';

import { InlineMarkdown, Markdown } from './markdown.js';

// Panels for the job detail page: outcome tiles, the acceptance checklist from the Task Card,
// the history of review / fix rounds, and a one-line stepper for finished jobs.
// Everything here works with old jobs (no reviewHistory, diffStat or manualChecks) and new ones.

const providerNames = { claudecode: 'Claude Code', gemini: 'Gemini', codex: 'Codex', reused: 'ใช้ของเดิม' };
const providerName = id => providerNames[id] || id || '–';
const roleLabels = { backend: 'Backend', frontend: 'Frontend', single: 'ลงมือทำ', plan: 'วางแผน', review: 'รีวิว' };
const stageLabels = { plan: 'วางแผน', backend: 'Backend', frontend: 'Frontend', checks: 'ทดสอบ', review: 'รีวิว' };
const stageStatusLabels = {
  pending: 'รอ', running: 'กำลังทำ', done: 'เสร็จ', warning: 'ตรวจเพิ่ม', failed: 'ล้มเหลว', cancelled: 'หยุด',
  waiting: 'รอโควตา', retrying: 'กำลังลองใหม่', skipped: 'ข้าม'
};
const triggerLabels = { initial: 'รีวิวครั้งแรก', auto_fix: 'แก้อัตโนมัติ', manual_fix: 'แก้ต่ออีกรอบ (สั่งเอง)' };
const checkKinds = {
  command: ['คำสั่ง', 'Relay รันคำสั่งนี้และต้องได้ exit code 0'],
  review: ['รีวิว', 'AI ผู้รีวิวตรวจข้อนี้'],
  manual: ['ตรวจเอง', 'คุณตรวจเองหลังส่งมอบ']
};
const acceptanceStatus = {
  passed: ['ผ่าน', 'ok'], failed: ['ไม่ผ่าน', 'bad'], pending: ['ยังไม่ตรวจ', 'pending'], skipped: ['ไม่ได้รัน', 'off']
};

export function formatDuration(ms) {
  if (!(ms >= 0)) return '–';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return seconds + ' วิ';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + ' นาที ' + (seconds % 60) + ' วิ';
  return Math.floor(minutes / 60) + ' ชม. ' + (minutes % 60) + ' นาที';
}

const clock = new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' });
const dateTime = at => Number.isFinite(at) ? clock.format(at) : '';

// Count files and +/− lines from a unified diff, for jobs saved before the server sent diffStat.
export function diffStatFromText(text) {
  if (typeof text !== 'string' || !text) return null;
  let files = 0, additions = 0, deletions = 0, inFile = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) { files++; inFile = true; continue; }
    if (!inFile || /^(index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line)) continue;
    if (line.startsWith('+')) additions++;
    else if (line.startsWith('-')) deletions++;
  }
  return { files, additions, deletions };
}

const normalizeCommand = value => String(value ?? '').trim().replace(/\s+/g, ' ');
const checkCommand = check => check?.command ?? check?.label ?? '';
const checkOk = check => typeof check?.ok === 'boolean' ? check.ok : check?.code === 0;
const checkExit = check => check?.exitCode !== undefined ? check.exitCode : check?.code ?? null;
const checkRan = check => typeof check?.ok === 'boolean' || (check?.code !== null && check?.code !== undefined) || check?.exitCode != null;

function reviewOk(review) {
  if (review.ok !== undefined) return review.ok;
  return Array.isArray(review.findings) ? review.findings.length === 0 : null;
}

// The last review result: the final reviewHistory round, or job.review for older jobs.
export function latestReview(job) {
  const history = Array.isArray(job?.reviewHistory) ? job.reviewHistory : [];
  const review = history.at(-1) ?? job?.review;
  if (!review) return null;
  return { ok: reviewOk(review), summary: review.summary || '', findings: review.findings || [] };
}

// Client-side twin of the server's evaluateAcceptance(job), used when the job came from /api/state
// (which carries card, checks, review and manualChecks but not the evaluated list).
export function evaluateAcceptance(job) {
  const items = Array.isArray(job?.card?.acceptance) ? job.card.acceptance : [];
  const checks = Array.isArray(job?.checks) ? job.checks : [];
  const review = latestReview(job);
  return items.map((item, index) => {
    const check = item.check || 'review';
    const command = check === 'command' ? normalizeCommand(item.command) || null : null;
    let status = 'pending', checked = false, matchedCheck = null;
    if (check === 'command' && command) {
      const found = checks.filter(entry => normalizeCommand(checkCommand(entry)) === command).at(-1);
      if (found) {
        matchedCheck = { command: checkCommand(found), ok: checkOk(found), exitCode: checkExit(found) };
        status = !checkRan(found) ? 'skipped' : matchedCheck.ok ? 'passed' : 'failed';
      }
    } else if (check === 'review') {
      status = review?.ok === true ? 'passed' : review?.ok === false ? 'failed' : 'pending';
    } else if (check === 'manual') {
      checked = Boolean(job?.manualChecks?.[String(index)]);
      status = checked ? 'passed' : 'pending';
    }
    return { index, text: item.text, check, command, status, checked, matchedCheck };
  });
}

/* ---------------- Outcome tiles ---------------- */

// Four numbers that answer "how did it go?". onOpenTab receives 'review', 'checks', 'diff' or 'usage';
// the page maps them to its tabs or sections. A tile without a handler is shown as plain text.
export function OutcomeTiles({ job, diffStat, diffText, onOpenTab }) {
  const review = latestReview(job);
  const rounds = Array.isArray(job?.reviewHistory) ? job.reviewHistory.length : 0;
  const checks = Array.isArray(job?.checks) ? job.checks : [];
  const ran = checks.filter(checkRan);
  const passed = ran.filter(checkOk).length;
  const stat = job?.diffStat || diffStat || diffStatFromText(diffText ?? (typeof job?.diff === 'string' ? job.diff : job?.diff?.diff));
  const calls = job?.usage?.calls;
  const elapsed = job?.startedAt ? (job.finishedAt || Date.now()) - job.startedAt : null;
  const findings = review?.findings?.length || 0;

  const tiles = [
    {
      key: 'review', icon: ClipboardList, label: 'ผลรีวิว',
      tone: review?.ok == null ? '' : review.ok ? 'ok' : 'warn',
      value: review?.ok == null ? 'ยังไม่รีวิว' : review.ok ? 'ไม่พบปัญหา' : findings ? 'เหลือ ' + findings + ' ข้อ' : 'ไม่ผ่าน',
      note: rounds > 1 ? 'รีวิว ' + rounds + ' รอบ' : review?.summary ? 'ดูสรุปจากรีวิว' : null
    },
    {
      key: 'checks', icon: FlaskConical, label: 'เทสผ่าน',
      tone: !checks.length ? '' : ran.length && passed === ran.length ? 'ok' : passed < ran.length ? 'bad' : '',
      value: checks.length ? passed + '/' + checks.length : 'ไม่ได้ทดสอบ',
      note: checks.length > ran.length ? 'ไม่ได้รัน ' + (checks.length - ran.length) + ' คำสั่ง' : null
    },
    {
      key: 'diff', icon: GitBranch, label: 'ไฟล์ที่เปลี่ยน',
      tone: '',
      value: stat ? stat.files + ' ไฟล์' : '–',
      note: stat ? <><span className="plus">+{stat.additions}</span> <span className="minus">−{stat.deletions}</span></> : 'เปิดแท็บ Git diff เพื่อดู'
    },
    {
      key: 'usage', icon: Activity, label: 'เรียก AI',
      tone: '',
      value: calls != null ? calls + ' ครั้ง' : '–',
      note: elapsed != null ? 'รวม ' + formatDuration(elapsed) : null
    }
  ];

  return <div className="outcome-tiles" role="list" aria-label="สรุปผลงาน">
    {tiles.map(({ key, icon: Icon, label, value, note, tone }) => {
      const body = <>
        <span className="outcome-icon" aria-hidden="true"><Icon size={18} /></span>
        <span className="outcome-text">
          <small>{label}</small>
          <strong>{value}</strong>
          {note ? <em>{note}</em> : null}
        </span>
      </>;
      return <div role="listitem" key={key} className="outcome-tile-item">
        {onOpenTab ? <button type="button" className={'outcome-tile ' + tone} onClick={() => onOpenTab(key)}
          aria-label={label + ' ' + (typeof value === 'string' ? value : '') + ' · เปิดรายละเอียด'}>{body}</button> :
          <div className={'outcome-tile ' + tone}>{body}</div>}
      </div>;
    })}
  </div>;
}

/* ---------------- Acceptance checklist ---------------- */

async function patchAcceptance(id, index, checked) {
  const response = await fetch('/api/jobs/' + encodeURIComponent(id) + '/acceptance', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index, checked })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(result.error || 'บันทึกไม่สำเร็จ');
  return result;
}

function AcceptanceStatus({ status }) {
  const [text, tone] = acceptanceStatus[status] || [status, ''];
  return <span className={'acceptance-status ' + tone}>
    {tone === 'ok' ? <Check size={13} aria-hidden="true" /> : tone === 'bad' ? <X size={13} aria-hidden="true" /> : tone === 'pending' ? <Clock size={13} aria-hidden="true" /> : null}
    {text}
  </span>;
}

// Shows job.card.acceptance grouped by kind. Manual items are ticked here and saved through
// PATCH /api/jobs/:id/acceptance; onUpdated({ id, manualChecks, acceptance }) lets the page sync the job.
// `acceptance` may be the evaluated list from /api/jobs/:id/summary; otherwise it is computed here.
// Jobs that did not come from a card show plan.acceptance as text.
export function AcceptanceChecklist(props) {
  return <JobAcceptanceChecklist key={props.job?.id} {...props} />;
}

function JobAcceptanceChecklist({ job, acceptance, onUpdated, readOnly = false, manualOnly = false }) {
  const [manualChecks, setManualChecks] = useState(() => ({ ...(job?.manualChecks || {}) }));
  const [saving, setSaving] = useState({});
  const [notice, setNotice] = useState(null);
  const serverChecks = JSON.stringify(job?.manualChecks || {});
  useEffect(() => { setManualChecks(JSON.parse(serverChecks)); }, [serverChecks]);

  const items = useMemo(() => {
    const base = Array.isArray(acceptance) && acceptance.length ? acceptance : evaluateAcceptance(job);
    const visibleItems = manualOnly ? base.filter(item => item.check === 'manual') : base;
    return visibleItems.map(item => {
      if (item.check !== 'manual') return item;
      const key = String(item.index);
      const checked = Object.hasOwn(manualChecks, key) ? manualChecks[key] : item.checked;
      return { ...item, checked, status: checked ? 'passed' : 'pending' };
    });
  }, [acceptance, job, manualChecks, manualOnly]);

  if (!items.length) {
    if (manualOnly) return <p className="muted">ไม่มีเกณฑ์ตรวจเองที่ค้างอยู่</p>;
    const text = job?.plan?.acceptance;
    return <section className="card acceptance" aria-label="เกณฑ์รับงาน">
      <div className="card-head"><h2>เกณฑ์รับงาน</h2></div>
      {text ? <>
        <p className="muted">งานนี้ไม่ได้มาจาก Task Card จึงแสดงเกณฑ์รับงานจากแผนของ AI</p>
        <p className="preline acceptance-plan">{text}</p>
      </> : <p className="muted">งานนี้ไม่มีเกณฑ์รับงานที่กำหนดไว้</p>}
    </section>;
  }

  async function toggle(item, checked) {
    const key = String(item.index);
    const previous = manualChecks[key];
    setManualChecks(current => ({ ...current, [key]: checked }));
    setSaving(current => ({ ...current, [key]: true }));
    setNotice(null);
    try {
      const result = await patchAcceptance(job.id, item.index, checked);
      if (result.manualChecks) setManualChecks({ ...result.manualChecks });
      setNotice({ text: 'บันทึกแล้ว' });
      onUpdated?.(result);
    } catch (error) {
      setManualChecks(current => {
        const next = { ...current };
        if (previous === undefined) delete next[key];
        else next[key] = previous;
        return next;
      });
      setNotice({ text: 'บันทึก "' + item.text + '" ไม่สำเร็จ: ' + error.message, error: true });
    } finally {
      setSaving(current => { const next = { ...current }; delete next[key]; return next; });
    }
  }

  const done = items.filter(item => item.status === 'passed').length;
  const groups = ['command', 'review', 'manual'].map(kind => [kind, items.filter(item => item.check === kind)]).filter(([, list]) => list.length);
  const busy = Object.keys(saving).length > 0;
  const title = manualOnly ? 'เกณฑ์ตรวจเอง' : 'เกณฑ์รับงาน';

  return <section className="card acceptance" aria-label={title}>
    <div className="card-head">
      <h2>{title}</h2>
      <span className={'chip acceptance-count' + (done === items.length ? ' ok' : '')}>
        {manualOnly ? 'ยังไม่ได้ติ๊ก ' + (items.length - done) + ' ข้อ' : 'ผ่าน ' + done + '/' + items.length}
      </span>
    </div>
    {groups.map(([kind, list]) => <div key={kind} className={'acceptance-group ' + kind}>
      {manualOnly ? null : <h3><span className={'acceptance-kind ' + kind}>{checkKinds[kind][0]}</span><small>{checkKinds[kind][1]}</small></h3>}
      <ul className="acceptance-list">
        {list.map(item => {
          const key = String(item.index);
          return <li key={item.index} className={'acceptance-item ' + item.status}>
            {kind === 'manual' ? <label className="checkbox acceptance-check">
              <input type="checkbox" checked={item.checked} disabled={readOnly || Boolean(saving[key])}
                onChange={event => toggle(item, event.target.checked)} />
              <span className="acceptance-text">{item.text}</span>
            </label> : <span className="acceptance-text">{item.text}</span>}
            <span className="acceptance-side">
              {saving[key] ? <span className="acceptance-status pending" role="status">กำลังบันทึก…</span> : <AcceptanceStatus status={item.status} />}
            </span>
            {kind === 'command' ? <div className="acceptance-command">
              <code>{item.command || '–'}</code>
              {item.matchedCheck ? item.matchedCheck.exitCode != null && !item.matchedCheck.ok ? <small>exit {item.matchedCheck.exitCode}</small> : null :
                <small>ยังไม่พบผลของคำสั่งนี้ในผลทดสอบ</small>}
            </div> : null}
          </li>;
        })}
      </ul>
    </div>)}
    {notice && !busy ? <p role={notice.error ? 'alert' : 'status'} className={notice.error ? 'error' : 'success acceptance-saved'}>{notice.text}</p> : null}
  </section>;
}

/* ---------------- Review / fix-round history ---------------- */

function findingParts(finding) {
  if (typeof finding === 'string') return { owner: null, text: finding };
  if (finding && typeof finding === 'object') return { owner: finding.owner || null, text: finding.detail || finding.text || finding.summary || JSON.stringify(finding) };
  return { owner: null, text: String(finding ?? '') };
}

// Every review round from job.reviewHistory, newest first, with the user's note and who fixed the findings.
// Older jobs without reviewHistory show only their latest job.review. renderFinding(text) may turn file names into links.
export function ReviewHistoryList({ job, renderFinding }) {
  const history = Array.isArray(job?.reviewHistory) && job.reviewHistory.length ? job.reviewHistory : null;
  const rounds = history ? [...history].reverse() : job?.review ? [{
    round: null, at: null, trigger: null, userNote: null, provider: job.stages?.review?.provider || null,
    ok: latestReview(job)?.ok ?? null, summary: job.review.summary || '', findings: job.review.findings || [], fixedBy: [], legacy: true
  }] : [];
  if (!rounds.length) return <p className="muted">ยังไม่มีผลรีวิว</p>;
  const latest = rounds[0];
  return <div className="review-history">
    {!history ? <p className="muted">งานนี้สร้างก่อนเริ่มเก็บประวัติทุกรอบ จึงแสดงเฉพาะผลรีวิวล่าสุด</p> : null}
    <ol className="review-rounds">
      {rounds.map((entry, position) => {
        const findings = Array.isArray(entry.findings) ? entry.findings : [];
        const ok = reviewOk(entry);
        const tone = ok === null ? 'pending' : ok ? 'ok' : 'warn';
        const Icon = ok === null ? Clock : ok ? CircleCheck : TriangleAlert;
        const fixedBy = Array.isArray(entry.fixedBy) ? entry.fixedBy : [];
        return <li key={(entry.round ?? 'latest') + ':' + position} className={'review-round ' + tone + (entry === latest ? ' latest' : '')}>
          <header className="review-round-head">
            <span className="review-round-icon" aria-hidden="true"><Icon size={16} /></span>
            <strong>{entry.round ? 'รอบ ' + entry.round : 'ผลรีวิวล่าสุด'}</strong>
            {entry.trigger ? <span className={'chip review-trigger ' + entry.trigger}>{triggerLabels[entry.trigger] || entry.trigger}</span> : null}
            <span className={'review-result ' + tone}>{ok === null ? 'ยังไม่ตรวจ' : ok ? 'ไม่พบปัญหา' : findings.length ? 'พบ ' + findings.length + ' ข้อ' : 'ไม่ผ่าน'}</span>
            {entry.provider || entry.at ? <small className="review-meta">
              {entry.provider ? 'รีวิวโดย ' + providerName(entry.provider) : ''}{entry.provider && entry.at ? ' · ' : ''}{entry.at ? dateTime(entry.at) : ''}
            </small> : null}
          </header>
          {entry.userNote ? <p className="review-note"><b>หมายเหตุของคุณ:</b> <span className="preline">{entry.userNote}</span></p> : null}
          {entry.summary ? <Markdown className="review-summary" text={entry.summary} /> : null}
          {findings.length ? <ul className="review-findings">{findings.map((finding, index) => {
            const { owner, text } = findingParts(finding);
            return <li key={index}>{owner ? <b>{roleLabels[owner] || owner}</b> : null}{owner ? ' · ' : ''}{renderFinding ? renderFinding(text) : <InlineMarkdown text={text} />}</li>;
          })}</ul> : null}
          {fixedBy.length ? <p className="review-fixed">
            <Wrench size={14} aria-hidden="true" /> แก้โดย {fixedBy.map((item, index) =>
              <span key={index} className="chip">{roleLabels[item.role] || item.role}{item.provider ? ' · ' + providerName(item.provider) : ''}</span>)}
          </p> : null}
        </li>;
      })}
    </ol>
  </div>;
}

/* ---------------- Stage stepper ---------------- */

const stuckStatuses = new Set(['failed', 'cancelled', 'interrupted']);

function stageList(job) {
  const keys = ['plan', 'backend', ...(job?.single ? [] : ['frontend']), 'checks', 'review'];
  return keys.map(key => {
    const stage = job?.stages?.[key] || {};
    let status = stage.status || 'pending';
    if (key === 'checks' && !job?.runChecks && status === 'pending') status = 'skipped';
    if (['running', 'waiting', 'retrying'].includes(status)) status = 'skipped';
    if (status === 'pending' && stuckStatuses.has(job?.status)) status = 'skipped';
    return { key, ...stage, status };
  });
}

const stageTitle = (job, key) => job?.single && key === 'backend' ? 'ลงมือทำ' : stageLabels[key];

// A finished job's stages on one line, with the full details folded underneath.
// `children` (for example the saved monitor or team tree) is rendered inside the folded section after the per-stage table.
export function StageStepper({ job, children, defaultOpen = false }) {
  const stages = stageList(job);
  return <section className="card stage-stepper" aria-label="ขั้นตอนการทำงาน">
    <ol className="stage-line">
      {stages.map(stage => <li key={stage.key} className={'stage-line-item ' + stage.status}
        title={stageTitle(job, stage.key) + ' · ' + (stageStatusLabels[stage.status] || stage.status)}>
        <span className="stage-line-dot" aria-hidden="true">
          {stage.status === 'done' ? <Check size={12} /> : stage.status === 'failed' || stage.status === 'cancelled' ? <X size={12} /> :
            stage.status === 'warning' ? <TriangleAlert size={12} /> : null}
        </span>
        <span className="stage-line-label">{stageTitle(job, stage.key)}</span>
        <span className="visually-hidden"> {stageStatusLabels[stage.status] || stage.status}</span>
      </li>)}
    </ol>
    <details className="stage-details" open={defaultOpen || undefined}>
      <summary>รายละเอียดขั้นตอน</summary>
      <ul className="stage-detail-list">
        {stages.map(stage => <li key={stage.key} className={'stage-detail ' + stage.status}>
          <strong>{stageTitle(job, stage.key)}</strong>
          <span className="stage-detail-status">{stage.key === 'checks' && stage.status === 'skipped' ? 'ไม่ได้ทดสอบ' : stageStatusLabels[stage.status] || stage.status}</span>
          <small>
            {[stage.provider ? providerName(stage.provider) : null,
              stage.startedAt && stage.endedAt ? formatDuration(stage.endedAt - stage.startedAt) : null,
              stage.round ? 'แก้รอบ ' + stage.round : null].filter(Boolean).join(' · ')}
          </small>
          {stage.note ? <p className="stage-detail-note">{stage.note}</p> : null}
        </li>)}
      </ul>
      {children}
    </details>
  </section>;
}
