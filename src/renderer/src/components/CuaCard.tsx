import { useState } from 'react'
import type { Message } from '@shared/types'
import * as I from '../icons'
import { useModelDetails } from '../lib/dev-mode'
import '../styles-cua.css'

// "Planner ⇄ Executor" card (src/main/agent/cua): the planner's plan with its checkpoints, and a compact timeline
// of both models' messages (plan, instructions, reports, disagreements, revisions, the done check). It rides on a
// notice message (never part of either model's history) that the main process updates as the run goes.

type Entry = { at: number; who: 'planner' | 'executor' | 'app' | 'user'; kind: string; text: string; checkpoint?: number; image?: boolean }
type Data = {
  planner: string; executor: string; why?: string; summary: string; current: number; active: boolean; finished?: string
  checkpoints: Array<{ id: number; goal: string; success: string; status: string }>
  timeline: Entry[]; plannerCalls: number; actions: number; disagreements: number
}

export const cuaOf = (m: Pick<Message, 'kind' | 'meta'>): Data | undefined => (m.kind === 'notice' && m.meta?.cua && typeof m.meta.cua === 'object' ? (m.meta.cua as Data) : undefined)

const WHO: Record<Entry['who'], string> = { planner: 'Planner', executor: 'Executor', app: 'SahilBot', user: 'You' }
const STATUS: Record<string, string> = { done: 'Done', stopped: 'Stopped', asked: 'Waiting for you', failed: 'Ended early' }

export function CuaCard({ m }: { m: Message }) {
  const d = cuaOf(m)
  const [open, setOpen] = useState(true)
  const { show, botChat } = useModelDetails()
  if (!d) return null
  const done = d.checkpoints.filter((c) => c.status === 'done').length
  const state = d.active ? 'Working' : STATUS[d.finished ?? ''] ?? 'Ended'
  return (
    <div className={`cua-card${d.active ? ' live' : ''}`} data-testid="cua-card" title={show || !botChat ? d.why : undefined}>
      <button className="cua-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <I.Sparkle size={15} />
        <span className="cua-title">Planner ⇄ Executor</span>
        {(show || !botChat) && <span className="cua-models"><b>{d.planner}</b> plans · <b>{d.executor}</b> executes</span>}
        <span className="cua-state" data-testid="cua-state">{state} · {done} of {d.checkpoints.length}</span>
        <I.Chevron size={13} style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform .15s' }} />
      </button>
      {open && (
        <div className="cua-body">
          {d.summary && <div className="cua-summary">{d.summary}</div>}
          <ol className="cua-steps">
            {d.checkpoints.map((c) => (
              <li key={c.id} className={`cs-${c.status}${c.id === d.current && d.active ? ' current' : ''}`} data-testid="cua-checkpoint">
                <span className="cs-mark">{c.status === 'done' ? <I.Check size={11} /> : null}</span>
                <span className="cs-text">{c.goal}<span className="cs-success">Done when: {c.success}</span></span>
              </li>
            ))}
          </ol>
          <ul className="cua-timeline" data-testid="cua-timeline">
            {d.timeline.map((e, i) => (
              <li key={i} className={`ct-${e.who} ck-${e.kind}`} data-testid="cua-entry" data-who={e.who} data-kind={e.kind}>
                <span className="ct-who">{WHO[e.who] ?? e.who}{e.checkpoint ? ` · ${e.checkpoint}` : ''}</span>
                <span className="ct-text">{e.kind === 'disagree' && !/^disagrees/i.test(e.text) ? 'Disagrees. ' : ''}{e.text}{e.image ? ' (with a screenshot)' : ''}</span>
              </li>
            ))}
          </ul>
          <div className="cua-foot">{d.plannerCalls} planner call{d.plannerCalls === 1 ? '' : 's'} · {d.actions} executor action{d.actions === 1 ? '' : 's'}{d.disagreements ? ` · ${d.disagreements} disagreement${d.disagreements === 1 ? '' : 's'}` : ''}</div>
        </div>
      )}
    </div>
  )
}
