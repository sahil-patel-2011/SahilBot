import type { ModelInfo, ModelList } from './types'

// Which models the UI offers where. Main (Endpoints.list) marks a model `installed` only when it can
// actually run: downloaded in Ollama, loaded in LM Studio, served by the custom server, or a cloud model
// whose provider has a key saved. Recommended models that aren't downloaded yet, and names added by hand
// that nothing serves, are listed with installed: false, for Settings → Models only.

/** The model picker (besides Auto) and the bot editor: usable models that are switched on. */
export function pickerModels(list: Pick<ModelList, 'models'> | null | undefined): ModelInfo[] {
  return (list?.models ?? []).filter((m) => m.installed && m.enabled)
}

/** Recommended downloads that aren't on this Mac yet and fit it (shown as "Download", never pickable). */
export function toDownload(list: Pick<ModelList, 'models'> | null | undefined): ModelInfo[] {
  return (list?.models ?? []).filter((m) => !m.installed && !!m.pull && (m.fits || m.maxFittingWindow > 0))
}

/**
 * Settings → Models, "Recommended for this Mac": every recommended model, downloaded or not. The ones
 * that fit first (strongest first), then the ones too big for this Mac.
 */
export function recommendedRows(list: Pick<ModelList, 'models'> | null | undefined): ModelInfo[] {
  const fits = (m: ModelInfo): number => Number(m.fits || m.maxFittingWindow > 0)
  return (list?.models ?? [])
    .filter((m) => !!m.pull && m.provider === 'ollama' && m.note !== 'remote')
    .sort((a, b) => fits(b) - fits(a) || b.tier - a.tier || (b.rank ?? 0) - (a.rank ?? 0) || Number(b.installed) - Number(a.installed))
}

// ---------------------------------------------------------------------------------------------------
// The three Auto entries at the top of the model picker. Stored as the model value of a chat, a bot or
// the default ('auto', 'auto:local', 'auto:cloud'); main routes them (llm/router.ts autoPool).
// ---------------------------------------------------------------------------------------------------

export interface AutoEntry { id: 'auto' | 'auto:local' | 'auto:cloud'; label: string; sub: string }

export const AUTO_ENTRIES: AutoEntry[] = [
  { id: 'auto', label: 'Auto', sub: 'Best of both: the right model for each message, local or cloud' },
  { id: 'auto:local', label: 'Auto (local)', sub: 'Only models on this Mac: free and private' },
  { id: 'auto:cloud', label: 'Auto (cloud)', sub: 'Only cloud models with a key: Haiku for quick chats, Sonnet for tasks, Opus for the hardest' }
]

export const isAutoModel = (id: string | null | undefined): boolean => !id || AUTO_ENTRIES.some((e) => e.id === id)

/** "Auto", "Auto (local)", "Auto (cloud)" for an Auto value; undefined for a concrete model. */
export const autoLabel = (id: string | null | undefined): string | undefined => (!id ? 'Auto' : AUTO_ENTRIES.find((e) => e.id === id)?.label)

const isCloud = (m: ModelInfo): boolean => m.note === 'remote' || m.provider === 'anthropic' || m.provider === 'openai' || m.provider === 'openrouter'

/**
 * Why an Auto entry has nothing to route to right now, from the picker's listing (undefined: usable).
 * `o` (when the caller knows the settings): cloud models switched on, and any cloud provider keyed.
 */
export function autoUnavailableReason(id: AutoEntry['id'], list: Pick<ModelList, 'models'> | null | undefined, o?: { cloudOn: boolean; keyed: boolean }): string | undefined {
  if (!list) return undefined
  const usable = pickerModels(list)
  if (id === 'auto:local') return usable.some((m) => !isCloud(m)) ? undefined : 'No local models downloaded — open Settings → Models'
  if (id === 'auto:cloud') {
    if (usable.some(isCloud)) return undefined
    if (!o) return 'No cloud model available — add an API key (and turn cloud models on) in Settings → Models'
    return !o.cloudOn ? 'Cloud models are switched off — turn them on in Settings → General' : !o.keyed ? 'No cloud API key saved — add one in Settings → Models' : 'No cloud model is switched on — open Settings → Models'
  }
  return usable.length ? undefined : 'No models yet — add an API key or your ChatGPT plan in Settings → Models'
}
