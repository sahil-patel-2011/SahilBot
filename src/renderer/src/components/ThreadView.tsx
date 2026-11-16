import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { HeavyBoard, Message, PendingRequest, TeamMember } from '@shared/types'
import { firstUnread } from '@shared/read-state'
import { api } from '../api'
import { ChatVaultOffers } from './VaultOffer'
import { toast } from '../lib/toast'
import { legibleOn } from '../brand'
import * as I from '../icons'
import { describe, duration, stepStatus, summarize, type Step } from '../lib/steps'
import { Markdown } from './Markdown'
import { PendingCard } from './Agent'
import { PageCard, pagesFromSteps } from './PageCard'
import { MadeFiles, filesFromSteps } from './MadeFiles'
import { StockCard, stocksFromSteps } from './StockCard'
import { VideoCard, videoOf, videosFromSteps } from './VideoCard'
import { DocCard, docsFromSteps } from './doc/DocCard'
import { AskBotCard, CouncilCard, HeavyCard, MemberRow, SpendCard, SwarmCard } from './HeavyCard'
import { CuaCard, cuaOf } from './CuaCard'
import { askBotOf, councilOf, groupMembers, heavyOf, isCardNotice, maxOf, maxTeamCalls, money, swarmOf, teamTotals, tokenCount, unfinished } from '../lib/swarm-view'
import { MaxCard } from './MaxCard'
import { useDevMode } from '../lib/dev-mode'
import { elapsed, galleryFromSteps, hasQuietContent, internalNotice, quietActions, turnStart } from '../lib/quiet'

type Block =
  | { kind: 'user'; m: Message }
  | { kind: 'text'; m: Message }
  | { kind: 'notice'; m: Message }
  | { kind: 'compacted'; m: Message }
  | { kind: 'activity'; id: string; steps: Step[] }
  | { kind: 'qa'; id: string; question: string; answer?: string; at: number }
  | { kind: 'plan'; id: string; items: PlanItem[]; at: number; title?: string }
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
  // A Max run shows its team inside its one card: that team's own card is left out.
  const inMax = maxTeamCalls(messages)
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
    // A Max hybrid's phase-1 brief is shown inside the Max card (the judged answer follows it).
    if (m.meta?.maxBrief && !m.toolCalls?.length) continue
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
        if (call.name === 'agents' && !inMax.has(call.id)) {
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
        // A tool that reports its own progress (cad_design: Design brief → Concepts → Plan → Build → Verify)
        // drives the same checklist; its step still shows below as usual.
        const own = results.get(call.id)?.meta
        if (Array.isArray(own?.plan)) {
          const items = (own!.plan as PlanItem[]).filter((x) => x && typeof x.text === 'string')
          const title = typeof own!.planTitle === 'string' ? own!.planTitle : undefined
          if (items.length && plan) { plan.items = items; plan.title = title }
          else if (items.length) {
            plan = { kind: 'plan', id: `${m.id}-${call.id}`, items, at: m.createdAt, title }
            out.push(plan)
            act = null
          }
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
        <span className="plan-count">{live || working ? `${working} working · ${done} of ${list.length} done` : summary ?? `${done} of ${list.length} done`}{cost ? <span className="dev-only">{` · ${cost}`}</span> : null}</span>
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
function PlanCard({ items, live, title }: { items: PlanItem[]; live: boolean; title?: string }) {
  const [open, setOpen] = useState(true)
  const done = items.filter((t) => t.status === 'done').length
  const all = done === items.length
  return (
    <div className={`plan-card${all ? ' complete' : ''}`} data-testid="plan-card">
      <button className="plan-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <I.ListIcon size={15} />
        <span className="plan-title">{all ? `${title ?? 'Plan'} complete` : title ?? 'Plan'}</span>
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

/**
 * "Thinking… 12s" / "Checking your calendar… 1:05" while SahilBot works. The time counts from when you sent
 * the message (turnStart), so it is how long this turn has taken so far.
 */
function StatusLine({ drafting, since, progress, doing }: { drafting: string | null; since: number; progress?: string | null; doing?: string | null }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [])
  const label = progress ? progress.replace(/\s+/g, ' ').slice(0, 120) : drafting ? (PREPARING[drafting] ?? `Preparing ${drafting.replace(/__/g, ' · ').replace(/_/g, ' ')}`) : doing ?? 'Thinking'
  return (
    <div className="status-line" data-testid="status-line">
      <span className="activity-dots live"><i /><i /><i /><i /></span>
      <span className="activity-title shimmer" role="status" aria-live="polite">{label}…</span>
      <span className="activity-meta" data-testid="turn-timer" aria-live="off" title="Time since you sent your message">{elapsed(now - since)}</span>
    </div>
  )
}

/**
 * Long chats stay smooth: the thread shows its latest WINDOW blocks and pulls in earlier ones as you
 * scroll up (or press "Show earlier messages"), so opening a chat with hundreds of messages mounts a
 * bounded amount of DOM. Each block is a memoized row: while a reply streams, only the block whose
 * message changed renders again (App batches stream deltas to one update per frame).
 */
export const WINDOW = 120
/** Blocks kept above the NEW divider when the window grows to reach it, so you see what came before. */
export const DIVIDER_CONTEXT = 3

/**
 * Where the NEW divider goes: before the block of the first unread reply, moved up over the work that led to
 * it (tool steps, a plan, a question, a notice) when that is newer than your read mark too, so you catch up
 * from the start of what you missed. Never above one of your own messages. -1: no divider.
 */
export function dividerBlock(bs: Block[], first: Pick<Message, 'id' | 'createdAt'>, after: number): number {
  let i = bs.findIndex((b) => b.kind === 'text' && b.m.id === first.id)
  if (i < 0) i = bs.findIndex((b) => b.kind !== 'user' && atOf(b) >= first.createdAt)
  if (i < 0) return -1
  while (i > 0 && bs[i - 1].kind !== 'user' && bs[i - 1].kind !== 'compacted' && atOf(bs[i - 1]) > after) i--
  return i
}

/** How many blocks to mount: the usual window, grown (once) to reach the NEW divider with a little context. */
export function windowLimit(limit: number, total: number, dividerAt: number): number {
  return dividerAt < 0 ? limit : Math.max(limit, total - dividerAt + DIVIDER_CONTEXT)
}

export function ThreadView({ messages, running, pending, actions, drafting, since, teams, progress, ready = true, unreadAfter = null, onAtBottom }: {
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
  /** The chat's messages are all in (not just live events that beat the fetch): the NEW divider is placed then. */
  ready?: boolean
  /** Bots and agent chats: your read mark when you opened the chat (null: no NEW divider here). */
  unreadAfter?: number | null
  /** You're at (or near) the bottom: reported straight away, so read state never runs ahead of the scroll. */
  onAtBottom?: (atBottom: boolean) => void
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottomState] = useState(true)
  const reportBottom = useRef(onAtBottom)
  reportBottom.current = onAtBottom
  const setAtBottom = (b: boolean): void => { setAtBottomState(b); reportBottom.current?.(b) }
  const threadId = messages[0]?.threadId
  // How many blocks to show, per chat (a different chat starts again from the latest WINDOW).
  const [win, setWin] = useState<{ threadId?: string; limit: number }>({ limit: WINDOW })
  /** Distance from the bottom before earlier blocks went in, so the view doesn't jump. */
  const keepFromBottom = useRef<number | null>(null)
  // The NEW divider: worked out once, when the chat's messages are in, and kept while you stay in the chat
  // (replies that arrive while you watch go below it). App mounts one ThreadView per chat, so leaving resets it.
  const divider = useRef<{ id: string; createdAt: number; after: number } | null | undefined>(undefined)
  if (divider.current === undefined && ready) {
    const f = unreadAfter == null ? undefined : firstUnread(messages, unreadAfter)
    divider.current = f && unreadAfter != null ? { id: f.id, createdAt: f.createdAt, after: unreadAfter } : null
  }
  const dev = useDevMode()
  const hasDocs = !!actions.onOpenDoc
  const all = useMemo(() => blocks(messages), [messages])
  // The quiet chat leaves out the plan, compaction markers, notes about models, and runs that left nothing to
  // show; Developer mode shows everything.
  const bs = useMemo(() => (dev ? all : all.filter((b) => quietVisible(b, hasDocs))), [all, dev, hasDocs])
  const dividerAt = divider.current ? dividerBlock(bs, divider.current, divider.current.after) : -1
  // Long chats mount their latest WINDOW blocks; an older first unread grows the window to include it.
  const limit = windowLimit(win.threadId === threadId ? win.limit : WINDOW, bs.length, dividerAt)

  // The parent makes a new actions object every render; rows get a stable one that always calls the latest.
  const live = useRef(actions)
  live.current = actions
  const stable = useMemo<ThreadActions>(() => ({
    onRetry: () => live.current.onRetry(),
    onEditLast: (text) => live.current.onEditLast(text),
    onRespond: (id, answer) => live.current.onRespond(id, answer),
    onReact: (id, emoji) => live.current.onReact(id, emoji),
    onReply: (text) => live.current.onReply(text),
    onOpenFile: (path) => live.current.onOpenFile(path),
    onOpenDoc: (id) => live.current.onOpenDoc?.(id)
  }), [])

  useLayoutEffect(() => {
    const el = scroller.current
    if (el && atBottom) el.scrollTop = el.scrollHeight
  }, [messages, pending, atBottom])

  useEffect(() => {
    const el = scroller.current
    // Opening on the NEW divider: that effect (below) decides where the view starts.
    if (el && !divider.current) el.scrollTop = el.scrollHeight
  }, [threadId])

  // Opened with replies you haven't seen: start at the divider rather than the bottom. Runs after the
  // bottom-scroll above, in the same commit, and reports where it landed before anything marks the chat read.
  const landed = useRef(false)
  const lastTop = useRef(0)
  useLayoutEffect(() => {
    if (landed.current || !ready) return
    landed.current = true
    const el = scroller.current
    const d = el?.querySelector<HTMLElement>('[data-testid="new-divider"]')
    if (!el || !d) return
    // A little of what came before stays in view, clear of the floating header.
    const top = d.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 72
    el.scrollTo({ top: Math.max(0, top), behavior: 'instant' })
    lastTop.current = el.scrollTop
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40)
  }, [ready]) // eslint-disable-line react-hooks/exhaustive-deps

  // Earlier blocks went in above: keep what you were reading where it was.
  useLayoutEffect(() => {
    const el = scroller.current
    // Instant, not the thread's smooth scrolling: an animated jump would pass the top again and load everything.
    if (el && keepFromBottom.current !== null) el.scrollTo({ top: el.scrollHeight - keepFromBottom.current, behavior: 'instant' })
    keepFromBottom.current = null
  }, [limit])

  const first = Math.max(0, bs.length - limit)
  const showEarlier = (): void => {
    const el = scroller.current
    if (el) keepFromBottom.current = el.scrollHeight - el.scrollTop
    setWin({ threadId, limit: limit + WINDOW })
  }
  const lastOf = (kind: Block['kind']): Block | undefined => { for (let i = bs.length - 1; i >= 0; i--) if (bs[i].kind === kind) return bs[i]; return undefined }
  const lastActivity = lastOf('activity')
  const lastPlan = lastOf('plan')
  const tail = bs[bs.length - 1]
  const last = messages[messages.length - 1]
  const waiting = running && !pending.length && tail?.kind !== 'activity' && (!last || last.role !== 'assistant' || (last.status === 'streaming' && !last.content && !last.reasoning && !last.toolCalls))
  // Quiet chat: one status line the whole time SahilBot works, except while a reply is being written.
  const allTail = all[all.length - 1]
  const liveStep = running && allTail?.kind === 'activity' ? allTail.steps[allTail.steps.length - 1] : undefined
  const writing = !!last && last.role === 'assistant' && last.status === 'streaming' && !!last.content
  const showStatus = running && !pending.length && (dev ? (waiting || !!drafting || !!progress) : !writing)
  const started = turnStart(messages, since)
  const approvalWaiting = pending.some((p) => p.kind === 'approval')
  let tailText: Block | undefined
  for (let i = bs.length - 1; i >= 0; i--) if (bs[i].kind !== 'notice' && bs[i].kind !== 'compacted') { tailText = bs[i]; break }
  const lastText = tailText?.kind === 'text'
  const lastUserId = (lastOf('user') as Extract<Block, { kind: 'user' }> | undefined)?.m.id

  return (
    <>
      <div className="thread-scroll" ref={scroller} data-testid="thread"
        onScroll={(e) => {
          const el = e.currentTarget
          // At the bottom once within 40px; away from it only when the view moved up (you scrolled), so the
          // smooth scroll that follows a new reply down never counts as leaving the bottom on its way there.
          const near = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          if (near) setAtBottom(true)
          else if (el.scrollTop < lastTop.current - 1) setAtBottom(false)
          lastTop.current = el.scrollTop
          // Near the top with more above: bring in the next batch.
          if (first > 0 && el.scrollTop < 240 && keepFromBottom.current === null) showEarlier()
        }}>
        <div className="thread">
          {first > 0 && (
            <button className="show-earlier" onClick={showEarlier} data-testid="show-earlier">
              <I.Chevron size={13} style={{ transform: 'rotate(180deg)' }} />Show earlier messages
            </button>
          )}
          {bs.slice(first).map((b, j) => {
            const i = first + j
            const prev = bs[i - 1]
            const time = stamp(atOf(b), prev ? atOf(prev) : undefined)
            // Back-to-back replies from the same bot stack tightly, like short progress messages.
            // (Not across the NEW divider: the first reply you missed starts afresh.)
            const cont = !time && i !== dividerAt && b.kind === 'text' && prev?.kind === 'text' && (b.m.meta?.botName ?? '') === (prev.m.meta?.botName ?? '')
            return (
              <Fragment key={blockKey(b)}>
              {i === dividerAt && (
                <div className="new-divider" role="separator" aria-label="New messages" data-testid="new-divider">
                  <span className="nd-line" /><span className="nd-pill">New</span>
                </div>
              )}
              <BlockItem b={b} time={time} cont={cont} actions={stable} hasDocs={hasDocs}
                // Live state goes only to the blocks it concerns, so the others keep their memoized render.
                running={(b.kind === 'team' || b.kind === 'heavy' || (b.kind === 'notice' && isCardNotice(b.m))) && running}
                live={running && b === lastActivity && tail === b}
                waitingApproval={approvalWaiting && b === lastActivity}
                planLive={running && b === lastPlan}
                members={b.kind === 'team' ? teams?.[b.id] : undefined}
                editable={!running && b.kind === 'user' && b.m.id === lastUserId}
                dev={dev} retry={!running && !pending.length && b === tailText && b.kind === 'text'} />
              </Fragment>
            )
          })}
          {pending.map((p) => (p.spend ? <SpendCard key={p.id} req={p} onRespond={stable.onRespond} /> : <PendingCard key={p.id} req={p} onRespond={stable.onRespond} thumb={p.tool === 'browser' ? lastBrowserShot(messages) : undefined} />))}
          {showStatus && <StatusLine drafting={drafting ?? null} since={started} progress={progress} doing={liveStep && !dev ? describe(liveStep)[2] : null} />}
          {!running && lastText && !pending.length && (dev || (tailText?.kind === 'text' && (tailText.m.status === 'error' || tailText.m.status === 'stopped'))) && (
            <div className="after-actions">
              <button className="chip-btn" onClick={stable.onRetry} data-testid="retry"><I.Reply size={13} style={{ transform: 'scaleX(-1)' }} /> Retry</button>
            </div>
          )}
        </div>
        {/* Pinned to the bottom of the visible thread, just above the composer (whatever its height). */}
        {!atBottom && (
          <div className="jump-dock">
            {/* With a NEW divider on screen it says what it does; otherwise the round arrow. */}
            <button className={`jump${dividerAt >= 0 ? ' labeled' : ''}`} onClick={() => setAtBottom(true)} title="Jump to latest" aria-label="Jump to latest" data-testid="jump-latest">
              <I.Down />{dividerAt >= 0 && <span>Jump to latest</span>}
            </button>
          </div>
        )}
      </div>
    </>
  )
}

const atOf = (x: Block): number => (x.kind === 'activity' ? x.steps[0].at : x.kind === 'qa' || x.kind === 'plan' || x.kind === 'team' || x.kind === 'heavy' ? x.at : x.m.createdAt)
const blockKey = (b: Block): string => (b.kind === 'activity' ? `a-${b.id}` : b.kind === 'qa' ? `q-${b.id}` : b.kind === 'plan' ? `p-${b.id}` : b.kind === 'team' ? `t-${b.id}` : b.kind === 'heavy' ? `h-${b.id}` : b.m.id)

type BlockProps = {
  b: Block
  time: string | null
  cont: boolean
  actions: ThreadActions
  hasDocs: boolean
  running: boolean
  live: boolean
  waitingApproval: boolean
  planLive: boolean
  members?: TeamMember[]
  editable: boolean
  /** Developer mode: every step, thinking, the model and its cost. */
  dev: boolean
  /** The last reply, finished: Retry is in its hover tools. */
  retry: boolean
}

/** What the quiet chat shows (Developer mode shows every block). */
function quietVisible(b: Block, docs: boolean): boolean {
  switch (b.kind) {
    case 'plan': case 'compacted': return false
    case 'notice': return !internalNotice(b.m)
    case 'activity': return hasQuietContent(b.steps, docs)
    case 'text': return !!(b.m.content || b.m.status === 'error' || b.m.status === 'stopped')
    case 'user': case 'qa': case 'team': case 'heavy': return true
    default: { const never: never = b; return never }
  }
}

/** A finished run in the quiet chat: what it made and the actions that matter, never its steps. */
function QuietActivity({ steps, actions, hasDocs }: { steps: Step[]; actions: ThreadActions; hasDocs: boolean }) {
  const done = quietActions(steps)
  return (
    <>
      {done.map((a) => <div key={a.key} className={`quiet-action${a.failed ? ' failed' : ''}`} data-testid="quiet-action">{a.failed ? <span aria-hidden>!</span> : <I.Check size={12} />}{a.text}</div>)}
      <Gallery items={galleryFromSteps(steps)} onOpen={actions.onOpenFile} />
      <MadeFiles files={filesFromSteps(steps).filter((f) => !galleryFromSteps(steps).some((g) => g.path === f.path))} onOpen={actions.onOpenFile} />
      {pagesFromSteps(steps).map((p) => <PageCard key={p.key} path={p.path} title={p.title} at={p.at} onOpen={actions.onOpenFile} />)}
      {stocksFromSteps(steps).map((x) => <StockCard key={x.key} data={x.data} />)}
      {videosFromSteps(steps).map((v) => <VideoCard key={v.key} data={v.data} progress />)}
      {hasDocs && docsFromSteps(steps).map((d) => <DocCard key={d.key} doc={d.doc} at={d.at} exported={d.exported} onOpen={actions.onOpenDoc!} />)}
    </>
  )
}

/** Pictures SahilBot made, shown in the chat (click to open). */
function Gallery({ items, onOpen }: { items: Array<{ key: string; path: string }>; onOpen: (path: string) => void }) {
  const [urls, setUrls] = useState<Record<string, string>>({})
  const key = items.map((i) => i.path).join('\n')
  useEffect(() => {
    let alive = true
    for (const it of items) void api.files.preview(it.path).then((p) => { if (alive && p.url) setUrls((u) => ({ ...u, [it.path]: p.url! })) }).catch(() => undefined)
    return () => { alive = false }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!items.length) return null
  return (
    <div className="gallery" data-testid="gallery">
      {items.map((it) => (
        <button key={it.key} className="gallery-item" onClick={() => onOpen(it.path)} title={it.path.split('/').pop()}>
          {urls[it.path] ? <img src={urls[it.path]} alt={it.path.split('/').pop()} /> : <span className="gallery-wait" />}
        </button>
      ))}
    </div>
  )
}

/**
 * Same content? blocks() builds fresh objects on every update, but the messages inside them are the
 * same objects until they change, so identity of the message (or of each step's call and result) says
 * whether a row needs to render again.
 */
export function sameBlock(a: Block, b: Block): boolean {
  if (a === b) return true
  switch (a.kind) {
    case 'user': case 'text': case 'notice': case 'compacted':
      return a.kind === b.kind && a.m === (b as typeof a).m
    case 'activity': {
      if (b.kind !== 'activity' || a.id !== b.id || a.steps.length !== b.steps.length) return false
      return a.steps.every((s, i) => s.call === b.steps[i].call && s.result === b.steps[i].result && s.at === b.steps[i].at)
    }
    case 'qa':
      return b.kind === 'qa' && a.id === b.id && a.question === b.question && a.answer === b.answer && a.at === b.at
    case 'plan':
      return b.kind === 'plan' && a.id === b.id && a.items.length === b.items.length && a.items.every((t, i) => t.text === b.items[i].text && t.status === b.items[i].status)
    case 'team':
      return b.kind === 'team' && a.id === b.id && a.final === b.final && a.summary === b.summary && a.titles.join('\n') === b.titles.join('\n')
    case 'heavy':
      return b.kind === 'heavy' && a.id === b.id && a.groupId === b.groupId && a.board === b.board && a.at === b.at
  }
}

const BlockItem = memo(function BlockItem({ b, time, cont, actions, hasDocs, running, live, waitingApproval, planLive, members, editable, dev, retry }: BlockProps) {
  return (
    <div className={`block b-${b.kind}${cont ? ' cont' : ''}`}>
      {time && <div className="stamp">{time}</div>}
      {b.kind === 'qa' ? (
        <>
          <div className="row"><div className="bubble-wrap"><div className="bubble ai">{b.question}</div></div></div>
          {b.answer && <div className="row me"><div className="bubble-wrap"><div className="bubble me" data-testid="answer-bubble">{b.answer}</div></div></div>}
        </>
      ) : b.kind === 'team' ? (
        <TeamCard id={b.id} titles={b.titles} members={members ?? b.final} summary={b.summary} live={running && !b.final} />
      ) : b.kind === 'heavy' ? (
        <HeavyCard board={b.board} groupId={b.groupId} live={running} />
      ) : b.kind === 'plan' ? (
        <PlanCard items={b.items} live={planLive} title={b.title} />
      ) : b.kind === 'activity' && !dev ? (
        <QuietActivity steps={b.steps} actions={actions} hasDocs={hasDocs} />
      ) : b.kind === 'activity' ? (
        <>
          <Activity steps={b.steps} live={live} waitingApproval={waitingApproval} onOpenFile={actions.onOpenFile} />
          {!live && <MadeFiles files={filesFromSteps(b.steps)} onOpen={actions.onOpenFile} />}
          {pagesFromSteps(b.steps).map((p) => <PageCard key={p.key} path={p.path} title={p.title} at={p.at} onOpen={actions.onOpenFile} />)}
          {stocksFromSteps(b.steps).map((s) => <StockCard key={s.key} data={s.data} />)}
          {videosFromSteps(b.steps).map((v) => <VideoCard key={v.key} data={v.data} progress />)}
          {hasDocs && docsFromSteps(b.steps).map((d) => <DocCard key={d.key} doc={d.doc} at={d.at} exported={d.exported} onOpen={actions.onOpenDoc!} />)}
        </>
      ) : b.kind === 'notice' && videoOf(b.m) ? (
        <VideoCard data={videoOf(b.m)!} />
      ) : b.kind === 'notice' && maxOf(b.m) ? (
        <MaxCard board={maxOf(b.m)!} live={running} />
      ) : b.kind === 'notice' && swarmOf(b.m) ? (
        <SwarmCard board={swarmOf(b.m)!.board} live={running} />
      ) : b.kind === 'notice' && councilOf(b.m) ? (
        <CouncilCard board={councilOf(b.m)!.board} live={running} />
      ) : b.kind === 'notice' && askBotOf(b.m) ? (
        <AskBotCard v={askBotOf(b.m)!} />
      ) : (
        <Row b={b} actions={actions} editable={editable} cont={cont} dev={dev} retry={retry} />
      )}
    </div>
  )
}, (a, b) => a.time === b.time && a.cont === b.cont && a.actions === b.actions && a.hasDocs === b.hasDocs && a.running === b.running &&
  a.live === b.live && a.waitingApproval === b.waitingApproval && a.planLive === b.planLive && a.members === b.members &&
  a.editable === b.editable && a.dev === b.dev && a.retry === b.retry && sameBlock(a.b, b.b))

/**
 * The next step for an error, as a button: open the right Settings page for keys, limits and models, or
 * Connect apps for a sign-in. Retry is always under the last reply.
 */
export function errorFix(error: string): { label: string; run: () => void } | null {
  const settings = (page: string) => () => window.dispatchEvent(new CustomEvent('sahilbot:open-settings', { detail: page }))
  if (/spending|monthly (limit|cap)|budget|over the monthly/i.test(error)) return { label: 'Change the monthly limit', run: settings('#monthly-limit') }
  if (/api key|401|403|unauthori[sz]ed|rejected|out of (api )?credit|insufficient_quota|no model|model is available|not available on this account/i.test(error)) return { label: 'Open Models & Keys', run: settings('models') }
  if (/sign[- ]?in|reconnect|needs_auth|connector|connected app/i.test(error)) return { label: 'Open Connect apps', run: () => window.dispatchEvent(new Event('sahilbot:open-connect')) }
  return null
}

/** The newest screenshot the browser took in this chat (for a browser approval's thumbnail). */
function lastBrowserShot(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0 && i >= messages.length - 40; i--) {
    const m = messages[i]
    if (m.role === 'tool' && m.toolName === 'browser' && m.images?.length) return m.images[m.images.length - 1]
  }
  return undefined
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

function Row({ b, actions, editable, cont, dev, retry }: { b: Exclude<Block, { kind: 'activity' } | { kind: 'qa' } | { kind: 'plan' } | { kind: 'team' } | { kind: 'heavy' }>; actions: ThreadActions; editable?: boolean; cont?: boolean; dev?: boolean; retry?: boolean }) {
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
    // Planner ⇄ Executor computer use: its live timeline card rides on a notice (CuaCard.tsx).
    if (cuaOf(m)) return <CuaCard m={m} />
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
          {Array.isArray(m.meta?.vaultOffers) && <ChatVaultOffers m={m} />}
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
          {dev && m.reasoning && (
            <details className="reasoning" open={streaming && !m.content}>
              <summary><I.Sparkle size={14} />{streaming && !m.content ? 'Thinking…' : 'Thought process'}</summary>
              <pre>{m.reasoning.trim()}</pre>
            </details>
          )}
          {m.content && <Markdown text={m.content} streaming={streaming} />}
          {m.status === 'stopped' && <div className="hint">Stopped</div>}
          {error && <div>{error}</div>}
          {error && (() => {
            const fix = errorFix(error)
            return fix && <button className="chip-btn err-fix" onClick={fix.run} data-testid="error-fix">{fix.label}</button>
          })()}
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
          <MessageTools m={m} actions={actions} side="right" onRetry={retry && !dev ? actions.onRetry : undefined} />
          {dev && (m.meta?.verification as { status?: string } | undefined)?.status === 'verified' && <span className="result-verified" title="The recorded acceptance checks passed"><I.Check size={12} /> Checked</span>}
          {dev && (m.meta?.verification as { status?: string } | undefined)?.status === 'blocked' && <span className="result-needs-check" title="Some acceptance checks remain unresolved">Needs checking</span>}
          {dev && m.model && (
            <span className="routed" title={m.meta?.routed ? `Auto chose this model: ${(m.meta.routed as { why: string }).why}` : 'Picked in the model menu'} data-testid="routed">
              {(((m.meta?.routed as { label?: string } | undefined)?.label) || m.model).split(' · ')[0]}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

/** Hover bar: react, reply, more (copy). Matches the bot-chat style. */
function MessageTools({ m, actions, side, onEdit, onRetry }: { m: Message; actions: ThreadActions; side: 'left' | 'right'; onEdit?: () => void; onRetry?: () => void }) {
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
      {onRetry && <button className="icon-btn" title="Retry" onClick={onRetry} data-testid="retry"><I.Reply size={15} style={{ transform: 'scaleX(-1)' }} /></button>}
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
