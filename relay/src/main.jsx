import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/noto-sans-thai';
import {
  ArrowRight, ChartPie, ChevronLeft, ClipboardList, CodeXml, FlaskConical,
  Layers, Plus, RefreshCw, RotateCcw, Settings, Sparkle, Terminal, X
} from 'lucide-react';
import './style.css';

const providers = {
  claudecode: { name: 'Claude Code', company: 'Anthropic', icon: Terminal },
  gemini: { name: 'Gemini', company: 'Google', icon: Sparkle },
  codex: { name: 'Codex', company: 'OpenAI', icon: CodeXml }
};
const pages = [
  ['queue', 'คิวงาน', Layers], ['quota', 'โควตา AI', ChartPie], ['settings', 'ตั้งค่า', Settings]
];
const statusLabels = {
  queued: 'รอเริ่ม', running: 'กำลังดำเนินการ', stopping: 'กำลังหยุด', complete: 'พร้อมตรวจผล',
  needs_review: 'ต้องตรวจเพิ่ม', failed: 'งานติดขัด', cancelled: 'หยุดแล้ว', interrupted: 'ถูกขัดจังหวะ'
};
const roleNames = { plan: 'วางแผน', backend: 'Backend', frontend: 'UX/UI', review: 'รีวิว' };
const busyStatuses = new Set(['queued', 'running', 'stopping']);
const clock = new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' });
const calendar = new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' });
const time = date => clock.format(date);
const dateTime = date => calendar.format(date);

async function api(url, method = 'GET', body) {
  const response = await fetch('/api' + url, method === 'GET' ? {} : {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {})
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || 'เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ');
  return result;
}

function Button({ children, icon: Icon, primary, ...props }) {
  return <button type="button" className={primary ? 'button primary' : 'button'} {...props}>
    {Icon ? <Icon aria-hidden="true" size={19} /> : null}{children}
  </button>;
}

function ProviderCard({ id, info, detailed }) {
  const model = providers[id];
  const Icon = model.icon;
  const windows = info?.windows ?? [];
  const now = Date.now();
  const fresh = info?.ready && (id === 'gemini' || (info.updatedAt && now - info.updatedAt < 300_000));
  const currentWindows = windows.filter(window => !window.resetAt || window.resetAt > now);
  const ordered = [...currentWindows].sort((a, b) => a.remaining - b.remaining);
  const display = detailed ? windows : ordered.slice(0, 1);
  return <article className="provider card">
    <header className="provider-head">
      <span className={'provider-icon ' + id}><Icon size={27} aria-hidden="true" /></span>
      <div><h2>{model.name}</h2><p>{model.company}</p></div>
      <span className={'connection ' + (info?.ready ? 'connected' : '')}>{info?.ready ? 'เชื่อมต่อแล้ว' : 'รอเชื่อมต่อ'}</span>
    </header>
    {display.length ? display.map(window => {
      const current = fresh && (!window.resetAt || window.resetAt > Date.now());
      return <div className="quota-window" key={window.label}>
        <div className="quota-label">{detailed ? window.label : 'โควตาคงเหลือ'}</div>
        <div className="bar-row">
          <div className="bar" role="meter" aria-label={window.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={current ? window.remaining : undefined}>
            {current ? <span className={id} style={{ width: window.remaining + '%' }} /> : null}
          </div>
          <strong>{current ? Math.round(window.remaining) + '%' : '–'}</strong>
        </div>
        {detailed && window.resetAt ? <small>รีเซ็ต {dateTime(window.resetAt)}</small> : null}
      </div>;
    }) : <div className="quota-window"><div className="quota-label">โควตาคงเหลือ</div><div className="bar-row"><div className="bar" /><strong>–</strong></div></div>}
    <p className="quota-note">{info?.cooldownUntil > now ? 'พักถึง ' + time(info.cooldownUntil) :
      currentWindows.length && fresh ? (info.source === 'estimate' ? 'ประมาณการจาก Relay' : 'ข้อมูลจากผู้ให้บริการ') + ' · ' + time(info.updatedAt) :
      info?.note || 'ยังไม่มีข้อมูลโควตาล่าสุด'}</p>
    {detailed ? <p className="mode">{info?.mode}{info?.updatedAt ? ' · อัปเดต ' + dateTime(info.updatedAt) : ''}</p> : null}
  </article>;
}

const steps = [
  [ClipboardList, 'วางแผน', 'กำหนดขอบเขต เกณฑ์รับงาน และ API contract'],
  [CodeXml, 'Backend + UX/UI', 'ให้แต่ละ AI ทำงานพร้อมกันใน Git worktree แยก'],
  [FlaskConical, 'รีวิวและทดสอบ', 'ตรวจ diff และผล build กับ test'],
  [RotateCcw, 'ส่งกลับไปแก้', 'ส่งเฉพาะข้อที่ต้องแก้ให้ AI เจ้าของงาน']
];

function Workflow() {
  return <section className="card workflow">
    <h2>ขั้นตอนการทำงาน</h2>
    <ol>{steps.map(([Icon, title, detail]) => <li key={title}>
      <span className="step-icon"><Icon size={23} aria-hidden="true" /></span>
      <div><h3>{title}</h3><p>{detail}</p></div>
    </li>)}</ol>
  </section>;
}

function Queue({ jobs, filter, setFilter, select, create }) {
  const filters = [['all', 'ทั้งหมด'], ['running', 'กำลังดำเนินการ'], ['queued', 'รอเริ่ม']];
  const items = [...jobs].reverse().filter(job => filter === 'all' || job.status === filter || (filter === 'running' && job.status === 'stopping'));
  return <section className="card queue">
    <h2>งานในคิว</h2>
    <div className="filters" aria-label="ตัวกรองคิว">{filters.map(([id, label]) =>
      <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>)}</div>
    {items.length ? <ul className="jobs">{items.map(job => <li key={job.id}>
      <button className="job-row" onClick={() => select(job.id)}>
        <span><strong>{job.title}</strong><small>{job.repo}</small></span>
        <span className={'status ' + job.status}>{statusLabels[job.status]}</span><ArrowRight size={17} aria-hidden="true" />
      </button>
    </li>)}</ul> : <div className="empty">
      <span className="terminal"><Terminal size={48} strokeWidth={1.75} aria-hidden="true" /></span>
      <h3>{filter === 'all' ? 'ยังไม่มีงานในคิว' : 'ไม่มีงานในสถานะนี้'}</h3>
      {filter === 'all' ? <><p>สร้างงานใหม่เพื่อเริ่มให้ AI ดำเนินการ</p><Button icon={Plus} primary onClick={create}>สร้างงาน</Button></> : null}
    </div>}
  </section>;
}

function NewJob({ close, created, previous }) {
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  async function submit(event) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    setPending(true);
    setError('');
    try {
      const job = await api('/jobs', 'POST', { ...Object.fromEntries(fields), runChecks: fields.has('runChecks') });
      created(job);
    } catch (error) { setError(error.message); setPending(false); }
  }
  useEffect(() => {
    const escape = event => { if (event.key === 'Escape' && !pending) close(); };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [close, pending]);
  return <div className="overlay">
    <form role="dialog" aria-modal="true" aria-labelledby="create-title" className="card dialog" onSubmit={submit}>
      <header><h2 id="create-title">สร้างงาน</h2>
        <button title="ปิด" aria-label="ปิด" className="icon-button" type="button" onClick={close} disabled={pending}><X size={22} /></button>
      </header>
      <label>ชื่องาน<input autoFocus required name="title" maxLength={100} placeholder="เพิ่มระบบจองคิว" defaultValue={previous?.title} /></label>
      <label>พาธ Git repo<input required name="repo" maxLength={500} placeholder={'D:\\Projects\\my-app'} defaultValue={previous?.repo} /></label>
      <small>แอปส่งไฟล์โค้ดจาก commit HEAD และโจทย์ไปยัง AI ที่เลือกตามการตั้งค่า</small>
      <label>โจทย์และเกณฑ์รับงาน<textarea required name="prompt" maxLength={8000} rows={5} placeholder="ระบุสิ่งที่ต้องการให้ AI ทำและวิธีตรวจว่าเสร็จแล้ว" defaultValue={previous?.prompt} /></label>
      <label className="checkbox"><input type="checkbox" name="runChecks" defaultChecked={previous?.runChecks} />รัน npm test และ build ที่มีใน repo นี้</label>
      <small>เลือกสำหรับ repo ที่คุณไว้วางใจ แอปอาจติดตั้ง dependencies จาก lockfile และรันโค้ดที่เพิ่งแก้บนเครื่อง</small>
      {error ? <p role="alert" className="error">{error}</p> : null}
      <footer><Button disabled={pending} onClick={close}>ยกเลิก</Button><button type="submit" className="button primary" disabled={pending}>{pending ? 'กำลังเพิ่มงาน…' : 'เพิ่มเข้าคิว'}</button></footer>
    </form>
  </div>;
}

function SettingsForm({ initial, changed }) {
  const [draft, setDraft] = useState(initial);
  const [notice, setNotice] = useState(null);
  const [saving, setSaving] = useState(false);
  function updateRoute(role, index, value) {
    setDraft(previous => ({ ...previous, routes: { ...previous.routes, [role]: previous.routes[role].map((item, i) => i === index ? value : item) } }));
  }
  async function submit(event) {
    event.preventDefault(); setNotice(null); setSaving(true);
    try {
      const saved = await api('/settings', 'PUT', draft);
      changed(saved);
      setNotice({ text: 'บันทึกการตั้งค่าแล้ว' });
    } catch (error) { setNotice({ text: error.message, error: true }); }
    finally { setSaving(false); }
  }
  return <form className="card settings" onSubmit={submit}>
    <h2>การมอบหมายงาน</h2>
    <div className="route-table">
      <strong>บทบาท</strong><strong>ตัวหลัก</strong><strong>ตัวสำรอง</strong>
      {Object.entries(roleNames).map(([role, label]) => <React.Fragment key={role}>
        <span>{label}</span>
        {[0, 1].map(index => <select aria-label={label + (index ? ' ตัวสำรอง' : ' ตัวหลัก')} key={index} value={draft.routes[role][index]} onChange={event => updateRoute(role, index, event.target.value)}>
          {index ? <option value="">ไม่มี</option> : null}
          {Object.entries(providers).map(([id, model]) => <option key={id} value={id}>{model.name}</option>)}
        </select>)}
      </React.Fragment>)}
    </div>
    <h2>โควตาและรอบแก้</h2>
    <p className="muted">แอปใช้เปอร์เซ็นต์ที่กันไว้เพื่อสงวนโควตาสำหรับขั้นรีวิว</p>
    <div className="settings-grid">
      {Object.entries(providers).map(([id, model]) => <label key={id}>กันโควตา {model.name} (%)<input type="number" required min="0" max="99" value={draft.reserve[id]} onChange={event => setDraft({ ...draft, reserve: { ...draft.reserve, [id]: Number(event.target.value) } })} /></label>)}
      <label>เพดาน Gemini ต่อวัน (0 = ยังไม่ระบุ)<input type="number" required min="0" max="1000000" value={draft.geminiDailyLimit} onChange={event => setDraft({ ...draft, geminiDailyLimit: Number(event.target.value) })} /></label>
      <label>จำนวนรอบแก้สูงสุด<input type="number" required min="0" max="4" value={draft.maxRounds} onChange={event => setDraft({ ...draft, maxRounds: Number(event.target.value) })} /></label>
    </div>
    <div className="form-actions"><button className="button primary" type="submit" disabled={saving}>บันทึกการตั้งค่า</button>
      {notice ? <span role="status" className={notice.error ? 'error' : 'success'}>{notice.text}</span> : null}</div>
  </form>;
}

function JobDetail({ job, back, retry, updated }) {
  const [tab, setTab] = useState('events');
  const [diff, setDiff] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  async function showDiff() {
    setTab('diff'); setError(''); setLoading(true);
    try { setDiff(await api('/jobs/' + job.id + '/diff')); }
    catch (error) { setError(error.message); }
    finally { setLoading(false); }
  }
  async function cancel() {
    try { updated(await api('/jobs/' + job.id + '/cancel', 'POST')); }
    catch (error) { setError(error.message); }
  }
  return <>
    <button type="button" className="back" onClick={back}><ChevronLeft size={18} /> กลับไปคิวงาน</button>
    <div className="heading detail-heading"><div><h1>{job.title}</h1><p>{job.repo}</p></div><span className={'status ' + job.status}>{statusLabels[job.status]}</span></div>
    <div className="detail-grid">
      <section className="card detail">
        <div className="filters"><button aria-pressed={tab === 'events'} onClick={() => { setTab('events'); setError(''); }}>ประวัติการทำงาน</button>
          <button aria-pressed={tab === 'diff'} onClick={showDiff} disabled={!job.worktree}>Git diff</button></div>
        {error ? <p role="alert" className="error">{error}</p> : null}
        {tab === 'diff' ? <>{loading ? <p>กำลังโหลด diff…</p> : <pre>{diff?.diff || 'ยังไม่มีการเปลี่ยนแปลงใน branch'}{diff?.truncated ? '\n… Diff ยาวเกินขนาดที่แสดง' : ''}</pre>}</> :
          <ol className="events">{job.events.length ? [...job.events].reverse().map((event, i) => <li key={job.events.length - i}><span>{time(event.at)}</span><div><strong>{event.title}</strong><p>{event.detail}</p></div></li>) : <li><p>รอเริ่มงาน</p></li>}</ol>}
      </section>
      <aside className="card detail facts">
        <h2>รายละเอียดงาน</h2><p className="preline">{job.prompt}</p>
        {job.error ? <p className="error">{job.error}</p> : null}
        {job.worktree ? <><h3>Branch ผลลัพธ์</h3><code>{job.branch}</code><small>{job.worktree}</small></> : null}
        {job.plan ? <><h3>API contract</h3><p className="preline">{job.plan.contract}</p><h3>เกณฑ์รับงาน</h3><p className="preline">{job.plan.acceptance}</p></> : null}
        {job.review ? <><h3>ผลรีวิว</h3><p className="preline">{job.review.summary}</p>
          {job.review.findings.length ? <ul>{job.review.findings.map((item, index) => <li key={index}>{roleNames[item.owner]} · {item.detail}</li>)}</ul> : null}</> : null}
        {job.checks?.length ? <><h3>ผลทดสอบ</h3>{job.checks.map(check => <details key={check.label}><summary>{check.label} · {check.code === 0 ? 'ผ่าน' : 'ตรวจเพิ่ม'}</summary><pre>{check.output}</pre></details>)}</> : null}
        {['queued', 'running'].includes(job.status) ? <Button onClick={cancel}>หยุดงาน</Button> : !busyStatuses.has(job.status) ? <Button icon={RotateCcw} onClick={() => retry(job)}>สร้างงานจากโจทย์นี้</Button> : null}
      </aside>
    </div>
  </>;
}

function App() {
  const [data, setData] = useState(null);
  const [networkError, setNetworkError] = useState('');
  const [page, setPage] = useState('queue');
  const [selection, setSelection] = useState(null);
  const [filter, setFilter] = useState('all');
  const [dialog, setDialog] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
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
  function open(next) { setPage(next); setSelection(null); }
  function updateJob(job) {
    setData(previous => ({ ...previous, jobs: [...previous.jobs.filter(item => item.id !== job.id), job].sort((a, b) => a.createdAt - b.createdAt) }));
  }
  async function refresh() {
    setRefreshing(true);
    try {
      const quotas = await api('/quota/refresh', 'POST');
      setData(previous => previous ? { ...previous, quotas } : previous);
    } catch (error) { setNetworkError(error.message); }
    finally { setRefreshing(false); }
  }
  const job = data?.jobs.find(item => item.id === selection);
  const pageLabel = pages.find(entry => entry[0] === page)[1];
  return <div className="shell">
    <aside className="sidebar">
      <button className="brand" onClick={() => open('queue')}><img src="/relay.svg" alt="" width="42" height="42" />Relay</button>
      <nav aria-label="เมนูหลัก">{pages.map(([id, label, Icon]) => <button key={id} type="button" aria-current={page === id ? 'page' : undefined} onClick={() => open(id)}><Icon size={22} aria-hidden="true" /><span>{label}</span></button>)}</nav>
      <footer><span className={data && !networkError ? 'live' : ''} /><div>Local Server · {networkError ? 'ออฟไลน์' : data ? 'พร้อมใช้งาน' : 'กำลังเชื่อมต่อ'}<small>{location.host}</small></div></footer>
    </aside>
    <div className="workspace">
      <header className="topbar"><div className="breadcrumb">Workspace <span>/</span> <strong>{pageLabel}</strong></div>
        <div className="actions"><Button icon={RefreshCw} onClick={refresh} disabled={refreshing}>{refreshing ? 'กำลังรีเฟรช' : 'รีเฟรชโควตา'}</Button><Button primary icon={Plus} onClick={() => setDialog({})} disabled={!data}>สร้างงาน</Button></div>
      </header>
      <main>
        {networkError ? <p className="error banner" role="alert">{networkError}</p> : null}
        {job ? <JobDetail key={job.id} job={job} back={() => setSelection(null)} retry={setDialog} updated={updateJob} /> :
          page === 'settings' ? <><div className="heading"><h1>ตั้งค่า</h1><p>เลือก AI ที่จะรับผิดชอบแต่ละขั้น</p></div>
            {data ? <SettingsForm initial={data.settings} changed={settings => setData(previous => ({ ...previous, settings }))} /> : null}</> :
          <>
            <div className="heading"><h1>{page === 'queue' ? 'คิวงาน AI' : 'โควตา AI'}</h1>
              <p>{page === 'queue' ? 'สั่งงาน ติดตามผล และจัดสรรโควตาจากที่เดียว' : 'ดูโควตาคงเหลือและเวลารีเซ็ตของแต่ละผู้ให้บริการ'}</p></div>
            <div className="providers">{Object.keys(providers).map(id => <ProviderCard id={id} key={id} info={data?.quotas[id]} detailed={page === 'quota'} />)}</div>
            {page === 'queue' ? <div className="dashboard-grid"><Queue jobs={data?.jobs ?? []} filter={filter} setFilter={setFilter} select={setSelection} create={() => setDialog({})} /><Workflow /></div> : null}
          </>}
      </main>
    </div>
    {dialog ? <NewJob previous={dialog} close={() => setDialog(null)} created={created => {
      updateJob(created); setPage('queue'); setSelection(created.id); setDialog(null);
    }} /> : null}
  </div>;
}

createRoot(document.getElementById('root')).render(<App />);
