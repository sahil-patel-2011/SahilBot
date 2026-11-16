import { useEffect, useMemo, useState } from 'react'
import type { BotAutonomySettings, NeedsYouItem, QueueQuestion, Space } from '@shared/types'
import { api } from '../api'
import { SpaceAvatar } from '../brand'
import * as I from '../icons'
import { toast } from '../lib/toast'
import { folderName, plainApproval } from '../lib/plain-approval'

// The "Needs you" inbox: every bot's pending questions and approvals in one place, with one-tap answers.
// Questions a bot posted while it kept working (main: agent/questions) and cards open in running chats
// right now. Answering resumes the bot. Assumptions a bot made at a deadline wait under "For your review".
// The same component works in SahilBot Server's web UI (window.foreman travels over its WebSocket).
// Styling reuses the Tasks board (tk-*) and Bot details (bd-*) classes.

const BOT_AUTONOMY_DEFAULTS: BotAutonomySettings = { alwaysAsk: [], deadlineHours: 4, digest: { enabled: true, time: '18:00' } }

const plain = (o: string): string => o.replace(/\s*\((recommended|default|suggested)\)\s*/gi, ' ').replace(/\s+/g, ' ').trim()
const recommended = (q: QueueQuestion): string | undefined => q.default?.trim() || q.options?.find((o) => /recommended/i.test(o)) || q.options?.[0]

function deadlineLine(x: NeedsYouItem): string {
  if (x.kind === 'approval') return 'Waits for your OK'
  if (x.expired) return 'Past its deadline · waits for you'
  if (!x.deadline) return 'Waiting for you'
  const ms = x.deadline - Date.now()
  if (ms <= 0) return 'Going ahead with the default now'
  // Whole minutes, rounded up: "3 h 60 min" never shows (it's "4 h").
  const total = Math.ceil(ms / 60_000), h = Math.floor(total / 60), m = total % 60
  return x.hardStop ? `Waits for you (${x.hardStop.replace(/^Question \d+: /, '')})` : `Goes with the default in ${h ? `${h} h` : ''}${h && m ? ' ' : ''}${m || !h ? `${m} min` : ''}`
}

/** The inbox items, live: reloads when a bot posts, answers arrive, or a chat's cards change. */
export function useNeedsYou(): { items: NeedsYouItem[] | null; reload: () => void } {
  const [items, setItems] = useState<NeedsYouItem[] | null>(null)
  const reload = (): void => { void api.needsYou.list().then(setItems).catch(() => setItems([])) }
  useEffect(() => {
    reload()
    const off = api.needsYou.onChange(reload)
    const offChat = api.chat?.onEvent?.((e) => { if (e.type === 'pending' || e.type === 'resolved' || (e.type === 'run' && e.status !== 'started')) reload() })
    return () => { off(); offChat?.() }
  }, [])
  return { items, reload }
}

export function NeedsYouInbox(p: { spaces: Space[]; onOpenChat: (threadId: string, botId: string) => void }) {
  const { items, reload } = useNeedsYou()
  const byId = useMemo(() => new Map(p.spaces.map((s) => [s.id, s])), [p.spaces])
  if (!items) return null
  const open = items.filter((x) => x.status === 'open')
  const review = items.filter((x) => x.review)
  if (!open.length && !review.length) return null
  return (
    <section className="tk-col needs ny-inbox" aria-label="Needs you" data-testid="needs-you-inbox">
      <header className="tk-col-head"><i aria-hidden="true" /><span>Needs you</span><b>{open.length}</b></header>
      {open.map((x) => <NeedsYouCard key={x.id} item={x} bot={byId.get(x.botId)} onOpen={() => p.onOpenChat(x.threadId, x.botId)} onDone={reload} />)}
      {review.length > 0 && (
        <>
          <header className="tk-col-head"><i aria-hidden="true" /><span>For your review</span><b>{review.length}</b></header>
          {review.map((x) => <ReviewCard key={x.id} item={x} bot={byId.get(x.botId)} onOpen={() => p.onOpenChat(x.threadId, x.botId)} onDone={reload} />)}
        </>
      )}
    </section>
  )
}

function Head({ item, bot, chip }: { item: NeedsYouItem; bot?: Space; chip: string }) {
  return (
    <div className="tk-card-top">
      {bot ? <SpaceAvatar color={bot.color} shape={bot.shape} size={26} /> : <span className="tk-noavatar" />}
      <span className="tk-bot">{bot?.name ?? item.botName}</span>
      <span className="tk-chip needs">{chip}</span>
    </div>
  )
}

function NeedsYouCard({ item: x, bot, onOpen, onDone }: { item: NeedsYouItem; bot?: Space; onOpen: () => void; onDone: () => void }) {
  const qs = x.questions ?? []
  // Questions already answered by a reply in the chat start filled in.
  const [answers, setAnswers] = useState<string[]>(() => qs.map((_q, i) => x.answers?.[i] ?? ''))
  const [busy, setBusy] = useState(false)
  const send = (a: string[] | 'approve' | 'always' | 'deny'): void => {
    setBusy(true)
    void api.needsYou.answer(x.id, a).then(() => { toast(a === 'deny' ? 'Declined' : a === 'always' && x.approval?.folder ? `${folderName(x.approval.folder)} is open to this bot now` : 'Sent to the bot') }).catch((e: Error) => toast(e.message)).finally(() => { setBusy(false); onDone() })
  }
  const pickOne = (i: number, v: string): void => {
    const next = answers.slice()
    next[i] = v
    setAnswers(next)
    // One question (or the last one left), one tap: answered.
    if (qs.length === 1 || next.every((a) => a.trim())) send(next)
  }
  const style = { '--bot': bot?.color ?? 'var(--accent)' } as React.CSSProperties
  if (x.kind === 'approval' || x.kind === 'other') {
    const plain = plainApproval(x.approval)
    const folder = x.approval?.folder
    return (
      <article className="tk-card ny-card" data-testid="needs-you-item" data-kind={x.kind} data-id={x.id} style={style}>
        <Head item={x} bot={bot} chip={x.kind === 'approval' ? 'Needs your OK' : 'Waiting'} />
        <p className="tk-title"><b>{plain.title}</b></p>
        {plain.where && <p className="ny-where"><I.Folder size={13} />{plain.where}</p>}
        {plain.why && <p className="tk-reason ny-why">{plain.why}</p>}
        <div className="tk-actions ny-actions">
          {x.kind === 'approval' && <button className="bd-btn primary" disabled={busy} onClick={() => send('approve')} data-testid="needs-you-approve">Allow</button>}
          {x.kind === 'approval' && folder && <button className="bd-btn" disabled={busy} onClick={() => send('always')} title={folder} data-testid="needs-you-always">Always allow in “{folderName(folder)}”</button>}
          {x.kind === 'approval' && <button className="bd-btn" disabled={busy} onClick={() => send('deny')} data-testid="needs-you-deny">Don't allow</button>}
          <button className="link-btn ny-open" onClick={onOpen}>Open chat</button>
        </div>
      </article>
    )
  }
  return (
    <article className="tk-card ny-card" data-testid="needs-you-item" data-kind="question" data-id={x.id} style={style}>
      <Head item={x} bot={bot} chip={qs.length > 1 ? `${qs.length} questions` : 'Question'} />
      {qs.map((q, i) => {
        const rec = recommended(q)
        // The recommended answer first, then the rest in the bot's order.
        const opts = (q.options ?? []).map(plain).filter((o, k, all) => all.indexOf(o) === k)
        const ordered = rec && opts.includes(plain(rec)) ? [plain(rec), ...opts.filter((o) => o !== plain(rec))] : opts
        return (
          <div className="ny-question" key={i}>
            <p className="tk-title"><b>{q.question}</b></p>
            {ordered.length > 0 && (
              <div className="ny-options" role="group" aria-label={q.question}>
                {ordered.map((o) => (
                  <button key={o} className={`ny-option${answers[i] === o ? ' on' : ''}`} disabled={busy} onClick={() => pickOne(i, o)} data-testid="needs-you-option">
                    <span>{o}</span>{rec && plain(rec) === o && <span className="ny-rec">Recommended</span>}
                  </button>
                ))}
              </div>
            )}
            <div className="ny-own">
              <input value={answers[i]} placeholder={ordered.length ? 'Or type your own answer' : 'Type your answer'} disabled={busy} onChange={(e) => { const n = answers.slice(); n[i] = e.target.value; setAnswers(n) }}
                onKeyDown={(e) => { if (e.key === 'Enter' && qs.length === 1 && answers[i].trim()) send(answers) }} aria-label={`Answer: ${q.question}`} data-testid="needs-you-input" />
              {qs.length === 1 && <button className="bd-btn primary" disabled={busy || !answers[i].trim()} onClick={() => send(answers)} data-testid="needs-you-send">Send</button>}
            </div>
          </div>
        )
      })}
      <div className="ny-foot">
        <span className="ny-deadline"><I.Clock size={12} />{x.source === 'live' ? 'The bot is waiting on this right now' : deadlineLine(x)}</span>
        {qs.length > 1 && <button className="bd-btn primary" disabled={busy || !answers.some((a) => a.trim())} onClick={() => send(answers)} data-testid="needs-you-send">Send answers</button>}
        <button className="link-btn ny-open" onClick={onOpen}>Open chat</button>
      </div>
    </article>
  )
}

function ReviewCard({ item: x, bot, onOpen, onDone }: { item: NeedsYouItem; bot?: Space; onOpen: () => void; onDone: () => void }) {
  const qs = x.questions ?? []
  const [change, setChange] = useState<string[] | null>(null)
  const ok = (): void => { void api.needsYou.reviewed(x.id).finally(onDone) }
  const send = (): void => { if (change) void api.needsYou.answer(x.id, change).then(() => toast('Sent to the bot')).finally(onDone) }
  return (
    <article className="tk-card ny-card" data-testid="needs-you-review" data-id={x.id} style={{ '--bot': bot?.color ?? 'var(--accent)' } as React.CSSProperties}>
      <Head item={x} bot={bot} chip="Assumed" />
      {qs.map((q, i) => (
        <div className="ny-question" key={i}>
          <p className="tk-title"><b>{q.question}</b></p>
          {change ? (
            <span className="tk-input"><input value={change[i] ?? ''} onChange={(e) => { const n = change.slice(); n[i] = e.target.value; setChange(n) }} list={`ny-${x.id}-${i}`} aria-label={`New answer: ${q.question}`} />
              <datalist id={`ny-${x.id}-${i}`}>{(q.options ?? []).map((o) => <option key={o} value={plain(o)} />)}</datalist></span>
          ) : <p className="tk-reason">No answer by the deadline, so it went with “{x.answers?.[i] ?? ''}”.</p>}
        </div>
      ))}
      <div className="tk-actions">
        {change ? <button className="bd-btn primary" onClick={send}>Send change</button> : <button className="bd-btn primary" onClick={ok} data-testid="needs-you-reviewed"><I.Check size={12} /> Looks good</button>}
        {!change && <button className="bd-btn" onClick={() => setChange(x.answers ?? qs.map(() => ''))}>Change</button>}
        <button className="bd-btn" onClick={onOpen}>Open chat</button>
      </div>
    </article>
  )
}

/** Bot details rows for an always-on bot: "Always ask for…" exceptions, question deadline, daily digest. */
export function AlwaysOnRows({ spaceId, part = 'all' }: { spaceId: string; part?: 'behaviour' | 'notifications' | 'all' }) {
  const [all, setAll] = useState<Record<string, Partial<BotAutonomySettings>> | null>(null)
  const [draft, setDraft] = useState('')
  useEffect(() => {
    let alive = true
    void api.settings.get().then((x) => { if (alive) setAll(x.botAutonomy ?? {}) })
    return () => { alive = false }
  }, [spaceId])
  if (!all) return null
  const mine: BotAutonomySettings = { ...BOT_AUTONOMY_DEFAULTS, ...all[spaceId], digest: { ...BOT_AUTONOMY_DEFAULTS.digest, ...all[spaceId]?.digest } }
  const save = (patch: Partial<BotAutonomySettings>): void => {
    const next = { ...all, [spaceId]: { ...mine, ...patch } }
    setAll(next)
    void api.settings.set({ botAutonomy: next }).then((s) => { setAll(s.botAutonomy ?? next); window.dispatchEvent(new Event('sahilbot:settings-changed')) })
  }
  const add = (): void => {
    const t = draft.replace(/\s+/g, ' ').trim()
    if (!t || mine.alwaysAsk.some((w) => w.toLowerCase() === t.toLowerCase())) { setDraft(''); return }
    save({ alwaysAsk: [...mine.alwaysAsk, t].slice(0, 20) })
    setDraft('')
  }
  const digest = (
    <div className="bd-row">
      <span className="bd-row-text">Daily digest<span className="bd-row-sub">A short summary in this chat on days it worked.</span></span>
      {mine.digest.enabled && <input className="bd-select bd-num" type="time" value={mine.digest.time} onChange={(e) => { if (/^\d{2}:\d{2}$/.test(e.target.value)) save({ digest: { ...mine.digest, time: e.target.value } }) }} aria-label="Digest time" data-testid="bot-digest-time" />}
      <button role="switch" aria-checked={mine.digest.enabled} aria-label="Daily digest" className={`switch${mine.digest.enabled ? ' on' : ''}`} onClick={() => save({ digest: { ...mine.digest, enabled: !mine.digest.enabled } })} data-testid="bot-digest"><i /></button>
    </div>
  )
  if (part === 'notifications') return digest
  return (
    <>
      <div className="bd-row" data-testid="bot-always-ask">
        <span className="bd-row-text">Always ask for…<span className="bd-row-sub">Even in Auto, e.g. “send email”, “calendar”.</span></span>
      </div>
      {mine.alwaysAsk.map((w) => (
        <div className="bd-row" key={w}>
          <span className="bd-row-text">{w}</span>
          <button className="bd-icon" aria-label={`Stop always asking for ${w}`} title="Remove" onClick={() => save({ alwaysAsk: mine.alwaysAsk.filter((x) => x !== w) })}><I.Trash size={13} /></button>
        </div>
      ))}
      <div className="bd-row">
        <span className="tk-input"><input value={draft} placeholder="Add an exception" maxLength={200} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add() }} aria-label="Add an always-ask exception" data-testid="bot-always-ask-input" /></span>
        <button className="bd-btn" onClick={add} disabled={!draft.trim()}>Add</button>
      </div>
      <label className="bd-row">
        <span className="bd-row-text">Question deadline<span className="bd-row-sub">Then it goes with its recommended answer, when that's safe. Money, passwords, deleting and posting always wait.</span></span>
        <select className="bd-select" value={String(mine.deadlineHours)} onChange={(e) => save({ deadlineHours: Number(e.target.value) })} data-testid="bot-question-deadline" aria-label="Question deadline">
          {[0.5, 1, 2, 4, 8, 12, 24, 48, 168].concat([0.5, 1, 2, 4, 8, 12, 24, 48, 168].includes(mine.deadlineHours) ? [] : [mine.deadlineHours]).sort((a, b) => a - b).map((h) => (
            <option key={h} value={String(h)}>{h < 1 ? `${h * 60} minutes` : h === 168 ? '1 week' : h === 1 ? '1 hour' : `${h} hours`}</option>
          ))}
        </select>
      </label>
      {part === 'all' && digest}
    </>
  )
}
