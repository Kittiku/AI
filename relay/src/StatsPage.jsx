import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, CircleCheck, Clock, Coins, RefreshCw, TriangleExclamationPoint } from 'lucide-react';

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
const money = value => value == null ? '–' : '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 8 });
function duration(ms) {
  if (ms == null) return '–';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return seconds + ' วิ';
  const minutes = Math.floor(seconds / 60);
  return minutes + ' นาที' + (seconds % 60 ? ' ' + (seconds % 60) + ' วิ' : '');
}
const shortDay = day => new Date(day + 'T00:00:00').toLocaleDateString('th-TH', { day: 'numeric', month: 'short' });
const time = at => new Date(at).toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const modelName = model => model ?? 'ไม่ทราบรุ่น';
const providerName = (providers, id) => providers[id]?.name || id;
const modelKey = ({ provider, model }) => provider + ':' + (model ?? 'unknown');
const providerColor = id => 'var(--series-' + id + ', var(--muted))';
const totalColor = '#8b929f';
const METRICS = {
  calls: { label: 'จำนวนครั้ง', format: value => number(value) + ' ครั้ง', tick: compact },
  tokens: { label: 'Token เข้า + ออก', format: value => number(value) + ' token', tick: compact },
  costUsd: { label: 'ค่าใช้จ่าย', format: money, tick: money },
  avgMs: { label: 'เวลาเฉลี่ย', format: duration, tick: ms => compact(ms / 1000) + ' วิ' }
};
const metricText = (metric, value) => value == null ? 'ไม่รายงาน' : METRICS[metric].format(value);

function useTooltip() {
  const [tip, setTip] = useState(null);
  const show = (x, y, content) => {
    const width = document.documentElement.clientWidth;
    const margin = Math.min(140, width / 2);
    setTip({ x: Math.min(width - margin, Math.max(margin, x)), y, content });
  };
  const bind = content => ({
    onMouseEnter: event => show(event.clientX, event.clientY, content),
    onMouseLeave: () => setTip(null),
    onFocus: event => {
      const box = event.currentTarget.getBoundingClientRect();
      show(box.left + box.width / 2, box.top, content);
    },
    onBlur: () => setTip(null),
    onKeyDown: event => { if (event.key === 'Escape') setTip(null); }
  });
  const node = tip ? <div className={'stats-tooltip' + (tip.y < Math.min(240, window.innerHeight / 2) ? ' below' : '')} role="tooltip"
    style={{ left: tip.x, top: tip.y }}>{tip.content}</div> : null;
  return [bind, node, () => setTip(null)];
}

function modelGroups(ids, models) {
  return ids.map(provider => {
    const rows = models.filter(model => model.provider === provider);
    const names = rows.filter(row => row.model != null).map(row => row.model).sort();
    const colors = new Map(names.map((name, index) => {
      const base = providerColor(provider);
      const shade = index % 2 ? 'var(--ink)' : 'var(--surface)';
      const strength = 32 * Math.ceil(index / 2) / Math.max(1, Math.floor(names.length / 2));
      return [name, index ? 'color-mix(in srgb, ' + base + ', ' + shade + ' ' + strength + '%)' : base];
    }));
    return { provider, models: rows.map(row => ({ ...row, key: modelKey(row), color: colors.get(row.model) ?? 'var(--muted)' })) };
  });
}

function buildDailySeries(daily, groups, metric, providers) {
  const byModel = daily.some(row => row.byModel != null);
  const dates = daily.map(row => row.date ?? row.day);
  const panels = groups.map(group => {
    const name = providerName(providers, group.provider);
    const series = byModel ? group.models.map(model => ({
      key: model.key, name: modelName(model.model), color: model.color, unknown: model.model == null,
      values: daily.map(row => row.byModel?.[model.key]?.[metric] ?? (metric === 'calls' ? 0 : null)),
      calls: daily.map(row => row.byModel?.[model.key]?.calls ?? 0)
    })) : [{
      key: group.provider, name, color: providerColor(group.provider),
      values: daily.map(row => metric === 'calls' ? row.byProvider?.[group.provider] ?? 0 : null),
      calls: daily.map(row => row.byProvider?.[group.provider] ?? 0)
    }];
    return { key: group.provider, name, series };
  });
  const series = panels.flatMap(panel => panel.series.map(item => ({
    ...item, name: byModel ? panel.name + ' · ' + item.name : item.name
  })));
  const total = { key: 'total', name: 'ยอดรวม', color: totalColor, total: true, values: daily.map((_, index) => {
    let sum = 0;
    let weight = 0;
    for (const item of series) {
      const value = item.values[index];
      if (value == null) continue;
      const count = metric === 'avgMs' ? item.calls[index] : 1;
      sum += value * count;
      weight += count;
    }
    if (metric === 'calls') return sum;
    if (!weight) return null;
    return metric === 'avgMs' ? sum / weight : sum;
  }) };
  return { dates, panels, series, total, byModel };
}

function chartScale(series, metric) {
  let peak = 0;
  for (const line of series) {
    for (const value of line.values) {
      if (value != null) peak = Math.max(peak, value);
    }
  }
  const minimum = { calls: 1, tokens: 1, costUsd: peak ? 0.00000001 : 0.001, avgMs: 1000 }[metric];
  const target = Math.max(minimum, peak / 4);
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const step = ([1, 2, 5, 10].find(value => value * magnitude >= target) ?? 10) * magnitude;
  const count = Math.max(1, Math.ceil(peak / step));
  return { top: count * step, ticks: Array.from({ length: count + 1 }, (_, index) => (count - index) * step) };
}

function linePaths(values, top) {
  let line = '';
  let dots = '';
  let connects = false;
  values.forEach((value, index) => {
    if (value == null) {
      connects = false;
      return;
    }
    const x = 100 * (index + 0.5) / values.length;
    const y = 100 * (1 - value / top);
    line += (connects ? 'L' : 'M') + x + ',' + y;
    dots += 'M' + x + ',' + y + 'h0';
    connects = true;
  });
  return { line, dots };
}

function SeriesLegend({ series }) {
  return <ul className="stats-legend" aria-label="เส้นในกราฟ">
    {series.map(item => <li key={item.key}>
      <i className={'stats-line-key' + (item.unknown ? ' unknown' : '')} style={{ color: item.color }} aria-hidden="true" />{item.name}
    </li>)}
  </ul>;
}

function DailyPlot({ title, dates, total, series, scale, metric, bind }) {
  const [focusedDay, setFocusedDay] = useState(0);
  const last = dates.length - 1;
  const labelDays = [...new Set([0, Math.floor(last / 2), last])];

  function navigate(event, index) {
    const next = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: last }[event.key];
    if (next == null) return;
    event.preventDefault();
    event.currentTarget.parentElement.children[Math.min(last, Math.max(0, next))].focus();
  }

  return <section className="stats-plot" aria-label={title}>
    <h3>{title}</h3>
    <SeriesLegend series={[total, ...series]} />
    {!series.some(item => item.values.some(value => value != null)) ?
      <p className="stats-no-series">ไม่มีข้อมูล{METRICS[metric].label}</p> : null}
    <div className="stats-axis-layout">
      <div className="stats-y-labels" aria-hidden="true">{scale.ticks.map(tick =>
        <span key={tick} style={{ top: 100 * (1 - tick / scale.top) + '%' }}>{METRICS[metric].tick(tick)}</span>)}</div>
      <div className={'stats-plot-area' + (dates.length > 45 ? ' dense' : '')}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {scale.ticks.map(tick => {
            const y = 100 * (1 - tick / scale.top);
            return <line key={tick} className="stats-grid-line" x1="0" x2="100" y1={y} y2={y} vectorEffect="non-scaling-stroke" />;
          })}
          {[total, ...series].map(item => {
            const { line, dots } = linePaths(item.values, scale.top);
            return <g key={item.key} className={(item.total ? 'stats-total-series' : '') + (item.unknown ? ' stats-unknown-series' : '')} style={{ color: item.color }}>
              <path className="stats-series-line" d={line} vectorEffect="non-scaling-stroke" />
              <path className="stats-series-dots" d={dots} vectorEffect="non-scaling-stroke" />
            </g>;
          })}
        </svg>
        <div className="stats-plot-days" role="group" aria-label="เลือกวันที่ด้วยปุ่มลูกศรซ้ายและขวา">
          {dates.map((date, index) => {
            const label = shortDay(date);
            const totalText = metricText(metric, total.values[index]);
            const active = series.filter(item => item.calls[index] > 0 || (metric !== 'calls' && item.values[index] != null));
            const listed = active.slice(0, 6);
            const remainder = active.length - listed.length;
            const tip = bind(<><strong>{label}</strong><span className="tip-total">ยอดรวม · {totalText}</span>
              {listed.length ? <dl className="tip-rows">{listed.map(item =>
                <div key={item.key}><dt>{item.name}</dt><dd>{metricText(metric, item.values[index])}</dd></div>)}</dl> : null}
              {remainder ? <span className="tip-total">อีก {number(remainder)} รุ่นในมุมมองตาราง</span> : null}</>);
            return <button type="button" key={date} tabIndex={Math.min(focusedDay, last) === index ? 0 : -1}
              aria-label={[label, 'ยอดรวม ' + totalText, ...listed.map(item => item.name + ' ' + metricText(metric, item.values[index])),
                ...(remainder ? ['อีก ' + number(remainder) + ' รุ่นในมุมมองตาราง'] : [])].join(' · ')}
              {...tip} onFocus={event => { setFocusedDay(index); tip.onFocus(event); }}
              onKeyDown={event => { navigate(event, index); tip.onKeyDown(event); }} />;
          })}
        </div>
      </div>
      <div className="stats-x-labels" aria-hidden="true">{labelDays.map((index, position) =>
        <span key={dates[index]} style={{ left: (position === 0 ? 0 : index === last ? 100 : 100 * (index + 0.5) / dates.length) + '%' }}>
          {shortDay(dates[index])}
        </span>)}</div>
    </div>
  </section>;
}

function DailyTable({ dates, total, series, metric, byModel }) {
  return <table className="steps stats-table stats-daily-table" aria-label={METRICS[metric].label + ' รายวัน'}>
    <thead><tr><th scope="col">วันที่</th><th scope="col">ยอดรวม</th><th scope="col">{byModel ? 'แยกตามรุ่น' : 'แยกตาม AI'}</th></tr></thead>
    <tbody>{dates.map((date, index) => <tr key={date}>
      <th scope="row">{shortDay(date)}</th><td>{metricText(metric, total.values[index])}</td>
      <td>{series.length ? <details>
        <summary aria-label={'ดูรายละเอียด ' + shortDay(date)}>ดูรายละเอียด</summary>
        <dl className="stats-daily-values">{series.map(item => <div key={item.key}>
          <dt>{item.name}</dt><dd>{metricText(metric, item.values[index])}</dd>
        </div>)}</dl>
      </details> : '–'}</td>
    </tr>)}</tbody>
  </table>;
}

function Heatmap({ matrix, groups, providers, bind }) {
  const models = groups.flatMap(group => group.models);
  const selected = new Set(models.map(model => model.key));
  const counts = new Map();
  let peak = 0;
  for (const row of matrix ?? []) {
    const key = modelKey(row);
    if (!selected.has(key)) continue;
    if (!counts.has(row.type)) counts.set(row.type, new Map());
    counts.get(row.type).set(key, row.count);
    peak = Math.max(peak, row.count);
  }
  if (!counts.size) return <p className="muted">ไม่มีข้อมูลประเภทงานแยกตามรุ่น</p>;

  // Keep the task labels beside each set of model columns at narrow widths.
  const columnsPerTable = 3;
  return <>
    <p className="muted">จำนวนครั้งที่เรียกตามประเภทงาน สีเข้มขึ้นเมื่อจำนวนครั้งมากขึ้น</p>
    <div className="stats-heatmaps">
      {Array.from({ length: Math.ceil(models.length / columnsPerTable) }, (_, index) => {
        const columns = models.slice(index * columnsPerTable, (index + 1) * columnsPerTable);
        return <table key={columns[0].key} className="stats-heatmap" aria-label={'จำนวนครั้งตามประเภทงานและรุ่น กลุ่ม ' + (index + 1)}>
          <thead><tr><th scope="col">ประเภทงาน</th>{columns.map(model =>
            <th scope="col" key={model.key}><span>{providerName(providers, model.provider)}</span>{modelName(model.model)}</th>)}</tr></thead>
          <tbody>{[...counts].map(([type, row]) => <tr key={type}>
            <th scope="row">{taskName(type)}</th>
            {columns.map(model => {
              const count = row.get(model.key) ?? 0;
              const label = taskName(type) + ' · ' + providerName(providers, model.provider) + ' · ' + modelName(model.model);
              return <td key={model.key}><span tabIndex={0} role="img" aria-label={label + ' · ' + number(count) + ' ครั้ง'}
                style={{ '--heat-color': model.color, '--heat-strength': (count ? 14 + 42 * count / peak : 0) + '%' }}
                {...bind(<><strong>{label}</strong><span className="tip-total">{number(count)} ครั้ง</span></>)}>{number(count)}</span></td>;
            })}
          </tr>)}</tbody>
        </table>;
      })}
    </div>
  </>;
}

function LatencyRange({ row, peak }) {
  if (row.p50Ms == null || row.p90Ms == null) return '–';
  const start = 100 * row.p50Ms / peak + '%';
  const end = 100 * row.p90Ms / peak + '%';
  return <span className="stats-latency">
    <span className="stats-latency-track" aria-hidden="true" style={{ '--start': start, '--end': end, '--range-color': row.color }}><i /></span>
    <span>{duration(row.p50Ms)} – {duration(row.p90Ms)}</span>
  </span>;
}

function ModelTable({ groups, providers, ProviderIcon }) {
  const models = groups.flatMap(group => group.models);
  const peak = models.reduce((max, row) => Math.max(max, row.p90Ms ?? 0), 1);
  if (!models.length) return <p className="muted">ไม่มีการเรียก AI ที่เลือกในช่วงนี้</p>;

  return <div className="stats-model-groups">{groups.filter(group => group.models.length > 0).map(({ provider, models }) => {
    const name = providerName(providers, provider);
    return <details className="stats-model-group" key={provider} open>
      <summary><span className="stats-ai"><ProviderIcon id={provider} size={14} />{name}</span>
        <small>{number(models.reduce((sum, model) => sum + model.calls, 0))} ครั้ง</small></summary>
      <table className="steps stats-table stats-adaptive-table" role="table" aria-label={'รุ่นของ ' + name}>
        <thead role="rowgroup"><tr role="row">
          <th role="columnheader" scope="col">รุ่น</th><th role="columnheader" scope="col">เรียก</th>
          <th role="columnheader" scope="col">สำเร็จ / ล้มเหลว</th><th role="columnheader" scope="col">เวลาเฉลี่ย</th>
          <th role="columnheader" scope="col">p50–p90</th><th role="columnheader" scope="col">Token เข้า / ออก</th>
          <th role="columnheader" scope="col">ค่าใช้จ่าย</th>
        </tr></thead>
        <tbody role="rowgroup">{models.map(row => <tr role="row" key={row.key}>
          <th role="rowheader" scope="row"><span className="stats-model-name"><i className={'stats-line-key' + (row.model == null ? ' unknown' : '')}
            style={{ color: row.color }} aria-hidden="true" />{modelName(row.model)}</span></th>
          <td role="cell" data-label="เรียก">{number(row.calls)}</td>
          <td role="cell" data-label="สำเร็จ / ล้มเหลว">{number(row.ok ?? row.done)} / {number(row.failed)}</td>
          <td role="cell" data-label="เวลาเฉลี่ย">{duration(row.avgMs)}</td>
          <td role="cell" data-label="p50–p90"><LatencyRange row={row} peak={peak} /></td>
          <td role="cell" data-label="Token เข้า / ออก">{row.withTokens === 0 || (row.inputTokens == null && row.outputTokens == null)
            ? '–' : compact(row.inputTokens) + ' / ' + compact(row.outputTokens)}</td>
          <td role="cell" data-label="ค่าใช้จ่าย">{money(Object.hasOwn(row, 'costUsd') ? row.costUsd : (row.subscriptionCostUsd + row.apiCostUsd || null))}</td>
        </tr>)}</tbody>
      </table>
    </details>;
  })}</div>;
}

function Kpi({ icon: Icon, label, value, note, tone = '' }) {
  return <div className={'stats-kpi ' + tone}>
    <span className="kpi-icon" aria-hidden="true"><Icon size={18} /></span>
    <div><small>{label}</small><strong>{value}</strong>{note ? <em>{note}</em> : null}</div>
  </div>;
}

export default function StatsPage({ api, providers, ProviderIcon, openJob }) {
  const [days, setDays] = useState(() => {
    try {
      const saved = Number(localStorage.getItem('relay.stats.days'));
      return RANGES.some(([value]) => value === saved) ? saved : 30;
    } catch { return 30; }
  });
  const [stats, setStats] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [provider, setProvider] = useState('');
  const [metric, setMetric] = useState('calls');
  const [combined, setCombined] = useState(false);
  const [table, setTable] = useState(false);
  const [bind, tooltip, clearTip] = useTooltip();
  const request = useRef(0);

  const load = useCallback(async () => {
    const current = ++request.current;
    setLoading(true);
    try {
      const data = await api('/stats?days=' + days);
      if (current === request.current) { setStats(data); setError(''); }
    } catch (reason) {
      if (current === request.current) setError(reason.message);
    } finally {
      if (current === request.current) setLoading(false);
    }
  }, [api, days]);
  useEffect(() => {
    load();
    const timer = setInterval(load, 60_000);
    return () => { clearInterval(timer); request.current++; };
  }, [load]);
  function pick(value) {
    clearTip();
    setDays(value);
    try { localStorage.setItem('relay.stats.days', String(value)); } catch {}
  }

  const totals = stats?.totals;
  const ids = useMemo(() => {
    const available = new Set([...ORDER, ...(stats?.providers ?? []).map(row => row.provider), ...(stats?.models ?? []).map(row => row.provider)]);
    return [...available];
  }, [stats]);
  const selected = useMemo(() => provider ? [provider] : ids, [provider, ids]);
  const groups = useMemo(() => modelGroups(selected, stats?.models ?? []), [selected, stats]);
  const daily = useMemo(() => buildDailySeries(stats?.daily ?? [], groups, metric, providers), [stats, groups, metric, providers]);
  const scale = useMemo(() => chartScale([daily.total, ...daily.series], metric), [daily, metric]);
  const providerRows = selected.map(id => stats?.providers.find(row => row.provider === id)).filter(Boolean);
  const peakCalls = Math.max(1, ...providerRows.map(row => row.calls));
  const topModel = totals && Object.hasOwn(totals, 'topModel') ? totals.topModel : stats?.models.find(row => row.model != null);
  const finished = totals ? totals.calls - totals.running : 0;

  return <div className="stats-page">
    <div className="stats-toolbar">
      <div className="filters" role="group" aria-label="ช่วงเวลา">
        {RANGES.map(([value, label]) => <button key={value} type="button" aria-pressed={days === value} onClick={() => pick(value)}>{label}</button>)}
      </div>
      <label className="stats-select">กรองตาม AI
        <select value={provider} onChange={event => { clearTip(); setProvider(event.target.value); }}>
          <option value="">ทุก AI</option>
          {ids.map(id => <option key={id} value={id}>{providerName(providers, id)}</option>)}
        </select>
      </label>
      <button type="button" className="button" onClick={load} disabled={loading}><RefreshCw size={16} aria-hidden="true" />{loading ? 'กำลังโหลด' : 'โหลดใหม่'}</button>
    </div>
    {error ? <p className="error" role="alert">{error}</p> : null}
    {!stats ? !error && <p className="muted" role="status">กำลังโหลดสถิติ…</p> : totals.calls === 0 ? <section className="card empty">
      <h3>ยังไม่มีการเรียก AI ใน {stats.range?.days ?? days} วันที่ผ่านมา</h3><p>สร้างงานแล้วกลับมาดูที่นี่ ทุกการเรียก AI จะถูกนับ</p></section> : <>
      <div className="stats-kpis" role="group" aria-label="ภาพรวมทุก AI">
        <Kpi icon={Activity} label="เรียก AI" value={number(totals.calls) + ' ครั้ง'} note={'จาก ' + number(totals.jobs) + ' งาน'} />
        <Kpi icon={CircleCheck} label="สำเร็จ" value={percent(totals.successRate)} tone={totals.successRate != null && totals.successRate < 0.8 ? 'warn' : ''}
          note={'ล้มเหลว ' + number(totals.failed) + ' · ข้าม ' + number(totals.skipped) + ' · หยุด ' + number(totals.stopped)} />
        <Kpi icon={Clock} label="เวลาเฉลี่ยต่อครั้ง" value={duration(totals.avgMs)} note="เฉพาะครั้งที่สำเร็จ" />
        <Kpi icon={Coins} label="Token เข้า / ออก" value={totals.withTokens ? compact(totals.inputTokens) + ' / ' + compact(totals.outputTokens) : 'ไม่รายงาน'}
          note={'นับได้ ' + number(totals.withTokens) + ' จาก ' + number(finished) + ' ครั้ง' +
            (totals.subscriptionCostUsd ? ' · มูลค่าเทียบ API ' + money(totals.subscriptionCostUsd) : '') +
            (totals.apiCostUsd ? ' · จ่ายจริง ' + money(totals.apiCostUsd) : '')} />
        <Kpi icon={Activity} label="รุ่นที่ใช้มากสุด" value={topModel ? modelName(topModel.model) : '–'}
          note={topModel ? providerName(providers, topModel.provider) + ' · ' + number(topModel.calls) + ' ครั้ง' : null} />
        <Kpi icon={Coins} label="ค่าใช้จ่ายต่องาน" value={money(totals.costPerJob)} note="เฉพาะงานที่รายงานค่าใช้จ่าย" />
      </div>

      <section className="card stats-card">
        <div className="card-head stats-card-head">
          <h2>การเรียก AI รายวัน</h2>
          <div className="stats-chart-controls">
            <label className="stats-select">ตัวชี้วัด
              <select value={metric} onChange={event => { clearTip(); setMetric(event.target.value); }}>
                {Object.entries(METRICS).map(([id, item]) => <option key={id} value={id}>{item.label}</option>)}
              </select>
            </label>
            <div className="filters" role="group" aria-label="มุมมองรายวัน">
              <button type="button" aria-pressed={!table} onClick={() => { clearTip(); setTable(false); }}>กราฟ</button>
              <button type="button" aria-pressed={table} onClick={() => { clearTip(); setTable(true); }}>ตาราง</button>
            </div>
            {!table && <button type="button" className="button" onClick={() => { clearTip(); setCombined(value => !value); }}>
              {combined ? 'แยกกราฟตาม AI' : 'รวมเป็นกราฟเดียว'}
            </button>}
          </div>
        </div>
        {metric === 'avgMs' ? <p className="stats-chart-note muted">ยอดรวมคำนวณจากเวลาเฉลี่ยของรุ่นที่มีข้อมูล ถ่วงน้ำหนักด้วยจำนวนครั้งที่เรียก</p> : null}
        {!daily.byModel ? <p className="stats-chart-note muted">ข้อมูลรายวันแยกตาม AI และแสดงได้เฉพาะจำนวนครั้ง</p> : null}
        {!daily.dates.length ? <p className="muted">ไม่มีข้อมูลรายวันในช่วงนี้</p> : table ?
          <DailyTable {...daily} metric={metric} /> : <div className="stats-plots">
            {combined ? <DailyPlot title="กราฟรวม" {...daily} scale={scale} metric={metric} bind={bind} /> :
              daily.panels.map(panel => <DailyPlot key={panel.key} title={panel.name} dates={daily.dates}
                total={daily.total} series={panel.series} scale={scale} metric={metric} bind={bind} />)}
          </div>}
      </section>

      <section className="card stats-card">
        <h2>แต่ละ AI</h2>
        <table className="steps stats-table stats-adaptive-table" role="table" aria-label="สถิติแยกตาม AI">
          <thead role="rowgroup"><tr role="row">
            <th role="columnheader" scope="col">AI</th><th role="columnheader" scope="col">เรียก</th>
            <th role="columnheader" scope="col">สำเร็จ</th><th role="columnheader" scope="col">เวลาเฉลี่ย</th>
            <th role="columnheader" scope="col">Token เข้า / ออก</th><th role="columnheader" scope="col">มูลค่า</th>
          </tr></thead>
          <tbody role="rowgroup">{providerRows.map(row => <tr role="row" key={row.provider}>
            <th role="rowheader" scope="row"><span className="stats-ai"><ProviderIcon id={row.provider} size={14} />{providerName(providers, row.provider)}</span></th>
            <td role="cell" data-label="เรียก"><span className="share"><span aria-hidden="true" className="share-track">
              <i style={{ width: (row.calls / peakCalls) * 100 + '%', background: providerColor(row.provider) }} />
            </span>{number(row.calls)}</span></td>
            <td role="cell" data-label="สำเร็จ">{percent(row.successRate)}{row.failed ? <small className="bad-text"> · ล้ม {row.failed}</small> : null}</td>
            <td role="cell" data-label="เวลาเฉลี่ย">{duration(row.avgMs)}</td>
            <td role="cell" data-label="Token เข้า / ออก">{row.withTokens ? compact(row.inputTokens) + ' / ' + compact(row.outputTokens) : <span className="muted-cell">ไม่รายงาน</span>}</td>
            <td role="cell" data-label="มูลค่า">{money(row.subscriptionCostUsd + row.apiCostUsd || null)}</td>
          </tr>)}</tbody>
        </table>
        <p className="muted">อัตราสำเร็จนับเฉพาะครั้งที่สำเร็จหรือล้มเหลว ไม่นับครั้งที่ถูกข้ามหรือหยุดเอง Codex และ Gemini CLI บางรุ่นไม่ส่งจำนวน token ให้ Relay</p>
      </section>

      <section className="card stats-card">
        <h2>รุ่นที่ใช้ แยกตาม AI</h2>
        <ModelTable groups={groups} providers={providers} ProviderIcon={ProviderIcon} />
        {totals.recordedModels < totals.calls ? <p className="muted">รวมทุก AI บันทึกชื่อรุ่นได้ {number(totals.recordedModels)} จาก {number(totals.calls)} ครั้ง</p> : null}
      </section>

      <section className="card stats-card">
        <h2>ประเภทงาน × รุ่น</h2>
        <Heatmap matrix={stats.matrix} groups={groups} providers={providers} bind={bind} />
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
        <table className="steps stats-table stats-adaptive-table" role="table" aria-label="การเรียกล่าสุด">
          <thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">เวลา</th><th scope="col" role="columnheader">งาน</th><th scope="col" role="columnheader">ประเภทงาน</th><th scope="col" role="columnheader">AI · โมเดล</th><th scope="col" role="columnheader">ผล</th><th scope="col" role="columnheader">ใช้เวลา</th><th scope="col" role="columnheader">Token เข้า/ออก</th></tr></thead>
          <tbody role="rowgroup">{stats.recent.map(row => <tr role="row" key={row.id} className={row.status}>
            <td role="cell" data-label="เวลา">{time(row.at)}</td>
            <td role="cell" data-label="งาน">{row.jobTitle ? <button type="button" className="link small" onClick={() => openJob(row.jobId)}>{row.jobTitle}</button> : '–'}</td>
            <td role="cell" data-label="ประเภทงาน">{taskName(row.task)}{row.round ? <small className="muted-cell"> · รอบ {row.round}</small> : null}</td>
            <td role="cell" data-label="AI · โมเดล"><span className="stats-ai"><ProviderIcon id={row.provider} size={14} />{row.model || providers[row.provider]?.name || row.provider}</span></td>
            <td role="cell" data-label="ผล"><span className={'step-status ' + row.status}>{statusNames[row.status] || row.status}</span></td>
            <td role="cell" data-label="ใช้เวลา">{duration(row.durationMs)}</td>
            <td role="cell" data-label="Token เข้า / ออก">{row.inputTokens || row.outputTokens ? compact(row.inputTokens) + ' / ' + compact(row.outputTokens) : '–'}</td>
          </tr>)}</tbody>
        </table>
      </section>
    </>}
    {tooltip}
  </div>;
}
