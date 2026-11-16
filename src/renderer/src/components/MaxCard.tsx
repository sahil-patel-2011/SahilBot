import { useState } from 'react'
import type { MaxBoard, MaxPhase, TeamMember } from '@shared/types'
import { api } from '../api'
import * as I from '../icons'
import { groupMembers, maxTotals, money, teamTotals, tokenCount, unfinished } from '../lib/swarm-view'
import { HeavyCard, MemberRow, SwarmCard } from './HeavyCard'
import { Markdown } from './Markdown'

// Max's one live card: the strategy the planner chose and why ("Max · idea swarm → judged final draft"), the
// phases as a stepper, then each phase's own board (team helpers with model, status and cost; the swarm's
// helpers and ideas; the attempts with the judge's notes), and the result with its credits. The team, swarm
// and Heavy boards are the same components their own cards use (HeavyCard.tsx), embedded.

const PHASE_STATUS: Record<MaxPhase['status'], string> = { waiting: 'Waiting', running: 'Working', done: 'Done', failed: 'Didn\'t finish', stopped: 'Stopped', skipped: 'Skipped' }
const SOURCE: Record<MaxBoard['source'], string> = { composer: 'you turned Max on', bot: 'this bot\'s Max setting', auto: 'Auto teams up only for big tasks', tool: 'the bot chose Max' }
const PHASE_ICON = { team: <I.Users size={13} />, swarm: <I.Layers size={13} />, heavy: <I.Sparkle size={13} /> }

function TeamPhase({ callId, members, live }: { callId: string; members: TeamMember[]; live: boolean }) {
  const [showDone, setShowDone] = useState(false)
  const left = unfinished(members)
  const t = teamTotals(members)
  const big = members.length > 12
  const done = members.filter((m) => m.status === 'done').length
  return (
    <div className="max-team team-card embedded" data-testid="team-card">
      <div className="max-sec-head">
        <I.Users size={14} /><span className="plan-title">Research team</span>
        <span className="plan-count">{done} of {members.length} done{t.usd ? <span className="dev-only">{` · ${money(t.usd)}`}</span> : null}{t.tokens ? <span className="dev-only">{` · ${tokenCount(t.tokens)}`}</span> : null}</span>
        {live && left > 0 && <button className="link-btn max-stop" onClick={() => void api.swarm.stopRemaining(callId)} data-testid="team-stop-remaining">Stop remaining ({left})</button>}
      </div>
      <div className="team-board">
        {groupMembers(members).map((g) => {
          const folded = big && g.status === 'done' && !showDone
          return (
            <div key={g.status} className={`team-group tg-${g.status}`} data-testid="team-group">
              <button className="team-group-head" onClick={() => g.status === 'done' && big && setShowDone((x) => !x)} disabled={!(g.status === 'done' && big)}>
                <span>{g.label}</span><span className="tg-count">{g.members.length}</span>
                {g.status === 'done' && big && <span className="tg-toggle">{folded ? 'Show' : 'Hide'}</span>}
              </button>
              {!folded && <div className="team-rows">{g.members.map((m) => <MemberRow key={m.id} m={m} live={live} />)}</div>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** The headline status: what is happening now, or how it ended. */
function statusLine(b: MaxBoard, live: boolean): string {
  if (b.status === 'done') return 'Done'
  if (b.status === 'stopped') return 'Stopped'
  if (b.status === 'failed' && !live) return 'Didn\'t finish'
  const now = b.phases.find((p) => p.status === 'running')
  if (!now) return 'Starting…'
  if (now.kind === 'heavy') {
    const j = b.heavy?.judge.status
    return j === 'comparing' ? 'Judge comparing attempts' : j === 'rechecking' ? 'Re-checking a contested point' : j === 'writing' ? 'Writing the judged answer' : 'Attempts working'
  }
  if (now.kind === 'swarm') return b.swarm?.phase === 'compiling' ? 'Compiling the swarm' : 'Swarm working'
  return 'Team researching'
}

export function MaxCard({ board, live }: { board: MaxBoard; live: boolean }) {
  const [open, setOpen] = useState(true)
  const active = live && board.status === 'running'
  const tot = maxTotals(board)
  const finished = board.phases.filter((p) => p.status === 'done').length
  const progress = board.status === 'done' ? 1 : (finished + (tot.agents ? tot.done / tot.agents : 0) * 0.9) / Math.max(1, board.phases.length)
  const teams = board.teams ?? []
  // Phases in their order, each with its board (a team phase can hold several teams).
  const sections = board.phases.map((p, i) => ({ p, i }))
  return (
    <div className={`heavy-card max-card${active ? ' live' : ''}`} data-testid="max-card" data-strategy={board.strategy} data-status={board.status}>
      <button className="plan-head max-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="max-badge" aria-hidden><I.Bolt size={13} /></span>
        <span className="plan-title">Agent swarm</span>
        <span className="max-title" data-testid="max-title">{board.title}</span>
        <span className="plan-count max-status">{statusLine(board, live)}{tot.usd ? <span className="dev-only">{` · ${money(tot.usd)}`}</span> : null}</span>
        <span className="plan-bar"><i style={{ width: `${Math.min(1, progress) * 100}%` }} /></span>
        <I.Chevron size={13} style={{ transform: open ? 'rotate(180deg)' : undefined }} />
      </button>
      {open && (
        <div className="heavy-body max-body">
          <div className="max-why" data-testid="max-why">
            <span className="max-why-k">Why</span>
            <span className="max-why-v">{board.source === 'auto' ? `Auto: ${board.why}` : board.why || 'picked for this request'}</span>
            <span className="sw-pill">{SOURCE[board.source]}</span>
            {board.unattended && <span className="sw-pill">routine budget{board.budgetUsd !== undefined ? ` ${money(board.budgetUsd) || '$0.00'}` : ''}</span>}
          </div>
          <ol className="max-steps" data-testid="max-phases">
            {board.phases.map((p, i) => (
              <li key={i} className={`max-step ms-${p.status}`} data-testid="max-phase" data-kind={p.kind} data-status={p.status} title={p.note}>
                <span className="ms-dot">{p.status === 'done' ? <I.Check size={11} /> : i + 1}</span>
                <span className="ms-ico" aria-hidden>{PHASE_ICON[p.kind]}</span>
                <span className="ms-label">{p.label}</span>
                <span className="ms-status">{PHASE_STATUS[p.status]}</span>
                {i < board.phases.length - 1 && <span className="ms-arrow" aria-hidden>→</span>}
              </li>
            ))}
          </ol>
          {sections.map(({ p, i }) => (
            <section key={i} className={`max-phase mp-${p.kind}`}>
              {p.note && <div className="max-note">{p.note}</div>}
              {p.kind === 'team' && teams.map((t) => <TeamPhase key={t.callId} callId={t.callId} members={t.members} live={active} />)}
              {p.kind === 'team' && !teams.length && p.status !== 'skipped' && <div className="hint max-wait">{p.status === 'waiting' ? 'Starts after the phase before it.' : 'The lead is splitting the work into helper tasks…'}</div>}
              {p.kind === 'swarm' && board.swarm && <SwarmCard board={board.swarm} live={active} embedded title={p.label} />}
              {p.kind === 'swarm' && !board.swarm && p.status !== 'skipped' && <div className="hint max-wait">{p.status === 'waiting' ? 'Starts after the phase before it.' : 'The lead is writing the swarm\'s brief…'}</div>}
              {p.kind === 'heavy' && board.heavy && <HeavyCard board={board.heavy} groupId={board.heavyId ?? ''} live={active} embedded title={p.label} />}
              {p.kind === 'heavy' && !board.heavy && p.status !== 'skipped' && <div className="hint max-wait">{p.status === 'waiting' ? 'Independent attempts write the final version next, then a judge compares them.' : 'Starting the attempts…'}</div>}
              {board.brief && i === 0 && board.strategy === 'hybrid' && (
                <details className="max-brief" data-testid="max-brief"><summary className="hint">Phase 1 brief, handed to the judged attempts</summary><Markdown text={board.brief} /></details>
              )}
            </section>
          ))}
          {board.result && (
            <div className="max-result" data-testid="max-result">
              <div className="hj-head"><span className="hj-title">Result</span>
                {board.result.credits.length > 0 && <span className="max-credits" data-testid="max-credits">Credits: {[...board.result.credits].sort((a, b) => b.count - a.count).slice(0, 8).map((c) => <span key={c.tag} className="hj-tags">{c.tag}×{c.count}</span>)}</span>}
              </div>
              <details><summary className="hint">The answer, as delivered</summary><Markdown text={board.result.excerpt} /></details>
            </div>
          )}
          <div className="heavy-foot">
            <span className="max-agents">{tot.agents ? `${tot.done} of ${tot.agents} agents finished` : ''}</span>
            {tot.usd ? <span className="heavy-cost">{money(tot.usd)} spent</span> : null}
          </div>
        </div>
      )}
    </div>
  )
}
