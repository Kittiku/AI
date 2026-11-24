import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, CircleCheck, Clock, Coins, RefreshCw, TriangleExclamationPoint } from 'lucide-react';

// AI usage statistics: which AI and which model did what kind of work, how often, how fast and at what cost.
// Charts are plain HTML so they share the app's fonts and tokens; every number is also in a table.

const ORDER = ['claudecode', 'gemini', 'codex']; // fixed series order: colour follows the AI, never its rank
const RANGES = [[7, '7 วัน'], [30, '30 วัน'], [90, '90 วัน']];
const taskNames = {
  plan: 'วางแผน', review: 'รีวิว', check_subtask: 'หัวหน้าตรวจงานย่อย',
  'backend.implement': 'Backend · ลงมือทำ', 'frontend.implement': 'Frontend · ลงมือทำ',
  'backend.subtask': 'Backend · งานย่อย', 'frontend.subtask': 'Frontend · งานย่อย',
  'backend.fix_subtask': 'Backend · แก้งานย่อย', 'frontend.fix_subtask': 'Frontend · แก้งานย่อย',
  'backend.fix_review': 'Backend · แก้ตามรีวิว', 'frontend.fix_review': 'Frontend · แก้ตามรีวิว',
  backend: 'Backend (ข้อมูลก่อนแยกประเภท)', frontend: 'Frontend (ข้อมูลก่อนแยกประเภท)'
};
const statusNames = { done: 'สำเร็จ', failed: 'ล้มเหลว', rejected: 'ใช้ผลไม่ได้', skipped: 'ข้าม', cancelled: 'หยุด', interrupted: 'ถูกขัดจังหวะ', running: 'กำลังทำ' };
const taskName = task => taskNames[task] || task;

const number = value => (value ?? 0).toLocaleString('en-US');
function compact(value) {
  if (value == null) return '–';
  if (value >= 1_000_000) return (value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1) + 'M';
  if (value >= 10_000) return Math.round(value / 1000) + 'K';
  return number(value);
}
const percent = value => value == null ? '–' : Math.round(value * 100) + '%';
const money = value => '$' + (value || 0).toFixed(2);
function duration(ms) {
  if (ms == null) return '–';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return seconds + ' วิ';
  const minutes = Math.floor(seconds / 60);
  return minutes + ' นาที' + (seconds % 60 ? ' ' + (seconds % 60) + ' วิ' : '');
}
const shortDay = day => new Date(day + 'T00:00:00').toLocaleDateString('th-TH', { day: 'numeric', month: 'short' });
const time = at => new Date(at).toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// One tooltip for the whole page, placed next to the pointer.
function useTooltip() {
  const [tip, setTip] = useState(null);
  const bind = content => ({
    onMouseEnter: event => setTip({ x: event.clientX, y: event.clientY, content }),
    onMouseMove: event => setTip(previous => previous && { ...previous, x: event.clientX, y: event.clientY }),
    onMouseLeave: () => setTip(null),
    onFocus: event => { const box = event.currentTarget.getBoundingClientRect(); setTip({ x: box.left + box.width / 2, y: box.top, content }); },
    onBlur: () => setTip(null)
  });
  const node = tip ? <div className="stats-tooltip" role="tooltip" style={{ left: tip.x, top: tip.y }}>{tip.content}</div> : null;
  return [bind, node];
}

function Legend({ providers }) {
  return <ul className="stats-legend" aria-label="สีของ AI">
    {ORDER.map(id => <li key={id}><i className={'swatch ' + id} aria-hidden="true" />{providers[id]?.name || id}</li>)}
  </ul>;
}

function Breakdown({ counts, providers }) {
  return <dl className="tip-rows">{ORDER.filter(id => counts[id]).map(id =>
    <div key={id}><dt><i className={'swatch ' + id} aria-hidden="true" />{providers[id].name}</dt><dd>{number(counts[id])}</dd></div>)}</dl>;
}

// Calls per day, stacked by AI. Ticks are clean round numbers.
function DailyChart({ daily, providers, bind }) {
  const peak = Math.max(1, ...daily.map(row => row.calls));
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].find(value => peak / value <= 4) || Math.ceil(peak / 4);
  const top = Math.ceil(peak / step) * step;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, index) => index * step);
  const every = daily.length > 45 ? 14 : daily.length > 14 ? 7 : 1;
  return <div className="daily-chart">
    <div className="daily-plot">
      <div className="daily-grid" aria-hidden="true">{ticks.slice().reverse().map(tick => <div key={tick}><span>{number(tick)}</span></div>)}</div>
      <div className="daily-columns">
        {daily.map(row => <button type="button" key={row.day} className="daily-column" aria-label={shortDay(row.day) + ' เรียก AI ' + row.calls + ' ครั้ง'}
          {...bind(<><strong>{shortDay(row.day)}</strong><span className="tip-total">{number(row.calls)} ครั้ง</span><Breakdown counts={row.byProvider} providers={providers} /></>)}>
          <span className="stack" style={{ height: (row.calls / top) * 100 + '%' }}>
            {ORDER.filter(id => row.byProvider[id]).map(id => <i key={id} className={'segment ' + id} style={{ flexGrow: row.byProvider[id] }} />)}
          </span>
        </button>)}
      </div>
    </div>
    <div className="daily-axis" aria-hidden="true">{daily.map((row, index) =>
      // Regular ticks, plus the last day; a regular tick too close to the last one is dropped so labels never collide.
      <span key={row.day}>{index === daily.length - 1 || (index % every === 0 && daily.length - 1 - index >= Math.max(2, every / 2)) ? shortDay(row.day) : ''}</span>)}</div>
  </div>;
}

// Which AI did each kind of work: one horizontal stacked bar per task.
function TaskChart({ tasks, providers, bind }) {
  const peak = Math.max(1, ...tasks.map(row => row.calls));
  return <ul className="task-chart">
    {tasks.map(row => <li key={row.task}>
      <span className="task-name">{taskName(row.task)}</span>
      <span className="task-track">
        <span className="task-bar" style={{ width: (row.calls / peak) * 100 + '%' }}>
          {ORDER.filter(id => row.providers[id]).map(id => <i key={id} tabIndex={0} className={'segment ' + id} style={{ flexGrow: row.providers[id] }}
            aria-label={taskName(row.task) + ' ' + providers[id].name + ' ' + row.providers[id] + ' ครั้ง'}
            {...bind(<><strong>{taskName(row.task)}</strong><span className="tip-total">{number(row.calls)} ครั้ง · สำเร็จ {percent(row.successRate)} · เฉลี่ย {duration(row.avgMs)}</span>
              <Breakdown counts={row.providers} providers={providers} /></>)} />)}
        </span>
        <b>{number(row.calls)}</b>
      </span>
    </li>)}
  </ul>;
}

function Kpi({ icon: Icon, label, value, note, tone = '' }) {
  return <div className={'stats-kpi ' + tone}>
    <span className="kpi-icon" aria-hidden="true"><Icon size={18} /></span>
    <div><small>{label}</small><strong>{value}</strong>{note ? <em>{note}</em> : null}</div>
  </div>;
}

export default function StatsPage({ api, providers, ProviderIcon, openJob }) {
  const [days, setDays] = useState(() => { try { return Number(localStorage.getItem('relay.stats.days')) || 30; } catch { return 30; } });
  const [stats, setStats] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [bind, tooltip] = useTooltip();

  const load = useCallback(async () => {
    setLoading(true);
    try { setStats(await api('/stats?days=' + days)); setError(''); }
    catch (reason) { setError(reason.message); }
    finally { setLoading(false); }
  }, [api, days]);
  useEffect(() => {
    load();
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  }, [load]);
  function pick(value) {
    setDays(value);
    try { localStorage.setItem('relay.stats.days', String(value)); } catch {}
  }

  const totals = stats?.totals;
  const providerRows = useMemo(() => stats ? ORDER.map(id => stats.providers.find(row => row.provider === id)).filter(Boolean) : [], [stats]);
  const peakCalls = Math.max(1, ...providerRows.map(row => row.calls));
  const finished = totals ? totals.calls - totals.running : 0;

  return <div className="stats-page">
    <div className="stats-toolbar">
      <div className="filters" role="group" aria-label="ช่วงเวลา">
        {RANGES.map(([value, label]) => <button key={value} type="button" aria-pressed={days === value} onClick={() => pick(value)}>{label}</button>)}
      </div>
      <button type="button" className="button" onClick={load} disabled={loading}><RefreshCw size={16} aria-hidden="true" />{loading ? 'กำลังโหลด' : 'โหลดใหม่'}</button>
    </div>
    {error ? <p className="error" role="alert">{error}</p> : null}
    {!stats ? <p className="muted" role="status">กำลังโหลดสถิติ…</p> : totals.calls === 0 ? <section className="card empty">
      <h3>ยังไม่มีการเรียก AI ใน {days} วันที่ผ่านมา</h3><p>สร้างงานแล้วกลับมาดูที่นี่ ทุกการเรียก AI จะถูกนับ</p></section> : <>
      <div className="stats-kpis">
        <Kpi icon={Activity} label="เรียก AI" value={number(totals.calls) + ' ครั้ง'} note={'จาก ' + number(totals.jobs) + ' งาน'} />
        <Kpi icon={CircleCheck} label="สำเร็จ" value={percent(totals.successRate)} tone={totals.successRate != null && totals.successRate < 0.8 ? 'warn' : ''}
          note={'ล้มเหลว ' + number(totals.failed) + ' · ข้าม ' + number(totals.skipped) + ' · หยุด ' + number(totals.stopped)} />
        <Kpi icon={Clock} label="เวลาเฉลี่ยต่อครั้ง" value={duration(totals.avgMs)} note="เฉพาะครั้งที่สำเร็จ" />
        <Kpi icon={Coins} label="Token เข้า / ออก" value={compact(totals.inputTokens) + ' / ' + compact(totals.outputTokens)}
          note={'นับได้ ' + number(totals.withTokens) + ' จาก ' + number(finished) + ' ครั้ง · มูลค่าเทียบ API ' + money(totals.subscriptionCostUsd) +
            (totals.apiCostUsd ? ' · จ่ายจริง ' + money(totals.apiCostUsd) : '')} />
      </div>

      <section className="card stats-card">
        <div className="card-head"><h2>การเรียก AI รายวัน</h2><Legend providers={providers} /></div>
        <DailyChart daily={stats.daily} providers={providers} bind={bind} />
      </section>

      <div className="stats-grid">
        <section className="card stats-card">
          <h2>แต่ละ AI</h2>
          <div className="table-scroll"><table className="steps stats-table">
            <thead><tr><th>AI</th><th>เรียก</th><th>สำเร็จ</th><th>เวลาเฉลี่ย</th><th>Token เข้า/ออก</th><th>มูลค่า</th></tr></thead>
            <tbody>{providerRows.map(row => <tr key={row.provider}>
              <td><span className="stats-ai"><ProviderIcon id={row.provider} size={14} />{providers[row.provider]?.name || row.provider}</span></td>
              <td><span className="share"><span className="share-track"><i className={'segment ' + row.provider} style={{ width: (row.calls / peakCalls) * 100 + '%' }} /></span>{number(row.calls)}</span></td>
              <td>{percent(row.successRate)}{row.failed ? <small className="bad-text"> · ล้ม {row.failed}</small> : null}</td>
              <td>{duration(row.avgMs)}</td>
              <td>{row.withTokens ? compact(row.inputTokens) + ' / ' + compact(row.outputTokens) : <span className="muted-cell">ไม่รายงาน</span>}</td>
              <td>{row.subscriptionCostUsd || row.apiCostUsd ? money(row.subscriptionCostUsd + row.apiCostUsd) : '–'}</td>
            </tr>)}</tbody>
          </table></div>
          <p className="muted">อัตราสำเร็จนับเฉพาะครั้งที่สำเร็จหรือล้มเหลว ไม่นับครั้งที่ถูกข้ามหรือหยุดเอง Codex และ Gemini CLI บางรุ่นไม่ส่งจำนวน token ให้ Relay</p>
        </section>

        <section className="card stats-card">
          <div className="card-head"><h2>งานแต่ละประเภท ใครทำ</h2><Legend providers={providers} /></div>
          <TaskChart tasks={stats.tasks} providers={providers} bind={bind} />
        </section>
      </div>

      <section className="card stats-card">
        <h2>โมเดลที่ใช้</h2>
        <div className="table-scroll"><table className="steps stats-table">
          <thead><tr><th>AI</th><th>โมเดล</th><th>เรียก</th><th>สำเร็จ</th><th>เวลาเฉลี่ย</th><th>Token เข้า/ออก</th></tr></thead>
          <tbody>{stats.models.map(row => <tr key={row.provider + ':' + (row.model || '')}>
            <td><span className="stats-ai"><ProviderIcon id={row.provider} size={14} />{providers[row.provider]?.name || row.provider}</span></td>
            <td>{row.model ? <code>{row.model}</code> : <span className="muted-cell">ไม่ทราบ (ก่อนเริ่มบันทึกโมเดล)</span>}</td>
            <td>{number(row.calls)}</td><td>{percent(row.successRate)}</td><td>{duration(row.avgMs)}</td>
            <td>{row.withTokens ? compact(row.inputTokens) + ' / ' + compact(row.outputTokens) : '–'}</td>
          </tr>)}</tbody>
        </table></div>
        {totals.recordedModels < totals.calls ? <p className="muted">บันทึกชื่อโมเดลได้ {number(totals.recordedModels)} จาก {number(totals.calls)} ครั้ง ครั้งที่เหลือเกิดก่อนเริ่มบันทึกโมเดล หรือ AI ไม่บอกชื่อโมเดล</p> : null}
      </section>

      {stats.failures.length ? <section className="card stats-card">
        <h2><TriangleExclamationPoint size={17} aria-hidden="true" /> ไม่สำเร็จล่าสุด</h2>
        <ul className="stats-failures">{stats.failures.map(row => <li key={row.id}>
          <div className="failure-head">
            <span className="stats-ai"><ProviderIcon id={row.provider} size={14} />{providers[row.provider]?.name || row.provider}</span>
            <span>{taskName(row.task)}</span><span className="muted-cell">{time(row.at)}</span>
            {row.jobTitle ? <button type="button" className="link small" onClick={() => openJob(row.jobId)}>{row.jobTitle}</button> : null}
          </div>
          {row.error ? <p>{row.error}</p> : null}
        </li>)}</ul>
      </section> : null}

      <section className="card stats-card">
        <h2>การเรียกล่าสุด</h2>
        <div className="table-scroll"><table className="steps stats-table">
          <thead><tr><th>เวลา</th><th>งาน</th><th>ประเภทงาน</th><th>AI · โมเดล</th><th>ผล</th><th>ใช้เวลา</th><th>Token เข้า/ออก</th></tr></thead>
          <tbody>{stats.recent.map(row => <tr key={row.id} className={row.status}>
            <td>{time(row.at)}</td>
            <td className="wrap">{row.jobTitle ? <button type="button" className="link small" onClick={() => openJob(row.jobId)}>{row.jobTitle}</button> : '–'}</td>
            <td>{taskName(row.task)}{row.round ? <small className="muted-cell"> · รอบ {row.round}</small> : null}</td>
            <td><span className="stats-ai"><ProviderIcon id={row.provider} size={14} />{row.model || providers[row.provider]?.name || row.provider}</span></td>
            <td><span className={'step-status ' + row.status}>{statusNames[row.status] || row.status}</span></td>
            <td>{duration(row.durationMs)}</td>
            <td>{row.inputTokens || row.outputTokens ? compact(row.inputTokens) + ' / ' + compact(row.outputTokens) : '–'}</td>
          </tr>)}</tbody>
        </table></div>
      </section>
    </>}
    {tooltip}
  </div>;
}
