import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ChatEvent, JobEvent, JobInfo, Message, PermissionMode, RunUsage } from '@shared/types'
import { api } from '../api'
import * as I from '../icons'
import { fmtTokens, fmtUsd, plural, runFacts, statusLine, usageText } from '../lib/run-summary'

// Background jobs (dev servers, watchers, long builds) a chat started with run_command background: true:
// the Jobs tab, the header chip, and the end-of-run summary line (actions, tokens, cost).

// ---------------------------------------------------------------- store (one for the window)

const MAX_LINES = 2000
const store = {
  jobs: new Map<string, JobInfo>(),
  lines: new Map<string, { lines: string[]; total: number }>(),
  subs: new Set<() => void>(),
  version: 0,
  started: false
}
const bump = (): void => { store.version++; for (const fn of store.subs) fn() }

function ensure(): void {
  if (store.started || !api?.jobs) return
  store.started = true
  void api.jobs.list().then((list) => { for (const j of list) store.jobs.set(j.id, j); bump() }).catch(() => undefined)
  api.jobs.onEvent((e: JobEvent) => {
    if (e.kind === 'job') store.jobs.set(e.job.id, e.job)
    else if (e.kind === 'removed') { store.jobs.delete(e.id); store.lines.delete(e.id) }
    else {
      const cur = store.lines.get(e.id)
      if (cur) {
        const lines = cur.lines.concat(e.lines)
        store.lines.set(e.id, { lines: lines.length > MAX_LINES ? lines.slice(-MAX_LINES) : lines, total: e.total })
      }
    }
    bump()
  })
}

const subscribe = (fn: () => void): (() => void) => { ensure(); store.subs.add(fn); return () => { store.subs.delete(fn) } }
const live = (j: JobInfo): boolean => j.status === 'starting' || j.status === 'running' || j.status === 'ready'

/** This chat's jobs, newest first (live updates). */
export function useJobs(threadId: string | null | undefined): JobInfo[] {
  const v = useSyncExternalStore(subscribe, () => store.version)
  return useMemo(() => (threadId ? [...store.jobs.values()].filter((j) => j.threadId === threadId).sort((a, b) => b.startedAt - a.startedAt) : []), [threadId, v])
}

function useLines(id: string): { lines: string[]; total: number } | undefined {
  useSyncExternalStore(subscribe, () => store.version)
  useEffect(() => {
    if (store.lines.has(id)) return
    let alive = true
    void api.jobs.output(id, { tail: 600 }).then((r) => {
      if (!alive) return
      const cur = store.lines.get(id)
      if (!cur || r.total >= cur.total) store.lines.set(id, { lines: r.lines, total: r.total })
      bump()
    })
    return () => { alive = false }
  }, [id])
  return store.lines.get(id)
}

/** Re-renders every second (uptimes). */
function useNow(on: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!on) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [on])
  return now
}

const duration = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}

const STATUS: Record<JobInfo['status'], string> = { starting: 'Starting', running: 'Running', ready: 'Ready', exited: 'Finished', failed: 'Failed', stopped: 'Stopped' }

export const TerminalIcon = ({ size = 15 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="4.5" width="18" height="15" rx="3" /><path d="m7.5 10 3 2.5-3 2.5M12.5 15.5h4" />
  </svg>
)

const tilde = (p: string): string => p.replace(/^\/Users\/[^/]+/, '~')

// ---------------------------------------------------------------- the Jobs tab

export function JobsPanel({ threadId, onOpenUrl }: { threadId: string | null; onOpenUrl: (url: string) => void }) {
  const list = useJobs(threadId)
  const running = list.filter(live)
  const [open, setOpen] = useState<string | null>(null)
  // The newest running job starts open.
  const first = running[0]?.id ?? list[0]?.id ?? null
  const expanded = open ?? first
  if (!list.length) {
    return (
      <div className="jobs-pane" data-testid="jobs-panel">
        <div className="jobs-empty">
          <TerminalIcon size={22} />
          <b>No background jobs</b>
          <span>Dev servers, watchers and long builds SahilBot starts for this chat show up here, with their live output.</span>
        </div>
      </div>
    )
  }
  return (
    <div className="jobs-pane" data-testid="jobs-panel">
      <div className="jobs-summary">
        <span className={`job-dot${running.length ? ' s-running' : ' s-exited'}`} aria-hidden />
        <b>{running.length ? `${running.length} running` : 'Nothing running'}</b>
        {list.length > running.length && <span className="hint">{list.length - running.length} finished</span>}
        <span className="spacer" />
        {running.length > 1 && <button className="btn small" onClick={() => { for (const j of running) void api.jobs.stop(j.id) }} data-testid="jobs-stop-all">Stop all</button>}
      </div>
      {list.map((j) => <JobCard key={j.id} job={j} expanded={expanded === j.id} onToggle={() => setOpen(expanded === j.id ? '' : j.id)} onOpenUrl={onOpenUrl} />)}
    </div>
  )
}

function JobCard({ job, expanded, onToggle, onOpenUrl }: { job: JobInfo; expanded: boolean; onToggle: () => void; onOpenUrl: (url: string) => void }) {
  const now = useNow(live(job))
  const [busy, setBusy] = useState<'stop' | 'restart' | null>(null)
  const up = (job.endedAt ?? now) - job.startedAt
  const url = job.urls[0]
  const act = (what: 'stop' | 'restart'): void => {
    setBusy(what)
    void (what === 'stop' ? api.jobs.stop(job.id) : api.jobs.restart(job.id)).finally(() => setBusy(null))
  }
  return (
    <section className={`job-card s-${job.status}${expanded ? ' open' : ''}`} data-testid="job-card" data-status={job.status} aria-label={`Job ${job.id}: ${job.command}`}>
      <div className="job-head">
        <button className="job-toggle" onClick={onToggle} aria-expanded={expanded} title={job.command}>
          <span className={`job-dot s-${job.status}`} aria-hidden />
          <span className="job-cmd">{job.command}</span>
          <I.Chevron size={13} className="job-chev" />
        </button>
        <div className="job-actions">
          {live(job) ? (
            <button className="btn small danger-ghost" disabled={busy !== null} onClick={() => act('stop')} data-testid="job-stop" aria-label={`Stop ${job.command}`}>
              {busy === 'stop' ? <span className="spin" /> : <I.Stop size={12} />}Stop
            </button>
          ) : (
            <button className="icon-btn small" onClick={() => void api.jobs.remove(job.id)} title="Remove from the list" aria-label="Remove job" data-testid="job-remove"><I.Close size={13} /></button>
          )}
          <button className="btn small" disabled={busy !== null} onClick={() => act('restart')} data-testid="job-restart" aria-label={`Restart ${job.command}`}>
            {busy === 'restart' ? <span className="spin" /> : <span aria-hidden>↻</span>}Restart
          </button>
        </div>
      </div>
      <div className="job-meta">
        <span className={`job-state s-${job.status}`}>{STATUS[job.status]}{!live(job) && job.exitCode !== null && job.status !== 'stopped' ? ` · exit ${job.exitCode}` : ''}</span>
        <span title="Uptime"><I.Clock size={11} />{duration(up)}</span>
        <span className="job-cwd" title={job.cwd}><I.Folder size={11} />{tilde(job.cwd)}</span>
        {typeof job.cpu === 'number' && live(job) && job.cpu > 0 && <span title="CPU (percent of one core)">{job.cpu}% CPU</span>}
        {job.restarts > 0 && <span>restarted {job.restarts}×</span>}
      </div>
      {url && (
        <div className="job-url">
          <I.Globe size={13} />
          <button className="job-link" onClick={() => onOpenUrl(url)} title={`Open ${url} in the browser panel`} data-testid="job-open">{url.replace(/^https?:\/\//, '')}</button>
          <span className="spacer" />
          <button className="btn small" onClick={() => onOpenUrl(url)}>Open</button>
          <button className="icon-btn small" title="Copy address" aria-label="Copy address" onClick={() => void navigator.clipboard?.writeText(url)}><I.Copy size={13} /></button>
        </div>
      )}
      {job.warning && <div className="job-warn" role="alert">⚠ {job.warning}</div>}
      {expanded && <JobOutput id={job.id} liveJob={live(job)} />}
    </section>
  )
}

function JobOutput({ id, liveJob }: { id: string; liveJob: boolean }) {
  const data = useLines(id)
  const box = useRef<HTMLPreElement>(null)
  const [follow, setFollow] = useState(true)
  const [q, setQ] = useState('')
  const lines = data?.lines ?? []
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase()
    return t ? lines.filter((l) => l.toLowerCase().includes(t)) : lines
  }, [lines, q])
  // Follow the end while you're at the bottom; scrolling up pauses it.
  useEffect(() => {
    const el = box.current
    if (el && follow) el.scrollTop = el.scrollHeight
  }, [shown, follow])
  const onScroll = (): void => {
    const el = box.current
    if (!el) return
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    if (atEnd !== follow) setFollow(atEnd)
  }
  const mark = (l: string) => {
    const t = q.trim()
    if (!t) return l
    const i = l.toLowerCase().indexOf(t.toLowerCase())
    return i < 0 ? l : <>{l.slice(0, i)}<mark>{l.slice(i, i + t.length)}</mark>{l.slice(i + t.length)}</>
  }
  return (
    <div className="job-out">
      <div className="job-out-bar">
        <label className="job-search">
          <I.Search size={12} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search output" aria-label="Search output" data-testid="job-search" />
        </label>
        <span className="hint">{q ? `${shown.length} match${shown.length === 1 ? '' : 'es'}` : `${data?.total ?? 0} lines`}</span>
      </div>
      <pre ref={box} className="job-log" onScroll={onScroll} role="log" aria-label="Job output" tabIndex={0} data-testid="job-log">
        {data === undefined ? <span className="hint">Loading…</span> : shown.length === 0 ? <span className="hint">{q ? 'No matching lines.' : liveJob ? 'Waiting for output…' : '(no output)'}</span> : shown.map((l, i) => <div key={i} className={/\b(error|failed|exception|ERR!)\b/i.test(l) ? 'err' : /\bwarn(ing)?\b/i.test(l) ? 'warn' : undefined}>{mark(l) || ' '}</div>)}
      </pre>
      {!follow && <button className="job-jump" onClick={() => setFollow(true)} data-testid="job-follow"><I.Down size={12} />Paused · jump to latest</button>}
    </div>
  )
}

// ---------------------------------------------------------------- header chip

export function JobsChip({ threadId, on, onOpen }: { threadId: string | null | undefined; on?: boolean; onOpen: () => void }) {
  const list = useJobs(threadId)
  const running = list.filter(live)
  if (!running.length) return null
  const warn = running.some((j) => j.warning)
  return (
    <button className={`jobs-chip${on ? ' on' : ''}${warn ? ' warn' : ''}`} onClick={onOpen} data-testid="jobs-chip"
      title={running.map((j) => `${j.command}${j.urls[0] ? ` · ${j.urls[0]}` : ''}`).join('\n')} aria-label={`${running.length} background job${running.length === 1 ? '' : 's'} running. Open the Jobs tab`}>
      <span className="job-dot s-running" aria-hidden />
      <TerminalIcon size={14} />
      {running.length} job{running.length === 1 ? '' : 's'}
    </button>
  )
}

// ---------------------------------------------------------------- end-of-run summary

/** Approvals and questions each chat's current run asked (counted live from chat events). */
const asks = new Map<string, { since: number; n: number }>()
if (typeof window !== 'undefined' && api?.chat) {
  api.chat.onEvent((e: ChatEvent) => {
    if (e.type === 'run' && e.status === 'started') asks.set(e.threadId, { since: Date.now(), n: 0 })
    else if (e.type === 'pending') { const a = asks.get(e.threadId); if (a) a.n++ }
  })
}

export function RunSummary({ threadId, messages, mode, simple }: { threadId: string; messages: Message[]; mode: PermissionMode; simple?: boolean }) {
  const facts = useMemo(() => runFacts(messages), [messages])
  const [usage, setUsage] = useState<RunUsage | null>(null)
  const since = facts?.since ?? 0
  const count = messages.length
  useEffect(() => {
    setUsage(null)
    if (!since || !api?.usage?.forRun) return
    let alive = true
    void api.usage.forRun(threadId, since).then((u) => { if (alive) setUsage(u) }).catch(() => undefined)
    return () => { alive = false }
  }, [threadId, since, count])
  // Everyone sees the finish line after real work; a quick chat answer needs none.
  if (!facts || (simple && facts.actions === 0)) return null
  const a = asks.get(threadId)
  const asked = a && a.since >= since - 10_000 ? a.n : undefined
  const line = statusLine(facts, usage, { asked })
  if (!line) return null
  // The permission level shows only when it isn't the default (Auto).
  const level = mode === 'ask' ? 'Ask' : mode === 'bypass' ? 'Bypass' : null
  const tokens = usageText(usage, true)
  return (
    <div className={`run-summary${facts.actions === 0 ? ' quiet' : ''}`} data-testid="run-summary" tabIndex={tokens ? 0 : -1} aria-label={`${line}${tokens ? `. ${tokens}` : ''}`}>
      <span className="rs-line">
        {level && <span className={`rs-badge${mode === 'bypass' ? ' danger' : ''}`} data-testid="run-summary-level">{level}</span>}
        <span className="rs-words">{line}</span>
      </span>
      {tokens && (
        <span className="rs-tip" role="tooltip">
          <span className="rs-row rs-total"><b>This reply</b><span>{tokens}</span></span>
          {usage && usage.models.map((m) => (
            <span key={m.model} className="rs-row">
              <b>{m.model}</b>
              <span>{plural(m.calls, 'call')} · {fmtTokens(m.input)} in / {fmtTokens(m.output)} out · {m.cloud ? fmtUsd(m.usd) : 'local'}</span>
            </span>
          ))}
          <span className="rs-row rs-foot">Monthly totals: Settings → Usage</span>
        </span>
      )}
    </div>
  )
}
