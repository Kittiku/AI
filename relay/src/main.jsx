import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/noto-sans-thai';
import {
  ArrowRight, ChartPie, Check, ChevronLeft, ClipboardList, CodeXml, Copy, FlaskConical, FolderGit2, FolderOpen, FolderPlus,
  GitBranch, Layers, Plus, RefreshCw, RotateCcw, Settings, Sparkle, Terminal, Trash, X
} from 'lucide-react';
import './style.css';

const providers = {
  claudecode: { name: 'Claude Code', company: 'Anthropic', icon: Terminal },
  gemini: { name: 'Gemini', company: 'Google', icon: Sparkle },
  codex: { name: 'Codex', company: 'OpenAI', icon: CodeXml }
};
const pages = [
  ['queue', 'คิวงาน', Layers], ['projects', 'โปรเจกต์', FolderGit2], ['quota', 'โควตา AI', ChartPie], ['settings', 'ตั้งค่า', Settings]
];
const statusLabels = {
  queued: 'รอเริ่ม', running: 'กำลังดำเนินการ', stopping: 'กำลังหยุด', complete: 'พร้อมตรวจผล',
  needs_review: 'ต้องตรวจเพิ่ม', failed: 'งานติดขัด', cancelled: 'หยุดแล้ว', interrupted: 'ถูกขัดจังหวะ'
};
const roleNames = { plan: 'วางแผน', backend: 'Backend', frontend: 'UX/UI', review: 'รีวิว' };
const stageNames = { plan: 'วางแผน', backend: 'Backend', frontend: 'UX/UI', checks: 'ทดสอบ', review: 'รีวิว' };
const stageStatus = { pending: 'รอ', running: 'กำลังทำ', done: 'เสร็จ', warning: 'ตรวจเพิ่ม', failed: 'ล้มเหลว', cancelled: 'หยุด', waiting: 'รอโควตา', retrying: 'กำลังลองใหม่' };
const busyStatuses = new Set(['queued', 'running', 'stopping']);
const doneStatuses = new Set(['complete', 'needs_review']);
const stuckStatuses = new Set(['failed', 'cancelled', 'interrupted']);
const clock = new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' });
const calendar = new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' });
const time = date => clock.format(date);
const dateTime = date => calendar.format(date);
const draftKey = 'relay.newJobDraft';
const promptLimit = 8000;

function duration(ms) {
  if (!(ms >= 0)) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return seconds + ' วิ';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + ' นาที ' + (seconds % 60) + ' วิ';
  return Math.floor(minutes / 60) + ' ชม. ' + (minutes % 60) + ' นาที';
}
const jobDuration = job => job.startedAt ? duration((job.finishedAt || Date.now()) - job.startedAt) : '';
const repoName = repo => repo.split(/[\\/]/).filter(Boolean).at(-1) || repo;
const samePath = (a, b) => Boolean(a && b) && a.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase() === b.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase();
const providerName = id => id === 'reused' ? 'ใช้ของเดิม' : providers[id]?.name || id;
const quote = value => '"' + value.replaceAll('"', '\\"') + '"';

function readStorage(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function writeStorage(key, value) {
  try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

async function api(url, method = 'GET', body) {
  const response = await fetch('/api' + url, method === 'GET' ? {} : {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {})
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(Error(result.error || 'เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ'), { data: result, status: response.status });
  return result;
}

function Button({ children, icon: Icon, primary, danger, ...props }) {
  return <button type="button" className={'button' + (primary ? ' primary' : '') + (danger ? ' danger' : '')} {...props}>
    {Icon ? <Icon aria-hidden="true" size={18} /> : null}{children}
  </button>;
}

function ProviderIcon({ id, size = 27 }) {
  const Icon = providers[id]?.icon || Check;
  return <span className={'provider-icon ' + id}><Icon size={size} aria-hidden="true" /></span>;
}

function ProviderCard({ id, info, detailed, reserve }) {
  const model = providers[id];
  const windows = info?.windows ?? [];
  const now = Date.now();
  const fresh = info?.ready && (id === 'gemini' || (info.updatedAt && now - info.updatedAt < 300_000));
  const currentWindows = windows.filter(window => !window.resetAt || window.resetAt > now);
  const ordered = [...currentWindows].sort((a, b) => a.remaining - b.remaining);
  const display = detailed ? windows : ordered.slice(0, 1);
  return <article className="provider card">
    <header className="provider-head">
      <ProviderIcon id={id} />
      <div><h2>{model.name}</h2><p>{model.company}</p></div>
      <span className={'connection ' + (info?.ready ? 'connected' : '')}>{info?.ready ? 'เชื่อมต่อแล้ว' : 'รอเชื่อมต่อ'}</span>
    </header>
    {display.length ? display.map(window => {
      const current = fresh && (!window.resetAt || window.resetAt > now);
      const low = current && window.remaining <= reserve;
      return <div className="quota-window" key={window.label}>
        <div className="quota-label">โควตาคงเหลือ · {window.label}{low ? <span className="low-note"> · ต่ำกว่าที่กันไว้</span> : null}</div>
        <div className="bar-row">
          <div className="bar" role="meter" aria-label={'โควตา ' + window.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={current ? window.remaining : undefined}>
            {current ? <span className={id + (low ? ' low' : '')} style={{ width: window.remaining + '%' }} /> : null}
            {reserve > 0 ? <i className="reserve-mark" style={{ left: reserve + '%' }} title={'กันไว้ ' + reserve + '%'} /> : null}
          </div>
          <strong className={low ? 'low-text' : ''}>{current ? Math.round(window.remaining) + '%' : '–'}</strong>
        </div>
        {window.resetAt ? <small>รีเซ็ต {detailed ? dateTime(window.resetAt) : time(window.resetAt)}</small> : null}
      </div>;
    }) : <div className="quota-window"><div className="quota-label">โควตาคงเหลือ</div><div className="bar-row"><div className="bar" /><strong>–</strong></div></div>}
    <p className="quota-note">{info?.cooldownUntil > now ? 'พักถึง ' + time(info.cooldownUntil) :
      currentWindows.length && fresh ? (info.source === 'estimate' ? 'ประมาณการจาก Relay' : 'ข้อมูลจากผู้ให้บริการ') + ' · ' + time(info.updatedAt) :
      info?.note || 'ยังไม่มีข้อมูลโควตาล่าสุด'}</p>
    {detailed ? <p className="mode">{info?.mode}{info?.updatedAt ? ' · อัปเดต ' + dateTime(info.updatedAt) : ''}{reserve ? ' · กันไว้ ' + reserve + '%' : ''}</p> : null}
  </article>;
}

function stagesOf(job) {
  const keys = ['plan', 'backend', 'frontend', ...(job.runChecks ? ['checks'] : []), 'review'];
  return keys.map(key => {
    const stage = job.stages?.[key] || {};
    let status = stage.status || 'pending';
    if (status === 'pending' && stuckStatuses.has(job.status)) status = 'skipped';
    return { key, ...stage, status };
  });
}

function Stepper({ job, compact }) {
  const stages = stagesOf(job);
  const now = Date.now();
  return <ol className={'stepper' + (compact ? ' compact' : '')}>
    {stages.map(stage => <li key={stage.key} className={'stage ' + stage.status}>
      <span className="stage-dot" aria-hidden="true">{stage.status === 'done' ? <Check size={14} /> : stage.status === 'failed' ? <X size={14} /> : null}</span>
      <div>
        <strong>{stageNames[stage.key]}</strong>
        <small>{stage.status === 'skipped' ? 'ไม่ได้ทำ' : stageStatus[stage.status] || stage.status}
          {stage.status === 'waiting' && stage.waitUntil ? ' ถึง ' + time(stage.waitUntil) : ''}
          {stage.provider && stage.status !== 'waiting' ? ' · ' + providerName(stage.provider) : ''}
          {stage.startedAt && stage.status !== 'pending' ? ' · ' + duration((stage.endedAt || now) - stage.startedAt) : ''}
          {stage.round ? ' · แก้รอบ ' + stage.round : ''}
          {stage.note ? ' · ' + stage.note : ''}</small>
      </div>
    </li>)}
  </ol>;
}

const steps = [
  [ClipboardList, 'วางแผน', 'กำหนดขอบเขต เกณฑ์รับงาน และ API contract'],
  [CodeXml, 'Backend + UX/UI', 'ให้แต่ละ AI ทำงานพร้อมกันใน Git worktree แยก'],
  [FlaskConical, 'รีวิวและทดสอบ', 'ตรวจ diff และผล build กับ test'],
  [RotateCcw, 'ส่งกลับไปแก้', 'ส่งเฉพาะข้อที่ต้องแก้ให้ AI เจ้าของงาน']
];

function SidePanel({ jobs, select }) {
  const active = jobs.find(job => job.status === 'running' || job.status === 'stopping');
  const waiting = jobs.filter(job => job.status === 'queued').length;
  if (active) return <section className="card workflow active-job">
    <h2>กำลังทำงาน</h2>
    <button type="button" className="active-title" onClick={() => select(active.id)}>
      <strong>{active.title}</strong><small>{repoName(active.repo)} · {jobDuration(active)}</small>
    </button>
    <Stepper job={active} compact />
    <div className="active-footer">
      {waiting ? <span className="muted">รอคิวอีก {waiting} งาน</span> : <span />}
      <Button icon={ArrowRight} onClick={() => select(active.id)}>ดูรายละเอียด</Button>
    </div>
  </section>;
  return <section className="card workflow">
    <h2>ขั้นตอนการทำงาน</h2>
    <ol>{steps.map(([Icon, title, detail]) => <li key={title}>
      <span className="step-icon"><Icon size={23} aria-hidden="true" /></span>
      <div><h3>{title}</h3><p>{detail}</p></div>
    </li>)}</ol>
  </section>;
}

function jobProviders(job) {
  return [...new Set(Object.values(job.stages || {}).map(stage => stage.provider).filter(id => providers[id]))];
}

function Queue({ jobs, filter, setFilter, select, create, hasProjects, addProject }) {
  const filters = [['all', 'ทั้งหมด'], ['running', 'กำลังทำ'], ['queued', 'รอเริ่ม'], ['done', 'เสร็จแล้ว'], ['stuck', 'ติดขัด']];
  const match = job => filter === 'all' || (filter === 'running' && (job.status === 'running' || job.status === 'stopping')) ||
    job.status === filter || (filter === 'done' && doneStatuses.has(job.status)) || (filter === 'stuck' && stuckStatuses.has(job.status));
  const items = [...jobs].reverse().filter(match);
  return <section className="card queue">
    <h2>งานในคิว</h2>
    <div className="filters" aria-label="ตัวกรองคิว">{filters.map(([id, label]) =>
      <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>)}</div>
    {items.length ? <ul className="jobs">{items.map(job => <li key={job.id}>
      <button className="job-row" onClick={() => select(job.id)}>
        <span className="job-main">
          <strong>{job.title}</strong>
          <small>{repoName(job.repo)} · สร้าง {dateTime(job.createdAt)}{job.startedAt ? ' · ใช้เวลา ' + jobDuration(job) : ''}</small>
        </span>
        <span className="job-ais">{jobProviders(job).map(id => <span key={id} title={providers[id].name}><ProviderIcon id={id} size={14} /></span>)}</span>
        <span className={'status ' + job.status}>{statusLabels[job.status]}</span><ArrowRight size={17} aria-hidden="true" />
      </button>
    </li>)}</ul> : <div className="empty">
      <span className="terminal"><Terminal size={48} strokeWidth={1.75} aria-hidden="true" /></span>
      <h3>{filter === 'all' ? 'ยังไม่มีงานในคิว' : 'ไม่มีงานในสถานะนี้'}</h3>
      {filter === 'all' ? <><p>{hasProjects ? 'สร้างงานใหม่เพื่อเริ่มให้ AI ดำเนินการ' : 'เริ่มจากเพิ่มโฟลเดอร์งานที่มีอยู่ หรือสร้างงานด้วยพาธของ repo'}</p>
        <div className="action-row center">{hasProjects ? null : <Button icon={FolderPlus} onClick={addProject}>เพิ่มโปรเจกต์</Button>}<Button icon={Plus} primary onClick={create}>สร้างงาน</Button></div></> : null}
    </div>}
  </section>;
}

function RouteTable({ routes, onChange, quotas, label }) {
  return <div className="route-table" aria-label={label}>
    <strong>บทบาท</strong><strong>ตัวหลัก</strong><strong>ตัวสำรอง</strong>
    {Object.entries(roleNames).map(([role, name]) => {
      const duplicate = routes[role][0] === routes[role][1];
      return <React.Fragment key={role}>
        <span>{name}</span>
        {[0, 1].map(index => <select aria-label={name + (index ? ' ตัวสำรอง' : ' ตัวหลัก')} key={index} value={routes[role][index]}
          aria-invalid={index === 1 && duplicate} onChange={event => onChange(role, index, event.target.value)}>
          {index ? <option value="">ไม่มี</option> : null}
          {Object.entries(providers).map(([id, model]) => <option key={id} value={id}>
            {model.name}{quotas && !quotas[id]?.ready ? ' (ยังไม่เชื่อมต่อ)' : ''}</option>)}
        </select>)}
        {duplicate ? <p className="row-warning">ตัวหลักและตัวสำรองซ้ำกัน เลือกตัวสำรองอื่นหรือ "ไม่มี"</p> : null}
      </React.Fragment>;
    })}
  </div>;
}
const updateRoutes = (routes, role, index, value) => ({ ...routes, [role]: routes[role].map((item, i) => i === index ? value : item) });
const hasDuplicate = routes => Object.values(routes).some(route => route[0] === route[1]);

function NewJob({ close, created, previous, jobs, projects, settings, quotas }) {
  const initial = useMemo(() => {
    const draft = previous?.title ? null : readStorage(draftKey);
    const source = previous?.title ? previous : { ...draft, ...(previous?.repo ? { repo: previous.repo } : {}) };
    return { title: source.title || '', repo: source.repo || '', prompt: source.prompt || '', runChecks: Boolean(source.runChecks) };
  }, [previous]);
  const [form, setForm] = useState(initial);
  const [override, setOverride] = useState(Boolean(previous?.settings) && JSON.stringify(previous.settings.routes) !== JSON.stringify(settings.routes));
  const [routes, setRoutes] = useState(structuredClone(previous?.settings?.routes || settings.routes));
  const [repoInfo, setRepoInfo] = useState(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const recentRepos = [...new Set([...jobs].reverse().map(job => job.repo))]
    .filter(repo => !projects.some(project => samePath(project.path, repo))).slice(0, 8);
  const chosenProject = projects.find(project => samePath(project.path, form.repo.trim()));
  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));

  useEffect(() => { if (!previous?.title) writeStorage(draftKey, form); }, [form, previous]);
  useEffect(() => {
    const repo = form.repo.trim();
    if (!repo) { setRepoInfo(null); return; }
    const timer = setTimeout(async () => {
      try { setRepoInfo({ ok: true, ...(await api('/repo/check', 'POST', { repo })) }); }
      catch (error) { setRepoInfo({ ok: false, error: error.message }); }
    }, 450);
    return () => clearTimeout(timer);
  }, [form.repo]);
  useEffect(() => {
    const escape = event => { if (event.key === 'Escape' && !pending) close(); };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [close, pending]);

  async function submit(event) {
    event.preventDefault();
    if (override && hasDuplicate(routes)) { setError('ตัวหลักและตัวสำรองต้องไม่ซ้ำกัน'); return; }
    setPending(true);
    setError('');
    try {
      if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
      const job = await api('/jobs', 'POST', { ...form, routes: override ? routes : undefined, fromJob: previous?.id });
      if (!previous?.title) writeStorage(draftKey, null);
      created(job);
    } catch (error) { setError(error.message); setPending(false); }
  }
  const canReusePlan = previous?.plan && previous.prompt === form.prompt.trim();
  const resumable = previous?.stages?.backend?.status === 'done' && previous?.stages?.frontend?.status === 'done' && (previous.worktree || previous.branchKept);
  return <div className="overlay">
    <form role="dialog" aria-modal="true" aria-labelledby="create-title" className="card dialog" onSubmit={submit}>
      <header><h2 id="create-title">{previous?.title ? 'สร้างงานจากโจทย์เดิม' : 'สร้างงาน'}</h2>
        <button title="ปิด" aria-label="ปิด" className="icon-button" type="button" onClick={close} disabled={pending}><X size={22} /></button>
      </header>
      <label>ชื่องาน<input autoFocus required name="title" maxLength={100} placeholder="เพิ่มระบบจองคิว" value={form.title} onChange={event => set('title', event.target.value)} /></label>
      {projects.length ? <label>โปรเจกต์<select value={chosenProject?.id || ''} onChange={event => {
        const project = projects.find(item => item.id === event.target.value);
        set('repo', project ? project.path : '');
        if (project?.checks?.length) set('runChecks', true);
      }}>
        <option value="">พาธอื่น (พิมพ์เอง)</option>
        {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select></label> : null}
      <label>พาธ Git repo<input required name="repo" maxLength={500} list="recent-repos" placeholder={'D:\\Projects\\my-app'} value={form.repo} onChange={event => set('repo', event.target.value)} /></label>
      <datalist id="recent-repos">{recentRepos.map(repo => <option key={repo} value={repo} />)}</datalist>
      {repoInfo?.ok ? <p className="repo-info"><GitBranch size={15} aria-hidden="true" /> {repoInfo.branch} · <code>{repoInfo.base}</code> {repoInfo.subject}
        {repoInfo.uncommitted ? <span className="warn-text"> · มี {repoInfo.uncommitted} ไฟล์ที่ยังไม่ commit จะไม่ถูกส่งไป</span> : null}</p> :
        repoInfo ? <p className="repo-info bad">{repoInfo.error}</p> :
        <small>แอปส่งไฟล์โค้ดจาก commit HEAD และโจทย์ไปยัง AI ที่เลือกตามการตั้งค่า</small>}
      <label>โจทย์และเกณฑ์รับงาน<textarea required name="prompt" maxLength={promptLimit} rows={6} placeholder="ระบุสิ่งที่ต้องการให้ AI ทำและวิธีตรวจว่าเสร็จแล้ว" value={form.prompt} onChange={event => set('prompt', event.target.value)} /></label>
      <small className={'counter' + (form.prompt.length > promptLimit * 0.9 ? ' warn-text' : '')}>{form.prompt.length.toLocaleString()} / {promptLimit.toLocaleString()} ตัวอักษร{previous?.title ? '' : ' · บันทึกร่างอัตโนมัติ'}</small>
      {canReusePlan ? <p className="repo-info">{resumable ?
        'ทำต่อจากจุดที่ค้างได้ ถ้า repo ยังอยู่ที่ commit เดิม Relay จะใช้แผนและผล Backend / UX/UI เดิม แล้วไปขั้นทดสอบและรีวิวต่อ' :
        'ใช้แผนจากงานเดิมได้ ถ้า repo ยังอยู่ที่ commit เดิม Relay จะข้ามขั้นวางแผนเพื่อประหยัดโควตา'}</p> : null}
      <label className="checkbox"><input type="checkbox" name="runChecks" checked={form.runChecks} onChange={event => set('runChecks', event.target.checked)} />
        {chosenProject?.checks?.length ? 'รันคำสั่งทดสอบของโปรเจกต์ (' + chosenProject.checks.length + ' คำสั่ง) และให้ AI แก้จนผ่าน' : 'รัน npm test และ build ที่มีใน repo นี้ และให้ AI แก้จนผ่าน'}</label>
      <small>เลือกสำหรับ repo ที่คุณไว้วางใจ แอปอาจติดตั้ง dependencies จาก lockfile และรันโค้ดที่เพิ่งแก้บนเครื่อง</small>
      <details className="advanced" open={override} onToggle={event => setOverride(event.currentTarget.open)}>
        <summary>เลือก AI เฉพาะงานนี้</summary>
        <RouteTable routes={routes} quotas={quotas} label="AI สำหรับงานนี้" onChange={(role, index, value) => setRoutes(current => updateRoutes(current, role, index, value))} />
      </details>
      {error ? <p role="alert" className="error">{error}</p> : null}
      <footer><Button disabled={pending} onClick={close}>ยกเลิก</Button><button type="submit" className="button primary" disabled={pending}>{pending ? 'กำลังเพิ่มงาน…' : 'เพิ่มเข้าคิว'}</button></footer>
    </form>
  </div>;
}

function SettingsForm({ initial, changed, quotas, onDirty }) {
  const [draft, setDraft] = useState(initial);
  const [notice, setNotice] = useState(null);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const duplicate = hasDuplicate(draft.routes);
  const setAuto = (key, value) => setDraft(current => ({ ...current, auto: { ...current.auto, [key]: value } }));
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  async function submit(event) {
    event.preventDefault(); setNotice(null); setSaving(true);
    try {
      const saved = await api('/settings', 'PUT', draft);
      changed(saved);
      setDraft(saved);
      setNotice({ text: 'บันทึกการตั้งค่าแล้ว' });
    } catch (error) { setNotice({ text: error.message, error: true }); }
    finally { setSaving(false); }
  }
  return <form className="card settings" onSubmit={submit}>
    <h2>การมอบหมายงาน</h2>
    <p className="muted">Relay ใช้ตัวหลักก่อน ถ้าตัวหลักยังไม่เชื่อมต่อ โควตาต่ำกว่าที่กันไว้ หรือเรียกไม่สำเร็จ จะเปลี่ยนไปใช้ตัวสำรอง</p>
    <RouteTable routes={draft.routes} quotas={quotas} label="การมอบหมายงาน" onChange={(role, index, value) => setDraft(current => ({ ...current, routes: updateRoutes(current.routes, role, index, value) }))} />
    <h2>โควตาและรอบแก้</h2>
    <p className="muted">ในขั้นวางแผน Backend และ UX/UI Relay จะข้าม AI ที่โควตาคงเหลือต่ำกว่าค่านี้ เพื่อเก็บโควตาไว้ใช้ในขั้นรีวิว หลอดโควตาจะมีเส้นบอกระดับนี้</p>
    <div className="settings-grid">
      {Object.entries(providers).map(([id, model]) => <label key={id}>กันโควตา {model.name} (%)<input type="number" required min="0" max="99" value={draft.reserve[id]} onChange={event => setDraft({ ...draft, reserve: { ...draft.reserve, [id]: Number(event.target.value) } })} /></label>)}
      <label>เพดาน Gemini ต่อวัน (0 = ยังไม่ระบุ)<input type="number" required min="0" max="1000000" value={draft.geminiDailyLimit} onChange={event => setDraft({ ...draft, geminiDailyLimit: Number(event.target.value) })} /></label>
      <label>จำนวนรอบแก้สูงสุด<input type="number" required min="0" max="6" value={draft.maxRounds} onChange={event => setDraft({ ...draft, maxRounds: Number(event.target.value) })} /></label>
    </div>
    <h2 className="section-gap">โหมดอัตโนมัติ</h2>
    <p className="muted">สั่งครั้งเดียวแล้วให้ Relay จัดการจนจบ: ลอง AI ตัวอื่นเมื่อทำไม่ได้ รอโควตาแทนการหยุด ลองขั้นที่ล้มใหม่ และส่ง error จากการทดสอบให้ AI แก้จนผ่านหรือครบจำนวนรอบ ผลงานยังอยู่บน branch ให้คุณตรวจก่อน merge เสมอ</p>
    <label className="checkbox"><input type="checkbox" checked={draft.auto.allProviders} onChange={event => setAuto('allProviders', event.target.checked)} />ถ้าตัวหลักและตัวสำรองทำไม่ได้ ให้ลอง AI ตัวอื่นที่เชื่อมต่ออยู่</label>
    <div className="settings-grid">
      <label>รอโควตากลับมาได้นานสุด (นาที, 0 = ไม่รอ)<input type="number" required min="0" max="600" value={draft.auto.waitMinutes} onChange={event => setAuto('waitMinutes', Number(event.target.value))} /></label>
      <label>ลองขั้นที่ล้มใหม่ (ครั้ง)<input type="number" required min="0" max="5" value={draft.auto.retries} onChange={event => setAuto('retries', Number(event.target.value))} /></label>
      <label>เวลาสูงสุดต่องาน (นาที)<input type="number" required min="10" max="1440" value={draft.auto.maxJobMinutes} onChange={event => setAuto('maxJobMinutes', Number(event.target.value))} /></label>
    </div>
    <div className="form-actions"><button className="button primary" type="submit" disabled={saving || !dirty || duplicate}>บันทึกการตั้งค่า</button>
      {dirty ? <Button onClick={() => { setDraft(initial); setNotice(null); }}>ยกเลิกการแก้</Button> : null}
      {notice ? <span role="status" className={notice.error ? 'error' : 'success'}>{notice.text}</span> :
        dirty ? <span role="status" className="warn-text">มีการแก้ที่ยังไม่บันทึก</span> : null}</div>
  </form>;
}

function parseDiff(text) {
  const files = [];
  let current;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      current = { path: match ? match[2] : line.slice(11), lines: [], added: 0, removed: 0, isNew: false };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('new file')) current.isNew = true;
    if (/^(index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line)) continue;
    if (line.startsWith('+')) current.added++;
    else if (line.startsWith('-')) current.removed++;
    current.lines.push(line);
  }
  return files;
}

function DiffView({ diff, focus }) {
  const files = useMemo(() => parseDiff(diff.diff || ''), [diff]);
  const refs = useRef({});
  useEffect(() => {
    if (!focus) return;
    const target = files.find(file => file.path === focus || file.path.endsWith('/' + focus) || focus.endsWith(file.path));
    const element = target && refs.current[target.path];
    if (element) { element.open = true; element.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  }, [focus, files]);
  if (!files.length) return <p className="muted">ยังไม่มีการเปลี่ยนแปลงใน branch</p>;
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);
  return <div className="diff">
    <p className="diff-summary">{files.length} ไฟล์ · <span className="plus">+{added}</span> <span className="minus">−{removed}</span>{diff.truncated ? ' · diff ยาวเกินขนาดที่แสดง' : ''}</p>
    {files.map(file => <details key={file.path} className="diff-file" ref={element => { refs.current[file.path] = element; }} open={files.length <= 3}>
      <summary><code>{file.path}</code>{file.isNew ? <span className="tag">ใหม่</span> : null}<span className="plus">+{file.added}</span><span className="minus">−{file.removed}</span></summary>
      <pre className="diff-lines">{file.lines.map((line, index) => <span key={index} className={line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('@@') ? 'hunk' : ''}>{line + '\n'}</span>)}</pre>
    </details>)}
  </div>;
}

const filePattern = /([\w@.-]+(?:\/[\w@.-]+)*\.[A-Za-z][\w]{0,6})(?::\d+(?:-\d+)?)?/g;
function Finding({ text, openFile }) {
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(filePattern)) {
    if (!match[1].includes('/') && !/\.(?:jsx?|tsx?|css|html|json|md|py|go|rs|vue|svelte|mjs|cjs)$/.test(match[1])) continue;
    parts.push(text.slice(last, match.index));
    parts.push(<button type="button" className="file-link" key={match.index} onClick={() => openFile(match[1])}>{match[0]}</button>);
    last = match.index + match[0].length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}

function CopyButton({ text, children }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch {}
  }
  return <Button icon={copied ? Check : Copy} onClick={copy}>{copied ? 'คัดลอกแล้ว' : children}</Button>;
}

function JobActions({ job, updated, removed, setError }) {
  const [working, setWorking] = useState(false);
  const hasBranch = Boolean(job.worktree || job.branchKept);
  async function run(task) {
    setWorking(true); setError('');
    try { await task(); } catch (error) { setError(error.message); } finally { setWorking(false); }
  }
  const mergeCommand = 'git -C ' + quote(job.repo) + ' merge ' + job.branch;
  return <div className="job-actions">
    <h3>ขั้นต่อไป</h3>
    {hasBranch ? <>
      <p>ตรวจ diff แล้ว merge branch <code>{job.branch}</code> เข้า repo ของคุณ</p>
      <div className="action-row">
        <CopyButton text={job.branch}>คัดลอกชื่อ branch</CopyButton>
        <CopyButton text={mergeCommand}>คัดลอกคำสั่ง merge</CopyButton>
        {job.worktree ? <Button icon={FolderOpen} disabled={working} onClick={() => run(() => api('/jobs/' + job.id + '/open', 'POST'))}>เปิดโฟลเดอร์</Button> : null}
      </div>
    </> : <p>{job.cleanedAt ? 'ล้าง worktree และ branch ของงานนี้แล้ว' : 'งานนี้ไม่มี branch ผลลัพธ์'}</p>}
    <div className="action-row">
      {job.worktree ? <Button icon={Trash} disabled={working} onClick={() => run(async () => {
        if (confirm('ลบโฟลเดอร์ worktree ของงานนี้? branch ' + job.branch + ' ยังอยู่ใน repo')) updated(await api('/jobs/' + job.id + '/cleanup', 'POST', {}));
      })}>ล้าง worktree</Button> : null}
      {hasBranch ? <Button danger icon={GitBranch} disabled={working} onClick={() => run(async () => {
        if (confirm('ลบ branch ' + job.branch + ' ด้วย? ถ้ายังไม่ได้ merge ผลงานจะหายและกู้คืนไม่ได้')) updated(await api('/jobs/' + job.id + '/cleanup', 'POST', { deleteBranch: true }));
      })}>ลบ branch</Button> : null}
      <Button danger icon={Trash} disabled={working} onClick={() => run(async () => {
        if (confirm('ลบงานนี้ออกจากประวัติ? Relay จะล้าง worktree ด้วย แต่ branch ผลลัพธ์ยังอยู่ใน repo')) { await api('/jobs/' + job.id, 'DELETE', {}); removed(job.id); }
      })}>ลบงานนี้</Button>
    </div>
  </div>;
}

function JobDetail({ job, back, retry, updated, removed }) {
  const [tab, setTab] = useState('events');
  const [diff, setDiff] = useState(null);
  const [focus, setFocus] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const busy = busyStatuses.has(job.status);
  const hasResult = Boolean(job.worktree || job.branchKept);
  async function showDiff(file) {
    setTab('diff'); setError(''); setFocus(file || null);
    if (diff && !busy && file) return;
    setLoading(true);
    try { setDiff(await api('/jobs/' + job.id + '/diff')); }
    catch (error) { setError(error.message); }
    finally { setLoading(false); }
  }
  async function cancel() {
    try { updated(await api('/jobs/' + job.id + '/cancel', 'POST')); }
    catch (error) { setError(error.message); }
  }
  const assigned = Object.entries(job.stages || {}).filter(([, stage]) => stage.provider);
  return <>
    <button type="button" className="back" onClick={back}><ChevronLeft size={18} /> กลับไปคิวงาน</button>
    <div className="heading detail-heading"><div><h1>{job.title}</h1>
      <p>{job.repo} · สร้าง {dateTime(job.createdAt)}{job.startedAt ? ' · ใช้เวลา ' + jobDuration(job) : ''}{job.resumedFrom ? ' · ใช้แผนจากงานเดิม' : ''}</p></div>
      <span className={'status ' + job.status}>{statusLabels[job.status]}</span></div>
    <section className="card progress-card"><Stepper job={job} /></section>
    <div className="detail-grid">
      <section className="card detail">
        <div className="filters"><button aria-pressed={tab === 'events'} onClick={() => { setTab('events'); setError(''); }}>ประวัติการทำงาน</button>
          <button aria-pressed={tab === 'diff'} onClick={() => showDiff()} disabled={!hasResult}>Git diff</button></div>
        {error ? <p role="alert" className="error">{error}</p> : null}
        {tab === 'diff' ? loading ? <p>กำลังโหลด diff…</p> : diff ? <DiffView diff={diff} focus={focus} /> : null :
          <ol className="events">{job.events.length ? [...job.events].reverse().map((event, i) => <li key={job.events.length - i}><span>{time(event.at)}</span><div><strong>{event.title}{event.provider ? ' · ' + providerName(event.provider) : ''}</strong><p>{event.detail}</p></div></li>) : <li><p>รอเริ่มงาน</p></li>}</ol>}
      </section>
      <aside className="card detail facts">
        {!busy ? <JobActions job={job} updated={updated} removed={removed} setError={setError} /> : null}
        <h2>รายละเอียดงาน</h2><p className="preline">{job.prompt}</p>
        {job.error ? <p className="error">{job.error}</p> : null}
        {assigned.length ? <><h3>AI ที่รับงาน</h3><ul className="assigned">{assigned.map(([key, stage]) => <li key={key}>{stageNames[key]} · {providerName(stage.provider)}</li>)}</ul></> : null}
        {job.branch && hasResult ? <><h3>Branch ผลลัพธ์</h3><code>{job.branch}</code>{job.worktree ? <small>{job.worktree}</small> : null}</> : null}
        {job.plan ? <><h3>API contract</h3><p className="preline">{job.plan.contract}</p><h3>เกณฑ์รับงาน</h3><p className="preline">{job.plan.acceptance}</p></> : null}
        {job.review ? <><h3>ผลรีวิว</h3><p className="preline">{job.review.summary}</p>
          {job.review.findings.length ? <ul>{job.review.findings.map((item, index) => <li key={index}>{roleNames[item.owner]} · <Finding text={item.detail} openFile={file => hasResult && showDiff(file)} /></li>)}</ul> : null}</> : null}
        {job.checks?.length ? <><h3>ผลทดสอบ</h3>{job.checks.map(check => <details key={check.label}><summary>{check.label} · {check.code === 0 ? 'ผ่าน' : 'ตรวจเพิ่ม'}</summary><pre>{check.output}</pre></details>)}</> : null}
        <div className="action-row">
          {['queued', 'running'].includes(job.status) ? <Button onClick={cancel}>หยุดงาน</Button> : null}
          {!busy && stuckStatuses.has(job.status) && job.plan ? <Button primary icon={RotateCcw} onClick={() => retry(job)}>ทำต่อจากจุดที่ค้าง</Button> : null}
          {!busy ? <Button icon={RotateCcw} onClick={() => retry({ ...job, plan: undefined, id: undefined })}>สร้างงานจากโจทย์นี้</Button> : null}
        </div>
      </aside>
    </div>
  </>;
}

function ChecksEditor({ project, updated }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const checks = project.checks || [];
  async function save() {
    setError('');
    try { updated(await api('/projects/' + project.id, 'PUT', { checks: text.split('\n') })); setEditing(false); }
    catch (error) { setError(error.message); }
  }
  if (!editing) return <div className="checks-list">
    <strong>คำสั่งทดสอบ</strong>{checks.length ? checks.map(command => <code key={command}>{command}</code>) :
      <span> · ยังไม่ได้ตั้ง (ใช้ npm test / build ถ้ามี)</span>}
    <div><button type="button" className="link" onClick={() => { setText(checks.join('\n')); setEditing(true); }}>{checks.length ? 'แก้คำสั่ง' : 'ตั้งคำสั่งทดสอบ'}</button></div>
  </div>;
  return <div className="checks-editor">
    <label>คำสั่งทดสอบ บรรทัดละ 1 คำสั่ง (รันในโฟลเดอร์งาน ถ้า exit code ไม่ใช่ 0 ถือว่าไม่ผ่าน)
      <textarea rows={3} value={text} placeholder={'python -m py_compile webapp/app.py\npython -m pytest -q'} onChange={event => setText(event.target.value)} /></label>
    {error ? <p role="alert" className="error">{error}</p> : null}
    <div className="action-row"><Button primary onClick={save}>บันทึก</Button><Button onClick={() => setEditing(false)}>ยกเลิก</Button></div>
  </div>;
}

function ProjectCard({ project, info, jobs, createJob, removed, select, updated }) {
  const [error, setError] = useState('');
  const projectJobs = jobs.filter(job => samePath(job.repo, project.path));
  const latest = projectJobs.at(-1);
  const running = projectJobs.some(job => busyStatuses.has(job.status));
  async function open() {
    setError('');
    try { await api('/projects/' + project.id + '/open', 'POST'); } catch (error) { setError(error.message); }
  }
  async function remove() {
    if (!confirm('เอา "' + project.name + '" ออกจากรายการ? ไฟล์และ Git repo ในโฟลเดอร์จะไม่ถูกลบ')) return;
    try { await api('/projects/' + project.id, 'DELETE', {}); removed(project.id); } catch (error) { setError(error.message); }
  }
  return <article className="card project">
    <header className="project-head">
      <span className="provider-icon project-icon"><FolderGit2 size={24} aria-hidden="true" /></span>
      <div><h2>{project.name}</h2><p>{project.path}</p></div>
    </header>
    {info?.ok ? <p className="repo-info"><GitBranch size={15} aria-hidden="true" /> {info.branch} · <code>{info.base}</code> {info.subject}
      {info.uncommitted ? <span className="warn-text"> · ยังไม่ commit {info.uncommitted} ไฟล์</span> : null}</p> :
      info ? <p className="repo-info bad">{info.error}</p> : <p className="muted">กำลังตรวจ repo…</p>}
    <p className="project-jobs">{projectJobs.length ? <>
      งานทั้งหมด {projectJobs.length} · ล่าสุด <button type="button" className="link" onClick={() => select(latest.id)}>{latest.title}</button>
      <span className={'status ' + latest.status}>{statusLabels[latest.status]}</span></> : 'ยังไม่มีงานในโปรเจกต์นี้'}</p>
    <ChecksEditor project={project} updated={updated} />
    {error ? <p role="alert" className="error">{error}</p> : null}
    <div className="action-row">
      <Button primary icon={Plus} onClick={() => createJob(project.path)} disabled={info && !info.ok}>สร้างงาน</Button>
      <Button icon={FolderOpen} onClick={open}>เปิดโฟลเดอร์</Button>
      <Button danger icon={Trash} onClick={remove} disabled={running} title={running ? 'มีงานที่กำลังทำอยู่' : undefined}>เอาออก</Button>
    </div>
  </article>;
}

function ProjectsPage({ projects, jobs, createJob, added, removed, select }) {
  const [folder, setFolder] = useState('');
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [needsInit, setNeedsInit] = useState(null);
  const [statuses, setStatuses] = useState({});
  const ids = projects.map(project => project.id + project.path).join('|');
  async function loadStatuses() {
    const entries = await Promise.all(projects.map(async project => {
      try { return [project.id, { ok: true, ...(await api('/repo/check', 'POST', { repo: project.path })) }]; }
      catch (error) { return [project.id, { ok: false, error: error.message }]; }
    }));
    setStatuses(Object.fromEntries(entries));
  }
  useEffect(() => { void loadStatuses(); }, [ids]);
  async function pick() {
    setPicking(true); setError('');
    try { const { path } = await api('/projects/pick', 'POST'); if (path) { setFolder(path); setNeedsInit(null); } }
    catch (error) { setError(error.message); }
    finally { setPicking(false); }
  }
  async function add(event) {
    event.preventDefault();
    setPending(true); setError(''); setNotice(''); setNeedsInit(null);
    try {
      const project = await api('/projects', 'POST', { path: folder, name });
      added(project);
      setNotice('เพิ่ม "' + project.name + '" แล้ว' + (samePath(project.path, folder) ? '' : ' (ใช้ root ของ repo: ' + project.path + ')'));
      setFolder(''); setName('');
    } catch (error) {
      if (error.data?.needsInit) setNeedsInit(error.data); else setError(error.message);
    } finally { setPending(false); }
  }
  async function useParent() {
    setPending(true); setError('');
    try {
      const project = await api('/projects', 'POST', { path: needsInit.folder, name, useParent: true });
      added(project);
      setNotice('เพิ่ม "' + project.name + '" แล้ว (ใช้ repo ที่ ' + project.path + ')');
      setNeedsInit(null); setFolder(''); setName('');
    } catch (error) { setError(error.message); }
    finally { setPending(false); }
  }
  async function init() {
    setPending(true); setError('');
    try {
      const project = await api('/projects/init', 'POST', { path: needsInit.folder, name });
      added(project);
      setNotice('สร้าง Git repo และ commit แรก ' + project.committed + ' ไฟล์แล้ว' + (project.createdIgnore ? ' พร้อมไฟล์ .gitignore' : '') + ' · เพิ่ม "' + project.name + '" แล้ว');
      setNeedsInit(null); setFolder(''); setName('');
    } catch (error) { setError(error.message); }
    finally { setPending(false); }
  }
  return <>
    <div className="heading"><h1>โปรเจกต์</h1><p>บันทึกโฟลเดอร์งานที่ใช้บ่อย แล้วสร้างงานจากโปรเจกต์ได้ทันที</p></div>
    <form className="card add-project" onSubmit={add}>
      <h2>เพิ่มโปรเจกต์</h2>
      <div className="add-row">
        <label>โฟลเดอร์ของโปรเจกต์<input required value={folder} maxLength={500} placeholder={'D:\\Projects\\my-app'} onChange={event => { setFolder(event.target.value); setNeedsInit(null); }} /></label>
        <Button icon={FolderOpen} onClick={pick} disabled={picking || pending}>{picking ? 'รอเลือกโฟลเดอร์…' : 'เลือกโฟลเดอร์'}</Button>
      </div>
      <label>ชื่อที่แสดง (ไม่ใส่ก็ได้)<input value={name} maxLength={80} placeholder="ใช้ชื่อโฟลเดอร์" onChange={event => setName(event.target.value)} /></label>
      {picking ? <p className="muted">หน้าต่างเลือกโฟลเดอร์ของ Windows เปิดอยู่ ถ้าไม่เห็น ให้ดูที่แถบงาน</p> : null}
      {needsInit ? <div className="init-panel" role="alert">
        <strong>{needsInit.error}</strong>
        {needsInit.kind === 'parent' ? <p>{needsInit.parentUsable ?
          'เลือกได้ว่าจะใช้ repo ที่ใหญ่กว่านั้นทั้งก้อน หรือสร้าง Git repo แยกเฉพาะโฟลเดอร์นี้' :
          'repo นั้นเป็นโฟลเดอร์ผู้ใช้หรือ root ของไดรฟ์ Relay จะไม่ใช้ repo นั้น ให้สร้าง Git repo แยกเฉพาะโฟลเดอร์นี้แทน'}</p> : null}
        <p>Relay ต้องใช้ Git repo ที่มี commit อย่างน้อย 1 ครั้ง ปุ่มสร้างจะ{needsInit.kind === 'empty' ? '' : 'สร้าง Git repo ในโฟลเดอร์นี้ แล้ว '}commit ไฟล์ทั้งหมดในโฟลเดอร์ ({needsInit.entries} รายการที่ระดับบนสุด) เป็น commit แรก</p>
        <p>{needsInit.hasGitignore ? 'ไฟล์ที่อยู่ใน .gitignore จะไม่ถูก commit' : 'โฟลเดอร์นี้ยังไม่มี .gitignore Relay จะสร้างให้ เพื่อไม่ให้ commit node_modules, dist และไฟล์ลับอย่าง .env หรือ *.key'}</p>
        <div className="action-row"><Button primary icon={FolderPlus} onClick={init} disabled={pending}>{needsInit.kind === 'empty' ? 'สร้าง commit แรก' : 'สร้าง Git repo และ commit แรก'}</Button>
          {needsInit.parentUsable ? <Button icon={GitBranch} onClick={useParent} disabled={pending}>ใช้ repo ที่ใหญ่กว่า</Button> : null}
          <Button onClick={() => setNeedsInit(null)} disabled={pending}>ยกเลิก</Button></div>
      </div> : null}
      {error ? <p role="alert" className="error">{error}</p> : null}
      {notice ? <p role="status" className="success">{notice}</p> : null}
      <div className="form-actions"><button type="submit" className="button primary" disabled={pending || !folder.trim()}><FolderPlus size={18} aria-hidden="true" />เพิ่มโปรเจกต์</button></div>
    </form>
    {projects.length ? <>
      <div className="section-head"><h2>โปรเจกต์ของคุณ ({projects.length})</h2><Button icon={RefreshCw} onClick={loadStatuses}>ตรวจสถานะใหม่</Button></div>
      <div className="projects">{projects.map(project => <ProjectCard key={project.id} project={project} info={statuses[project.id]} jobs={jobs} createJob={createJob} removed={removed} select={select} updated={added} />)}</div>
    </> : <section className="card empty">
      <span className="terminal"><FolderGit2 size={48} strokeWidth={1.75} aria-hidden="true" /></span>
      <h3>ยังไม่มีโปรเจกต์</h3><p>เพิ่มโฟลเดอร์งานที่มีอยู่แล้วด้านบน เพื่อให้ AI เข้าไปทำงานต่อได้</p>
    </section>}
  </>;
}

function useJobAlerts(jobs) {
  const previous = useRef(null);
  const [unseen, setUnseen] = useState(0);
  useEffect(() => {
    if (!jobs) return;
    const statuses = Object.fromEntries(jobs.map(job => [job.id, job.status]));
    if (previous.current) {
      for (const job of jobs) {
        const before = previous.current[job.id];
        if (before && busyStatuses.has(before) && !busyStatuses.has(job.status)) {
          if (document.hidden) setUnseen(count => count + 1);
          if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
            try { new Notification('Relay · ' + statusLabels[job.status], { body: job.title, icon: '/relay.svg' }); } catch {}
          }
        }
      }
    }
    previous.current = statuses;
  }, [jobs]);
  useEffect(() => {
    const seen = () => { if (!document.hidden) setUnseen(0); };
    document.addEventListener('visibilitychange', seen);
    window.addEventListener('focus', seen);
    return () => { document.removeEventListener('visibilitychange', seen); window.removeEventListener('focus', seen); };
  }, []);
  const running = jobs?.filter(job => job.status === 'running' || job.status === 'stopping').length || 0;
  useEffect(() => {
    document.title = (unseen ? '(✓ ' + unseen + ') ' : running ? '(⏳) ' : '') + 'Relay';
  }, [unseen, running]);
}

function App() {
  const [data, setData] = useState(null);
  const [networkError, setNetworkError] = useState('');
  const [page, setPage] = useState('queue');
  const [selection, setSelection] = useState(null);
  const [filter, setFilter] = useState('all');
  const [dialog, setDialog] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [settingsDirty, setSettingsDirty] = useState(false);
  useEffect(() => {
    let disposed = false;
    let timer;
    async function poll() {
      try {
        const next = await api('/state');
        if (!disposed) { setData(next); setNetworkError(''); }
      } catch (error) { if (!disposed) setNetworkError(error.message); }
      if (!disposed) timer = window.setTimeout(poll, 2200);
    }
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, []);
  useEffect(() => {
    if (!settingsDirty) return;
    const warn = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [settingsDirty]);
  useJobAlerts(data?.jobs);
  const leaveSettings = () => !settingsDirty || confirm('ออกจากหน้าตั้งค่าโดยไม่บันทึก?');
  function open(next) { if (next !== page && !leaveSettings()) return; setPage(next); setSelection(null); }
  function select(id) { if (!leaveSettings()) return; setPage('queue'); setSelection(id); }
  function updateJob(job) {
    setData(previous => ({ ...previous, jobs: [...previous.jobs.filter(item => item.id !== job.id), job].sort((a, b) => a.createdAt - b.createdAt) }));
  }
  function removeJob(id) {
    setData(previous => ({ ...previous, jobs: previous.jobs.filter(item => item.id !== id) }));
    setSelection(null);
  }
  async function refresh() {
    setRefreshing(true);
    try {
      const quotas = await api('/quota/refresh', 'POST');
      setData(previous => previous ? { ...previous, quotas } : previous);
    } catch (error) { setNetworkError(error.message); }
    finally { setRefreshing(false); }
  }
  const jobs = data?.jobs ?? [];
  const projects = data?.projects ?? [];
  const addProject = project => setData(previous => ({ ...previous, projects: [...previous.projects.filter(item => item.id !== project.id), project] }));
  const removeProject = id => setData(previous => ({ ...previous, projects: previous.projects.filter(item => item.id !== id) }));
  const job = jobs.find(item => item.id === selection);
  const runningCount = jobs.filter(item => item.status === 'running' || item.status === 'stopping').length;
  const queuedCount = jobs.filter(item => item.status === 'queued').length;
  const reserve = data?.settings.reserve ?? {};
  const cards = detailed => <div className="providers">{Object.keys(providers).map(id => <ProviderCard id={id} key={id} info={data?.quotas[id]} detailed={detailed} reserve={reserve[id] ?? 0} />)}</div>;
  return <div className="shell">
    <aside className="sidebar">
      <button className="brand" onClick={() => open('queue')}><img src="/relay.svg" alt="" width="42" height="42" />Relay</button>
      <nav aria-label="เมนูหลัก">{pages.map(([id, label, Icon]) => <button key={id} type="button" aria-current={page === id ? 'page' : undefined} onClick={() => open(id)}><Icon size={22} aria-hidden="true" /><span>{label}</span></button>)}</nav>
      <footer><span className={data && !networkError ? 'live' : ''} /><div>Local Server · {networkError ? 'ออฟไลน์' : data ? 'พร้อมใช้งาน' : 'กำลังเชื่อมต่อ'}<small>{location.host}</small></div></footer>
    </aside>
    <div className="workspace">
      <header className="topbar"><div className="topbar-status" role="status">
        {runningCount ? <span className="pulse" aria-hidden="true" /> : null}
        {runningCount ? 'กำลังทำ ' + runningCount + ' งาน' : 'ไม่มีงานที่กำลังทำ'}{queuedCount ? ' · รอ ' + queuedCount : ''}</div>
        <div className="actions"><Button icon={RefreshCw} onClick={refresh} disabled={refreshing}>{refreshing ? 'กำลังรีเฟรช' : 'รีเฟรชโควตา'}</Button><Button primary icon={Plus} onClick={() => setDialog({})} disabled={!data}>สร้างงาน</Button></div>
      </header>
      <main>
        {networkError ? <p className="error banner" role="alert">{networkError}</p> : null}
        {job ? <JobDetail key={job.id} job={job} back={() => setSelection(null)} retry={setDialog} updated={updateJob} removed={removeJob} /> :
          page === 'settings' ? <><div className="heading"><h1>ตั้งค่า</h1><p>เลือก AI ที่จะรับผิดชอบแต่ละขั้น</p></div>
            {data ? <SettingsForm initial={data.settings} quotas={data.quotas} onDirty={setSettingsDirty} changed={settings => setData(previous => ({ ...previous, settings }))} /> : null}</> :
          page === 'projects' ? <ProjectsPage projects={projects} jobs={jobs} createJob={repo => setDialog({ repo })} added={addProject} removed={removeProject} select={select} /> :
          page === 'quota' ? <><div className="heading"><h1>โควตา AI</h1><p>ดูโควตาคงเหลือ เวลารีเซ็ต และระดับที่กันไว้ของแต่ละผู้ให้บริการ</p></div>{cards(true)}</> :
          <>
            <div className="heading"><h1>คิวงาน AI</h1><p>สั่งงาน ติดตามผล และจัดสรรโควตาจากที่เดียว</p></div>
            {cards(false)}
            <div className="dashboard-grid"><Queue jobs={jobs} filter={filter} setFilter={setFilter} select={select} create={() => setDialog({})} hasProjects={projects.length > 0} addProject={() => open('projects')} /><SidePanel jobs={jobs} select={select} /></div>
          </>}
      </main>
    </div>
    {dialog ? <NewJob previous={dialog} jobs={jobs} projects={projects} settings={data.settings} quotas={data.quotas} close={() => setDialog(null)} created={created => {
      updateJob(created); setPage('queue'); setSelection(created.id); setDialog(null);
    }} /> : null}
  </div>;
}

createRoot(document.getElementById('root')).render(<App />);
