import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ComputerUseSetting } from './ComputerUseSetting'
import type { ModelInfo, ModelList, ProviderId, Rule, Sampling, Settings, Skill, Space, SystemInfo, VoiceStatus } from '@shared/types'
import { api, isServerRuntime } from '../api'
import * as I from '../icons'
import { toast } from '../lib/toast'
import { Toggle } from './Toggle'
import { ModelContextSelect } from './ModelContextSelect'
import { recommendedRows } from '@shared/model-picker'
import { MemoryManager } from './MemoryManager'
import { VaultSettings } from './VaultView'
import { SecretVaultSettings } from './VaultSettings'
import { KnowledgeSettings } from './KnowledgeSettings'
import { UsagePage } from './UsagePage'
import { SpendingLimitSection } from './SpendingLimit'
import { FastModeSection, XaiSection } from './FastModeSettings'
import { McpSettings } from './McpSettings'
import { ChatgptPlanSettings } from './ChatgptPlanSettings'
// Local models are opt-in: one quiet row when they're off, no download prompts (components/LocalModels.tsx).
import { LocalModelsRow, VoiceInputNote, VoiceOutputRow, localIsOn } from './LocalModels'
import { ActivitySettings } from './ActivitySettings'
import { AlwaysOnServerPage, ServerPage } from './ServerSettings'
import { ClampText, Disclosure } from './ui'
import { addRule, loadRules, removeRule, RULE_LIMIT, RULE_MAX_CHARS } from '../lib/approvalRules'
import '../styles-approvals.css'
import '../styles-purchase.css'

// Settings: one page per topic. Every change saves right away (keys go to the Keychain).

type Page = 'general' | 'usage' | 'models' | 'keys' | 'appearance' | 'voice' | 'memory' | 'knowledge' | 'rules' | 'approvals' | 'passwords' | 'privacy' | 'advanced' | 'server'
const PAGES: Array<{ id: Page; label: string; icon: ReactNode; color: string; words: string }> = [
  { id: 'general', label: 'General', icon: <I.Gear size={14} />, color: '#8e8e93', words: 'name workspace folder quick ask shortcut search cloud budget spending limit hybrid' },
  { id: 'usage', label: 'Usage', icon: <I.Clock size={14} />, color: '#ff6a1a', words: 'usage spend spending cost cap budget tokens requests local cloud model bot csv export' },
  { id: 'models', label: 'Models', icon: <I.Cpu size={14} />, color: '#5856d6', words: 'model auto download recommended voice background ollama lm studio chatgpt plan subscription codex sign in' },
  { id: 'keys', label: 'API Keys & Servers', icon: <I.Plug size={14} />, color: '#007aff', words: 'anthropic claude openai openrouter cursor key base url ollama lm studio custom server onshape cad' },
  { id: 'appearance', label: 'Appearance', icon: <I.Sparkle size={14} />, color: '#ff9500', words: 'theme dark light width font tint density code wrap' },
  { id: 'voice', label: 'Voice', icon: <I.Mic size={14} />, color: '#ff2d55', words: 'speak read aloud dictation whisper kokoro' },
  { id: 'memory', label: 'Memory', icon: <I.ListIcon size={14} />, color: '#34c759', words: 'remember people places projects facts import chatgpt claude gemini another ai forget work log vault obsidian notes knowledge' },
  { id: 'knowledge', label: 'Knowledge', icon: <I.Search size={14} />, color: '#0a84ff', words: 'knowledge search files folders documents index pdf notes embeddings rebuild' },
  { id: 'rules', label: 'Rules & Skills', icon: <I.Check size={14} />, color: '#30b0c7', words: 'rules skills procedures engineering medical business coding' },
  { id: 'approvals', label: 'Approval rules', icon: <I.Shield size={14} />, color: '#34aadc', words: 'approval approve allow ask first permission always automatically confirm' },
  { id: 'passwords', label: 'Vault', icon: <I.Key size={14} />, color: '#636366', words: 'vault passwords login card credit id passport license secure note master password touch id lock backup export import csv' },
  { id: 'privacy', label: 'Privacy & Permissions', icon: <I.Shield size={14} />, color: '#5ac8fa', words: 'privacy permissions accessibility screen recording microphone full disk access automation notifications macos system settings mcp connected apps cursor claude code desktop token server' },
  { id: 'advanced', label: 'Advanced', icon: <I.Edit size={14} />, color: '#af52de', words: 'context window gpu memory sampling hard stops' },
  // SahilBot Server: devices, pairing, notifications, audit (web UI); in the Mac app, the link to a server.
  { id: 'server', label: isServerRuntime ? 'Server' : 'Always-on server', icon: <I.Plug size={14} />, color: '#1f8a5b', words: 'server raspberry pi always on remote phone devices pairing tailscale notifications audit' }
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
      <div className="set-row-text"><div className="set-row-title">{title}</div>{sub && <ClampText>{sub}</ClampText>}</div>
      {children && <div className="set-row-ctl">{children}</div>}
    </div>
  )
}

// Re-exported for anything that still imports it from here; it lives in its own module (see Toggle.tsx).
export { Toggle }

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
  const pages = PAGES.filter((x) => !isServerRuntime || (x.id !== 'voice' && x.id !== 'privacy')).filter((x) => !find.trim() || `${x.label} ${x.words}`.toLowerCase().includes(find.trim().toLowerCase()))
  const [s, setS] = useState(settings)
  const patch = async (p: SettingsPatchUi): Promise<Settings> => {
    const n = await api.settings.set(p)
    setS(n)
    onSaved(n)
    return n
  }
  useEffect(() => {
    // preventDefault: this Esc is spent closing Settings (the chat's run and the details panel leave it alone).
    const k = (e: KeyboardEvent): void => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); onClose() } }
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
          {page === 'usage' && <UsagePage />}
          {page === 'models' && <Models s={s} models={models} patch={patch} onRefresh={onRefreshModels} />}
          {page === 'keys' && <Keys s={s} patch={patch} onChanged={onRefreshModels} models={models} />}
          {page === 'appearance' && <AppearancePage s={s} patch={patch} />}
          {page === 'voice' && <VoicePage s={s} models={models} patch={patch} />}
          {page === 'memory' && <MemoryPage spaces={spaces ?? []} />}
          {page === 'knowledge' && <KnowledgeSettings />}
          {page === 'rules' && <RulesPage spaces={spaces ?? []} />}
          {page === 'approvals' && <ApprovalRulesPage patch={patch} />}
          {page === 'passwords' && <SecretVaultSettings />}
          {page === 'privacy' && <PrivacyPage />}
          {page === 'advanced' && <Advanced s={s} models={models} patch={patch} />}
          {page === 'server' && (isServerRuntime ? <ServerPage /> : <AlwaysOnServerPage />)}
        </div>
      </div>
    </div>
  )
}

type P = { s: Settings; patch: (p: SettingsPatchUi) => Promise<Settings> }

const CATCH_UP = [[0, 'Off'], [1, '1 hour'], [6, '6 hours'], [12, '12 hours'], [24, '1 day'], [72, '3 days'], [168, '1 week']] as const

/** Menu bar, login, keep-awake and missed routines: SahilBot keeps working when the window is closed. */
function AlwaysOn({ s, patch }: P) {
  const [login, setLogin] = useState<string | null>(null)
  useEffect(() => void api.alwaysOn.status().then((st) => setLogin(st.loginItem)), [s.openAtLogin])
  const loginHint = login === 'requires-approval' ? 'Allow SahilBot in System Settings → General → Login Items.'
    : login === 'unsupported' ? 'Works in the installed app.' : 'Starts in the menu bar with the window hidden.'
  return (
    <Section title="Always on" sub="Closing the window doesn't stop SahilBot: bots keep working and routines keep running until you quit.">
      <Row title="Show SahilBot in the menu bar" sub="See which bots are working or need you, from any app."><Toggle on={s.menuBarIcon ?? true} onChange={(v) => void patch({ menuBarIcon: v })} label="Show SahilBot in the menu bar" testId="menu-bar-icon" /></Row>
      <Row title="Open at login" sub={loginHint}><Toggle on={s.openAtLogin ?? false} onChange={(v) => void patch({ openAtLogin: v })} label="Open at login" testId="open-at-login" /></Row>
      <Row title="Keep the Mac awake while bots work" sub="Only while a chat or routine is running. Closing the lid still sleeps."><Toggle on={s.keepAwakeWhileWorking ?? true} onChange={(v) => void patch({ keepAwakeWhileWorking: v })} label="Keep the Mac awake while bots work" testId="keep-awake" /></Row>
      <Row title="Catch up on missed routines" sub="If SahilBot was closed or the Mac was asleep, each missed routine runs once if it was due within this window.">
        <select className="set-select" value={s.catchUpHours ?? 12} onChange={(e) => void patch({ catchUpHours: Number(e.target.value) })} data-testid="catch-up">
          {CATCH_UP.map(([h, label]) => <option key={h} value={h}>{label}</option>)}
        </select>
      </Row>
      <Row title="Pause all routines" sub="Nothing runs on a schedule until you turn this off."><Toggle on={s.routinesPaused ?? false} onChange={(v) => void patch({ routinesPaused: v })} label="Pause all routines" testId="routines-paused" /></Row>
    </Section>
  )
}

const PERM_BADGE: Record<string, string> = { granted: 'Allowed', denied: 'Not allowed', 'not-determined': 'Not set', unknown: 'Unknown' }
const AUTOMATION_APPS = ['Notes', 'Calendar', 'Reminders', 'Mail', 'Finder', 'Music']

/** What macOS lets SahilBot do, and one click to the exact System Settings pane. Nothing is granted from here. */
function PrivacyPage() {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof api.permissions.status>> | null>(null)
  const [app, setApp] = useState(AUTOMATION_APPS[0])
  const [auto, setAuto] = useState<{ app: string; state: string; detail?: string } | null>(null)
  const refresh = (): void => void api.permissions.status().then(setRows).catch(() => setRows([]))
  useEffect(() => {
    refresh()
    // Back from System Settings: show the new state.
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])
  return (
    <>
      <h2>Privacy &amp; Permissions</h2>
      <p className="hint">macOS decides what SahilBot can reach. Only you can turn these on, in System Settings; SahilBot asks before it uses any of them for a task.</p>
      <Section>
        {rows === null ? <Row title="Checking…" /> : rows.filter((r) => r.kind !== 'automation').map((r) => (
          <Row key={r.kind} title={<>{r.title}<span className={`tier-badge${r.state === 'granted' ? ' ok' : ''}`}>{PERM_BADGE[r.state] ?? r.state}</span></>} sub={<>{r.enables}{r.detail ? <> · {r.detail}</> : null}</>} testId={`perm-${r.kind}`}>
            <button className="btn" onClick={() => void api.permissions.open(r.kind)} title={r.how}>Open Settings</button>
          </Row>
        ))}
      </Section>
      <Section title="Automation" sub="Lets SahilBot control another app (Notes, Calendar, Mail…) when a task needs it. macOS asks once per app.">
        <Row title="Check an app" sub={auto ? `${auto.app}: ${PERM_BADGE[auto.state] ?? auto.state}${auto.detail ? ` · ${auto.detail}` : ''}` : 'Checking may show macOS\'s one-time prompt for that app.'}>
          <div className="key-edit">
            <select className="set-select" value={app} onChange={(e) => { setApp(e.target.value); setAuto(null) }} data-testid="perm-auto-app">
              {AUTOMATION_APPS.map((a) => <option key={a}>{a}</option>)}
            </select>
            <button className="btn" onClick={() => void api.permissions.automation(app).then(setAuto).catch((e) => setAuto({ app, state: 'unknown', detail: clean(e) }))} data-testid="perm-auto-check">Check</button>
            <button className="btn" onClick={() => void api.permissions.open('automation')}>Open Settings</button>
          </div>
        </Row>
      </Section>
      <ActivitySettings />
      <McpSettings />
    </>
  )
}

function General({ s, patch }: P) {
  const [braveKey, setBraveKey] = useState('')
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
      {/* Cloud first: with local models off, cloud models are the only ones, and Hybrid (a local model asking the cloud) doesn't apply. */}
      <Section title="Cloud" sub={localIsOn(s) ? 'Local models are free and private. Cloud models (Claude, GPT) are optional and capped by your monthly limit.' : 'Cloud models (Claude, GPT, Grok, your ChatGPT plan) do the work. Pay-per-use spending is capped by your monthly limit.'}>
        <Row title="Use cloud models" sub={localIsOn(s) ? 'Off: nothing is ever sent to a cloud model. Your keys stay saved.' : 'Off: nothing is sent to a cloud model, so with local models off there\'s no model to chat with. Your keys stay saved.'}><Toggle on={s.cloud.enabled} onChange={(v) => void patch({ cloud: { ...s.cloud, enabled: v } })} label="Use cloud models" testId="cloud-enabled" /></Row>
        {s.cloud.enabled && localIsOn(s) && (
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
      <AlwaysOn s={s} patch={patch} />
      <SpendingLimitSection s={s} patch={patch} />
    </>
  )
}

// ------------------------------------------------------------------ models

function modelName(m: ModelInfo): string { return m.label || m.id }

/** Cloud model facts for the Models page: "1M context · $4 / $20 per M tokens". */
function cloudFacts(m: ModelInfo): string {
  const tok = (n: number): string => (n >= 1_000_000 ? `${n / 1_000_000}M` : `${Math.round(n / 1000)}K`)
  const usd = (n: number): string => `$${n < 1 ? n.toFixed(2) : n}`
  return [m.contextTokens ? `${tok(m.contextTokens)} context` : '', m.price ? `${usd(m.price.input)} / ${usd(m.price.output)} per M tokens${m.price.cacheRead !== undefined ? ` (cached ${usd(m.price.cacheRead)})` : ''}` : '', m.priceEstimated ? 'pricing estimated' : ''].filter(Boolean).map((x) => ` · ${x}`).join('')
}

/** Size on disk as Ollama reports it ("18.2 GB"). */
const diskGB = (bytes: number): string => `${(bytes / 1e9).toFixed(bytes >= 10e9 ? 0 : 1)} GB`

function Models({ s, models, patch, onRefresh }: P & { models: ModelList | null; onRefresh: () => void }) {
  const [q, setQ] = useState('')
  const [all, setAll] = useState(false)
  const [pull, setPull] = useState<Record<string, { pct: number; status: string; error?: string }>>({})
  const [deleting, setDeleting] = useState<string | null>(null)
  // The three picks first-run setup offers for this Mac (best agent model, fast one, alternative).
  const [picks, setPicks] = useState<Record<string, string>>({})
  useEffect(() => { if (localIsOn(s)) void api.models.setupPicks().then((ps) => setPicks(Object.fromEntries(ps.map((p) => [p.pull, p.role])))).catch(() => undefined) }, [models, s.local?.enabled])
  useEffect(() => api.models.onPull((e) => {
    setPull((p) => ({ ...p, [e.tag]: { pct: e.total ? Math.round(((e.completed ?? 0) / e.total) * 100) : p[e.tag]?.pct ?? 0, status: e.status, error: e.error } }))
    if (e.done && !e.error) { toast(`${e.tag} is ready`, 'ok'); onRefresh() }
    if (e.error) toast(e.error, 'error')
  }), [onRefresh])

  // Installed = can run now (downloaded, or a cloud model with its key). Recommended rows include both.
  const installed = (models?.models ?? []).filter((m) => m.installed)
  const recommended = recommendedRows(models)
  const ollama = models?.providers?.find((p) => p.id === 'ollama')
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
  const download = (m: ModelInfo): void => { setPull((p) => ({ ...p, [m.pull!]: { pct: 0, status: 'starting' } })); void api.models.pull(m.pull!) }
  // Deleting asks first: it removes the files from Ollama (they can be downloaded again).
  const remove = async (m: ModelInfo): Promise<void> => {
    const size = m.sizeBytes ? ` and frees ${diskGB(m.sizeBytes)}` : ''
    if (!confirm(`Delete ${modelName(m)} (${m.id}) from this Mac? This removes it from Ollama${size}. You can download it again later.`)) return
    setDeleting(m.id)
    const r = await api.models.remove(m.id).catch((e: Error) => ({ ok: false, error: e.message }))
    setDeleting(null)
    if (r.ok) toast(`Deleted ${modelName(m)}`, 'ok')
    else toast(r.error ?? 'Couldn\'t delete it', 'error')
    onRefresh()
  }
  const deleteBtn = (m: ModelInfo): ReactNode => deleting === m.id
    ? <span className="spin" />
    : <button className="icon-btn" title={`Delete ${m.id}`} aria-label={`Delete ${m.id}`} onClick={() => void remove(m)} data-testid={`model-delete-${m.id}`}><I.Trash size={15} /></button>

  return (
    <>
      <h2>Models</h2>
      <div className="set-sub">Downloaded models and cloud models with a saved key. Auto uses the ones that are on.</div>
      <Section title="Default">
        <Row title="Model for new chats" sub="Auto picks a fast model for quick chats and a stronger one for real tasks.">
          <select className="set-select" value={s.defaultModel} onChange={(e) => void patch({ defaultModel: e.target.value })} data-testid="default-model">
            <option value="auto">Auto (recommended)</option>
            {localIsOn(s) && <option value="auto:local">Auto (local only)</option>}
            <option value="auto:cloud">Auto (cloud only)</option>
            {usable.map((m) => <option key={m.id} value={m.id}>{modelName(m)}</option>)}
          </select>
        </Row>
        <Row title="Thinking for new chats" sub="Auto leans high for real tasks and low for quick chats. Chats and bots can choose their own.">
          <select className="set-select" value={s.thinking} onChange={(e) => void patch({ thinking: e.target.value as Settings['thinking'] })} data-testid="default-thinking">
            <option value="auto">Auto (recommended)</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="xhigh">Extra</option>
            <option value="max">Max</option>
          </select>
        </Row>
        <Row title="Auto prefers" sub="Best result: the strongest model for each kind of task. Balanced: the cheapest one that's strong enough. Cheapest: free local models first.">
          <select className="set-select" value={s.cloud.autoPrefers ?? 'best'} onChange={(e) => void patch({ cloud: { ...s.cloud, autoPrefers: e.target.value as 'best' | 'balanced' | 'cheapest' } })} data-testid="auto-prefers">
            <option value="best">Best result</option>
            <option value="balanced">Balanced</option>
            <option value="cheapest">Cheapest</option>
          </select>
        </Row>
      </Section>

      <Section title="Local models"><LocalModelsRow s={s} patch={patch} onChanged={onRefresh} /></Section>

      {localIsOn(s) && s.providers.ollama.enabled && (recommended.length > 0 || (ollama && !ollama.ok)) && (
        <Section title="Recommended for this Mac" sub={`Free models picked for agent work and tool use, sized for this Mac${models ? ` (${models.totalGB} GB of memory, ${models.budgetGB} GB for models)` : ''}. Download the ones that fit; Auto starts using them right away.`}>
          {ollama && !ollama.ok && <OllamaSetup onReady={onRefresh} />}
          {recommended.map((m) => {
            const pr = m.pull ? pull[m.pull] : undefined
            const busy = !m.installed && pr && !pr.error && pr.status !== 'done'
            const fits = m.fits || m.maxFittingWindow > 0
            const role = m.pull ? picks[m.pull] : undefined
            return (
              <div className="set-row" style={fits ? undefined : { opacity: 0.6 }} key={m.id} data-testid="recommended-row">
                <div className="set-row-text">
                  <div className="set-row-title">{modelName(m)} <span className="tier-badge">{TIER[m.tier]}</span>{role && <span className="tier-badge" style={{ marginLeft: 4 }} data-testid={`recommended-pick-${m.pull}`}>{role}</span>}</div>
                  <div className="set-row-sub">
                    {m.blurb}
                    {m.installed ? ` · Downloaded${m.id !== m.pull ? ` as ${m.id}` : ''}${m.sizeBytes ? ` · ${diskGB(m.sizeBytes)} on disk` : ''}` : ` · ${m.note}`}
                  </div>
                  {busy && <div className="meter" style={{ marginTop: 6 }}><i style={{ width: `${pr.pct}%` }} /></div>}
                </div>
                {m.installed ? <><span className="hint" style={{ marginRight: 6 }}>Installed</span>{deleteBtn(m)}</>
                  : busy ? <span className="hint">{pr.pct ? `${pr.pct}%` : pr.status}</span>
                  : <button className="btn" disabled={!fits} title={fits ? `Download ${m.pull} with Ollama` : 'Needs more memory than this Mac has'} onClick={() => download(m)} data-testid={`pull-${m.id}`}>Download</button>}
              </div>
            )
          })}
        </Section>
      )}

      {/* ChatGPT plan (via Codex): the user's subscription through their own Codex (ChatgptPlanSettings.tsx). */}
      <ChatgptPlanSettings onRefresh={onRefresh} />

      {/* xAI (Grok) and Fast mode (FastModeSettings.tsx). */}
      <XaiSection s={s} models={models} keyField={<KeyField saved={!!s.keys.xai} placeholder="xai-…" testId="key-xai" onSave={async (k) => { await patch({ setKeys: { xai: k } }); onRefresh() }} onTest={async (k) => { const r = await api.models.test('https://api.x.ai/v1', k); return r.ok ? 'ok' : keyError(clean({ message: r.error ?? '' })) }} />} />
      <Section title="Installed and available" sub="Switch one off to keep it out of the picker and Auto.">
        <div className="set-search">
          <input className="set-input" placeholder="Add or search model" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addModel()} data-testid="model-search" />
          {q.trim() && !installed.some((m) => m.id === q.trim()) && <button className="btn" onClick={addModel}>Add “{q.trim()}”</button>}
          <button className="icon-btn" title="Refresh" onClick={onRefresh}><I.Reply size={15} style={{ transform: 'scaleX(-1)' }} /></button>
        </div>
        {!models && <div className="set-empty">Loading models…</div>}
        {models && installed.length === 0 && <div className="set-empty">No models yet. Download one above, or add an API key under API Keys & Servers.</div>}
        {list.map((m) => (
          <div className="set-row" key={m.id} data-testid="model-row">
            <div className="set-row-text">
              <div className="set-row-title">{modelName(m)}</div>
              <div className="set-row-sub">{m.providerName} · {TIER[m.tier]}{m.vision ? ' · sees images' : ''}{m.note === 'remote' ? ` · cloud${cloudFacts(m)}` : m.sizeBytes ? ` · ${diskGB(m.sizeBytes)} on disk` : m.requiredGB ? ` · ${m.requiredGB} GB` : ''}{!m.fits && m.note && m.note !== 'remote' ? ` · ${m.note}` : ''}</div>
            </div>
            <ModelContextSelect model={m} s={s} patch={patch} />
            {m.provider === 'ollama' && m.note !== 'remote' && deleteBtn(m)}
            <Toggle on={m.enabled} onChange={(v) => setOn(m.id, v)} label={`Show ${m.id}`} testId={`model-toggle-${m.id}`} />
          </div>
        ))}
        {!q && shown.length > 12 && <button className="link-btn set-more" onClick={() => setAll((x) => !x)}>{all ? 'Show fewer' : `View All Models (${shown.length})`}</button>}
        {s.customModels.length > 0 && (
          <div className="set-row-sub" style={{ padding: '8px 4px 2px' }}>Added by you: {s.customModels.map((id) => {
            // Names nothing can run yet (no key for its provider, or no server has it) aren't in the picker.
            const off = models?.models.find((m) => m.id === id && !m.installed)
            return (
              <button key={id} className="chip-btn" style={{ marginLeft: 6 }} title={off?.note ? `Not in the picker: ${off.note}` : 'Remove'} onClick={() => void patch({ customModels: s.customModels.filter((x) => x !== id) }).then(onRefresh)}>
                {id}{off?.note ? ` (${off.note.toLowerCase()})` : ''} ×
              </button>
            )
          })}</div>
        )}
      </Section>
      <Disclosure title="Advanced" sub="Cloud routing, fast mode, computer use and task models" testId="models-advanced">
        {s.cloud.enabled && installed.some((m) => m.note === 'remote') && (
          <Section title="Cloud models" sub="How Auto and hybrid mode use cloud models. Every cloud request is still priced against your monthly cap first.">
            <Row title="Local or cloud first" sub="Cloud first (the default once a cloud key is saved): Auto picks among Claude and GPT models by the kind of task. Local first: free, private local models for quick chats and light work whenever one is strong enough; agent work (coding, research, tasks) still goes to the strongest cloud model.">
              <select className="set-select" value={s.cloud.prefer ?? (s.keys.anthropic ? 'cloud' : 'local')} onChange={(e) => void patch({ cloud: { ...s.cloud, prefer: e.target.value as 'local' | 'cloud' } })} data-testid="cloud-prefer">
                <option value="local">Local first</option>
                <option value="cloud">Cloud first</option>
              </select>
            </Row>
            {s.keys.anthropic && (
              <>
                <Row title="Claude context" sub="How much of Claude's 1M-token window a chat uses before older turns are summarized (by Claude, on Anthropic's servers). More context remembers more but costs more per step; cached history is billed at a fraction of the input price.">
                  <select className="set-select" value={s.cloud.contextStrategy ?? 'balanced'} onChange={(e) => void patch({ cloud: { ...s.cloud, contextStrategy: e.target.value as 'max' | 'balanced' | 'economy' } })} data-testid="claude-context-strategy">
                    <option value="max">Maximum (the full 1M window)</option>
                    <option value="balanced">Balanced (up to 400K, recommended)</option>
                    <option value="economy">Economy (up to 128K)</option>
                  </select>
                </Row>
                <Row title="Claude's native tools" sub="Claude uses its own computer-use, text-editor, terminal and web search tools, which it handles best. They run through SahilBot's same approvals and safety checks; web search then runs on Anthropic's servers ($10 per 1,000 searches).">
                  <Toggle on={s.cloud.nativeTools !== false} onChange={(v) => void patch({ cloud: { ...s.cloud, nativeTools: v } })} label="Claude's native tools" testId="claude-native-tools" />
                </Row>
                <Row title="Use Fable for the hardest tasks" sub="Auto sends the hardest requests to Claude Fable (priced well above Opus). Off: Fable only when you pick it.">
                  <Toggle on={!!s.cloud.fableForHardest} onChange={(v) => void patch({ cloud: { ...s.cloud, fableForHardest: v } })} label="Use Fable for the hardest tasks" testId="claude-fable-hardest" />
                </Row>
              </>
            )}
            {s.cloud.hybrid && (
              <Row title="Hybrid advisor" sub="The cloud model your local model asks for plans and help.">
                <select className="set-select" value={s.cloud.advisorModel} onChange={(e) => void patch({ cloud: { ...s.cloud, advisorModel: e.target.value } })} data-testid="advisor-model">
                  <option value="">Best Opus (recommended)</option>
                  <option value="sonnet">Best Sonnet (cheaper)</option>
                  {installed.filter((m) => m.note === 'remote' && m.enabled).map((m) => <option key={m.id} value={m.id}>{modelName(m)}</option>)}
                </select>
              </Row>
            )}
          </Section>
        )}
        <FastModeSection s={s} patch={patch} models={models} />
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

        <Section title="Computer use">
          <ComputerUseSetting s={s} usable={usable} patch={patch} />
        </Section>
      </Disclosure>
    </>
  )
}

// ------------------------------------------------------------------ keys & servers

const SETUP_PHASE: Record<string, string> = { download: 'Downloading Ollama…', verify: 'Checking it with Apple\'s security check…', install: 'Installing…', start: 'Starting Ollama…', done: 'Ollama is running.' }

/** Ollama isn't running: install it if needed and start it, in one click. */
/** Settings → API Keys → Onshape: the access/secret key pair for the onshape CAD tool, and a Test button. */
function OnshapeKeys({ s, patch }: P) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const test = async (): Promise<void> => {
    if (!api.cad) return
    setMsg({ ok: true, text: 'Checking…' })
    const r = await api.cad.onshapeTest().catch((e: Error) => ({ ok: false, name: undefined, error: e.message }))
    setMsg(r.ok ? { ok: true, text: `Working${r.name ? ` · ${r.name}` : ''}` } : { ok: false, text: (r.error ?? 'Could not connect.').split('. Fix:')[0].slice(0, 160) })
  }
  const save = (field: 'onshapeAccessKey' | 'onshapeSecretKey') => async (k: string | null): Promise<void> => { setMsg(null); await patch({ [field]: k } as never) }
  return (
    <Section title="Onshape (CAD)" sub={<>Lets the bots read your Onshape documents (parts, feature trees, variables, mass properties, exports) and, with your OK each time, change variables or configurations in a workspace. Create an API key pair at the <a href="https://dev-portal.onshape.com/keys" target="_blank" rel="noreferrer">Onshape developer portal</a> (Read scope to look; Write to make changes) and paste both halves here. Keys only work on the Onshape stack they were made on.</>}>
      <Row title="Access key"><KeyField saved={!!s.onshapeKeyParts?.access} placeholder="Onshape access key" testId="key-onshape-access" onSave={save('onshapeAccessKey')} /></Row>
      <Row title="Secret key"><KeyField saved={!!s.onshapeKeyParts?.secret} placeholder="Onshape secret key" testId="key-onshape-secret" onSave={save('onshapeSecretKey')} /></Row>
      <Row title="Connection" sub={s.hasOnshapeKeys ? 'Checks the saved keys with Onshape (one API call).' : 'Save both keys, then test them.'}>
        <div className="key-saved">
          <button className="link-btn" disabled={!s.hasOnshapeKeys} onClick={() => void test()} data-testid="onshape-test">Test</button>
          {msg && <span className={`conn ${msg.ok ? 'ok' : 'bad'}`} data-testid="onshape-test-msg">{msg.text}</span>}
        </div>
      </Row>
    </Section>
  )
}

function OllamaSetup({ onReady }: { onReady: () => void }) {
  const [st, setSt] = useState<{ phase: string; pct?: number; error?: string } | null>(null)
  const [installed, setInstalled] = useState<boolean | null>(null)
  useEffect(() => void api.ollama.installed().then(setInstalled), [])
  useEffect(() => api.ollama.onSetup((e) => { setSt(e); if (e.phase === 'done') onReady() }), [onReady])
  const busy = st && !st.error && st.phase !== 'done'
  return (
    <Row title={installed ? 'Start Ollama' : 'Set up local models'} sub={st?.error ?? (st ? `${SETUP_PHASE[st.phase] ?? ''}${st.phase === 'download' && st.pct ? ` ${st.pct}%` : ''}` : installed ? 'Ollama is installed but not running. SahilBot can run it in the background.' : 'SahilBot installs Ollama (free, about 230 MB, no password), checks it with Apple\'s security check, and runs it in the background.')}>
      {busy ? <span className="spin" /> : <button className="btn primary" onClick={() => { setSt({ phase: installed ? 'start' : 'download' }); void api.ollama.setup() }} data-testid="settings-ollama-setup">{st?.error ? 'Try again' : installed ? 'Start' : 'Set up'}</button>}
    </Row>
  )
}

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
      {id === 'ollama' && localIsOn(s) && s.providers.ollama.enabled && status('ollama') === 'Not running' && <OllamaSetup onReady={onChanged} />}
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
      <Section title="xAI API Key" sub={<>Put in <a href={link('xai')} target="_blank" rel="noreferrer">your xAI key</a> to use Grok models. It is used for every model whose name starts with "grok-". Spending counts toward your monthly limit.</>}>
        <Row title="API Key"><KeyField saved={!!s.keys.xai} placeholder="xai-…" testId="key-xai-keys" onSave={saveKey('xai')} onTest={test('https://api.x.ai/v1')} /></Row>
      </Section>
      <Section title="Market data" sub="Stock prices for the stock tools, cards and alerts. SEC filings and financials need no key. A free Tiingo key gives full daily history; the others add live or delayed quotes.">
        {([['tiingo', 'Tiingo', 'https://www.tiingo.com/account/api/token', 'Free: full daily price history (recommended)'], ['polygon', 'Polygon', 'https://polygon.io/dashboard/api-keys', 'Daily history and delayed quotes'], ['alphavantage', 'Alpha Vantage', 'https://www.alphavantage.co/support/#api-key', 'Quotes and history (small free limit)'], ['finnhub', 'Finnhub', 'https://finnhub.io/dashboard', 'Live quotes and company news']] as const).map(([id, name, url, sub]) => (
          <Row key={id} title={<a href={url} target="_blank" rel="noreferrer">{name}</a>} sub={sub}>
            <KeyField saved={!!s.markets?.keys?.[id]} placeholder={`${name} key`} testId={`key-market-${id}`} onSave={async (k) => { await patch({ marketKeys: { [id]: k } } as never) }} />
          </Row>
        ))}
        <Row title="Quotes from" sub="Auto uses the first source above that has a key. Without one, prices are the last daily close, with its date.">
          <select className="set-select" value={s.markets?.quoteProvider ?? 'auto'} onChange={(e) => void patch({ markets: { ...(s.markets ?? { secContact: '' }), quoteProvider: e.target.value as never } } as never)} data-testid="quote-provider">
            {['auto', 'none', 'tiingo', 'polygon', 'alphavantage', 'finnhub'].map((v) => <option key={v} value={v}>{v === 'auto' ? 'Auto' : v === 'none' ? 'Daily closes only' : v === 'alphavantage' ? 'Alpha Vantage' : v[0].toUpperCase() + v.slice(1)}</option>)}
          </select>
        </Row>
      </Section>
      <Section title="The Blue Alliance (FRC)" sub={<>A free read key from <a href="https://www.thebluealliance.com/account" target="_blank" rel="noreferrer">your TBA account</a> lets the FRC bots pull match schedules, results and rankings. Statbotics works without a key.</>}>
        <Row title="Read API Key"><KeyField saved={!!s.hasTbaKey} placeholder="TBA read key" testId="key-tba" onSave={async (k) => { await patch({ tbaKey: k }) }} /></Row>
      </Section>
      <OnshapeKeys s={s} patch={patch} />
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
  }, [s.voiceOutput?.openai, s.local?.enabled])
  const usable = (models?.models ?? []).filter((m) => m.installed && m.enabled)
  return (
    <>
      <h2>Voice</h2>
      <div className="set-sub" style={{ marginTop: -6 }}>{localIsOn(s) ? 'Dictation, read-aloud and voice conversations run on this Mac (Whisper listens, Kokoro speaks).' : 'Dictation, read-aloud and voice conversations. Replies can be read in your Mac\'s own voice; voice input uses OpenAI (or local models, when they\'re on).'}</div>
      <Section title="Speaking">
        <Row title="Read replies aloud" sub="Speak every reply as it arrives. You can also press the speaker button on any message."><Toggle on={s.speakReplies} onChange={(v) => void patch({ speakReplies: v })} label="Read replies aloud" testId="speak-replies" /></Row>
        <VoiceOutputRow s={s} patch={patch} output={voice?.output} />
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
        ] as const).filter(() => localIsOn(s)).map(([k, label, ok, mb]) => (
          <Row key={k} title={label} sub={`${mb} MB${dl[k]?.error ? ` · ${dl[k].error}` : ''}`}>
            {ok ? <span className="conn ok"><I.Check size={13} /> Ready</span> : dl[k] && !dl[k].error && dl[k].progress < 1
              ? <span className="hint">{Math.round(dl[k].progress * 100)}%</span>
              : <button className="btn" onClick={() => { setDl((d) => ({ ...d, [k]: { progress: 0.01 } })); void api.voice.download(k) }}>Download</button>}
          </Row>
        ))}
        {voice && !voice.binary && localIsOn(s) && <Row title="Speech recognition isn't built" sub="Run scripts/voice-setup.sh once." />}
        {/* Local models off: no voice model downloads; voice input uses OpenAI's transcription or says what it needs. */}
        {voice && !localIsOn(s) && <VoiceInputNote input={voice.input} note={voice.inputNote} />}
      </Section>
      <div className="set-sub">Shortcuts: ⌘⇧D dictates into the message box; ⌘⇧V starts a voice conversation; Esc stops speaking.</div>
    </>
  )
}

// ------------------------------------------------------------------ memory bank

function MemoryPage({ spaces }: { spaces: Space[] }) {
  return (
    <>
      <h2>Memory</h2>
      <div className="set-sub" style={{ marginTop: -6 }}>What your bots remember: facts about you that every bot shares, and each bot's own rules and work log. Everything stays on this Mac. Click a memory to edit it.</div>
      <MemoryManager spaces={spaces} />
      <VaultSettings />
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

// ------------------------------------------------------------------ approval rules

const RULE_EXAMPLES: Array<{ when: string; action: 'allow' | 'ask' }> = [
  { when: 'send email', action: 'ask' },
  { when: 'npm install', action: 'allow' },
  { when: 'post', action: 'ask' },
  { when: 'tool:run_command git status', action: 'allow' }
]

/** "When SahilBot wants to …, it should allow automatically / ask first." Ask first wins when both match. */
function ApprovalRulesPage({ patch }: { patch: (p: SettingsPatchUi) => Promise<Settings> }) {
  const [rules, setRules] = useState<NonNullable<Settings['customRules']> | null>(null)
  const [when, setWhen] = useState('')
  const [action, setAction] = useState<'allow' | 'ask'>('ask')
  const [busy, setBusy] = useState(false)
  // Guards a second Enter that lands before the first add re-renders.
  const busyRef = useRef(false)
  // Read the saved list fresh: an approval card may have added a rule since Settings opened.
  useEffect(() => { void loadRules().then(setRules) }, [])
  const save = (customRules: NonNullable<Settings['customRules']>): Promise<Settings> => patch({ customRules })
  const add = async (): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      const r = await addRule(when, action, save)
      if ('error' in r) { toast(r.error, 'error'); return }
      setRules(r.rules)
      setWhen('')
      toast('Saved to your approval rules', 'ok')
    } catch (e) { toast(clean(e), 'error') } finally { busyRef.current = false; setBusy(false) }
  }
  const del = async (id: string): Promise<void> => {
    try { setRules(await removeRule(id, save)) } catch (e) { toast(clean(e), 'error') }
  }
  const list = rules ?? []
  const of = (k: 'allow' | 'ask') => list.filter((r) => r.action === k)
  const full = of(action).length >= RULE_LIMIT
  const ruleLabel = (t: string): ReactNode => t.split(/(tool:\S+)/g).map((part, i) => (/^tool:/.test(part) ? <code key={i}>{part}</code> : part))
  const group = (k: 'allow' | 'ask', title: string, sub: string) => (
    <Section title={`${title} (${of(k).length}/${RULE_LIMIT})`} sub={sub}>
      <div className="ar-card" data-testid={`rules-${k}`}>
        {of(k).length === 0 && <div className="ar-empty">None yet.</div>}
        {of(k).map((r) => (
          <div key={r.id} className="ar-item" data-testid="rule-item">
            <div className="ar-item-text">{ruleLabel(r.when)}</div>
            <button className="ar-del" title="Delete rule" aria-label={`Delete rule: ${r.when}`} onClick={() => void del(r.id)} data-testid="rule-delete"><I.Close size={14} /></button>
          </div>
        ))}
      </div>
    </Section>
  )
  return (
    <>
      <h2>Approval rules</h2>
      <div className="set-sub">Decide ahead of time which actions SahilBot can take on its own and which always need your OK. A rule matches when every word in it appears in the action (its name, what it will do, or its details); “sends”, “sending” and “sent” all count as “send”. If an Ask first rule and an Allow rule both match, SahilBot asks.</div>
      <Section>
        <div className="ar-form">
          <label htmlFor="rule-when">When SahilBot wants to:</label>
          <textarea id="rule-when" className="set-input" rows={2} maxLength={RULE_MAX_CHARS} value={when} placeholder="e.g. send email, npm install, click Buy, tool:run_command"
            onChange={(e) => setWhen(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (when.trim() && !full) void add() } }} data-testid="rule-when" />
          <div className="ar-form-row">
            <label htmlFor="rule-action">It should:</label>
            <select id="rule-action" className="set-select" value={action} onChange={(e) => setAction(e.target.value as 'allow' | 'ask')} data-testid="rule-action">
              <option value="allow">Allow automatically</option>
              <option value="ask">Ask first</option>
            </select>
            <button className="btn primary" disabled={busy || !when.trim() || full} onClick={() => void add()} data-testid="rule-add">Add rule</button>
            <span className="ar-count">{full ? `You have ${RULE_LIMIT} of these. Delete one to add another.` : when.length > RULE_MAX_CHARS - 100 ? `${when.length}/${RULE_MAX_CHARS}` : ''}</span>
          </div>
          <div className="ar-examples">Try:
            {RULE_EXAMPLES.map((x) => <button key={x.when} onClick={() => { setWhen(x.when); setAction(x.action) }}>{x.action === 'ask' ? 'Ask first' : 'Allow'}: {x.when}</button>)}
          </div>
        </div>
      </Section>
      {rules === null ? <div className="hint">Loading…</div> : (
        <>
          {group('ask', 'Ask first', 'SahilBot stops and asks before these, even in Auto mode.')}
          {group('allow', 'Allow automatically', 'SahilBot does these without asking. Deleting, payments and sign-in changes still ask, and saved passwords are never sent anywhere.')}
        </>
      )}
      <div className="set-sub">Tip: <code>tool:run_command</code> matches one tool by name (<code>*</code> is a wildcard), and “quoted words” must appear exactly as written.</div>
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
        <Row title="Context window" sub="How much of the conversation a local model holds. Auto gives each model up to 64k on Macs with 48 GB or more and 32k on smaller ones, never more than fits in memory. Older turns are summarized only when it's almost full.">
          <div className="seg">{WINDOWS.map((w) => <button key={w} className={s.contextWindow === w ? 'on' : ''} onClick={() => void patch({ contextWindow: w })}>{w ? `${w / 1024}k` : 'Auto'}</button>)}</div>
        </Row>
        {/* Only local models use the GPU memory setting: with them off it's just noise. */}
        {localIsOn(s) && <GpuRow />}
        <Row title="Hard stops in Bypass" sub="Always ask before payments, typing credentials, account or security settings, and permanent deletes.">
          <Toggle on={s.advanced.hardStopsEnabled} onChange={(v) => void patch({ advanced: { hardStopsEnabled: v } })} label="Hard stops" />
        </Row>
        <Row title="Autonomy for new chats" sub="Ask first: approve every change. Auto: routine steps run; installing, sending, buying, posting and deleting ask. Autonomous: also builds, tests, installs from the project's lockfile, git and file changes in your folders; deleting, sending, buying, credentials and anything outside your folders still ask. A bot can set its own level in its details panel.">
          <select className="set-select" value={s.defaultMode ?? 'auto'} onChange={(e) => void patch({ defaultMode: e.target.value as Settings['defaultMode'] })} data-testid="default-autonomy" aria-label="Autonomy for new chats">
            <option value="ask">Ask first</option>
            <option value="auto">Auto</option>
            <option value="autonomous">Autonomous</option>
          </select>
        </Row>
        <Row title="Offer Bypass in the autonomy picker" sub="Bypass runs everything without asking except hard stops (when they're on). It resets to Auto when SahilBot restarts. Only for work you watch.">
          <Toggle on={!!s.advanced.allowBypass} onChange={(v) => void patch({ advanced: { ...s.advanced, allowBypass: v } })} label="Offer Bypass" testId="allow-bypass" />
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
