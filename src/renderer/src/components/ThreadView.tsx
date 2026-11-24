import { createContext, Fragment, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { repliedSince } from '../lib/bot-working'
import { awaitingFinal, heldDrafts } from '../lib/held-drafts'
import { PERMISSION_BUTTON, permissionAsked } from '../lib/permission-ask'
import type { CollaborationRole, CollaborationStatus, CollaborationStep, Effort, HeavyBoard, Message, PendingRequest, TeamMember, VoiceSession } from '@shared/types'
import { filesFromMessages } from '../lib/ux'
import { firstUnread } from '@shared/read-state'
import { api } from '../api'
import { ChatVaultOffers } from './VaultOffer'
import { toast } from '../lib/toast'
import { legibleOn } from '../brand'
import * as I from '../icons'
import { describe, duration, runningStep, stepStatus, summarize, type Step } from '../lib/steps'
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
import { THINKING_LABEL } from '../lib/picker'
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
  | { kind: 'idea'; id: string; idea: string; why: string; outside: boolean; threadId: string; at: number }

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

/**
 * Voice conversations in the chat: a finished one is folded into its one-line summary (open it to read the
 * transcript); the one in progress shows only when its transcript is on. Notices (results from work the call
 * started, handoffs) always show.
 */
export function foldVoice(messages: Message[], open: Set<string>, live?: { since: number; transcript: boolean; threadId?: string } | null): Message[] {
  const sessions = messages.filter((m) => m.kind === 'notice' && m.meta?.voiceSession).map((m) => ({ id: m.id, ...(m.meta!.voiceSession as VoiceSession) }))
  const hideLive = !!live && !live.transcript && (!live.threadId || live.threadId === messages[0]?.threadId)
  if (!sessions.length && !hideLive) return messages
  // Only the voice turns fold: what you said (meta.voice) and the replies and steps that answer it, never a typed
  // message, an error or a failed step.
  let voiceTurn = false
  return messages.filter((m) => {
    if (m.role === 'user' && !m.meta?.hidden) voiceTurn = !!m.meta?.voice
    if (!voiceTurn || m.kind === 'notice' || m.kind === 'error' || m.status === 'error' || (m.role === 'tool' && m.meta?.status === 'error')) return true
    const s = sessions.find((x) => m.createdAt >= x.startedAt && m.createdAt <= x.endedAt)
    if (s) return open.has(s.id)
    return !(hideLive && m.createdAt >= live!.since)
  })
}

/** "0:51", "12:05", "1:02:09". */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`
}

const VoiceFold = createContext<{ open: Set<string>; toggle: (id: string) => void; messages: Message[] }>({ open: new Set(), toggle: () => undefined, messages: [] })

/** A finished voice conversation: its name and length (open it for the transcript), files it made, 👍 / 👎. */
function VoiceSessionLine({ m, onReact, onOpenFile }: { m: Message; onReact: ThreadActions['onReact']; onOpenFile: (path: string) => void }) {
  const fold = useContext(VoiceFold)
  const s = m.meta!.voiceSession as VoiceSession
  const open = fold.open.has(m.id)
  const files = useMemo(() => filesFromMessages(fold.messages.filter((x) => x.createdAt >= s.startedAt && x.createdAt <= s.endedAt)), [fold.messages, s.startedAt, s.endedAt])
  const mine = ((m.meta?.reactions ?? {}) as { user?: string }).user
  return (
    <div className="voice-session-wrap" data-testid="voice-session">
      <div className="voice-session">
        <button className="voice-session-open" onClick={() => fold.toggle(m.id)} aria-expanded={open} title={open ? 'Hide transcript' : 'Show transcript'} data-testid="voice-session-open">
          <I.Wave size={14} /> <span>{s.title}</span> <span aria-hidden="true">·</span> <span>{clock(s.seconds)}</span>
        </button>
        <button className={`voice-session-react${mine === '👍' ? ' on' : ''}`} onClick={() => onReact(m.id, mine === '👍' ? null : '👍')} aria-label="Good conversation" aria-pressed={mine === '👍'}>👍</button>
        <button className={`voice-session-react${mine === '👎' ? ' on' : ''}`} onClick={() => onReact(m.id, mine === '👎' ? null : '👎')} aria-label="Bad conversation" aria-pressed={mine === '👎'}>👎</button>
      </div>
      {!open && <MadeFiles files={files} onOpen={onOpenFile} />}
    </div>
  )
}

/** The result of work a voice chat started: from that bot, with the files it made. */
function VoiceResultCard({ m, onOpenFile }: { m: Message; onOpenFile: (path: string) => void }) {
  const v = m.meta!.voiceResult as { bot: string; title: string; files?: string[] }
  return (
    <div className="voice-result" data-testid="voice-result">
      <div className="voice-result-from">From {v.bot} · {v.title}</div>
      <div className="bubble ai"><Markdown text={m.content} /></div>
      <MadeFiles files={(v.files ?? []).map((path) => ({ key: path, path }))} onOpen={onOpenFile} />
    </div>
  )
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
  const { held, waiting } = heldDrafts(messages)
  for (const m of messages) {
    if (m.role === 'tool') continue
    // The checked answer is still being written: the answer being checked stays in its place until it's done.
    if (waiting.has(m.id)) continue
    if (m.kind === 'compacted') { out.push({ kind: 'compacted', m }); continue }
    // Heavy mode's card rides on a notice (kept out of the model's history), updated live.
    const hv = m.kind === 'notice' ? heavyOf(m) : undefined
    if (hv) { act = null; out.push({ kind: 'heavy', id: m.id, groupId: hv.id, board: hv.board, at: m.createdAt }); continue }
    if (m.kind === 'notice') { act = null; out.push({ kind: 'notice', m }); continue }
    if (m.role === 'user') {
      if (m.meta?.hidden) continue
      act = null
      // A routine's run starts with its instructions: a small "⏰ Routine · title" line, never your own (editable) bubble.
      if (m.meta?.scheduled) { plan = null; out.push({ kind: 'notice', m: { ...m, content: `⏰ Routine · ${m.content.split('\n')[0].replace(/^⏰\s*/, '').trim()}` } }); continue }
      // Steering mid-run continues the same request: keep its plan card.
      if (!m.meta?.steer) plan = null
      out.push({ kind: 'user', m })
      continue
    }
    // A draft the app sent back for fixing (e.g. it cited links nobody retrieved) is replaced by the next answer.
    if (m.meta?.superseded && !held.has(m.id)) continue
    // A Max hybrid's phase-1 brief is shown inside the Max card (the judged answer follows it).
    if (m.meta?.maxBrief && !m.toolCalls?.length) continue
    // A reply the app may still send back (provisional) stays out of sight until it stands: never shown, then pulled.
    const hasText = !m.meta?.provisional && !!(m.content || m.status === 'error' || m.status === 'stopped' || (m.reasoning && !m.toolCalls?.length))
    if (hasText) { act = null; out.push({ kind: 'text', m }) }
    if (m.toolCalls?.length) {
      for (const call of m.toolCalls) {
        if (call.name === 'ask_user') {
          // A question the tool refused (bad arguments) was never asked: don't show it as one (the model asks again).
          if (/^(Invalid arguments|Error)/.test(results.get(call.id)?.content.replace(/^<tool_output[^>]*>\s*/, '') ?? '')) continue
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
        // An idea the agent offers: a card with "Do it" (the result carries the cleaned-up text).
        if (call.name === 'propose_idea') {
          const r = results.get(call.id)
          const meta = r?.meta?.idea as { idea?: string; why?: string; outside?: boolean } | undefined
          if (meta?.idea) { act = null; out.push({ kind: 'idea', id: call.id, idea: meta.idea, why: meta.why ?? '', outside: meta.outside === true, threadId: m.threadId, at: m.createdAt }) }
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

const IDEA_SENT = 'sahilbot:idea-sent:'
/**
 * The agent's idea: a better way or the next step. "Do it" sends it as your message in this chat, once (it
 * remembers). When the run read outside content (a page, an email, a file) the idea may have been planted there,
 * so it only goes into the message box to read first. Not while the chat is still working or asking.
 */
function IdeaCard({ id, idea, why, outside, threadId, busy }: { id: string; idea: string; why: string; outside: boolean; threadId: string; busy?: boolean }) {
  const [sent, setSent] = useState(() => { try { return localStorage.getItem(IDEA_SENT + id) === '1' } catch { return false } })
  const [sending, setSending] = useState(false)
  const doIt = (): void => {
    setSending(true)
    window.dispatchEvent(new CustomEvent('sahilbot:send-text', { detail: { text: idea, threadId, done: (ok: boolean) => {
      setSending(false)
      if (ok) { setSent(true); try { localStorage.setItem(IDEA_SENT + id, '1') } catch { /* not remembered */ } }
    } } }))
  }
  return (
    <div className={`idea-card${outside ? ' outside' : ''}`} data-testid="idea-card">
      <div className="idea-head"><span className="idea-mark" aria-hidden>✦</span> Idea from SahilBot<span className="idea-who">not written by you</span></div>
      <div className="idea-text">{idea}</div>
      {why && <div className="idea-why">{why}</div>}
      {outside && <div className="idea-why">This task read outside content (a web page, an email or a file), so check the idea before you send it.</div>}
      <div className="idea-actions">
        {!outside && <button className="btn primary" disabled={sent || sending || busy} title={busy ? 'When this task finishes' : undefined} aria-label={busy ? 'When this task finishes' : undefined} onClick={doIt} data-testid="idea-do">{sent ? 'Sent' : sending ? 'Sending…' : 'Do it'}</button>}
        <button className={`btn${outside ? ' primary' : ''}`} disabled={sent} onClick={() => window.dispatchEvent(new CustomEvent('sahilbot:compose', { detail: idea }))} title="Put it in the message box to read or change it first" data-testid="idea-edit">{outside ? 'Put in message box' : 'Edit first'}</button>
      </div>
    </div>
  )
}

/**
 * The plan of the run that's working, pinned above the message box: where the agent is ("Step 3 of 6:
 * Check the export"), with the whole checklist a click away. The full card stays in the chat as well.
 */
function LivePlan({ items, title }: { items: PlanItem[]; title?: string }) {
  const [open, setOpen] = useState(false)
  const done = items.filter((t) => t.status === 'done').length
  const i = items.findIndex((t) => t.status === 'in_progress')
  const at = i >= 0 ? i : items.findIndex((t) => t.status !== 'done')
  const cur = items[at]
  return (
    <div className={`live-plan${open ? ' open' : ''}`} data-testid="live-plan" role="status" aria-live="polite">
      {open && (
        <ol className="plan-steps">
          {items.map((t, k) => (
            <li key={k} className={`ps-${t.status}${t.status === 'in_progress' ? ' live' : ''}`}>
              <span className="ps-mark">{t.status === 'done' ? <I.Check size={11} /> : null}</span>
              <span className="ps-text">{t.text}</span>
            </li>
          ))}
        </ol>
      )}
      <button className="live-plan-head" onClick={() => setOpen((o) => !o)} aria-expanded={open} title={open ? 'Hide the plan' : 'Show the whole plan'}>
        <span className="spin" />
        <span className="live-plan-step">{title ? `${title} · ` : ''}Step {Math.min(items.length, at + 1)} of {items.length}{cur ? `: ${cur.text}` : ''}</span>
        <span className="plan-bar"><i style={{ width: `${(done / items.length) * 100}%` }} /></span>
        <I.Chevron size={13} style={{ transform: open ? undefined : 'rotate(180deg)', transition: 'transform .15s' }} />
      </button>
    </div>
  )
}

/**
 * The sources an answer used, numbered exactly as the inline [1], [2] citations (which link to them), six at
 * a time with "+N more".
 */
function SourceChips({ sources }: { sources: Array<{ title: string; url: string }> }) {
  const [all, setAll] = useState(false)
  const list = sources.map((src, i) => ({ ...src, n: i + 1 })).filter((src, i, xs) => xs.findIndex((x) => x.url === src.url) === i)
  const shown = all ? list : list.slice(0, 6)
  return (
    <div className="sources" data-testid="sources">
      {shown.map((src) => {
        let host = src.url
        try { host = new URL(src.url).hostname.replace(/^www\./, '') } catch { /* keep url */ }
        const hue = [...host].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)
        return (
          <a key={src.url} className="source-pill" href={src.url} target="_blank" rel="noreferrer" title={`${src.title}\n${src.url}`}>
            <span className="source-ico" style={{ background: `hsl(${hue} 55% 45%)` }}>{host[0]?.toUpperCase()}</span>
            <span className="source-host">{host}</span>
            <span className="source-n">{src.n}</span>
          </a>
        )
      })}
      {list.length > 6 && <button className="source-pill source-more" onClick={() => setAll((x) => !x)}>{all ? 'Fewer' : `+${list.length - 6} more`}</button>}
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
  // The first real task ever: the work panel opens by itself once, so people learn it's there.
  useEffect(() => {
    if (!doing) return
    try { if (localStorage.getItem('sb.workShown')) return; localStorage.setItem('sb.workShown', '1') } catch { return }
    window.dispatchEvent(new CustomEvent('sahilbot:show-work'))
  }, [!!doing])
  const label = progress ? progress.replace(/\s+/g, ' ').slice(0, 120) : drafting ? (PREPARING[drafting] ?? `Preparing ${drafting.replace(/__/g, ' · ').replace(/_/g, ' ')}`) : doing ?? 'Thinking'
  return (
    <div className="status-line" data-testid="status-line">
      <span className="activity-dots live"><i /><i /><i /><i /></span>
      <span className="activity-title shimmer" role="status" aria-live="polite">{label}…</span>
      <span className="activity-meta" data-testid="turn-timer" aria-live="off" title="Time since you sent your message">{elapsed(now - since)}</span>
      {/* The plan, sources and files it's working with, one click away (it used to be an unlabeled icon). */}
      <button type="button" className="show-work" onClick={() => window.dispatchEvent(new CustomEvent('sahilbot:show-work'))} data-testid="show-work">Show work</button>
    </div>
  )
}

/**
 * Working, Grok Bot's way (every chat outside Developer mode): the bot says it's on it (its own opening line when it
 * wrote one; a plain "On it." if nothing came after a moment), then one quiet line, an icon and what it's doing
 * ("Planning the Savannah trip"). No timer and no "Thinking…".
 */
function BotWorking({ name, ack, slow, label }: { name?: string; ack: boolean; slow?: boolean; label?: string | null }) {
  // A quick answer needs no "On it.": it shows only when nothing has come after a moment.
  const [late, setLate] = useState(false)
  useEffect(() => {
    if (!ack) return
    const t = setTimeout(() => setLate(true), 1200)
    return () => clearTimeout(t)
  }, [ack])
  const who = name ?? 'SahilBot'
  const text = slow ? `${who} is still working. This is taking longer than usual; press Stop if you'd rather not wait` : label || (name ? `${name} is working` : 'Working on it')
  return (
    <>
      {ack && late && <div className="row ai bot-ack" data-testid="bot-ack"><div className="bubble-wrap ai-col"><div className="bubble ai">On it.</div></div></div>}
      <div className="status-line bot-working" data-testid="status-line">
        <span className="work-orb" aria-hidden="true" />
        <span className="activity-title" role="status" aria-live="polite" data-testid="bot-working">{text}</span>
      </div>
    </>
  )
}

/**
 * What the working line says, steadiest first: a note from the app, the step of the bot's own plan it's on ("Find
 * family hotels under $150"), then the tool step running now, then the one being prepared. Nothing: the default.
 */
export function workLabel(o: { progress?: string | null; drafting?: string | null; plan?: string | null; doing?: string | null }): string | null {
  if (o.progress && !o.progress.startsWith('Still on it:')) return o.progress.replace(/\s+/g, ' ').slice(0, 120)
  if (o.plan) return o.plan.replace(/\s+/g, ' ').slice(0, 80)
  if (o.doing) return o.doing
  if (o.drafting) return PREPARING[o.drafting] ?? null
  return null
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

export function ThreadView({ messages, running, pending, actions, drafting, since, teams, progress, ready = true, unreadAfter = null, onAtBottom, voiceLive, botName }: {
  messages: Message[]
  /**
   * A bot's chat (Grok Bot's way): only the conversation. While it works you see an "On it." from the bot and
   * "<name> is working…"; steps, plans, team boards, "Double-checking" and the timer stay out of sight.
   */
  botName?: string
  /** A voice conversation in progress (in this chat): its turns show only with its transcript on. */
  voiceLive?: { since: number; transcript: boolean; threadId?: string } | null
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
  const [openVoice, setOpenVoice] = useState<Set<string>>(new Set())
  const shown = useMemo(() => foldVoice(messages, openVoice, voiceLive), [messages, openVoice, voiceLive])
  const fold = useMemo(() => ({ open: openVoice, messages, toggle: (id: string) => setOpenVoice((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n }) }), [openVoice, messages])
  const all = useMemo(() => blocks(shown), [shown])
  // The quiet chat leaves out the plan, compaction markers, notes about models, and runs that left nothing to
  // show; Developer mode shows everything.
  // A question waiting on its card (below) shows there only: the same words don't appear twice.
  const asking = pending.some((p) => p.kind === 'question' || p.kind === 'questions')
  const quietBot = !!botName && !dev
  const bs = useMemo(() => all.filter((b) => {
    if (b.kind === 'qa' && !b.answer && asking) return false
    if (b.kind === 'notice' && internalNotice(b.m)) return dev
    // A bot's chat: the conversation only (what it did is one click away in Show work, not in the chat).
    if (quietBot && (b.kind === 'activity' || b.kind === 'plan' || b.kind === 'team' || b.kind === 'heavy' || b.kind === 'compacted')) return false
    // One answer, posted once (Grok Bot's way), in every chat: an answer the app checks before accepting it stays out
    // of sight, with the working line up, until it is final. Nothing posted is pulled back (heldDrafts).
    if (running && !dev && b.kind === 'text' && awaitingFinal(b.m)) return false
    // ...and no status notes ("The bot is continuing with…"). System lines Grok Bot shows too stay: "Paused routine ·
    // …", "Undid …", messages between bots, and cards that need you.
    if (quietBot && b.kind === 'notice' && !isCardNotice(b.m) && (typeof b.m.meta?.publicText === 'string' || Array.isArray(b.m.meta?.collaboration))) return false
    return dev || quietVisible(b, hasDocs)
  }), [all, dev, hasDocs, asking, quietBot, running])
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
  // You just sent something: the chat jumps to it, even if you had scrolled up to read.
  const lastSent = [...messages].reverse().find((m) => m.role === 'user' && !m.meta?.hidden)?.id
  const seenSent = useRef(lastSent)
  useLayoutEffect(() => {
    if (lastSent && lastSent !== seenSent.current) { seenSent.current = lastSent; setAtBottom(true); const el = scroller.current; if (el) el.scrollTop = el.scrollHeight }
  }, [lastSent])

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
  // The pinned plan is this run's: a plan from before your latest message belongs to an earlier task.
  const lastUser = (() => { for (let i = bs.length - 1; i >= 0; i--) if (bs[i].kind === 'user') return i; return -1 })()
  const runPlan = lastPlan && bs.indexOf(lastPlan) > lastUser ? lastPlan : undefined
  const tail = bs[bs.length - 1]
  const last = messages[messages.length - 1]
  const waiting = running && !pending.length && tail?.kind !== 'activity' && (!last || last.role !== 'assistant' || (last.status === 'streaming' && ((!last.content && !last.reasoning && !last.toolCalls) || !!last.meta?.provisional)))
  // Quiet chat: one status line the whole time SahilBot works, except while a reply is being written.
  const allTail = all[all.length - 1]
  // The status names the step that is running now: once it has its result, it's "Thinking" again, never a stale label.
  const liveStep = runningStep(allTail?.kind === 'activity' ? allTail.steps : undefined, running)
  // The bot's own plan step for the working line, even where the plan card itself is hidden (outside Developer mode).
  const allUser = (() => { for (let i = all.length - 1; i >= 0; i--) if (all[i].kind === 'user') return i; return -1 })()
  const livePlan = (() => { for (let i = all.length - 1; i > allUser; i--) { const b = all[i]; if (b.kind === 'plan') return b } return undefined })()
  const writing = !!last && last.role === 'assistant' && last.status === 'streaming' && !!last.content
  // The working line stays up while an answer is written out of sight (checked before it's posted, heldDrafts).
  const writingVisible = writing && !(last?.meta?.superseded || awaitingFinal(last!) || heldDrafts(messages).waiting.has(last!.id))
  const showStatus = running && !pending.length && (dev ? (waiting || !!drafting || !!progress) : !writingVisible)
  const started = turnStart(messages, since)
  const approvalWaiting = pending.some((p) => p.kind === 'approval')
  let tailText: Block | undefined
  for (let i = bs.length - 1; i >= 0; i--) if (bs[i].kind !== 'notice' && bs[i].kind !== 'compacted') { tailText = bs[i]; break }
  const lastText = tailText?.kind === 'text'
  const lastUserId = (lastOf('user') as Extract<Block, { kind: 'user' }> | undefined)?.m.id

  return (
    <VoiceFold.Provider value={fold}>
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
        <div className={`thread${quietBot ? ' quiet-bot' : ''}`}>
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
          {showStatus && (dev
            ? <StatusLine drafting={drafting ?? null} since={started} progress={progress} doing={null} />
            : <BotWorking name={botName} ack={!repliedSince(messages)} slow={!!progress?.startsWith('Still on it:')}
                label={workLabel({ progress, drafting, plan: livePlan ? (livePlan.items.find((x) => x.status === 'in_progress')?.text ?? livePlan.title ?? null) : null, doing: liveStep ? describe(liveStep)[2] : null })} />)}
          {!quietBot && running && runPlan?.kind === 'plan' && runPlan.items.some((t) => t.status !== 'done') && <LivePlan items={runPlan.items} title={runPlan.title} />}
          {!running && lastText && !pending.length && (dev || (tailText?.kind === 'text' && (tailText.m.status === 'error' || tailText.m.status === 'stopped'))) && (
            <div className="after-actions">
              <button className="chip-btn" onClick={stable.onRetry} data-testid="retry"><I.Reply size={13} style={{ transform: 'scaleX(-1)' }} /> Retry</button>
            </div>
          )}
          {/* A template bot's starter tasks, under its first message until you ask something: a tap fills the chat box. */}
          {!running && tailText?.kind === 'text' && Array.isArray(tailText.m.meta?.suggestions) && !messages.some((m) => m.role === 'user') && (
            <div className="starter-chips" data-testid="starter-tasks">
              {(tailText.m.meta.suggestions as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 6).map((q) => (
                <button key={q} className="chip-btn" onClick={() => window.dispatchEvent(new CustomEvent('sahilbot:compose', { detail: q }))} data-testid="starter-task">{q}</button>
              ))}
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
    </VoiceFold.Provider>
  )
}

const atOf = (x: Block): number => (x.kind === 'activity' ? x.steps[0].at : x.kind === 'qa' || x.kind === 'plan' || x.kind === 'team' || x.kind === 'heavy' || x.kind === 'idea' ? x.at : x.m.createdAt)
const blockKey = (b: Block): string => (b.kind === 'activity' ? `a-${b.id}` : b.kind === 'qa' ? `q-${b.id}` : b.kind === 'plan' ? `p-${b.id}` : b.kind === 'team' ? `t-${b.id}` : b.kind === 'heavy' ? `h-${b.id}` : b.kind === 'idea' ? `i-${b.id}` : b.m.id)

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
    case 'user': case 'qa': case 'team': case 'heavy': case 'idea': return true
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
    case 'idea':
      return b.kind === 'idea' && a.id === b.id && a.idea === b.idea && a.outside === b.outside
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
      ) : b.kind === 'idea' ? (
        <IdeaCard id={b.id} idea={b.idea} why={b.why} outside={b.outside} threadId={b.threadId} busy={running} />
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
      ) : b.kind === 'notice' && b.m.meta?.voiceSession ? (
        <VoiceSessionLine m={b.m} onReact={actions.onReact} onOpenFile={actions.onOpenFile} />
      ) : b.kind === 'notice' && b.m.meta?.voiceResult ? (
        <VoiceResultCard m={b.m} onOpenFile={actions.onOpenFile} />
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
  if (/api key|401|403|unauthori[sz]ed|rejected|out of (api )?credit|insufficient_quota|no model|model is available|not available on this account/i.test(error)) return { label: 'Open AI & spending', run: settings('models') }
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

function Row({ b, actions, editable, cont, dev, retry }: { b: Exclude<Block, { kind: 'activity' } | { kind: 'qa' } | { kind: 'plan' } | { kind: 'team' } | { kind: 'heavy' } | { kind: 'idea' }>; actions: ThreadActions; editable?: boolean; cont?: boolean; dev?: boolean; retry?: boolean }) {
  const m = b.m
  const [editing, setEditing] = useState<string | null>(null)
  // ↑ in an empty message box opens this editor on your last message.
  useEffect(() => {
    if (!editable) return
    const on = (): void => setEditing(m.content)
    window.addEventListener('sahilbot:edit-last', on)
    return () => window.removeEventListener('sahilbot:edit-last', on)
  }, [editable, m.content])
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
    if (Array.isArray(m.meta?.collaboration)) return <CollaborationCard steps={m.meta.collaboration as CollaborationStep[]} interrupted={m.status === 'stopped'} />
    const message = !dev && typeof m.meta?.publicText === 'string' ? m.meta.publicText : m.content
    return <div className="notice sys-line" role="status">{message}</div>
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
  const visibleError = !dev && m.model ? (m.meta?.publicError as string | undefined) ?? 'The bot could not finish this reply.' : error
  const effort = m.meta?.effort as Effort | undefined
  const speaker = m.meta?.botName as string | undefined
  // The speaker's name in their colour, nudged toward the text colour until it reads (4.5:1) on the light and dark backgrounds.
  const spColor = m.meta?.botColor as string | undefined
  const spStyle = spColor ? { '--spk-l': legibleOn(spColor, '#ffffff', '#121212'), '--spk-d': legibleOn(spColor, '#161616', '#ededec') } as React.CSSProperties : undefined
  return (
    <div className="row ai">
      <div className="bubble-wrap ai-col">
        {speaker && !cont && <div className={`speaker${spStyle ? ' spk-c' : ''}`} style={spStyle}>{speaker}</div>}
        {typeof m.meta?.replyText === 'string' && <div className="reply-to" data-testid="reply-to" title="Answers this message"><span aria-hidden>↪</span>{m.meta.replyText as string}</div>}
        <div className={`bubble ai${error ? ' err' : ''}`} data-testid="assistant-bubble" data-status={m.status}>
          {dev && m.reasoning && (
            <details className="reasoning" open={streaming && !m.content}>
              <summary><I.Sparkle size={14} />{streaming && !m.content ? 'Thinking…' : 'Thought process'}</summary>
              <pre>{m.reasoning.trim()}</pre>
            </details>
          )}
          {m.content && <Markdown text={m.content} streaming={streaming} sources={Array.isArray(m.meta?.sources) ? m.meta!.sources as Array<{ title: string; url: string }> : undefined} />}
          {m.status === 'stopped' && <div className="hint">Stopped</div>}
          {error && <div>{visibleError}</div>}
          {error && (() => {
            const fix = errorFix(error)
            return fix && <button className="chip-btn err-fix" onClick={fix.run} data-testid="error-fix">{fix.label}</button>
          })()}
        </div>
        {Array.isArray(m.meta?.sources) && (m.meta!.sources as Array<{ title: string; url: string }>).length > 0 && <SourceChips sources={m.meta!.sources as Array<{ title: string; url: string }>} />}
        {reactions.user && (
          <button className="reaction" onClick={() => actions.onReact(m.id, null)} title="Remove reaction" data-testid="user-reaction">{reactions.user}</button>
        )}
        {dev && m.model && m.content && !streaming && (
          <div className="reply-model-details" title={routedTitle(m)} data-testid="routed">
            {(((m.meta?.routed as { label?: string } | undefined)?.label) || m.model).split(' · ')[0]}
            {effort && THINKING_LABEL[effort] ? ` · ${THINKING_LABEL[effort]} thinking` : ''}
          </div>
        )}
      </div>
      {/* Beside the bubble (so stacked replies stay close): react, copy, read aloud, more; shown on hover. */}
      {m.content && !streaming && (
        <div className="ai-foot">
          <MessageTools m={m} actions={actions} side="right" onRetry={retry && !dev ? actions.onRetry : undefined} latest={!!retry} />
          {dev && (m.meta?.verification as { status?: string } | undefined)?.status === 'verified' && <span className="result-verified" title="The recorded acceptance checks passed"><I.Check size={12} /> Checked</span>}
          {dev && !!m.meta?.superseded && !!m.meta?.checking && <span className="result-checking">Double-checking…</span>}
          {(() => { const kind = m.status !== 'streaming' ? permissionAsked(m.content) : undefined; return kind ? <button type="button" className="perm-ask" onClick={() => void api.permissions.request(kind).catch(() => api.permissions.open(kind))} data-testid="perm-ask">{PERMISSION_BUTTON[kind]}</button> : null })()}
          {(m.meta?.verification as { status?: string } | undefined)?.status === 'blocked' && <span className="result-needs-check" title={dev ? ((m.meta?.verification as { issues?: string[] }).issues ?? []).join('\n') : 'SahilBot couldn\'t confirm this worked. Check the result before relying on it.'}>Needs a check</span>}
        </div>
      )}
    </div>
  )
}

const COLLABORATION_ROLE: Record<CollaborationRole, string> = { lead: 'Lead agent', planner: 'Planner', partner: 'Second perspective', reviewer: 'Reviewer', specialist: 'Specialist' }
const COLLABORATION_STATUS: Record<CollaborationStatus, string> = { queued: 'Up next', working: 'Working', done: 'Done', unavailable: 'Unavailable', stopped: 'Stopped' }

function CollaborationCard({ steps, interrupted }: { steps: CollaborationStep[]; interrupted: boolean }) {
  const show = useDevMode()
  const active = !interrupted && steps.some((s) => s.status === 'working' || s.status === 'queued')
  const finished = steps.filter((s) => s.status === 'done').length
  const outcome = active ? 'In progress' : interrupted || steps.some((s) => s.status === 'stopped') ? 'Stopped'
    : finished < steps.length ? `${finished} of ${steps.length} finished` : 'Complete'
  return (
    <details className="collaboration-card" open data-testid="collaboration-card">
      <summary className="plan-head">
        <I.Users size={16} aria-hidden />
        <span className="plan-title">Agents collaborating</span>
        <span className="plan-count" role="status">{outcome}</span>
        <I.Chevron size={13} className="collaboration-chevron" aria-hidden />
      </summary>
      <ul className="collaboration-steps">
        {steps.map((s) => {
          const status = interrupted && (s.status === 'working' || s.status === 'queued') ? 'stopped' : s.status
          return (
            <li key={s.id} className={`collaboration-step is-${status}`}>
              <span className="collaboration-dot" aria-hidden />
              <span className="collaboration-role">{COLLABORATION_ROLE[s.role]}{s.role === 'specialist' ? ` ${Number(s.id.slice('specialist-'.length)) + 1}` : ''}</span>
              {show && <span className="collaboration-model" title={s.model}>{s.model}</span>}
              <span className="collaboration-status">{COLLABORATION_STATUS[status]}</span>
            </li>
          )
        })}
      </ul>
    </details>
  )
}

/** Hover bar: react, reply, more (copy). Matches the bot-chat style. */
function MessageTools({ m, actions, side, onEdit, onRetry, latest }: { m: Message; actions: ThreadActions; side: 'left' | 'right'; onEdit?: () => void; onRetry?: () => void; latest?: boolean }) {
  const dev = useDevMode()
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
  // The latest answer: if its task changed files, one click puts them back (Grok Bot can't take back what's done).
  const [undoable, setUndoable] = useState(0)
  useEffect(() => {
    if (!latest || m.role !== 'assistant') { setUndoable(0); return }
    let alive = true
    void api.undo?.status(m.threadId, m.id).then((s) => { if (alive) setUndoable(s?.files ?? 0) }).catch(() => undefined)
    return () => { alive = false }
  }, [latest, m.id, m.threadId, m.role])
  const undo = (): void => { void api.undo.run(m.threadId, m.id).then((text) => { setUndoable(0); toast(text, 'ok') }).catch((e) => toast((e as Error).message, 'error')) }
  return (
    <div className={`msg-actions${picker || menu ? ' pinned' : ''}`} ref={ref}>
      {canReact && <button className="icon-btn" title="React" aria-label="React" onClick={() => setPicker(picker ? null : 'quick')} data-testid="react-btn"><I.Smile size={17} /></button>}
      {onEdit && <button className="icon-btn" title="Edit and resend" aria-label="Edit and resend" onClick={onEdit} data-testid="edit-last"><I.Edit size={16} /></button>}
      <button className="icon-btn" title="Reply" aria-label="Reply" onClick={() => actions.onReply(m.content)}><I.Reply size={17} /></button>
      {canReact && m.content && <button className="icon-btn" title={copied ? 'Copied' : 'Copy'} aria-label={copied ? 'Copied' : 'Copy'} onClick={() => { void navigator.clipboard.writeText(m.content); setCopied(true); setTimeout(() => setCopied(false), 900) }} data-testid="copy-msg">{copied ? <I.Check size={15} /> : <I.Copy size={15} />}</button>}
      {canReact && m.content && <button className="icon-btn" title="Read aloud (Esc stops)" aria-label="Read aloud (Esc stops)" onClick={() => void api.voice.speak(m.content)} data-testid="read-aloud"><I.Speaker size={16} /></button>}
      {undoable > 0 && <button className="icon-btn" title={`Undo the file changes (${undoable} file${undoable === 1 ? '' : 's'})`} aria-label="Undo the file changes" onClick={undo} data-testid="undo-changes"><I.Undo size={16} /></button>}
      {onRetry && <button className="icon-btn" title="Retry" aria-label="Retry" onClick={onRetry} data-testid="retry"><I.Reply size={15} style={{ transform: 'scaleX(-1)' }} /></button>}
      <button className="icon-btn" title="More" aria-label="More" onClick={() => setMenu((x) => !x)}><span className="more">···</span></button>
      {picker && (
        <div className={`emoji-bar ${side}`}>
          {(picker === 'quick' ? QUICK : MORE).map((e) => (
            <button key={e} onClick={() => { actions.onReact(m.id, e); setPicker(null) }} data-testid="emoji">{e}</button>
          ))}
          {picker === 'quick' && <button className="emoji-more" title="More" aria-label="More" onClick={() => setPicker('more')}><I.SmilePlus size={20} /></button>}
        </div>
      )}
      {menu && (
        <div className={`menu down ${side === 'right' ? '' : 'right'}`} style={{ minWidth: 160, maxWidth: 320 }}>
          <button className="menu-item" onClick={() => {
            void navigator.clipboard.writeText(m.content)
            setCopied(true)
            setTimeout(() => { setCopied(false); setMenu(false) }, 700)
          }}>{copied ? <I.Check size={15} /> : <I.Copy size={15} />}Copy text</button>
          {/* Which model answered and why (Auto's read, teamwork, cost class): one click away, without cluttering the chat. */}
          {dev && m.role === 'assistant' && m.model && (
            <div className="menu-note" data-testid="why-model">
              <b>{(((m.meta?.routed as { label?: string } | undefined)?.label) || m.model).split(' · ')[0]}</b>
              <span>{routedTitle(m).replace(/^Why this model:\s*/, '')}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** The model chip's hover: Auto's "Why this model" line (main: auto-brain.ts explainPick), else its routing note. */
export function routedTitle(m: Pick<Message, 'meta'>): string {
  const r = m.meta?.routed as { why?: string; explain?: string } | undefined
  if (!r) return 'Picked in the model menu'
  return r.explain || `Auto chose this model: ${r.why ?? ''}`
}
