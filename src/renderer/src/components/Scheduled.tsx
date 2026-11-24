import { useEffect, useState } from 'react'
import type { Schedule, ScheduledTask, Space } from '@shared/types'
import { api } from '../api'
import * as I from '../icons'
import { describeSchedule, nextRunText } from '../routines'

// Schedules in words live in ../routines (shared with the bot details panel).
export { describeSchedule }

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

/** Scheduled tasks: reminders and recurring jobs that run on their own (unattended). */
export function Scheduled({ spaces, onClose, onOpen }: { spaces: Space[]; onClose: () => void; onOpen: (t: ScheduledTask) => void }) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [form, setForm] = useState(false)
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [type, setType] = useState<Schedule['type']>('daily')
  const [time, setTime] = useState('09:00')
  const [at, setAt] = useState(() => new Date(Date.now() + 3600_000 - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16))
  const [days, setDays] = useState<string[]>(['mon', 'wed', 'fri'])
  const [minutes, setMinutes] = useState(60)
  const [expr, setExpr] = useState('0 9 * * 1-5')
  const [spaceId, setSpaceId] = useState(spaces.find((s) => s.isMain)?.id ?? '')
  const [err, setErr] = useState('')

  const [running, setRunning] = useState<Set<string>>(new Set())
  const load = (): void => void api.schedules.list().then(async (ts) => {
    setTasks(ts)
    // A routine is running while its newest run is.
    const live = await Promise.all(ts.map(async (t) => ((await api.schedules.runs(t.id).catch(() => []))[0]?.status === 'running' ? t.id : null)))
    setRunning(new Set(live.filter((x): x is string => !!x)))
  })
  const fail = (e: unknown): void => setErr((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
  useEffect(() => { load(); return api.schedules.onChange(load) }, [])
  useEffect(() => {
    // preventDefault: this Esc is spent closing this (the chat's run and the details panel leave it alone).
    const k = (e: KeyboardEvent): void => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); onClose() } }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])

  const schedule = (): Schedule => type === 'once' ? { type, at: new Date(at).toISOString() } : type === 'daily' ? { type, time } : type === 'weekly' ? { type, days, time } : type === 'every' ? { type, minutes } : { type: 'cron', expr }

  const create = async (): Promise<void> => {
    setErr('')
    try {
      await api.schedules.create({ title, prompt, schedule: schedule(), spaceId })
      setForm(false)
      setTitle('')
      setPrompt('')
    } catch (e) {
      setErr((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: 'min(720px, 94vw)' }} data-testid="scheduled">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h2 style={{ flex: 1 }}>Scheduled</h2>
          <button className="btn primary" onClick={() => setForm((f) => !f)} data-testid="schedule-new"><I.Plus size={14} /> New task</button>
          <button className="icon-btn" onClick={onClose} title="Close" aria-label="Close"><I.Close size={16} /></button>
        </div>
        <div className="hint">Tasks run on their own at the times you set. With nobody watching, anything that would need your OK is skipped and reported instead. You can also just ask: "remind me every Monday at 9 to send the report".</div>

        {form && (
          <div className="conn-form">
            <div className="field"><label>Title</label><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Morning inbox summary" data-testid="schedule-title" /></div>
            <div className="field"><label>Instructions</label><textarea style={{ minHeight: 90, fontFamily: 'var(--font)' }} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Summarize unread email from clients and list anything urgent." data-testid="schedule-prompt" /></div>
            <div className="field"><label>When</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div className="seg">{(['once', 'daily', 'weekly', 'every', 'cron'] as const).map((t) => <button key={t} className={type === t ? 'on' : ''} onClick={() => setType(t)}>{t[0].toUpperCase() + t.slice(1)}</button>)}</div>
                {type === 'once' && <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />}
                {(type === 'daily' || type === 'weekly') && <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />}
                {type === 'weekly' && <div style={{ display: 'flex', gap: 4 }}>{DAYS.map((d) => <button key={d} className={`day${days.includes(d) ? ' on' : ''}`} onClick={() => setDays((xs) => xs.includes(d) ? xs.filter((x) => x !== d) : [...xs, d])}>{d.slice(0, 2)}</button>)}</div>}
                {type === 'every' && <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="number" min={1} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} style={{ width: 90 }} /> minutes</div>}
                {type === 'cron' && <input value={expr} onChange={(e) => setExpr(e.target.value)} placeholder="minute hour day month weekday" />}
              </div>
            </div>
            <div className="field"><label>Run in</label>
              <select value={spaceId} onChange={(e) => setSpaceId(e.target.value)}>{spaces.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
            </div>
            {err && <div className="hint error">{err}</div>}
            <div className="modal-actions"><button className="btn" onClick={() => setForm(false)}>Cancel</button><button className="btn primary" onClick={() => void create()} data-testid="schedule-save">Schedule</button></div>
          </div>
        )}

        <div style={{ marginTop: 14 }}>
          {err && !form && <div className="hint error" style={{ marginBottom: 8 }} role="alert">{err}</div>}
          {tasks.length === 0 && !form && <div className="hint" style={{ padding: '18px 0', textAlign: 'center' }}>Nothing scheduled yet.</div>}
          {tasks.map((t) => (
            <div key={t.id} className="sched-row" data-testid="schedule-row">
              <I.Clock size={17} />
              <div className="sched-text" onClick={() => t.threadId && onOpen(t)} role="button" tabIndex={t.threadId ? 0 : -1}
                onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && t.threadId) { e.preventDefault(); onOpen(t) } }}>
                <b>{t.title}</b>
                <span className="hint">{running.has(t.id) ? 'Running…' : t.enabled ? describeSchedule(t.schedule) : 'Paused'} · {spaces.find((s) => s.id === t.spaceId)?.name ?? 'SahilBot'}{t.enabled && t.nextRun && !running.has(t.id) ? ` · next ${nextRunText(t.schedule, t.nextRun)}` : ''}{t.lastStatus && !running.has(t.id) ? ` · last: ${t.lastStatus}` : ''}</span>
              </div>
              <label className="switch" title={t.enabled ? 'Pause' : 'Resume'}><input type="checkbox" checked={t.enabled} onChange={(e) => { setErr(''); api.schedules.update(t.id, { enabled: e.target.checked }).catch(fail) }} /><span /></label>
              <button className="icon-btn" title={running.has(t.id) ? 'Running…' : 'Test (run now)'} aria-label={running.has(t.id) ? 'Running' : 'Test (run now)'} disabled={running.has(t.id)} onClick={() => { setErr(''); setRunning((r) => new Set(r).add(t.id)); api.schedules.runNow(t.id).catch(fail) }} data-testid="schedule-run"><I.Play size={15} /></button>
              <button className="icon-btn" title="Delete" aria-label="Delete" onClick={() => { if (confirm(`Delete "${t.title}"? This can't be undone.`)) api.schedules.remove(t.id).catch(fail) }}><I.Trash size={15} /></button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
