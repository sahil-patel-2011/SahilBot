import { useEffect, useState } from 'react'
import type { CouncilBoard, HeavyAttempt, HeavyBoard, Message, PendingRequest, SwarmBoard, SwarmHelperView, TeamMember } from '@shared/types'
import { api } from '../api'
import * as I from '../icons'
import { toast } from '../lib/toast'
import { money, swarmStats, tokenCount, unfinished, type AskBotView } from '../lib/swarm-view'
import { SpaceAvatar } from '../brand'
import { Markdown } from './Markdown'
import { useDevMode } from '../lib/dev-mode'

// Heavy mode's card (each attempt's model, status and cost, the judge's verdict, the answers on demand),
// one compact helper row shared with the Team board, and the cost card a big swarm or a Heavy run asks with.

const shortModel = (m?: string): string => (m ?? '').replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2')

const cancel = (id: string): void => {
  void api.swarm.cancel(id).then((ok) => { if (!ok) toast('That one already finished.', 'ok') }, (e: Error) => toast(e.message, 'error'))
}

/** A one-line preview of a status or answer: Markdown marks (#, *, `, >) dropped, whitespace collapsed. */
const plain = (t?: string): string => (t ?? '').replace(/[#*_`>]+/g, '').replace(/\s+/g, ' ').trim()

/** One helper (or attempt) as a compact row: status dot, name, what it's doing, model, tokens, cost, cancel. */
export function MemberRow({ m, live, label }: { m: Pick<TeamMember, 'id' | 'title' | 'status' | 'detail' | 'model' | 'usd' | 'tokens' | 'depth'>; live: boolean; label?: string }) {
  const show = useDevMode()
  const canCancel = live && (m.status === 'working' || m.status === 'queued')
  return (
    <div className={`team-row tm-${m.status}${m.depth > 1 ? ' sub' : ''}`} data-testid="team-member" title={m.detail}>
      <span className="tm-dot" />
      <span className="tr-title">{label ?? m.title}</span>
      <span className="tr-detail">{plain(m.detail)}</span>
      {show && <span className="tr-model">{shortModel(m.model)}</span>}
      <span className="tr-num">{tokenCount(m.tokens)}</span>
      <span className="tr-num">{money(m.usd)}</span>
      {canCancel
        ? <button className="tr-cancel" onClick={(e) => { e.preventDefault(); e.stopPropagation(); cancel(m.id) }} title={m.status === 'queued' ? 'Don\'t start this one' : 'Stop this one (the rest carry on)'} aria-label={`Cancel ${label ?? m.title}`} data-testid="member-cancel"><I.Close size={11} /></button>
        : <span className="tr-cancel-space" />}
    </div>
  )
}

const JUDGE_STATUS: Record<HeavyBoard['judge']['status'], string> = {
  waiting: 'Waiting for the attempts', comparing: 'Comparing the attempts', rechecking: 'Having a contested point re-checked',
  writing: 'Writing the final answer', done: 'Done', failed: 'Didn\'t finish', stopped: 'Stopped'
}

const tags = (ns: number[]): string => ns.map((n) => `A${n}`).join(' ')

function Attempt({ a, live }: { a: HeavyAttempt; live: boolean }) {
  return (
    <li className="heavy-attempt" data-testid="heavy-attempt">
      <details>
        <summary>
          <MemberRow m={{ id: a.id, title: `Attempt ${a.n}`, status: a.status, detail: a.rechecked && a.status === 'done' ? `${a.detail ?? ''}` : a.detail ?? a.angle, model: a.label ?? a.model, usd: a.usd, tokens: a.tokens, depth: 1 }}
            live={live} label={`A${a.n}${a.rechecked ? ' · re-checked' : ''}`} />
        </summary>
        <div className="heavy-answer">
          <div className="heavy-angle">{a.angle}</div>
          {a.answer ? <Markdown text={a.answer} /> : <div className="hint">{a.status === 'working' || a.status === 'queued' ? 'Still working…' : 'No answer.'}</div>}
        </div>
      </details>
    </li>
  )
}

/** Heavy mode: the attempts, the judge's verdict, and what it cost. */
export function HeavyCard({ board, groupId, live, embedded, title }: { board: HeavyBoard; groupId: string; live: boolean; embedded?: boolean; title?: string }) {
  const [open, setOpen] = useState(true)
  const finished = ['done', 'failed', 'stopped'].includes(board.judge.status)
  const active = live && !finished
  const done = board.attempts.filter((a) => a.status === 'done').length
  const left = unfinished(board.attempts)
  const v = board.judge.verdict
  const steps = board.attempts.length + 1
  const progress = (done + (board.judge.status === 'done' ? 1 : 0)) / steps
  return (
    <div className={`heavy-card${active ? ' live' : ''}${embedded ? ' embedded' : ''}`} data-testid="heavy-card" data-judge={board.judge.status}>
      <button className="plan-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <I.Sparkle size={15} />
        <span className="plan-title">{title ?? 'Heavy'}</span>
        <span className="plan-count">{active ? JUDGE_STATUS[board.judge.status] : `${done} of ${board.attempts.length} attempts`}{board.spentUsd ? <span className="dev-only">{` · ${money(board.spentUsd)}`}</span> : null}</span>
        {!finished && <span className="plan-bar"><i style={{ width: `${progress * 100}%` }} /></span>}
        <I.Chevron size={13} style={{ transform: open ? 'rotate(180deg)' : undefined }} />
      </button>
      {open && (
        <div className="heavy-body">
          {active && left > 0 && (
            <div className="team-actions">
              <button className="link-btn" onClick={() => void api.swarm.stopRemaining(groupId)} data-testid="heavy-stop-remaining">Stop remaining attempts ({left})</button>
            </div>
          )}
          <ol className="heavy-attempts">{board.attempts.map((a) => <Attempt key={a.id} a={a} live={active} />)}</ol>
          <div className={`heavy-judge hj-${board.judge.status}`} data-testid="heavy-judge">
            <div className="hj-head">
              <span className="hj-title">Judge</span>
              <span className="tr-model">{board.judge.label ?? shortModel(board.judge.model)}</span>
              <span className="hj-status">{JUDGE_STATUS[board.judge.status]}</span>
            </div>
            {v && (
              <div className="hj-verdict" data-testid="heavy-verdict">
                {v.summary && <p className="hj-summary">{v.summary}</p>}
                {v.agreements.length > 0 && <section><h5>Agree</h5><ul>{v.agreements.map((x, i) => <li key={i}>{x}</li>)}</ul></section>}
                {v.disagreements.length > 0 && <section><h5>Disagree</h5><ul>{v.disagreements.map((x, i) => <li key={i}>{x.point}{x.attempts.length > 0 && <span className="hj-tags"> {tags(x.attempts)}</span>}</li>)}</ul></section>}
                {v.errors.length > 0 && <section><h5>Errors</h5><ul>{v.errors.map((x, i) => <li key={i}><span className="hj-tags">A{x.attempt}</span> {x.issue}</li>)}</ul></section>}
                {v.unsupported.length > 0 && <section><h5>Unsupported</h5><ul>{v.unsupported.map((x, i) => <li key={i}><span className="hj-tags">A{x.attempt}</span> {x.claim}</li>)}</ul></section>}
                {v.recheck && (
                  <section className="hj-recheck"><h5>Re-check · A{v.recheck.attempt}</h5>
                    <p>{v.recheck.question}</p>
                    {v.recheck.answer && <details><summary className="hint">Its answer</summary><Markdown text={v.recheck.answer} /></details>}
                  </section>
                )}
              </div>
            )}
          </div>
          {(board.note || board.capUsd) && (
            <div className="heavy-foot">
              {board.note && <span className="heavy-note">{board.note}</span>}
              {board.capUsd ? <span className="heavy-cost">{money(board.spentUsd) || '$0.00'} spent{board.estimateUsd ? ` · est. ${money(board.estimateUsd)}` : ''} · cap {money(board.capUsd)}</span> : null}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const SPEND_KIND: Record<NonNullable<PendingRequest['spend']>['kind'], string> = { team: 'Agent swarm · research', heavy: 'Agent swarm · independent review', swarm: 'Agent swarm', council: 'Agent swarm · cross-provider review' }

/** A big swarm or a Heavy run asking for the user's OK on what it will cost. */
export function SpendCard({ req, onRespond }: { req: PendingRequest; onRespond: (id: string, answer: string) => void | Promise<unknown> }) {
  const s = req.spend!
  const show = useDevMode()
  const quiet = !show
  return (
    <div className="pending ap-card spend-card" data-testid="spend-card" data-id={req.id}>
      <div className="ap-head">
        <span className="ap-icon">{s.kind === 'heavy' || s.kind === 'council' ? <I.Sparkle size={15} /> : <I.Users size={15} />}</span>
        <div className="ap-head-text">
          <div className="ap-summary" data-testid="spend-summary">{quiet ? 'Approve cloud spending for this team' : req.summary}</div>
          <div className="ap-meta">{SPEND_KIND[s.kind]} · cloud spend{!quiet && req.reason ? ` · ${req.reason}` : ''}</div>
        </div>
      </div>
      <div className="spend-figs">
        <div><span className="sf-n">{s.count}</span><span className="sf-l">{s.kind === 'heavy' ? 'attempts' : s.kind === 'council' ? 'members' : 'helpers'}</span></div>
        <div><span className="sf-n">{money(s.estimateUsd) || '$0.00'}</span><span className="sf-l">estimate</span></div>
        <div><span className="sf-n">{money(s.capUsd)}</span><span className="sf-l">hard cap</span></div>
      </div>
      {s.estimateUsd > s.capUsd && <div className="hint spend-warn">The estimate is above the cap: it stops at the cap and you get partial results.</div>}
      <div className="pending-actions">
        <button className="btn primary" onClick={() => onRespond(req.id, 'once')} data-testid="spend-ok">Run it</button>
        <button className="btn" onClick={() => onRespond(req.id, 'deny')} data-testid="spend-deny">Don't run</button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- bot swarms, Council, ask_bot

/** A hidden helper's thread, read on demand (the helpers are temporary; their transcripts stay readable). */
function Transcript({ threadId }: { threadId: string }) {
  const [ms, setMs] = useState<Message[] | null>(null)
  useEffect(() => {
    let live = true
    void api.threads.messages(threadId).then((x) => { if (live) setMs(x) }, () => { if (live) setMs([]) })
    return () => { live = false }
  }, [threadId])
  if (!ms) return <div className="hint">Loading…</div>
  const shown = ms.filter((m) => (m.role === 'user' || m.role === 'assistant' || m.role === 'tool') && m.kind !== 'notice' && (m.content || m.toolCalls?.length))
  if (!shown.length) return <div className="hint">Nothing yet.</div>
  return (
    <div className="sw-transcript" data-testid="swarm-transcript">
      {shown.map((m) => (
        <div key={m.id} className={`swt-row swt-${m.role}`}>
          <span className="swt-who">{m.role === 'user' ? 'Brief' : m.role === 'tool' ? String(m.meta?.label ?? m.toolName ?? 'Tool') : 'Helper'}</span>
          {m.role === 'tool'
            ? <span className="swt-tool">{String(m.meta?.display ?? '').slice(0, 160) || 'done'}</span>
            : m.role === 'assistant' && m.toolCalls?.length && !m.content
              ? <span className="swt-tool">{m.toolCalls.map((c) => c.name).join(', ')}</span>
              : <div className="swt-text"><Markdown text={m.content.length > 6000 ? `${m.content.slice(0, 6000)}\n\n[…]` : m.content} /></div>}
        </div>
      ))}
    </div>
  )
}

const SWARM_PHASE: Record<SwarmBoard['phase'], string> = { running: 'Helpers working', compiling: 'Compiling', refining: 'Round two', done: 'Compiled', stopped: 'Stopped', failed: 'Didn\'t finish' }
const ROLE_TAG: Record<string, string> = { breadth: 'breadth', solid: 'solid', hard: 'hardest', review: 'review' }

function SwarmHelperRow({ h, live, credited }: { h: SwarmHelperView; live: boolean; credited: boolean }) {
  const [open, setOpen] = useState(false)
  const show = useDevMode()
  return (
    <li className={`sw-helper${credited ? ' credited' : ''}`} data-testid="swarm-helper" data-status={h.status}>
      <button className="sw-helper-head" onClick={() => setOpen((o) => !o)} aria-expanded={open} title={h.angle}>
        <MemberRow m={{ id: h.id, title: h.title, status: h.status, detail: h.detail ?? h.angle, model: h.label ?? h.model, usd: h.usd, tokens: h.tokens, depth: 1 }} live={live} label={`H${h.n} · ${h.title}`} />
      </button>
      {(h.ideas?.length || h.credit) ? (
        <div className="sw-ideas">
          {h.credit ? <span className="sw-credit" data-testid="swarm-credit">{h.credit > 1 ? `used ${h.credit}× in the answer` : 'used in the answer'}</span> : null}
          {(h.ideas ?? []).slice(0, 4).map((t, i) => <span key={i} className="sw-idea">{t}</span>)}
          {(h.ideas?.length ?? 0) > 4 && <span className="sw-idea more">+{h.ideas!.length - 4}</span>}
        </div>
      ) : null}
      {open && (
        <div className="sw-detail">
          <div className="heavy-angle">{show && <><b>{ROLE_TAG[h.role] ? `${ROLE_TAG[h.role]} · ` : ''}{h.label ?? h.model}</b> · </>}{h.angle}</div>
          {h.childId ? <Transcript threadId={h.childId} /> : h.report ? <Markdown text={h.report} /> : <div className="hint">{h.status === 'queued' ? 'Not started yet.' : 'No result.'}</div>}
        </div>
      )}
    </li>
  )
}

/** A bot swarm: helpers with their angle, model and status, ideas as they come in, cost, and the compiled result with credits. */
export function SwarmCard({ board, live, embedded, title }: { board: SwarmBoard; live: boolean; embedded?: boolean; title?: string }) {
  const [open, setOpen] = useState(true)
  const [all, setAll] = useState(false)
  const show = useDevMode()
  const st = swarmStats(board)
  const active = live && !['done', 'stopped', 'failed'].includes(board.phase)
  const left = unfinished(board.helpers)
  const credited = new Set((board.compiled?.credits ?? []).map((c) => c.n))
  const rows = all || board.helpers.length <= 12 ? board.helpers : [...board.helpers.filter((h) => h.status === 'working'), ...board.helpers.filter((h) => h.status !== 'working')].slice(0, 12)
  return (
    <div className={`heavy-card swarm-card${active ? ' live' : ''}${embedded ? ' embedded' : ''}`} data-testid="swarm-card" data-phase={board.phase}>
      <button className="plan-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <I.Users size={15} />
        <span className="plan-title">{title ?? (board.bot ? `${board.bot}'s swarm` : 'Swarm')}</span>
        <span className="plan-count" data-testid="swarm-count">{st.done} of {st.total} helpers{st.ideas ? ` · ${st.ideas} ideas` : ''} · {SWARM_PHASE[board.phase]}{board.spentUsd ? <span className="dev-only">{` · ${money(board.spentUsd)}`}</span> : null}</span>
        {active && <span className="plan-bar"><i style={{ width: `${(st.done / Math.max(1, st.total)) * 100}%` }} /></span>}
        <I.Chevron size={13} style={{ transform: open ? 'rotate(180deg)' : undefined }} />
      </button>
      {open && (
        <div className="heavy-body">
          <div className="sw-meta">
            <span className="sw-pill">{board.pattern === 'ideate' ? 'Divergent ideas' : 'Divide and conquer'}</span>
            {board.sizing && <span className="sw-sizing" title="How the helper count was chosen">{board.sizing}</span>}
            {board.routing && show && <span className="sw-sizing">{board.routing}</span>}
            {board.unattended && <span className="sw-pill">routine budget</span>}
          </div>
          {active && left > 0 && (
            <div className="team-actions">
              <button className="link-btn" onClick={() => void api.swarm.stopRemaining(board.swarmId)} data-testid="swarm-stop-remaining">Stop remaining ({left})</button>
            </div>
          )}
          <ol className="sw-helpers">{rows.map((h) => <SwarmHelperRow key={h.id} h={h} live={active} credited={credited.has(h.n)} />)}</ol>
          {rows.length < board.helpers.length && <button className="link-btn sw-all" onClick={() => setAll(true)}>Show all {board.helpers.length} helpers</button>}
          <div className={`heavy-judge hj-${board.phase === 'done' ? 'done' : board.phase === 'failed' || board.phase === 'stopped' ? 'failed' : 'writing'}`} data-testid="swarm-compile">
            <div className="hj-head">
              <span className="hj-title">Compile</span>
              <span className="tr-model">{board.compiler ? `draft: ${board.compiler.label ?? board.compiler.model} · ` : ''}{board.lead.label ?? board.lead.model}</span>
              <span className="hj-status">{board.phase === 'done' ? 'Done' : board.phase === 'running' ? 'Waiting for the helpers' : SWARM_PHASE[board.phase]}</span>
            </div>
            {board.ideas && <p className="hj-summary">{board.ideas.total} ideas from {st.done} helpers, about {board.ideas.distinct} distinct after merging duplicates.</p>}
            {board.compiled && (
              <div className="sw-compiled" data-testid="swarm-compiled">
                {st.top.length > 0 && !embedded && <div className="sw-credits">Drew on: {st.top.map((c) => <span key={c.n} className="hj-tags">H{c.n}×{c.count}</span>)}</div>}
                <details><summary className="hint">Compiled result</summary><Markdown text={board.compiled.excerpt} /></details>
              </div>
            )}
          </div>
          {(board.note || board.capUsd) && (
            <div className="heavy-foot">
              {board.note && <span className="heavy-note">{board.note}</span>}
              {board.capUsd ? <span className="heavy-cost">{money(board.spentUsd) || '$0.00'} spent{board.estimateUsd ? ` · est. ${money(board.estimateUsd)}` : ''} · cap {money(board.capUsd)}</span> : null}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const COUNCIL_PHASE: Record<CouncilBoard['phase'], string> = {
  planning: 'Drafting plans', critiquing: 'Critiquing each other', merging: 'Merging the plans', deciding: 'Waiting for your call',
  executing: 'Carrying it out', reviewing: 'Reviewing each other', writing: 'Writing the answer', done: 'Done', stopped: 'Stopped', failed: 'Didn\'t finish'
}

/** Council: each member's own plan and critique, the merged plan with owners, disagreements, reviews, cost. */
export function CouncilCard({ board, live }: { board: CouncilBoard; live: boolean }) {
  const [open, setOpen] = useState(true)
  const show = useDevMode()
  const active = live && !['done', 'stopped', 'failed'].includes(board.phase)
  const who = (i: number): string => (show && (board.members[i]?.label ?? board.members[i]?.model)) || `Member ${i + 1}`
  return (
    <div className={`heavy-card council-card${active ? ' live' : ''}`} data-testid="council-card" data-phase={board.phase}>
      <button className="plan-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <I.Sparkle size={15} />
        <span className="plan-title">Agent swarm</span>
        <span className="plan-count">{COUNCIL_PHASE[board.phase]}{board.spentUsd ? <span className="dev-only">{` · ${money(board.spentUsd)}`}</span> : null}</span>
        <I.Chevron size={13} style={{ transform: open ? 'rotate(180deg)' : undefined }} />
      </button>
      {open && (
        <div className="heavy-body">
          <div className="cc-members">
            {board.members.map((m, i) => (
              <details key={m.id} className={`cc-member tm-${m.status === 'waiting' ? 'queued' : m.status}`} data-testid="council-member">
                <summary>
                  <span className="tm-dot" />
                  <b>{who(i)}</b>{m.chair && <span className="sw-pill">chair</span>}{m.critic && <span className="sw-pill">critic</span>}
                  {m.planOk === false && <span className="hj-tags">objects</span>}
                  <span className="tr-detail">{plain(m.detail)}</span>
                  <span className="tr-num">{money(m.usd)}</span>
                </summary>
                {m.plan && <section><h5>Its plan</h5><Markdown text={m.plan} /></section>}
                {m.critique && <section><h5>Its critique</h5><Markdown text={m.critique} /></section>}
                {m.objections?.length ? <section><h5>Objections to the merged plan</h5><ul>{m.objections.map((o, k) => <li key={k}>{o}</li>)}</ul></section> : null}
                {m.childId && <section><h5>Its work</h5><Transcript threadId={m.childId} /></section>}
              </details>
            ))}
          </div>
          {board.merged && (
            <div className="cc-plan" data-testid="council-plan">
              <h5>Merged plan</h5>
              {board.merged.summary && <p className="hj-summary">{board.merged.summary}</p>}
              <ol>
                {board.merged.steps.map((st) => (
                  <li key={st.n} className={`cc-step cs-${st.status}`} data-testid="council-step">
                    <span>{st.text}</span> <span className="hint">{who(st.owner)}{st.via === 'cursor' ? ' via Cursor' : ''}</span> <span className="hj-status">{st.status}</span>
                    {(st.output || st.instructions) && <details><summary className="hint">Result</summary>{st.instructions && <Markdown text={`**Cursor instructions**\n\n${st.instructions}`} />}{st.output && <Markdown text={st.output} />}</details>}
                  </li>
                ))}
              </ol>
            </div>
          )}
          {board.disagreements.length > 0 && (
            <div className="cc-disagree" data-testid="council-disagreements">
              <h5>Disagreements</h5>
              <ul>{board.disagreements.map((d, i) => <li key={i}>{d.point}{d.positions.length > 0 && <ul>{d.positions.map((p, k) => <li key={k}><b>{who(p.member)}:</b> {p.view}</li>)}</ul>}{d.resolution && <div className="hint">→ {d.resolution}</div>}</li>)}</ul>
            </div>
          )}
          {board.secondOpinion && <details className="cc-second"><summary className="hint">Second opinion{show ? ` · ${board.secondOpinion.label ?? board.secondOpinion.model}` : ''}</summary><Markdown text={board.secondOpinion.text} /></details>}
          {board.reviews.length > 0 && (
            <div className="cc-reviews" data-testid="council-reviews">
              <h5>Reviews · round {board.round} of {board.maxRounds}</h5>
              <ul>{board.reviews.map((r, i) => <li key={i} className={r.ok ? 'ok' : 'issue'} data-testid="council-review"><b>R{r.round} {who(r.by)} → {who(r.of)}:</b> {r.ok ? 'signed off' : r.notes || 'issues'}</li>)}</ul>
            </div>
          )}
          <div className="heavy-foot">
            {board.stopReason && <span className="cc-stop" data-testid="council-stop">{board.stopReason}</span>}
            {board.note && <span className="heavy-note">{board.note}</span>}
            {board.capUsd ? <span className="heavy-cost">{money(board.spentUsd) || '$0.00'} spent{board.estimateUsd ? ` · est. ${money(board.estimateUsd)}` : ''} · cap {money(board.capUsd)}</span> : null}
          </div>
        </div>
      )}
    </div>
  )
}

/** "Asked Finance bot": one bot's question to another and the answer, compact. */
export function AskBotCard({ v }: { v: AskBotView }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`askbot-card ab-${v.status}`} data-testid="askbot-card">
      <button className="ab-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <SpaceAvatar color={v.color ?? '#888'} shape={v.shape} size={18} />
        <span className="ab-title">{v.status === 'asking' ? `Asking ${v.bot}…` : `Asked ${v.bot}`}</span>
        <span className="ab-q">{v.question}</span>
        {v.usd ? <span className="tr-num">{money(v.usd)}</span> : null}
        <I.Chevron size={12} style={{ transform: open ? 'rotate(180deg)' : undefined }} />
      </button>
      {open && (
        <div className="ab-body">
          <div className="ab-qfull"><b>{v.from ?? 'This bot'} asked:</b> {v.question}</div>
          {v.answer ? <div className="ab-answer" data-testid="askbot-answer"><Markdown text={v.answer} /></div> : <div className="hint">{v.status === 'asking' ? 'Waiting for the answer…' : 'No answer.'}</div>}
          {v.childId && <details><summary className="hint">How it answered</summary><Transcript threadId={v.childId} /></details>}
        </div>
      )}
    </div>
  )
}
