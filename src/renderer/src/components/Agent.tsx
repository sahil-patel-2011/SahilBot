import { useState } from 'react'
import type { PendingRequest } from '@shared/types'
import { api } from '../api'
import * as I from '../icons'

const EFFECT_TEXT: Record<string, string> = {
  read: 'Reads only',
  write_local: 'Changes files on this Mac',
  write_external: 'Acts outside this Mac',
  destructive: 'Can delete or overwrite'
}

/** One click: sign in (browser opens for OAuth), and the agent continues with the new tools. */
function ConnectCard({ req, onRespond }: { req: PendingRequest; onRespond: (id: string, answer: string) => void }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const p = req.preset!
  const go = async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    try {
      const st = await api.connectors.connectPreset(p.id)
      if (st.state === 'connected') onRespond(req.id, 'connected')
      else setErr(st.error ?? 'Sign-in did not finish.')
    } catch (e) {
      setErr((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="pending connect-card" data-testid="connect-card">
      <div className="pending-title">
        <span className="conn-logo" style={{ background: p.color }}>{p.name[0]}</span>
        Connect {p.name} to continue?
      </div>
      <div className="hint">{p.description} {p.auth === 'none' ? 'No sign-in needed.' : 'You sign in on their site; your login is stored in your Mac\'s Keychain.'}</div>
      {err && <div className="hint" style={{ color: 'var(--danger)' }}>{err}</div>}
      <div className="pending-actions">
        <button className="btn primary" disabled={busy} onClick={() => void go()} data-testid="connect-card-go">{busy ? (p.auth === 'none' ? 'Connecting…' : 'Waiting for sign-in…') : `Connect ${p.name}`}</button>
        <button className="btn" onClick={() => onRespond(req.id, 'skip')}>Not now</button>
      </div>
    </div>
  )
}

/** Several clarifying questions in one card: pick an option or type your own, then send them all. */
function QuestionsCard({ req, onRespond }: { req: PendingRequest; onRespond: (id: string, answer: string) => void }) {
  const qs = req.questions ?? []
  const [answers, setAnswers] = useState<string[]>(() => qs.map(() => ''))
  const set = (i: number, v: string): void => setAnswers((a) => a.map((x, j) => (j === i ? v : x)))
  const ready = answers.some((a) => a.trim())
  return (
    <div className="pending qcard" data-testid="questions-card">
      <div className="pending-title"><I.Sparkle size={15} /> A few questions before I start</div>
      {qs.map((q, i) => (
        <div key={i} className="qcard-q">
          <div className="qcard-text"><span className="qcard-n">{i + 1}</span>{q.question}</div>
          {!!q.options?.length && (
            <div className="qcard-opts">
              {q.options.map((o) => <button key={o} className={`qcard-opt${answers[i] === o ? ' on' : ''}`} onClick={() => set(i, answers[i] === o ? '' : o)} data-testid="qcard-option">{o}</button>)}
            </div>
          )}
          <input className="set-input qcard-input" placeholder={q.options?.length ? 'Or type your own answer' : 'Your answer'} value={q.options?.includes(answers[i]) ? '' : answers[i]} onChange={(e) => set(i, e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && ready) onRespond(req.id, JSON.stringify(answers)) }} data-testid="qcard-input" />
        </div>
      ))}
      <div className="pending-actions">
        <button className="btn primary" disabled={!ready} onClick={() => onRespond(req.id, JSON.stringify(answers))} data-testid="qcard-send">Send answers</button>
        <button className="btn" onClick={() => onRespond(req.id, JSON.stringify(qs.map(() => '')))}>Skip: use your judgment</button>
      </div>
    </div>
  )
}

/** The agent's plan, waiting for your OK: approve to start, or say what to change. */
function PlanApprovalCard({ req, onRespond }: { req: PendingRequest; onRespond: (id: string, answer: string) => void }) {
  const p = req.plan!
  const [changing, setChanging] = useState(false)
  const [notes, setNotes] = useState('')
  return (
    <div className="pending plan-approval" data-testid="plan-approval">
      <div className="pending-title"><I.ListIcon size={15} /> Here's my plan</div>
      <div className="pa-goal">{p.goal}</div>
      <ol className="pa-steps">{p.steps.map((s, i) => <li key={i}><span className="pa-n">{i + 1}</span>{s}</li>)}</ol>
      {!!p.assumptions?.length && <div className="pa-meta"><b>Assuming</b> {p.assumptions.join(' · ')}</div>}
      {!!p.risks?.length && <div className="pa-meta risk"><b>Watch out</b> {p.risks.join(' · ')}</div>}
      {changing ? (
        <div className="pa-change">
          <textarea className="set-input" rows={3} autoFocus placeholder="What should change? e.g. skip step 3, use Notion instead of a PDF…" value={notes} onChange={(e) => setNotes(e.target.value)} data-testid="plan-notes" />
          <div className="pending-actions">
            <button className="btn primary" disabled={!notes.trim()} onClick={() => onRespond(req.id, `revise: ${notes.trim()}`)} data-testid="plan-send-changes">Send changes</button>
            <button className="btn" onClick={() => setChanging(false)}>Back</button>
          </div>
        </div>
      ) : (
        <div className="pending-actions">
          <button className="btn primary" onClick={() => onRespond(req.id, 'approve')} data-testid="plan-approve">Approve & start</button>
          <button className="btn" onClick={() => setChanging(true)} data-testid="plan-change">Change…</button>
        </div>
      )}
    </div>
  )
}

export function PendingCard({ req, onRespond }: { req: PendingRequest; onRespond: (id: string, answer: string) => void }) {
  if (req.kind === 'connect' && req.preset) return <ConnectCard req={req} onRespond={onRespond} />
  if (req.kind === 'questions' && req.questions) return <QuestionsCard req={req} onRespond={onRespond} />
  if (req.kind === 'plan' && req.plan) return <PlanApprovalCard req={req} onRespond={onRespond} />
  if (req.kind === 'question') {
    return (
      <div className="question" data-testid="question-card">
        <div className="question-title">{req.question}</div>
        {req.options?.length ? (
          <div className="question-options">
            {req.options.map((o, i) => (
              <button key={o} className="question-option" onClick={() => onRespond(req.id, o)}>
                <span className="letter">{String.fromCharCode(65 + i)}</span>{o}
              </button>
            ))}
          </div>
        ) : (
          <div className="hint">Answer in the message box below.</div>
        )}
      </div>
    )
  }
  const danger = req.effect === 'destructive' || req.reason?.startsWith('Hard stop')
  return (
    <div className={`pending${danger ? ' danger' : ''}`} data-testid="approval-card" data-id={req.id}>
      <div className="pending-title"><I.Shield size={15} /> Allow {req.label ?? req.tool}?</div>
      {req.summary && <div className="pending-q" data-testid="approval-summary">{req.summary}</div>}
      <div className="hint">{EFFECT_TEXT[req.effect ?? 'read']}{req.reason ? ` · ${req.reason}` : ''}</div>
      <details className="pending-details" open={!req.summary}>
        <summary className="hint">Details</summary>
        <pre className="pending-args">{req.args}</pre>
      </details>
      <div className="pending-actions">
        <button className="btn primary" onClick={() => onRespond(req.id, 'once')} data-testid="approve-once">Allow once</button>
        <button className="btn" onClick={() => onRespond(req.id, 'always')} data-testid="approve-always">Always in this thread</button>
        <button className="btn danger" onClick={() => onRespond(req.id, 'deny')} data-testid="approve-deny">Deny</button>
      </div>
    </div>
  )
}
