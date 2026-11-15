import type { ModelInfo, Settings } from '@shared/types'
import { choiceText, contextChoices, savedChoice, withChoice } from '@shared/context-choices'

/**
 * Settings → Models: one model's "Context window". Only the sizes its provider offers (or, for a local model,
 * what fits this Mac); "Default (follow strategy)" first. The choice is applied exactly (llm/context-window.ts).
 */
export function ModelContextSelect({ model, s, patch }: { model: ModelInfo; s: Settings; patch: (p: Partial<Settings>) => Promise<unknown> }) {
  const choices = contextChoices(model)
  if (choices.length <= 1) return null
  const saved = savedChoice(s.modelContext, model.id)
  // A saved size this model doesn't list (its table changed) still shows, so the select tells the truth.
  const listed = choices.some((c) => c.tokens === saved)
  return (
    <select
      className="set-select"
      style={{ maxWidth: 230 }}
      title="Context window: how much of the conversation this model works with before older turns are summarized"
      aria-label={`Context window for ${model.label || model.id}`}
      value={saved}
      onChange={(e) => void patch({ modelContext: withChoice(s.modelContext, model.id, Number(e.target.value)) })}
      data-testid={`model-context-${model.id}`}
    >
      {choices.map((c) => <option key={c.tokens} value={c.tokens}>{c.tokens === 0 ? 'Default context' : choiceText(c)}</option>)}
      {!listed && saved > 0 && <option value={saved}>{`${Math.round(saved / 1000)}K (saved)`}</option>}
    </select>
  )
}
