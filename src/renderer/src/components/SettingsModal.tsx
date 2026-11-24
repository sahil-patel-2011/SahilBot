import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { WhatsNewList } from './WhatsNew'
import { downloadedText } from '@shared/bytes'
import type { ConnectorStatus, ModelInfo, ModelList, PermissionKind, ProviderId, Settings, Space, SystemInfo, UpdateStatus, VoiceStatus } from '@shared/types'
import { api, isServerRuntime } from '../api'
import * as I from '../icons'
import { toast } from '../lib/toast'
import { Toggle } from './Toggle'
import { ModelContextSelect } from './ModelContextSelect'
import { recommendedRows } from '@shared/model-picker'
import { MemoryPage } from './MemoryManager'
import { SecretVaultSettings } from './VaultSettings'
import { BackupSettings } from './BackupSettings'
import { UsagePage } from './UsagePage'
import { SpendingLimitSection } from './SpendingLimit'
import { McpSettings } from './McpSettings'
import { ChatgptPlanSettings } from './ChatgptPlanSettings'
import { GrokPlanSettings } from './GrokPlanSettings'
// Local models are opt-in: one quiet row when they're off, no download prompts (components/LocalModels.tsx).
import { LocalModelsRow, VoiceOutputRow, localIsOn } from './LocalModels'
import { AlwaysOnServerPage, PhoneAccessSection, PhonePage, ServerPage } from './ServerSettings'
import { ClampText, Disclosure, InfoTip, Segmented, SetTabs as Tabs } from './ui'
import { useDevMode } from '../lib/dev-mode'
import { SECTION_HINT, SECTION_OF, LEGACY_PAGES, PAGE_TITLES, SETTINGS_INDEX, searchSettings, type SettingEntry, type SettingsPage } from '../lib/settings-index'
import '../styles-approvals.css'
import '../styles-purchase.css'

// Settings: nine pages, each with the few choices most people want on top and everything rarely used
// behind one "Advanced" (or "More") row. Every option starts at the best choice, so most people never
// need to come here. Every change saves right away (keys go to the Keychain). Search finds any setting
// (lib/settings-index.ts) and jumps to it, opening its tab and any closed disclosure on the way.

type Page = SettingsPage
const PAGES: Array<{ id: Page; icon: ReactNode; color: string }> = [
  { id: 'general', icon: <I.Smile size={14} />, color: '#8e8e93' },
  { id: 'models', icon: <I.Cpu size={14} />, color: '#5856d6' },
  { id: 'connected', icon: <I.Plug size={14} />, color: '#007aff' },
  { id: 'memory', icon: <I.Sparkle size={14} />, color: '#34c759' },
  { id: 'privacy', icon: <I.Shield size={14} />, color: '#5ac8fa' },
  { id: 'voice', icon: <I.Mic size={14} />, color: '#ff2d55' },
  // SahilBot Server: devices, pairing, notifications, audit (web UI); in the Mac app, the link to a server.
  { id: 'server', icon: <I.Globe size={14} />, color: '#1f8a5b' }
]
/**
 * SahilBot is a desktop app first: the phone and always-on server pages only show once one is in use (or in
 * Developer mode), so the list stays short. Everything else is one flat list; search finds any setting.
 */
/** A phone using the Mac (Phone access) sees its own page where SahilBot Server's browsers see the server's. */
const onPhone = isServerRuntime && api?.serverHost === 'mac'
const pageTitle = (id: Page): string => (id === 'server' && isServerRuntime ? (onPhone ? 'This phone' : 'Server') : PAGE_TITLES[id])

const TIER = ['Instant', 'Light', 'Standard', 'Heavy']
const clean = (e: unknown): string => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export type SettingsPatchUi = Parameters<typeof api.settings.set>[0]

/** A page id, a legacy one ("keys", "passwords"…) or "page:tab" → the page and tab to open. */
export function resolvePage(id?: string): { page: Page; tab?: string } {
  if (!id) return { page: 'general' }
  if (LEGACY_PAGES[id]) return LEGACY_PAGES[id]
  const [p, tab] = id.split(':')
  if (LEGACY_PAGES[p]) return LEGACY_PAGES[p]
  return p in SECTION_OF ? { page: p as Page, tab } : { page: 'general' }
}

// ------------------------------------------------------------------ building blocks

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
  /** The section on screen: some pages (Spending, What it may do, Advanced) live inside another one. */
  const section = SECTION_OF[page] ?? 'general'
  // Opened at a page that lives inside a section (a link to Spending, say): scroll to it there.
  useEffect(() => {
    const sub: Partial<Record<Page, string>> = { usage: 'usage', permissions: 'permissions-page', advanced: 'advanced-page' }
    if (page !== section && sub[page]) setJump((j) => j ?? sub[page]!)
  }, [page, section])
  const [tabs, setTabs] = useState<Partial<Record<Page, string>>>(start.tab ? { [start.page]: start.tab } : {})
  const [find, setFind] = useState('')
  const [jump, setJump] = useState<string | null>(anchored?.anchor ?? null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const dev = useDevMode()
  const [remoteInUse, setRemoteInUse] = useState(false)
  useEffect(() => {
    if (isServerRuntime) return
    void Promise.all([api.phoneAccess?.status().then((x) => x.enabled).catch(() => false), api.remoteServer?.status().then((x) => x.linked).catch(() => false)])
      .then(([a, b]) => setRemoteInUse(!!a || !!b))
  }, [])
  const showServer = isServerRuntime || dev || remoteInUse || page === 'server'
  const pages = PAGES.filter((x) => (!isServerRuntime || x.id !== 'voice') && (x.id !== 'server' || showServer))
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
            {pages.map((p) => (
              <button key={p.id} className={`set-nav-item${section === p.id ? ' on' : ''}`} onClick={() => go(p.id)} data-testid={`settings-${p.id}`}>
                <span className="set-tile" style={{ background: p.color }}>{p.icon}</span>
                <span className="set-nav-text"><span>{pageTitle(p.id)}</span>{SECTION_HINT[p.id] && <small>{SECTION_HINT[p.id]}</small>}</span>
              </button>
            ))}
          </>}
          {sys && <div className="set-nav-foot">SahilBot {sys.appVersion}</div>}
        </nav>
        <div className="set-body" ref={bodyRef} data-page={page} key={section}>
          {section === 'general' && <>
            {/* The basics only (at most ~8 settings). Look, routines, web search, rules and developer options are gone
                from here: the bot picks sensible defaults, and anything else you just ask it for in chat. */}
            <General s={s} patch={patch} />
          </>}
          {section === 'models' && <>
            <ModelsPage s={s} models={models} patch={patch} onRefresh={onRefreshModels} />
            <div data-setting="usage" className="set-subpage"><UsagePage /></div>
          </>}
          {section === 'connected' && <ConnectedPage s={s} patch={patch} />}
          {section === 'memory' && <MemoryPage spaces={spaces ?? []} tab={tabs.memory ?? 'memories'} onTab={setTab('memory')} />}
          {section === 'voice' && <VoicePage s={s} models={models} patch={patch} />}
          {section === 'privacy' && <>
            <div data-setting="permissions-page"><PermissionsPage s={s} patch={patch} /></div>
            <div className="set-subpage"><PrivacySecurityPage s={s} patch={patch} tab={tabs.privacy ?? 'passwords'} onTab={setTab('privacy')} /></div>
          </>}
          {section === 'server' && <div data-setting="server">{isServerRuntime ? (onPhone ? <PhonePage /> : <ServerPage />) : <AlwaysOnServerPage />}</div>}
        </div>
      </div>
    </div>
  )
}

type P = { s: Settings; patch: (p: SettingsPatchUi) => Promise<Settings> }

// ------------------------------------------------------------------ general

/** Phone access (preview): shown once it's turned on, or in Developer mode. SahilBot is a desktop app first. */
function PhoneAccessWhenUsed() {
  const dev = useDevMode()
  const [on, setOn] = useState(false)
  useEffect(() => { void api.phoneAccess?.status().then((x) => setOn(x.enabled)).catch(() => undefined) }, [])
  return dev || on ? <div data-setting="phone-access"><PhoneAccessSection /></div> : null
}

function General({ s, patch }: P) {
  const [login, setLogin] = useState<string | null>(null)
  useEffect(() => { if (!isServerRuntime) void api.alwaysOn.status().then((st) => setLogin(st.loginItem)).catch(() => undefined) }, [s.openAtLogin])
  const loginHint = login === 'requires-approval' ? 'Allow SahilBot in System Settings → General → Login Items.' : login === 'unsupported' ? 'Works in the installed app.' : 'Starts hidden in the menu bar.'
  return (
    <>
      <h2>You</h2>
      <div className="set-sub">What SahilBot calls you, how it looks, and how it starts. Changes save as you go.</div>
      <Section>
        <Row id="user-name" title="Your name" sub="SahilBot calls you by your first name.">
          <div style={{ display: 'flex', gap: 6 }}>
            <Field value={s.profile?.firstName ?? s.userName} width={130} placeholder="First name" label="First name" testId="me-first" onSave={(v) => void patch({ profile: { firstName: v, lastName: s.profile?.lastName ?? '' } })} />
            <Field value={s.profile?.lastName ?? ''} width={130} placeholder="Last name" label="Last name" testId="me-last" onSave={(v) => void patch({ profile: { firstName: s.profile?.firstName ?? s.userName, lastName: v } })} />
          </div>
        </Row>
        <Row id="birthday" title="Birthday" sub="Optional. Used for reminders and sign-in later; stays on this Mac.">
          <Field value={s.profile?.birthday ?? ''} type="date" width={170} label="Birthday" testId="me-birthday" onSave={(v) => void patch({ profile: { firstName: s.profile?.firstName ?? s.userName, lastName: s.profile?.lastName ?? '', birthday: v } })} />
        </Row>
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
            <Row id="open-at-login" title="Open at login" sub={loginHint}><Toggle on={s.openAtLogin ?? false} onChange={(v) => void patch({ openAtLogin: v })} label="Open at login" testId="open-at-login" /></Row>
            <UpdatesRow />
          </>
        )}
      </Section>

      {api.phoneAccess && <PhoneAccessWhenUsed />}

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
    : st.state === 'downloading' ? `Getting the update… ${st.progress ?? 0}%${st.size ? ` · ${downloadedText(st.received ?? ((st.progress ?? 0) / 100) * st.size, st.size)}` : ''}`
    : st.state === 'ready' ? 'Ready. Restart to finish: your chats, bots and settings stay as they are, and a copy is saved first.'
    : st.state === 'installing' ? 'Saving a copy of your data and restarting…'
    : st.state === 'error' || st.state === 'unsupported' ? st.detail ?? 'Couldn\'t check for updates.'
    : st.state === 'idle' ? 'New versions download on their own.'
    : 'You\'re up to date.'
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
  const grok = installed.filter((m) => m.provider === 'xai')
  return (
    <>
      <h2>AI &amp; spending</h2>
      <div className="set-sub">Connect at least one. Auto picks the right model for each request. Keys are encrypted with your Mac's Keychain and kept through updates.</div>
      {s.keysLocked && (
        <div className="banner" role="status" data-testid="keys-locked">
          <span className="banner-text"><b>{s.keysLocked.count === 1 ? '1 saved key is' : `${s.keysLocked.count} saved keys are`} locked right now, not lost.</b> macOS Keychain didn't answer (it may still be locked after login). Don't re-enter them: unlock your Mac and press Retry.</span>
          <span className="banner-actions"><button className="btn small primary" onClick={() => void api.settings.get().then((n) => { void patch({}); if (!n.keysLocked) toast('Your keys are back.', 'ok') })}>Retry</button></span>
        </div>
      )}
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
      <div data-setting="monthly-limit"><SpendingLimitSection s={s} patch={patch} /></div>

      <Section title="How answers are picked">
        <Row id="auto-prefers" title="Prefer" info="Best answers picks the strongest model for each request; price only breaks close ties. Balanced and Lowest cost give price more weight.">
          <Segmented value={s.cloud.autoPrefers ?? 'best'} label="Prefer" testIdPrefix="auto-prefers" onChange={(v) => void patch({ cloud: { ...s.cloud, autoPrefers: v } })}
            options={[{ id: 'best', label: 'Best answers' }, { id: 'balanced', label: 'Balanced' }, { id: 'cheapest', label: 'Lowest cost' }]} />
        </Row>
        <div data-setting="local-models"><LocalModelsRow s={s} patch={patch} onChanged={onRefresh} /></div>
      </Section>

      <Disclosure title="Use a ChatGPT or Grok subscription instead" sub="Your existing plan, through its app on this Mac, with no API charges" testId="models-subscriptions">
        <div data-setting="chatgpt-plan"><ChatgptPlanSettings onRefresh={onRefresh} /></div>
        {api.runtime !== 'server' && <GrokPlanSettings onRefresh={onRefresh} />}
      </Disclosure>
      {localIsOn(s) && <RecommendedLocal s={s} models={models} onRefresh={onRefresh} />}

      {/* No Advanced section: Auto picks the model, thinking, routing and tools for each request. */}
    </>
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
      <h2>Apps</h2>
      <div className="set-sub">Gmail, Calendar, Notion, Slack, GitHub and more. Bots use them when a task needs them.</div>
      <Section>
        <Row id="connect-apps" testId="connected-summary"
          title={apps === null ? 'Checking…' : live.length ? `${live.length} connected` : 'Nothing connected yet'}
          sub={apps === null ? undefined : [live.map((a) => a.name).join(', '), waiting.length ? `${waiting.length} need${waiting.length === 1 ? 's' : ''} attention: ${waiting.map((a) => a.name).join(', ')}` : ''].filter(Boolean).join(' · ') || 'One click each; you sign in with the app itself.'}>
          <button className="btn primary" onClick={() => window.dispatchEvent(new Event('sahilbot:open-connect'))} data-testid="settings-connect-apps">Connect apps</button>
        </Row>
      </Section>
      <Disclosure title="For developers" sub="Cursor coding agents, MCP for other apps, Shortcuts links" testId="connected-advanced">
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
        {!isServerRuntime && <div data-setting="mcp-server"><McpSettings /></div>}
      </Disclosure>
    </>
  )
}

// ------------------------------------------------------------------ voice

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
      <div className="set-sub">Dictate with ⌘D, talk with ⇧⌘V. Typed replies are never read aloud on their own: press the speaker on a message to hear it.</div>
      <Section>
        {localIsOn(s) && <Row id="speech-model" testId="voice-speech-model" title={sp ? <>{sp.label} <span className="hint" data-testid="voice-speech-reason">· {sp.reason}</span></> : 'Speech recognition'} sub={speechSub} info={sp?.why}>
          {state}
        </Row>}
        <div data-setting="voice-openai"><VoiceOutputRow s={s} patch={patch} /></div>
      </Section>
    </>
  )
}

// ------------------------------------------------------------------ privacy & security


function PrivacySecurityPage({ s, patch, tab, onTab }: P & { tab: string; onTab: (t: string) => void }) {
  // Three tabs: passwords, backups, and everything about what SahilBot may see (on one page).
  const tabs = [
    { id: 'passwords', label: 'Passwords' },
    { id: 'backups', label: 'Backups', hidden: isServerRuntime }
  ]
  const want = tab === 'activity' || tab === 'sensitive' || tab === 'hybrid' ? 'privacy' : tab
  const cur = tabs.find((t) => t.id === want && !t.hidden)?.id ?? 'passwords'
  return (
    <>
      <h3 className="set-h3">Passwords and backups</h3>
      <div className="set-sub">Saved passwords and copies of your data.</div>
      <Tabs value={cur} tabs={tabs} onChange={onTab} label="Privacy and security" />
      {cur === 'passwords' && <div data-setting="passwords">{onPhone
        ? <div className="set-sub" data-testid="vault-on-mac">Saved passwords, cards and authenticator codes stay on your Mac and are never sent to this phone. Manage them in SahilBot on the Mac.</div>
        : <SecretVaultSettings embedded />}</div>}
      {cur === 'backups' && <div data-setting="backups"><BackupSettings /></div>}
    </>
  )
}

// ------------------------------------------------------------------ permissions

/** What SahilBot may do, and what the Mac lets it use. No levels or rules to set: it does the work, and asks only where it must. */
function PermissionsPage(_: P) {
  return (
    <>
      <h2>Privacy &amp; safety</h2>
      <div className="set-sub">SahilBot works on its own, anywhere on your Mac: files and folders, apps, the web and your connected accounts.</div>
      <div className="perm-note" data-setting="autonomy" data-testid="perm-note"><I.Shield size={13} />It asks only before buying something, typing a saved password anywhere but that login's own site, or doing something a web page or email told it to. System and secret places (like your keychain and SSH keys) stay off limits. Undo takes back a task's file changes.</div>
      {!isServerRuntime && <MacPermissions />}
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

export function MacPermissions({ title = 'Your Mac', sub = 'Turn on only what you want SahilBot to use. You can change these any time.', omit = [] }: { title?: string; sub?: string; omit?: PermissionKind[] } = {}) {
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
      const auto = kind === 'automation' && r === 'prompted' ? 'macOS is asking: click OK in its window to let SahilBot control your apps.' : ''
      setAsked((a) => ({ ...a, [kind]: note || auto || (r === 'opened' ? 'Turn on SahilBot in the window that opened, then come back.' : r === 'denied' ? 'macOS said no. Use Open Settings to change it.' : '') }))
      setTimeout(refresh, 800)
      // macOS's question is still open: check again while the user answers it.
      if (kind === 'notifications' && r === 'prompted') for (const ms of [3000, 8000, 15000, 30000, 60000]) setTimeout(refresh, ms)
    }).catch((e) => toast(clean(e), 'error'))
  }
  const sorted = (rows ?? []).filter((r) => !omit.includes(r.kind)).sort((a, b) => PERM_ORDER.indexOf(a.kind) - PERM_ORDER.indexOf(b.kind))
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
                // One button: it asks macOS first; once macOS has answered, the same button opens System Settings.
                : asked[r.kind]
                  ? <button className="btn" onClick={() => void api.permissions.open(r.kind)} data-testid={`perm-${r.kind}-open`}>Open Settings</button>
                  : <button className="btn" onClick={() => allow(r.kind)} data-testid={`perm-${r.kind}-allow`}>{r.kind === 'notifications' ? 'Turn on' : 'Allow'}</button>}
            </Row>
          )
        })}
      </div>
    </Section>
  )
}

// ------------------------------------------------------------------ advanced

// (Advanced settings were removed: the bot picks sensible defaults, and the rest you ask for in chat.)
