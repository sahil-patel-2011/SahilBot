import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ComputerUseSetting } from './ComputerUseSetting'
import { bytesText } from '@shared/bytes'
import { WhatsNewList } from './WhatsNew'
import type { ConnectorStatus, ModelInfo, ModelList, PermissionKind, ProviderId, Rule, Sampling, Settings, Skill, Space, SystemInfo, UpdateStatus, VoiceStatus } from '@shared/types'
import { SENSITIVE_CATEGORIES, type ContextEngineStatus } from '@shared/context-engine'
import { HYBRID_BEST, HYBRID_MIN, type PrivacyInstallEvent, type PrivacyStatus } from '@shared/privacy'
import { api, isServerRuntime } from '../api'
import * as I from '../icons'
import { toast } from '../lib/toast'
import { Toggle } from './Toggle'
import { ModelContextSelect } from './ModelContextSelect'
import { isAutoModel, recommendedRows } from '@shared/model-picker'
import { MemoryPage } from './MemoryManager'
import { SecretVaultSettings } from './VaultSettings'
import { KnowledgeSettings } from './KnowledgeSettings'
import { UsagePage } from './UsagePage'
import { SpendingLimitSection } from './SpendingLimit'
import { FastModeSection } from './FastModeSettings'
import { McpSettings } from './McpSettings'
import { ChatgptPlanSettings } from './ChatgptPlanSettings'
import { GrokPlanSettings } from './GrokPlanSettings'
// Local models are opt-in: one quiet row when they're off, no download prompts (components/LocalModels.tsx).
import { LocalModelsRow, VoiceOutputRow, localIsOn } from './LocalModels'
import { ActivitySettings } from './ActivitySettings'
import { AlwaysOnServerPage, PhoneAccessSection, PhonePage, ServerPage } from './ServerSettings'
import { ClampText, Disclosure, InfoTip, Segmented, SetTabs as Tabs } from './ui'
import { addRule, loadRules, removeRule, RULE_LIMIT, RULE_MAX_CHARS } from '../lib/approvalRules'
import { LEGACY_PAGES, PAGE_TITLES, SETTINGS_INDEX, searchSettings, type SettingEntry, type SettingsPage } from '../lib/settings-index'
import '../styles-approvals.css'
import '../styles-purchase.css'

// Settings: nine pages, each with the few choices most people want on top and everything rarely used
// behind one "Advanced" (or "More") row. Every option starts at the best choice, so most people never
// need to come here. Every change saves right away (keys go to the Keychain). Search finds any setting
// (lib/settings-index.ts) and jumps to it, opening its tab and any closed disclosure on the way.

type Page = SettingsPage
const PAGES: Array<{ id: Page; icon: ReactNode; color: string }> = [
  { id: 'general', icon: <I.Gear size={14} />, color: '#8e8e93' },
  { id: 'models', icon: <I.Cpu size={14} />, color: '#5856d6' },
  { id: 'connected', icon: <I.Plug size={14} />, color: '#007aff' },
  { id: 'permissions', icon: <I.Shield size={14} />, color: '#34aadc' },
  { id: 'memory', icon: <I.Sparkle size={14} />, color: '#34c759' },
  { id: 'voice', icon: <I.Mic size={14} />, color: '#ff2d55' },
  { id: 'privacy', icon: <I.Shield size={14} />, color: '#5ac8fa' },
  { id: 'usage', icon: <I.Clock size={14} />, color: '#ff6a1a' },
  // SahilBot Server: devices, pairing, notifications, audit (web UI); in the Mac app, the link to a server.
  { id: 'server', icon: <I.Globe size={14} />, color: '#1f8a5b' },
  { id: 'advanced', icon: <I.Sliders size={14} />, color: '#af52de' }
]
/** The pages shown up front; the others sit under "More settings". */
const MAIN_PAGES = new Set<Page>(['general', 'models', 'connected', 'privacy', 'server'])
/** A phone using the Mac (Phone access) sees its own page where SahilBot Server's browsers see the server's. */
const onPhone = isServerRuntime && api?.serverHost === 'mac'
const pageTitle = (id: Page): string => (id === 'server' && isServerRuntime ? (onPhone ? 'This phone' : 'Server') : PAGE_TITLES[id])

const WINDOWS: Settings['contextWindow'][] = [0, 16384, 32768, 65536, 131072]
const SAMPLING_KEYS: Array<keyof Sampling> = ['temperature', 'top_p', 'top_k', 'min_p', 'presence_penalty', 'repeat_penalty']
const TIER = ['Instant', 'Light', 'Standard', 'Heavy']
const clean = (e: unknown): string => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export type SettingsPatchUi = Parameters<typeof api.settings.set>[0]

/** A page id, a legacy one ("keys", "passwords"…) or "page:tab" → the page and tab to open. */
export function resolvePage(id?: string): { page: Page; tab?: string } {
  if (!id) return { page: 'general' }
  if (LEGACY_PAGES[id]) return LEGACY_PAGES[id]
  const [p, tab] = id.split(':')
  if (LEGACY_PAGES[p]) return LEGACY_PAGES[p]
  return PAGES.some((x) => x.id === p) ? { page: p as Page, tab } : { page: 'general' }
}

// ------------------------------------------------------------------ building blocks

/** Built-in skill groups (Settings → Rules & skills): each skill's category folds into one of these. */
const BUILTIN_GROUPS: Array<{ id: string; label: string; what: string }> = [
  { id: 'engineering', label: 'Engineering', what: 'coding, robotics, mechanical and electrical engineering' },
  { id: 'office', label: 'Office', what: 'documents, business, email, research and everyday tasks' },
  { id: 'medical', label: 'Medical', what: 'clinical work and health records' },
  { id: 'health', label: 'Health', what: 'fitness, sleep, nutrition and wellbeing' }
]
function builtinGroup(category?: string): string | undefined {
  const c = (category ?? '').toLowerCase()
  if (c === 'redirects') return undefined
  if (/medical|hipaa|clinical/.test(c)) return 'medical'
  if (/health|fitness/.test(c)) return 'health'
  if (/coding|frc|engineering|cad|code/.test(c)) return 'engineering'
  return 'office'
}

function Section({ title, sub, children, testId }: { title?: string; sub?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section className="set-section" data-testid={testId}>
      {title && <div className="set-label">{title}</div>}
      {sub && <div className="set-sub">{sub}</div>}
      <div className="set-card">{children}</div>
    </section>
  )
}

/** One setting: title (+ an "i" with the details), one short line, the control. `id` is its search anchor. */
function Row({ id, title, sub, info, children, testId }: { id?: string; title: ReactNode; sub?: ReactNode; info?: ReactNode; children?: ReactNode; testId?: string }) {
  return (
    <div className="set-row" data-testid={testId} data-setting={id}>
      <div className="set-row-text">
        <div className="set-row-title">{title}{info && <InfoTip>{info}</InfoTip>}</div>
        {sub && <ClampText>{sub}</ClampText>}
      </div>
      {children && <div className="set-row-ctl">{children}</div>}
    </div>
  )
}

// Re-exported for anything that still imports it from here; it lives in its own module (see Toggle.tsx).
export { Toggle }

/** A text box that saves when you press Enter or leave it. */
function Field({ value, onSave, placeholder, type = 'text', testId, width, label }: { value: string; onSave: (v: string) => void; placeholder?: string; type?: string; testId?: string; width?: number; label?: string }) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  const commit = (): void => { if (v.trim() !== value) onSave(v.trim()) }
  return <input className="set-input" style={width ? { width } : undefined} type={type} value={v} placeholder={placeholder} spellCheck={false} aria-label={label}
    onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} data-testid={testId} />
}

/** An API key: saved straight to the Keychain; shows only that one is saved. Checked before it's saved. */
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
        <span className="key-dots"><I.Check size={13} /> Saved</span>
        <button className="link-btn" onClick={() => setEditing(true)}>Replace</button>
        <button className="link-btn danger" onClick={() => void onSave(null).then(() => setMsg(null))}>Remove</button>
        {msg && <span className={`conn ${msg.ok ? 'ok' : 'bad'}`}>{msg.text}</span>}
      </div>
    )
  }
  return (
    <div className="key-edit">
      <input className="set-input" type="password" value={v} placeholder={placeholder} autoComplete="off" spellCheck={false} data-testid={testId} aria-label={placeholder}
        onChange={(e) => { setV(e.target.value); setMsg(null) }} onKeyDown={(e) => e.key === 'Enter' && void save()} />
      <button className="btn" disabled={!v.trim()} onClick={() => void save()} data-testid={`${testId}-save`}>Save</button>
      {saved && <button className="link-btn" onClick={() => setEditing(false)}>Cancel</button>}
      {msg && <span className={`conn ${msg.ok ? 'ok' : 'bad'}`} data-testid={`${testId}-msg`}>{msg.text}</span>}
    </div>
  )
}

function Slider({ min, max, step = 1, value, onChange, left, right, mid, label }: { min: number; max: number; step?: number; value: number; onChange: (v: number) => void; left?: string; right?: string; mid?: string; label?: string }) {
  return (
    <div className="set-slider">
      <input type="range" min={min} max={max} step={step} value={value} aria-label={label} onChange={(e) => onChange(Number(e.target.value))} />
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
  initialPage?: string
}) {
  // "#anchor" (the ⌘K search): open the setting's own page and tab, scrolled to it.
  const anchored = initialPage?.startsWith('#') ? SETTINGS_INDEX.find((e) => e.anchor === initialPage.slice(1)) : undefined
  const start = anchored ? { page: anchored.page, tab: anchored.tab } : resolvePage(initialPage)
  const [page, setPage] = useState<Page>(start.page)
  const [tabs, setTabs] = useState<Partial<Record<Page, string>>>(start.tab ? { [start.page]: start.tab } : {})
  const [find, setFind] = useState('')
  const [jump, setJump] = useState<string | null>(anchored?.anchor ?? null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const pages = PAGES.filter((x) => !isServerRuntime || x.id !== 'voice')
  const [more, setMore] = useState(() => { try { return localStorage.getItem('sahilbot:settings-more') === '1' } catch { return false } })
  const results = useMemo(() => searchSettings(find, { server: isServerRuntime }), [find])
  const [s, setS] = useState(settings)
  useEffect(() => setS(settings), [settings])
  const patch = async (p: SettingsPatchUi): Promise<Settings> => {
    const n = await api.settings.set(p)
    setS(n)
    onSaved(n)
    return n
  }
  const setTab = (p: Page) => (t: string): void => setTabs((x) => ({ ...x, [p]: t }))
  const go = (p: Page): void => { setPage(p); bodyRef.current?.scrollTo({ top: 0 }) }
  /** A search result: its page and tab, then (once rendered) open whatever hides it and scroll to it. */
  const pick = (e: SettingEntry): void => {
    setPage(e.page)
    if (e.tab) setTabs((x) => ({ ...x, [e.page]: e.tab }))
    setFind('')
    setJump(e.anchor)
  }
  useEffect(() => {
    if (!jump) return
    let tries = 0
    let t: ReturnType<typeof setTimeout>
    const look = (): void => {
      const el = bodyRef.current?.querySelector<HTMLElement>(`[data-setting="${jump}"]`)
      if (!el) { if (++tries < 40) t = setTimeout(look, 50); else setJump(null); return }
      for (let d = el.closest('details'); d; d = d.parentElement?.closest('details') ?? null) d.open = true
      el.scrollIntoView({ block: 'center' })
      el.classList.remove('set-flash')
      void el.offsetWidth
      el.classList.add('set-flash')
      setTimeout(() => el.classList.remove('set-flash'), 1800)
      setJump(null)
    }
    t = setTimeout(look, 0)
    return () => clearTimeout(t)
  }, [jump, page, tabs])
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
          <div className="set-find nodrag"><I.Search size={14} />
            <input placeholder="Search settings" value={find} onChange={(e) => setFind(e.target.value)} aria-label="Search settings" data-testid="settings-search"
              onKeyDown={(e) => { if (e.key === 'Enter' && results[0]) pick(results[0]); if (e.key === 'Escape' && find) { e.preventDefault(); e.stopPropagation(); setFind('') } }} />
          </div>
          {find.trim() ? (
            <div className="set-results" role="listbox" aria-label="Matching settings" data-testid="settings-results">
              {results.length === 0 && <div className="set-results-empty">No setting matches “{find.trim()}”.</div>}
              {results.slice(0, 14).map((r) => (
                <button key={r.anchor} role="option" aria-selected={false} className="set-result" onClick={() => pick(r)} data-testid={`settings-result-${r.anchor}`}>
                  <span className="set-result-title">{r.title}</span>
                  <span className="set-result-where">{pageTitle(r.page)}{r.advanced ? ' · Advanced' : ''}</span>
                </button>
              ))}
            </div>
          ) : <>
            {/* Simple first: the five pages most people need, the rest one click away (search finds everything). */}
            {pages.filter((p) => MAIN_PAGES.has(p.id)).map((p) => (
              <button key={p.id} className={`set-nav-item${page === p.id ? ' on' : ''}`} onClick={() => go(p.id)} data-testid={`settings-${p.id}`}><span className="set-tile" style={{ background: p.color }}>{p.icon}</span>{pageTitle(p.id)}</button>
            ))}
            <button className="set-nav-more" onClick={() => { setMore((m) => { try { localStorage.setItem('sahilbot:settings-more', m ? '0' : '1') } catch { /* ignore */ } return !m }) }} aria-expanded={more || !MAIN_PAGES.has(page)} data-testid="settings-more">{more || !MAIN_PAGES.has(page) ? '▾' : '▸'} More settings</button>
            {(more || !MAIN_PAGES.has(page)) && pages.filter((p) => !MAIN_PAGES.has(p.id)).map((p) => (
              <button key={p.id} className={`set-nav-item${page === p.id ? ' on' : ''}`} onClick={() => go(p.id)} data-testid={`settings-${p.id}`}><span className="set-tile" style={{ background: p.color }}>{p.icon}</span>{pageTitle(p.id)}</button>
            ))}
          </>}
          {sys && <div className="set-nav-foot">{sys.chip}<br />{sys.totalGB} GB RAM · SahilBot {sys.appVersion}</div>}
        </nav>
        <div className="set-body" ref={bodyRef} data-page={page}>
          {page === 'general' && <General s={s} patch={patch} />}
          {page === 'models' && <ModelsPage s={s} models={models} patch={patch} onRefresh={onRefreshModels} />}
          {page === 'connected' && <ConnectedPage s={s} patch={patch} />}
          {page === 'permissions' && <PermissionsPage s={s} patch={patch} />}
          {page === 'memory' && <MemoryPage spaces={spaces ?? []} tab={tabs.memory ?? 'memories'} onTab={setTab('memory')} />}
          {page === 'voice' && <VoicePage s={s} models={models} patch={patch} />}
          {page === 'privacy' && <PrivacySecurityPage s={s} patch={patch} tab={tabs.privacy ?? 'passwords'} onTab={setTab('privacy')} />}
          {page === 'usage' && <div data-setting="usage"><UsagePage /></div>}
          {page === 'server' && <div data-setting="server">{isServerRuntime ? (onPhone ? <PhonePage /> : <ServerPage />) : <AlwaysOnServerPage />}</div>}
          {page === 'advanced' && <AdvancedPage s={s} models={models} patch={patch} spaces={spaces ?? []} tab={tabs.advanced ?? 'rules'} onTab={setTab('advanced')} />}
        </div>
      </div>
    </div>
  )
}

type P = { s: Settings; patch: (p: SettingsPatchUi) => Promise<Settings> }

// ------------------------------------------------------------------ general

const CATCH_UP = [[0, 'Off'], [1, '1 hour'], [6, '6 hours'], [12, '12 hours'], [24, '1 day'], [72, '3 days'], [168, '1 week']] as const

function General({ s, patch }: P) {
  const [braveKey, setBraveKey] = useState('')
  const [login, setLogin] = useState<string | null>(null)
  useEffect(() => { if (!isServerRuntime) void api.alwaysOn.status().then((st) => setLogin(st.loginItem)).catch(() => undefined) }, [s.openAtLogin])
  const loginHint = login === 'requires-approval' ? 'Allow SahilBot in System Settings → General → Login Items.' : login === 'unsupported' ? 'Works in the installed app.' : 'Starts hidden in the menu bar.'
  const a = s.appearance
  const look = (p: Partial<Settings['appearance']>): void => void patch({ appearance: { ...a, ...p } })
  return (
    <>
      <h2>General</h2>
      <div className="set-sub">Most people never need to change anything here.</div>
      <Section>
        <Row id="user-name" title="Your name" sub="What SahilBot calls you."><Field value={s.userName} placeholder="First name" label="Your name" onSave={(v) => void patch({ userName: v })} /></Row>
        {/* Me: bots may always email or text these without asking (agent/trusted.ts). Commas separate several. */}
        <Row id="me-contact" title="Your email and phone" sub="Bots can always message you here without asking.">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Field value={(s.me?.emails ?? []).join(', ')} width={220} placeholder="you@example.com" label="Your email" testId="me-emails" onSave={(v) => void patch({ me: { emails: v.split(/[,;\s]+/).filter(Boolean), phones: s.me?.phones ?? [] } })} />
            <Field value={(s.me?.phones ?? []).join(', ')} width={220} type="tel" placeholder="+1 555 010 1234" label="Your phone" testId="me-phones" onSave={(v) => void patch({ me: { emails: s.me?.emails ?? [], phones: v.split(/[,;]+/).map((x) => x.trim()).filter(Boolean) } })} />
          </div>
        </Row>
        <Row id="workspace" title="Workspace folder" sub="Where SahilBot saves what it makes."><Field value={s.workspaceDir} width={280} label="Workspace folder" onSave={(v) => void patch({ workspaceDir: v })} /></Row>
        <Row id="theme" title="Theme">
          <Segmented value={s.theme} label="Theme" testIdPrefix="theme" onChange={(v) => void patch({ theme: v })} options={[{ id: 'system', label: 'System' }, { id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }]} />
        </Row>
        {!isServerRuntime && (
          <>
            <Row id="quick-ask" title="Quick Ask shortcut" sub="A small SahilBot bar over any app.">
              <select className="set-select" value={s.quickKey} onChange={(e) => void patch({ quickKey: e.target.value })} data-testid="quick-key" aria-label="Quick Ask shortcut">
                <option value="Alt+Space">⌥ Space</option><option value="Control+Space">⌃ Space</option><option value="CommandOrControl+Shift+Space">⌘⇧ Space</option><option value="Alt+Shift+Space">⌥⇧ Space</option><option value="">Off</option>
              </select>
            </Row>
            <Row id="menu-bar" title="Show in the menu bar" sub="See what bots are doing from any app."><Toggle on={s.menuBarIcon ?? true} onChange={(v) => void patch({ menuBarIcon: v })} label="Show SahilBot in the menu bar" testId="menu-bar-icon" /></Row>
            <Row id="open-at-login" title="Open at login" sub={loginHint}><Toggle on={s.openAtLogin ?? false} onChange={(v) => void patch({ openAtLogin: v })} label="Open at login" testId="open-at-login" /></Row>
            <UpdatesRow />
          </>
        )}
      </Section>

      {api.phoneAccess && <div data-setting="phone-access"><PhoneAccessSection /></div>}

      <Disclosure title="More" sub="Appearance, routines and web search" testId="general-more">
        <Section title="Appearance">
          <Row id="density" title="Step detail" sub="How much of the agent's work shows in a chat.">
            <Segmented value={a.density} label="Step detail" onChange={(v) => look({ density: v })} options={[{ id: 'compact', label: 'Compact' }, { id: 'detailed', label: 'Detailed' }]} />
          </Row>
          <Row id="chat-width" title="Chat width"><Slider min={600} max={1200} step={20} value={a.chatWidth} label="Chat width" onChange={(v) => look({ chatWidth: v })} left="Narrow" mid={`${a.chatWidth}px`} right="Wide" /></Row>
          <Row id="code-wrap" title="Wrap long code lines"><Toggle on={a.codeWrap} onChange={(v) => look({ codeWrap: v })} label="Wrap long code lines" /></Row>
          <Row id="tint" title="Accent tint" sub={a.tint ? `${a.tint}% strength` : 'Off'}>
            <div className="hue-row">
              <Slider min={0} max={360} value={a.hue} label="Tint color" onChange={(v) => look({ hue: v, tint: a.tint || 30 })} />
              <span className="hue-swatch" style={{ background: `hsl(${a.hue} 70% 55%)` }} />
              <Slider min={0} max={100} value={a.tint} label="Tint strength" onChange={(v) => look({ tint: v })} />
            </div>
          </Row>
          <Row id="reduce-transparency" title="Reduce transparency"><Toggle on={a.reduceTransparency} onChange={(v) => look({ reduceTransparency: v })} label="Reduce transparency" /></Row>
          {!isServerRuntime && <Row id="animate-browser" title="Animate browser actions" sub="Show a cursor animation when you’re watching SahilBot’s browser.">
            <Toggle on={s.advanced.animateBrowser === true} onChange={(v) => void patch({ advanced: { ...s.advanced, animateBrowser: v } })} label="Animate browser actions" />
          </Row>}
          <Row id="font-size" title="Text size">
            <div className="stepper">
              <button onClick={() => look({ fontSize: Math.max(12, a.fontSize - 1) })} aria-label="Smaller">−</button>
              <span>{a.fontSize}</span>
              <button onClick={() => look({ fontSize: Math.min(20, a.fontSize + 1) })} aria-label="Larger">+</button>
            </div>
          </Row>
        </Section>
        <Section title="Routines">
          {!isServerRuntime && <Row id="keep-awake" title="Keep the Mac awake while bots work" info="Only while a chat or routine is running. Closing the lid still sleeps (see the next setting)."><Toggle on={s.keepAwakeWhileWorking ?? true} onChange={(v) => void patch({ keepAwakeWhileWorking: v })} label="Keep the Mac awake while bots work" testId="keep-awake" /></Row>}
          {!isServerRuntime && <LidAwakeRow on={s.lidAwake === true} onChanged={() => void patch({})} />}
          <Row id="catch-up" title="Catch up on missed routines" info="If SahilBot was closed or the Mac was asleep, each missed routine runs once if it was due within this window.">
            <select className="set-select" value={s.catchUpHours ?? 12} onChange={(e) => void patch({ catchUpHours: Number(e.target.value) })} data-testid="catch-up" aria-label="Catch up on missed routines">
              {CATCH_UP.map(([h, label]) => <option key={h} value={h}>{label}</option>)}
            </select>
          </Row>
          <Row id="routines-paused" title="Pause all routines"><Toggle on={s.routinesPaused ?? false} onChange={(v) => void patch({ routinesPaused: v })} label="Pause all routines" testId="routines-paused" /></Row>
        </Section>
        <Section title="Web search">
          <Row id="web-search" title="Search with" info="Automatic uses the best one available. Brave and SearXNG need a key or an address.">
            <select className="set-select" value={s.search.provider} aria-label="Web search provider" onChange={(e) => void patch({ search: { ...s.search, provider: e.target.value as Settings['search']['provider'] } })}>
              <option value="auto">Automatic</option><option value="duckduckgo">DuckDuckGo (no key)</option><option value="brave">Brave Search API</option><option value="searxng">SearXNG</option><option value="none">Off</option>
            </select>
          </Row>
          {s.search.provider === 'brave' && (
            <Row title="Brave API key"><div className="key-edit">
              <input className="set-input" type="password" value={braveKey} aria-label="Brave API key" onChange={(e) => setBraveKey(e.target.value)} placeholder={s.search.hasBraveKey ? '•••••••• saved' : 'Paste key'} />
              <button className="btn" disabled={!braveKey} onClick={() => void patch({ braveKey }).then(() => { setBraveKey(''); toast('Saved', 'ok') })}>Save</button>
            </div></Row>
          )}
          {s.search.provider === 'searxng' && <Row title="SearXNG address"><Field value={s.search.searxngUrl} placeholder="http://localhost:8888" label="SearXNG address" onSave={(v) => void patch({ search: { ...s.search, searxngUrl: v } })} /></Row>}
        </Section>
      </Disclosure>
    </>
  )
}

/** Settings → General: this version, and the newer one when there is one (downloaded and checked in the background). */
function UpdatesRow() {
  const [st, setSt] = useState<UpdateStatus | null>(null)
  const [notes, setNotes] = useState(false)
  useEffect(() => {
    void api.update.status().then(setSt).catch(() => undefined)
    return api.update.onStatus(setSt)
  }, [])
  const text = !st ? 'Checking…'
    : st.state === 'checking' ? 'Checking for a new version…'
    : st.state === 'downloading' ? `Downloading ${st.version}${st.size ? ` (${bytesText(st.size)})` : ''}… ${st.progress ?? 0}%`
    : st.state === 'ready' ? `${st.version}${st.size ? ` (${bytesText(st.size)})` : ''} is ready. The old version is removed once the new one has run for a minute, so only one SahilBot stays installed. Your chats, bots, connected apps and settings stay as they are, and a copy of your data is saved first.`
    : st.state === 'installing' ? 'Backing up your data and restarting…'
    : st.state === 'error' || st.state === 'unsupported' ? st.detail ?? 'Couldn\'t check for updates.'
    : st.state === 'idle' ? `SahilBot ${st.current ?? ''}. New versions are checked for and downloaded on their own.`
    : `SahilBot ${st.current ?? ''} is up to date.`
  return (
    <>
      <Row id="updates" title="Updates" sub={text} testId="updates-row">
        {st?.state === 'ready'
          ? <button className="btn primary" onClick={() => void api.update.install().then(setSt).catch((e: Error) => toast(clean(e), 'error'))} data-testid="update-install">Restart to update</button>
          : <button className="btn" disabled={st?.state === 'checking' || st?.state === 'downloading' || st?.state === 'installing' || st?.state === 'unsupported'} onClick={() => void api.update.check().then(setSt)} data-testid="update-check">Check now</button>}
        <button className="btn" onClick={() => setNotes((v) => !v)} aria-expanded={notes} data-testid="whats-new-toggle">{notes ? 'Hide what\'s new' : 'What\'s new'}</button>
      </Row>
      {notes && <WhatsNewList current={st?.current} />}
    </>
  )
}

// ------------------------------------------------------------------ models & keys

function modelName(m: ModelInfo): string { return m.label || m.id }

/** Cloud model facts: "1M context · $4 / $20 per M tokens". */
function cloudFacts(m: ModelInfo): string {
  const tok = (n: number): string => (n >= 1_000_000 ? `${n / 1_000_000}M` : `${Math.round(n / 1000)}K`)
  const usd = (n: number): string => `$${n < 1 ? n.toFixed(2) : n}`
  return [m.contextTokens ? `${tok(m.contextTokens)} context` : '', m.price ? `${usd(m.price.input)} / ${usd(m.price.output)} per M tokens${m.price.cacheRead !== undefined ? ` (cached ${usd(m.price.cacheRead)})` : ''}` : '', m.priceEstimated ? 'pricing estimated' : ''].filter(Boolean).map((x) => ` · ${x}`).join('')
}

/** Size on disk as Ollama reports it ("18.2 GB"). */
const diskGB = (bytes: number): string => `${(bytes / 1e9).toFixed(bytes >= 10e9 ? 0 : 1)} GB`

function ModelsPage({ s, models, patch, onRefresh }: P & { models: ModelList | null; onRefresh: () => void }) {
  const [providers, setProviders] = useState<Array<{ id: string; keyUrl?: string }>>([])
  useEffect(() => void api.providers().then(setProviders).catch(() => undefined), [])
  const link = (id: string): string | undefined => providers.find((p) => p.id === id)?.keyUrl
  const test = (baseUrl: string) => async (k?: string): Promise<string> => {
    const r = await api.models.test(baseUrl, k)
    return r.ok ? 'ok' : keyError(clean({ message: r.error ?? '' }))
  }
  const saveKey = (id: ProviderId) => async (k: string | null): Promise<void> => { await patch({ setKeys: { [id]: k } }); onRefresh() }
  const saved = (id: ProviderId): boolean => !!(s.keysSaved?.[id] ?? (s.keys as Record<string, boolean | undefined>)[id])
  const off = (id: ProviderId): boolean => !!s.disabledProviders?.includes(id)
  /** On/off for a provider with a key saved: off keeps the key and stops using its models. */
  const power = (id: ProviderId, name: string): ReactNode => saved(id) && (
    <Toggle on={!off(id)} label={`Use ${name}`} testId={`provider-on-${id}`}
      onChange={(v) => void patch({ disabledProviders: v ? (s.disabledProviders ?? []).filter((x) => x !== id) : [...new Set([...(s.disabledProviders ?? []), id])] }).then(onRefresh)} />
  )
  const openai = s.providers.openai.baseUrl.trim() || 'https://api.openai.com/v1'
  const status = (id: string): ReactNode => {
    const p = models?.providers?.find((x) => x.id === id)
    if (saved(id as ProviderId) && off(id as ProviderId)) return <span className="tier-badge">Off · key kept</span>
    return p && (s.keys as Record<string, boolean | undefined>)[id] ? <span className={`tier-badge${p.ok ? ' ok' : ''}`}>{p.ok ? 'Connected' : 'Not connected'}</span> : null
  }
  const installed = (models?.models ?? []).filter((m) => m.installed)
  const usable = installed.filter((m) => !new Set(s.hiddenModels).has(m.id) && (m.fits || m.maxFittingWindow >= 16384))
  const grok = installed.filter((m) => m.provider === 'xai')
  return (
    <>
      <h2>Models &amp; Keys</h2>
      <div className="set-sub">Connect at least one. Auto picks the right model for each request.</div>
      <Section title="Connect" sub="Switch a provider off to stop using it. Its key stays saved.">
        <div data-setting="provider-switches" />
        <Row id="key-anthropic" title={<>Claude{status('anthropic')}</>} sub={<>Anthropic API key · <a href={link('anthropic') ?? 'https://console.anthropic.com/settings/keys'} target="_blank" rel="noreferrer">get one</a></>} info="Used for every model named “claude-…”. Spending counts toward your monthly limit.">
          <KeyField saved={saved('anthropic')} placeholder="sk-ant-…" testId="key-anthropic" onSave={saveKey('anthropic')} onTest={test('https://api.anthropic.com/v1')} />
          {power('anthropic', 'Claude')}
        </Row>
        <Row id="key-openai" title={<>OpenAI{status('openai')}</>} sub={<>OpenAI API key · <a href={link('openai') ?? 'https://platform.openai.com/api-keys'} target="_blank" rel="noreferrer">get one</a></>} info="GPT models at cost; also voice and meaning search when you allow them. Spending counts toward your monthly limit.">
          <KeyField saved={saved('openai')} placeholder="sk-…" testId="key-openai" onSave={saveKey('openai')} onTest={test(openai)} />
          {power('openai', 'OpenAI')}
        </Row>
        <Row id="key-xai" title={<>Grok{status('xai')}</>} sub={<>xAI API key · <a href={link('xai') ?? 'https://console.x.ai'} target="_blank" rel="noreferrer">get one</a></>}
          info={<>Used for models named “grok-…”. Auto uses Grok for documents and knowledge work after Claude, and as a later choice elsewhere.{grok.length ? ` Available: ${grok.map(modelName).join(', ')}.` : ''}</>}>
          <KeyField saved={saved('xai')} placeholder="xai-…" testId="key-xai" onSave={saveKey('xai')} onTest={test('https://api.x.ai/v1')} />
          {power('xai', 'Grok')}
        </Row>
      </Section>
      <div data-setting="chatgpt-plan"><ChatgptPlanSettings onRefresh={onRefresh} /></div>
      {api.runtime !== 'server' && <GrokPlanSettings onRefresh={onRefresh} />}

      <Section title="How models are used">
        <Row id="auto-prefers" title="Auto prefers" info="Best prioritizes the quality of the result. Price breaks close ties. Balanced and Cheapest give cost more weight.">
          <Segmented value={s.cloud.autoPrefers ?? 'best'} label="Auto prefers" testIdPrefix="auto-prefers" onChange={(v) => void patch({ cloud: { ...s.cloud, autoPrefers: v } })}
            options={[{ id: 'best', label: 'Best' }, { id: 'balanced', label: 'Balanced' }, { id: 'cheapest', label: 'Cheapest' }]} />
        </Row>
        <div data-setting="local-models"><LocalModelsRow s={s} patch={patch} onChanged={onRefresh} /></div>
      </Section>
      <div data-setting="monthly-limit"><SpendingLimitSection s={s} patch={patch} /></div>
      {localIsOn(s) && <RecommendedLocal s={s} models={models} onRefresh={onRefresh} />}

      <Disclosure title="Advanced" sub="Defaults, routing, fast mode, model list, servers and tool keys" testId="models-advanced">
        <Section title="Defaults">
          <Row id="default-model" title="Model for new chats" info="Auto picks a fast model for quick chats and a stronger one for real tasks. Each chat can pick its own.">
            <select className="set-select" value={s.defaultModel} onChange={(e) => void patch({ defaultModel: e.target.value, ...(isAutoModel(e.target.value) ? { thinking: 'auto' as const } : {}) })} data-testid="default-model" aria-label="Model for new chats">
              <option value="auto">Auto (recommended)</option>
              {localIsOn(s) && <option value="auto:local">Auto (local only)</option>}
              <option value="auto:cloud">Auto (cloud only)</option>
              {usable.map((m) => <option key={m.id} value={m.id}>{modelName(m)}</option>)}
            </select>
          </Row>
          {/* A thinking choice can override Auto model routing independently. */}
          {<Row id="thinking" title="Thinking for new chats" info="For the model picked above. Auto leans high for real tasks and low for quick chats. Chats can choose their own.">
            <select className="set-select" value={s.thinking} onChange={(e) => void patch({ thinking: e.target.value as Settings['thinking'] })} data-testid="default-thinking" aria-label="Thinking for new chats">
              <option value="auto">Auto (recommended)</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">Extra</option><option value="max">Max</option>
            </select>
          </Row>}
          <Row id="background-model" title="Model for background jobs" sub="Chat titles and other tiny jobs.">
            <select className="set-select" value={s.taskModels.background} aria-label="Model for background jobs" onChange={(e) => void patch({ taskModels: { ...s.taskModels, background: e.target.value } })}>
              <option value="">Smallest local model</option>
              {usable.filter((m) => m.note !== 'remote').map((m) => <option key={m.id} value={m.id}>{modelName(m)}</option>)}
            </select>
          </Row>
        </Section>
        <CloudRouting s={s} patch={patch} installed={installed} />
        <div data-setting="fast-mode"><FastModeSection s={s} patch={patch} models={models} /></div>
        <Section title="Computer use"><div data-setting="computer-use"><ComputerUseSetting s={s} usable={usable} patch={patch} /></div></Section>
        <ModelList s={s} models={models} patch={patch} onRefresh={onRefresh} />
        <Servers s={s} patch={patch} models={models} onChanged={onRefresh} test={test} link={link} />
        <ToolKeys s={s} patch={patch} />
      </Disclosure>
    </>
  )
}

/** Cloud on/off, hybrid, local-or-cloud first and Claude's own options (Models → Advanced). */
function CloudRouting({ s, patch, installed }: P & { installed: ModelInfo[] }) {
  const remote = installed.filter((m) => m.note === 'remote')
  return (
    <Section title="Cloud">
      <Row id="cloud-enabled" title="Use cloud models" sub={localIsOn(s) ? 'Off: nothing is ever sent to a cloud model.' : 'Off: with local models off too, there\'s no model to chat with.'}>
        <Toggle on={s.cloud.enabled} onChange={(v) => void patch({ cloud: { ...s.cloud, enabled: v } })} label="Use cloud models" testId="cloud-enabled" />
      </Row>
      {s.cloud.enabled && localIsOn(s) && (
        <Row id="hybrid" title="Hybrid: local model asks the cloud" info="Your local model does the work and can ask a cloud model for a plan or help when it's stuck: a few short questions per request.">
          {s.cloud.hybrid && (
            <select className="set-select" value={s.cloud.advisorModel} aria-label="Hybrid advisor" onChange={(e) => void patch({ cloud: { ...s.cloud, advisorModel: e.target.value } })} data-testid="advisor-model">
              <option value="">Best Opus</option>
              <option value="sonnet">Best Sonnet (cheaper)</option>
              {remote.filter((m) => m.enabled).map((m) => <option key={m.id} value={m.id}>{modelName(m)}</option>)}
            </select>
          )}
          <Toggle on={s.cloud.hybrid} onChange={(v) => void patch({ cloud: { ...s.cloud, hybrid: v } })} label="Hybrid mode" testId="cloud-hybrid" />
        </Row>
      )}
      {s.cloud.enabled && remote.length > 0 && (
        <div data-setting="cloud-routing">
          <Row title="Local or cloud first" info="Cloud first (the default once a cloud key is saved): Auto picks among cloud models by the kind of task. Local first: free local models for quick chats whenever one is strong enough; agent work still goes to the strongest cloud model.">
            <select className="set-select" value={s.cloud.prefer ?? (s.keys.anthropic ? 'cloud' : 'local')} aria-label="Local or cloud first" onChange={(e) => void patch({ cloud: { ...s.cloud, prefer: e.target.value as 'local' | 'cloud' } })} data-testid="cloud-prefer">
              <option value="local">Local first</option><option value="cloud">Cloud first</option>
            </select>
          </Row>
          <Row title="Cloud context" info="Maximum uses up to one million tokens when the provider supports it. Older turns are summarized as the conversation approaches its limit.">
                <select className="set-select" value={s.cloud.contextStrategy ?? 'max'} aria-label="Cloud context" onChange={(e) => void patch({ cloud: { ...s.cloud, contextStrategy: e.target.value as 'max' | 'balanced' | 'economy' } })} data-testid="claude-context-strategy">
                  <option value="max">Maximum (1M)</option><option value="balanced">Balanced (400K)</option><option value="economy">Economy (128K)</option>
                </select>
              </Row>
          {s.keys.anthropic && (
            <>
              <Row title="Claude's native tools" info="Claude's own computer-use, editor, terminal and web search tools, through SahilBot's same approvals. Web search then runs on Anthropic's servers ($10 per 1,000 searches).">
                <Toggle on={s.cloud.nativeTools !== false} onChange={(v) => void patch({ cloud: { ...s.cloud, nativeTools: v } })} label="Claude's native tools" testId="claude-native-tools" />
              </Row>
              <Row title="Use Fable for the hardest tasks" info="Auto sends the hardest requests to Claude Fable (priced well above Opus). Off: Fable only when you pick it.">
                <Toggle on={!!s.cloud.fableForHardest} onChange={(v) => void patch({ cloud: { ...s.cloud, fableForHardest: v } })} label="Use Fable for the hardest tasks" testId="claude-fable-hardest" />
              </Row>
            </>
          )}
        </div>
      )}
    </Section>
  )
}

/** Every model that can run: on/off for the picker and Auto, its context window, delete (Ollama), add by name. */
function ModelList({ s, models, patch, onRefresh }: P & { models: ModelList | null; onRefresh: () => void }) {
  const [q, setQ] = useState('')
  const [all, setAll] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const installed = (models?.models ?? []).filter((m) => m.installed)
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
  return (
    <Section title="Models in the picker" sub="Switch one off to keep it out of the picker and Auto." testId="model-list">
      <div className="set-search" data-setting="model-list">
        <input className="set-input" placeholder="Add or search model" aria-label="Add or search model" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addModel()} data-testid="model-search" />
        {q.trim() && !installed.some((m) => m.id === q.trim()) && <button className="btn" onClick={addModel}>Add “{q.trim()}”</button>}
        <button className="icon-btn" title="Refresh" aria-label="Refresh models" onClick={onRefresh}><I.Reply size={15} style={{ transform: 'scaleX(-1)' }} /></button>
      </div>
      {!models && <div className="set-empty">Loading models…</div>}
      {models && installed.length === 0 && <div className="set-empty">No models yet. Add a key above.</div>}
      {list.map((m) => (
        <div className="set-row" key={m.id} data-testid="model-row">
          <div className="set-row-text">
            <div className="set-row-title">{modelName(m)}</div>
            <div className="set-row-sub">{m.providerName} · {TIER[m.tier]}{m.vision ? ' · sees images' : ''}{m.note === 'remote' ? ` · cloud${cloudFacts(m)}` : m.sizeBytes ? ` · ${diskGB(m.sizeBytes)} on disk` : m.requiredGB ? ` · ${m.requiredGB} GB` : ''}{!m.fits && m.note && m.note !== 'remote' ? ` · ${m.note}` : ''}</div>
          </div>
          <ModelContextSelect model={m} s={s} patch={patch} />
          {m.provider === 'ollama' && m.note !== 'remote' && (deleting === m.id ? <span className="spin" />
            : <button className="icon-btn" title={`Delete ${m.id}`} aria-label={`Delete ${m.id}`} onClick={() => void remove(m)} data-testid={`model-delete-${m.id}`}><I.Trash size={15} /></button>)}
          <Toggle on={m.enabled} onChange={(v) => setOn(m.id, v)} label={`Show ${m.id}`} testId={`model-toggle-${m.id}`} />
        </div>
      ))}
      {!q && shown.length > 12 && <button className="link-btn set-more" onClick={() => setAll((x) => !x)}>{all ? 'Show fewer' : `View all ${shown.length} models`}</button>}
      {s.customModels.length > 0 && (
        <div className="set-row-sub" style={{ padding: '8px 4px 2px' }}>Added by you: {s.customModels.map((id) => {
          const off = models?.models.find((m) => m.id === id && !m.installed)
          return (
            <button key={id} className="chip-btn" style={{ marginLeft: 6 }} title={off?.note ? `Not in the picker: ${off.note}` : 'Remove'} onClick={() => void patch({ customModels: s.customModels.filter((x) => x !== id) }).then(onRefresh)}>
              {id}{off?.note ? ` (${off.note.toLowerCase()})` : ''} ×
            </button>
          )
        })}</div>
      )}
    </Section>
  )
}

/** Local models on: the downloads picked for this Mac, and Ollama setup when it isn't running. */
function RecommendedLocal({ s, models, onRefresh }: { s: Settings; models: ModelList | null; onRefresh: () => void }) {
  const [pull, setPull] = useState<Record<string, { pct: number; status: string; error?: string }>>({})
  const [picks, setPicks] = useState<Record<string, string>>({})
  useEffect(() => { void api.models.setupPicks().then((ps) => setPicks(Object.fromEntries(ps.map((p) => [p.pull, p.role])))).catch(() => undefined) }, [models])
  useEffect(() => api.models.onPull((e) => {
    setPull((p) => ({ ...p, [e.tag]: { pct: e.total ? Math.round(((e.completed ?? 0) / e.total) * 100) : p[e.tag]?.pct ?? 0, status: e.status, error: e.error } }))
    if (e.done && !e.error) { toast(`${e.tag} is ready`, 'ok'); onRefresh() }
    if (e.error) toast(e.error, 'error')
  }), [onRefresh])
  const recommended = recommendedRows(models)
  const ollama = models?.providers?.find((p) => p.id === 'ollama')
  if (!s.providers.ollama.enabled || (!recommended.length && (!ollama || ollama.ok))) return null
  return (
    <Section title="Recommended for this Mac" sub={`Free models sized for this Mac${models ? ` (${models.totalGB} GB of memory)` : ''}. Auto starts using them right away.`}>
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
              <div className="set-row-sub">{m.blurb}{m.installed ? ` · Downloaded${m.sizeBytes ? ` · ${diskGB(m.sizeBytes)}` : ''}` : ` · ${m.note}`}</div>
              {busy && <div className="meter" style={{ marginTop: 6 }}><i style={{ width: `${pr.pct}%` }} /></div>}
            </div>
            {m.installed ? <span className="hint">Installed</span>
              : busy ? <span className="hint">{pr.pct ? `${pr.pct}%` : pr.status}</span>
              : <button className="btn" disabled={!fits} title={fits ? `Download ${m.pull} with Ollama` : 'Needs more memory than this Mac has'} onClick={() => { setPull((p) => ({ ...p, [m.pull!]: { pct: 0, status: 'starting' } })); void api.models.pull(m.pull!) }} data-testid={`pull-${m.id}`}>Download</button>}
          </div>
        )
      })}
    </Section>
  )
}

const SETUP_PHASE: Record<string, string> = { download: 'Downloading Ollama…', verify: 'Checking it with Apple\'s security check…', install: 'Installing…', start: 'Starting Ollama…', done: 'Ollama is running.' }

/** Ollama isn't running: install it if needed and start it, in one click. */
function OllamaSetup({ onReady }: { onReady: () => void }) {
  const [st, setSt] = useState<{ phase: string; pct?: number; error?: string } | null>(null)
  const [installed, setInstalled] = useState<boolean | null>(null)
  useEffect(() => void api.ollama.installed().then(setInstalled), [])
  useEffect(() => api.ollama.onSetup((e) => { setSt(e); if (e.phase === 'done') onReady() }), [onReady])
  const busy = st && !st.error && st.phase !== 'done'
  return (
    <Row title={installed ? 'Start Ollama' : 'Set up local models'} sub={st?.error ?? (st ? `${SETUP_PHASE[st.phase] ?? ''}${st.phase === 'download' && st.pct ? ` ${st.pct}%` : ''}` : installed ? 'Installed but not running.' : 'Installs Ollama (free, about 230 MB) and runs it in the background.')}>
      {busy ? <span className="spin" /> : <button className="btn primary" onClick={() => { setSt({ phase: installed ? 'start' : 'download' }); void api.ollama.setup() }} data-testid="settings-ollama-setup">{st?.error ? 'Try again' : installed ? 'Start' : 'Set up'}</button>}
    </Row>
  )
}

/** OpenRouter, an OpenAI-compatible gateway, Ollama, LM Studio and a custom server (Models → Advanced). */
function Servers({ s, patch, models, onChanged, test, link }: P & { models: ModelList | null; onChanged: () => void; test: (u: string) => (k?: string) => Promise<string>; link: (id: string) => string | undefined }) {
  const [override, setOverride] = useState(!!s.providers.openai.baseUrl)
  const saveKey = (id: ProviderId) => async (k: string | null): Promise<void> => { await patch({ setKeys: { [id]: k } }); onChanged() }
  const status = (id: string): string | undefined => {
    const p = models?.providers?.find((x) => x.id === id)
    return p ? (p.ok ? `Running · ${p.count} model${p.count === 1 ? '' : 's'}` : 'Not running') : undefined
  }
  const local = (id: 'ollama' | 'lmstudio', name: string, sub: string) => (
    <>
      <Row title={<>{name}{status(id) && <span className={`tier-badge${status(id)!.startsWith('Running') ? ' ok' : ''}`}>{status(id)}</span>}</>} sub={sub}><Toggle on={s.providers[id].enabled} onChange={(v) => void patch({ providers: { ...s.providers, [id]: { ...s.providers[id], enabled: v } } }).then(onChanged)} label={name} testId={`provider-${id}`} /></Row>
      {s.providers[id].enabled && <Row title={`${name} address`}><Field value={s.providers[id].baseUrl} width={260} testId={`${id}-url`} label={`${name} address`} onSave={(v) => void patch({ providers: { ...s.providers, [id]: { ...s.providers[id], baseUrl: v } } }).then(onChanged)} /></Row>}
    </>
  )
  return (
    <Section title="Servers and gateways">
      <div data-setting="servers">
        <Row title="OpenRouter" sub={<>Then add models by name above · <a href={link('openrouter') ?? 'https://openrouter.ai/keys'} target="_blank" rel="noreferrer">get a key</a></>}>
          <KeyField saved={s.keys.openrouter} placeholder="sk-or-…" testId="key-openrouter" onSave={saveKey('openrouter')} onTest={test('https://openrouter.ai/api/v1')} />
        </Row>
        <Row title="Send OpenAI requests to another gateway" info="Any OpenAI-compatible gateway; your OpenAI key is sent there.">
          <Toggle on={override} onChange={(v) => { setOverride(v); if (!v) void patch({ providers: { ...s.providers, openai: { baseUrl: '' } } }).then(onChanged) }} label="Override OpenAI base URL" />
        </Row>
        {override && <Row title="Gateway URL"><Field value={s.providers.openai.baseUrl} width={280} label="Gateway URL" placeholder="https://my-gateway.example.com/v1" onSave={(v) => void patch({ providers: { ...s.providers, openai: { baseUrl: v } } }).then(onChanged)} /></Row>}
        {localIsOn(s) && local('ollama', 'Ollama', 'Usually http://localhost:11434/v1')}
        {localIsOn(s) && local('lmstudio', 'LM Studio', 'Start the server in LM Studio’s Developer tab.')}
        {localIsOn(s) && s.providers.lmstudio.enabled && <Row title="LM Studio API key" sub="Only with “Require API key” on in LM Studio."><KeyField saved={s.keys.lmstudio} placeholder="Optional" testId="key-lmstudio" onSave={saveKey('lmstudio')} onTest={test(s.providers.lmstudio.baseUrl)} /></Row>}
        <Row title="Custom server" sub="Any OpenAI-compatible server: llama.cpp, vLLM, another Mac.">
          <Toggle on={s.providers.custom.enabled} onChange={(v) => void patch({ providers: { ...s.providers, custom: { ...s.providers.custom, enabled: v } } }).then(onChanged)} label="Custom server" testId="provider-custom" />
        </Row>
        {s.providers.custom.enabled && (
          <>
            <Row title="Name"><Field value={s.providers.custom.name} label="Server name" onSave={(v) => void patch({ providers: { ...s.providers, custom: { ...s.providers.custom, name: v || 'Custom server' } } })} /></Row>
            <Row title="Base URL"><Field value={s.providers.custom.baseUrl} width={260} testId="custom-url" label="Server base URL" onSave={(v) => void patch({ providers: { ...s.providers, custom: { ...s.providers.custom, baseUrl: v } } }).then(onChanged)} /></Row>
            <Row title="API key" sub="Leave empty if it has none."><KeyField saved={s.keys.custom} placeholder="Optional" testId="key-custom" onSave={saveKey('custom')} onTest={test(s.providers.custom.baseUrl)} /></Row>
          </>
        )}
      </div>
    </Section>
  )
}

/** Keys for tools (market data, The Blue Alliance, Onshape): Models → Advanced. Cursor is under Connected apps. */
function ToolKeys({ s, patch }: P) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const testOnshape = async (): Promise<void> => {
    if (!api.cad) return
    setMsg({ ok: true, text: 'Checking…' })
    const r = await api.cad.onshapeTest().catch((e: Error) => ({ ok: false, name: undefined, error: e.message }))
    setMsg(r.ok ? { ok: true, text: `Working${r.name ? ` · ${r.name}` : ''}` } : { ok: false, text: (r.error ?? 'Could not connect.').split('. Fix:')[0].slice(0, 160) })
  }
  const saveOnshape = (field: 'onshapeAccessKey' | 'onshapeSecretKey') => async (k: string | null): Promise<void> => { setMsg(null); await patch({ [field]: k } as never) }
  const market = [['tiingo', 'Tiingo', 'https://www.tiingo.com/account/api/token', 'Free: full daily price history'], ['polygon', 'Polygon', 'https://polygon.io/dashboard/api-keys', 'Daily history and delayed quotes'], ['alphavantage', 'Alpha Vantage', 'https://www.alphavantage.co/support/#api-key', 'Quotes and history'], ['finnhub', 'Finnhub', 'https://finnhub.io/dashboard', 'Live quotes and news']] as const
  return (
    <Section title="Keys for tools" sub="Only for the tools that use them. SEC filings need no key.">
      <div data-setting="tool-keys">
        {market.map(([id, name, url, sub]) => (
          <Row key={id} title={<a href={url} target="_blank" rel="noreferrer">{name}</a>} sub={sub}>
            <KeyField saved={!!s.markets?.keys?.[id]} placeholder={`${name} key`} testId={`key-market-${id}`} onSave={async (k) => { await patch({ marketKeys: { [id]: k } } as never) }} />
          </Row>
        ))}
        <Row title="Stock quotes from" info="Auto uses the first source above with a key. Without one, prices are the last daily close.">
          <select className="set-select" value={s.markets?.quoteProvider ?? 'auto'} aria-label="Stock quotes from" onChange={(e) => void patch({ markets: { ...(s.markets ?? { secContact: '' }), quoteProvider: e.target.value as never } } as never)} data-testid="quote-provider">
            {['auto', 'none', 'tiingo', 'polygon', 'alphavantage', 'finnhub'].map((v) => <option key={v} value={v}>{v === 'auto' ? 'Auto' : v === 'none' ? 'Daily closes only' : v === 'alphavantage' ? 'Alpha Vantage' : v[0].toUpperCase() + v.slice(1)}</option>)}
          </select>
        </Row>
        <Row title={<a href="https://www.thebluealliance.com/account" target="_blank" rel="noreferrer">The Blue Alliance</a>} sub="FRC match schedules, results and rankings."><KeyField saved={!!s.hasTbaKey} placeholder="TBA read key" testId="key-tba" onSave={async (k) => { await patch({ tbaKey: k }) }} /></Row>
        <Row title={<a href="https://dev-portal.onshape.com/keys" target="_blank" rel="noreferrer">Onshape access key</a>} info="Lets bots read your Onshape documents and, with your OK each time, change variables or configurations. Read scope to look; Write to change."><KeyField saved={!!s.onshapeKeyParts?.access} placeholder="Onshape access key" testId="key-onshape-access" onSave={saveOnshape('onshapeAccessKey')} /></Row>
        <Row title="Onshape secret key">
          <div className="key-saved">
            <KeyField saved={!!s.onshapeKeyParts?.secret} placeholder="Onshape secret key" testId="key-onshape-secret" onSave={saveOnshape('onshapeSecretKey')} />
            {s.hasOnshapeKeys && <button className="link-btn" onClick={() => void testOnshape()} data-testid="onshape-test">Test</button>}
            {msg && <span className={`conn ${msg.ok ? 'ok' : 'bad'}`} data-testid="onshape-test-msg">{msg.text}</span>}
          </div>
        </Row>
      </div>
    </Section>
  )
}

// ------------------------------------------------------------------ connected apps

function ConnectedPage({ s, patch }: P) {
  const [apps, setApps] = useState<Array<{ name: string; state: ConnectorStatus['state'] }> | null>(null)
  useEffect(() => {
    const load = (): void => void api.connectors.list().then((r) => {
      const st = new Map(r.statuses.map((x) => [x.id, x.state]))
      setApps(r.configs.map((c) => ({ name: c.name, state: st.get(c.id) ?? 'off' })).filter((a) => a.state !== 'off'))
    }).catch(() => setApps([]))
    load()
    return api.connectors.onChange(load)
  }, [])
  const live = (apps ?? []).filter((a) => a.state === 'connected')
  const waiting = (apps ?? []).filter((a) => a.state !== 'connected')
  return (
    <>
      <h2>Connected apps</h2>
      <div className="set-sub">Gmail, Calendar, Notion, Slack, GitHub and more. Bots use them when a task needs them.</div>
      <Section>
        <Row id="connect-apps" testId="connected-summary"
          title={apps === null ? 'Checking…' : live.length ? `${live.length} connected` : 'Nothing connected yet'}
          sub={apps === null ? undefined : [live.map((a) => a.name).join(', '), waiting.length ? `${waiting.length} need${waiting.length === 1 ? 's' : ''} attention: ${waiting.map((a) => a.name).join(', ')}` : ''].filter(Boolean).join(' · ') || 'One click each; you sign in with the app itself.'}>
          <button className="btn primary" onClick={() => window.dispatchEvent(new Event('sahilbot:open-connect'))} data-testid="settings-connect-apps">Connect apps</button>
        </Row>
      </Section>
      <Section title="Cursor" sub="Hand coding work to Cursor Cloud Agents on your GitHub repos. Cursor is connected only by its API key." testId="connect-cursor">
        <Row title={<>Cursor{s.hasCursorKey ? <span className="tier-badge ok">Connected</span> : <span className="tier-badge">Not connected</span>}</>}
          sub={<>Cursor API key · <a href="https://cursor.com/dashboard?tab=integrations" target="_blank" rel="noreferrer">get one</a></>}>
          <KeyField saved={s.hasCursorKey} placeholder="key_…" testId="connect-cursor-key" onSave={async (k) => { await patch({ cursorKey: k }) }} />
        </Row>
        {!isServerRuntime && (
          <Row title="Also run Cursor on this Mac" sub="Uses Cursor's command-line agent for folders on this Mac. Off: cloud agents only.">
            <Toggle on={!!s.cursorLocalAgent} onChange={(v) => void patch({ cursorLocalAgent: v })} label="Also run Cursor on this Mac" testId="cursor-local-agent" />
          </Row>
        )}
      </Section>
      {!isServerRuntime && (
        <Disclosure title="Let other apps use SahilBot" sub="MCP for Cursor and Claude, Shortcuts links" testId="connected-advanced">
          <div data-setting="mcp-server"><McpSettings /></div>
        </Disclosure>
      )}
    </>
  )
}

// ------------------------------------------------------------------ voice

const WHISPER_CHOICES: Array<[string, string]> = [
  ['auto', 'Auto (best for this Mac)'], ['small-q5_1', 'Whisper small, 5-bit · 190 MB'], ['small-q8_0', 'Whisper small, 8-bit · 264 MB'],
  ['medium-q5_0', 'Whisper medium, 5-bit · 539 MB'], ['large-v3-turbo-q5_0', 'Whisper large-v3-turbo, 5-bit · 574 MB'], ['large-v3-turbo-q8_0', 'Whisper large-v3-turbo, 8-bit · 874 MB']
]

/** Settings → Voice: the speech model picked for this Mac (it downloads itself), reading aloud, OpenAI's voice. */
function VoicePage({ s, models, patch }: P & { models: ModelList | null }) {
  const [voice, setVoice] = useState<VoiceStatus | null>(null)
  const [dl, setDl] = useState<{ progress: number; error?: string } | null>(null)
  useEffect(() => {
    const load = (): void => void api.voice.status().then(setVoice).catch(() => undefined)
    load()
    return api.voice.onEvent((e) => {
      if (e.type !== 'download') return
      if (e.kind === 'whisper') setDl({ progress: e.progress, error: e.error })
      if (e.done || e.error || e.kind !== 'whisper') load()
    })
  }, [s.voiceOutput?.provider, s.keys.openai, s.keys.xai, s.voiceOutput?.openai, s.local?.enabled, s.voiceInput?.model, s.voiceInput?.local])
  const sp = voice?.speech
  const usable = (models?.models ?? []).filter((m) => m.installed && m.enabled)
  const progress = dl && !dl.error ? dl.progress : sp?.progress
  const state = !sp ? null
    : sp.state === 'ready' ? <span className="conn ok"><I.Check size={13} /> Ready</span>
    : sp.state === 'off' ? <span className="hint">Off</span>
    : sp.state === 'error' || dl?.error ? <button className="btn" onClick={() => { setDl({ progress: 0 }); void api.voice.download('whisper') }} data-testid="voice-speech-retry">Retry</button>
    : <span className="set-progress" data-testid="voice-speech-progress"><span className="meter"><i style={{ width: `${Math.max(3, Math.round((progress ?? 0) * 100))}%` }} /></span><span className="hint">{progress ? `${Math.round(progress * 100)}%` : 'Downloading…'}</span></span>
  const speechSub = !sp ? 'Checking…'
    : sp.state === 'off' ? (voice?.input === 'openai' ? 'OpenAI transcribes (Transcribe on this Mac is off).' : voice?.inputNote ?? '')
    : sp.state === 'ready' ? `Runs on this Mac · ${sp.mb} MB${sp.bench ? ` · ${(sp.bench / 1000).toFixed(1)} s for a short sentence` : ''}`
    : sp.state === 'error' ? `Download failed: ${sp.error ?? dl?.error ?? 'try again'}`
    : `Downloading ${sp.mb} MB in the background${sp.using ? ` · ${sp.using.label} works meanwhile` : voice?.input === 'openai' ? ' · OpenAI transcribes meanwhile' : ''}`
  return (
    <>
      <h2>Voice</h2>
      <div className="set-sub">Dictate with ⌘⇧D, talk with ⌘⇧V, Esc stops speaking.</div>
      <Section>
        {localIsOn(s) && <Row id="speech-model" testId="voice-speech-model" title={sp ? <>{sp.label} <span className="hint" data-testid="voice-speech-reason">· {sp.reason}</span></> : 'Speech recognition'} sub={speechSub} info={sp?.why}>
          {state}
        </Row>}
        <Row id="read-aloud" title="Read replies aloud" sub="Or press the speaker on any message."><Toggle on={s.speakReplies} onChange={(v) => void patch({ speakReplies: v })} label="Read replies aloud" testId="speak-replies" /></Row>
        <div data-setting="voice-openai"><VoiceOutputRow s={s} patch={patch} /></div>
        <Row id="speaking-voice" title="Voices" sub="Pick a voice, its speed and your language in the voice bar: its settings button." />
      </Section>
      <Disclosure title="Advanced" sub="Speech model, local transcription and the voice model" testId="voice-advanced">
        <Section>
          {localIsOn(s) && <><Row id="transcribe-local" title="Transcribe on this Mac" sub="Off: OpenAI transcribes, when allowed above.">
            <Toggle on={s.voiceInput?.local === true} onChange={(v) => void patch({ voiceInput: { ...s.voiceInput, local: v } })} label="Transcribe on this Mac" testId="voice-local" />
          </Row>
          <Row id="whisper-model" title="Speech model" info="Auto: Whisper small on Macs under 16 GB, large-v3-turbo (5-bit) on 16–31 GB if a quick test says it's fast enough, large-v3-turbo (8-bit) on 32 GB and up. Models come from whisper.cpp's official repository and are checked against its checksums.">
            <select className="set-select" value={s.voiceInput?.model ?? 'auto'} aria-label="Speech model" onChange={(e) => void patch({ voiceInput: { ...s.voiceInput, model: e.target.value } })} data-testid="voice-whisper-model">
              {WHISPER_CHOICES.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
            </select>
          </Row>
          </>}
          <Row id="voice-model" title="Model for voice conversations" sub="A light model answers faster.">
            <select className="set-select" value={s.taskModels.voice} aria-label="Model for voice conversations" onChange={(e) => void patch({ taskModels: { ...s.taskModels, voice: e.target.value } })} data-testid="voice-model">
              <option value="">Same as chat (Auto)</option>
              {usable.map((m) => <option key={m.id} value={m.id}>{m.label || m.id} · {TIER[m.tier]}</option>)}
            </select>
          </Row>
          {voice && localIsOn(s) && !voice.binary && <Row title="Speech recognition isn't built" sub="Run scripts/voice-setup.sh once." />}
        </Section>
      </Disclosure>
    </>
  )
}

// ------------------------------------------------------------------ privacy & security


function PrivacySecurityPage({ s, patch, tab, onTab }: P & { tab: string; onTab: (t: string) => void }) {
  const tabs = [
    { id: 'passwords', label: 'Passwords' },
    { id: 'activity', label: 'Activity', hidden: isServerRuntime },
    { id: 'sensitive', label: 'Sensitive details' },
    { id: 'hybrid', label: 'Hybrid compute', hidden: isServerRuntime }
  ]
  const cur = tabs.find((t) => t.id === tab && !t.hidden)?.id ?? 'passwords'
  return (
    <>
      <h2>Privacy &amp; Security</h2>
      <div className="set-sub">Saved passwords, and what SahilBot may see and keep. What it may do on its own is under Permissions.</div>
      <Tabs value={cur} tabs={tabs} onChange={onTab} label="Privacy and security" />
      {cur === 'passwords' && <div data-setting="passwords">{onPhone
        ? <div className="set-sub" data-testid="vault-on-mac">Saved passwords, cards and authenticator codes stay on your Mac and are never sent to this phone. Manage them in SahilBot on the Mac.</div>
        : <SecretVaultSettings embedded />}</div>}
      {cur === 'activity' && <div data-setting="activity"><ActivitySettings /></div>}
      {cur === 'sensitive' && <SensitiveDetails />}
      {cur === 'hybrid' && <HybridComputeSettings />}
    </>
  )
}

// ------------------------------------------------------------------ permissions

const LEVELS: Array<{ id: 'ask' | 'auto'; title: string; sub: string; rec?: boolean }> = [
  { id: 'auto', title: 'Auto', rec: true, sub: 'Works on its own. Asks before spending money, using a password, deleting your things, emailing lots of people or posting in public.' },
  { id: 'ask', title: 'Ask first', sub: 'Checks with you before anything that changes something.' }
]

/** How much SahilBot does on its own, what the Mac lets it use, and rules for specific actions: one page. */
function PermissionsPage({ s, patch }: P) {
  const level = s.defaultMode === 'ask' ? 'ask' : 'auto'
  return (
    <>
      <h2>Permissions</h2>
      <div className="set-sub">What SahilBot may do without asking, and what your Mac lets it use.</div>
      <section className="set-section" data-setting="autonomy">
        <div className="set-label">New chats</div>
        <div className="perm-levels" role="radiogroup" aria-label="Permissions for new chats">
          {LEVELS.map((l) => (
            <button key={l.id} type="button" role="radio" aria-checked={level === l.id} className={`perm-level${level === l.id ? ' on' : ''}`}
              onClick={() => void patch({ defaultMode: l.id })} data-testid={`autonomy-${l.id}`}>
              <span className="perm-radio" aria-hidden />
              <span className="perm-level-text"><b>{l.title}</b>{l.rec && <span className="perm-rec">Recommended</span>}<span className="sub">{l.sub}</span></span>
            </button>
          ))}
        </div>
        <div className="perm-note"><I.Shield size={13} />Buying something, a password or a one-time code always needs you. Any chat can change this from the menu under its message box.</div>
      </section>
      <Section>
        <Row id="files-anywhere" title="Read and edit files anywhere" sub="Your files in any folder, without asking first. Deleting still asks (files go to the Trash), and system, private and secret places stay off limits.">
          <Toggle on={s.advanced.filesAnywhere !== false} onChange={(v) => void patch({ advanced: { ...s.advanced, filesAnywhere: v } })} label="Read and edit files anywhere" testId="files-anywhere" />
        </Row>
      </Section>
      {!isServerRuntime && <MacPermissions />}
      <Disclosure title="Rules for specific actions" sub="Always allow or always ask, Bypass and hard stops" testId="approvals-rules">
        <ApprovalsTab s={s} patch={patch} />
      </Disclosure>
    </>
  )
}

const PERM_ORDER: PermissionKind[] = ['microphone', 'accessibility', 'screen', 'notifications', 'automation', 'fullDisk']
const PERM_SHORT: Partial<Record<PermissionKind, string>> = {
  microphone: 'Talk to SahilBot and dictate.',
  accessibility: 'Use other apps for you: click, type and read their windows.',
  screen: 'See your screen while it works for you.',
  notifications: 'Tell you when a task is done or needs you.',
  automation: 'Permissions are granted per app when first used. Review them in System Settings.',
  fullDisk: 'Read Messages, Mail and Safari data when you ask. Optional.'
}

/** What macOS lets SahilBot use: one Allow button each, macOS's own prompt where it has one. */
/** "Allow all": macOS's own prompt for each one in turn (the ones that need System Settings open it last). */
const NOTE_ASKING = 'macOS is asking: in the notification at the top right of your screen, click Allow (or Options → Allow).'
const ALLOW_ALL_ORDER: PermissionKind[] = ['notifications', 'microphone', 'automation', 'accessibility', 'screen', 'fullDisk']

export function MacPermissions({ title = 'Your Mac', sub = 'Turn on only what you want SahilBot to use. You can change these any time.' }: { title?: string; sub?: string } = {}) {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof api.permissions.status>> | null>(null)
  const [asked, setAsked] = useState<Partial<Record<PermissionKind, string>>>({})
  const [busy, setBusy] = useState(false)
  const refresh = (): void => void api.permissions.status().then(setRows).catch(() => setRows([]))
  useEffect(() => {
    refresh()
    // Back from System Settings or a macOS prompt: show the new state.
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])
  const allow = (kind: PermissionKind): void => {
    if (kind === 'notifications') setAsked((a) => ({ ...a, notifications: NOTE_ASKING }))
    void api.permissions.request(kind).then((r) => {
      const note = kind === 'notifications'
        ? (r === 'granted' ? '' : r === 'denied' ? 'macOS has notifications off for SahilBot. Use Open Settings, choose SahilBot and turn on Allow notifications.' : r === 'prompted' ? NOTE_ASKING : '')
        : ''
      setAsked((a) => ({ ...a, [kind]: note || (r === 'opened' ? 'Turn on SahilBot in the window that opened, then come back.' : r === 'denied' ? 'macOS said no. Use Open Settings to change it.' : '') }))
      setTimeout(refresh, 800)
      // macOS's question is still open: check again while the user answers it.
      if (kind === 'notifications' && r === 'prompted') for (const ms of [3000, 8000, 15000, 30000, 60000]) setTimeout(refresh, ms)
    }).catch((e) => toast(clean(e), 'error'))
  }
  const sorted = (rows ?? []).slice().sort((a, b) => PERM_ORDER.indexOf(a.kind) - PERM_ORDER.indexOf(b.kind))
  const missing = sorted.filter((r) => r.state !== 'granted')
  const allowAll = async (): Promise<void> => {
    setBusy(true)
    for (const kind of ALLOW_ALL_ORDER) {
      if (!missing.some((r) => r.kind === kind)) continue
      await api.permissions.request(kind).catch(() => undefined)
      await new Promise((r) => setTimeout(r, 700))
    }
    setBusy(false)
    refresh()
    toast('macOS asked for each one. In System Settings, turn on SahilBot for Full Disk Access and Screen Recording, then reopen SahilBot.', 'ok')
  }
  return (
    <Section title={title} sub={sub}>
      <div data-setting="mac-permissions">
        {rows !== null && (
          <Row title={missing.length ? 'Turn on everything' : 'Everything is on'} sub={missing.length ? 'Asks macOS for each permission SahilBot uses, one after another.' : 'SahilBot can use everything it needs on this Mac.'} testId="perm-all">
            {missing.length > 0 && <button className="btn primary" disabled={busy} onClick={() => void allowAll()} data-testid="perm-allow-all">{busy ? 'Asking…' : 'Allow all'}</button>}
          </Row>
        )}
        {rows === null ? <Row title="Checking…" /> : sorted.map((r) => {
          const on = r.state === 'granted'
          const title = r.kind === 'automation' ? 'Mac apps' : r.title
          return (
            <Row key={r.kind} title={title} sub={asked[r.kind] || PERM_SHORT[r.kind] || r.enables} info={[r.enables, r.how, r.detail].filter(Boolean).join(' ')} testId={`perm-${r.kind}`}>
              {on
                ? <span className="perm-on" data-testid={`perm-${r.kind}-on`}><I.Check size={13} />On</span>
                : <>
                    {asked[r.kind] && <button className="link-btn" onClick={() => void api.permissions.open(r.kind)}>Open Settings</button>}
                    <button className="btn" onClick={() => allow(r.kind)} data-testid={`perm-${r.kind}-allow`}>{r.kind === 'automation' ? 'Open Settings' : r.kind === 'notifications' ? 'Turn on' : 'Allow'}</button>
                  </>}
            </Row>
          )
        })}
      </div>
    </Section>
  )
}

/**
 * Hybrid compute: cloud models plan and research while personal details stay on this Mac. Off until the user
 * turns it on, on a Mac that meets the requirements; turning it on downloads PII-Tracer (the Privacy Gate).
 */
function HybridComputeSettings() {
  const [st, setSt] = useState<PrivacyStatus | null>(null)
  const [progress, setProgress] = useState<PrivacyInstallEvent | null>(null)
  const [test, setTest] = useState<{ running?: boolean; text?: string; error?: string } | null>(null)
  useEffect(() => { void api.privacy.status().then(setSt).catch(() => undefined) }, [])
  useEffect(() => api.privacy.onInstall((e) => { setProgress(e); if (e.phase === 'done' || e.phase === 'error') void api.privacy.status().then(setSt) }), [])
  const gb = st ? (st.downloadBytes / 1e9).toFixed(1) : '1.2'
  const install = (): void => { setProgress({ phase: 'download', pct: 0 }); void api.privacy.install().then(setSt).catch((e) => { setProgress({ phase: 'error', error: clean(e) }) }) }
  const busy = !!st?.installing || (!!progress && progress.phase !== 'done' && progress.phase !== 'error')
  const turn = (on: boolean): void => {
    void api.privacy.setEnabled(on).then((next) => { setSt(next); if (on && !next.installed && !busy) install() }).catch((e) => toast(clean(e), 'error'))
  }
  const r = st?.requirements
  const macLine = !r ? 'Checking this Mac…'
    : `This Mac: ${r.ramGB} GB memory, ${r.freeDiskGB} GB free disk. ` + (!r.meetsMinimum ? r.problem ?? '' : r.meetsBest ? 'Runs the top local models at full quality.' : `Meets the minimum. ${HYBRID_BEST.ramGB} GB memory and ${HYBRID_BEST.diskGB} GB free disk run the top local models at full quality.`)
  const gate = !st ? 'Checking…'
    : busy ? (progress?.phase === 'download' ? `Downloading PII-Tracer… ${progress.pct ?? 0}%` : progress?.phase === 'verify' ? 'Checking the download…' : 'Starting PII-Tracer…')
    : !st.enabled ? 'Off'
    : !st.installed ? `PII-Tracer isn't downloaded yet (${gb} GB).`
    : !st.hybrid ? 'Ready. It starts checking once you have both a local model and a cloud model set up (Settings → Models).'
    : 'On: checks every cloud request in chats on this Mac.'
  return (
    <Section sub="Cloud models plan, research and reason; anything personal stays on this Mac. Before a cloud model sees a request, the Privacy Gate checks it on this Mac with PII-Tracer. Names, contact details, account numbers, secrets and documents like bank statements or bills pause the chat and ask: process it on your Mac, let the cloud plan with stand-ins while a local model handles the details, share it, or skip it. Saved passwords and cards stay usable: the vault never shows their values to any model." testId="settings-hybrid">
      <div data-setting="hybrid-compute">
        <Row title="Hybrid compute" sub={macLine} info={`Minimum: Apple Silicon, ${HYBRID_MIN.ramGB} GB memory, ${HYBRID_MIN.diskGB} GB free disk for the local models and PII-Tracer. Best: ${HYBRID_BEST.ramGB} GB and ${HYBRID_BEST.diskGB} GB for the strongest local models at full quality.`} testId="hybrid-on">
          <Toggle on={!!st?.enabled} disabled={!st || (!st.enabled && !r?.meetsMinimum)} onChange={turn} label="Hybrid compute" testId="hybrid-toggle" />
        </Row>
        <Row title="Privacy Gate" sub={<>{gate}{progress?.phase === 'error' ? <span className="ui-text-danger"> · {progress.error}</span> : null}</>} info="PII-Tracer is Perplexity's open-source 0.6B personal-data detector (MIT), run by llama.cpp on this Mac. Every file is checked against a pinned SHA-256. What it checks never leaves your Mac." testId="privacy-gate-model">
          {st?.enabled && !st.installed && !busy && <button className="btn primary" onClick={install} data-testid="privacy-gate-install">Download ({gb} GB)</button>}
          {st?.installed && !busy && st.enabled && (
            <button className="btn" disabled={test?.running} data-testid="privacy-gate-test" title="Runs a made-up sample (a name, email, phone, card and address) through PII-Tracer on this Mac"
              onClick={() => { setTest({ running: true }); void api.privacy.selfTest().then((r) => setTest({ text: r.found.length ? `Caught ${r.found.length} in ${(r.ms / 1000).toFixed(1)} s: ${r.found.map((f) => `${f.label.toLowerCase().replace(/_/g, ' ')} “${f.text}”`).join(', ')}` : 'It caught nothing in the sample: the gate may not be working. Remove the download and download it again.' })).catch((e) => setTest({ error: clean(e) })) }}>
              {test?.running ? 'Testing…' : 'Test'}
            </button>
          )}
          {st?.installed && !busy && !st.enabled && <button className="btn" onClick={() => void api.privacy.remove().then(setSt)} data-testid="privacy-gate-remove">Remove download</button>}
        </Row>
        {test && !test.running && <div className={`hint${test.error ? ' ui-text-danger' : ''}`} style={{ margin: '0 0 10px' }} data-testid="privacy-gate-test-result">{test.error ?? test.text}</div>}
        {st?.enabled && st.installed && (
          <Row title="When it finds personal details" sub={st.mode === 'auto'
            ? 'Protect automatically: cloud models get stand-ins like [PERSON_1] (a personal record like a bank statement moves to the model on your Mac), the chat carries on, and a note says what was protected.'
            : 'Ask me: the chat pauses on a card so you choose for each new detail.'} testId="privacy-gate-mode">
            <Segmented value={st.mode} options={[{ id: 'ask', label: 'Ask me' }, { id: 'auto', label: 'Protect automatically' }]} onChange={(m) => void api.privacy.setMode(m).then(setSt).catch((e) => toast(clean(e), 'error'))} label="When it finds personal details" testIdPrefix="privacy-mode" />
          </Row>
        )}
        {st?.enabled && st.installed && (
          <Row title="Today" sub={st.today.requests
            ? `Checked ${st.today.checked.toLocaleString()} new part${st.today.checked === 1 ? '' : 's'} of conversations in ${st.today.requests.toLocaleString()} check${st.today.requests === 1 ? '' : 's'} on this Mac · asked you ${st.today.asked} time${st.today.asked === 1 ? '' : 's'} · protected ${st.today.protected} automatically · ${st.today.cleared} cleared as not personal (by you before, or the model on your Mac)${st.today.errors ? ` · ${st.today.errors} check${st.today.errors === 1 ? '' : 's'} failed (nothing unchecked was sent)` : ''}`
            : 'Nothing checked yet today.'} testId="privacy-gate-today">
            {st.remembered > 0 && <button className="btn" onClick={() => void api.privacy.forgetNotPersonal().then(setSt)} title="Details you marked as not personal are shared without asking in every chat" data-testid="privacy-forget">Forget {st.remembered} “not personal”</button>}
          </Row>
        )}
        {busy && progress?.phase === 'download' && <div className="meter" style={{ margin: '0 0 8px' }}><i style={{ width: `${progress.pct ?? 0}%` }} /></div>}
      </div>
    </Section>
  )
}

/** The context engine's sensitive categories: what bots may remember about health, money, beliefs… (all on by default). */
function SensitiveDetails() {
  const [st, setSt] = useState<ContextEngineStatus | null>(null)
  useEffect(() => { try { void api.people.status().then(setSt).catch(() => undefined) } catch { /* not in this runtime */ } }, [])
  const set = (id: string, on: boolean): void => {
    void api.people.setSettings({ sensitive: { [id]: on } } as never).then(setSt).catch((e) => toast(clean(e), 'error'))
  }
  return (
    <>
      <Section sub="What memory and People & Places may keep when you mention it. Passwords, codes, card, account and ID numbers are never kept." testId="settings-sensitive">
        <div data-setting="sensitive">
          {!st ? <Row title="Loading…" /> : SENSITIVE_CATEGORIES.map((c) => (
            <Row key={c.id} title={c.label} sub={c.hint || undefined}>
              <Toggle on={st.settings.sensitive[c.id]} onChange={(v) => set(c.id, v)} label={`Remember ${c.label}`} testId={`settings-sens-${c.id}`} />
            </Row>
          ))}
        </div>
      </Section>
    </>
  )
}

const RULE_EXAMPLES: Array<{ when: string; action: 'allow' | 'ask' }> = [
  { when: 'send email', action: 'ask' },
  { when: 'npm install', action: 'allow' },
  { when: 'post', action: 'ask' },
  { when: 'tool:run_command git status', action: 'allow' }
]

/** Autonomy for new chats, and "When SahilBot wants to …, it should allow automatically / ask first" (Ask first wins). */
function ApprovalsTab({ s, patch }: P) {
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
      <Section title="Approval rules" sub="Decide ahead of time what SahilBot may do on its own and what always needs your OK.">
        <div className="ar-form" data-setting="approval-rules">
          <label htmlFor="rule-when">When SahilBot wants to:<InfoTip>A rule matches when every word in it appears in the action (its name, what it will do, or its details); “sends”, “sending” and “sent” all count as “send”. tool:run_command matches one tool by name (* is a wildcard); “quoted words” must appear exactly. If an Ask first rule and an Allow rule both match, SahilBot asks.</InfoTip></label>
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
          {group('ask', 'Ask first', 'Even in Auto.')}
          {group('allow', 'Allow automatically', 'Deleting, payments and sign-in changes still ask.')}
        </>
      )}
      <Section title="Bypass">
          <Row id="bypass" title="Bypass confirmed" info="Bypass runs everything without asking, except purchases, passwords and one-time codes, which always need you. Pick it in a chat's Permissions menu; the first time, SahilBot asks you to confirm. It resets to Auto when SahilBot restarts. Turn this off to be asked again.">
            <Toggle on={!!s.advanced.allowBypass} onChange={(v) => void patch({ advanced: { ...s.advanced, allowBypass: v } })} label="Bypass confirmed" testId="allow-bypass" />
          </Row>
          <Row title="Hard stops in Bypass" sub="Also ask before security settings, permanent deletes, mass sends and public posts in Bypass. Purchases, passwords and one-time codes always ask.">
            <Toggle on={s.advanced.hardStopsEnabled} onChange={(v) => void patch({ advanced: { ...s.advanced, hardStopsEnabled: v } })} label="Hard stops" />
          </Row>
      </Section>
    </>
  )
}

// ------------------------------------------------------------------ advanced

function AdvancedPage({ s, models, patch, spaces, tab, onTab }: P & { models: ModelList | null; spaces: Space[]; tab: string; onTab: (t: string) => void }) {
  const tabs = [{ id: 'rules', label: 'Rules & skills' }, { id: 'knowledge', label: 'Knowledge folders' }, { id: 'developer', label: 'Developer' }]
  const cur = tabs.some((t) => t.id === tab) ? tab : 'rules'
  return (
    <>
      <h2>Advanced</h2>
      <div className="set-sub">Rules every chat follows, folders bots can search, and model tuning.</div>
      <Tabs value={cur} tabs={tabs} onChange={onTab} label="Advanced" />
      {cur === 'rules' && <RulesSkills spaces={spaces} />}
      {cur === 'knowledge' && <div data-setting="knowledge"><KnowledgeSettings embedded /></div>}
      {cur === 'developer' && <Developer s={s} models={models} patch={patch} />}
    </>
  )
}

function RulesSkills({ spaces }: { spaces: Space[] }) {
  const [rules, setRules] = useState<Rule[]>([])
  const [skills, setSkills] = useState<Skill[]>([])
  const [newRule, setNewRule] = useState({ name: '', text: '', scope: 'everywhere' })
  const [edit, setEdit] = useState<{ name: string; description: string; body: string; isNew: boolean } | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const reload = (): void => { void api.rules.list().then(setRules); void api.skills.list().then(setSkills) }
  useEffect(reload, [])
  const scopeName = (sc: string): string => sc === 'everywhere' ? 'All chats' : sc.startsWith('bot:') ? `Bot: ${spaces.find((x) => x.id === sc.slice(4))?.name ?? 'removed'}` : `Project: ${spaces.find((x) => x.id === sc.slice(8))?.name ?? 'removed'}`
  const cats = [...new Set(rules.map((r) => r.category))].sort((a, b) => a.localeCompare(b))
  const catOf = (k: Skill): string => k.source === 'builtin' ? k.category ?? 'Built in' : k.source === 'learned' ? 'Learned by SahilBot' : 'Yours'
  // Built-in skills show as a few groups with a count, nothing inside: the agent uses them on its own.
  const builtinGroups = BUILTIN_GROUPS.map((g) => ({ ...g, n: skills.filter((k) => k.source === 'builtin' && builtinGroup(k.category) === g.id).length })).filter((g) => g.n > 0)
  const skillCats = [...new Set(skills.filter((k) => k.source !== 'builtin').map(catOf))].sort((a, b) => a.localeCompare(b))
  return (
    <>
      <div className="set-sub" data-setting="rules">Rules are instructions every chat follows; skills are procedures a bot reads when a task calls for one. Changes apply to new chats.</div>
      <Section title="Rules">
        {cats.map((c) => {
          const rs = rules.filter((r) => r.category === c)
          return (
            <Disclosure key={c} title={c} sub={`${rs.filter((r) => r.enabled).length} of ${rs.length} on`}>
              {rs.map((r) => (
                <div className="set-row" key={r.name} data-testid="rule-row">
                  <div className="set-row-text">
                    <div className="set-row-title">{r.name.replace(/-/g, ' ')} <span className="tier-badge">{r.source === 'builtin' ? 'built in' : r.source === 'learned' ? 'learned' : 'yours'}</span>{r.scope !== 'everywhere' && <span className="tier-badge">{scopeName(r.scope)}</span>}</div>
                    <ClampText>{r.text}</ClampText>
                  </div>
                  {r.source !== 'builtin' && <button className="icon-btn" title="Delete rule" aria-label={`Delete rule ${r.name}`} onClick={() => void api.rules.remove(r.name).then(reload)}><I.Trash size={14} /></button>}
                  <Toggle on={r.enabled} onChange={(v) => void api.rules.setEnabled(r.name, v).then(reload)} label={r.name} />
                </div>
              ))}
            </Disclosure>
          )
        })}
        <Disclosure title="Add a rule" testId="rule-add-open">
          <div className="vault-add">
            <input className="set-input" placeholder="Short name" aria-label="Rule name" value={newRule.name} onChange={(e) => setNewRule({ ...newRule, name: e.target.value })} />
            <select className="set-select" value={newRule.scope} aria-label="Applies to" onChange={(e) => setNewRule({ ...newRule, scope: e.target.value })}>
              <option value="everywhere">All chats</option>
              {spaces.filter((x) => !x.isMain).map((x) => <option key={x.id} value={`${x.kind === 'project' ? 'project' : 'bot'}:${x.id}`}>{x.kind === 'project' ? 'Project' : 'Bot'}: {x.name}</option>)}
            </select>
          </div>
          <textarea className="set-input" rows={2} aria-label="Rule" placeholder='e.g. "Always write emails in a warm, short style and sign them Sahil."' value={newRule.text} onChange={(e) => setNewRule({ ...newRule, text: e.target.value })} data-testid="rule-text" />
          <div className="set-search"><button className="btn" disabled={!newRule.name.trim() || !newRule.text.trim()} onClick={() => void api.rules.save(newRule).then(() => { setNewRule({ name: '', text: '', scope: 'everywhere' }); reload() })} data-testid="rule-save">Add rule</button></div>
        </Disclosure>
      </Section>
      <Section title="Skills">
        <div data-setting="skills" />
        {builtinGroups.map((g) => (
          <div key={g.id} className="set-row" data-testid={`skill-group-${g.id}`}>
            <div className="set-row-text">
              <div className="set-row-title">{g.label} <span className="tier-badge">built in</span></div>
              <div className="set-row-sub">{g.n} skill{g.n === 1 ? '' : 's'} for {g.what}. SahilBot uses them by itself when a task needs one.</div>
            </div>
          </div>
        ))}
        {skillCats.map((c) => {
          const ks = skills.filter((k) => catOf(k) === c)
          return (
            <Disclosure key={c} title={c} sub={`${ks.length}`}>
              {ks.map((k) => (
                <div key={k.name} data-testid="skill-row">
                  <div className="set-row">
                    <div className="set-row-text" style={{ cursor: 'pointer' }} onClick={() => setOpen(open === k.name ? null : k.name)}>
                      <div className="set-row-title">{k.name.replace(/-/g, ' ')}</div>
                      <div className="set-row-sub">{k.description}{k.uses ? ` · used ${k.uses}×` : ''}</div>
                    </div>
                    <button className="link-btn" onClick={() => setEdit({ name: k.name, description: k.description, body: k.body, isNew: false })}>{k.source === 'builtin' ? 'Customize' : 'Edit'}</button>
                    {k.source !== 'builtin' && <button className="icon-btn" title="Delete skill" aria-label={`Delete skill ${k.name}`} onClick={() => { if (confirm(`Delete the skill "${k.name}"?`)) void api.skills.remove(k.name).then(reload) }}><I.Trash size={14} /></button>}
                  </div>
                  {open === k.name && <pre className="skill-body">{k.body}</pre>}
                </div>
              ))}
            </Disclosure>
          )
        })}
        <div className="set-row"><div className="set-row-text"><div className="set-row-sub">Write your own procedure.</div></div><button className="btn" onClick={() => setEdit({ name: '', description: '', body: '1. ', isNew: true })} data-testid="skill-new">New skill</button></div>
      </Section>
      {edit && (
        <div className="skill-editor" data-testid="skill-editor">
          <input className="set-input" placeholder="name-with-dashes" aria-label="Skill name" value={edit.name} disabled={!edit.isNew} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
          <input className="set-input" placeholder="When to use it (one sentence)" aria-label="When to use it" value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} />
          <textarea className="set-input" rows={10} placeholder="Steps" aria-label="Steps" value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} />
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

/** macOS lets the GPU use about 75% of memory; local models can use up to 90% when this is on. */
function GpuRow() {
  const [g, setG] = useState<{ totalGB: number; limitMB: number } | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => void api.models.gpu().then(setG).catch(() => undefined), [])
  if (!g) return null
  const pct = g.limitMB ? Math.round((g.limitMB / 1024 / g.totalGB) * 100) : 75
  const set = (percent: number, keep: boolean): void => {
    setBusy(true)
    void api.models.setGpuLimit(percent, keep).then((r) => { setG({ ...g, limitMB: r.limitMB }); toast(percent ? 'Local models can now use up to 90% of memory' : 'Back to the macOS default', 'ok') })
      .catch((e) => toast(clean(e), 'error')).finally(() => setBusy(false))
  }
  return (
    <Row id="gpu" title="GPU memory for local models" sub={`Now about ${pct}% of ${g.totalGB} GB.`} info="Raising it to 90% lets bigger local models and longer contexts run. macOS asks for your password; leave enough for your other apps.">
      <div className="key-edit">
        {g.limitMB ? <button className="btn" disabled={busy} onClick={() => set(0, false)}>Reset</button> : null}
        <button className="btn" disabled={busy} onClick={() => set(90, true)} data-testid="gpu-90">Use 90%</button>
      </div>
    </Row>
  )
}

function Developer({ s, models, patch }: P & { models: ModelList | null }) {
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
      <Section>
        <Row id="dev-mode" title="Developer mode" sub="Show detailed steps, tokens and cost in chats, and the models and thinking levels behind replies in every chat.">
          <Toggle on={!!s.advanced.devMode} onChange={(v) => void patch({ advanced: { ...s.advanced, devMode: v } })} label="Developer mode" testId="dev-mode" />
        </Row>
      </Section>
      <Section title="Local models">
        <Row id="context-window" title="Context window" info="How much of the conversation a local model holds. Auto gives each model up to 64K on Macs with 48 GB or more and 32K on smaller ones, never more than fits in memory.">
          <div className="seg">{WINDOWS.map((w) => <button key={w} className={s.contextWindow === w ? 'on' : ''} onClick={() => void patch({ contextWindow: w })}>{w ? `${w / 1024}K` : 'Auto'}</button>)}</div>
        </Row>
        {localIsOn(s) && !isServerRuntime && <GpuRow />}
      </Section>
      <Section title="Sampling" sub="Blank uses the model card's recommended values.">
        <Row id="sampling" title="For model">
          <select className="set-select" value={samplingModel} aria-label="Sampling for model" onChange={(e) => setSamplingModel(e.target.value)}>
            {(models?.models ?? []).filter((m) => m.installed).map((m) => <option key={m.id} value={m.id}>{m.label || m.id}</option>)}
          </select>
        </Row>
        {SAMPLING_KEYS.map((k) => (
          <Row key={`${samplingModel}-${k}`} title={k}><Field value={sampling[k] === undefined ? '' : String(sampling[k])} width={110} type="number" label={k} placeholder="model card" onSave={(v) => setSampling(k, v)} /></Row>
        ))}
      </Section>
    </>
  )
}

/**
 * Keep working with the lid closed (off by default). Turning it on asks macOS for an administrator once
 * (main/lid-awake.ts); a refusal leaves it off and says why.
 */
function LidAwakeRow({ on, onChanged }: { on: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const set = async (v: boolean): Promise<void> => {
    setBusy(true)
    try {
      const r = await api.alwaysOn.setLidAwake(v)
      if (!r.ok) toast(r.error ?? 'Couldn\'t turn it on.', 'error')
      else if (v) toast('On: the Mac keeps working with the lid closed while bots run, and for 5 minutes after.', 'ok')
    } catch (e) { toast(clean(e), 'error') } finally { setBusy(false); onChanged() }
  }
  return (
    <Row id="lid-awake" title="Keep working with the lid closed" info="While a chat, bot or routine is working (and for 5 minutes after it finishes), the Mac stays awake even with the lid shut, then sleeps as usual. The first time, macOS asks for an administrator password. It lets the Mac sleep below 20% battery; don't leave a working Mac in a closed bag.">
      <Toggle on={on} disabled={busy} onChange={(v) => void set(v)} label="Keep working with the lid closed" testId="lid-awake" />
    </Row>
  )
}
