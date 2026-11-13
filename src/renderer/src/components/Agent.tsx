import { useState } from 'react'
import type { PendingRequest } from '@shared/types'
import { api } from '../api'
import * as I from '../icons'
import { toast } from '../lib/toast'
import { addRule, RULE_MAX_CHARS } from '../lib/approvalRules'
import '../styles-approvals.css'

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
            onKeyDown={(e) => { if (e.key === 'Escape') e.preventDefault(); if (e.key === 'Enter' && ready) onRespond(req.id, JSON.stringify(answers)) }} data-testid="qcard-input" />
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
          <textarea className="set-input" rows={3} autoFocus placeholder="What should change? e.g. skip step 3, use Notion instead of a PDF…" value={notes} onChange={(e) => setNotes(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setChanging(false) } }} data-testid="plan-notes" />
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
  return <ApprovalCard req={req} onRespond={onRespond} />
}

// ---------------------------------------------------------------- approvals

const words = (...xs: Array<string | undefined>): string => xs.filter(Boolean).join(' ').replace(/[_.:/-]+/g, ' ')
const SENDS = /\b(send|sends|sending|post|posts|posting|publish|share|sharing|upload|reply|replies|forward|tweet|comment|email|e-mail|message|dm|submit|invite|sms)\b/i
const SECURITY = /\b(account or security settings|security settings|account settings|change (your |the )?password|password (change|reset)|reset (your |the )?password|2fa|two[- ]factor|mfa|recovery (email|phone)|api keys?|sign[- ]in settings|login settings|permission settings)\b/i
const SECRET = /\b(fill secret|saved login|password field|vault)\b/i

/** Plain-English warnings for the risky parts of an action. */
function approvalWarnings(req: PendingRequest): string[] {
  const text = words(req.tool, req.label, req.summary, req.reason)
  const out: string[] = []
  if (req.effect === 'destructive') out.push(/\btrash\b/i.test(text) ? 'This moves it to the Trash' : "This can't be undone")
  if (req.effect === 'write_external' && SENDS.test(text) && !SECRET.test(text)) out.push('This shares your data outside this chat')
  if (SECURITY.test(text)) out.push('This changes sign-in or security settings')
  else if (SECRET.test(text)) out.push('This types one of your saved passwords')
  if (/payment|checkout|purchase|\bbuy\b|\bpay\b/i.test(req.reason ?? '')) out.push('This may spend money')
  return out
}

/** "Hard stop: payment or checkout" → "Payment or checkout". */
const reasonText = (r?: string): string => {
  const t = (r ?? '').replace(/^Hard stop:\s*/i, '').trim()
  return t ? t[0].toUpperCase() + t.slice(1) : ''
}

/** A tool call waiting for your OK: what it will do in words, what kind of action it is, and the details on demand. */
function ApprovalCard({ req, onRespond }: { req: PendingRequest; onRespond: (id: string, answer: string) => void }) {
  const hardStop = !!req.reason?.startsWith('Hard stop')
  const danger = req.effect === 'destructive' || hardStop
  const warnings = approvalWarnings(req)
  const name = req.label ?? req.tool ?? 'this action'
  const [ruleOpen, setRuleOpen] = useState(false)
  const [ruleText, setRuleText] = useState(() => (req.summary ?? name).slice(0, RULE_MAX_CHARS))
  const [ruleAction, setRuleAction] = useState<'allow' | 'ask'>('allow')
  const [saving, setSaving] = useState(false)
  const reason = reasonText(req.reason)
  const meta = [name, EFFECT_TEXT[req.effect ?? 'read'], reason && !warnings.some((w) => w.toLowerCase().includes(reason.toLowerCase())) ? reason : ''].filter(Boolean)

  const saveRule = async (): Promise<void> => {
    setSaving(true)
    try {
      const r = await addRule(ruleText, ruleAction)
      if ('error' in r) { toast(r.error, 'error'); return }
      toast('Saved to your approval rules', 'ok')
      setRuleOpen(false)
      // An Allow rule also lets this one through, once: the rule (not the whole tool) covers the rest.
      if (ruleAction === 'allow') onRespond(req.id, 'once')
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={`pending ap-card${danger ? ' danger' : ''}`} data-testid="approval-card" data-id={req.id}>
      <div className="ap-head">
        <span className={`ap-icon${danger ? ' danger' : ''}`}><I.Shield size={15} /></span>
        <div className="ap-head-text">
          {req.summary
            ? <div className="ap-summary" data-testid="approval-summary">{req.summary}</div>
            : <div className="ap-summary">Allow {name}?</div>}
          <div className="ap-meta" data-testid="approval-meta">{meta.join(' · ')}</div>
        </div>
      </div>
      {warnings.length > 0 && (
        <ul className="ap-warnings" data-testid="approval-warnings">
          {warnings.map((w) => <li key={w} className={danger ? 'danger' : undefined}>{w}</li>)}
        </ul>
      )}
      {!!req.args && (
        <details className="pending-details ap-details" open={!req.summary}>
          <summary className="hint">{req.summary ? 'Show details' : 'Details'}</summary>
          <pre className="pending-args">{req.args}</pre>
        </details>
      )}
      <div className="pending-actions">
        <button className="btn primary" onClick={() => onRespond(req.id, 'once')} data-testid="approve-once">Allow once</button>
        <button className="btn" title={`Don't ask again for ${name} in this chat`}
          onClick={() => { onRespond(req.id, 'always'); toast(`${name} is allowed for the rest of this chat`, 'ok') }} data-testid="approve-always">Always allow</button>
        <button className="btn danger" onClick={() => onRespond(req.id, 'deny')} data-testid="approve-deny">Deny</button>
        {!danger && !ruleOpen && <button className="link-btn ap-rule-link" onClick={() => setRuleOpen(true)} data-testid="approve-make-rule">Make it a rule…</button>}
      </div>
      {ruleOpen && (
        <div className="ap-rule" data-testid="approval-rule">
          <label className="ap-rule-label">When SahilBot wants to</label>
          <input className="set-input ap-rule-input" autoFocus maxLength={RULE_MAX_CHARS} value={ruleText} onChange={(e) => setRuleText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setRuleOpen(false) } if (e.key === 'Enter' && ruleText.trim()) void saveRule() }} data-testid="approval-rule-text" />
          <div className="ap-rule-row">
            <span className="ap-rule-label">it should</span>
            <select className="set-select" value={ruleAction} onChange={(e) => setRuleAction(e.target.value as 'allow' | 'ask')} data-testid="approval-rule-action">
              <option value="allow">Allow automatically</option>
              <option value="ask">Ask first</option>
            </select>
            <button className="btn primary" disabled={saving || !ruleText.trim()} onClick={() => void saveRule()} data-testid="approval-rule-save">{saving ? 'Saving…' : 'Save rule'}</button>
            <button className="btn" onClick={() => setRuleOpen(false)}>Cancel</button>
          </div>
          <div className="hint">Matches any action that mentions every word above. Shorten it to cover more, e.g. “npm install”. Manage rules in Settings → Approval rules.</div>
        </div>
      )}
    </div>
  )
}
