import { useState } from 'react'
import type { HeavyAttempt, HeavyBoard, PendingRequest, TeamMember } from '@shared/types'
import { api } from '../api'
import * as I from '../icons'
import { toast } from '../lib/toast'
import { money, tokenCount, unfinished } from '../lib/swarm-view'
import { Markdown } from './Markdown'

// Heavy mode's card (each attempt's model, status and cost, the judge's verdict, the answers on demand),
// one compact helper row shared with the Team board, and the cost card a big swarm or a Heavy run asks with.

const shortModel = (m?: string): string => (m ?? '').replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2')

const cancel = (id: string): void => {
  void api.swarm.cancel(id).then((ok) => { if (!ok) toast('That one already finished.', 'ok') }, (e: Error) => toast(e.message, 'error'))
}

/** One helper (or attempt) as a compact row: status dot, name, what it's doing, model, tokens, cost, cancel. */
export function MemberRow({ m, live, label }: { m: Pick<TeamMember, 'id' | 'title' | 'status' | 'detail' | 'model' | 'usd' | 'tokens' | 'depth'>; live: boolean; label?: string }) {
  const canCancel = live && (m.status === 'working' || m.status === 'queued')
  return (
    <div className={`team-row tm-${m.status}${m.depth > 1 ? ' sub' : ''}`} data-testid="team-member" title={m.detail}>
      <span className="tm-dot" />
      <span className="tr-title">{label ?? m.title}</span>
      <span className="tr-detail">{m.detail ?? ''}</span>
      <span className="tr-model">{shortModel(m.model)}</span>
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
export function HeavyCard({ board, groupId, live }: { board: HeavyBoard; groupId: string; live: boolean }) {
  const [open, setOpen] = useState(true)
  const finished = ['done', 'failed', 'stopped'].includes(board.judge.status)
  const active = live && !finished
  const done = board.attempts.filter((a) => a.status === 'done').length
  const left = unfinished(board.attempts)
  const v = board.judge.verdict
  const steps = board.attempts.length + 1
  const progress = (done + (board.judge.status === 'done' ? 1 : 0)) / steps
  return (
    <div className={`heavy-card${active ? ' live' : ''}`} data-testid="heavy-card">
      <button className="plan-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <I.Sparkle size={15} />
        <span className="plan-title">Heavy</span>
        <span className="plan-count">{active ? JUDGE_STATUS[board.judge.status] : `${done} of ${board.attempts.length} attempts`}{board.spentUsd ? ` · ${money(board.spentUsd)}` : ''}</span>
        <span className="plan-bar"><i style={{ width: `${progress * 100}%` }} /></span>
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

/** A big swarm or a Heavy run asking for the user's OK on what it will cost. */
export function SpendCard({ req, onRespond }: { req: PendingRequest; onRespond: (id: string, answer: string) => void | Promise<unknown> }) {
  const s = req.spend!
  return (
    <div className="pending ap-card spend-card" data-testid="spend-card" data-id={req.id}>
      <div className="ap-head">
        <span className="ap-icon">{s.kind === 'heavy' ? <I.Sparkle size={15} /> : <I.Users size={15} />}</span>
        <div className="ap-head-text">
          <div className="ap-summary" data-testid="spend-summary">{req.summary}</div>
          <div className="ap-meta">{s.kind === 'heavy' ? 'Heavy' : 'Team of Experts'} · cloud spend{req.reason ? ` · ${req.reason}` : ''}</div>
        </div>
      </div>
      <div className="spend-figs">
        <div><span className="sf-n">{s.count}</span><span className="sf-l">{s.kind === 'heavy' ? 'attempts' : 'helpers'}</span></div>
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
