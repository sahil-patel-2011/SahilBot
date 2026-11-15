import type { ComputerUseSettings, ModelInfo, Settings } from '@shared/types'
import { ClampText } from './ui'

// Settings → Models → Computer use (src/main/agent/cua): Single model / Planner + executor / Auto, and which model
// executes. Its own file so the Models page only gains one line.

type Patch = (p: { computerUse: ComputerUseSettings }) => unknown

export function ComputerUseSetting({ s, usable, patch }: { s: Settings; usable: ModelInfo[]; patch: Patch }) {
  const cu = s.computerUse ?? {}
  const set = (p: Partial<ComputerUseSettings>): void => { void patch({ computerUse: { ...cu, ...p } }) }
  const name = (m: ModelInfo): string => m.label || m.id
  return (
    <>
      <div className="set-row" data-testid="computer-use-row">
        <div className="set-row-text">
          <div className="set-row-title">Computer use</div>
          <ClampText>Planner + executor: a strong model plans the task as checkpoints and checks each one; another model clicks and types, and reports back (or disagrees). Auto uses it for multi-step tasks across apps, forms and long flows; a single click stays with one model. Approvals and hard stops apply to every action either way.</ClampText>
        </div>
        <div className="set-row-ctl">
          <select className="set-select" value={cu.mode ?? 'auto'} onChange={(e) => set({ mode: e.target.value as ComputerUseSettings['mode'] })} data-testid="computer-use-mode">
            <option value="auto">Auto</option>
            <option value="single">Single model</option>
            <option value="pair">Planner + executor</option>
          </select>
        </div>
      </div>
      {cu.mode !== 'single' && (
        <div className="set-row" data-testid="computer-use-executor-row">
          <div className="set-row-text">
            <div className="set-row-title">Executor model</div>
            <ClampText>Auto follows the evidence: Claude Sonnet 5.5 executes and Claude Opus 5.5 plans when both are on (GPT models when only an OpenAI key is saved). Pick a model to have it do the clicking.</ClampText>
          </div>
          <div className="set-row-ctl">
            <select className="set-select" value={cu.executor ?? ''} onChange={(e) => set({ executor: e.target.value })} data-testid="computer-use-executor">
              <option value="">Auto</option>
              {usable.map((m) => <option key={m.id} value={m.id}>{name(m)}</option>)}
            </select>
          </div>
        </div>
      )}
    </>
  )
}
