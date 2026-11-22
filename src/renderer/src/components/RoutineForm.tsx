import { useState } from 'react'
import { api } from '../api'
import { formSchedule, titleFrom, type Repeat } from '../routines'
import { toast } from '../lib/toast'

/**
 * A routine without typing a request: what to do, how often, and when. (Grok Bot's "Create a routine" only
 * pre-fills a question; this makes the routine.) Chat still works for anything fancier.
 */
const DAYS: Array<[string, string]> = [['mon', 'M'], ['tue', 'T'], ['wed', 'W'], ['thu', 'T'], ['fri', 'F'], ['sat', 'S'], ['sun', 'S']]
const pad = (n: number): string => String(n).padStart(2, '0')

export function RoutineForm({ spaceId, onDone }: { spaceId: string; onDone: () => void }) {
  const soon = new Date(Date.now() + 60 * 60_000)
  const [prompt, setPrompt] = useState('')
  const [repeat, setRepeat] = useState<Repeat>('daily')
  const [date, setDate] = useState(`${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())}`)
  const [time, setTime] = useState('09:00')
  const [days, setDays] = useState<string[]>(['mon'])
  const [busy, setBusy] = useState(false)
  const schedule = formSchedule({ repeat, date, time, days })
  const ok = !!prompt.trim() && !!schedule
  const save = async (): Promise<void> => {
    if (!ok || !schedule) return
    setBusy(true)
    try {
      await api.schedules.create({ title: titleFrom(prompt), prompt: prompt.trim(), schedule, spaceId })
      toast('Routine saved', 'ok')
      onDone()
    } catch (e) { toast(String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error') } finally { setBusy(false) }
  }
  return (
    <div className="rt-form" data-testid="routine-form">
      <label className="rt-form-label" htmlFor="rt-prompt">What should it do?</label>
      <textarea id="rt-prompt" className="set-input rt-form-prompt" rows={2} value={prompt} autoFocus placeholder="e.g. Send me a short science fact" onChange={(e) => setPrompt(e.target.value)} data-testid="routine-form-prompt" />
      <div className="rt-form-label">How often</div>
      <div className="rt-form-repeat" role="radiogroup" aria-label="How often">
        {(['once', 'daily', 'weekdays', 'weekly'] as Repeat[]).map((r) => (
          <button key={r} type="button" role="radio" aria-checked={repeat === r} className={repeat === r ? 'on' : ''} onClick={() => setRepeat(r)} data-testid={`routine-form-${r}`}>
            {r === 'once' ? 'Once' : r === 'daily' ? 'Every day' : r === 'weekdays' ? 'Weekdays' : 'Some days'}
          </button>
        ))}
      </div>
      {repeat === 'weekly' && (
        <div className="rt-form-days" role="group" aria-label="Days">
          {DAYS.map(([d, l]) => (
            <button key={d} type="button" aria-pressed={days.includes(d)} aria-label={d} className={days.includes(d) ? 'on' : ''} onClick={() => setDays((x) => (x.includes(d) ? x.filter((y) => y !== d) : [...x, d]))} data-testid={`routine-form-day-${d}`}>{l}</button>
          ))}
        </div>
      )}
      <div className="rt-form-when">
        {repeat === 'once' && <input type="date" className="set-input" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" data-testid="routine-form-date" />}
        <input type="time" className="set-input" value={time} onChange={(e) => setTime(e.target.value)} aria-label="Time" data-testid="routine-form-time" />
      </div>
      {repeat === 'once' && prompt.trim() && !schedule && <div className="hint error">Pick a time in the future.</div>}
      <div className="rt-form-actions">
        <button className="bd-btn" onClick={onDone}>Cancel</button>
        <button className="bd-btn primary" disabled={!ok || busy} onClick={() => void save()} data-testid="routine-form-save">{busy ? 'Saving…' : 'Save routine'}</button>
      </div>
    </div>
  )
}
