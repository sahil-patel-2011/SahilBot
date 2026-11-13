import { useEffect, useRef, useState } from 'react'
import type { TeachState } from '@shared/types'
import { api } from '../api'
import { toast } from '../lib/toast'

// "Teach a task": the bar shown over the browser panel while SahilBot records the user's steps,
// then a small sheet that names the task and sends the recording to the bot's chat.

const clock = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const errText = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export function TeachBar({ state, threadId }: { state: TeachState; threadId?: string | null }) {
  const [now, setNow] = useState(Date.now())
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState(state.name ?? '')
  const [goal, setGoal] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  const recording = state.status === 'recording'
  useEffect(() => {
    if (!recording) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [recording])
  useEffect(() => { if (naming) nameRef.current?.focus() }, [naming])
  // A recording that stopped at a cap goes straight to naming.
  useEffect(() => { if (state.status === 'stopped') setNaming(true) }, [state.status])

  const elapsed = (state.stoppedAt ?? now) - state.startedAt
  // A recording the bot asked for goes back to that bot's chat; yours goes to the chat you're in.
  const target = state.threadId ?? threadId ?? null

  const done = async (): Promise<void> => {
    setErr(null)
    try {
      await api.browser.teachStop()
      setNaming(true)
    } catch (e) { setErr(errText(e)) }
  }

  const send = async (): Promise<void> => {
    if (!name.trim() || busy) return
    setBusy(true)
    setErr(null)
    try {
      const m = await api.browser.teachCompose(name.trim(), goal.trim() || undefined)
      const tid = target ?? m.threadId
      if (tid) {
        await api.chat.send({ threadId: tid, text: m.text, note: m.note, meta: { teach: { name: name.trim(), steps: state.steps } } })
      } else {
        // No chat to send to: hand it over on the clipboard instead of losing it.
        await navigator.clipboard.writeText(m.text)
        toast('Recording copied. Paste it into a chat with your bot.', 'ok')
      }
    } catch (e) {
      setErr(errText(e))
      setBusy(false)
    }
  }

  const cancel = (): void => { void api.browser.teachCancel() }

  if (naming || state.status === 'stopped') {
    const empty = state.steps === 0
    return (
      <div className="teach-sheet" data-testid="teach-sheet">
        <div className="teach-sheet-head">
          <span className="teach-dot off" />
          <b>{empty ? 'Nothing was recorded' : `Recorded ${state.steps} step${state.steps === 1 ? '' : 's'}`}</b>
          <span className="teach-time">{clock(elapsed)}</span>
          {state.limit && <span className="teach-limit">{state.limit === 'time' ? 'Reached the 10-minute limit' : 'Reached the 300-step limit'}</span>}
        </div>
        {empty ? (
          <div className="teach-empty">Clicks, typing and pages you open in this panel are recorded. Try again and do the task here.</div>
        ) : (
          <form className="teach-form" onSubmit={(e) => { e.preventDefault(); void send() }}>
            <label className="teach-q" htmlFor="teach-name">What should this be called, and what does it do?</label>
            <input id="teach-name" ref={nameRef} className="teach-input" value={name} maxLength={80} placeholder="e.g. Download this month's invoices"
              onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') cancel() }} data-testid="teach-name" />
            <input className="teach-input" value={goal} maxLength={300} placeholder="What it's for, in one line (optional)"
              onChange={(e) => setGoal(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') cancel() }} data-testid="teach-goal" />
            {state.recent.length > 0 && (
              <ol className="teach-recent" start={Math.max(1, state.steps - state.recent.length + 1)}>
                {state.recent.map((r, i) => <li key={i}>{r}</li>)}
              </ol>
            )}
            {err && <div className="teach-err">{err}</div>}
            <div className="teach-actions">
              <span className="teach-hint">{target ? 'Your bot turns it into a skill it can repeat.' : 'No chat is open: it will be copied for you to paste.'}</span>
              <button type="button" className="btn" onClick={cancel}>Discard</button>
              <button type="submit" className="btn primary" disabled={!name.trim() || busy} data-testid="teach-send">{busy ? 'Sending…' : target ? 'Teach my bot' : 'Copy'}</button>
            </div>
          </form>
        )}
        {empty && <div className="teach-actions"><span className="teach-hint" /><button className="btn" onClick={cancel}>Close</button></div>}
      </div>
    )
  }

  return (
    <div className="teach-bar" data-testid="teach-bar" role="status" aria-live="polite">
      <div className="teach-row">
        <span className="teach-dot" aria-hidden />
        <b>{state.by === 'agent' ? 'Show me once' : 'Recording'}</b>
        <span className="teach-time">{clock(elapsed)}</span>
        <span className="teach-count">{state.steps} step{state.steps === 1 ? '' : 's'}</span>
        <span className="spacer" />
        <button className="teach-cancel" onClick={cancel} data-testid="teach-cancel">Cancel</button>
        <button className="teach-done" onClick={() => void done()} data-testid="teach-done">Done</button>
      </div>
      {state.recent.length ? (
        <ol className="teach-recent" start={Math.max(1, state.steps - state.recent.length + 1)}>
          {state.recent.map((r, i) => <li key={`${state.steps}-${i}`}>{r}</li>)}
        </ol>
      ) : (
        <div className="teach-empty">{state.by === 'agent' && state.name ? `Do "${state.name}" in this panel. ` : 'Do the task in this panel. '}Passwords and codes are never recorded.</div>
      )}
      {err && <div className="teach-err">{err}</div>}
    </div>
  )
}
