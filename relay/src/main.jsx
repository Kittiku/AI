import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/noto-sans-thai';
import {
  ArrowRight, ChartColumn, ChartPie, Check, ChevronLeft, ClipboardList, CodeXml, Copy, Ellipsis, FlaskConical, FolderGit2, FolderOpen, FolderPlus,
  TriangleExclamationPoint, CircleCheck, Clock, GitBranch, Layers, LayoutDashboard, Plus, RefreshCw, RotateCcw, Search, Settings, Sparkle, Terminal, Trash, Wrench, X
} from 'lucide-react';
import AddProjectModal from './AddProjectModal.jsx';
import StatsPage from './StatsPage.jsx';
import { AcceptanceChecklist, OutcomeTiles, ReviewHistoryList, StageStepper } from './JobDetailPanels.jsx';
import { Markdown, InlineMarkdown } from './markdown.js';
import { getJobStatusBadge } from './jobBadge.js';
import './style.css';

const providers = {
  claudecode: { name: 'Claude Code', company: 'Anthropic', icon: Terminal },
  gemini: { name: 'Gemini', company: 'Google', icon: Sparkle },
  codex: { name: 'Codex', company: 'OpenAI', icon: CodeXml }
};
const pages = [
  ['queue', 'ภาพรวม', LayoutDashboard], ['projects', 'โปรเจกต์', FolderGit2], ['quota', 'โควตา AI', ChartPie], ['stats', 'สถิติ AI', ChartColumn], ['settings', 'ตั้งค่า', Settings]
];
const pageInfo = {
  queue: ['ภาพรวม', 'งานที่กำลังทำ สิ่งที่รอคุณ และคิวทั้งหมด'],
  projects: ['โปรเจกต์', 'โฟลเดอร์งานที่บันทึกไว้ คำสั่งทดสอบ และบันทึกที่ AI อ่านทุกงาน'],
  quota: ['โควตา AI', 'โควตาคงเหลือ เวลารีเซ็ต และระดับที่กันไว้ของแต่ละ AI'],
  stats: ['สถิติ AI', 'เรียก AI ตัวไหน โมเดลอะไร ทำงานอะไร บ่อยแค่ไหน เร็วแค่ไหน และใช้ token เท่าไร'],
  settings: ['ตั้งค่า', 'การจ่ายงาน โมเดล การทำงานพร้อมกัน โควตา การอนุมัติ และงบ'],
  job: ['รายละเอียดงาน', 'ติดตามความคืบหน้า ตรวจผล และ merge']
};
const statusLabels = {
  queued: 'รอเริ่ม', running: 'กำลังดำเนินการ', stopping: 'กำลังหยุด', complete: 'พร้อมตรวจผล',
  needs_review: 'ต้องตรวจเพิ่ม', failed: 'งานติดขัด', cancelled: 'หยุดแล้ว', interrupted: 'ถูกขัดจังหวะ', waiting_approval: 'รออนุมัติ'
};
const jobTypes = { feature: 'ฟีเจอร์ใหม่ (Backend + Frontend)', bugfix: 'แก้ bug (AI ตัวเดียว)', refactor: 'ปรับโครงสร้างโค้ด (AI ตัวเดียว)', docs: 'เอกสาร (AI ตัวเดียว)', other: 'อื่นๆ (Backend + Frontend)' };
const stageName = (job, key) => job.single && key === 'backend' ? 'ลงมือทำ' : stageNames[key];
const roleNames = { plan: 'วางแผน', backend: 'Backend', frontend: 'Frontend', review: 'รีวิว' };
const stageNames = { plan: 'วางแผน', backend: 'Backend', frontend: 'Frontend', checks: 'ทดสอบ', review: 'รีวิว' };
const stageStatus = { pending: 'รอ', running: 'กำลังทำ', done: 'เสร็จ', warning: 'ตรวจเพิ่ม', failed: 'ล้มเหลว', cancelled: 'หยุด', waiting: 'รอโควตา', retrying: 'กำลังลองใหม่' };
const activeStatuses = new Set(['running', 'stopping', 'waiting_approval']);
const busyStatuses = new Set(['queued', ...activeStatuses]);
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

async function api(url, method = 'GET', body, options) {
  const response = await fetch('/api' + url, method === 'GET' ? options : {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {})
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(Error(result.error || 'เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ'), { data: result, status: response.status });
  return result;
}

const readState = signal => api('/state', 'GET', undefined, { signal, cache: 'no-store' });

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

function stagesOf(job, inactive) {
  const keys = ['plan', 'backend', ...(job.single ? [] : ['frontend']), 'checks', 'review'];
  return keys.map(key => {
    const stage = job.stages?.[key] || {};
    let status = stage.status || 'pending';
    if (key === 'checks' && !job.runChecks && status === 'pending') return { key, status: 'skipped', skippedText: 'ไม่ได้ทดสอบ' };
    if (key === 'checks' && status === 'skipped') return { key, ...stage, status, skippedText: 'ไม่ได้ทดสอบ' };
    if (inactive && ['running', 'waiting', 'retrying'].includes(status)) {
      return { key, status: job.status === 'queued' ? 'pending' : 'skipped' };
    }
    if (status === 'pending' && stuckStatuses.has(job.status)) status = 'skipped';
    return { key, ...stage, status };
  });
}

function Stepper({ job, inactive }) {
  const stages = stagesOf(job, inactive);
  const now = Date.now();
  return <ol className="stepper" aria-label="ขั้นตอนการทำงาน">
    {stages.map(stage => <li key={stage.key} className={'stage ' + stage.status}>
      <span className="stage-dot" aria-hidden="true">{stage.status === 'done' ? <Check size={14} /> : stage.status === 'failed' ? <X size={14} /> : null}</span>
      <div>
        <strong>{stageName(job, stage.key)}</strong>
        <small>{stage.status === 'skipped' ? stage.skippedText || (stage.note ? 'ข้าม · ' + stage.note : 'ไม่ได้ทำ') : stageStatus[stage.status] || stage.status}
          {stage.status === 'waiting' && stage.waitUntil ? ' ถึง ' + time(stage.waitUntil) : ''}
          {stage.provider && stage.status !== 'waiting' ? ' · ' + providerName(stage.provider) : ''}
          {stage.startedAt && stage.status !== 'pending' ? ' · ' + duration((stage.endedAt || now) - stage.startedAt) : ''}
          {stage.round ? ' · แก้รอบ ' + stage.round : ''}</small>
      </div>
    </li>)}
  </ol>;
}

const monitorStageNames = {
  ...stageNames, prepare: 'เตรียมงาน', integrate: 'รวมงาน', delivery: 'ส่งมอบ', merge: 'Merge', rebase: 'รีเบส'
};
const monitorStageIcons = {
  prepare: FolderGit2, plan: ClipboardList, work: CodeXml, integrate: GitBranch,
  checks: FlaskConical, review: ClipboardList, delivery: Check
};
const monitorActions = {
  prepare_worktree: 'เตรียม worktree', plan: 'จัดทำแผน', implement: 'ลงมือแก้ไฟล์',
  integrate: 'รวมผลจากแต่ละส่วน', run_check: 'รันคำสั่งทดสอบ', review: 'ตรวจผลการแก้ไข',
  fix_review: 'แก้ตามรีวิว', apply_result: 'นำผลไปใช้', wait_quota: 'รอโควตา AI',
  wait_approval: 'รอการอนุมัติ', retry: 'ลองใหม่', finish: 'ส่งมอบงาน',
  subtask: 'ทำงานย่อย', fix_subtask: 'แก้งานย่อยตามที่หัวหน้าตรวจ', check_subtask: 'หัวหน้าตรวจงานย่อย'
};
const monitorActivities = {
  started: 'เริ่มทำงาน', provider_fallback: 'เปลี่ยนไปใช้ AI สำรอง', quota_wait: 'รอโควตา AI',
  retry_scheduled: 'เตรียมลองใหม่', approval_requested: 'ขออนุมัติ', completed: 'เสร็จแล้ว',
  failed: 'ล้มเหลว', cancelled: 'หยุดแล้ว'
};
const monitorConnections = {
  connecting: 'กำลังเชื่อมต่อ', live: 'สด', polling: 'อัปเดตเป็นระยะ', stale: 'ข้อมูลล่าสุดอาจล้าสมัย'
};
const approvalLabels = { plan: 'รออนุมัติแผน', budget: 'รออนุมัติงบงาน', daily_budget: 'รออนุมัติงบรายวัน', before_merge: 'รออนุมัติ merge' };
const sameApproval = (first, second) => Number.isFinite(first?.requestedAt) &&
  first.kind === second?.kind && first.requestedAt === second?.requestedAt;
const workKeys = new Set(['backend', 'frontend']);
const monitorClock = new Intl.DateTimeFormat('th-TH', {
  timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', second: '2-digit'
});
const monitorTime = at => monitorClock.format(at);

function isMonitorJob(value) {
  return Boolean(value?.id && Array.isArray(value.stages) && Array.isArray(value.activities));
}

const activeJobId = entry => typeof entry === 'string' ? entry : entry?.id ?? entry?.jobId;

function activeMonitorJobs(snapshot) {
  if (!Array.isArray(snapshot?.activeJobs)) return isMonitorJob(snapshot?.activeJob) ? [snapshot.activeJob] : [];
  const legacy = snapshot.activeJob;
  return snapshot.activeJobs.map(entry => isMonitorJob(entry) ? entry :
    activeJobId(entry) === legacy?.id ? legacy : null).filter(isMonitorJob);
}

function isMonitorSnapshot(value) {
  return Number.isFinite(value?.updatedAt) && Number.isInteger(value.queuedCount) &&
    (value.lastFinishedJob == null || Boolean(value.lastFinishedJob.id)) &&
    (Array.isArray(value.activeJobs) || value.activeJob === null || isMonitorJob(value.activeJob));
}

function useSavedJobMonitor(id, isLive, status, isStale) {
  const [savedJob, setSavedJob] = useState(undefined);
  useEffect(() => {
    if (isLive) {
      setSavedJob(undefined);
      return;
    }
    const controller = new AbortController();
    const { signal } = controller;
    api('/jobs/' + encodeURIComponent(id) + '/monitor', 'GET', undefined, { signal, cache: 'no-store' }).then(result => {
      if (!signal.aborted) setSavedJob(isMonitorJob(result) && result.id === id ? result : null);
    }, () => {
      if (!signal.aborted) setSavedJob(previous => previous ?? null);
    });
    return () => controller.abort();
  }, [id, isLive, status, isStale]);
  return savedJob;
}

function useMonitor(paused, epoch, onSnapshot) {
  const [monitor, setMonitor] = useState({ snapshot: null, receivedAt: null, connection: 'connecting' });
  useEffect(() => {
    if (paused) {
      setMonitor(previous => ({ ...previous, connection: 'stale' }));
      return;
    }
    setMonitor({ snapshot: null, receivedAt: null, connection: 'connecting' });
    const silenceLimit = 25_000;
    const pollInterval = 2200;
    let disposed = false;
    let stream;
    let watchdog;
    let reconnectTimer;
    let pollTimer;
    let request;
    let live = false;
    let latestUpdatedAt = -Infinity;

    function applySnapshot(snapshot, connection) {
      latestUpdatedAt = snapshot.updatedAt;
      setMonitor({ snapshot, receivedAt: Date.now(), connection });
      onSnapshot(snapshot, epoch);
    }

    function stopPolling() {
      clearInterval(pollTimer);
      pollTimer = undefined;
      request?.abort();
      request = undefined;
    }

    async function poll() {
      if (request) return;
      const controller = new AbortController();
      request = controller;
      const timeout = setTimeout(() => controller.abort(), 2000);
      try {
        const response = await fetch('/api/monitor', { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw Error('Monitor unavailable');
        const snapshot = await response.json();
        if (!isMonitorSnapshot(snapshot)) throw Error('Invalid monitor snapshot');
        if (request !== controller || controller.signal.aborted) return;
        // A fresh, uncached poll can establish a lower baseline after a server restart.
        // Reopen the stream so frames from the previous connection cannot cross that baseline.
        if (snapshot.updatedAt < latestUpdatedAt && stream) {
          stream.close();
          stream = undefined;
          clearTimeout(watchdog);
          reconnectTimer = setTimeout(connect, 0);
        }
        applySnapshot(snapshot, 'polling');
      } catch {
        if (request === controller) setMonitor(previous => ({ ...previous, connection: 'stale' }));
      } finally {
        clearTimeout(timeout);
        if (request === controller) request = undefined;
      }
    }

    function fallBack() {
      clearTimeout(watchdog);
      stream?.close();
      stream = undefined;
      live = false;
      setMonitor(previous => previous.connection === 'stale' || !previous.snapshot
        ? previous : { ...previous, connection: 'polling' });
      if (pollTimer === undefined) {
        pollTimer = setInterval(poll, pollInterval);
        void poll();
      }
      if (typeof EventSource === 'function') reconnectTimer = setTimeout(connect, pollInterval);
    }

    function watchStream() {
      clearTimeout(watchdog);
      watchdog = setTimeout(fallBack, silenceLimit);
    }

    function connect() {
      const source = new EventSource('/api/monitor/events');
      stream = source;
      watchStream();
      source.addEventListener('snapshot', event => {
        if (disposed || stream !== source) return;
        let snapshot;
        try { snapshot = JSON.parse(event.data); } catch { return; }
        if (!isMonitorSnapshot(snapshot) || snapshot.updatedAt < latestUpdatedAt) return;
        live = true;
        stopPolling();
        watchStream();
        applySnapshot(snapshot, 'live');
      });
      source.addEventListener('heartbeat', () => {
        if (stream === source && live) watchStream();
      });
      source.addEventListener('error', () => {
        if (stream === source) fallBack();
      });
    }

    if (typeof EventSource === 'function') connect();
    else fallBack();
    return () => {
      disposed = true;
      stream?.close();
      stream = undefined;
      clearTimeout(watchdog);
      clearTimeout(reconnectTimer);
      stopPolling();
    };
  }, [paused, epoch, onSnapshot]);
  return monitor;
}

const restartUnconfirmedMessage = 'Relay ยังไม่ได้ยืนยันคำขอรีสตาร์ท';

function useRelayConnection() {
  const [data, setData] = useState(null);
  const [networkError, setNetworkError] = useState('');
  const [restart, setRestart] = useState(null);
  const [phase, setPhase] = useState(null);
  const [monitorEpoch, setMonitorEpoch] = useState(0);
  const [pending, setPending] = useState(false);
  const [requestError, setRequestError] = useState('');
  const [restartUnconfirmed, setRestartUnconfirmed] = useState(false);
  const session = useRef(null);
  const onSnapshot = useCallback((snapshot, epoch) => session.current?.receiveSnapshot(snapshot, epoch), []);
  const monitor = useMonitor(phase === 'reconnecting' || phase === 'timeout', monitorEpoch, onSnapshot);
  const approvalKey = JSON.stringify(activeMonitorJobs(monitor.snapshot).filter(job => job.approval)
    .map(({ id, approval }) => [id, approval.kind, approval.requestedAt]).sort());

  useEffect(() => {
    const checkInterval = 800;
    const checkTimeout = 2500;
    const reconnectTimeout = 20_000;
    let server;
    let currentRestart;
    let restartVersion = 0;
    let restartAt = -Infinity;
    let epoch = 0;
    let recovery;
    let timedOut = false;
    let stateRequest;
    let stateTimer;
    let actionPending = false;
    let disposed = false;

    function stopStatePoll() {
      clearTimeout(stateTimer);
      stateRequest?.abort();
      stateRequest = undefined;
    }

    function stopRecovery() {
      clearTimeout(recovery?.timer);
      recovery?.request?.abort();
      recovery = undefined;
    }

    function reopenMonitor(nextPhase) {
      timedOut = false;
      setPhase(nextPhase);
      setMonitorEpoch(++epoch);
    }

    function receiveRestart(next, version = restartVersion, snapshotAt) {
      if (!next) return;
      const updatedAt = next.updatedAt ?? -Infinity;
      // A state request or action response can arrive after a newer monitor snapshot.
      if ((next.updatedAt != null && updatedAt < restartAt) ||
          (next.updatedAt == null && snapshotAt <= restartAt) ||
          (version !== restartVersion && updatedAt <= restartAt)) return;
      if (next.status !== 'idle') setRestartUnconfirmed(false);
      if (currentRestart && ['status', 'updatedAt', 'busyCount', 'error'].every(key => currentRestart[key] === next[key])) return;
      if (next.status !== currentRestart?.status) setRequestError('');
      currentRestart = next;
      if (next.status !== 'idle') setPhase(previous => previous === 'connected' ? null : previous);
      restartAt = Math.max(restartAt, updatedAt);
      restartVersion++;
      setRestart(next);
      if (next.status === 'restarting' && !timedOut) startRecovery();
    }

    function receiveSnapshot(snapshot, snapshotEpoch) {
      if (snapshotEpoch !== epoch || recovery || timedOut) return;
      receiveRestart(snapshot.restart, restartVersion, snapshot.updatedAt);
    }

    function receiveState(next, version, recovered = false) {
      const newBoot = server?.bootId && next.server?.bootId && server.bootId !== next.server.bootId;
      const reachableAfterTimeout = timedOut && next.server?.bootId && next.restart?.status !== 'restarting';
      if (newBoot) {
        setRestartUnconfirmed(false);
        currentRestart = null;
        restartAt = -Infinity;
        restartVersion++;
        setRestart(null);
      }
      if (newBoot || recovered || reachableAfterTimeout) {
        setRequestError('');
        reopenMonitor(next.restart?.status === 'idle' ? 'connected' : null);
      }
      server = next.server ?? server;
      setData(next);
      setNetworkError('');
      receiveRestart(next.restart, newBoot || recovered ? restartVersion : version);
    }

    async function pollState() {
      if (recovery) return;
      stopStatePoll();
      const controller = new AbortController();
      stateRequest = controller;
      const version = restartVersion;
      try {
        const next = await readState(controller.signal);
        if (!controller.signal.aborted) receiveState(next, version);
      } catch (error) {
        if (controller.signal.aborted) return;
        setNetworkError(error.message);
        if (server?.bootId && !timedOut) startRecovery(true);
      }
      if (!controller.signal.aborted) stateTimer = setTimeout(pollState, 2200);
    }

    function startRecovery(connectionLost = false) {
      if (recovery || disposed) return;
      stopStatePoll();
      timedOut = false;
      setPhase('reconnecting');
      const attempt = recovery = {
        bootId: server?.bootId, connectionLost, deadline: performance.now() + reconnectTimeout
      };
      void checkHealth(attempt);
    }

    function expireRecovery() {
      stopRecovery();
      timedOut = true;
      setPhase('timeout');
      void pollState();
    }

    async function checkHealth(attempt) {
      const started = performance.now();
      const remaining = attempt.deadline - started;
      if (remaining <= 0) {
        expireRecovery();
        return;
      }
      const canReconnect = (bootId, status) => Boolean(attempt.bootId && bootId !== attempt.bootId) ||
        (status !== 'restarting' && (attempt.connectionLost || !attempt.bootId));
      const controller = new AbortController();
      attempt.request = controller;
      const timer = setTimeout(() => controller.abort(), Math.min(checkTimeout, remaining));
      try {
        const health = await api('/health', 'GET', undefined, { signal: controller.signal, cache: 'no-store' });
        if (recovery !== attempt || controller.signal.aborted) return;
        if (!health?.ok || typeof health.bootId !== 'string' || !health.bootId || !health.restart) throw Error('Invalid Relay health');
        const sameBoot = !attempt.bootId || health.bootId === attempt.bootId;
        if (sameBoot && health.restart.status === 'failed') {
          receiveRestart(health.restart);
          stopRecovery();
          setNetworkError('');
          reopenMonitor(null);
          void pollState();
          return;
        }
        if (canReconnect(health.bootId, health.restart.status)) {
          const next = await readState(controller.signal);
          if (recovery !== attempt || controller.signal.aborted) return;
          const nextBootId = next.server?.bootId;
          if (nextBootId && canReconnect(nextBootId, next.restart?.status)) {
            stopRecovery();
            receiveState(next, restartVersion, true);
            if (!recovery) stateTimer = setTimeout(pollState, 2200);
            return;
          }
        }
        attempt.bootId ??= health.bootId;
      } catch {
        if (recovery === attempt) attempt.connectionLost = true;
      } finally {
        clearTimeout(timer);
        attempt.request = undefined;
        if (recovery === attempt) {
          const now = performance.now();
          attempt.timer = setTimeout(() => { void checkHealth(attempt); },
            Math.max(0, Math.min(checkInterval - (now - started), attempt.deadline - now)));
        }
      }
    }

    async function changeRestart(cancel, jobId) {
      if (actionPending || recovery || timedOut) return;
      actionPending = true;
      setPending(true);
      setRequestError('');
      setRestartUnconfirmed(false);
      const version = restartVersion;
      const requestEpoch = epoch;
      function receiveAction(result) {
        if (requestEpoch !== epoch || disposed) return;
        if (server?.bootId && result.server?.bootId && server.bootId !== result.server.bootId) {
          void pollState();
          return;
        }
        server ??= result.server;
        receiveRestart(result.restart, version);
      }
      try {
        receiveAction(cancel ? await api('/system/restart/cancel', 'POST') :
          await api('/system/restart', 'POST', { jobId }));
      } catch (error) {
        if (disposed || epoch !== requestEpoch) return;
        if (error.data?.restart) receiveAction(error.data);
        if (!cancel && !error.status) {
          setRestartUnconfirmed(true);
          startRecovery(true);
        } else if (!error.data?.restart?.error) {
          setRequestError(error.message);
        }
      } finally {
        actionPending = false;
        if (!disposed) setPending(false);
      }
    }

    function updateManualChecks({ id, manualChecks }) {
      setData(previous => previous && {
        ...previous,
        jobs: previous.jobs.map(job => job.id === id ? { ...job, manualChecks } : job)
      });
      // Refresh after saving so any in-flight poll cannot restore an older set of checks.
      void pollState();
    }

    function updateSettings(settings) {
      setData(previous => previous && { ...previous, settings });
      void pollState();
    }

    session.current = {
      pollState, receiveSnapshot, changeRestart, updateManualChecks, updateSettings,
      retry: () => { setRequestError(''); startRecovery(true); }
    };
    return () => {
      disposed = true;
      session.current = null;
      stopStatePoll();
      stopRecovery();
    };
  }, []);

  useEffect(() => { void session.current?.pollState(); }, [approvalKey]);
  return {
    data, setData, networkError, setNetworkError, monitor,
    onSettingsUpdated: settings => session.current?.updateSettings(settings),
    onAcceptanceUpdated: result => session.current?.updateManualChecks(result),
    relayRestart: {
      restart, phase, pending, requestError, restartUnconfirmed,
      changeRestart: (cancel, jobId) => session.current?.changeRestart(cancel, jobId),
      retry: () => session.current?.retry(),
      dismiss: () => setPhase(null)
    }
  };
}

function restartWaitingMessage(busyCount) {
  return busyCount > 0
    ? 'รอให้งานค้างเสร็จก่อนรีสตาร์ท (' + busyCount + ' งาน)'
    : 'รอให้การดำเนินการปัจจุบันเสร็จก่อนรีสตาร์ท';
}

function RestartBanner({ relayRestart }) {
  const { restart, phase, pending, requestError, restartUnconfirmed, changeRestart, retry, dismiss } = relayRestart;
  const waiting = restart?.status === 'waiting';
  const timedOut = phase === 'timeout';
  const failed = restart?.status === 'failed' || Boolean(requestError);
  let tone, title, detail, Icon, action;
  if (phase === 'reconnecting') {
    tone = 'progress';
    Icon = RefreshCw;
    title = restart?.status === 'restarting' ? 'กำลังรีสตาร์ท Relay และรอเชื่อมต่อใหม่…' : 'กำลังรอเชื่อมต่อ Relay ใหม่…';
  } else if (timedOut) {
    tone = 'bad';
    Icon = TriangleExclamationPoint;
    title = 'หมดเวลารอเชื่อมต่อ Relay';
    action = <Button icon={RefreshCw} onClick={retry}>ลองเชื่อมต่อใหม่</Button>;
  } else if (waiting) {
    tone = 'warn';
    Icon = Clock;
    title = restartWaitingMessage(restart.busyCount);
    detail = requestError;
    action = <Button icon={X} onClick={() => changeRestart(true)} disabled={pending}>ยกเลิกการรอรีสตาร์ท</Button>;
  } else if (pending) {
    tone = 'progress';
    Icon = RefreshCw;
    title = 'กำลังส่งคำขอรีสตาร์ท Relay…';
  } else if (failed) {
    tone = 'bad';
    Icon = TriangleExclamationPoint;
    title = 'รีสตาร์ท Relay ไม่สำเร็จ';
    detail = restart?.error || requestError;
    action = <Button icon={RefreshCw} onClick={retry}>ลองเชื่อมต่อใหม่</Button>;
  } else if (restartUnconfirmed) {
    tone = 'warn';
    Icon = TriangleExclamationPoint;
    title = restartUnconfirmedMessage;
    detail = 'กด “รีสตาร์ท Relay ตอนนี้” ในกล่อง “อัปเดต Relay” เพื่อส่งคำขออีกครั้ง';
  } else if (phase === 'connected') {
    tone = 'ok';
    Icon = CircleCheck;
    title = 'เชื่อมต่อ Relay ใหม่เรียบร้อยแล้ว';
    action = <button type="button" className="icon-button" aria-label="ปิดแถบสถานะการเชื่อมต่อ" onClick={dismiss}><X size={18} aria-hidden="true" /></button>;
  } else {
    return null;
  }

  return <div className={'restart-banner ' + tone}>
    <Icon className="restart-banner-icon" size={19} aria-hidden="true" />
    <div className="restart-banner-message" role={tone === 'bad' ? 'alert' : 'status'}>
      <strong>{title}</strong>
      {detail ? <p>{detail}</p> : null}
      {tone === 'bad' ? <p>ตรวจข้อความในหน้าต่าง <code>start-relay.bat</code> แล้วเปิด Relay เองหากจำเป็น</p> : null}
    </div>
    {action}
  </div>;
}

function monitorStageStatus(stage) {
  if (stage.status === 'waiting') {
    return stage.action === 'wait_approval' ? 'รออนุมัติ' : stage.action === 'wait_quota' ? 'รอโควตา' : 'กำลังรอ';
  }
  if (stage.status === 'skipped') return stage.key === 'checks' ? 'ข้ามการทดสอบ' : stage.note ? 'ข้าม · ' + stage.note : 'ข้ามขั้นนี้';
  return stageStatus[stage.status] || 'ยังไม่มีข้อมูล';
}

function implementationStage(roles) {
  const statusOrder = ['running', 'retrying', 'waiting', 'failed', 'warning', 'cancelled', 'pending', 'done', 'skipped'];
  const stage = statusOrder.map(status => roles.find(role => role.status === status)).find(Boolean);
  const running = roles.filter(role => role.status === 'running').length;
  const skipped = roles.length > 1 ? roles.filter(role => role.status === 'skipped' && role.note) : [];
  const label = running && roles.length > 1 ? 'กำลังทำ ' + running + '/' + roles.length + ' ส่วน' : monitorStageStatus(stage || {});
  return {
    key: 'work', status: stage?.status,
    label: skipped.length && skipped.length < roles.length ? label + ' · ข้าม ' + skipped.map(role => monitorStageNames[role.key]).join(', ') : label
  };
}

function MonitorActivity({ activity }) {
  return <><strong>{monitorActivities[activity.code] || 'อัปเดตสถานะ'}</strong>
    {activity.provider ? <span> · {providerName(activity.provider)}</span> : null}</>;
}

const monitorTimelineKeys = ['prepare', 'plan', 'work', 'integrate', 'checks', 'review', 'delivery'];

function MonitorTimeline({ job, roles, keys = monitorTimelineKeys }) {
  const byKey = Object.fromEntries(job.stages.map(stage => [stage.key, stage]));
  return <ol className="monitor-timeline" aria-label="ขั้นตอนการทำงาน">
    {keys.filter(key => !['prepare', 'delivery'].includes(key) || byKey[key]).map(key => {
      const stage = key === 'work' ? implementationStage(roles) : byKey[key] || { key };
      const Icon = monitorStageIcons[key];
      const current = ['running', 'waiting', 'retrying'].includes(stage.status);
      const activity = job.activities.find(item => item.stageKey === key);
      return <li key={key} className={'monitor-step ' + (stage.status || 'pending')} aria-current={current ? 'step' : undefined}>
        <span className="monitor-step-icon"><Icon size={16} aria-hidden="true" /></span>
        <div>
          <strong>{key === 'work' ? 'ลงมือทำ' : monitorStageNames[key]}</strong>
          <small>{stage.label || monitorStageStatus(stage)}</small>
          {stage.action && current ? <small>{monitorActions[stage.action]}{stage.waitUntil ? ' ถึง ' + monitorTime(stage.waitUntil) : ''}</small> : null}
          {activity?.code === 'provider_fallback' && activity.provider === stage.provider ?
            <small>{monitorActivities.provider_fallback}</small> : null}
          {stage.provider ? <small>{providerName(stage.provider)}</small> : null}
          {stage.round > 0 ? <small>แก้รอบ {stage.round}</small> : null}
        </div>
      </li>;
    })}
  </ol>;
}

function MonitorFiles({ label, files, unknown, empty }) {
  return <details className="monitor-files">
    <summary>{label}{files != null ? <span>{files.length}</span> : null}</summary>
    {files?.length ? <ul>{files.map(file => <li key={file}><code>{file}</code></li>)}</ul> :
      <p>{files == null ? unknown : empty}</p>}
  </details>;
}

function MonitorRole({ stage, single, activities }) {
  const activity = activities.find(item => item.stageKey === stage.key);
  const Icon = stage.key === 'frontend' ? Layers : CodeXml;
  const skippedNote = stage.status === 'skipped' && stage.note ? stage.note : null;
  return <article className={'monitor-role ' + stage.status}>
    <header>
      <h3><Icon size={18} aria-hidden="true" />{single ? 'ลงมือทำ' : monitorStageNames[stage.key]}</h3>
      <span className="monitor-role-status">{skippedNote ? 'ข้ามขั้นนี้' : monitorStageStatus(stage)}</span>
    </header>
    {skippedNote ? <p className="monitor-role-note" role="note">{skippedNote}</p> : <p className="monitor-role-action">
      {monitorActions[stage.action] || monitorStageStatus(stage)}
      {stage.waitUntil ? <> ถึง <time dateTime={new Date(stage.waitUntil).toISOString()}>{dateTime(stage.waitUntil)}</time></> : null}
    </p>}
    {activity ? <p className="monitor-role-activity">
      <time dateTime={new Date(activity.at).toISOString()}>{monitorTime(activity.at)}</time> <MonitorActivity activity={activity} />
    </p> : null}
    <dl className="monitor-role-meta">
      <div><dt>AI</dt><dd>{stage.provider ? providerName(stage.provider) : '–'}</dd></div>
      <div><dt>รอบแก้</dt><dd>{stage.round ?? '–'}</dd></div>
      <div><dt>Branch</dt><dd><code>{stage.branch || '–'}</code></dd></div>
    </dl>
    <MonitorRoleFiles stage={stage} />
  </article>;
}

function MonitorRoleFiles({ stage }) {
  return <>
    <MonitorFiles label="ไฟล์ตามแผน" files={stage.plannedFiles} unknown="ยังไม่มีข้อมูลไฟล์ตามแผน" empty="ไม่มีไฟล์ในแผน" />
    <MonitorFiles label="ไฟล์ที่ตรวจพบว่าแก้แล้ว" files={stage.changedFiles} unknown="ยังไม่มีผลตรวจไฟล์" empty="ตรวจแล้วไม่พบการแก้ไข" />
  </>;
}

const roundLimit = 5;
const roundLabel = round => round > 1 ? 'รอบแก้ ' + (round - 1) : 'รอบแรก';
const endCodes = new Set(['completed', 'failed', 'cancelled']);

// Activities arrive newest first. Build one line per stage: a start and its finish become a single line,
// and repeated events (same stage, time and AI) are dropped.
function timelineLines(activities) {
  const seen = new Set();
  const lines = [];
  const open = new Map();
  const ordered = [...activities].sort((a, b) => a.at - b.at);
  for (const activity of ordered) {
    const sig = [activity.stageKey, activity.at, activity.provider, activity.code].join('|');
    if (seen.has(sig)) continue;
    seen.add(sig);
    if (activity.code === 'started') {
      const line = { id: activity.id, stageKey: activity.stageKey, at: activity.at, endedAt: null,
        provider: activity.provider, model: activity.model ?? null, code: 'started' };
      lines.push(line);
      open.set(activity.stageKey, line);
    } else if (endCodes.has(activity.code) && open.has(activity.stageKey)) {
      const line = open.get(activity.stageKey);
      open.delete(activity.stageKey);
      line.endedAt = activity.at;
      line.code = activity.code;
      line.provider = activity.provider ?? line.provider;
      line.model = activity.model ?? line.model;
    } else {
      lines.push({ id: activity.id, stageKey: activity.stageKey, at: activity.at, endedAt: null,
        provider: activity.provider, model: activity.model ?? null, code: activity.code });
    }
  }
  return lines.reverse();
}

function groupRounds(activities, history) {
  const map = new Map();
  const entry = round => {
    if (!map.has(round)) map.set(round, { round, activities: [], info: null });
    return map.get(round);
  };
  for (const item of Array.isArray(history) ? history : []) {
    if (Number.isInteger(item?.round) && item.round >= 1) entry(item.round).info = item;
  }
  for (const activity of activities) {
    entry(Number.isInteger(activity.round) && activity.round >= 1 ? activity.round : 1).activities.push(activity);
  }
  return [...map.values()].sort((a, b) => b.round - a.round)
    .map(group => ({ ...group, lines: timelineLines(group.activities) }));
}

function RoundSection({ group, current, single }) {
  const [all, setAll] = useState(false);
  const { round, lines, info } = group;
  const shown = all ? lines : lines.slice(0, roundLimit);
  const startedAt = info?.startedAt ?? lines.at(-1)?.at;
  const endedAt = info?.endedAt ?? (current ? null : lines[0]?.endedAt ?? lines[0]?.at);
  const status = info?.status ? statusLabels[info.status] || stageStatus[info.status] || info.status : current ? 'กำลังดำเนินการ' : 'จบแล้ว';
  const span = startedAt && endedAt ? duration(endedAt - startedAt) : '';
  return <details className="round-section" open={current ? true : undefined}>
    <summary>
      <strong>{roundLabel(round)}</strong>
      <span className="round-status">{status}</span>
      {span ? <span className="round-span">{span}</span> : null}
      <span className="round-count">{lines.length}</span>
      {info?.reason ? <span className="round-reason">สาเหตุ: {info.reason}</span> : null}
    </summary>
    {lines.length ? <ol className="round-lines">
      {shown.map(line => {
        const stage = line.stageKey === 'backend' && single ? 'ลงมือทำ' : monitorStageNames[line.stageKey] || 'งาน';
        return <li key={line.id} className={'round-line ' + line.code}>
          <time dateTime={new Date(line.at).toISOString()}>{monitorTime(line.at)}</time>
          <span className="round-line-main">
            <strong>{stage}</strong>
            <span className="round-line-result">{monitorActivities[line.code] || 'อัปเดตสถานะ'}</span>
          </span>
          <span className="round-line-meta">
            {line.provider ? <span>{providerName(line.provider)}</span> : null}
            {line.model ? <span>{line.model}</span> : null}
            {line.endedAt ? <span>{duration(line.endedAt - line.at)}</span> : null}
          </span>
        </li>;
      })}
    </ol> : <p className="muted">ยังไม่มีกิจกรรมในรอบนี้</p>}
    {lines.length > roundLimit ? <button type="button" className="link small round-more" aria-expanded={all}
      onClick={() => setAll(value => !value)}>{all ? 'ย่อ' : 'ดูทั้งหมด (' + lines.length + ')'}</button> : null}
  </details>;
}

function MonitorActivityList({ job, expanded, rounds }) {
  const groups = useMemo(() => groupRounds(job.activities, rounds ?? job.roundHistory ?? job.rounds), [job.activities, rounds, job.roundHistory, job.rounds]);
  const total = groups.reduce((sum, group) => sum + group.lines.length, 0);
  return <details className="monitor-activity-list" open={expanded ? true : undefined}>
    <summary>กิจกรรมแยกตามรอบ <span>{total}</span></summary>
    <div className="rounds">
      {groups.map((group, index) => <RoundSection key={group.round} group={group} current={index === 0} single={job.single} />)}
    </div>
  </details>;
}

function LiveMonitor({ monitor, job, fallbackJob, saved, onDetails, onApproval, showTeam, hideIdentity = false, detailJob, children }) {
  const { snapshot, receivedAt, connection } = monitor;
  const [now, setNow] = useState(Date.now);
  const latest = snapshot?.lastFinishedJob;
  const summary = job || fallbackJob || latest;
  const finishedAt = summary?.finishedAt;
  const ticking = Boolean(job?.startedAt) && !saved && finishedAt == null && connection !== 'stale';
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  const roles = job?.stages.filter(stage => workKeys.has(stage.key) && !(job.single && stage.key === 'frontend')) || [];
  const elapsed = summary?.startedAt == null || (saved && finishedAt == null) ? '' : duration(Math.max(0,
    (finishedAt ?? (connection === 'stale' ? receivedAt ?? now : Math.max(now, receivedAt ?? 0))) - summary.startedAt));
  const approval = saved ? null : job?.approval;
  return <section className="card monitor" aria-label="ติดตามงานสด">
    <header className="monitor-header">
      <h2><span><Terminal size={19} aria-hidden="true" /></span>ติดตามงานสด</h2>
      <span className={'monitor-connection' + (saved ? '' : ' ' + connection)} role="status">
        {saved ? 'ข้อมูลที่บันทึกไว้' : monitorConnections[connection]}
      </span>
    </header>
    <div className={'monitor-summary' + (hideIdentity ? ' monitor-summary-detail' : '')}>
      {!hideIdentity ? <div className="monitor-job">
        {summary ? <>
          {!job && !fallbackJob ? <small>งานล่าสุดที่จบ</small> : null}
          <h3>{summary.title}</h3>
          {summary.projectName || summary.branch ? <p className="monitor-project">
            {summary.projectName ? <span>{summary.projectName}</span> : null}
            {summary.branch ? <span><GitBranch size={14} aria-hidden="true" /><code>{summary.branch}</code></span> : null}
          </p> : null}
        </> : <h3>{snapshot ? 'ไม่มีงานที่กำลังทำ' : 'ยังไม่มีข้อมูลติดตามงาน'}</h3>}
      </div> : summary?.branch ? <p className="monitor-project">
        <span><GitBranch size={14} aria-hidden="true" /><code>{summary.branch}</code></span>
      </p> : null}
      {!hideIdentity ? <div className="monitor-summary-right">
        {summary ? <span className={'status ' + summary.status}>{statusLabels[summary.status] || 'ยังไม่มีสถานะ'}</span> : null}
        {onDetails && summary ? <button type="button" className="monitor-link" onClick={() => onDetails(summary.id)}>
          ดูรายละเอียด <ArrowRight size={15} aria-hidden="true" />
        </button> : null}
      </div> : null}
      <dl className="monitor-metrics">
        {(job && !saved) || elapsed ? <div><dt>เวลาที่ผ่านไป</dt><dd>{elapsed || '–'}</dd></div> : null}
        {finishedAt != null ? <div><dt>จบเมื่อ</dt><dd>{dateTime(finishedAt)}</dd></div> : null}
        {saved ? null : <><div><dt>ได้รับข้อมูลล่าสุด</dt><dd>{receivedAt == null ? '–' :
          <time dateTime={new Date(receivedAt).toISOString()} title={'ข้อมูลจากเซิร์ฟเวอร์ ' + dateTime(snapshot.updatedAt)}>
            {monitorTime(receivedAt)}
          </time>}</dd></div>
        <div><dt>รอในคิว</dt><dd>{snapshot ? snapshot.queuedCount + ' งาน' : '–'}</dd></div></>}
      </dl>
    </div>
    {approval ? <div className="monitor-approval">
      <div><strong>{approvalLabels[approval.kind] || 'รออนุมัติ'}</strong>
        {approval.requestedAt != null ? <small>ขออนุมัติเมื่อ {dateTime(approval.requestedAt)}</small> : null}</div>
      <Button primary icon={ArrowRight} onClick={() => onApproval(job.id)}>ไปที่แผงอนุมัติ</Button>
    </div> : null}
    {job ? <>
      <MonitorTimeline job={job} roles={roles} />
      {detailJob ? <TeamTree job={detailJob} team={detailJob.team ?? job.team} roleStages={roles} /> :
        roles.length ? <div className={'monitor-roles' + (roles.length === 1 ? ' single' : '')} key={job.id}>
        {roles.map(stage => <MonitorRole key={stage.key} stage={stage} single={job.single} activities={job.activities} />)}
      </div> : null}
      {showTeam && job.team ? <TeamTree key={'team:' + job.id} job={job} team={job.team} compact /> : null}
      {job.activities.length ? <MonitorActivityList key={job.id} job={job} expanded={Boolean(fallbackJob) && !saved} /> : null}
    </> : children}
  </section>;
}

const queueWaitLabels = {
  max_concurrency: 'รอเพดานงานพร้อมกัน',
  file_conflict: 'รอไฟล์ซ้อนกับงานอื่น',
  provider_limit: 'รอเพดานการเรียก AI',
  merge_lock: 'รอคิว merge'
};

function queueWait(job) {
  const reason = job.waitReason;
  const code = typeof reason === 'string' ? reason : reason?.code ?? reason?.reason;
  const label = Object.hasOwn(queueWaitLabels, code) ? queueWaitLabels[code] : null;
  if (job.merged || !label) return null;
  return {
    code, label,
    conflictingJobId: reason?.conflictingJobId ?? reason?.metadata?.conflictingJobId ?? job.conflictingJobId,
    conflictingFiles: reason?.conflictingFiles ?? reason?.metadata?.conflictingFiles ?? job.conflictingFiles,
    provider: reason?.provider ?? reason?.metadata?.provider ?? job.waitingProvider ?? job.waitProvider
  };
}

const isQueueWaiting = job => job.status === 'queued' || Boolean(queueWait(job));
const isQueueActive = job => activeStatuses.has(job.status) && !isQueueWaiting(job);

// Four numbers that answer "what needs me now?"; each tile jumps to the matching list.
function Kpis({ jobs, onFilter, onApproval }) {
  const running = jobs.filter(job => isQueueActive(job) && job.status !== 'waiting_approval').length;
  const waiting = jobs.filter(job => job.status === 'waiting_approval');
  const queued = jobs.filter(isQueueWaiting).length;
  const review = jobs.filter(job => doneStatuses.has(job.status) && !job.merged && !isQueueWaiting(job)).length;
  const tiles = [
    { key: 'running', label: 'กำลังทำ', value: running, icon: Layers, tone: running ? 'brand' : '', action: () => onFilter('running') },
    { key: 'waiting', label: 'รอคุณอนุมัติ', value: waiting.length, icon: TriangleExclamationPoint, tone: waiting.length ? 'warn' : '',
      action: () => waiting.length ? onApproval(waiting[0].id) : onFilter('running') },
    { key: 'queued', label: 'รอคิว', value: queued, icon: Clock, tone: '', action: () => onFilter('queued') },
    { key: 'review', label: 'รอตรวจและ merge', value: review, icon: CircleCheck, tone: review ? 'success' : '', action: () => onFilter('done') }
  ];
  return <div className="kpis">{tiles.map(({ key, label, value, icon: Icon, tone, action }) =>
    <button key={key} type="button" className={'kpi ' + tone} onClick={action}>
      <span className="kpi-icon"><Icon size={18} aria-hidden="true" /></span>
      <span><strong>{value}</strong><small>{label}</small></span>
    </button>)}</div>;
}

// One line per AI: connection, the tightest quota window and when it resets.
function AiStatus({ quotas, reserve, onMore }) {
  const now = Date.now();
  return <section className="card ai-status">
    <header className="card-head"><h2>AI ที่พร้อมใช้</h2><button type="button" className="link" onClick={onMore}>ดูโควตาทั้งหมด</button></header>
    <ul>{Object.entries(providers).map(([id, model]) => {
      const info = quotas?.[id];
      const windows = (info?.windows || []).filter(window => !window.resetAt || window.resetAt > now).sort((a, b) => a.remaining - b.remaining);
      const tight = windows[0];
      const low = tight && tight.remaining <= (reserve[id] ?? 0);
      return <li key={id}>
        <ProviderIcon id={id} size={16} />
        <div className="ai-status-main">
          <div className="ai-status-line"><strong>{model.name}</strong>
            <span className={'dot ' + (info?.cooldownUntil > now ? 'warn' : info?.ready ? 'ok' : 'off')}>{info?.cooldownUntil > now ? 'พักถึง ' + time(info.cooldownUntil) : info?.ready ? 'พร้อม' : 'ไม่พร้อม'}</span></div>
          {tight ? <div className="mini-bar" title={tight.label}><span className={id + (low ? ' low' : '')} style={{ width: tight.remaining + '%' }} /></div> : null}
          <small>{tight ? Math.round(tight.remaining) + '% · ' + tight.label + (tight.resetAt ? ' · รีเซ็ต ' + time(tight.resetAt) : '') : info?.note || 'ไม่มีข้อมูลโควตา'}</small>
        </div>
      </li>;
    })}</ul>
  </section>;
}

function jobProviders(job) {
  return [...new Set(Object.values(job.stages || {}).map(stage => stage.provider).filter(id => providers[id]))];
}

function queueStage(job, active) {
  const name = key => stageName(job, key) || monitorStageNames[key];
  const current = name(active?.stage ?? active?.currentStage);
  if (current) return current;
  const entries = active?.stages ?? job.stages ?? {};
  const stages = Array.isArray(entries) ? entries : Object.entries(entries).map(([key, stage]) => ({ key, ...stage }));
  const labels = stages.filter(stage => ['running', 'waiting', 'retrying'].includes(stage.status) && name(stage.key))
    .map(stage => name(stage.key) + (stage.status === 'running' ? '' : ' · ' + monitorStageStatus(stage)));
  return labels.join(' / ') || name(job.stage);
}

function QueueWait({ wait, jobsById }) {
  const { code, label, conflictingJobId, conflictingFiles, provider } = wait;
  const blocker = jobsById.get(conflictingJobId)?.title || conflictingJobId;
  return <span className="queue-wait">
    <span><Clock size={14} aria-hidden="true" />{label}{code === 'provider_limit' && provider ? ' · ' + providerName(provider) : ''}</span>
    {code === 'file_conflict' && blocker ? <span>งานที่ใช้ไฟล์อยู่ · {blocker}</span> : null}
    {code === 'file_conflict' && Array.isArray(conflictingFiles) && conflictingFiles.length ?
      <span>ไฟล์ที่ซ้อนกัน · {conflictingFiles.map((file, index) => <React.Fragment key={file}>{index ? ', ' : ''}<code>{file}</code></React.Fragment>)}</span> : null}
  </span>;
}

function Queue({ jobs, activeById, projects = [], filter, setFilter, select, create, hasProjects, addProject }) {
  const filters = [['all', 'ทั้งหมด'], ['running', 'กำลังทำ'], ['queued', 'รอคิว'], ['done', 'เสร็จแล้ว'], ['stuck', 'ติดขัด']];
  const matches = (job, id) => {
    if (id === 'all') return true;
    if (id === 'queued') return isQueueWaiting(job);
    if (id === 'running') return isQueueActive(job);
    if (id === 'done') return !isQueueWaiting(job) && doneStatuses.has(job.status);
    return stuckStatuses.has(job.status);
  };
  const priority = job => isQueueActive(job) ? 0 : isQueueWaiting(job) ? 1 : 2;
  const items = [...jobs].reverse().filter(job => matches(job, filter)).sort((a, b) => priority(a) - priority(b));
  const jobsById = new Map(jobs.map(job => [job.id, job]));
  const projectOf = job => projects.find(project => samePath(project.path, job.repo))?.name || repoName(job.repo);
  return <section className="card queue">
    <header className="card-head"><h2>งานทั้งหมด</h2></header>
    <div className="filters" aria-label="ตัวกรองคิว">{filters.map(([id, label]) => {
      const count = jobs.filter(job => matches(job, id)).length;
      return <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}{count ? <span className="count">{count}</span> : null}</button>;
    })}</div>
    {items.length ? <ul className="jobs">{items.map(job => {
      const wait = queueWait(job);
      const active = activeById.get(job.id);
      const stage = isQueueActive(job) || activeById.has(job.id) ? queueStage(job, active) : null;
      const status = wait ? 'queued' : job.status;
      return <li key={job.id}>
        <button type="button" className={'job-row is-' + status} onClick={() => select(job.id)}>
          <span className="job-main">
            <strong>{job.title}</strong>
            <small>{projectOf(job)} · {dateTime(job.createdAt)}{job.startedAt ? ' · ' + jobDuration(job) : ''}</small>
          </span>
          <span className="job-ais">{jobProviders(job).map(id => <span key={id} title={providers[id].name}><ProviderIcon id={id} size={13} /></span>)}</span>
          <span className="job-tags">{(() => {
            const badge = wait ? { status, label: 'รอคิว' } : getJobStatusBadge(job);
            return <span className={'status ' + badge.status}>{badge.label}</span>;
          })()}</span>
          <ArrowRight className="job-arrow" size={16} aria-hidden="true" />
          {stage ? <span className="queue-stage">ขั้นตอน · {stage}</span> : null}
          {wait ? <QueueWait wait={wait} jobsById={jobsById} /> : null}
        </button>
      </li>;
    })}</ul> : <div className="empty">
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
    return { title: source.title || '', repo: source.repo || '', prompt: source.prompt || '', runChecks: Boolean(source.runChecks),
      type: source.type || 'feature', approvePlan: Boolean(source.approvalGates?.includes('after_plan') ?? source.approvePlan) };
  }, [previous]);
  const [form, setForm] = useState(initial);
  const [override, setOverride] = useState(Boolean(previous?.settings) && JSON.stringify(previous.settings.routes) !== JSON.stringify(settings.routes));
  const [routes, setRoutes] = useState(structuredClone(previous?.settings?.routes || settings.routes));
  const [repoInfo, setRepoInfo] = useState(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [mode, setMode] = useState('form');
  const [cardText, setCardText] = useState('');
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
    if (mode === 'form' && override && hasDuplicate(routes)) { setError('ตัวหลักและตัวสำรองต้องไม่ซ้ำกัน'); return; }
    let card;
    if (mode === 'card') {
      try { card = JSON.parse(cardText); } catch (error) { setError('JSON ไม่ถูกต้อง: ' + error.message); return; }
    }
    setPending(true);
    setError('');
    try {
      if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
      const job = mode === 'card' ? await api('/cards', 'POST', { card: { ...card, source: card.source || { kind: 'paste' } } }) :
        await api('/jobs', 'POST', { title: form.title, repo: form.repo, prompt: form.prompt, runChecks: form.runChecks, type: form.type,
          approvals: form.approvePlan ? ['after_plan'] : [], routes: override ? routes : undefined, fromJob: previous?.id,
          cardFrom: previous?.card ? previous.cardFrom ?? previous.id : undefined });
      if (!previous?.title) writeStorage(draftKey, null);
      created(job);
    } catch (error) { setError(error.message); setPending(false); }
  }
  const limit = previous?.card ? Math.max(20_000, previous.prompt?.length || 0) : promptLimit;
  const canReusePlan = previous?.plan && previous.prompt === form.prompt.trim();
  const resumable = previous?.stages?.backend?.status === 'done' && previous?.stages?.frontend?.status === 'done' && (previous.worktree || previous.branchKept);
  return <div className="overlay">
    <form role="dialog" aria-modal="true" aria-labelledby="create-title" className="card dialog" onSubmit={submit}>
      <header><h2 id="create-title">{previous?.title ? 'สร้างงานจากโจทย์เดิม' : 'สร้างงาน'}</h2>
        <button title="ปิด" aria-label="ปิด" className="icon-button" type="button" onClick={close} disabled={pending}><X size={22} /></button>
      </header>
      {previous?.title ? null : <div className="filters" aria-label="วิธีสร้างงาน">
        <button type="button" aria-pressed={mode === 'form'} onClick={() => { setMode('form'); setError(''); }}>กรอกเอง</button>
        <button type="button" aria-pressed={mode === 'card'} onClick={() => { setMode('card'); setError(''); }}>วาง Task Card</button>
      </div>}
      {mode === 'card' ? <>
        <label>Task Card (JSON)<textarea className="card-json" required rows={14} value={cardText} spellCheck={false}
          placeholder={'{\n  "title": "…",\n  "project": "ชื่อโปรเจกต์ใน Relay",\n  "goal": "…",\n  "acceptance": [{ "text": "…", "check": "command", "command": "…" }]\n}'}
          onChange={event => setCardText(event.target.value)} /></label>
        <small>วาง Task Card ที่ได้จาก Chat ฟิลด์ที่จำเป็นคือ title, project และ goal ส่วน acceptance แบบ command Relay จะรันเป็นคำสั่งทดสอบให้</small>
      </> : <>
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
      <label>โจทย์และเกณฑ์รับงาน<textarea required name="prompt" maxLength={limit} rows={6} placeholder="ระบุสิ่งที่ต้องการให้ AI ทำและวิธีตรวจว่าเสร็จแล้ว" value={form.prompt} onChange={event => set('prompt', event.target.value)} /></label>
      <small className={'counter' + (form.prompt.length > limit * 0.9 ? ' warn-text' : '')}>{form.prompt.length.toLocaleString()} / {limit.toLocaleString()} ตัวอักษร{previous?.title ? '' : ' · บันทึกร่างอัตโนมัติ'}</small>
      {previous?.card ? <p className="repo-info">ใช้ค่าจาก Task Card เดิมด้วย: {[
        previous.scope ? 'ขอบเขตไฟล์' : null,
        previous.checkCommands?.length ? 'คำสั่งตรวจ ' + previous.checkCommands.length + ' คำสั่ง' : null,
        previous.pinned ? 'AI ที่ต้องการ' : null,
        previous.cardSubtasks ? 'งานย่อยที่กำหนดเอง' : null,
        previous.card.routing?.budget_usd !== undefined ? 'งบของการ์ด' : null
      ].filter(Boolean).join(' · ') || 'ที่มาของการ์ด'}</p> : null}
      {canReusePlan ? <p className="repo-info">{resumable ?
        'ทำต่อจากจุดที่ค้างได้ ถ้า repo ยังอยู่ที่ commit เดิม Relay จะใช้แผนและผล Backend / Frontend เดิม แล้วไปขั้นทดสอบและรีวิวต่อ' :
        'ใช้แผนจากงานเดิมได้ ถ้า repo ยังอยู่ที่ commit เดิม Relay จะข้ามขั้นวางแผนเพื่อประหยัดโควตา'}</p> : null}
      <label>ประเภทงาน<select value={form.type} onChange={event => set('type', event.target.value)}>
        {Object.entries(jobTypes).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select></label>
      <label className="checkbox"><input type="checkbox" checked={form.approvePlan} onChange={event => set('approvePlan', event.target.checked)} />หยุดให้ฉันตรวจและอนุมัติแผนก่อนลงมือแก้โค้ด</label>
      <label className="checkbox"><input type="checkbox" name="runChecks" checked={form.runChecks} onChange={event => set('runChecks', event.target.checked)} />
        {chosenProject?.checks?.length ? 'รันคำสั่งทดสอบของโปรเจกต์ (' + chosenProject.checks.length + ' คำสั่ง) และให้ AI แก้จนผ่าน' : 'รัน npm test และ build ที่มีใน repo นี้ และให้ AI แก้จนผ่าน'}</label>
      <small>เลือกสำหรับ repo ที่คุณไว้วางใจ แอปอาจติดตั้ง dependencies จาก lockfile และรันโค้ดที่เพิ่งแก้บนเครื่อง</small>
      <details className="advanced" open={override} onToggle={event => setOverride(event.currentTarget.open)}>
        <summary>เลือก AI เฉพาะงานนี้ (งานนี้จะไม่ใช้การเลือกอัตโนมัติ)</summary>
        <RouteTable routes={routes} quotas={quotas} label="AI สำหรับงานนี้" onChange={(role, index, value) => setRoutes(current => updateRoutes(current, role, index, value))} />
      </details>
      </>}
      {error ? <p role="alert" className="error">{error}</p> : null}
      <footer><Button disabled={pending} onClick={close}>ยกเลิก</Button><button type="submit" className="button primary" disabled={pending}>{pending ? 'กำลังเพิ่มงาน…' : 'เพิ่มเข้าคิว'}</button></footer>
    </form>
  </div>;
}

const profileNames = { balanced: 'สมดุล', fast: 'เร็วที่สุด', cheap: 'ประหยัดที่สุด' };
const profileHints = {
  balanced: 'สมดุล: ให้น้ำหนักความเหมาะกับขั้น โควตา และอัตราสำเร็จเป็นหลัก',
  fast: 'เร็วที่สุด: ให้น้ำหนักความเร็วที่วัดได้จริงมากขึ้น เหมาะเมื่อมีคนรอผล',
  cheap: 'ประหยัดที่สุด: เลือก AI ที่โควตาเหลือมากและต้นทุนต่ำก่อน เก็บโควตาของตัวที่เหลือน้อยไว้'
};
const factorLabels = { fit: 'เหมาะกับขั้น', quota: 'โควตา', success: 'อัตราสำเร็จ', speed: 'ความเร็ว', cost: 'ต้นทุน' };

function ScoreBars({ row }) {
  return <span className="score-bars" title={Object.entries(row.parts).map(([key, value]) => factorLabels[key] + ' ' + value).join(' · ')}>
    {Object.entries(row.parts).map(([key, value]) => <i key={key} style={{ height: Math.max(8, value * 100) + '%' }} />)}
  </span>;
}

function adjustText(row) {
  return [row.adjust?.independence ? 'ตัดคะแนนเพราะเป็นตัวที่เขียนโค้ด' : '', row.adjust?.spread ? 'ตัดคะแนนเพราะซ้ำกับส่วนที่ทำพร้อมกัน' : ''].filter(Boolean).join(' · ');
}

// What automatic routing would choose for each role right now, from the saved settings.
function RoutingPreview({ refreshKey }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    api('/routing/preview').then(result => { if (live) { setData(result); setError(''); } }, failure => { if (live) setError(failure.message); });
    return () => { live = false; };
  }, [refreshKey]);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">กำลังโหลดตัวอย่างการเลือก…</p>;
  const enough = data.stats.filter(item => item.n >= data.minSamples).length;
  return <div className="routing-preview">
    <h3>ถ้าสั่งงานตอนนี้ Relay จะเลือก</h3>
    <div className="table-scroll"><table className="steps">
      <thead><tr><th>ขั้น</th><th>อันดับ 1</th><th>อันดับ 2</th><th>อันดับ 3</th></tr></thead>
      <tbody>{Object.entries(roleNames).map(([role, label]) => {
        const { ranking, skipped } = data.roles[role];
        return <tr key={role}>
          <td>{label}</td>
          {[0, 1, 2].map(index => <td key={index} className={index === 0 ? 'wrap' : undefined}>{ranking[index] ? <><strong>{providerName(ranking[index].provider)}</strong> {ranking[index].score} <ScoreBars row={ranking[index]} /></> : index ? '–' : 'ไม่มี AI ที่พร้อมใช้'}
            {index === 0 && ranking[0]?.reason ? <small>{ranking[0].reason}</small> : null}
            {index === 0 && skipped.length ? <small>ข้าม: {skipped.map(item => providerName(item.provider) + ' (' + item.reason + ')').join(', ')}</small> : null}</td>)}
        </tr>;
      })}</tbody>
    </table></div>
    <p className="muted">แท่งสีเล็กๆ คือคะแนนย่อย (เหมาะกับขั้น · โควตา · อัตราสำเร็จ · ความเร็ว · ต้นทุน) เอาเมาส์ชี้เพื่อดูตัวเลข ข้อมูลที่ใช้: {data.stats.length} คู่ AI/ขั้นที่เคยทำ มี {enough} คู่ที่ข้อมูลพอให้ใช้สถิติจริง ที่เหลือใช้ค่าตั้งต้น คำนวณจากค่าที่บันทึกแล้ว</p>
  </div>;
}

const modelRoles = [
  ['default', 'ค่าเริ่มต้นของ AI'],
  ['plan', roleNames.plan],
  ['implement', 'ลงมือทำ'],
  ['review', roleNames.review],
  ['check', 'ตรวจงานย่อย']
];
const modelProviderIds = ['claudecode', 'codex', 'gemini'];
const modelIdLimit = 120;

function ModelSettings({ models, onChange, saving }) {
  const [suggestions, setSuggestions] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    api('/models', 'GET', undefined, { signal, cache: 'no-store' }).then(
      result => { if (!signal.aborted) setSuggestions(result ?? {}); },
      () => { if (!signal.aborted) setSuggestions({}); }
    );
    return () => controller.abort();
  }, []);

  const suggestionsByProvider = Object.fromEntries(modelProviderIds.map(id => {
    const list = Array.isArray(suggestions?.[id]) ? suggestions[id] : [];
    const validIds = list.filter(model => typeof model === 'string' && model.length > 0 && model.length <= modelIdLimit);
    return [id, [...new Set(validIds)]];
  }));
  return <section className="model-settings" aria-labelledby="model-settings-title">
    <h2 id="model-settings-title">โมเดล</h2>
    <p className="muted" id="model-settings-help">เลือกจากรายการแนะนำหรือพิมพ์ชื่อโมเดลเอง ล้างช่องเพื่อกลับเป็นอัตโนมัติ
      บทบาทที่ตั้งเป็นอัตโนมัติจะใช้ค่าเริ่มต้นของ AI ถ้าตั้งไว้</p>
    <div className="model-list-status muted" role="status">
      {suggestions === null ? 'กำลังโหลดรายชื่อโมเดลแนะนำ…' :
        Object.values(suggestionsByProvider).every(list => list.length === 0) ? 'ยังไม่มีรายการแนะนำ พิมพ์ชื่อโมเดลเองได้' : null}
    </div>
    <table className="model-table" role="table" aria-labelledby="model-settings-title" aria-describedby="model-settings-help">
      <thead role="rowgroup"><tr role="row">
        <th role="columnheader" scope="col">AI</th>
        {modelRoles.map(([role, label]) => <th key={role} role="columnheader" scope="col">{label}</th>)}
      </tr></thead>
      <tbody role="rowgroup">{modelProviderIds.map(id => {
        const name = providerName(id);
        const list = suggestionsByProvider[id];
        const listId = 'model-list-' + id;
        return <tr role="row" key={id}>
          <th role="rowheader" scope="row"><span className="model-provider"><ProviderIcon id={id} size={15} />{name}</span></th>
          {modelRoles.map(([role, label]) => <td key={role} role="cell">
            <span className="model-role-label" aria-hidden="true">{label}</span>
            <input type="text" aria-label={name + ' · ' + label} placeholder="อัตโนมัติ"
              list={list.length ? listId : undefined} value={models?.[id]?.[role] ?? ''}
              maxLength={modelIdLimit} autoComplete="off" autoCapitalize="none" spellCheck={false}
              readOnly={saving} onChange={event => onChange(id, role, event.target.value)} />
          </td>)}
        </tr>;
      })}</tbody>
    </table>
    {modelProviderIds.map(id => <datalist key={id} id={'model-list-' + id}>
      {suggestionsByProvider[id].map(model => <option key={model} value={model} />)}
    </datalist>)}
  </section>;
}

function ConcurrencySettings({ concurrency, setConcurrency, setProviderLimit, saving }) {
  return <section className="concurrency-settings" aria-labelledby="concurrency-title">
    <h2 id="concurrency-title">การทำงานพร้อมกัน</h2>
    <label className="settings-field concurrency-max">จำนวนงานสูงสุดที่ทำพร้อมกัน
      <select value={concurrency.maxJobs} disabled={saving}
        onChange={event => setConcurrency('maxJobs', Number(event.target.value))}>
        <option value={1}>1 งาน (ทำทีละงาน)</option>
        {[2, 3, 4].map(count => <option key={count} value={count}>{count} งาน</option>)}
      </select>
    </label>
    <label className="checkbox concurrency-plan">
      <input type="checkbox" role="switch" className="settings-switch" checked={concurrency.planAhead} disabled={saving}
        aria-describedby="plan-ahead-help" onChange={event => setConcurrency('planAhead', event.target.checked)} />
      วางแผนงานถัดไปล่วงหน้า
    </label>
    <p id="plan-ahead-help" className="muted">ให้ Relay เริ่มวางแผนงานถัดไประหว่างที่งานก่อนหน้ากำลังทดสอบหรือรีวิว</p>
    <fieldset className="provider-limits">
      <legend>เพดานการเรียกพร้อมกันต่อ AI</legend>
      <p id="provider-limit-help" className="muted">เว้นว่างหากไม่ต้องการตั้งเพดานให้ AI ตัวนั้น</p>
      <div className="settings-grid">
        {Object.entries(providers).map(([id, provider]) => <label key={id}>{provider.name}
          <input type="number" min={1} step={1} value={concurrency.perProvider[id] ?? ''} disabled={saving}
            aria-describedby="provider-limit-help" placeholder="ไม่ระบุ"
            onChange={event => setProviderLimit(id, event.target.value)} />
        </label>)}
      </div>
    </fieldset>
  </section>;
}

function withSettingsDefaults(settings) {
  const team = settings.team;
  return {
    ...settings,
    models: settings.models ?? {},
    concurrency: {
      maxJobs: settings.concurrency?.maxJobs ?? 1,
      planAhead: settings.concurrency?.planAhead ?? true,
      perProvider: settings.concurrency?.perProvider ?? {}
    },
    selfUpdate: {
      ...settings.selfUpdate,
      autoRestart: settings.selfUpdate?.autoRestart === true
    },
    team: {
      ...team,
      mode: team?.mode ?? 'auto',
      maxSubtasks: team?.maxSubtasks ?? 4,
      parallel: team?.parallel ?? 2,
      check: team?.check ?? 'always'
    }
  };
}

function SettingsForm({ initial: storedSettings, changed, quotas, onDirty }) {
  const initial = withSettingsDefaults(storedSettings);
  const [draft, setDraft] = useState(initial);
  const [notice, setNotice] = useState(null);
  const [saving, setSaving] = useState(false);
  const [section, setSection] = useState('routing');
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const duplicate = hasDuplicate(draft.routes);
  const setAuto = (key, value) => setDraft(current => ({ ...current, auto: { ...current.auto, [key]: value } }));
  const setBudget = (key, value) => setDraft(current => ({ ...current, budget: { ...current.budget, [key]: value } }));
  function setModel(provider, role, value) {
    setNotice(null);
    setDraft(current => {
      const models = { ...current.models };
      const roles = { ...models[provider] };
      if (value === '') delete roles[role];
      else roles[role] = value;
      if (Object.keys(roles).length) models[provider] = roles;
      else delete models[provider];
      return { ...current, models };
    });
  }
  const { team, concurrency } = draft;
  function setConcurrency(key, value) {
    setNotice(null);
    setDraft(current => ({ ...current, concurrency: { ...current.concurrency, [key]: value } }));
  }
  function setProviderLimit(id, value) {
    setNotice(null);
    setDraft(current => {
      const perProvider = { ...current.concurrency.perProvider };
      if (value === '') delete perProvider[id];
      else perProvider[id] = Number(value);
      return { ...current, concurrency: { ...current.concurrency, perProvider } };
    });
  }
  const setTeam = (key, value) => setDraft(current => ({ ...current, team: { ...current.team, [key]: value } }));
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  async function submit(event) {
    event.preventDefault();
    if (saving || !dirty || duplicate) return;
    if (Object.values(concurrency.perProvider).some(value => !Number.isSafeInteger(value) || value < 1)) {
      setSection('concurrency');
      setNotice({ text: 'เพดานต่อ AI ต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป หรือเว้นว่าง', error: true });
      return;
    }
    setNotice(null); setSaving(true);
    try {
      const saved = await api('/settings', 'PUT', draft);
      changed(saved);
      const next = withSettingsDefaults(saved);
      if (!saved.concurrency && JSON.stringify(concurrency) !== JSON.stringify(initial.concurrency)) {
        setDraft({ ...next, concurrency });
        setNotice({ text: 'เซิร์ฟเวอร์ยังไม่ยืนยันการบันทึกค่าการทำงานพร้อมกัน', error: true });
        return;
      }
      setDraft(next);
      setNotice({ text: 'บันทึกการตั้งค่าแล้ว' });
    } catch (error) { setNotice({ text: error.message, error: true }); }
    finally { setSaving(false); }
  }
  const routing = draft.routing || { mode: 'auto', profile: 'balanced', minSamples: 5 };
  const setRouting = (key, value) => setDraft(current => ({ ...current, routing: { ...routing, [key]: value } }));
  const table = <RouteTable routes={draft.routes} quotas={quotas} label="การมอบหมายงาน" onChange={(role, index, value) => setDraft(current => ({ ...current, routes: updateRoutes(current.routes, role, index, value) }))} />;
  const sections = [['routing', 'การจ่ายงาน', 'Relay เลือก AI ให้แต่ละขั้นอย่างไร'], ['models', 'โมเดล', 'เลือกโมเดลแยกตาม AI และบทบาท'],
    ['concurrency', 'การทำงานพร้อมกัน', 'จำนวนงาน วางแผนล่วงหน้า และเพดานต่อ AI'],
    ['quota', 'โควตาและรอบแก้', 'กันโควตาไว้ใช้รีวิว และจำนวนรอบแก้'],
    ['edit', 'การแก้โค้ดและอนุมัติ', 'ให้ AI แก้ไฟล์เอง และจุดหยุดรออนุมัติ'], ['budget', 'งบ', 'หยุดรออนุมัติเมื่อถึงงบ'],
    ['auto', 'ทำงานต่อเนื่อง', 'ลองซ้ำ รอโควตา และเวลาสูงสุด'], ['self-update', 'อัปเดต Relay', 'ตั้งค่าการรีสตาร์ทหลัง merge']];
  const show = key => section === key;
  return <form className={'settings-layout' + (show('models') ? ' show-models' : '')} onSubmit={submit}>
    <nav className="card settings-nav" aria-label="หมวดการตั้งค่า">{sections.map(([key, label, hint]) =>
      <button key={key} type="button" aria-current={section === key ? 'page' : undefined} onClick={() => setSection(key)}><strong>{label}</strong><small>{hint}</small></button>)}</nav>
    <div className="card settings">
    {show('routing') ? <>
    <h2>การจ่ายงาน</h2>
    <div className="filters" aria-label="โหมดการจ่ายงาน">
      <button type="button" aria-pressed={routing.mode === 'auto'} onClick={() => setRouting('mode', 'auto')}>อัตโนมัติ (Relay เลือกให้)</button>
      <button type="button" aria-pressed={routing.mode === 'fixed'} onClick={() => setRouting('mode', 'fixed')}>กำหนดเอง</button>
    </div>
    {routing.mode === 'auto' ? <>
      <p className="muted">Relay ให้คะแนน AI ทุกตัวที่พร้อมใช้ในแต่ละขั้น แล้วเลือกตัวที่คะแนนสูงสุด ไม่ต้องเรียก AI ช่วยเลือก จึงไม่เสียโควตา ตัวที่เหลือเรียงเป็นตัวสำรองตามลำดับคะแนน คะแนนมาจากความเหมาะกับขั้นนั้น โควตาที่เหลือ อัตราสำเร็จและความเร็วจริง ต้นทุน และขั้นรีวิวจะเลี่ยง AI ที่เขียนโค้ดงานนั้น</p>
      <div className="settings-grid">
        <label>โปรไฟล์<select value={routing.profile} onChange={event => setRouting('profile', event.target.value)}>
          {Object.entries(profileNames).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        <label>ใช้สถิติจริงเมื่อมีข้อมูลอย่างน้อย (ครั้งต่อ AI ต่อขั้น)<input type="number" required min="1" max="50" value={routing.minSamples} onChange={event => setRouting('minSamples', Number(event.target.value))} /></label>
      </div>
      <p className="muted">{profileHints[routing.profile]}</p>
      <RoutingPreview refreshKey={JSON.stringify(initial.routing) + JSON.stringify(initial.reserve)} />
      <details className="advanced"><summary>ตารางกำหนดเอง (ใช้เมื่อเลือกโหมดกำหนดเอง)</summary>{table}</details>
    </> : <>
      <p className="muted">Relay ใช้ตัวหลักก่อน ถ้าตัวหลักยังไม่เชื่อมต่อ โควตาต่ำกว่าที่กันไว้ หรือเรียกไม่สำเร็จ จะเปลี่ยนไปใช้ตัวสำรอง</p>
      {table}
    </>}
    </> : null}
    {show('models') ? <ModelSettings models={draft.models} onChange={setModel} saving={saving} /> : null}
    {show('concurrency') ? <ConcurrencySettings concurrency={concurrency} setConcurrency={setConcurrency}
      setProviderLimit={setProviderLimit} saving={saving} /> : null}
    {show('quota') ? <>
    <h2>โควตาและรอบแก้</h2>
    <p className="muted">ในขั้นวางแผน Backend และ Frontend Relay จะข้าม AI ที่โควตาคงเหลือต่ำกว่าค่านี้ เพื่อเก็บโควตาไว้ใช้ในขั้นรีวิว หลอดโควตาจะมีเส้นบอกระดับนี้</p>
    <div className="settings-grid">
      {Object.entries(providers).map(([id, model]) => <label key={id}>กันโควตา {model.name} (%)<input type="number" required min="0" max="99" value={draft.reserve[id]} onChange={event => setDraft({ ...draft, reserve: { ...draft.reserve, [id]: Number(event.target.value) } })} /></label>)}
      <label>เพดาน Gemini ต่อวัน (0 = ยังไม่ระบุ)<input type="number" required min="0" max="1000000" value={draft.geminiDailyLimit} onChange={event => setDraft({ ...draft, geminiDailyLimit: Number(event.target.value) })} /></label>
      <label>จำนวนรอบแก้สูงสุด<input type="number" required min="0" max="6" value={draft.maxRounds} onChange={event => setDraft({ ...draft, maxRounds: Number(event.target.value) })} /></label>
    </div>
    </> : null}
    {show('edit') ? <>
    <h2>การแก้โค้ดและการอนุมัติ</h2>
    <label className="checkbox"><input type="checkbox" checked={draft.agentEdits !== false} onChange={event => setDraft({ ...draft, agentEdits: event.target.checked })} />ให้ Claude Code และ Codex แก้ไฟล์เองใน worktree ของงาน (เห็นทั้ง repo แก้ไฟล์ใหญ่ได้ตรงจุด) Gemini ยังส่งผลเป็น JSON</label>
    <label className="checkbox"><input type="checkbox" checked={draft.approvals?.afterPlan} onChange={event => setDraft({ ...draft, approvals: { ...draft.approvals, afterPlan: event.target.checked } })} />ทุกงาน: หยุดให้ฉันอนุมัติแผนก่อนลงมือแก้โค้ด</label>
    <h2 className="section-gap">ทำงานเป็นทีม</h2>
    <p className="muted">ผู้วางแผนประเมินความยากของงาน งานง่ายทำรวดเดียว งานระดับกลางและงานยากจะแบ่งเป็นงานย่อยของแต่ละฝั่ง งานย่อยที่ไม่ต้องรอกันทำพร้อมกันได้</p>
    <div className="settings-grid">
      <label>แบ่งงานย่อย
        <select value={team.mode} onChange={event => setTeam('mode', event.target.value)}>
          <option value="auto">อัตโนมัติตามความยาก</option>
          <option value="off">ปิด ทำทั้งฝั่งรวดเดียว</option>
        </select>
      </label>
      <label>งานย่อยสูงสุดต่อฝั่ง<input type="number" required min="2" max="6" disabled={team.mode === 'off'} value={team.maxSubtasks}
        onChange={event => setTeam('maxSubtasks', Number(event.target.value))} /></label>
      <div className="settings-field">
        <label htmlFor="team-parallel">งานย่อยที่ทำพร้อมกันต่อฝั่ง</label>
        <select id="team-parallel" aria-describedby="team-parallel-help" value={team.parallel}
          onChange={event => setTeam('parallel', Number(event.target.value))}>
          <option value={1}>1</option>
          <option value={2}>2 (ค่าเริ่มต้น)</option>
          <option value={3}>3</option>
        </select>
        <small id="team-parallel-help">เลือก 1 เพื่อทำงานทีละชิ้นตามลำดับเหมือนเดิม</small>
      </div>
      <div className="settings-field">
        <label htmlFor="team-check">ให้หัวหน้าตรวจงานย่อยเมื่อไร</label>
        <select id="team-check" aria-describedby="team-check-help" value={team.check}
          onChange={event => setTeam('check', event.target.value)}>
          <option value="always">ตรวจทุกงานย่อย (ค่าเริ่มต้น)</option>
          <option value="hard">ตรวจเฉพาะงานที่ประเมินว่ายาก</option>
          <option value="off">ข้ามการตรวจงานย่อย</option>
        </select>
        <small id="team-check-help">เมื่อข้ามการตรวจงานย่อย ให้รีวิวรวมตอนท้ายตัดสิน</small>
      </div>
    </div>
    </> : null}
    {show('budget') ? <>
    <h2>งบ</h2>
    <p className="muted">เมื่อถึงงบ Relay จะหยุดงานและรอคุณอนุมัติก่อนเรียก AI ต่อ ใส่ 0 ถ้าไม่จำกัด Task Card ตั้งงบเฉพาะงานได้ด้วย routing.budget_usd</p>
    <div className="settings-grid">
      <label>งบต่องาน (USD)<input type="number" required min="0" max="10000" step="0.01" value={draft.budget?.perJobUsd ?? 0} onChange={event => setBudget('perJobUsd', Number(event.target.value))} /></label>
      <label>งบต่อวัน (USD)<input type="number" required min="0" max="10000" step="0.01" value={draft.budget?.dailyUsd ?? 0} onChange={event => setBudget('dailyUsd', Number(event.target.value))} /></label>
    </div>
    <label className="checkbox"><input type="checkbox" checked={draft.budget?.countSubscription !== false} onChange={event => setBudget('countSubscription', event.target.checked)} />นับมูลค่าเทียบ API ของงานที่ใช้ subscription ด้วย (ถ้าไม่ติ๊ก นับเฉพาะเงินที่จ่ายจริงผ่าน API)</label>
    </> : null}
    {show('auto') ? <>
    <h2>ทำงานต่อเนื่อง (โหมดอัตโนมัติ)</h2>
    <p className="muted">สั่งครั้งเดียวแล้วให้ Relay จัดการจนจบ: ลอง AI ตัวอื่นเมื่อทำไม่ได้ รอโควตาแทนการหยุด ลองขั้นที่ล้มใหม่ และส่ง error จากการทดสอบให้ AI แก้จนผ่านหรือครบจำนวนรอบ ผลงานยังอยู่บน branch ให้คุณตรวจก่อน merge เสมอ</p>
    <label className="checkbox"><input type="checkbox" checked={draft.auto.allProviders} onChange={event => setAuto('allProviders', event.target.checked)} />ถ้าตัวหลักและตัวสำรองทำไม่ได้ ให้ลอง AI ตัวอื่นที่เชื่อมต่ออยู่</label>
    <div className="settings-grid">
      <label>รอโควตากลับมาได้นานสุด (นาที, 0 = ไม่รอ)<input type="number" required min="0" max="600" value={draft.auto.waitMinutes} onChange={event => setAuto('waitMinutes', Number(event.target.value))} /></label>
      <label>ลองขั้นที่ล้มใหม่ (ครั้ง)<input type="number" required min="0" max="5" value={draft.auto.retries} onChange={event => setAuto('retries', Number(event.target.value))} /></label>
      <label>เวลาสูงสุดต่องาน (นาที)<input type="number" required min="10" max="1440" value={draft.auto.maxJobMinutes} onChange={event => setAuto('maxJobMinutes', Number(event.target.value))} /></label>
    </div>
    </> : null}
    {show('self-update') ? <>
    <h2>อัปเดต Relay</h2>
    <label className="checkbox">
      <input type="checkbox" role="switch" className="settings-switch" checked={draft.selfUpdate.autoRestart}
        aria-describedby="auto-restart-help" onChange={event => {
          const autoRestart = event.target.checked;
          setDraft(current => ({ ...current, selfUpdate: { ...current.selfUpdate, autoRestart } }));
        }} />
      รีสตาร์ท Relay อัตโนมัติหลัง merge งานที่แก้ server
    </label>
    <p id="auto-restart-help" className="muted">การตั้งค่านี้มีผลกับงานที่แก้ server หรือ MCP และ Relay จะรอให้งานค้างเสร็จทั้งหมดก่อนรีสตาร์ทเสมอ</p>
    </> : null}
    <div className={'form-actions save-bar' + (dirty ? ' dirty' : '')}>
      {notice ? <span role="status" className={notice.error ? 'error' : 'success'}>{notice.text}</span> :
        dirty ? <span role="status" className="warn-text">มีการแก้ที่ยังไม่บันทึก</span> : <span className="muted">บันทึกแล้ว</span>}
      <span className="spacer" />
      {dirty ? <Button disabled={saving} onClick={() => { setDraft(initial); setNotice(null); }}>ยกเลิกการแก้</Button> : null}
      <button className="button primary" type="submit" disabled={saving || !dirty || duplicate}>บันทึกการตั้งค่า</button></div>
    </div>
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
    parts.push(<InlineMarkdown key={'t' + match.index} text={text.slice(last, match.index)} />);
    parts.push(<button type="button" className="file-link" key={match.index} onClick={() => openFile(match[1])}>{match[0]}</button>);
    last = match.index + match[0].length;
  }
  parts.push(<InlineMarkdown key="tail" text={text.slice(last)} />);
  return <>{parts}</>;
}

function CopyButton({ text, children }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch {}
  }
  return <Button icon={copied ? Check : Copy} onClick={copy}>{copied ? 'คัดลอกแล้ว' : children}</Button>;
}

// Merge in two steps: check first (target branch, uncommitted files, predicted conflicts), then confirm.
function useJobMerge(job, updated) {
  const [preview, setPreview] = useState(null);
  const version = job.finishedAt ?? job.status;
  const check = preview?.version === version ? preview.check : null;
  const [cleanupAfter, setCleanupAfter] = useState(true);
  const [busyState, setBusyState] = useState('');
  const [error, setError] = useState('');
  async function prepare() {
    setBusyState('check'); setError('');
    try { setPreview({ version, check: await api('/jobs/' + job.id + '/merge-check') }); }
    catch (error) { setError(error.message); } finally { setBusyState(''); }
  }
  async function merge() {
    setBusyState('merge'); setError('');
    try { updated(await api('/jobs/' + job.id + '/merge', 'POST', { target: check.target, cleanup: cleanupAfter })); close(); }
    catch (error) { setError(error.message); if (error.data?.check) setPreview({ version, check: error.data.check }); }
    finally { setBusyState(''); }
  }
  function close() { setPreview(null); setError(''); }
  return { check, cleanupAfter, setCleanupAfter, busyState, error, prepare, merge, close };
}

function MergePanel({ job, mergeAction, mergeNeedsApproval }) {
  const { check, cleanupAfter, setCleanupAfter, busyState, error, prepare, merge, close } = mergeAction;
  if (!check) return error ? <p role="alert" className="error">{error}</p> : null;
  const blocked = check.blockers.length > 0;
  const confirmLabel = mergeNeedsApproval ? 'ขออนุมัติ merge เข้า ' + check.target :
    check.alreadyMerged ? 'บันทึกว่า merge แล้ว' : 'ยืนยัน merge เข้า ' + check.target;
  const pendingLabel = mergeNeedsApproval ? 'กำลังขออนุมัติ…' : 'กำลัง merge…';
  return <div className={'merge-panel open' + (blocked ? ' blocked' : '')}>
    <strong>{check.alreadyMerged ? 'branch นี้อยู่ใน ' + check.target + ' แล้ว' : 'Merge ' + job.branch + ' → ' + check.target}</strong>
    {check.stat ? <small>{check.stat}</small> : null}
    <ul>
      {check.alreadyMerged ? <li>ไม่ต้อง merge ซ้ำ Relay จะบันทึกว่า merge แล้ว</li> :
        check.fastForward ? <li>fast-forward: ไม่มี commit ใหม่บน {check.target} ระหว่างทาง จึงไม่มีทางชนกัน</li> :
        !check.conflicts.length ? <li>{check.target} มี commit ใหม่ระหว่างทาง Relay จะสร้าง merge commit ให้ จำลองแล้วไม่ชนกัน</li> : null}
      {check.otherBranch ? <li className="warn-text">งานนี้เริ่มจาก {check.expected} แต่ตอนนี้ repo อยู่บน {check.target}</li> : null}
      {check.blockers.map(item => <li key={item} className="bad-text">{item}</li>)}
      {check.overlap?.length ? <li className="files">ไฟล์ที่แก้ค้างและงานนี้จะ merge ทับ: {check.overlap.join(', ')}</li> : null}
      {check.staged?.length ? <li className="files">ไฟล์ที่ stage ไว้: {check.staged.join(', ')}</li> : null}
      {!check.overlap && check.dirty.length ? <li className="files">{check.dirty.join(', ')}</li> : null}
      {check.untouched ? <li>repo มีไฟล์ที่แก้ค้างไว้ {check.untouched} ไฟล์ซึ่งงานนี้ไม่ได้แตะ merge ได้ และไฟล์เหล่านั้นจะอยู่เหมือนเดิม</li> : null}
      {check.conflicts.length ? <li className="files">ไฟล์ที่จะชน: {check.conflicts.join(', ')}</li> : null}
    </ul>
    {blocked ? null : <label className="checkbox"><input type="checkbox" checked={cleanupAfter} onChange={event => setCleanupAfter(event.target.checked)} />หลัง merge ล้าง worktree และลบ branch ของงานนี้</label>}
    {error ? <p role="alert" className="error">{error}</p> : null}
    <div className="action-row">
      {blocked ? <Button onClick={prepare} disabled={Boolean(busyState)}>ตรวจอีกครั้ง</Button> :
        <Button primary icon={Check} onClick={merge} disabled={Boolean(busyState)}>{busyState === 'merge' ? pendingLabel : confirmLabel}</Button>}
      <Button onClick={close} disabled={busyState === 'merge'}>ยกเลิก</Button>
    </div>
  </div>;
}

const complexityNames = { simple: 'ง่าย ทำรวดเดียว', medium: 'กลาง แบ่งงานย่อย', hard: 'ยาก แบ่งงานย่อยมากขึ้น' };
const subtaskStatus = {
  pending: ['รอคิว', ''], running: ['กำลังทำ', 'running'], checking: ['หัวหน้ากำลังตรวจ', 'running'], fixing: ['แก้ตามที่หัวหน้าตรวจ', 'warn'],
  passed: ['ผ่าน', 'ok'], warning: ['ยังมีปัญหา', 'warn'], skipped: ['ไม่มีงาน', ''], done: ['เสร็จ', 'ok'],
  waiting: ['รอชิ้นอื่น', 'waiting'], merging: ['กำลังรวมงาน', 'running'], rerun: ['รวมแล้วชนกัน ทำใหม่', 'warn'],
  failed: ['ล้มเหลว', 'bad'], cancelled: ['หยุดแล้ว', '']
};
const subtaskFinished = new Set(['passed', 'skipped', 'done']);
const subtaskActive = new Set(['running', 'checking', 'fixing', 'merging', 'rerun']);
const subtaskNumber = (item, index) => Number.isInteger(item.index) ? item.index : Number.isInteger(item.id) ? item.id : Number.isInteger(Number(item.id)) && String(item.id).trim() ? Number(item.id) : index + 1;

// Use the server's waitingOn list, including an empty list. Infer dependencies only for older records.
function waitingFor(item, items) {
  if (Array.isArray(item.waitingOn)) return item.waitingOn;
  if (!['pending', 'waiting'].includes(item.status || 'pending') || !Array.isArray(item.dependsOn)) return [];
  return item.dependsOn.filter(number => {
    const index = items.findIndex((other, i) => subtaskNumber(other, i) === number);
    return index >= 0 && !subtaskFinished.has(items[index].status);
  });
}

// Team view: each role's lead, its subtasks in order, who did each one and what the lead's check said.
// Takes the full job.team from /api/state, or the monitor's { fromCard, backend, frontend } via `team`.
// `compact` is the short form shown inside the live monitor on the home page.
function TeamTree({ job = {}, team = job.team, compact = false, roleStages = [], archived = false }) {
  const groups = ['backend', 'frontend'].map(role => ({
    role,
    items: Array.isArray(team?.[role]) ? team[role] : [],
    stage: roleStages.find(stage => stage.key === role)
  })).filter(({ items, stage }) => items.length || stage);
  if (!groups.length) return null;
  const fromCard = team?.fromCard === true || job.plan?.subtasksFromCard === true;
  const Wrapper = compact ? 'div' : 'section';
  const Title = compact ? 'h3' : 'h2';
  return <Wrapper className={compact ? 'team compact' : 'card team'} aria-label="ทีมงาน">
    <div className="card-head"><Title>ทีมงาน{fromCard ? <> <span className="plan-source-badge">งานย่อยจากการ์ด</span></> : null}</Title>
      {!compact && job.plan?.complexity ? <span className="chip">{complexityNames[job.plan.complexity]}</span> : null}</div>
    <div className={'team-groups' + (groups.length === 1 ? ' single' : '')}>
      {groups.map(({ role, items, stage }) => {
        const passed = items.filter(item => subtaskFinished.has(item.status)).length;
        const active = items.filter(item => subtaskActive.has(item.status)).length;
        const waiting = items.filter(item => waitingFor(item, items).length).length;
        return <div key={role} className="team-group">
          <header><strong>{job.single ? 'ผู้ลงมือ' : role === 'frontend' ? 'Frontend' : 'Backend'}</strong>
            {items.length ? <small>{compact ? '' : fromCard ? 'จากการ์ด ' : 'หัวหน้าแบ่ง '}{items.length} งานย่อย · ผ่านแล้ว {passed}</small> : null}
            {stage && !archived ? <span className="chip team-role-status">
              {stage.status === 'skipped' ? 'ข้ามขั้นนี้' : monitorStageStatus(stage)}
            </span> : null}
            {active > 1 || waiting ? <span className="team-badges">
              {active > 1 ? <span className="team-badge parallel">ทำพร้อมกัน {active} ชิ้น</span> : null}
              {waiting ? <span className="team-badge waiting">รอชิ้นอื่น {waiting}</span> : null}
            </span> : null}
          </header>
          {stage ? <div className="team-role-details">
            {!archived && (stage.action || stage.waitUntil) ? <p className="monitor-role-action">
              {monitorActions[stage.action]}
              {stage.waitUntil ? <> ถึง <time dateTime={new Date(stage.waitUntil).toISOString()}>{dateTime(stage.waitUntil)}</time></> : null}
            </p> : null}
            {!archived && stage.note ? <p className="team-role-note">{stage.note}</p> : null}
            {!archived || stage.branch ? <dl className="monitor-role-meta">
              {!archived ? <>
                <div><dt>AI</dt><dd>{stage.provider ? providerName(stage.provider) : '–'}</dd></div>
                <div><dt>รอบแก้</dt><dd>{stage.round ?? '–'}</dd></div>
              </> : null}
              {stage.branch || !archived ? <div><dt>Branch</dt><dd><code>{stage.branch || '–'}</code></dd></div> : null}
            </dl> : null}
            <MonitorRoleFiles stage={stage} />
          </div> : null}
          {items.length ? <ol className="subtasks">
            {items.map((item, index) => {
              const waits = waitingFor(item, items);
              const [text, tone] = waits.length ? ['รอ #' + waits.join(', #'), 'waiting'] : subtaskStatus[item.status] || [item.status, ''];
              const parallel = active > 1 && subtaskActive.has(item.status);
              const deps = Array.isArray(item.dependsOn) ? item.dependsOn : [];
              const worker = item.provider && item.provider !== 'reused' ? item.provider : null;
              const prefer = providers[item.prefer] && item.prefer !== worker ? item.prefer : null;
              return <li key={item.id ?? item.index ?? index} className={'subtask ' + (tone || 'idle') + (parallel ? ' parallel' : '')}>
                <span className="subtask-no">{subtaskNumber(item, index)}</span>
                <div className="subtask-body">
                  <div className="subtask-line"><strong>{item.title}</strong><em className={'subtask-status ' + tone}
                    title={waits.length ? 'เริ่มได้เมื่องานย่อย #' + waits.join(', #') + ' ผ่านการตรวจแล้ว' : undefined}>{text}</em></div>
                  {parallel || (deps.length && !waits.length && !subtaskFinished.has(item.status)) ? <div className="subtask-flags">
                    {parallel ? <span className="subtask-flag parallel">ทำพร้อมกัน</span> : null}
                    {deps.length && !waits.length && !subtaskFinished.has(item.status) ? <span className="subtask-flag">ต่อจาก #{deps.join(', #')}</span> : null}
                  </div> : null}
                  {worker || prefer || item.checker || item.fixes ? <div className="subtask-who">
                    {worker ? <span><ProviderIcon id={worker} size={12} /> ทำโดย {providerName(worker)}</span> : null}
                    {prefer ? <span className="subtask-prefer">AI ที่ต้องการ · {providerName(prefer)}</span> : null}
                    {item.checker ? <span><ProviderIcon id={item.checker} size={12} /> ตรวจโดย {providerName(item.checker)}</span> : null}
                    {item.fixes ? <span>แก้ {item.fixes} รอบ</span> : null}
                  </div> : null}
                  {compact ? null : item.check ? <p className="subtask-check">{item.check}</p> : item.summary ? <p className="subtask-check">{item.summary}</p> : null}
                </div>
              </li>;
            })}
          </ol> : null}
        </div>;
      })}
    </div>
  </Wrapper>;
}

// A ready-to-paste brief for a Claude Code session: where the work is, what is still wrong, and what done means.
function handoffPrompt(job) {
  const findings = job.review?.findings || [];
  const failed = (job.checks || []).filter(item => item.code !== 0 && item.code !== null);
  const lines = [
    'งานนี้มาจาก Relay: "' + job.title + '" ช่วยแก้ปัญหาที่ยังค้างให้เสร็จ',
    '',
    ...(job.merged ? ['repo: ' + job.repo, 'งานนี้ merge เข้า ' + job.merged.into + ' แล้ว (commit ' + job.merged.commit.slice(0, 10) + ') ให้แก้ต่อบน ' + job.merged.into]
      : [job.worktree ? 'ทำงานในโฟลเดอร์นี้ (เป็น git worktree ที่อยู่บน branch ของงานแล้ว): ' + job.worktree
        : 'repo: ' + job.repo + ' ให้ checkout branch ' + job.branch + ' ก่อน',
      'branch: ' + job.branch + (job.base ? ' (เริ่มจาก commit ' + job.base.slice(0, 10) + ')' : '')]),
    ''
  ];
  if (findings.length) {
    lines.push('ปัญหาที่รีวิวเจอ:');
    findings.forEach((item, index) => {
      const detail = typeof item === 'string' ? item : item.detail || item.text || item.summary || JSON.stringify(item);
      const owner = item.owner ? '[' + (roleNames[item.owner] || item.owner) + '] ' : '';
      lines.push((index + 1) + '. ' + owner + detail);
    });
    lines.push('');
  }
  if (failed.length) {
    lines.push('เทสที่ไม่ผ่าน:');
    for (const item of failed) lines.push('- ' + item.label + ' (exit ' + item.code + ')\n' + String(item.output || '').slice(-1200).trim());
    lines.push('');
  }
  if (job.review?.summary) lines.push('สรุปจากรีวิว: ' + job.review.summary, '');
  if (job.prompt) lines.push('โจทย์เดิม:', job.prompt.slice(0, 2500), '');
  const tip = job.merged ? (job.merged.tip || job.merged.commit).slice(0, 10) : 'HEAD';
  lines.push('ดูการเปลี่ยนแปลงของงานนี้ได้ด้วย git diff ' + (job.base ? job.base.slice(0, 10) : tip + '~1') + '..' + tip,
    'แก้ให้ครบ รันเทสให้ผ่าน แล้ว commit ' + (job.merged ? 'บน ' + job.merged.into : 'บน branch นี้') + ' ห้าม push');
  return lines.join('\n');
}

// One more fix round on the same branch, or hand the open problems to a Claude Code session.
function FixPanel({ job, updated, open, setOpen, showTrigger }) {
  const [note, setNote] = useState('');
  const [provider, setProvider] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const findings = job.review?.findings?.length || 0;
  const failed = (job.checks || []).filter(item => item.code !== 0 && item.code !== null).length;
  async function send() {
    setSending(true); setError('');
    try { updated(await api('/jobs/' + job.id + '/fix', 'POST', { note, provider })); setOpen(false); setNote(''); }
    catch (error) { setError(error.message); } finally { setSending(false); }
  }
  const attention = job.status === 'needs_review';
  return <div className={'fix-panel' + (attention ? ' attention' : '')}>
    {attention ? <p className="fix-lead"><Wrench size={15} aria-hidden="true" /> ยังเหลือ{findings ? ' ปัญหาจากรีวิว ' + findings + ' ข้อ' : ''}{findings && failed ? ' ·' : ''}{failed ? ' เทสไม่ผ่าน ' + failed + ' คำสั่ง' : ''}</p> : null}
    {open ? <div className="fix-form">
      <label>บอก AI เพิ่ม (ไม่บังคับ{findings ? '' : ' แต่งานนี้ไม่มีปัญหาค้าง ต้องบอกว่าจะให้แก้อะไร'})
        <textarea rows={3} value={note} onChange={event => setNote(event.target.value)} placeholder="เช่น ข้อ 2 ไม่ต้องแก้ ให้เน้นทำเทสให้ผ่าน" />
      </label>
      <label>ให้ AI ตัวไหนแก้
        <select value={provider} onChange={event => setProvider(event.target.value)}>
          <option value="">ให้ Relay เลือกเอง</option>
          {Object.entries(providers).map(([id, item]) => <option key={id} value={id}>{item.name}</option>)}
        </select>
      </label>
      <small>แก้บน branch เดิม <code>{job.branch}</code> แล้วทดสอบและรีวิวใหม่ 1 รอบ</small>
      {error ? <p role="alert" className="error">{error}</p> : null}
      <div className="action-row">
        <Button primary icon={Wrench} onClick={send} disabled={sending || (!findings && !note.trim())}>{sending ? 'กำลังส่ง…' : 'เริ่มแก้'}</Button>
        <Button onClick={() => { setOpen(false); setError(''); }} disabled={sending}>ยกเลิก</Button>
      </div>
    </div> : <div className="action-row">
      {showTrigger ? <Button icon={Wrench} onClick={() => setOpen(true)}>แก้ต่ออีกรอบ</Button> : null}
      <CopyButton text={handoffPrompt(job)}>คัดลอก prompt ให้ Claude Code</CopyButton>
    </div>}
  </div>;
}

function SelfUpdatePanel({ job, relayRestart }) {
  const { restart, phase, pending, requestError, restartUnconfirmed, changeRestart } = relayRestart;
  const { ui, built, dependencies, restarted } = job.selfUpdate;
  const needsRestart = job.selfUpdate.restart === true && !restarted;
  const status = restart?.status;
  const waiting = status === 'waiting';
  const restarting = phase === 'reconnecting';
  const timedOut = phase === 'timeout';
  const failed = status === 'failed';

  return <div className={'self-update' + (built === false || needsRestart || dependencies ? ' warn' : '')}>
    <strong>อัปเดต Relay</strong>
    {ui || dependencies ? <ul>
      {ui ? <li>{built ? <>build หน้าเว็บใหม่แล้ว <button type="button" className="link small" onClick={() => location.reload()}>รีเฟรชหน้านี้</button> เพื่อใช้เวอร์ชันใหม่</> : <>build หน้าเว็บไม่สำเร็จ รัน <code>npm.cmd run build</code> ในโฟลเดอร์ relay เอง</>}</li> : null}
      {dependencies ? <li>งานนี้แก้ package.json ต้องรัน <code>npm.cmd install</code> ในโฟลเดอร์ relay ก่อน</li> : null}
    </ul> : null}
    {restarted ? <p role="status" className="self-update-status success"><Check size={16} aria-hidden="true" />รีสตาร์ท Relay แล้ว</p> : null}
    {needsRestart ? <>
      {waiting && !restarting && !timedOut ? <p role="status" className="self-update-status warn-text"><Clock size={16} aria-hidden="true" />{restartWaitingMessage(restart.busyCount)}</p> : null}
      {restarting ? <p className="self-update-status">กำลังรอเชื่อมต่อ Relay ใหม่…</p> : null}
      {failed && !restarting && !timedOut ? <div className="error">
        <TriangleExclamationPoint size={16} aria-hidden="true" />
        <div>
          <strong>รีสตาร์ท Relay ไม่สำเร็จ</strong>
          {restart.error ? <p>{restart.error}</p> : null}
          <p>ตรวจข้อความในหน้าต่าง <code>start-relay.bat</code> แล้วเปิด Relay เองหากจำเป็น</p>
        </div>
      </div> : null}
      {requestError && !restarting && !timedOut ? <p className="error">{requestError}</p> : null}
      {restartUnconfirmed && status === 'idle' && !restarting && !timedOut ? <p className="self-update-status warn-text">{restartUnconfirmedMessage}</p> : null}
      {!restarting && !timedOut ? <div className="action-row">
        {waiting ? <Button icon={X} disabled={pending} onClick={() => changeRestart(true)}>ยกเลิกการรอรีสตาร์ท</Button> :
          <Button primary icon={RotateCcw} disabled={pending} onClick={() => changeRestart(false, job.id)}>รีสตาร์ท Relay ตอนนี้</Button>}
      </div> : null}
    </> : null}
  </div>;
}

function JobActions({ job, relayRestart, updated, removed, retry, canFix, fixOpen, setFixOpen, primaryFix,
  canMerge, mergeNeedsApproval, mergeAction, mergeButton }) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const hasBranch = Boolean(job.worktree || job.branchKept);
  async function run(task) {
    setWorking(true); setError('');
    try { await task(); } catch (error) { setError(error.message); } finally { setWorking(false); }
  }
  const mergeCommand = 'git -C ' + quote(job.repo) + ' merge ' + job.branch;
  const canCopyMergeCommand = canMerge && !mergeNeedsApproval;
  const merged = job.merged;
  const undoCommand = merged && (merged.fastForward && merged.before ? 'git -C ' + quote(job.repo) + ' revert --no-edit ' + merged.before.slice(0, 10) + '..' + merged.commit.slice(0, 10)
    : 'git -C ' + quote(job.repo) + ' revert --no-edit -m 1 ' + merged.commit.slice(0, 10));
  return <div className="job-actions">
    <h2>ขั้นต่อไป</h2>
    {merged ? <div className="merged-box">
      <p><Check size={16} aria-hidden="true" /> merge เข้า <code>{merged.into}</code> แล้วเมื่อ {dateTime(merged.at)} · commit <code>{merged.commit.slice(0, 7)}</code>{merged.fastForward ? ' (fast-forward)' : ''}</p>
      {merged.before !== null ? <><small>ถ้าต้องการย้อน ใช้คำสั่งนี้ จะได้ commit ใหม่ที่ยกเลิกการเปลี่ยนแปลง ประวัติเดิมไม่หาย</small>
        <div className="action-row"><CopyButton text={undoCommand}>คัดลอกคำสั่งย้อน</CopyButton></div></> : null}
    </div> : null}
    {merged && job.selfUpdate ? <SelfUpdatePanel job={job} relayRestart={relayRestart} /> : null}
    {merged && job.status === 'needs_review' ? <div className="fix-panel attention">
      <p className="fix-lead"><Wrench size={15} aria-hidden="true" /> merge แล้วแต่ยังมีปัญหาค้าง ส่งต่อให้ Claude Code แก้บน {merged.into} ได้</p>
      <div className="action-row"><CopyButton text={handoffPrompt(job)}>คัดลอก prompt ให้ Claude Code</CopyButton></div>
    </div> : null}
    {canFix ? <FixPanel job={job} updated={updated} open={fixOpen} setOpen={setFixOpen} showTrigger={!primaryFix} /> : null}
    {canMerge ? <>{mergeButton}<MergePanel job={job} mergeAction={mergeAction} mergeNeedsApproval={mergeNeedsApproval} /></> : null}
    {hasBranch ? <>
      {canCopyMergeCommand ? <p>หรือ merge เองด้วย Git ที่ branch <code>{job.branch}</code></p> : null}
      <div className="action-row">
        <CopyButton text={job.branch}>คัดลอกชื่อ branch</CopyButton>
        {canCopyMergeCommand ? <CopyButton text={mergeCommand}>คัดลอกคำสั่ง merge</CopyButton> : null}
        {job.worktree ? <Button icon={FolderOpen} disabled={working} onClick={() => run(() => api('/jobs/' + job.id + '/open', 'POST'))}>เปิดโฟลเดอร์</Button> : null}
      </div>
    </> : merged ? null : <p>{job.cleanedAt ? 'ล้าง worktree และ branch ของงานนี้แล้ว' : 'งานนี้ไม่มี branch ผลลัพธ์'}</p>}
    <div className="action-row">
      <Button icon={RotateCcw} onClick={() => retry({ ...job, plan: undefined, id: undefined, cardFrom: job.id })}>สั่งงานนี้อีกครั้ง</Button>
    </div>
    <details className="job-management">
      <summary>จัดการ worktree และงาน</summary>
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
    </details>
    {error ? <p role="alert" className="error">{error}</p> : null}
  </div>;
}

const sourceNames = { chat: 'Chat (MCP)', paste: 'วางเอง', card: 'Task Card' };
const stepStatus = { done: 'สำเร็จ', failed: 'ล้มเหลว', rejected: 'ใช้ผลไม่ได้', running: 'กำลังทำ', cancelled: 'หยุด', interrupted: 'ถูกขัดจังหวะ' };
const tokens = value => value == null ? '–' : value >= 10_000 ? Math.round(value / 1000).toLocaleString() + 'k' : value.toLocaleString();
const usd = value => value == null ? '–' : '$' + value.toFixed(value < 0.1 ? 4 : 2);

// One row per AI call: who did what, how long it took, tokens and cost.
// Cost on a subscription login is what the same tokens would cost on the API, not money spent.
function UsageView({ job }) {
  const [steps, setSteps] = useState(null);
  const [error, setError] = useState('');
  const running = busyStatuses.has(job.status);
  const stepCount = job.usage?.calls;
  useEffect(() => {
    api('/jobs/' + job.id + '/steps').then(setSteps, error => setError(error.message));
  }, [job.id, running, stepCount]);
  const total = job.usage;
  if (error) return <p className="error">{error}</p>;
  if (!steps) return <p>กำลังโหลด…</p>;
  return <div className="usage">
    <div className="usage-totals">
      <div><small>เรียก AI</small><strong>{steps.length} ครั้ง</strong></div>
      <div><small>Token เข้า / ออก</small><strong>{tokens(total?.inputTokens ?? 0)} / {tokens(total?.outputTokens ?? 0)}</strong></div>
      <div><small>จ่ายจริงผ่าน API</small><strong>{usd(total?.apiCostUsd ?? 0)}</strong></div>
      <div><small>มูลค่าเทียบ API (ใช้ subscription)</small><strong>{usd(total?.subscriptionCostUsd ?? 0)}</strong></div>
    </div>
    {steps.length ? <div className="table-scroll"><table className="steps">
      <thead><tr><th>ขั้น</th><th>AI</th><th>ผล</th><th>เวลา</th><th>Token เข้า/ออก</th><th>ค่าใช้จ่าย</th></tr></thead>
      <tbody>{steps.map(step => <tr key={step.id} className={step.status}>
        <td>{stageNames[step.role] || step.role}{step.round ? ' · รอบ ' + step.round : ''}</td>
        <td>{providerName(step.provider)}</td>
        <td title={step.error || ''}>{stepStatus[step.status] || step.status}</td>
        <td>{step.ended_at ? duration(step.ended_at - step.started_at) : '…'}</td>
        <td>{tokens(step.input_tokens)} / {tokens(step.output_tokens)}</td>
        <td>{usd(step.cost_usd)}{step.billing === 'subscription' && step.cost_usd != null ? ' *' : ''}</td>
      </tr>)}</tbody>
    </table></div> : <p className="muted">ยังไม่มีการเรียก AI ในงานนี้</p>}
    <p className="muted">* ใช้บัญชี subscription ตัวเลขคือมูลค่าเทียบราคา API ไม่ใช่เงินที่จ่ายจริง · Codex และ Gemini CLI ยังไม่รายงาน token</p>
  </div>;
}

function PlanTaskGroups({ plan, single, Heading = 'h3' }) {
  const minTasks = plan.subtasksFromCard === true ? 1 : 2;
  return ['backend', 'frontend'].map(role => {
    const tasks = plan[role + 'Tasks'];
    if (!tasks || tasks.length < minTasks) return null;
    return <div key={role} className="plan-tasks">
      <Heading>งานย่อย {single ? '' : roleNames[role]} ({tasks.length})</Heading>
      <ol>{tasks.map((task, index) => <li key={index}>
        <strong>{task.title}</strong>
        {task.prefer ? <> <span className="plan-task-prefer">AI ที่ต้องการ · {providerName(task.prefer)}</span></> : null}
        <p>{task.goal}</p>
        {task.files?.length ? <small>ไฟล์: {task.files.join(', ')}</small> : null}
      </li>)}</ol>
    </div>;
  });
}

function CardSubtaskBadge({ plan }) {
  return plan?.subtasksFromCard === true ? <> <span className="plan-source-badge">งานย่อยจากการ์ด</span></> : null;
}

// Shown while a job waits for a decision on the plan, budget or merge.
function ApprovalPanel({ job, panelRef, onAcceptanceUpdated }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const verification = useRef(null);
  const { kind, requestedAt } = job.approval;
  const plan = kind === 'plan' ? job.plan : null;
  const merging = kind === 'before_merge';
  const partial = merging && job.review?.partial === true;
  useEffect(() => () => verification.current?.abort(), []);
  async function decide(decision) {
    if (busy || verification.current) return;
    if (decision === 'revise' && !note.trim()) { setError('บอกด้วยว่าต้องการให้แก้แผนตรงไหน'); return; }
    if (decision === 'reject' && !confirm(merging ? 'ปฏิเสธ merge? branch ของงานนี้จะยังอยู่' : 'หยุดงานนี้?')) return;
    const controller = new AbortController();
    verification.current = controller;
    setBusy(true); setError('');
    try {
      const { jobs } = await readState(controller.signal);
      if (controller.signal.aborted) return;
      const current = jobs.find(item => item.id === job.id);
      if (current?.status !== 'waiting_approval' || !sameApproval(job.approval, current.approval)) {
        setError('คำขออนุมัติเปลี่ยนแล้ว รอรายละเอียดล่าสุดก่อนส่งคำตอบ');
        return;
      }
      await api('/jobs/' + job.id + '/approve', 'POST', { decision, note, kind, requestedAt });
    } catch (error) {
      if (!controller.signal.aborted) { setError(error.message); setBusy(false); }
    } finally {
      verification.current = null;
    }
  }
  return <section ref={panelRef} tabIndex={-1} className="card approval-panel" aria-label="รออนุมัติ">
    <h2>{plan ? 'ตรวจแผนก่อนลงมือ' : merging ? 'อนุมัติก่อน merge' : 'ถึงงบที่ตั้งไว้'}<CardSubtaskBadge plan={plan} /></h2>
    <p>{job.approval.message}</p>
    {partial ? <p className="partial-badge" role="note"><TriangleExclamationPoint size={14} aria-hidden="true" /> รีวิวบางส่วน (diff ถูกตัด)</p> : null}
    {merging ? <AcceptanceChecklist job={job} onUpdated={onAcceptanceUpdated} manualOnly /> : null}
    {plan ? <div className="plan-view">
      <div><h3>{job.single ? 'สิ่งที่จะทำ' : 'Backend'}</h3><p className="preline">{plan.backend}</p>{plan.backendFiles?.length ? <small>ไฟล์: {plan.backendFiles.join(', ')}</small> : null}</div>
      {job.single ? null : <div><h3>Frontend</h3><p className="preline">{plan.frontend}</p>{plan.frontendFiles?.length ? <small>ไฟล์: {plan.frontendFiles.join(', ')}</small> : null}</div>}
      <div><h3>ข้อตกลงระหว่างส่วน</h3><p className="preline">{plan.contract}</p></div>
      <div><h3>เกณฑ์รับงาน</h3><p className="preline">{plan.acceptance}</p></div>
      <PlanTaskGroups plan={plan} single={job.single} />
    </div> : null}
    {plan?.complexity ? <p className="muted">ความยากที่ประเมิน: {complexityNames[plan.complexity] || plan.complexity}</p> : null}
    {plan ? <label>หมายเหตุ (ต้องใส่ถ้าขอแก้แผน)<textarea rows={3} value={note} onChange={event => setNote(event.target.value)} placeholder="เช่น อย่าแตะไฟล์ CSS ของหน้า Records" /></label> : null}
    {error ? <p role="alert" className="error">{error}</p> : null}
    <div className="action-row">
      <Button primary icon={Check} disabled={busy} onClick={() => decide('approve')}>{plan ? 'อนุมัติแผน' : merging ? 'อนุมัติ merge' : 'อนุมัติให้ทำต่อ'}</Button>
      {plan ? <Button icon={RotateCcw} disabled={busy} onClick={() => decide('revise')}>ขอแก้แผน</Button> : null}
      <Button danger icon={X} disabled={busy} onClick={() => decide('reject')}>{plan ? 'ไม่อนุมัติ หยุดงาน' : merging ? 'ปฏิเสธ merge (เก็บ branch ไว้)' : 'หยุดงาน'}</Button>
    </div>
  </section>;
}

// Every automatic choice made for this job: who was picked for which step, why, and the scores of all AIs.
function RoutingView({ job }) {
  const decisions = [...(job.routing || [])].reverse();
  return <div className="routing-view">
    <p className="muted">{job.settings?.routing?.mode === 'auto' ? 'โปรไฟล์ ' + (profileNames[job.settings.routing.profile] || job.settings.routing.profile) : 'งานนี้ใช้ตารางกำหนดเอง'}
      {job.pinned ? ' · Task Card กำหนด: ' + Object.entries(job.pinned).map(([role, provider]) => (roleNames[role] || role) + ' → ' + providerName(provider)).join(', ') : ''}</p>
    <ol className="events">{decisions.map((decision, index) => <li key={decision.at + ':' + index}>
      <span>{time(decision.at)}</span>
      <div>
        <strong>{roleNames[decision.role] || decision.role}{decision.round ? ' · รอบแก้ ' + decision.round : ''} → {decision.attempts?.length ? decision.attempts.map(providerName).join(' แล้วลอง ') : 'ยังไม่ได้เลือก'}</strong>
        <p>{decision.ranking[0]?.reason || '—'}</p>
        <details><summary>คะแนนของทุก AI</summary>
          <table className="steps"><thead><tr><th>อันดับ</th><th>AI</th><th>รวม</th>{Object.keys(factorLabels).map(key => <th key={key}>{factorLabels[key]}</th>)}</tr></thead>
            <tbody>{decision.ranking.map(row => <tr key={row.provider}><td>{row.rank}</td><td>{providerName(row.provider)}{adjustText(row) ? <small>{adjustText(row)}</small> : null}</td><td>{row.score}</td>
              {Object.keys(factorLabels).map(key => <td key={key}>{row.parts[key]}</td>)}</tr>)}</tbody></table>
          {decision.skipped?.length ? <small>ข้าม: {decision.skipped.map(item => providerName(item.provider) + ' (' + item.reason + ')').join(', ')}</small> : null}
        </details>
      </div>
    </li>)}</ol>
  </div>;
}

// History line: long AI summaries are clamped to three lines until clicked.
function EventItem({ event }) {
  const [open, setOpen] = useState(false);
  const long = (event.detail || '').length > 220;
  return <li className={event.provider ? 'by-' + event.provider : ''}>
    <span className="event-time">{time(event.at)}</span>
    <div>
      <strong>{event.title}{event.provider ? <em>{providerName(event.provider)}</em> : null}</strong>
      <div className={long && !open ? 'clamp' : ''}><Markdown text={event.detail} /></div>
      {long ? <button type="button" className="link small" onClick={() => setOpen(value => !value)}>{open ? 'ย่อ' : 'อ่านต่อ'}</button> : null}
    </div>
  </li>;
}

const jobDetailTabs = [
  ['events', 'ประวัติการทำงาน'], ['review', 'รีวิว'], ['checks', 'ผลทดสอบ'],
  ['diff', 'Git diff'], ['usage', 'การใช้ AI'], ['routing', 'การจ่ายงาน']
];

function JobChecks({ checks = [] }) {
  if (!checks.length) return <p className="muted">ยังไม่มีผลทดสอบ</p>;
  return checks.map((check, index) => {
    const code = check.exitCode ?? check.code;
    const status = check.ok ?? (code == null ? null : code === 0);
    return <details key={index} className="check">
      <summary><span className={'check-dot ' + (status === true ? 'ok' : status === false ? 'bad' : 'off')} />
        {check.command ?? check.label}<em>{status === true ? 'ผ่าน' : status === false ? 'ไม่ผ่าน' : 'ไม่ได้รัน'}</em></summary>
      {Array.isArray(check.failedTests) && check.failedTests.length ? <div className="failed-tests">
        <strong>เทสต์ที่ล้ม ({check.failedTests.length})</strong>
        <ul>{check.failedTests.map((test, i) => <li key={i}><code>{test.name}</code>{test.error ? <pre>{test.error}</pre> : null}</li>)}</ul>
      </div> : null}
      <pre>{check.output}</pre>
    </details>;
  });
}

function JobDetail({ job, projectName, monitor, relayRestart, approvalRequested, onApproval, onApprovalFocused, back, retry, updated, removed, onAcceptanceUpdated }) {
  const [tab, setTab] = useState('events');
  const [diff, setDiff] = useState(null);
  const [diffAttempt, setDiffAttempt] = useState(0);
  const [focus, setFocus] = useState(null);
  const [cancelError, setCancelError] = useState('');
  const [fixOpen, setFixOpen] = useState(false);
  const approvalRef = useRef(null);
  const nextStepRef = useRef(null);
  const detailRef = useRef(null);
  const mergeAction = useJobMerge(job, updated);
  const { snapshot } = monitor;
  const active = monitor.connection === 'stale' ? null : activeMonitorJobs(snapshot).find(item => item.id === job.id);
  const latest = snapshot?.lastFinishedJob;
  // A manual fix reuses the job ID. Ignore snapshots from the previous round.
  const liveJob = active?.id === job.id && (active.startedAt ?? 0) >= (job.fixRequest?.at ?? 0) &&
    (!job.finishedAt || active.startedAt > job.finishedAt) ? active : null;
  const finishedJob = latest?.id === job.id &&
    latest.finishedAt >= Math.max(job.startedAt ?? 0, job.fixRequest?.at ?? 0, job.finishedAt ?? 0) ? latest : null;
  const status = liveJob?.status ?? finishedJob?.status ?? job.status;
  const savedJob = useSavedJobMonitor(job.id, Boolean(liveJob), status, monitor.connection === 'stale');
  const monitorJob = liveJob ?? (savedJob?.status === status ? savedJob : null);
  const busy = busyStatuses.has(status);
  const canAct = !busy && !busyStatuses.has(job.status);
  // Approval is also checked against fresh state before a decision is sent.
  const showApproval = job.status === 'waiting_approval' && Number.isFinite(job.approval?.requestedAt) &&
    (job.approval.kind !== 'plan' || Boolean(job.plan)) && (!liveJob || sameApproval(job.approval, liveJob.approval));
  const hasBranch = Boolean(job.worktree || job.branchKept);
  const hasResult = hasBranch || Boolean(job.merged);
  const mergeNeedsApproval = job.approvalGates?.includes('before_merge');
  const canMerge = canAct && hasBranch && !job.merged && (!mergeNeedsApproval || doneStatuses.has(job.status));
  const canFix = canMerge && doneStatuses.has(job.status);
  const primaryMerge = canMerge && status === 'complete';
  const primaryFix = canFix && status === 'needs_review';
  const primaryResume = canAct && stuckStatuses.has(status);
  const canCancel = ['queued', 'running', 'waiting_approval'].includes(status);

  // Fetch the diff for the tab or for older finished jobs that lack diffStat.
  const needsDiffStat = !busy && !job.diffStat && job.diff == null;
  const shouldLoadDiff = hasResult && (tab === 'diff' || needsDiffStat);
  const diffVersion = (busy ? 'live' : finishedJob?.finishedAt ?? job.finishedAt ?? 'finished') + ':' + diffAttempt;
  const currentDiff = diff?.version === diffVersion ? diff : null;
  useEffect(() => {
    if (!shouldLoadDiff || currentDiff) return;
    const controller = new AbortController();
    const { signal } = controller;
    api('/jobs/' + job.id + '/diff', 'GET', undefined, { signal, cache: 'no-store' }).then(
      value => { if (!signal.aborted) setDiff({ version: diffVersion, value }); },
      error => { if (!signal.aborted) setDiff({ version: diffVersion, error: error.message }); }
    );
    return () => controller.abort();
  }, [job.id, shouldLoadDiff, diffVersion, currentDiff]);

  useEffect(() => {
    if (!approvalRequested || !showApproval) return;
    const panel = approvalRef.current;
    panel.focus({ preventScroll: true });
    panel.scrollIntoView({ block: 'start' });
    onApprovalFocused();
  }, [approvalRequested, showApproval, onApprovalFocused]);

  function openDetailTab(nextTab, file) {
    if (nextTab === 'diff') {
      setFocus(file || null);
      if (currentDiff && (busy || currentDiff.error)) setDiffAttempt(attempt => attempt + 1);
    }
    setTab(nextTab);
  }

  function jumpTo(ref) {
    ref.current?.focus({ preventScroll: true });
    ref.current?.scrollIntoView({ block: 'start' });
  }

  async function cancel() {
    setCancelError('');
    try { updated(await api('/jobs/' + job.id + '/cancel', 'POST')); }
    catch (error) { setCancelError(error.message); }
  }

  const mergeButton = canMerge ? <Button primary={primaryMerge} icon={GitBranch}
    onClick={() => {
      jumpTo(nextStepRef);
      if (!mergeAction.check) void mergeAction.prepare();
    }} disabled={Boolean(mergeAction.busyState)}>
    {mergeAction.busyState === 'check' ? 'กำลังตรวจ…' : mergeNeedsApproval ? 'ขออนุมัติ merge' :
      primaryMerge || job.status !== 'needs_review' ? 'Merge เข้า repo' : 'Merge ทั้งที่ยังมีปัญหา'}
  </Button> : null;
  const roleStages = monitorJob?.stages.filter(stage => workKeys.has(stage.key)) ?? [];
  const archivedStages = monitorJob?.stages.filter(stage =>
    ['prepare', 'integrate', 'delivery'].includes(stage.key) && stage.status !== 'pending') ?? [];
  const stepperStages = { ...job.stages, ...Object.fromEntries(
    (monitorJob?.stages ?? []).map(stage => [stage.key, { ...job.stages?.[stage.key], ...stage }])
  ) };
  const diffText = currentDiff?.value?.diff;
  const emptyDiffStat = diffText === '' ? { files: 0, additions: 0, deletions: 0 } : undefined;
  const detailTab = tab === 'routing' && !job.routing?.length ? 'events' : tab;

  return <div className="job-detail">
    <button type="button" className="back" onClick={back}><ChevronLeft size={16} /> กลับไปภาพรวม</button>
    <header className="job-header card">
      <div className="job-header-main">
        <div className="job-title-row"><h1>{job.title}</h1>{(() => {
          const badge = getJobStatusBadge({ ...job, status });
          return <span className={'status ' + badge.status}>{badge.label}</span>;
        })()}
          {job.review?.partial === true ? <span className="partial-badge" title="diff ใหญ่เกินที่ส่งให้ผู้รีวิว จึงไม่ merge อัตโนมัติ"><TriangleExclamationPoint size={13} aria-hidden="true" /> รีวิวบางส่วน (diff ถูกตัด)</span> : null}</div>
        <p className="job-meta">
          <span>{projectName}</span><span>{jobTypes[job.type || 'feature']}</span><span>สร้าง {dateTime(job.createdAt)}</span>
          {!busy && job.startedAt ? <span>ใช้เวลา {jobDuration({ ...job, finishedAt: finishedJob?.finishedAt ?? job.finishedAt })}</span> : null}
          {job.card ? <span>{job.source && job.source !== 'card' ? 'Task Card · ' + (sourceNames[job.source] || job.source) : 'Task Card'}</span> : null}
          {job.resumedFrom ? <span>ทำต่อจากงานเดิม</span> : null}
        </p>
      </div>
      {canCancel || primaryMerge || primaryFix || primaryResume ? <div className="job-header-actions">
        {canCancel ? <Button danger icon={X} onClick={cancel}>หยุดงาน</Button> : null}
        {primaryMerge ? mergeButton : null}
        {primaryFix ? <Button primary icon={Wrench} aria-expanded={fixOpen} onClick={() => { setFixOpen(true); jumpTo(nextStepRef); }}>แก้ต่ออีกรอบ</Button> : null}
        {primaryResume ? <Button primary icon={RotateCcw} onClick={() => retry(job)}>ทำต่อจากจุดที่ค้าง</Button> : null}
      </div> : null}
    </header>
    {job.error ? <p className="error banner" role="alert"><TriangleExclamationPoint size={16} aria-hidden="true" /> {job.error}</p> : null}
    {cancelError ? <p className="error banner" role="alert">{cancelError}</p> : null}
    {busy ? <>
      <LiveMonitor monitor={monitor} job={monitorJob} saved={!liveJob && Boolean(monitorJob)}
        fallbackJob={{ ...job, status }} onApproval={onApproval} hideIdentity detailJob={job}>
        <div className="monitor-legacy-progress">
          {savedJob === undefined ? <p className="muted" role="status">กำลังโหลดข้อมูลติดตามงาน…</p> :
            <Stepper job={{ ...job, status }} inactive={Boolean(snapshot) || status === 'queued'} />}
          <TeamTree job={job} />
        </div>
      </LiveMonitor>
      {showApproval ? <ApprovalPanel key={job.approval.kind + ':' + job.approval.requestedAt}
        job={job} panelRef={approvalRef} onAcceptanceUpdated={onAcceptanceUpdated} /> : null}
    </> : <>
      <OutcomeTiles job={job} diffStat={emptyDiffStat} diffText={diffText}
        onOpenTab={nextTab => { openDetailTab(nextTab); jumpTo(detailRef); }} />
      <div className={'job-overview' + (canAct ? '' : ' single')}>
        {canAct ? <section ref={nextStepRef} tabIndex={-1} className="card detail next-step" aria-label="ขั้นต่อไป">
          <JobActions job={job} relayRestart={relayRestart} updated={updated} removed={removed} retry={retry}
            canFix={canFix} fixOpen={fixOpen} setFixOpen={setFixOpen} primaryFix={primaryFix}
            canMerge={canMerge} mergeNeedsApproval={mergeNeedsApproval} mergeAction={mergeAction}
            mergeButton={primaryMerge || mergeAction.check ? null : mergeButton} />
        </section> : null}
        <AcceptanceChecklist job={job} onUpdated={onAcceptanceUpdated} readOnly={!canAct} />
      </div>
      <StageStepper job={{ ...job, status, stages: stepperStages }}>
        <div className="archived-stage-details">
          {archivedStages.length ? <MonitorTimeline job={monitorJob} keys={archivedStages.map(stage => stage.key)} /> : null}
          <TeamTree job={job} team={job.team ?? monitorJob?.team} roleStages={roleStages} archived />
          {monitorJob?.activities.length ? <MonitorActivityList key={job.id} job={monitorJob} rounds={job.roundHistory ?? job.rounds} /> : null}
        </div>
      </StageStepper>
    </>}
    <div className="detail-grid">
      <section className="card detail job-detail-tabs" ref={detailRef} tabIndex={-1} aria-label="รายละเอียดผลและประวัติงาน">
        <div className="filters tabs" role="group" aria-label="รายละเอียดงาน">
          {jobDetailTabs.filter(([key]) => key !== 'routing' || job.routing?.length).map(([key, label]) =>
            <button key={key} type="button" aria-pressed={detailTab === key} onClick={() => openDetailTab(key)}>{label}</button>)}
        </div>
        {detailTab === 'review' ? <ReviewHistoryList job={job}
          renderFinding={hasResult ? text => <Finding text={text} openFile={file => openDetailTab('diff', file)} /> : undefined} /> :
          detailTab === 'checks' ? <JobChecks checks={job.checks} /> :
          detailTab === 'routing' ? <RoutingView job={job} /> :
          detailTab === 'usage' ? <UsageView job={job} /> :
          detailTab === 'diff' ? !hasResult ? <p className="muted">ยังไม่มีผลลัพธ์ของงานนี้</p> :
            currentDiff?.error ? <p role="alert" className="error">{currentDiff.error}</p> :
            currentDiff?.value ? <DiffView diff={currentDiff.value} focus={focus} /> : <p role="status">กำลังโหลด diff…</p> :
          <ol className="events timeline">{job.events.length ? [...job.events].reverse().map((event, i) => <EventItem key={job.events.length - i} event={event} />) : <li><p>รอเริ่มงาน</p></li>}</ol>}
      </section>
      <aside className="facts-column">
        <section className="card detail facts">
          <h2>สรุปงาน</h2>
          <details className="fact" open={job.prompt.length < 500}><summary><h3>โจทย์</h3></summary><p className="preline">{job.prompt}</p></details>
          {job.plan ? <details className="fact"><summary><h3>แผนงาน</h3><CardSubtaskBadge plan={job.plan} /></summary>
            <h4>ข้อตกลงระหว่างส่วน</h4><p className="preline">{job.plan.contract}</p>
            {busy && !(showApproval && job.approval.kind === 'plan') && job.plan.acceptance ? <><h4>เกณฑ์รับงาน</h4><p className="preline">{job.plan.acceptance}</p></> : null}
            {job.plan.subtasksFromCard === true ? <PlanTaskGroups plan={job.plan} single={job.single} Heading="h4" /> : null}
          </details> : null}
          {job.scope ? <div className="fact"><h3>Scope</h3><p>{job.scope.include?.length ? 'แก้ได้เฉพาะ ' + job.scope.include.join(', ') : ''}{job.scope.exclude?.length ? ' · ห้ามแก้ ' + job.scope.exclude.join(', ') : ''}</p></div> : null}
          {job.branch && hasResult ? <div className="fact"><h3>Branch ผลลัพธ์</h3><code>{job.branch}</code>{job.worktree ? <small>{job.worktree}</small> : null}</div> : null}
          {job.budgetUsd != null ? <div className="fact"><h3>งบ</h3><p>{'$' + job.budgetUsd}</p></div> : null}
        </section>
      </aside>
    </div>
  </div>;
}

// Notes the AIs read on every job in this project: how to run it, conventions, things to avoid.
function NotesEditor({ project, updated }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  async function save() {
    setError('');
    try { updated(await api('/projects/' + project.id, 'PUT', { notes: text })); setEditing(false); }
    catch (error) { setError(error.message); }
  }
  if (!editing) return <div className="checks-list">
    <strong>บันทึกของโปรเจกต์</strong>{project.notes ? <p className="preline notes-text">{project.notes}</p> : <span> · ยังไม่มี</span>}
    <div><button type="button" className="link" onClick={() => { setText(project.notes || ''); setEditing(true); }}>{project.notes ? 'แก้บันทึก' : 'เขียนบันทึกให้ AI'}</button></div>
  </div>;
  return <div className="checks-editor">
    <label>บันทึกที่ AI อ่านทุกงานในโปรเจกต์นี้ เช่น วิธีรัน ข้อตกลงในโค้ด สิ่งที่ห้ามทำ
      <textarea rows={5} maxLength={4000} value={text} placeholder={'แอป Flask รันด้วย run_web_app.bat พอร์ต 6001\nข้อมูลรูปอยู่ใน Report Images (ห้ามแก้)\nใช้ธีมพาสเทล รองรับธีมมืด'} onChange={event => setText(event.target.value)} /></label>
    {error ? <p role="alert" className="error">{error}</p> : null}
    <div className="action-row"><Button primary onClick={save}>บันทึก</Button><Button onClick={() => setEditing(false)}>ยกเลิก</Button></div>
  </div>;
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

function ProjectDetail({ project, info, projectJobs, createJob, removed, select, updated }) {
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState(false);
  const detailRef = useRef(null);
  const latest = projectJobs.at(-1);
  const running = projectJobs.some(job => busyStatuses.has(job.status));

  async function open() {
    setError('');
    try { await api('/projects/' + project.id + '/open', 'POST'); }
    catch (error) { setError(error.message); }
  }

  async function remove() {
    if (running || removing) return;
    if (!confirm('เอา "' + project.name + '" ออกจากรายการ? ไฟล์และ Git repo ในโฟลเดอร์จะไม่ถูกลบ')) return;
    setError('');
    setRemoving(true);
    try {
      await api('/projects/' + project.id, 'DELETE', {});
      removed(project.id, detailRef.current?.contains(document.activeElement));
    } catch (error) {
      setError(error.message);
    } finally {
      setRemoving(false);
    }
  }

  return <article ref={detailRef} className="card projects-detail-pane" aria-labelledby="project-detail-title">
    <header className="project-detail-header">
      <div className="project-head">
        <span className="provider-icon project-icon"><FolderGit2 size={24} aria-hidden="true" /></span>
        <div>
          <h2 id="project-detail-title">{project.name}</h2>
          <p className="project-detail-path">{project.path}</p>
        </div>
      </div>
      <div className="action-row project-detail-actions">
        <Button primary icon={Plus} onClick={() => createJob(project.path)} disabled={removing || Boolean(info && !info.ok)}>สร้างงาน</Button>
        <Button icon={FolderOpen} onClick={open}>เปิดโฟลเดอร์</Button>
        <details className="project-actions-menu" onBlur={event => {
          if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
        }} onKeyDown={event => {
          if (event.key !== 'Escape' || !event.currentTarget.open) return;
          event.preventDefault();
          event.currentTarget.open = false;
          event.currentTarget.querySelector('summary')?.focus();
        }}>
          <summary className="button"><Ellipsis size={18} aria-hidden="true" />จัดการ</summary>
          <div className="project-actions-menu-content">
            <Button danger icon={Trash} onClick={remove} disabled={running}
              aria-disabled={removing || undefined} title={running ? 'มีงานที่กำลังทำอยู่' : undefined}>
              {removing ? 'กำลังเอาออก…' : 'เอาออก'}
            </Button>
            {running ? <p className="muted">มีงานที่กำลังทำอยู่</p> : null}
          </div>
        </details>
      </div>
    </header>
    {error ? <p role="alert" className="error">{error}</p> : null}
    <section className="project-detail-section project-git">
      <h3>สถานะ Git ในเครื่อง</h3>
      {info?.ok ? <>
        <p className="repo-info project-git-status"><GitBranch size={15} aria-hidden="true" /> <code>{info.branch}</code>
          {info.uncommitted === 0 ? <span>ไม่มีไฟล์ที่ยังไม่ commit</span> : null}</p>
        <p className="project-commit"><span>Commit ล่าสุด</span> <code>{info.base}</code> {info.subject}</p>
        {info.uncommitted > 0 ? <p className="project-dirty-warning warn-text">
          <TriangleExclamationPoint size={16} aria-hidden="true" /> ยังไม่ commit {info.uncommitted} ไฟล์
        </p> : null}
      </> : info ? <p className="repo-info bad">{info.error}</p> : <p className="muted" role="status">กำลังตรวจ repo…</p>}
    </section>
    <section className="project-detail-section">
      <h3>งานล่าสุด</h3>
      <p className="project-jobs">{latest ? <>
        <button type="button" className="link" onClick={() => select(latest.id)}>{latest.title}</button>
        <span className={'status ' + getJobStatusBadge(latest).status}>{getJobStatusBadge(latest).label}</span>
        <span>งานทั้งหมด {projectJobs.length} งาน</span>
      </> : 'ยังไม่มีงานในโปรเจกต์นี้'}</p>
    </section>
    <ChecksEditor project={project} updated={saved => updated(saved, 'checks')} />
    <NotesEditor project={project} updated={saved => updated(saved, 'notes')} />
    <details className="memory project-collapsible">
      <summary>งานล่าสุดที่ AI จำได้ ({project.memory?.length ?? 0})</summary>
      {project.memory?.length ? <ul>
        {project.memory.slice(0, 5).map(item => <li key={item.jobId}><strong>{item.title}</strong> · {statusLabels[item.status]} · {dateTime(item.at)}
          {item.summary ? <small>{item.summary}</small> : null}</li>)}
      </ul> : <p className="muted">ยังไม่มีงานที่ AI จำไว้</p>}
    </details>
  </article>;
}

function ProjectsPage({ projects, jobs, createJob, added, removed, select, updated }) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const addProjectButtonRef = useRef(null);
  const projectListRef = useRef(null);
  const [folder, setFolder] = useState('');
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [needsInit, setNeedsInit] = useState(null);
  const [statusRefresh, setStatusRefresh] = useState(0);
  const [statusResult, setStatusResult] = useState(null);
  const repoTargets = JSON.stringify(projects.map(project => [project.id, project.path]).sort());
  const statuses = statusResult?.targets === repoTargets ? statusResult.entries : {};
  const refreshing = projects.length > 0 && (statusResult?.targets !== repoTargets || statusResult.refresh !== statusRefresh);
  const jobsByProject = useMemo(() => new Map(projects.map(project => [
    project.id, jobs.filter(job => samePath(job.repo, project.path))
  ])), [projects, jobs]);
  const query = searchQuery.trim().toLowerCase();
  const visibleProjects = projects.filter(project => project.name.toLowerCase().includes(query) || project.path.toLowerCase().includes(query));
  const selectedProject = visibleProjects.find(project => project.id === selectedProjectId) ?? visibleProjects[0];

  useEffect(() => {
    const targets = JSON.parse(repoTargets);
    if (!targets.length) return;
    let current = true;
    async function loadStatuses() {
      const entries = await Promise.all(targets.map(async ([id, repo]) => {
        try { return [id, { ok: true, ...(await api('/repo/check', 'POST', { repo })) }]; }
        catch (error) { return [id, { ok: false, error: error.message }]; }
      }));
      if (current) setStatusResult({ targets: repoTargets, refresh: statusRefresh, entries: Object.fromEntries(entries) });
    }
    void loadStatuses();
    return () => { current = false; };
  }, [repoTargets, statusRefresh]);

  function projectAdded(project) {
    added(project);
    setSelectedProjectId(project.id);
    setSearchQuery('');
  }

  function projectRemoved(id, restoreFocus) {
    if (restoreFocus) {
      const next = projectListRef.current?.querySelector('button[aria-pressed="false"]');
      (next ?? addProjectButtonRef.current)?.focus();
    }
    setSelectedProjectId(current => current === id ? null : current);
    removed(id);
  }

  async function pick() {
    setPicking(true); setError('');
    try { const { path } = await api('/projects/pick', 'POST'); if (path) { setFolder(path); setNeedsInit(null); } }
    catch (error) { setError(error.message); }
    finally { setPicking(false); }
  }
  async function add(event) {
    event.preventDefault();
    if (pending || picking || !folder.trim()) return;
    setPending(true); setError(''); setNotice(''); setNeedsInit(null);
    try {
      const project = await api('/projects', 'POST', { path: folder, name });
      projectAdded(project);
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
      projectAdded(project);
      setNotice('เพิ่ม "' + project.name + '" แล้ว (ใช้ repo ที่ ' + project.path + ')');
      setNeedsInit(null); setFolder(''); setName('');
    } catch (error) { setError(error.message); }
    finally { setPending(false); }
  }
  async function init() {
    setPending(true); setError('');
    try {
      const project = await api('/projects/init', 'POST', { path: needsInit.folder, name });
      projectAdded(project);
      setNotice('สร้าง Git repo และ commit แรก ' + project.committed + ' ไฟล์แล้ว' + (project.createdIgnore ? ' พร้อมไฟล์ .gitignore' : '') + ' · เพิ่ม "' + project.name + '" แล้ว');
      setNeedsInit(null); setFolder(''); setName('');
    } catch (error) { setError(error.message); }
    finally { setPending(false); }
  }
  return <>
    <div className="projects-page" inert={addOpen}>
      <header className="projects-toolbar">
        <h2 id="projects-list-title">โปรเจกต์ของคุณ ({projects.length})</h2>
        <div className="projects-toolbar-actions">
          <div className="projects-search">
            <Search size={17} aria-hidden="true" />
            <input type="search" aria-label="ค้นหาโปรเจกต์จากชื่อหรือพาธ" placeholder="ค้นหาชื่อหรือพาธ"
              value={searchQuery} onChange={event => setSearchQuery(event.target.value)} />
          </div>
          <Button ref={addProjectButtonRef} primary icon={FolderPlus} aria-haspopup="dialog"
            onClick={() => { setNotice(''); setAddOpen(true); }}>เพิ่มโปรเจกต์</Button>
          <Button icon={RefreshCw} onClick={() => setStatusRefresh(count => count + 1)}
            disabled={!projects.length || refreshing} aria-busy={refreshing || undefined}>
            {refreshing ? 'กำลังตรวจสถานะ…' : 'ตรวจสถานะใหม่'}
          </Button>
        </div>
      </header>
      {visibleProjects.length ? <div className="projects-split">
        <section className="card projects-list-pane" aria-labelledby="projects-list-title">
          <ul ref={projectListRef} className="projects-list">
            {visibleProjects.map(project => {
              const latest = jobsByProject.get(project.id).at(-1);
              const pathLabel = project.path.length > 48 ? project.path.slice(0, 16) + '…' + project.path.slice(-28) : project.path;
              return <li key={project.id}>
                <button type="button" className="project-row" aria-pressed={project.id === selectedProject.id}
                  onClick={() => setSelectedProjectId(project.id)}>
                  <span className="provider-icon project-icon"><FolderGit2 size={19} aria-hidden="true" /></span>
                  <span className="project-row-main">
                    <strong>{project.name}</strong>
                    <span className="project-row-path" title={project.path}>{pathLabel}</span>
                  </span>
                  {latest ? <span className={'status ' + getJobStatusBadge(latest).status}>{getJobStatusBadge(latest).label}</span> : null}
                </button>
              </li>;
            })}
          </ul>
        </section>
        <ProjectDetail key={selectedProject.id} project={selectedProject} info={statuses[selectedProject.id]}
          projectJobs={jobsByProject.get(selectedProject.id)} createJob={createJob} removed={projectRemoved}
          select={select} updated={updated} />
      </div> : <section className="card empty project-empty-state" role="status">
        <span className="terminal">
          {projects.length ? <Search aria-hidden="true" /> : <FolderGit2 aria-hidden="true" />}
        </span>
        {projects.length ? <>
          <h3>ไม่พบโปรเจกต์</h3>
          <p>ลองค้นหาด้วยชื่อหรือพาธอื่น</p>
        </> : <>
          <h3>ยังไม่มีโปรเจกต์</h3>
          <p>เพิ่มโฟลเดอร์งานที่มีอยู่แล้ว เพื่อให้ AI เข้าไปทำงานต่อได้</p>
        </>}
      </section>}
    </div>
    <AddProjectModal open={addOpen} onClose={() => setAddOpen(false)} returnFocusRef={addProjectButtonRef}
      folder={folder} name={name} onFolderChange={value => { setFolder(value); setNeedsInit(null); }} onNameChange={setName}
      onPick={pick} picking={picking} pending={pending} needsInit={needsInit} onInit={init} onUseParent={useParent}
      onCancelInit={() => setNeedsInit(null)} error={error} notice={notice} onSubmit={add} />
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
        const asks = job.status === 'waiting_approval' && before !== 'waiting_approval';
        if (before && ((busyStatuses.has(before) && !busyStatuses.has(job.status)) || asks)) {
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
  const waiting = jobs?.filter(job => job.status === 'waiting_approval').length || 0;
  useEffect(() => {
    document.title = (waiting ? '(❗ ' + waiting + ') ' : unseen ? '(✓ ' + unseen + ') ' : running ? '(⏳) ' : '') + 'Relay';
  }, [unseen, running, waiting]);
}

function isEditableTarget(node) {
  const element = node?.nodeType === 1 ? node : node?.parentElement;
  if (!element) return false;
  if (element.isContentEditable || element.closest?.('input, textarea, select')) return true;
  const editable = element.closest?.('[contenteditable]');
  return Boolean(editable && editable.getAttribute('contenteditable')?.toLowerCase() !== 'false');
}

function App() {
  const { data, setData, monitor, networkError, setNetworkError, relayRestart, onAcceptanceUpdated, onSettingsUpdated } = useRelayConnection();
  const [page, setPage] = useState('queue');
  const [selection, setSelection] = useState(null);
  const [approvalTarget, setApprovalTarget] = useState(null);
  const [filter, setFilter] = useState('all');
  const [dialog, setDialog] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const { snapshot, connection } = monitor;
  useEffect(() => {
    if (!settingsDirty) return;
    const warn = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [settingsDirty]);
  const hasData = Boolean(data);
  useEffect(() => {
    if (!hasData || dialog) return;
    const onKeyDown = event => {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.key?.toLowerCase() !== 'n') return;
      if (isEditableTarget(event.target) || isEditableTarget(document.activeElement)) return;
      if (document.querySelector('dialog[open], [role="dialog"], [aria-modal="true"]')) return;
      event.preventDefault();
      setDialog({});
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [hasData, dialog]);
  useJobAlerts(data?.jobs);
  const leaveSettings = () => !settingsDirty || confirm('ออกจากหน้าตั้งค่าโดยไม่บันทึก?');
  function open(next) { if (next !== page && !leaveSettings()) return; setPage(next); setSelection(null); setApprovalTarget(null); }
  function select(id) { if (!leaveSettings()) return; setPage('queue'); setSelection(id); setApprovalTarget(null); }
  function openApproval(id) { if (!leaveSettings()) return; setPage('queue'); setSelection(id); setApprovalTarget(id); }
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
  const updateProject = (saved, field) => setData(previous => ({ ...previous,
    projects: previous.projects.map(project => project.id === saved.id ? { ...project, [field]: saved[field] } : project)
  }));
  const removeProject = id => setData(previous => ({ ...previous, projects: previous.projects.filter(item => item.id !== id) }));
  const job = jobs.find(item => item.id === selection);
  const projectName = job && (projects.find(project => samePath(project.path, job.repo))?.name || repoName(job.repo));
  const currentSnapshot = connection === 'stale' ? null : snapshot;
  const liveJobs = activeMonitorJobs(currentSnapshot);
  const activeEntries = currentSnapshot?.activeJobs ?? data?.activeJobs ?? [...jobs.filter(isQueueActive), ...liveJobs];
  const activeById = new Map(activeEntries.map(entry => [activeJobId(entry), entry]).filter(([id]) => id));
  for (const entry of liveJobs) if (activeById.has(entry.id)) activeById.set(entry.id, entry);
  const runningCount = activeById.size;
  const waitingCount = data ? jobs.filter(item => item.status === 'waiting_approval').length :
    liveJobs.filter(item => item.approval).length;
  const queuedCount = data ? jobs.filter(isQueueWaiting).length : currentSnapshot?.queuedCount ?? 0;
  const monitorFallback = !liveJobs.length ? jobs.find(item => isQueueActive(item) && activeById.has(item.id)) : null;
  const reserve = data?.settings.reserve ?? {};
  const pageKey = job ? 'job' : page;
  const badges = { queue: waitingCount ? { value: waitingCount, tone: 'warn' } : runningCount ? { value: runningCount, tone: 'brand' } : null,
    projects: projects.length ? { value: projects.length, tone: '' } : null };
  const cards = detailed => <div className="providers">{Object.keys(providers).map(id => <ProviderCard id={id} key={id} info={data?.quotas[id]} detailed={detailed} reserve={reserve[id] ?? 0} />)}</div>;
  return <div className="shell">
    <aside className="sidebar">
      <button className="brand" onClick={() => open('queue')}><img src="/relay.svg" alt="" width="34" height="34" /><span>Relay</span></button>
      <nav aria-label="เมนูหลัก">{pages.map(([id, label, Icon]) => <button key={id} type="button" aria-current={page === id && !job ? 'page' : undefined} onClick={() => open(id)}>
        <Icon size={19} aria-hidden="true" /><span>{label}</span>{badges[id] ? <i className={'nav-badge ' + badges[id].tone}>{badges[id].value}</i> : null}</button>)}</nav>
      <footer><span className={data && !networkError ? 'live' : ''} /><div>Local Server · {networkError ? 'ออฟไลน์' : data ? 'พร้อมใช้งาน' : 'กำลังเชื่อมต่อ'}<small>{location.host}</small></div></footer>
    </aside>
    <div className="workspace">
      <div className="workspace-header">
        <header className="topbar">
          <div className="page-title"><h1>{pageInfo[pageKey][0]}</h1><p>{pageInfo[pageKey][1]}</p></div>
          <div className="topbar-status" role="status">
            {runningCount ? <span className="pulse" aria-hidden="true" /> : <span className="idle-dot" aria-hidden="true" />}
            {runningCount ? 'กำลังทำ ' + runningCount + ' งาน' : 'ว่าง'}{waitingCount ? ' · รออนุมัติ ' + waitingCount : ''}{queuedCount ? ' · รอ ' + queuedCount : ''}</div>
          <div className="actions"><Button icon={RefreshCw} onClick={refresh} disabled={refreshing}>{refreshing ? 'กำลังรีเฟรช' : 'รีเฟรชโควตา'}</Button><Button primary icon={Plus} onClick={() => setDialog({})} disabled={!data} title="สร้างงาน (N)" aria-keyshortcuts="n">สร้างงาน</Button></div>
        </header>
        <RestartBanner relayRestart={relayRestart} />
      </div>
      <main>
        {networkError && !relayRestart.phase ? <p className="error banner" role="alert">{networkError}</p> : null}
        {job ? <JobDetail key={job.id} job={job} projectName={projectName} monitor={monitor} relayRestart={relayRestart}
          approvalRequested={approvalTarget === job.id}
          onApproval={openApproval} onApprovalFocused={() => setApprovalTarget(null)} back={() => open('queue')}
          retry={setDialog} updated={updateJob} removed={removeJob} onAcceptanceUpdated={onAcceptanceUpdated} /> :
          page === 'settings' ? <>
            {data ? <SettingsForm initial={data.settings} quotas={data.quotas} onDirty={setSettingsDirty} changed={onSettingsUpdated} /> : null}</> :
          page === 'projects' ? (data ? <ProjectsPage projects={projects} jobs={jobs} createJob={repo => setDialog({ repo })}
            added={addProject} removed={removeProject} select={select} updated={updateProject} /> : null) :
          page === 'quota' ? <>{cards(true)}</> :
          page === 'stats' ? <StatsPage api={api} providers={providers} ProviderIcon={ProviderIcon} openJob={select} /> :
          <>
            <Kpis jobs={jobs} onFilter={setFilter} onApproval={openApproval} />
            <div className="home-grid">
              <div className="home-main">
                <LiveMonitor monitor={monitor} job={liveJobs[0]} fallbackJob={monitorFallback} onDetails={select} onApproval={openApproval} showTeam />
                <Queue jobs={jobs} activeById={activeById} projects={projects} filter={filter} setFilter={setFilter} select={select}
                  create={() => setDialog({})} hasProjects={projects.length > 0} addProject={() => open('projects')} />
              </div>
              <AiStatus quotas={data?.quotas} reserve={reserve} onMore={() => open('quota')} />
            </div>
          </>}
      </main>
    </div>
    {dialog ? <NewJob previous={dialog} jobs={jobs} projects={projects} settings={data.settings} quotas={data.quotas} close={() => setDialog(null)} created={created => {
      updateJob(created); setPage('queue'); setSelection(created.id); setDialog(null);
    }} /> : null}
  </div>;
}

createRoot(document.getElementById('root')).render(<App />);
