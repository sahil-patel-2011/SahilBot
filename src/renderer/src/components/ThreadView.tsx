import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { HeavyBoard, Message, PendingRequest, TeamMember } from '@shared/types'
import { api } from '../api'
import { toast } from '../lib/toast'
import { legibleOn } from '../brand'
import * as I from '../icons'
import { describe, duration, stepStatus, summarize, type Step } from '../lib/steps'
import { Markdown } from './Markdown'
import { PendingCard } from './Agent'
import { PageCard, pagesFromSteps } from './PageCard'
import { StockCard, stocksFromSteps } from './StockCard'
import { DocCard, docsFromSteps } from './doc/DocCard'
import { HeavyCard, MemberRow, SpendCard } from './HeavyCard'
import { groupMembers, heavyOf, money, teamTotals, tokenCount, unfinished } from '../lib/swarm-view'

type Block =
  | { kind: 'user'; m: Message }
  | { kind: 'text'; m: Message }
  | { kind: 'notice'; m: Message }
  | { kind: 'compacted'; m: Message }
  | { kind: 'activity'; id: string; steps: Step[] }
  | { kind: 'qa'; id: string; question: string; answer?: string; at: number }
  | { kind: 'plan'; id: string; items: PlanItem[]; at: number }
  | { kind: 'team'; id: string; titles: string[]; final?: TeamMember[]; summary?: string; at: number }
  | { kind: 'heavy'; id: string; groupId: string; board: HeavyBoard; at: number }

type PlanItem = { text: string; status: 'pending' | 'in_progress' | 'done' }

export interface ThreadActions {
  onRetry: () => void
  onEditLast: (text: string) => void
  onRespond: (id: string, answer: string) => void | Promise<unknown>
  onReact: (messageId: string, emoji: string | null) => void
  onReply: (text: string) => void
  onOpenFile: (path: string) => void
  /** Docs: opens a live document in the Document tab. */
  onOpenDoc?: (id: string) => void
}

/** Groups consecutive tool calls into one activity block; text replies stay bubbles. */
export function blocks(messages: Message[]): Block[] {
  const results = new Map<string, Message>()
  for (const m of messages) if (m.role === 'tool' && m.toolCallId) results.set(m.toolCallId, m)
  const out: Block[] = []
  let act: Extract<Block, { kind: 'activity' }> | null = null
  // One plan card per request: it appears where the agent first wrote its plan and shows the latest version.
  let plan: Extract<Block, { kind: 'plan' }> | null = null
  for (const m of messages) {
    if (m.role === 'tool') continue
    if (m.kind === 'compacted') { out.push({ kind: 'compacted', m }); continue }
    // Heavy mode's card rides on a notice (kept out of the model's history), updated live.
    const hv = m.kind === 'notice' ? heavyOf(m) : undefined
    if (hv) { act = null; out.push({ kind: 'heavy', id: m.id, groupId: hv.id, board: hv.board, at: m.createdAt }); continue }
    if (m.kind === 'notice') { act = null; out.push({ kind: 'notice', m }); continue }
    if (m.role === 'user') {
      if (m.meta?.hidden) continue
      act = null
      // Steering mid-run continues the same request: keep its plan card.
      if (!m.meta?.steer) plan = null
      out.push({ kind: 'user', m })
      continue
    }
    // A draft the app sent back for fixing (e.g. it cited links nobody retrieved) is replaced by the next answer.
    if (m.meta?.superseded) continue
    const hasText = !!(m.content || m.status === 'error' || m.status === 'stopped' || (m.reasoning && !m.toolCalls?.length))
    if (hasText) { act = null; out.push({ kind: 'text', m }) }
    if (m.toolCalls?.length) {
      for (const call of m.toolCalls) {
        if (call.name === 'ask_user') {
          // Questions read as conversation: the bot asks, you answer.
          let q = ''
          let many: Array<{ question: string }> = []
          try { const a = JSON.parse(call.arguments); q = String(a.question ?? ''); many = a.questions ?? [] } catch { /* raw */ }
          const r = results.get(call.id)
          const raw = r?.content.match(/User answered:\s*([\s\S]*?)\n?<\/tool_output>/)?.[1]?.trim() ?? r?.content.match(/User answered: (.*)/)?.[1]
          act = null
          if (many.length) {
            // Several questions: show each with its answer, compactly.
            const answers = raw ? [...raw.matchAll(/→ (.*)/g)].map((x) => x[1].replace(/^\(no answer.*\)$/, '(your call)')) : undefined
            out.push({ kind: 'qa', id: call.id, question: many.map((x, i) => `${i + 1}. ${x.question}`).join('\n'), answer: answers ? answers.map((a, i) => `${i + 1}. ${a}`).join('\n') : undefined, at: m.createdAt })
          } else out.push({ kind: 'qa', id: call.id, question: q, answer: raw, at: m.createdAt })
          continue
        }
        if (call.name === 'propose_plan' && !/approved the plan/.test(results.get(call.id)?.content ?? '')) {
          // Waiting: the approval card shows it. Changes requested: keep a small record of the exchange.
          const r = results.get(call.id)
          if (r) {
            let goal = ''
            try { goal = String(JSON.parse(call.arguments).goal ?? '') } catch { /* raw */ }
            act = null
            out.push({ kind: 'qa', id: call.id, question: `Proposed plan: ${goal}`, answer: `Change: ${r.content.match(/changes to the plan:\n([\s\S]*?)\nRevise/)?.[1] ?? ''}`, at: m.createdAt })
          }
          continue
        }
        if (call.name === 'agents') {
          let titles: string[] = []
          try { titles = (JSON.parse(call.arguments).tasks ?? []).map((t: { title: string }) => t.title) } catch { /* partial */ }
          const r = results.get(call.id)
          act = null
          out.push({ kind: 'team', id: call.id, titles, final: r?.meta?.team as TeamMember[] | undefined, summary: r?.meta?.display as string | undefined, at: m.createdAt })
          continue
        }
        // An approved plan becomes the checklist (later todo updates tick it off).
        const approved = call.name === 'propose_plan' && /approved the plan/.test(results.get(call.id)?.content ?? '')
        if (call.name === 'todo' || approved) {
          let items: PlanItem[] = []
          try {
            const a = JSON.parse(call.arguments)
            items = approved ? (a.steps ?? []).map((t: string, i: number) => ({ text: t, status: i === 0 ? 'in_progress' : 'pending' }))
              : (a.items ?? []).filter((x: PlanItem) => x && typeof x.text === 'string')
          } catch { /* partial */ }
          if (!items.length) continue
          if (plan) plan.items = items
          else {
            plan = { kind: 'plan', id: `${m.id}-${call.id}`, items, at: m.createdAt }
            out.push(plan)
            act = null
          }
          continue
        }
        if (!act) {
          act = { kind: 'activity', id: `${m.id}-${call.id}`, steps: [] }
          out.push(act)
        }
        act.steps.push({ call, result: results.get(call.id), at: m.createdAt })
      }
    }
  }
  return out
}

/**
 * Team of Experts: every helper agent, grouped by status (busiest first) in compact rows with live tokens
 * and cost. While it runs: cancel one helper, or stop the ones that haven't finished. Big swarms fold
 * the finished helpers away.
 */
function TeamCard({ id, titles, members, summary, live }: { id: string; titles: string[]; members?: TeamMember[]; summary?: string; live: boolean }) {
  const [open, setOpen] = useState(true)
  const [showDone, setShowDone] = useState(false)
  const list: TeamMember[] = members?.length ? members : titles.map((t, i) => ({ id: String(i), title: t, status: 'queued', depth: 1 }))
  const done = list.filter((m) => m.status === 'done').length
  const working = list.filter((m) => m.status === 'working').length
  const left = unfinished(list)
  const totals = teamTotals(list)
  const big = list.length > 12
  const cost = [money(totals.usd), tokenCount(totals.tokens)].filter(Boolean).join(' · ')
  return (
    <div className={`team-card${big ? ' big' : ''}`} data-testid="team-card">
      <button className="plan-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <I.Users size={15} />
        <span className="plan-title">Team of Experts</span>
        <span className="plan-count">{live || working ? `${working} working · ${done} of ${list.length} done` : summary ?? `${done} of ${list.length} done`}{cost ? ` · ${cost}` : ''}</span>
        <span className="plan-bar"><i style={{ width: `${(done / Math.max(1, list.length)) * 100}%` }} /></span>
        <I.Chevron size={13} style={{ transform: open ? 'rotate(180deg)' : undefined }} />
      </button>
      {open && (
        <div className="team-board">
          {live && left > 0 && members?.length ? (
            <div className="team-actions">
              <button className="link-btn" onClick={() => void api.swarm.stopRemaining(id)} data-testid="team-stop-remaining">Stop remaining ({left})</button>
            </div>
          ) : null}
          {groupMembers(list).map((g) => {
            const folded = big && g.status === 'done' && !showDone
            return (
              <div key={g.status} className={`team-group tg-${g.status}`} data-testid="team-group">
                <button className="team-group-head" onClick={() => g.status === 'done' && big && setShowDone((x) => !x)} disabled={!(g.status === 'done' && big)}>
                  <span>{g.label}</span><span className="tg-count">{g.members.length}</span>
                  {g.status === 'done' && big && <span className="tg-toggle">{folded ? 'Show' : 'Hide'}</span>}
                </button>
                {!folded && <div className="team-rows">{g.members.map((m) => <MemberRow key={m.id} m={m} live={live && !!members?.length} />)}</div>}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** The agent's own step list, ticked off as it works. */
function PlanCard({ items, live }: { items: PlanItem[]; live: boolean }) {
  const [open, setOpen] = useState(true)
  const done = items.filter((t) => t.status === 'done').length
  const all = done === items.length
  return (
    <div className={`plan-card${all ? ' complete' : ''}`} data-testid="plan-card">
      <button className="plan-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <I.ListIcon size={15} />
        <span className="plan-title">{all ? 'Plan complete' : 'Plan'}</span>
        <span className="plan-count">{done} of {items.length}</span>
        <span className="plan-bar"><i style={{ width: `${(done / items.length) * 100}%` }} /></span>
        <I.Chevron size={13} style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform .15s' }} />
      </button>
      {open && (
        <ol className="plan-steps">
          {items.map((t, i) => (
            <li key={i} className={`ps-${t.status}${live && t.status === 'in_progress' ? ' live' : ''}`} data-testid="plan-step">
              <span className="ps-mark">{t.status === 'done' ? <I.Check size={11} /> : null}</span>
              <span className="ps-text">{t.text}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

const PREPARING: Record<string, string> = {
  file_write: 'Preparing to write a file', create_document: 'Building a document', file_manage: 'Preparing a file change',
  web_search: 'Preparing a web search', create_page: 'Building a page', update_page: 'Updating the page', doc_create: 'Writing the document', doc_edit: 'Editing the document', doc_export: 'Exporting the document', message_bot: 'Handing off to another bot', fetch_page: 'Opening a page', browser: 'Preparing a browser step', todo: 'Planning',
  memory: 'Updating memory', verify: 'Double-checking the work', ask_user: 'Writing a question', schedule: 'Setting up a schedule', find_tools: 'Looking for tools',
  research: 'Searching trusted sources', run_command: 'Preparing a command', agents: 'Putting together a team', consult: 'Asking an expert', computer: 'Getting ready to use your Mac', cursor: 'Preparing a Cursor task', mac_apps: 'Opening a Mac app'
}

/** "Thinking… 12s" / "Preparing to write a file… 3s" while the model works. */
function StatusLine({ drafting, since, progress }: { drafting: string | null; since: number; progress?: string | null }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [])
  const secs = Math.max(0, Math.round((now - since) / 1000))
  const label = progress ? progress.replace(/\s+/g, ' ').slice(0, 120) : drafting ? (PREPARING[drafting] ?? `Preparing ${drafting.replace(/__/g, ' · ').replace(/_/g, ' ')}`) : 'Thinking'
  return (
    <div className="status-line" data-testid="status-line">
      <span className="activity-dots live"><i /><i /><i /><i /></span>
      <span className="activity-title shimmer">{label}…</span>
      {secs >= 2 && <span className="activity-meta">{secs}s</span>}
    </div>
  )
}

export function ThreadView({ messages, running, pending, actions, drafting, since, teams, progress }: {
  messages: Message[]
  /** Live Team of Experts boards by agents call id. */
  teams?: Record<string, TeamMember[]>
  running: boolean
  pending: PendingRequest[]
  actions: ThreadActions
  drafting?: string | null
  since?: number
  /** Live progress from a long-running tool (tests, builds, a Cursor agent). */
  progress?: string | null
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)

  useLayoutEffect(() => {
    const el = scroller.current
    if (el && atBottom) el.scrollTop = el.scrollHeight
  }, [messages, pending, atBottom])

  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages[0]?.threadId])

  const bs = blocks(messages)
  const lastActivity = [...bs].reverse().find((b) => b.kind === 'activity')
  const lastPlan = [...bs].reverse().find((b) => b.kind === 'plan')
  const tail = bs[bs.length - 1]
  const last = messages[messages.length - 1]
  const waiting = running && !pending.length && tail?.kind !== 'activity' && (!last || last.role !== 'assistant' || (last.status === 'streaming' && !last.content && !last.reasoning && !last.toolCalls))
  const approvalWaiting = pending.some((p) => p.kind === 'approval')
  const tailText = [...bs].reverse().find((b) => b.kind !== 'notice' && b.kind !== 'compacted')
  const lastText = tailText?.kind === 'text'
  const lastUserId = [...bs].reverse().find((b) => b.kind === 'user')?.m?.id

  return (
    <>
      <div className="thread-scroll" ref={scroller} data-testid="thread"
        onScroll={(e) => {
          const el = e.currentTarget
          setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40)
        }}>
        <div className="thread">
          {bs.map((b, i) => {
            const prev = bs[i - 1]
            const atOf = (x: Block): number => (x.kind === 'activity' ? x.steps[0].at : x.kind === 'qa' || x.kind === 'plan' || x.kind === 'team' || x.kind === 'heavy' ? x.at : x.m.createdAt)
            const at = atOf(b)
            const prevAt = prev ? atOf(prev) : undefined
            const time = stamp(at, prevAt)
            // Back-to-back replies from the same bot stack tightly, like short progress messages.
            const cont = !time && b.kind === 'text' && prev?.kind === 'text' && (b.m.meta?.botName ?? '') === (prev.m.meta?.botName ?? '')
            return (
              <div key={b.kind === 'activity' ? `a-${b.id}` : b.kind === 'qa' ? `q-${b.id}` : b.kind === 'plan' ? `p-${b.id}` : b.kind === 'team' ? `t-${b.id}` : b.kind === 'heavy' ? `h-${b.id}` : b.m.id}
                className={`block b-${b.kind}${cont ? ' cont' : ''}`}>
                {time && <div className="stamp">{time}</div>}
                {b.kind === 'qa' ? (
                  <>
                    <div className="row"><div className="bubble-wrap"><div className="bubble ai">{b.question}</div></div></div>
                    {b.answer && <div className="row me"><div className="bubble-wrap"><div className="bubble me" data-testid="answer-bubble">{b.answer}</div></div></div>}
                  </>
                ) : b.kind === 'team' ? (
                  <TeamCard id={b.id} titles={b.titles} members={teams?.[b.id] ?? b.final} summary={b.summary} live={running && !b.final} />
                ) : b.kind === 'heavy' ? (
                  <HeavyCard board={b.board} groupId={b.groupId} live={running} />
                ) : b.kind === 'plan' ? (
                  <PlanCard items={b.items} live={running && b === lastPlan} />
                ) : b.kind === 'activity' ? (
                  <>
                    <Activity steps={b.steps} live={running && b === lastActivity && tail === b} waitingApproval={approvalWaiting && b === lastActivity} onOpenFile={actions.onOpenFile} />
                    {pagesFromSteps(b.steps).map((p) => <PageCard key={p.key} path={p.path} title={p.title} at={p.at} onOpen={actions.onOpenFile} />)}
                    {stocksFromSteps(b.steps).map((s) => <StockCard key={s.key} data={s.data} />)}
                    {actions.onOpenDoc && docsFromSteps(b.steps).map((d) => <DocCard key={d.key} doc={d.doc} at={d.at} exported={d.exported} onOpen={actions.onOpenDoc!} />)}
                  </>
                ) : (
                  <Row b={b} actions={actions} editable={!running && b.kind === 'user' && b.m.id === lastUserId} cont={cont} />
                )}
              </div>
            )
          })}
          {pending.map((p) => (p.spend ? <SpendCard key={p.id} req={p} onRespond={actions.onRespond} /> : <PendingCard key={p.id} req={p} onRespond={actions.onRespond} />))}
          {running && !pending.length && (waiting || drafting || progress) && <StatusLine drafting={drafting ?? null} since={since ?? Date.now()} progress={progress} />}
          {!running && lastText && !pending.length && (
            <div className="after-actions">
              <button className="chip-btn" onClick={actions.onRetry} data-testid="retry"><I.Reply size={13} style={{ transform: 'scaleX(-1)' }} /> Retry</button>
            </div>
          )}
        </div>
      </div>
      {!atBottom && (
        <button className="jump" onClick={() => setAtBottom(true)} title="Jump to latest"><I.Down /></button>
      )}
    </>
  )
}

function stamp(at: number, prev?: number): string | null {
  if (prev && at - prev < 30 * 60_000) return null
  const d = new Date(at)
  const today = new Date().toDateString() === d.toDateString()
  return today
    ? `Today ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
    : d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// ---------------------------------------------------------------- activity

function Activity({ steps, live, waitingApproval, onOpenFile }: { steps: Step[]; live: boolean; waitingApproval: boolean; onOpenFile: (p: string) => void }) {
  // Appearance → Tool call density: "Detailed" opens step groups by default.
  const [open, setOpen] = useState(() => document.documentElement.classList.contains('detailed'))
  const [detail, setDetail] = useState<string | null>(null)
  const current = steps[steps.length - 1]
  const [, , doing] = describe(current)
  const end = steps.reduce((t, s) => Math.max(t, s.result?.createdAt ?? s.at), 0)
  const failures = steps.filter((s) => ['error', 'denied'].includes(stepStatus(s, false))).length
  const title = live ? (waitingApproval ? 'Waiting for your OK' : `${doing}…`) : summarize(steps)

  return (
    <div className={`activity${open ? ' open' : ''}`} data-testid="activity" data-live={live}>
      <button className="activity-head" onClick={() => setOpen((o) => !o)} data-testid="activity-head">
        <span className={`activity-dots${live ? ' live' : ''}`}><i /><i /><i /><i /></span>
        <span className="activity-title">{title}</span>
        {!live && failures > 0 && <span className="activity-warn">{failures} skipped or failed</span>}
        {live && steps.some((x) => x.call.name === 'browser') && (
          <span className="watch" role="button" tabIndex={0} onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('foreman:watch-browser')) }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); window.dispatchEvent(new CustomEvent('foreman:watch-browser')) } }}
            onKeyUp={(e) => { if (e.key === ' ') { e.preventDefault(); e.stopPropagation() } }}>Watch</span>
        )}
        <span className="activity-meta">{live ? `${steps.length} ${steps.length === 1 ? 'step' : 'steps'}` : duration(end - steps[0].at)}</span>
        <I.Chevron size={14} style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform .15s' }} />
      </button>
      {open && (
        <div className="steps">
          {steps.map((s) => {
            const status = stepStatus(s, live)
            const [, done, ing] = describe(s)
            const isOpen = detail === s.call.id
            return (
              <div key={s.call.id} className={`step st-${status}`} data-testid="tool-chip" data-status={status} data-tool={s.call.name}>
                <button className="step-row" onClick={() => setDetail(isOpen ? null : s.call.id)}>
                  <span className="step-icon">{status === 'running' ? <span className="spin" /> : status === 'ok' ? <I.Check size={13} /> : status === 'denied' ? '–' : '!'}</span>
                  <span className="step-text">{status === 'running' ? `${ing}…` : status === 'denied' ? `Skipped · ${done}` : status === 'error' ? `Failed · ${done}` : status === 'invalid' ? `Fixing arguments · ${done}` : done}</span>
                  <I.Chevron size={13} style={{ transform: isOpen ? 'rotate(180deg)' : 'rotate(-90deg)' }} />
                </button>
                {isOpen && <StepDetail s={s} onOpenFile={onOpenFile} />}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function StepDetail({ s, onOpenFile }: { s: Step; onOpenFile: (p: string) => void }) {
  const out = s.result?.content.replace(/^<tool_output[^>]*>\n?|\n?<\/tool_output>[\s\S]*$/g, '')
  let args: Record<string, unknown> = {}
  try {
    args = JSON.parse(s.call.arguments)
  } catch { /* shown raw */ }
  const path = (s.result?.meta?.path as string | undefined) ?? (typeof args.path === 'string' && /file_write|create_document|file_read/.test(s.call.name) ? args.path : undefined)
  return (
    <div className="step-detail">
      {s.result?.images?.map((src, i) => <img key={i} src={src} alt="" className="step-shot" />)}
      {path && s.result?.meta?.status === 'ok' && <button className="btn" onClick={() => onOpenFile(path)}><I.File size={14} /> Open {path.split('/').pop()}</button>}
      <div className="step-label">Input</div>
      <pre>{Object.keys(args).length ? JSON.stringify(args, null, 2) : s.call.arguments}</pre>
      {out !== undefined && <><div className="step-label">Output</div><pre>{out.slice(0, 8000)}</pre></>}
    </div>
  )
}

// ---------------------------------------------------------------- messages

const QUICK = ['👍', '😄', '👎', '❤️', '🤐']
const MORE = ['🔥', '🎉', '🙏', '👀', '🤔', '😂', '😮', '💯', '✅', '🚀', '😢', '👏']

function Row({ b, actions, editable, cont }: { b: Exclude<Block, { kind: 'activity' } | { kind: 'qa' } | { kind: 'plan' } | { kind: 'team' } | { kind: 'heavy' }>; actions: ThreadActions; editable?: boolean; cont?: boolean }) {
  const m = b.m
  const [editing, setEditing] = useState<string | null>(null)
  if (b.kind === 'compacted') {
    const before = m.meta?.before as number | undefined, after = m.meta?.after as number | undefined
    return (
      <details className="compacted" data-testid="compacted">
        <summary className="notice">Compacted earlier messages{before && after ? ` · ${Math.round(before / 1000)}k → ${Math.round(after / 1000)}k tokens` : ''}</summary>
        <div className="md compact-body"><Markdown text={m.content} /></div>
      </details>
    )
  }
  if (b.kind === 'notice') {
    // Work cut off by the app closing: one click picks it up where it stopped.
    if (m.meta?.interrupted && m.meta?.resumable) return (
      <div className="notice sys-line interrupted" role="status" data-testid="interrupted">
        {m.content}
        <button className="link-btn" onClick={() => void api.chat.resume(m.threadId).catch((e) => toast((e as Error).message, 'error'))} data-testid="resume-run">Continue</button>
      </div>
    )
    return <div className="notice sys-line" role="status">{m.content}</div>
  }
  const reactions = (m.meta?.reactions ?? {}) as { user?: string; bot?: string }

  if (b.kind === 'user') {
    const files = (m.meta?.files ?? []) as Array<{ name: string; path: string }>
    const folders = (m.meta?.folders ?? []) as string[]
    if (editing !== null) {
      return (
        <div className="row me">
          <div className="edit-box">
            <textarea autoFocus value={editing} onChange={(e) => setEditing(e.target.value)} data-testid="edit-input"
              onKeyDown={(e) => {
                if (e.key === 'Escape') { e.preventDefault(); setEditing(null) }
                if (e.key === 'Enter' && !e.shiftKey && editing.trim()) { e.preventDefault(); actions.onEditLast(editing.trim()); setEditing(null) }
              }} />
            <div className="pending-actions" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn primary" disabled={!editing.trim()} onClick={() => { actions.onEditLast(editing.trim()); setEditing(null) }}>Send</button>
            </div>
          </div>
        </div>
      )
    }
    return (
      <div className="row me">
        <MessageTools m={m} actions={actions} side="left" onEdit={editable ? () => setEditing(m.content) : undefined} />
        <div className="bubble-wrap">
          <div className="bubble me" data-testid="user-bubble">
            {m.images?.map((src, i) => <img key={i} className="attach" src={src} alt="" />)}
            {(files.length > 0 || folders.length > 0) && (
              <div className="bubble-files">
                {files.map((f) => <button key={f.path} className="file-pill" onClick={() => actions.onOpenFile(f.path)}><I.File size={13} />{f.name}</button>)}
                {folders.map((f) => <span key={f} className="file-pill"><I.Folder size={13} />{f.split('/').pop()}</span>)}
              </div>
            )}
            {m.content}
          </div>
          {!!m.meta?.steer && <div className="steered-tag" data-testid="steered"><I.Reply size={11} style={{ transform: 'scaleX(-1)' }} />Steered while working</div>}
          {reactions.bot && <span className="reaction left" title="SahilBot reacted" data-testid="bot-reaction">{reactions.bot}</span>}
        </div>
      </div>
    )
  }

  const streaming = m.status === 'streaming'
  const error = m.status === 'error' ? String(m.meta?.error ?? 'Something went wrong') : null
  const speaker = m.meta?.botName as string | undefined
  // The speaker's name in their colour, nudged toward the text colour until it reads (4.5:1) on the light and dark backgrounds.
  const spColor = m.meta?.botColor as string | undefined
  const spStyle = spColor ? { '--spk-l': legibleOn(spColor, '#ffffff', '#121212'), '--spk-d': legibleOn(spColor, '#161616', '#ededec') } as React.CSSProperties : undefined
  return (
    <div className="row ai">
      <div className="bubble-wrap ai-col">
        {speaker && !cont && <div className={`speaker${spStyle ? ' spk-c' : ''}`} style={spStyle}>{speaker}</div>}
        <div className={`bubble ai${error ? ' err' : ''}`} data-testid="assistant-bubble" data-status={m.status}>
          {m.reasoning && (
            <details className="reasoning" open={streaming && !m.content}>
              <summary><I.Sparkle size={14} />{streaming && !m.content ? 'Thinking…' : 'Thought process'}</summary>
              <pre>{m.reasoning.trim()}</pre>
            </details>
          )}
          {m.content && <Markdown text={m.content} streaming={streaming} />}
          {m.status === 'stopped' && <div className="hint">Stopped</div>}
          {error && <div>{error}</div>}
        </div>
        {Array.isArray(m.meta?.sources) && (m.meta!.sources as Array<{ title: string; url: string }>).length > 0 && (
          <div className="sources" data-testid="sources">
            {(m.meta!.sources as Array<{ title: string; url: string }>).filter((src, i, all) => {
              // One chip per site.
              const h = (u: string): string => { try { return new URL(u).hostname.replace(/^www\./, '') } catch { return u } }
              return all.findIndex((x) => h(x.url) === h(src.url)) === i
            }).slice(0, 6).map((src, i) => {
              let host = src.url
              try { host = new URL(src.url).hostname.replace(/^www\./, '') } catch { /* keep url */ }
              const hue = [...host].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)
              return (
                <a key={src.url} className="source-pill" href={src.url} target="_blank" rel="noreferrer" title={`${src.title}\n${src.url}`}>
                  <span className="source-ico" style={{ background: `hsl(${hue} 55% 45%)` }}>{host[0]?.toUpperCase()}</span>
                  <span className="source-host">{host}</span>
                  <span className="source-n">{i + 1}</span>
                </a>
              )
            })}
          </div>
        )}
        {reactions.user && (
          <button className="reaction" onClick={() => actions.onReact(m.id, null)} title="Remove reaction" data-testid="user-reaction">{reactions.user}</button>
        )}
      </div>
      {/* Beside the bubble (so stacked replies stay close): react, copy, read aloud, more; shown on hover. */}
      {m.content && !streaming && (
        <div className="ai-foot">
          <MessageTools m={m} actions={actions} side="right" />
          {!!m.meta?.routed && m.model && (
            <span className="routed" title={`Auto chose this model: ${(m.meta.routed as { why: string }).why}`} data-testid="routed">
              {(m.meta.routed as { label?: string }).label || m.model}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

/** Hover bar: react, reply, more (copy). Matches the bot-chat style. */
function MessageTools({ m, actions, side, onEdit }: { m: Message; actions: ThreadActions; side: 'left' | 'right'; onEdit?: () => void }) {
  const [picker, setPicker] = useState<'quick' | 'more' | null>(null)
  const [copied, setCopied] = useState(false)
  const [menu, setMenu] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!picker && !menu) return
    const close = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) { setPicker(null); setMenu(false) }
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [picker, menu])
  const canReact = m.role === 'assistant'
  return (
    <div className={`msg-actions${picker || menu ? ' pinned' : ''}`} ref={ref}>
      {canReact && <button className="icon-btn" title="React" onClick={() => setPicker(picker ? null : 'quick')} data-testid="react-btn"><I.Smile size={17} /></button>}
      {onEdit && <button className="icon-btn" title="Edit and resend" onClick={onEdit} data-testid="edit-last"><I.Edit size={16} /></button>}
      <button className="icon-btn" title="Reply" onClick={() => actions.onReply(m.content)}><I.Reply size={17} /></button>
      {canReact && m.content && <button className="icon-btn" title={copied ? 'Copied' : 'Copy'} onClick={() => { void navigator.clipboard.writeText(m.content); setCopied(true); setTimeout(() => setCopied(false), 900) }} data-testid="copy-msg">{copied ? <I.Check size={15} /> : <I.Copy size={15} />}</button>}
      {canReact && m.content && <button className="icon-btn" title="Read aloud (Esc stops)" onClick={() => void api.voice.speak(m.content)} data-testid="read-aloud"><I.Speaker size={16} /></button>}
      <button className="icon-btn" title="More" onClick={() => setMenu((x) => !x)}><span className="more">···</span></button>
      {picker && (
        <div className={`emoji-bar ${side}`}>
          {(picker === 'quick' ? QUICK : MORE).map((e) => (
            <button key={e} onClick={() => { actions.onReact(m.id, e); setPicker(null) }} data-testid="emoji">{e}</button>
          ))}
          {picker === 'quick' && <button className="emoji-more" title="More" onClick={() => setPicker('more')}><I.SmilePlus size={20} /></button>}
        </div>
      )}
      {menu && (
        <div className={`menu down ${side === 'right' ? '' : 'right'}`} style={{ minWidth: 160 }}>
          <button className="menu-item" onClick={() => {
            void navigator.clipboard.writeText(m.content)
            setCopied(true)
            setTimeout(() => { setCopied(false); setMenu(false) }, 700)
          }}>{copied ? <I.Check size={15} /> : <I.Copy size={15} />}Copy text</button>
        </div>
      )}
    </div>
  )
}
