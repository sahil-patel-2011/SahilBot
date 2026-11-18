import { Fragment, useEffect, useId, useRef, useState } from 'react'
import type { PendingRequest } from '@shared/types'
import { api } from '../api'
import * as I from '../icons'
import { toast } from '../lib/toast'
import { addRule, RULE_MAX_CHARS } from '../lib/approvalRules'
import { approvalView, type ApprovalPreview } from '../lib/approval-view'
import { Markdown } from './Markdown'
import '../styles-approvals.css'
import '../styles-purchase.css'
// Lazy: Connect Apps is its own chunk; only a card for an app that still needs its setup (or a key) uses it.
import { ApiKeyPanel, AppSetup, GoogleSetup, Lazy } from '../lazy'
import { folderName } from '../lib/plain-approval'

const EFFECT_TEXT: Record<string, string> = {
  read: 'Reads only',
  write_local: 'Changes files on this Mac',
  write_external: 'Acts outside this Mac',
  destructive: 'Can delete or overwrite'
}

/**
 * One click: sign in (the app's own page opens in the user's default browser), and the agent continues
 * with the new tools. An app that isn't one click yet (no built-in client and none of the user's own,
 * or an API key) never gets the one-click button: the card shows its one-time setup instead.
 */
function ConnectCard({ req, onRespond }: { req: PendingRequest; onRespond: (id: string, answer: string) => void | Promise<unknown> }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const p = req.preset!
  // Answered once: a connect from here, from Connect apps or from another chat all end the card.
  const answered = useRef(false)
  const respond = (answer: string): void => { if (answered.current) return; answered.current = true; void onRespond(req.id, answer) }
  // Google apps without SahilBot's built-in Google app need "Set up Google once" first: right here in the card.
  const [googleSetup, setGoogleSetup] = useState(false)
  useEffect(() => { if (p.auth === 'google' && !p.builtinClient) void api.connectors.googleClient().then((c) => setGoogleSetup(!c)).catch(() => undefined) }, [p.auth, p.builtinClient])
  // Apps without self-registration and no built-in client: their one-time setup, unless the user did it already.
  const [ownApp, setOwnApp] = useState<boolean | null>(p.auth === 'oauth-static' && !p.builtinClient ? null : false)
  useEffect(() => {
    if (p.auth !== 'oauth-static' || p.builtinClient) return
    void api.connectors.list().then((r) => setOwnApp(!r.configs.some((c) => c.preset === p.id && !!c.clientId))).catch(() => setOwnApp(true))
  }, [p.id, p.auth, p.builtinClient])
  // Connected somewhere else meanwhile (Connect apps, another chat's card): the chat goes on with it.
  useEffect(() => api.connectors.onChange(() => {
    void api.connectors.list().then((r) => {
      const ids = new Set(r.configs.filter((c) => c.preset === p.id).map((c) => c.id))
      if (r.statuses.some((st) => ids.has(st.id) && st.state === 'connected')) respond('connected')
    }).catch(() => undefined)
  }), [p.id])
  const go = async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    try {
      const st = await api.connectors.connectPreset(p.id)
      if (st.state === 'connected') respond('connected')
      else setErr(st.error ?? 'Sign-in did not finish. Press Connect to try again.')
    } catch (e) {
      const m = (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
      if (p.auth === 'google' && /one-time setup/i.test(m)) setGoogleSetup(true)
      else if (p.auth === 'oauth-static' && /one-time setup/i.test(m)) setOwnApp(true)
      else setErr(m)
    } finally {
      setBusy(false)
    }
  }
  // API-key apps (Render, PagerDuty…): the key box right in the card; the key goes straight to main.
  if (p.auth === 'apikey') {
    return (
      <div className="pending connect-card" data-testid="connect-card">
        <div className="pending-title">
          <span className="conn-logo" style={{ background: p.color }}>{p.name[0]}</span>
          Connect {p.name} with your API key to continue?
        </div>
        <div className="hint">{p.description} The key is kept in your Mac's Keychain and only sent to {p.name}.</div>
        <Lazy fallback="inline"><ApiKeyPanel compact preset={p} onCancel={() => respond('skip')} onDone={(st) => { if (st.state === 'connected') respond('connected') }} /></Lazy>
      </div>
    )
  }
  if (ownApp === null) return <div className="pending connect-card" data-testid="connect-card"><div className="hint">Checking {p.name}…</div></div>
  if (ownApp) {
    return (
      <div className="pending connect-card" data-testid="connect-card" data-needs-setup="1">
        <div className="pending-title">
          <span className="conn-logo" style={{ background: p.color }}>{p.name[0]}</span>
          {p.name} needs a one-time setup first
        </div>
        <div className="hint" data-testid="connect-card-setup-note">{p.name} doesn't let apps register themselves, and SahilBot doesn't ship its own {p.name} app yet. Create one in about {p.setup?.minutes ?? 5} minutes; after that it's one click.</div>
        <Lazy fallback="inline"><AppSetup preset={p} onCancel={() => respond('skip')} onDone={async (clientId, clientSecret) => {
          const cfg = (await api.connectors.list()).configs.find((c) => c.preset === p.id)
          await api.connectors.save({ ...(cfg ?? { name: p.name, kind: 'remote', url: p.url, preset: p.id, enabled: true }), clientId, ...(clientSecret ? { clientSecret } : {}) })
          setOwnApp(false)
          await go()
        }} /></Lazy>
      </div>
    )
  }
  if (googleSetup) {
    return (
      <div className="pending connect-card" data-testid="connect-card">
        <div className="pending-title">
          <span className="conn-logo" style={{ background: p.color }}>{p.name[0]}</span>
          Set up Google once to connect {p.name}
        </div>
        <Lazy fallback="inline"><GoogleSetup compact forApp={p.name} onCancel={() => respond('skip')} onDone={() => { setGoogleSetup(false); void go() }} /></Lazy>
      </div>
    )
  }
  return (
    <div className="pending connect-card" data-testid="connect-card">
      <div className="pending-title">
        <span className="conn-logo" style={{ background: p.color }}>{p.name[0]}</span>
        Connect {p.name} to continue?
      </div>
      {req.question && <p className="connect-reason">{req.question}</p>}
      <div className="hint">{p.description} {p.auth === 'none' ? 'No sign-in needed.' : `Sign in or create an account on ${p.name}'s page. Your password stays with ${p.name}.`}</div>
      {busy && p.auth !== 'none' && <div className="hint" data-testid="connect-card-waiting">Finish signing in to {p.name} in your browser; this chat goes on by itself once you're back.</div>}
      {err && <div className="hint error" data-testid="connect-card-error">{err}</div>}
      <div className="pending-actions">
        <button className="btn primary" disabled={busy} onClick={() => void go()} data-testid="connect-card-go">{busy ? (p.auth === 'none' ? 'Connecting…' : 'Waiting for sign-in…') : err ? 'Try again' : p.auth === 'none' ? `Connect ${p.name}` : 'Connect / Sign in'}</button>
        <button className="btn" onClick={() => respond('skip')} data-testid="connect-card-skip">Not now</button>
      </div>
    </div>
  )
}

/** Several clarifying questions in one card: pick an option or type your own, then send them all. */
function QuestionsCard({ req, onRespond }: { req: PendingRequest; onRespond: (id: string, answer: string) => void | Promise<unknown> }) {
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

/** One question: up to three choices (A–C), and always a last row to type your own answer. */
function QuestionCard({ req, onRespond }: { req: PendingRequest; onRespond: (id: string, answer: string) => void | Promise<unknown> }) {
  const options = (req.options ?? []).filter((o) => !/^(other|something else|none of these)\b/i.test(o.trim()))
  const [own, setOwn] = useState('')
  const [sending, setSending] = useState(false)
  const send = (answer: string): void => {
    if (!answer.trim() || sending) return
    setSending(true)
    void Promise.resolve(onRespond(req.id, answer.trim())).finally(() => setSending(false))
  }
  const ownLetter = String.fromCharCode(65 + options.length)
  return (
    <div className="question" data-testid="question-card">
      <div className="question-title">{req.question}</div>
      <div className="question-options">
        {options.map((o, i) => (
          <button key={o} className="question-option" disabled={sending} onClick={() => send(o)}>
            <span className="letter">{String.fromCharCode(65 + i)}</span>{o}
          </button>
        ))}
        <label className="question-option own" data-testid="question-own">
          <span className="letter">{ownLetter}</span>
          <input value={own} onChange={(e) => setOwn(e.target.value)} placeholder={options.length ? 'Type your own answer' : 'Type your answer'} aria-label="Type your own answer"
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); (e.target as HTMLInputElement).blur() } if (e.key === 'Enter') { e.preventDefault(); send(own) } }} data-testid="question-own-input" />
          {own.trim() && <button className="btn primary small" disabled={sending} onClick={() => send(own)} data-testid="question-own-send">Send</button>}
        </label>
      </div>
    </div>
  )
}

/** The agent's plan, waiting for your OK: approve to start, or say what to change. */
function PlanApprovalCard({ req, onRespond }: { req: PendingRequest; onRespond: (id: string, answer: string) => void | Promise<unknown> }) {
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

/** Counts down to `at` (ms since epoch); true once it's reached. */
function useReady(at: number): boolean {
  const [ready, setReady] = useState(() => Date.now() >= at)
  useEffect(() => {
    if (ready) return
    const t = setTimeout(() => setReady(true), Math.max(0, at - Date.now()) + 20)
    return () => clearTimeout(t)
  }, [at, ready])
  return ready
}

/**
 * A purchase waiting for your click. Everything on it comes from main: the store is the page's own
 * address, the total and items were read from the page, the card and address are your saved nicknames.
 * Nothing the assistant writes appears here. It approves exactly this one step, once.
 */
function PurchaseCard({ req }: { req: PendingRequest }) {
  const p = req.purchase!
  const ready = useReady(p.readyAt)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const answer = async (a: 'approve' | 'deny'): Promise<void> => {
    setBusy(true)
    setErr(null)
    try {
      const r = await api.purchase.respond(req.threadId, req.id, p.nonce, a)
      if (!r.ok) setErr(r.error ?? 'Not accepted.')
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const fill = p.step === 'fill'
  return (
    <div className="pending purchase-card" data-testid="purchase-card" data-id={req.id} data-step={p.step} role="group" aria-label="Purchase approval">
      <div className="pc-head">
        <span className="pc-icon" aria-hidden="true"><I.Shield size={15} /></span>
        <div className="pc-head-text">
          <div className="pc-kicker">{fill ? 'Use a saved card?' : 'Approve this purchase?'}</div>
          <div className="pc-merchant" data-testid="purchase-merchant">
            {p.merchant}
            <span className={`pc-secure${p.secure ? '' : ' warn'}`}>{p.secure ? 'secure connection' : 'not secure (http)'}</span>
          </div>
        </div>
      </div>
      {p.changed && <div className="pc-changed" data-testid="purchase-changed">The page changed after you approved. Check the details again.</div>}
      <div className="pc-total" data-testid="purchase-total">
        {p.total
          ? <><span className="pc-total-label">Total</span><span className="pc-total-amount">{p.total.display}</span><span className="pc-total-cur">{p.total.currency}</span></>
          : <span className="pc-total-missing">Total not found — check the page (the browser panel is open)</span>}
      </div>
      {p.items.length > 0 && (
        <ul className="pc-items" data-testid="purchase-items" aria-label="Items (from the page)">
          {p.items.map((it, i) => <li key={i}><span>{it.name}</span>{it.price && <span className="pc-price">{it.price}</span>}</li>)}
        </ul>
      )}
      <dl className="pc-facts">
        <dt>Pay with</dt><dd data-testid="purchase-payment">{p.payment}</dd>
        <dt>Ship to</dt><dd data-testid="purchase-shipping">{p.shipping}</dd>
        <dt>Action</dt><dd data-testid="purchase-action">{p.action}</dd>
      </dl>
      {!!p.typed?.length && (
        <dl className="pc-facts pc-typed" data-testid="purchase-typed" aria-label="Already typed into the form">
          {p.typed.map((t, i) => <Fragment key={i}><dt>{t.field}</dt><dd>{t.value}</dd></Fragment>)}
        </dl>
      )}
      <div className="hint pc-note">{ON_PHONE ? ON_MAC_NOTE : 'Approves this one step only. Assistants and web pages can\'t approve purchases; only this button can.'}</div>
      {err && <div className="hint error">{err}</div>}
      <div className="pending-actions">
        <button className="btn primary" disabled={!ready || busy || ON_PHONE} onClick={() => void answer('approve')} data-testid="purchase-approve">{ON_PHONE ? 'Approve on your Mac' : fill ? 'Use this card' : p.total ? `Buy for ${p.total.display}` : 'Approve purchase'}</button>
        <button className="btn danger" disabled={busy} onClick={() => void answer('deny')} data-testid="purchase-deny">{fill ? "Don't use it" : "Don't buy"}</button>
      </div>
    </div>
  )
}

/** A phone using the Mac (Phone access): purchases and one-time codes are approved on the Mac; the phone can still say no. */
const ON_PHONE = api?.serverHost === 'mac'
const ON_MAC_NOTE = 'Approve this on your Mac: SahilBot asks there too. You can still say no from here.'

const OTP_SOURCE: Record<string, string> = { authenticator: 'your saved authenticator key', email: 'your email', sms: 'your text messages' }

/** Using a one-time sign-in code on a site: once for this chat, or always for this site. */
function OtpCard({ req }: { req: PendingRequest }) {
  const o = req.otp!
  const ready = useReady(o.readyAt)
  const [err, setErr] = useState<string | null>(null)
  const answer = (a: 'approve' | 'always' | 'deny'): void => {
    void api.purchase.respond(req.threadId, req.id, o.nonce, a).then((r) => { if (!r.ok) setErr(r.error ?? 'Not accepted.') }, (e: Error) => setErr(e.message))
  }
  return (
    <div className="pending otp-card" data-testid="otp-card" data-id={req.id}>
      <div className="pc-head">
        <span className="pc-icon otp" aria-hidden="true"><I.Key size={15} /></span>
        <div className="pc-head-text">
          <div className="pc-kicker">One-time sign-in code</div>
          <div className="pc-merchant">Use a code from {OTP_SOURCE[o.source] ?? o.source} to sign in to {o.site}?</div>
        </div>
      </div>
      {o.sender && (
        <dl className="pc-facts" data-testid="otp-sender">
          <dt>From</dt><dd>{o.sender}</dd>
          {o.snippet && <><dt>Message</dt><dd>{o.snippet}</dd></>}
        </dl>
      )}
      {o.unverifiedSender && <div className="pc-changed" data-testid="otp-unverified">This message isn't from {o.site}'s own domain. Only allow it if you know this sender is {o.site}.</div>}
      <div className="hint">{ON_PHONE ? ON_MAC_NOTE : <>SahilBot types the code straight into the page; the assistant never sees it.{o.source === 'sms' ? ' Reads only messages from the last 10 minutes.' : ''}</>}</div>
      {err && <div className="hint error">{err}</div>}
      <div className="pending-actions">
        <button className="btn primary" disabled={!ready || ON_PHONE} onClick={() => answer('approve')} data-testid="otp-approve">{ON_PHONE ? 'Approve on your Mac' : 'Allow in this chat'}</button>
        {!ON_PHONE && <button className="btn" disabled={!ready} onClick={() => answer('always')} data-testid="otp-always">Always for {o.site}</button>}
        <button className="btn danger" onClick={() => answer('deny')} data-testid="otp-deny">Deny</button>
      </div>
    </div>
  )
}

export function PendingCard({ req, onRespond, thumb }: { req: PendingRequest; onRespond: (id: string, answer: string) => void | Promise<unknown>; thumb?: string }) {
  if (req.kind === 'purchase' && req.purchase) return <PurchaseCard req={req} />
  if (req.kind === 'otp' && req.otp) return <OtpCard req={req} />
  if (req.kind === 'connect' && req.preset) return <ConnectCard req={req} onRespond={onRespond} />
  if (req.kind === 'questions' && req.questions) return <QuestionsCard req={req} onRespond={onRespond} />
  if (req.kind === 'plan' && req.plan) return <PlanApprovalCard req={req} onRespond={onRespond} />
  if (req.kind === 'question') return <QuestionCard req={req} onRespond={onRespond} />
  return <ApprovalCard req={req} onRespond={onRespond} thumb={thumb} />
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
function ApprovalCard({ req, onRespond, thumb }: { req: PendingRequest; onRespond: (id: string, answer: string) => void | Promise<unknown>; thumb?: string }) {
  const hardStop = !!req.reason?.startsWith('Hard stop')
  const danger = req.effect === 'destructive' || hardStop
  const warnings = approvalWarnings(req)
  const name = req.label ?? req.tool ?? 'this action'
  const [ruleOpen, setRuleOpen] = useState(false)
  const [ruleText, setRuleText] = useState(() => (req.summary ?? name).slice(0, RULE_MAX_CHARS))
  const [ruleAction, setRuleAction] = useState<'allow' | 'ask'>('allow')
  const [saving, setSaving] = useState(false)
  // A second Enter before the first save re-renders must not save the rule twice.
  const savingRef = useRef(false)
  const ruleId = useId()
  const reason = reasonText(req.reason)
  const view = approvalView(req)
  // Which app or tool, unless the headline already says it plainly (saving a file, a command, a click).
  const who = view.preview && ['file', 'command', 'click'].includes(view.preview.kind) ? '' : name
  const meta = [who, EFFECT_TEXT[req.effect ?? 'read'], reason && !warnings.some((w) => w.toLowerCase().includes(reason.toLowerCase())) ? reason : ''].filter(Boolean)

  const saveRule = async (): Promise<void> => {
    if (savingRef.current) return
    savingRef.current = true
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
      savingRef.current = false
      setSaving(false)
    }
  }

  return (
    <div className={`pending ap-card${danger ? ' danger' : ''}`} data-testid="approval-card" data-id={req.id}>
      <div className="ap-head">
        <span className={`ap-icon${danger ? ' danger' : ''}`}><I.Shield size={15} /></span>
        <div className="ap-head-text">
          <div className="ap-summary" data-testid="approval-summary">{view.title[0]}{view.title[1] && <b>{view.title[1]}</b>}{view.title[2]}</div>
          <div className="ap-meta" data-testid="approval-meta">{meta.join(' · ')}</div>
        </div>
      </div>
      {warnings.length > 0 && (
        <ul className="ap-warnings" data-testid="approval-warnings">
          {warnings.map((w) => <li key={w} className={danger ? 'danger' : undefined}>{w}</li>)}
        </ul>
      )}
      {view.preview && <ApprovalPreviewBox p={view.preview} thumb={thumb} />}
      {!!req.args && (
        <details className="pending-details ap-details" data-testid="approval-details">
          <summary className="hint">Technical details</summary>
          <pre className="pending-args">{req.args}</pre>
        </details>
      )}
      <div className="pending-actions">
        <button className="btn primary" onClick={() => onRespond(req.id, 'once')} data-testid="approve-once">Allow once</button>
        <button className="btn" title={req.folder ? `Files in ${req.folder} won't ask again in this chat` : `Don't ask again for ${name} in this chat`}
          onClick={() => {
            // Say so only once SahilBot has taken it.
            void Promise.resolve(onRespond(req.id, 'always')).then(
              () => toast(req.folder ? `${folderName(req.folder)} is open to this chat now` : `${name} is allowed for the rest of this chat`, 'ok'),
              (e: unknown) => toast((e as Error)?.message ?? String(e), 'error'))
          }} data-testid="approve-always">{req.folder ? `Always allow in “${folderName(req.folder)}”` : 'Always allow'}</button>
        <button className="btn danger" onClick={() => onRespond(req.id, 'deny')} data-testid="approve-deny">Deny</button>
        {!danger && !ruleOpen && <button className="link-btn ap-rule-link" onClick={() => setRuleOpen(true)} data-testid="approve-make-rule">Make it a rule…</button>}
      </div>
      {ruleOpen && (
        <div className="ap-rule" data-testid="approval-rule">
          <label className="ap-rule-label" htmlFor={`${ruleId}-when`}>When SahilBot wants to</label>
          <input id={`${ruleId}-when`} className="set-input ap-rule-input" autoFocus maxLength={RULE_MAX_CHARS} value={ruleText} onChange={(e) => setRuleText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setRuleOpen(false) } if (e.key === 'Enter' && ruleText.trim()) void saveRule() }} data-testid="approval-rule-text" />
          <div className="ap-rule-row">
            <label className="ap-rule-label" htmlFor={`${ruleId}-action`}>it should</label>
            <select id={`${ruleId}-action`} className="set-select" value={ruleAction} onChange={(e) => setRuleAction(e.target.value as 'allow' | 'ask')} data-testid="approval-rule-action">
              <option value="allow">Allow automatically</option>
              <option value="ask">Ask first</option>
            </select>
            <button className="btn primary" disabled={saving || !ruleText.trim()} onClick={() => void saveRule()} data-testid="approval-rule-save">{saving ? 'Saving…' : 'Save rule'}</button>
            <button className="btn" onClick={() => setRuleOpen(false)}>Cancel</button>
          </div>
          <div className="hint">Matches any action that mentions every word above. Shorten it to cover more, e.g. “npm install”. Manage rules in Settings → Permissions.</div>
        </div>
      )}
    </div>
  )
}

/** The approval's preview: the file it will save, the command it will run, the button, the message. */
function ApprovalPreviewBox({ p, thumb }: { p: ApprovalPreview; thumb?: string }) {
  if (p.kind === 'file') return (
    <div className="ap-preview ap-file" data-testid="approval-preview" data-kind="file">
      <div className="ap-file-head"><I.File size={13} /><span className="ap-file-name">{p.name}</span><span className="ap-file-meta">{p.lines} line{p.lines === 1 ? '' : 's'}{p.append ? ' · added at the end' : ''}</span></div>
      <div className={`ap-file-body${p.markdown ? ' md' : ''}`}>{p.markdown ? <Markdown text={p.text} /> : <pre>{p.text}</pre>}</div>
      {p.more > 0 && <div className="ap-file-more">+{p.more} more line{p.more === 1 ? '' : 's'}</div>}
    </div>
  )
  if (p.kind === 'command') return (
    <div className="ap-preview ap-command" data-testid="approval-preview" data-kind="command">
      <pre className="ap-cmd"><code>{p.command}</code></pre>
      {(p.why || p.cwd) && <div className="ap-cmd-why">{p.why}{p.why && p.cwd ? ' · ' : ''}{p.cwd ? `in ${p.cwd.replace(/^\/Users\/[^/]+/, '~')}` : ''}</div>}
    </div>
  )
  if (p.kind === 'click') return (
    <div className="ap-preview ap-click" data-testid="approval-preview" data-kind="click">
      {thumb && <img className="ap-thumb" src={thumb} alt={`The page on ${p.site ?? 'the site'}`} />}
      <dl className="ap-fields"><dt>{p.role ? p.role[0].toUpperCase() + p.role.slice(1) : 'Button'}</dt><dd>{p.target}</dd>{p.site && <><dt>Site</dt><dd>{p.site}</dd></>}</dl>
    </div>
  )
  if (p.kind === 'message') return (
    <div className="ap-preview ap-message" data-testid="approval-preview" data-kind="message">
      <dl className="ap-fields">
        {p.to && <><dt>To</dt><dd>{p.to}</dd></>}
        {p.channel && <><dt>Channel</dt><dd>{p.channel}</dd></>}
        {p.subject && <><dt>Subject</dt><dd>{p.subject}</dd></>}
      </dl>
      {p.body && <div className="ap-msg-body">{p.body}</div>}
    </div>
  )
  return (
    <div className="ap-preview" data-testid="approval-preview" data-kind="fields">
      <dl className="ap-fields">{p.rows.map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>)}</dl>
    </div>
  )
}
