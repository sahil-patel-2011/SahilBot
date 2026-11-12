import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { MemoryItem, ModelInfo, ModelList, ProviderId, Rule, Sampling, Settings, Skill, Space, SystemInfo, VaultEntry, VoiceStatus } from '@shared/types'
import { api } from '../api'
import * as I from '../icons'
import { toast } from '../lib/toast'

// Settings: one page per topic. Every change saves right away (keys go to the Keychain).

type Page = 'general' | 'models' | 'keys' | 'appearance' | 'voice' | 'memory' | 'rules' | 'passwords' | 'advanced'
const PAGES: Array<{ id: Page; label: string; icon: ReactNode; color: string; words: string }> = [
  { id: 'general', label: 'General', icon: <I.Gear size={14} />, color: '#8e8e93', words: 'name workspace folder quick ask shortcut search cloud budget spending limit hybrid' },
  { id: 'models', label: 'Models', icon: <I.Cpu size={14} />, color: '#5856d6', words: 'model auto download recommended voice background ollama lm studio' },
  { id: 'keys', label: 'API Keys & Servers', icon: <I.Plug size={14} />, color: '#007aff', words: 'anthropic claude openai openrouter cursor key base url ollama lm studio custom server' },
  { id: 'appearance', label: 'Appearance', icon: <I.Sparkle size={14} />, color: '#ff9500', words: 'theme dark light width font tint density code wrap' },
  { id: 'voice', label: 'Voice', icon: <I.Mic size={14} />, color: '#ff2d55', words: 'speak read aloud dictation whisper kokoro' },
  { id: 'memory', label: 'Memory', icon: <I.ListIcon size={14} />, color: '#34c759', words: 'remember people places projects facts' },
  { id: 'rules', label: 'Rules & Skills', icon: <I.Check size={14} />, color: '#30b0c7', words: 'rules skills procedures engineering medical business coding' },
  { id: 'passwords', label: 'Passwords', icon: <I.Shield size={14} />, color: '#636366', words: 'vault login password' },
  { id: 'advanced', label: 'Advanced', icon: <I.Edit size={14} />, color: '#af52de', words: 'context window gpu memory sampling hard stops' }
]

const WINDOWS: Settings['contextWindow'][] = [0, 16384, 32768, 65536, 131072]
const SAMPLING_KEYS: Array<keyof Sampling> = ['temperature', 'top_p', 'top_k', 'min_p', 'presence_penalty', 'repeat_penalty']
const TIER = ['Instant', 'Light', 'Standard', 'Heavy']
const clean = (e: unknown): string => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export type SettingsPatchUi = Parameters<typeof api.settings.set>[0]

// ------------------------------------------------------------------ building blocks

function Section({ title, sub, children }: { title?: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <section className="set-section">
      {title && <div className="set-label">{title}</div>}
      {sub && <div className="set-sub">{sub}</div>}
      <div className="set-card">{children}</div>
    </section>
  )
}

function Row({ title, sub, children, testId }: { title: ReactNode; sub?: ReactNode; children?: ReactNode; testId?: string }) {
  return (
    <div className="set-row" data-testid={testId}>
      <div className="set-row-text"><div className="set-row-title">{title}</div>{sub && <div className="set-row-sub">{sub}</div>}</div>
      {children && <div className="set-row-ctl">{children}</div>}
    </div>
  )
}

export function Toggle({ on, onChange, label, testId }: { on: boolean; onChange: (v: boolean) => void; label?: string; testId?: string }) {
  return <button role="switch" aria-checked={on} aria-label={label} className={`switch${on ? ' on' : ''}`} onClick={() => onChange(!on)} data-testid={testId}><i /></button>
}

/** A text box that saves when you press Enter or leave it. */
function Field({ value, onSave, placeholder, type = 'text', testId, width }: { value: string; onSave: (v: string) => void; placeholder?: string; type?: string; testId?: string; width?: number }) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  const commit = (): void => { if (v.trim() !== value) onSave(v.trim()) }
  return <input className="set-input" style={width ? { width } : undefined} type={type} value={v} placeholder={placeholder} spellCheck={false}
    onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} data-testid={testId} />
}

/** An API key: saved straight to the Keychain; shows only that one is saved. */
function KeyField({ saved, onSave, onTest, placeholder, testId }: { saved: boolean; onSave: (k: string | null) => Promise<void>; onTest?: (k?: string) => Promise<string>; placeholder: string; testId: string }) {
  const [editing, setEditing] = useState(!saved)
  const [v, setV] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  useEffect(() => setEditing(!saved), [saved])
  const save = async (): Promise<void> => {
    if (!v.trim()) return
    setMsg({ ok: true, text: 'Checking…' })
    const r = onTest ? await onTest(v.trim()) : 'ok'
    if (r !== 'ok') { setMsg({ ok: false, text: r }); return }
    await onSave(v.trim())
    setV('')
    setMsg({ ok: true, text: 'Saved' })
  }
  if (!editing) {
    return (
      <div className="key-saved" data-testid={`${testId}-saved`}>
        <span className="key-dots"><I.Check size={13} /> Saved in Keychain</span>
        {onTest && <button className="link-btn" onClick={() => { setMsg({ ok: true, text: 'Checking…' }); void onTest().then((r) => setMsg(r === 'ok' ? { ok: true, text: 'Working' } : { ok: false, text: r })) }}>Test</button>}
        <button className="link-btn" onClick={() => setEditing(true)}>Replace</button>
        <button className="link-btn danger" onClick={() => void onSave(null).then(() => setMsg(null))}>Remove</button>
        {msg && <span className={`conn ${msg.ok ? 'ok' : 'bad'}`}>{msg.text}</span>}
      </div>
    )
  }
  return (
    <div className="key-edit">
      <input className="set-input" type="password" value={v} placeholder={placeholder} autoComplete="off" spellCheck={false} data-testid={testId}
        onChange={(e) => { setV(e.target.value); setMsg(null) }} onKeyDown={(e) => e.key === 'Enter' && void save()} />
      <button className="btn" disabled={!v.trim()} onClick={() => void save()} data-testid={`${testId}-save`}>Save</button>
      {saved && <button className="link-btn" onClick={() => setEditing(false)}>Cancel</button>}
      {msg && <span className={`conn ${msg.ok ? 'ok' : 'bad'}`} data-testid={`${testId}-msg`}>{msg.text}</span>}
    </div>
  )
}

function Slider({ min, max, step = 1, value, onChange, left, right, mid }: { min: number; max: number; step?: number; value: number; onChange: (v: number) => void; left?: string; right?: string; mid?: string }) {
  return (
    <div className="set-slider">
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      {(left || right || mid) && <div className="set-slider-labels"><span>{left}</span><span>{mid}</span><span>{right}</span></div>}
    </div>
  )
}

const keyError = (e: string): string =>
  /401|403|unauthori|invalid.*key|rejected|authentication/i.test(e) ? 'The key was rejected. Check it and try again.'
    : /fetch failed|ECONNREFUSED|timeout|aborted|ENOTFOUND/i.test(e) ? 'Nothing answered at that address. Is the server running?' : e || 'Could not connect.'

// ------------------------------------------------------------------ the window

export function SettingsModal({ settings, models, sys, spaces, onClose, onSaved, onRefreshModels, initialPage }: {
  settings: Settings
  models: ModelList | null
  sys: SystemInfo | null
  spaces?: Space[]
  onClose: () => void
  onSaved: (s: Settings) => void
  onRefreshModels: () => void
  initialPage?: Page
}) {
  const [page, setPage] = useState<Page>(initialPage ?? 'general')
  const [find, setFind] = useState('')
  const pages = PAGES.filter((x) => !find.trim() || `${x.label} ${x.words}`.toLowerCase().includes(find.trim().toLowerCase()))
  const [s, setS] = useState(settings)
  const patch = async (p: SettingsPatchUi): Promise<Settings> => {
    const n = await api.settings.set(p)
    setS(n)
    onSaved(n)
    return n
  }
  useEffect(() => {
    const k = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])

  return (
    <div className="settings-page" data-testid="settings">
      <div className="settings-win">
        <nav className="set-nav">
          <div className="set-nav-top drag">
            <button className="icon-btn nodrag" onClick={onClose} title="Back (Esc)" data-testid="settings-close"><I.Chevron size={16} style={{ transform: 'rotate(90deg)' }} /></button>
            <span className="set-nav-title">Settings</span>
          </div>
          <div className="set-find nodrag"><I.Search size={14} /><input placeholder="Search settings" value={find} onChange={(e) => { setFind(e.target.value); const first = PAGES.find((x) => `${x.label} ${x.words}`.toLowerCase().includes(e.target.value.trim().toLowerCase())); if (first && e.target.value.trim()) setPage(first.id) }} /></div>
          {pages.map((p) => (
            <button key={p.id} className={`set-nav-item${page === p.id ? ' on' : ''}`} onClick={() => setPage(p.id)} data-testid={`settings-${p.id}`}><span className="set-tile" style={{ background: p.color }}>{p.icon}</span>{p.label}</button>
          ))}
          {sys && <div className="set-nav-foot">{sys.chip}<br />{sys.totalGB} GB RAM · SahilBot {sys.appVersion}</div>}
        </nav>
        <div className="set-body">
          {page === 'general' && <General s={s} patch={patch} />}
          {page === 'models' && <Models s={s} models={models} patch={patch} onRefresh={onRefreshModels} />}
          {page === 'keys' && <Keys s={s} patch={patch} onChanged={onRefreshModels} models={models} />}
          {page === 'appearance' && <AppearancePage s={s} patch={patch} />}
          {page === 'voice' && <VoicePage s={s} models={models} patch={patch} />}
          {page === 'memory' && <MemoryPage spaces={spaces ?? []} />}
          {page === 'rules' && <RulesPage spaces={spaces ?? []} />}
          {page === 'passwords' && <Passwords />}
          {page === 'advanced' && <Advanced s={s} models={models} patch={patch} />}
        </div>
      </div>
    </div>
  )
}

type P = { s: Settings; patch: (p: SettingsPatchUi) => Promise<Settings> }

function General({ s, patch }: P) {
  const [braveKey, setBraveKey] = useState('')
  const [spend, setSpend] = useState<{ spent: number; cap: number; requests: number } | null>(null)
  useEffect(() => void api.budget().then(setSpend), [])
  return (
    <>
      <h2>General</h2>
      <Section>
        <Row title="Your name" sub="What SahilBot calls you."><Field value={s.userName} placeholder="First name" onSave={(v) => void patch({ userName: v })} /></Row>
        <Row title="Quick Ask shortcut" sub="Opens a small SahilBot bar over any app: ask, optionally with your screen or clipboard.">
          <select className="set-select" value={s.quickKey} onChange={(e) => void patch({ quickKey: e.target.value })} data-testid="quick-key">
            <option value="Alt+Space">⌥ Space</option><option value="Control+Space">⌃ Space</option><option value="CommandOrControl+Shift+Space">⌘⇧ Space</option><option value="Alt+Shift+Space">⌥⇧ Space</option><option value="">Off</option>
          </select>
        </Row>
        <Row title="Workspace folder" sub="Where SahilBot saves the files it makes."><Field value={s.workspaceDir} width={300} onSave={(v) => void patch({ workspaceDir: v })} /></Row>
      </Section>
      <Section title="Web search" sub="Used to look things up before answering.">
        <Row title="Search provider">
          <select className="set-select" value={s.search.provider} onChange={(e) => void patch({ search: { ...s.search, provider: e.target.value as Settings['search']['provider'] } })}>
            <option value="auto">Automatic</option><option value="duckduckgo">DuckDuckGo (no key)</option><option value="brave">Brave Search API</option><option value="searxng">SearXNG</option><option value="none">Off</option>
          </select>
        </Row>
        {s.search.provider === 'brave' && (
          <Row title="Brave API key"><div className="key-edit">
            <input className="set-input" type="password" value={braveKey} onChange={(e) => setBraveKey(e.target.value)} placeholder={s.search.hasBraveKey ? '•••••••• saved' : 'Paste key'} />
            <button className="btn" disabled={!braveKey} onClick={() => void patch({ braveKey }).then(() => { setBraveKey(''); toast('Saved', 'ok') })}>Save</button>
          </div></Row>
        )}
        {s.search.provider === 'searxng' && <Row title="SearXNG address"><Field value={s.search.searxngUrl} placeholder="http://localhost:8888" onSave={(v) => void patch({ search: { ...s.search, searxngUrl: v } })} /></Row>}
      </Section>
      <Section title="Cloud" sub="Local models are free and private. Cloud models (Claude, GPT) are optional and capped by your monthly limit.">
        <Row title="Use cloud models" sub="Off: nothing is ever sent to a cloud model. Your keys stay saved."><Toggle on={s.cloud.enabled} onChange={(v) => void patch({ cloud: { ...s.cloud, enabled: v } })} label="Use cloud models" testId="cloud-enabled" /></Row>
        {s.cloud.enabled && (
          <>
            <Row title="Hybrid: local model asks the cloud for help" sub="Your local model does the work and can ask a cloud model for a plan, best practices, or help when it's stuck. Only a few short questions per request.">
              <Toggle on={s.cloud.hybrid} onChange={(v) => void patch({ cloud: { ...s.cloud, hybrid: v } })} label="Hybrid mode" testId="cloud-hybrid" />
            </Row>
            {s.cloud.hybrid && (
              <Row title="Questions per request" sub="The most times the local model may ask, per message you send.">
                <div className="stepper">
                  <button onClick={() => void patch({ cloud: { ...s.cloud, maxConsultsPerRequest: Math.max(1, s.cloud.maxConsultsPerRequest - 1) } })}>−</button>
                  <span>{s.cloud.maxConsultsPerRequest}</span>
                  <button onClick={() => void patch({ cloud: { ...s.cloud, maxConsultsPerRequest: Math.min(10, s.cloud.maxConsultsPerRequest + 1) } })}>+</button>
                </div>
              </Row>
            )}
          </>
        )}
      </Section>
      <Section title="Cloud spending limit" sub="SahilBot prices every cloud request before sending it and refuses anything that would go past this monthly cap. Requests the provider rejects aren't counted.">
        <Row title="Monthly cap" sub={spend ? `This month: $${spend.spent.toFixed(2)} of $${spend.cap.toFixed(2)} · ${spend.requests} cloud requests` : undefined}>
          <div className="key-edit"><span className="hint">$</span><Field value={String(s.cloudBudgetUsd)} width={90} type="number" testId="budget-cap" onSave={(v) => void patch({ cloudBudgetUsd: Math.max(0, Number(v) || 0) }).then(() => void api.budget().then(setSpend))} /></div>
        </Row>
      </Section>
    </>
  )
}

// ------------------------------------------------------------------ models

function modelName(m: ModelInfo): string { return m.label || m.id }

function Models({ s, models, patch, onRefresh }: P & { models: ModelList | null; onRefresh: () => void }) {
  const [q, setQ] = useState('')
  const [all, setAll] = useState(false)
  const [pull, setPull] = useState<Record<string, { pct: number; status: string; error?: string }>>({})
  useEffect(() => api.models.onPull((e) => {
    setPull((p) => ({ ...p, [e.tag]: { pct: e.total ? Math.round(((e.completed ?? 0) / e.total) * 100) : p[e.tag]?.pct ?? 0, status: e.status, error: e.error } }))
    if (e.done && !e.error) { toast(`${e.tag} is ready`, 'ok'); onRefresh() }
    if (e.error) toast(e.error, 'error')
  }), [onRefresh])

  const installed = (models?.models ?? []).filter((m) => m.installed)
  const recommended = (models?.models ?? []).filter((m) => !m.installed)
  const hidden = new Set(s.hiddenModels)
  const shown = installed.filter((m) => !q || `${m.id} ${m.label ?? ''} ${m.providerName}`.toLowerCase().includes(q.toLowerCase()))
  const list = all || q ? shown : shown.slice(0, 12)
  const setOn = (id: string, on: boolean): void => void patch(on
    ? { hiddenModels: s.hiddenModels.filter((x) => x !== id), shownModels: [...new Set([...s.shownModels, id])] }
    : { hiddenModels: [...new Set([...s.hiddenModels, id])], shownModels: s.shownModels.filter((x) => x !== id) }).then(onRefresh)
  const addModel = (): void => {
    const id = q.trim()
    if (!id || installed.some((m) => m.id === id)) return
    void patch({ customModels: [...new Set([...s.customModels, id])] }).then(() => { setQ(''); onRefresh(); toast(`Added ${id}`, 'ok') })
  }
  const usable = installed.filter((m) => !hidden.has(m.id) && (m.fits || m.maxFittingWindow >= 16384))

  return (
    <>
      <h2>Models</h2>
      <div className="set-sub" style={{ marginTop: -6 }}>Choose which models appear in the model picker. Auto uses the ones that are on.</div>
      <Section title="Default">
        <Row title="Model for new chats" sub="Auto picks the right model for each message: a fast one for quick chats, a stronger one for real tasks. When it isn't sure, it uses the stronger one.">
          <select className="set-select" value={s.defaultModel} onChange={(e) => void patch({ defaultModel: e.target.value })} data-testid="default-model">
            <option value="auto">Auto (recommended)</option>
            {usable.map((m) => <option key={m.id} value={m.id}>{modelName(m)}</option>)}
          </select>
        </Row>
      </Section>
      <Section title="Task models">
        <Row title="Voice conversations" sub="A light, fast model so spoken replies start right away.">
          <select className="set-select" value={s.taskModels.voice} onChange={(e) => void patch({ taskModels: { ...s.taskModels, voice: e.target.value } })} data-testid="voice-model">
            <option value="">Same as chat (Auto)</option>
            {usable.map((m) => <option key={m.id} value={m.id}>{modelName(m)} · {TIER[m.tier]}</option>)}
          </select>
        </Row>
        <Row title="Background jobs" sub="Chat titles and other tiny jobs. Always a local model.">
          <select className="set-select" value={s.taskModels.background} onChange={(e) => void patch({ taskModels: { ...s.taskModels, background: e.target.value } })}>
            <option value="">Smallest local model</option>
            {usable.filter((m) => m.note !== 'remote').map((m) => <option key={m.id} value={m.id}>{modelName(m)}</option>)}
          </select>
        </Row>
      </Section>

      <Section>
        <div className="set-search">
          <input className="set-input" placeholder="Add or search model" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addModel()} data-testid="model-search" />
          {q.trim() && !installed.some((m) => m.id === q.trim()) && <button className="btn" onClick={addModel}>Add “{q.trim()}”</button>}
          <button className="icon-btn" title="Refresh" onClick={onRefresh}><I.Reply size={15} style={{ transform: 'scaleX(-1)' }} /></button>
        </div>
        {!models && <div className="set-empty">Loading models…</div>}
        {models && installed.length === 0 && <div className="set-empty">No models yet. Download one below, or add an API key under API Keys & Servers.</div>}
        {list.map((m) => (
          <div className="set-row" key={m.id} data-testid="model-row">
            <div className="set-row-text">
              <div className="set-row-title">{modelName(m)}</div>
              <div className="set-row-sub">{m.providerName} · {TIER[m.tier]}{m.vision ? ' · sees images' : ''}{m.note === 'remote' ? ' · cloud' : m.requiredGB ? ` · ${m.requiredGB} GB` : ''}{!m.fits && m.note && m.note !== 'remote' ? ` · ${m.note}` : ''}</div>
            </div>
            <Toggle on={m.enabled} onChange={(v) => setOn(m.id, v)} label={`Show ${m.id}`} testId={`model-toggle-${m.id}`} />
          </div>
        ))}
        {!q && shown.length > 12 && <button className="link-btn set-more" onClick={() => setAll((x) => !x)}>{all ? 'Show fewer' : `View All Models (${shown.length})`}</button>}
        {s.customModels.length > 0 && (
          <div className="set-row-sub" style={{ padding: '8px 4px 2px' }}>Added by you: {s.customModels.map((id) => (
            <button key={id} className="chip-btn" style={{ marginLeft: 6 }} onClick={() => void patch({ customModels: s.customModels.filter((x) => x !== id) }).then(onRefresh)}>{id} ×</button>
          ))}</div>
        )}
      </Section>

      {recommended.length > 0 && (
        <Section title="Recommended downloads" sub="The best free model at each size, picked for agent work and tool use. Get the ones that fit this Mac; Auto starts using them right away.">
          {recommended.map((m) => {
            const pr = pull[m.id]
            const busy = pr && !pr.error && pr.status !== 'done'
            return (
              <div className="set-row" key={m.id} data-testid="recommended-row">
                <div className="set-row-text">
                  <div className="set-row-title">{modelName(m)} <span className="tier-badge">{TIER[m.tier]}</span></div>
                  <div className="set-row-sub">{m.blurb} · {m.note}</div>
                  {busy && <div className="meter" style={{ marginTop: 6 }}><i style={{ width: `${pr.pct}%` }} /></div>}
                </div>
                {busy ? <span className="hint">{pr.pct ? `${pr.pct}%` : pr.status}</span>
                  : <button className="btn" disabled={!m.fits && m.maxFittingWindow === 0} onClick={() => { setPull((p) => ({ ...p, [m.id]: { pct: 0, status: 'starting' } })); void api.models.pull(m.pull!) }} data-testid={`pull-${m.id}`}>Get</button>}
              </div>
            )
          })}
        </Section>
      )}
    </>
  )
}

// ------------------------------------------------------------------ keys & servers

function Keys({ s, patch, onChanged, models }: P & { onChanged: () => void; models: ModelList | null }) {
  // Status, not alarms: a server that isn't running is just "Not running".
  const status = (id: string): string | undefined => {
    const p = models?.providers?.find((x) => x.id === id)
    return p ? (p.ok ? `Running · ${p.count} model${p.count === 1 ? '' : 's'}` : 'Not running') : undefined
  }
  const [providers, setProviders] = useState<Array<{ id: string; keyUrl?: string }>>([])
  useEffect(() => void api.providers().then(setProviders), [])
  const link = (id: string): string | undefined => providers.find((p) => p.id === id)?.keyUrl
  const test = (baseUrl: string) => async (k?: string): Promise<string> => {
    const r = await api.models.test(baseUrl, k)
    return r.ok ? 'ok' : keyError(clean({ message: r.error ?? '' }))
  }
  const saveKey = (id: ProviderId) => async (k: string | null): Promise<void> => { await patch({ setKeys: { [id]: k } }); onChanged() }
  const openai = s.providers.openai.baseUrl.trim() || 'https://api.openai.com/v1'
  const [override, setOverride] = useState(!!s.providers.openai.baseUrl)
  const local = (id: 'ollama' | 'lmstudio', name: string, sub: string) => (
    <>
      <Row title={<>{name}{status(id) && <span className={`tier-badge${status(id)!.startsWith('Running') ? ' ok' : ''}`}>{status(id)}</span>}</>} sub={sub}><Toggle on={s.providers[id].enabled} onChange={(v) => void patch({ providers: { ...s.providers, [id]: { ...s.providers[id], enabled: v } } }).then(onChanged)} label={name} testId={`provider-${id}`} /></Row>
      {s.providers[id].enabled && <Row title="Address"><Field value={s.providers[id].baseUrl} width={260} testId={`${id}-url`} onSave={(v) => void patch({ providers: { ...s.providers, [id]: { ...s.providers[id], baseUrl: v } } }).then(onChanged)} /></Row>}
    </>
  )
  return (
    <>
      <h2>API Keys & Servers</h2>
      <Section title="Anthropic API Key" sub={<>Put in <a href={link('anthropic')} target="_blank" rel="noreferrer">your Anthropic key</a> to use Claude. It is used for every model whose name starts with "claude-". Spending is capped by your monthly budget.</>}>
        <Row title="API Key"><KeyField saved={s.keys.anthropic} placeholder="sk-ant-…" testId="key-anthropic" onSave={saveKey('anthropic')} onTest={test('https://api.anthropic.com/v1')} /></Row>
      </Section>
      <Section title="OpenAI API Key" sub={<>Put in <a href={link('openai')} target="_blank" rel="noreferrer">your OpenAI key</a> to use GPT models at cost.</>}>
        <Row title="API Key"><KeyField saved={s.keys.openai} placeholder="sk-…" testId="key-openai" onSave={saveKey('openai')} onTest={test(openai)} /></Row>
        <Row title="Override OpenAI Base URL" sub="Send OpenAI requests to another compatible gateway.">
          <Toggle on={override} onChange={(v) => { setOverride(v); if (!v) void patch({ providers: { ...s.providers, openai: { baseUrl: '' } } }).then(onChanged) }} label="Override OpenAI base URL" />
        </Row>
        {override && <Row title="Base URL"><Field value={s.providers.openai.baseUrl} width={280} placeholder="https://my-gateway.example.com/v1" onSave={(v) => void patch({ providers: { ...s.providers, openai: { baseUrl: v } } }).then(onChanged)} /></Row>}
      </Section>
      <Section title="OpenRouter API Key" sub={<>Put in <a href={link('openrouter')} target="_blank" rel="noreferrer">your OpenRouter key</a>, then add models by name (like "qwen/qwen3.8-27b") on the Models page.</>}>
        <Row title="API Key"><KeyField saved={s.keys.openrouter} placeholder="sk-or-…" testId="key-openrouter" onSave={saveKey('openrouter')} onTest={test('https://openrouter.ai/api/v1')} /></Row>
      </Section>
      <Section title="Cursor API Key" sub={<>Lets SahilBot start and manage <a href="https://cursor.com/dashboard" target="_blank" rel="noreferrer">Cursor cloud agents</a> on your GitHub repos (Cursor dashboard → API Keys). Opening files in Cursor and its agent on this Mac need no key.</>}>
        <Row title="API Key"><KeyField saved={s.hasCursorKey} placeholder="key_…" testId="key-cursor" onSave={async (k) => { await patch({ cursorKey: k }) }} /></Row>
      </Section>
      <Section title="Local servers" sub="Models on this Mac: private and free. SahilBot finds the models each server has, and runs MLX builds on Apple silicon automatically.">
        {local('ollama', 'Ollama', 'Usually http://localhost:11434/v1')}
        {local('lmstudio', 'LM Studio', 'Start the server in LM Studio’s Developer tab. Usually http://localhost:1234/v1')}
        {s.providers.lmstudio.enabled && <Row title="LM Studio API key" sub="Only if you turned on “Require API key” in LM Studio."><KeyField saved={s.keys.lmstudio} placeholder="Optional" testId="key-lmstudio" onSave={saveKey('lmstudio')} onTest={test(s.providers.lmstudio.baseUrl)} /></Row>}
        <Row title="Custom server" sub="Any OpenAI-compatible server: llama.cpp, vLLM, another Mac on your network.">
          <Toggle on={s.providers.custom.enabled} onChange={(v) => void patch({ providers: { ...s.providers, custom: { ...s.providers.custom, enabled: v } } }).then(onChanged)} label="Custom server" testId="provider-custom" />
        </Row>
        {s.providers.custom.enabled && (
          <>
            <Row title="Name"><Field value={s.providers.custom.name} onSave={(v) => void patch({ providers: { ...s.providers, custom: { ...s.providers.custom, name: v || 'Custom server' } } })} /></Row>
            <Row title="Base URL"><Field value={s.providers.custom.baseUrl} width={260} testId="custom-url" onSave={(v) => void patch({ providers: { ...s.providers, custom: { ...s.providers.custom, baseUrl: v } } }).then(onChanged)} /></Row>
            <Row title="API key" sub="Leave empty if it has none."><KeyField saved={s.keys.custom} placeholder="Optional" testId="key-custom" onSave={saveKey('custom')} onTest={test(s.providers.custom.baseUrl)} /></Row>
          </>
        )}
      </Section>
    </>
  )
}

// ------------------------------------------------------------------ appearance

function AppearancePage({ s, patch }: P) {
  const a = s.appearance
  const set = (p: Partial<Settings['appearance']>): void => void patch({ appearance: { ...a, ...p } })
  return (
    <>
      <h2>Appearance</h2>
      <Section>
        <Row title="Theme" sub="Light, dark, or follow your Mac.">
          <select className="set-select" value={s.theme} onChange={(e) => void patch({ theme: e.target.value as Settings['theme'] })}>
            <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
          </select>
        </Row>
      </Section>
      <Section title="Conversations">
        <Row title="Tool call density" sub="How much detail is shown for the agent's steps.">
          <Slider min={0} max={1} value={a.density === 'detailed' ? 1 : 0} onChange={(v) => set({ density: v ? 'detailed' : 'compact' })} left="Compact" right="Detailed" />
        </Row>
        <Row title="Chat width" sub="The maximum width of conversations.">
          <Slider min={600} max={1200} step={20} value={a.chatWidth} onChange={(v) => set({ chatWidth: v })} left="Narrow" mid={`${a.chatWidth}px`} right="Wide" />
        </Row>
        <Row title="Code block word wrap" sub="Wrap long lines in code blocks."><Toggle on={a.codeWrap} onChange={(v) => set({ codeWrap: v })} label="Code word wrap" /></Row>
      </Section>
      <Section title="Colors">
        <Row title="Hue" sub="Choose a tint color.">
          <div className="hue-row"><Slider min={0} max={360} value={a.hue} onChange={(v) => set({ hue: v, tint: a.tint || 30 })} /><span className="hue-swatch" style={{ background: `hsl(${a.hue} 70% 55%)` }} /></div>
        </Row>
        <Row title="Intensity" sub="How strongly the tint is applied.">
          <div className="hue-row"><Slider min={0} max={100} value={a.tint} onChange={(v) => set({ tint: v })} /><span className="hint" style={{ width: 36, textAlign: 'right' }}>{a.tint}%</span></div>
        </Row>
        <Row title="Reduce transparency" sub="Use solid backgrounds instead of see-through ones."><Toggle on={a.reduceTransparency} onChange={(v) => set({ reduceTransparency: v })} label="Reduce transparency" /></Row>
      </Section>
      <Section title="Typography">
        <Row title="UI font size">
          <div className="stepper">
            <button onClick={() => set({ fontSize: Math.max(12, a.fontSize - 1) })} aria-label="Smaller">−</button>
            <span>{a.fontSize}</span>
            <button onClick={() => set({ fontSize: Math.min(20, a.fontSize + 1) })} aria-label="Larger">+</button>
          </div>
        </Row>
      </Section>
    </>
  )
}

// ------------------------------------------------------------------ voice

function VoicePage({ s, models, patch }: P & { models: ModelList | null }) {
  const [voice, setVoice] = useState<VoiceStatus | null>(null)
  const [dl, setDl] = useState<Record<string, { progress: number; error?: string }>>({})
  useEffect(() => {
    void api.voice.status().then(setVoice)
    return api.voice.onEvent((e) => {
      if (e.type !== 'download') return
      setDl((d) => ({ ...d, [e.kind]: { progress: e.progress, error: e.error } }))
      if (e.done) void api.voice.status().then(setVoice)
    })
  }, [])
  const usable = (models?.models ?? []).filter((m) => m.installed && m.enabled)
  return (
    <>
      <h2>Voice</h2>
      <div className="set-sub" style={{ marginTop: -6 }}>Dictation, read-aloud and voice conversations run on this Mac (Whisper listens, Kokoro speaks).</div>
      <Section title="Speaking">
        <Row title="Read replies aloud" sub="Speak every reply as it arrives. You can also press the speaker button on any message."><Toggle on={s.speakReplies} onChange={(v) => void patch({ speakReplies: v })} label="Read replies aloud" testId="speak-replies" /></Row>
        {voice && (
          <Row title="Voice">
            <div className="key-edit">
              <select className="set-select" value={voice.voice} onChange={(e) => { void api.voice.setVoice(e.target.value); setVoice({ ...voice, voice: e.target.value }) }}>
                {[['af_heart', 'Heart'], ['af_bella', 'Bella'], ['af_nicole', 'Nicole'], ['af_sky', 'Sky'], ['am_michael', 'Michael'], ['am_adam', 'Adam'], ['bf_emma', 'Emma (UK)'], ['bm_george', 'George (UK)']].map(([v, n]) => <option key={v} value={v}>{n}</option>)}
              </select>
              <button className="btn" onClick={() => void api.voice.speak(`Hi${s.userName ? ` ${s.userName}` : ''}, this is how I sound.`)}>Try it</button>
            </div>
          </Row>
        )}
        <Row title="Model for voice conversations" sub="A light model answers faster.">
          <select className="set-select" value={s.taskModels.voice} onChange={(e) => void patch({ taskModels: { ...s.taskModels, voice: e.target.value } })}>
            <option value="">Same as chat (Auto)</option>
            {usable.map((m) => <option key={m.id} value={m.id}>{m.label || m.id} · {TIER[m.tier]}</option>)}
          </select>
        </Row>
      </Section>
      <Section title="Voice models">
        {voice && ([
          ['whisper', 'Speech recognition (Whisper large-v3-turbo)', voice.whisper, voice.sizes.whisper],
          ['vad', 'Voice detection (Silero)', voice.vad, voice.sizes.vad],
          ['kokoro', 'Natural voice (Kokoro-82M)', voice.kokoro, voice.sizes.kokoro]
        ] as const).map(([k, label, ok, mb]) => (
          <Row key={k} title={label} sub={`${mb} MB${dl[k]?.error ? ` · ${dl[k].error}` : ''}`}>
            {ok ? <span className="conn ok"><I.Check size={13} /> Ready</span> : dl[k] && !dl[k].error && dl[k].progress < 1
              ? <span className="hint">{Math.round(dl[k].progress * 100)}%</span>
              : <button className="btn" onClick={() => { setDl((d) => ({ ...d, [k]: { progress: 0.01 } })); void api.voice.download(k) }}>Download</button>}
          </Row>
        ))}
        {voice && !voice.binary && <Row title="Speech recognition isn't built" sub="Run scripts/voice-setup.sh once." />}
      </Section>
      <div className="set-sub">Shortcuts: ⌘⇧D dictates into the message box; ⌘⇧V starts a voice conversation; Esc stops speaking.</div>
    </>
  )
}

// ------------------------------------------------------------------ memory bank

function MemoryPage({ spaces }: { spaces: Space[] }) {
  const [mem, setMem] = useState<MemoryItem[]>([])
  const [adding, setAdding] = useState('')
  const reload = (): void => { void api.memory.list().then(setMem) }
  useEffect(reload, [])
  const projects = spaces.filter((x) => x.kind === 'project')
  const about = mem.filter((m) => !m.projectId)
  const byProject = useMemo(() => projects.map((p) => ({ p, items: mem.filter((m) => m.projectId === p.id) })).filter((x) => x.items.length), [mem, projects])

  const row = (m: MemoryItem) => (
    <div className="set-row" key={m.id} data-testid="memory-row">
      <div className="set-row-text"><div className="set-row-title mem-text" contentEditable suppressContentEditableWarning
        onBlur={(e) => { const t = e.currentTarget.textContent?.trim() ?? ''; if (t && t !== m.content) void api.memory.update(m.id, t).then(reload) }}>{m.content}</div>
        <div className="set-row-sub">{m.category} · {new Date(m.updatedAt).toLocaleDateString()}</div></div>
      <button className="icon-btn" title="Forget" onClick={() => void api.memory.remove(m.id).then(reload)}><I.Trash size={14} /></button>
    </div>
  )

  return (
    <>
      <h2>Memory</h2>
      <div className="set-sub" style={{ marginTop: -6 }}>What SahilBot remembers: you, the people and places in your life, your projects. Everything stays on this Mac. Click a memory to edit it.</div>
      <Section title="About you" sub="Shared by every chat, whichever model you use. SahilBot saves these as you talk.">
        {about.length === 0 && <div className="set-empty">Nothing yet.</div>}
        {(['profile', 'work', 'preference', 'person', 'location', 'project', 'trip', 'link', 'date', 'other'] as const).map((c) => {
          const items = about.filter((m) => (m.category || 'other') === c)
          if (!items.length) return null
          return (
            <div key={c}>
              <div className="mem-cat">{({ profile: 'You', work: 'Work', preference: 'Preferences', person: 'People', location: 'Places', project: 'Projects', trip: 'Trips', link: 'Links', date: 'Dates', other: 'Other' } as Record<string, string>)[c]}</div>
              {items.map(row)}
            </div>
          )
        })}
        {about.filter((m) => !['profile', 'work', 'preference', 'person', 'location', 'project', 'trip', 'link', 'date', 'other'].includes(m.category)).map(row)}
        <div className="set-search">
          <input className="set-input" placeholder="Add something SahilBot should know about you" value={adding} onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && adding.trim()) void api.memory.add(adding.trim(), null).then(() => { setAdding(''); reload() }) }} data-testid="memory-add" />
        </div>
      </Section>
      {byProject.map(({ p, items }) => (
        <Section key={p.id} title={`Project: ${p.name}`} sub="Shared by every chat in this project.">{items.map(row)}</Section>
      ))}
    </>
  )
}

// ------------------------------------------------------------------ rules & skills

function RulesPage({ spaces }: { spaces: Space[] }) {
  const [rules, setRules] = useState<Rule[]>([])
  const [skills, setSkills] = useState<Skill[]>([])
  const [newRule, setNewRule] = useState({ name: '', text: '', scope: 'everywhere' })
  const [edit, setEdit] = useState<{ name: string; description: string; body: string; isNew: boolean } | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const reload = (): void => { void api.rules.list().then(setRules); void api.skills.list().then(setSkills) }
  useEffect(reload, [])
  const scopeName = (sc: string): string => sc === 'everywhere' ? 'All chats' : sc.startsWith('bot:') ? `Bot: ${spaces.find((x) => x.id === sc.slice(4))?.name ?? 'removed'}` : `Project: ${spaces.find((x) => x.id === sc.slice(8))?.name ?? 'removed'}`
  const cats = [...new Set(rules.map((r) => r.category))]
  const skillCats = [...new Set(skills.map((k) => k.source === 'builtin' ? k.category ?? 'Built in' : k.source === 'learned' ? 'Learned by SahilBot' : 'Yours'))]
  const catOf = (k: Skill): string => k.source === 'builtin' ? k.category ?? 'Built in' : k.source === 'learned' ? 'Learned by SahilBot' : 'Yours'
  return (
    <>
      <h2>Rules & Skills</h2>
      <div className="set-sub" style={{ marginTop: -6 }}>Rules are instructions SahilBot always follows. Skills are step-by-step procedures it reads when a task calls for one. Both come in built-in packs; you and your bots can add more. Changes apply to new chats.</div>
      {cats.map((c) => (
        <Section key={c} title={`Rules · ${c}`}>
          {rules.filter((r) => r.category === c).map((r) => (
            <div className="set-row" key={r.name} data-testid="rule-row">
              <div className="set-row-text">
                <div className="set-row-title">{r.name.replace(/-/g, ' ')} <span className="tier-badge">{r.source === 'builtin' ? 'built in' : r.source === 'learned' ? 'learned' : 'yours'}</span>{r.scope !== 'everywhere' && <span className="tier-badge">{scopeName(r.scope)}</span>}</div>
                <div className="set-row-sub">{r.text}</div>
              </div>
              {r.source !== 'builtin' && <button className="icon-btn" title="Delete rule" onClick={() => void api.rules.remove(r.name).then(reload)}><I.Trash size={14} /></button>}
              <Toggle on={r.enabled} onChange={(v) => void api.rules.setEnabled(r.name, v).then(reload)} label={r.name} />
            </div>
          ))}
        </Section>
      ))}
      <Section title="Add a rule">
        <div className="vault-add">
          <input className="set-input" placeholder="Short name" value={newRule.name} onChange={(e) => setNewRule({ ...newRule, name: e.target.value })} />
          <select className="set-select" value={newRule.scope} onChange={(e) => setNewRule({ ...newRule, scope: e.target.value })}>
            <option value="everywhere">All chats</option>
            {spaces.filter((x) => !x.isMain).map((x) => <option key={x.id} value={`${x.kind === 'project' ? 'project' : 'bot'}:${x.id}`}>{x.kind === 'project' ? 'Project' : 'Bot'}: {x.name}</option>)}
          </select>
        </div>
        <textarea className="set-input" rows={2} placeholder='e.g. "Always write emails in a warm, short style and sign them Sahil."' value={newRule.text} onChange={(e) => setNewRule({ ...newRule, text: e.target.value })} data-testid="rule-text" />
        <div className="set-search"><button className="btn" disabled={!newRule.name.trim() || !newRule.text.trim()} onClick={() => void api.rules.save(newRule).then(() => { setNewRule({ name: '', text: '', scope: 'everywhere' }); reload() })} data-testid="rule-save">Add rule</button></div>
      </Section>
      {skillCats.map((c) => (
        <Section key={c} title={`Skills · ${c}`}>
          {skills.filter((k) => catOf(k) === c).map((k) => (
            <div key={k.name} data-testid="skill-row">
              <div className="set-row">
                <div className="set-row-text" style={{ cursor: 'pointer' }} onClick={() => setOpen(open === k.name ? null : k.name)}>
                  <div className="set-row-title">{k.name.replace(/-/g, ' ')}</div>
                  <div className="set-row-sub">{k.description}{k.uses ? ` · used ${k.uses}×` : ''}</div>
                </div>
                <button className="link-btn" onClick={() => setEdit({ name: k.name, description: k.description, body: k.body, isNew: false })}>{k.source === 'builtin' ? 'Customize' : 'Edit'}</button>
                {k.source !== 'builtin' && <button className="icon-btn" title="Delete skill" onClick={() => { if (confirm(`Delete the skill "${k.name}"?`)) void api.skills.remove(k.name).then(reload) }}><I.Trash size={14} /></button>}
              </div>
              {open === k.name && <pre className="skill-body">{k.body}</pre>}
            </div>
          ))}
        </Section>
      ))}
      <div className="set-search"><button className="btn" onClick={() => setEdit({ name: '', description: '', body: '1. ', isNew: true })} data-testid="skill-new">New skill</button></div>
      {edit && (
        <div className="skill-editor" data-testid="skill-editor">
          <input className="set-input" placeholder="name-with-dashes" value={edit.name} disabled={!edit.isNew} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
          <input className="set-input" placeholder="When to use it (one sentence)" value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} />
          <textarea className="set-input" rows={10} placeholder="Steps" value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} />
          <div className="modal-actions">
            <button className="btn" onClick={() => setEdit(null)}>Cancel</button>
            <button className="btn primary" disabled={!edit.name.trim() || !edit.description.trim() || !edit.body.trim()}
              onClick={() => void api.skills.save(edit).then(() => { setEdit(null); reload() }).catch((e) => toast(clean(e), 'error'))}>Save skill</button>
          </div>
        </div>
      )}
    </>
  )
}

// ------------------------------------------------------------------ passwords

function Passwords() {
  const [vault, setVault] = useState<VaultEntry[]>([])
  const [draft, setDraft] = useState({ name: '', origin: '', username: '', password: '' })
  const [err, setErr] = useState('')
  useEffect(() => void api.vault.list().then(setVault), [])
  return (
    <>
      <h2>Passwords</h2>
      <Section sub="Logins SahilBot can type into a site without ever seeing them. Stored encrypted in your Keychain, only for the site they belong to.">
        {vault.length === 0 && <div className="set-empty">No saved logins.</div>}
        {vault.map((v) => (
          <div className="set-row" key={v.name} data-testid="vault-row">
            <div className="set-row-text"><div className="set-row-title">{v.name}</div><div className="set-row-sub">{v.username} · {v.origin}</div></div>
            <button className="icon-btn" title="Remove" onClick={() => void api.vault.remove(v.name).then(setVault)}><I.Trash size={14} /></button>
          </div>
        ))}
      </Section>
      <Section title="Add a login">
        <div className="vault-add">
          <input className="set-input" placeholder="Name (e.g. github)" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <input className="set-input" placeholder="Site (github.com)" value={draft.origin} onChange={(e) => setDraft({ ...draft, origin: e.target.value })} />
          <input className="set-input" placeholder="Username" value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} autoComplete="off" />
          <input className="set-input" placeholder="Password" type="password" value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} autoComplete="new-password" />
          <button className="btn" onClick={() => { setErr(''); void api.vault.set(draft).then((v) => { setVault(v); setDraft({ name: '', origin: '', username: '', password: '' }) }).catch((e) => setErr(clean(e))) }}>Save login</button>
        </div>
        {err && <div className="set-empty" style={{ color: 'var(--danger)' }}>{err}</div>}
      </Section>
    </>
  )
}

// ------------------------------------------------------------------ advanced

/** macOS lets the GPU use about 75% of memory; local models can use up to 90% when this is on. */
function GpuRow() {
  const [g, setG] = useState<{ totalGB: number; limitMB: number } | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => void api.models.gpu().then(setG), [])
  if (!g) return null
  const pct = g.limitMB ? Math.round((g.limitMB / 1024 / g.totalGB) * 100) : 75
  const set = (percent: number, keep: boolean): void => {
    setBusy(true)
    void api.models.setGpuLimit(percent, keep).then((r) => { setG({ ...g, limitMB: r.limitMB }); toast(percent ? 'Local models can now use up to 90% of memory' : 'Back to the macOS default', 'ok') })
      .catch((e) => toast(clean(e), 'error')).finally(() => setBusy(false))
  }
  return (
    <Row title="GPU memory for local models" sub={`Now: about ${pct}% of ${g.totalGB} GB. Raising it to 90% lets bigger models and longer contexts run on Apple silicon. macOS asks for your password; leave enough for your other apps.`}>
      <div className="key-edit">
        {g.limitMB ? <button className="btn" disabled={busy} onClick={() => set(0, false)}>Reset</button> : null}
        <button className="btn" disabled={busy} onClick={() => set(90, true)} data-testid="gpu-90">Use 90%</button>
      </div>
    </Row>
  )
}

function Advanced({ s, models, patch }: P & { models: ModelList | null }) {
  const [samplingModel, setSamplingModel] = useState(s.defaultModel === 'auto' ? models?.models.find((m) => m.installed)?.id ?? '' : s.defaultModel)
  const sampling = s.sampling[samplingModel] ?? {}
  const setSampling = (k: keyof Sampling, v: string): void => {
    const next = { ...sampling }
    if (v === '') delete next[k]
    else next[k] = Number(v)
    void patch({ sampling: { ...s.sampling, [samplingModel]: next } })
  }
  return (
    <>
      <h2>Advanced</h2>
      <Section>
        <Row title="Context window" sub="How much of the conversation a local model holds. Auto uses the most this Mac's memory allows for each model (agents get the room they need). Older turns are summarized only when it's almost full.">
          <div className="seg">{WINDOWS.map((w) => <button key={w} className={s.contextWindow === w ? 'on' : ''} onClick={() => void patch({ contextWindow: w })}>{w ? `${w / 1024}k` : 'Auto'}</button>)}</div>
        </Row>
        <GpuRow />
        <Row title="Hard stops in Bypass" sub="Always ask before payments, typing credentials, account or security settings, and permanent deletes.">
          <Toggle on={s.advanced.hardStopsEnabled} onChange={(v) => void patch({ advanced: { hardStopsEnabled: v } })} label="Hard stops" />
        </Row>
      </Section>
      <Section title="Sampling" sub="Blank fields use the model card's recommended values.">
        <Row title="For model">
          <select className="set-select" value={samplingModel} onChange={(e) => setSamplingModel(e.target.value)}>
            {(models?.models ?? []).filter((m) => m.installed).map((m) => <option key={m.id} value={m.id}>{m.label || m.id}</option>)}
          </select>
        </Row>
        {SAMPLING_KEYS.map((k) => (
          <Row key={`${samplingModel}-${k}`} title={k}><Field value={sampling[k] === undefined ? '' : String(sampling[k])} width={110} type="number" placeholder="model card" onSave={(v) => setSampling(k, v)} /></Row>
        ))}
      </Section>
    </>
  )
}
