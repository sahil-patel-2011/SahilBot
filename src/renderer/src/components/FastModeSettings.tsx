import { useEffect, useState, type ReactNode } from 'react'
import type { FastCatalogRow, FastChoice, FastModeSettings, ModelList, Settings } from '@shared/types'
import { api } from '../api'
import { Toggle } from './Toggle'
import { ClampText } from './ui'

// Settings → Models: the xAI (Grok) section and Fast mode (per provider, then per model). Facts on each row
// come from the providers' docs (docs/model-routing.md "Fast mode", docs/grok.md); fast mode is off by default.

type Patch = (p: Partial<Settings>) => Promise<Settings>

const DEFAULT: FastModeSettings = { providers: { anthropic: false, openai: false, xai: false }, models: {}, auto: 'speed' }
const fastOf = (s: Settings): FastModeSettings => ({ ...DEFAULT, ...s.fastMode, providers: { ...DEFAULT.providers, ...s.fastMode?.providers }, models: { ...s.fastMode?.models } })

const PROVIDERS: Array<{ id: 'anthropic' | 'openai' | 'xai'; name: string; how: string; key: 'anthropic' | 'openai' | 'xai' }> = [
  { id: 'anthropic', name: 'Anthropic', key: 'anthropic', how: 'speed "fast" on Claude Opus 5.5, Fable 5.2 and Mythos 5.2 (Opus 5 and 4.8 in preview / deprecated): up to 2.5x faster output at 2x the price. Over its own rate limit a request falls back to standard speed and price.' },
  { id: 'openai', name: 'OpenAI', key: 'openai', how: 'service_tier "fast": up to 2.5x faster at 2x the price on most models (GPT-5.5: 2.5x). Ultrafast, OpenAI’s fastest tier, is 6x and only on GPT-6 Astra and GPT-6.1 Sol: choose it per model below. A downgraded request is billed at standard.' },
  { id: 'xai', name: 'xAI', key: 'xai', how: 'service_tier "priority": served ahead of standard traffic when capacity is free, at 2x the price, billed only when xAI confirms it. (Grok 4.7 Fast is a Cursor / Grok Build model, not on the API.)' }
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
      {rows.some((r) => keyed.some((p) => p.id === r.provider)) && (
        <div className="set-card fm-models">
          {rows.filter((r) => keyed.some((p) => p.id === r.provider)).map((r) => {
            const v = (f.models[r.id.toLowerCase()] ?? 'inherit') as FastChoice
            const inherited = f.providers[r.provider] ? 'on' : 'off'
            return (
              <div className="set-row" key={r.id} data-testid="fast-model-row">
                <div className="set-row-text">
                  <div className="set-row-title">{r.label}<span className={`tier-badge${(v === 'inherit' ? inherited === 'on' : v !== 'off') ? ' ok' : ''}`}>{v === 'inherit' ? `Default (${inherited})` : v === 'ultrafast' ? 'Ultrafast' : v === 'on' ? 'On' : 'Off'}</span></div>
                  <ClampText>{r.tradeoff}</ClampText>
                </div>
                <select className="set-select" value={v} onChange={(e) => setModel(r.id, e.target.value as FastChoice)} data-testid={`fast-model-${r.id}`} aria-label={`Fast mode for ${r.label}`}>
                  <option value="inherit">Use {PROVIDERS.find((p) => p.id === r.provider)!.name} setting</option>
                  <option value="on">Fast ({r.factor}x price)</option>
                  {r.ultrafast && <option value="ultrafast">Ultrafast ({r.ultrafast}x price)</option>}
                  <option value="off">Off</option>
                </select>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
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
