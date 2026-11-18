import { useEffect, useState, type ReactNode } from 'react'
import type { FastCatalogRow, FastChoice, FastModeSettings, FastSpeedOption, ModelList, Settings } from '@shared/types'
import { api } from '../api'
import { Toggle } from './Toggle'
import { ClampText, Disclosure } from './ui'

// Settings → Models: the xAI (Grok) section and Fast mode (per provider, then per model). Facts on each row
// come from the providers' docs (docs/model-routing.md "Fast mode", docs/grok.md); fast mode is off by default.

type Patch = (p: Partial<Settings>) => Promise<Settings>

const DEFAULT: FastModeSettings = { providers: { anthropic: false, openai: false, xai: false }, models: {}, auto: 'speed' }
const fastOf = (s: Settings): FastModeSettings => ({ ...DEFAULT, ...s.fastMode, providers: { ...DEFAULT.providers, ...s.fastMode?.providers }, models: { ...s.fastMode?.models } })

const PROVIDERS: Array<{ id: 'anthropic' | 'openai' | 'xai'; name: string; how: string; key: 'anthropic' | 'openai' | 'xai' }> = [
  { id: 'anthropic', name: 'Anthropic', key: 'anthropic', how: 'speed "fast" on Claude Opus 5.5, Fable 5.2 and Mythos 5.2 (Opus 5 and 4.8 in preview / deprecated): up to 2.5x faster output at 2x the price. Over its own rate limit a request falls back to standard speed and price.' },
  { id: 'openai', name: 'OpenAI', key: 'openai', how: 'service_tier "fast": up to 2.5x faster at 2x the price on most models (GPT-5.5: 2.5x); OpenAI may downgrade a request to standard speed, and it is then billed at standard. Ultrafast, OpenAI’s fastest tier (up to 4.5x on GPT-6.2), is only on GPT-6.2 Astra and Sol (3x until Feb 28, 2027, then 6x) and GPT-6 Astra and GPT-6.1 Sol (6x): choose it per model below. This switch never turns on Ultrafast.' },
  { id: 'xai', name: 'xAI', key: 'xai', how: 'service_tier "priority": served ahead of standard traffic when capacity is free, at 2x the price, billed only when xAI confirms it. (Grok 4.7 Fast is a Cursor / Grok Build model, not on the API.)' }
]

/** Rows from an older main process (no options): the multipliers alone. */
const fallbackOptions = (r: FastCatalogRow): FastSpeedOption[] => [
  { tier: 'standard', title: 'Standard', speed: 'normal speed', factor: 1, line: 'Standard · normal speed · 1x price', tradeoffs: [] },
  { tier: 'fast', title: 'Fast', speed: '', factor: r.factor, line: `Fast · ${r.factor}x price`, tradeoffs: [] },
  ...(r.ultrafast ? [{ tier: 'ultrafast' as const, title: 'Ultrafast', speed: '', factor: r.ultrafast, line: `Ultrafast · ${r.ultrafast}x price`, tradeoffs: [] }] : [])
]

/** Settings → Models → Fast mode. */
export function FastModeSection({ s, patch, models }: { s: Settings; patch: Patch; models: ModelList | null }) {
  const [rows, setRows] = useState<FastCatalogRow[]>([])
  useEffect(() => { void api.fast.catalog().then(setRows).catch(() => setRows([])) }, [models])
  const f = fastOf(s)
  const save = (next: FastModeSettings): void => void patch({ fastMode: next })
  const setModel = (id: string, v: FastChoice): void => {
    const m = { ...f.models }
    if (v === 'inherit') delete m[id.toLowerCase()]
    else m[id.toLowerCase()] = v
    save({ ...f, models: m })
  }
  const keyed = PROVIDERS.filter((p) => s.keys?.[p.key])
  if (!keyed.length) return null
  // The models switched on in the picker first; the rest (older, superseded) behind a disclosure.
  const mine = rows.filter((r) => keyed.some((p) => p.id === r.provider))
  const shown = mine.filter((r) => r.enabled !== false)
  const hidden = mine.filter((r) => r.enabled === false)
  const row = speedRows(f, setModel)
  return (
    <section className="set-section" data-testid="fast-mode">
      <div className="set-label">Fast mode</div>
      <div className="set-sub fm-sub">Faster replies for a higher price, through each provider’s own fast service tier. Off unless you switch it on. Fast requests are priced at their real rate in your monthly limit and in each step’s cost.</div>
      <div className="set-card">
        {keyed.map((p) => (
          <div className="set-row" key={p.id}>
            <div className="set-row-text">
              <div className="set-row-title">{p.name}</div>
              <ClampText>{p.how}</ClampText>
            </div>
            <Toggle on={f.providers[p.id]} onChange={(v) => save({ ...f, providers: { ...f.providers, [p.id]: v } })} label={`Fast mode for ${p.name}`} testId={`fast-provider-${p.id}`} />
          </div>
        ))}
        <div className="set-row">
          <div className="set-row-text">
            <div className="set-row-title">When Auto picks the model</div>
            <ClampText>Auto never uses fast mode unless it is allowed above. “Only where speed matters” keeps it to voice, small talk and quick code questions.</ClampText>
          </div>
          <select className="set-select" value={f.auto} onChange={(e) => save({ ...f, auto: e.target.value as FastModeSettings['auto'] })} data-testid="fast-auto">
            <option value="speed">Only where speed matters</option>
            <option value="allowed">Whenever allowed</option>
            <option value="never">Never</option>
          </select>
        </div>
      </div>
      {shown.length > 0 && (
        <div className="set-card fm-models">
          {shown.map(row)}
        </div>
      )}
      {hidden.length > 0 && (
        <Disclosure title={`Models switched off in the picker (${hidden.length})`} sub="Their speed choice applies when you pick one by name" testId="fast-models-off">
          <div className="set-card fm-models">{hidden.map(row)}</div>
        </Disclosure>
      )}
    </section>
  )
}

/** Rows of the per-model speed choice. */
function speedRows(f: FastModeSettings, setModel: (id: string, v: FastChoice) => void) {
  return (r: FastCatalogRow) => {
    const v = (f.models[r.id.toLowerCase()] ?? 'inherit') as FastChoice
    const providerName = PROVIDERS.find((p) => p.id === r.provider)!.name
    const inherited = f.providers[r.provider] ? 'fast' : 'standard'
    const running = v === 'inherit' ? inherited : v === 'on' ? 'fast' : v === 'ultrafast' ? 'ultrafast' : 'standard'
    const options = r.options?.length ? r.options : fallbackOptions(r)
    const named = (t: string): string => options.find((o) => o.tier === t)?.title ?? t
    return (
      <div className="set-row fm-model" key={r.id} data-testid="fast-model-row">
        <div className="set-row-text">
          <div className="set-row-title">{r.label}<span className={`tier-badge${running !== 'standard' ? ' ok' : ''}`}>{v === 'inherit' ? `${providerName} setting: ${named(inherited)}` : named(running)}</span></div>
          <div className="fm-speeds" role="radiogroup" aria-label={`Speed for ${r.label}`} data-testid={`fast-model-${r.id}`}>
            <label className={`fm-speed${v === 'inherit' ? ' on' : ''}`}>
              <input type="radio" name={`fm-${r.id}`} checked={v === 'inherit'} onChange={() => setModel(r.id, 'inherit')} data-testid={`fast-speed-${r.id}-inherit`} />
              <span className="fm-speed-text"><span className="fm-speed-title">Use the {providerName} setting</span><span className="fm-speed-line">Now {named(inherited)}: the {providerName} switch above</span></span>
            </label>
            {options.map((o) => {
              const choice: FastChoice = o.tier === 'standard' ? 'off' : o.tier === 'fast' ? 'on' : 'ultrafast'
              return (
                <label key={o.tier} className={`fm-speed${v === choice ? ' on' : ''}`}>
                  <input type="radio" name={`fm-${r.id}`} checked={v === choice} onChange={() => setModel(r.id, choice)} data-testid={`fast-speed-${r.id}-${o.tier}`} />
                  <span className="fm-speed-text">
                    <span className="fm-speed-title">{o.title}</span>
                    <span className="fm-speed-line" data-testid={`fast-penalty-${r.id}-${o.tier}`} title={o.line}>{o.line.startsWith(`${o.title} · `) ? o.line.slice(o.title.length + 3) : o.line}</span>
                    {o.tradeoffs.length > 0 && <span className="fm-speed-notes">{o.tradeoffs.join(' · ')}</span>}
                  </span>
                </label>
              )
            })}
          </div>
        </div>
      </div>
    )
  }
}

/** Settings → Models → xAI (Grok): the key (Keychain), a Test button, and what SahilBot uses Grok for. */
export function XaiSection({ s, models, keyField }: { s: Settings; models: ModelList | null; keyField: ReactNode }) {
  const grok = (models?.models ?? []).filter((m) => m.provider === 'xai' && m.installed)
  const status = models?.providers?.find((p) => p.id === 'xai')
  return (
    <section className="set-section" data-testid="xai-section">
      <div className="set-label">xAI (Grok)</div>
      <div className="set-card">
        <div className="set-row">
          <div className="set-row-text">
            <div className="set-row-title">API key{status && <span className={`tier-badge${status.ok ? ' ok' : ''}`}>{status.ok ? `Connected · ${status.count} model${status.count === 1 ? '' : 's'}` : 'Not connected'}</span>}</div>
            <ClampText>From <a href="https://console.x.ai" target="_blank" rel="noreferrer">the xAI Console</a>. Saved in your Keychain and used only for models named “grok-…”. Spending counts toward your monthly limit.</ClampText>
          </div>
          {keyField}
        </div>
        {s.keys?.xai && (
          <div className="set-row">
            <div className="set-row-text">
              <div className="set-row-title">How Auto uses Grok</div>
              <ClampText>
                Grok 4.7 ($2 / $6 per M tokens, 500K context) is routed by its measured strengths: documents and knowledge work (after Claude Opus and Sonnet, ahead of GPT), and as a later choice elsewhere, where independent boards put it behind Claude and GPT. Pick it by name any time. Thinking maps to xAI’s low / medium / high / xhigh.
                {grok.length > 0 && <> Available: {grok.map((m) => m.label || m.id).join(', ')}.</>}
              </ClampText>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
