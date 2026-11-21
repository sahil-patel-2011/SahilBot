import { toast } from '../lib/toast'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ConnectorConfig, ConnectorPreset, ConnectorStatus, GoogleConnectLink, GoogleConnectStatus, Skill } from '@shared/types'
import { api } from '../api'
import * as I from '../icons'
import { AppIcon, IconStack, connectedApps, useAppIcons } from './ConnectedIcons'
import { APP_STATE_TEXT, CUSTOM_REDIRECT, MAIN_CHIPS, MORE_CATEGORIES, SECTION_ORDER, SETUP_GROUP, appState, checkSummary, connectBadge, keyProblem, matches, recommended, searchApps, splitSection, type AppState, type Badge } from '../lib/connect-catalog'

const STATE_TEXT: Record<ConnectorStatus['state'], string> = {
  off: 'Off', disconnected: 'Disconnected', connecting: 'Connecting…', signing_in: 'Finish signing in in your browser…',
  needs_auth: 'Needs sign-in', connected: 'Connected', error: 'Error', reconnecting: 'Reconnecting…'
}

/** SahilBot's own saved-logins vault, listed under Password Managers (opens Settings → Privacy & Security → Passwords). */
const VAULT: ConnectorPreset = {
  id: 'sahilbot-vault', name: 'SahilBot Vault', url: 'app:vault', color: '#3A3A3C', category: 'Password Managers', auth: 'app',
  description: 'Saved logins SahilBot types into sites for you, encrypted in your Keychain.'
}

const clean = (e: unknown): string => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const prettyTool = (n: string): string => n.replace(/[_\-.]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
const ACRONYMS = /^(pdf|pcb|sql|seo|ci|api|ios|gdt|dfm)$/i
const prettySkill = (n: string): string => n.split('-').map((w) => (ACRONYMS.test(w) ? w.toUpperCase() : w)).join(' ').replace(/^\w/, (c) => c.toUpperCase())

type View = 'browse' | 'manage' | 'form' | 'google' | 'setup' | 'key' | 'gmail'

/** An API-key app SahilBot talks to with its own tool (no MCP server, no connector config): Resend. */
export const isNativeKeyApp = (p: Pick<ConnectorPreset, 'auth' | 'url'> | undefined): boolean => !!p && p.auth === 'apikey' && p.url.startsWith('app:')
const GOOGLE_METHOD: Record<GoogleConnectLink['method'], string> = { oauth: 'Sign in with Google', mail: 'the Mac\'s Mail app', 'app-password': 'app password' }

/** Badge look (styles-system.css): quiet neutral pills; the words say how it connects. */
const BADGE_STYLE: Record<Badge, { cls: string }> = {
  'One click': { cls: 'one-click' },
  'API key': { cls: 'api-key' },
  'Needs setup': { cls: 'setup' },
  'SahilBot\'s browser': { cls: 'browser' }
}
const badgeTitle = (b: Badge, p: ConnectorPreset): string =>
  b === 'One click' ? `Opens ${p.name}'s own sign-in page in your browser; nothing to set up`
  : b === 'SahilBot\'s browser' ? 'Sign in inside SahilBot\'s browser: SahilBot uses the site like you do (no connector)'
  : b === 'API key' ? `Paste your ${p.name} API key once (kept in your Keychain), then it connects`
  : p.auth === 'google' ? 'One-time Google setup (about 5 minutes), then one click'
  : `One-time setup at ${p.name} (about ${p.setup?.minutes ?? 5} minutes), then one click`
type Form = { preset: ConnectorPreset; name: string; kind: 'remote' | 'stdio'; url: string; command: string; headerName: string; headerValue: string; clientId: string; clientSecret: string }

/**
 * Connect Apps: browse the catalog, connect apps (OAuth in your browser, Google client ID, custom MCP
 * servers, or no-setup browser sign-in), manage connected apps and their tools, and add bot templates.
 * Spec: design/bot-ui.md → Connect Apps.
 */
export function ConnectApps({ onClose, onBrowse, onOpenBot: _onOpenBot, onOpenSettings, onTry }: {
  onClose: () => void
  onBrowse: (url: string) => void
  /** Open a bot's chat (older callers; bot templates moved to the New bot dialog). */
  onOpenBot?: (spaceId: string, threadId?: string) => void
  /** "Try it" on a connected app: a new chat with this first message in the box. */
  onTry?: (text: string) => void
  /** Open Settings at a page (falls back to a toast). */
  onOpenSettings?: (page: 'passwords' | 'rules' | 'connected') => void
}) {
  const [presets, setPresets] = useState<ConnectorPreset[]>([])
  const [configs, setConfigs] = useState<ConnectorConfig[]>([])
  const [statuses, setStatuses] = useState<ConnectorStatus[]>([])
  const [skills, setSkills] = useState<Skill[]>([])
  const [form, setForm] = useState<Form | null>(null)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  const [view, setView] = useState<View>('browse')
  const [chip, setChip] = useState<string>('All')
  const [moreOpen, setMoreOpen] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  /** The Google app waiting for "Set up Google once" to finish (connects right after). */
  const [googleFor, setGoogleFor] = useState<ConnectorPreset | null>(null)
  const [google, setGoogle] = useState<{ clientId: string; hasSecret: boolean } | null>(null)
  /** The app whose one-time OAuth setup is open (oauth-static presets). */
  const [setupFor, setSetupFor] = useState<ConnectorPreset | null>(null)
  /** The API-key app whose paste-your-key panel is open. */
  const [keyFor, setKeyFor] = useState<ConnectorPreset | null>(null)
  /** Connector ids with an API key saved (main never sends the keys themselves). */
  const [keys, setKeys] = useState<Set<string>>(new Set())
  /** Cursor is connected by its API key (kept with the other settings keys, not a connector's). */
  const [cursorOn, setCursorOn] = useState(false)
  /** How Google is connected (one tile, three ways: Sign in with Google, the Mac's Mail app, an app password). */
  const [gstat, setGstat] = useState<GoogleConnectStatus | null>(null)
  /** Test connection results by connector id. */
  const [tests, setTests] = useState<Record<string, { ok: boolean; text: string }>>({})
  /** "Check all": running, and its one-line result. */
  const [checking, setChecking] = useState(false)
  const [checked, setChecked] = useState('')
  const body = useRef<HTMLDivElement>(null)
  const icons = useAppIcons()

  const load = async (): Promise<void> => {
    const r = await api.connectors.list()
    setConfigs(r.configs)
    setStatuses(r.statuses)
    setKeys(new Set(r.keys ?? []))
    setCursorOn(!!(await api.settings.get().catch(() => null))?.hasCursorKey)
    setGoogle(await api.connectors.googleClient().catch(() => null))
    setGstat(await api.google?.status(false).catch(() => null) ?? null)
  }
  useEffect(() => {
    void api.connectors.presets().then(setPresets)
    void api.skills.list().then(setSkills).catch(() => undefined)
    void load()
    return api.connectors.onChange(() => void load())
  }, [])
  useEffect(() => {
    // preventDefault: this Esc is spent closing this (the chat's run and the details panel leave it alone).
    const k = (e: KeyboardEvent): void => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); onClose() } }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  useEffect(() => { body.current?.scrollTo({ top: 0 }) }, [view, chip])

  const status = (id: string): ConnectorStatus | undefined => statuses.find((s) => s.id === id)
  const configOf = (p: ConnectorPreset): ConnectorConfig | undefined => configs.find((c) => c.preset === p.id)
  const connected = useMemo(() => {
    const apps = connectedApps(configs, statuses, presets)
    if (cursorOn) apps.push({ id: 'cursor-cloud-key', presetId: 'cursor-app', name: 'Cursor', color: '#111111' })
    // Native API-key apps (Resend) are connected when their key is saved; Google by the Mail app or an app password too.
    for (const p of presets) if (isNativeKeyApp(p) && keys.has(p.id)) apps.push({ id: `${p.id}-key`, presetId: p.id, name: p.name, color: p.color })
    if (gstat?.link && gstat.link.method !== 'oauth' && !apps.some((a) => a.presetId === 'gmail')) apps.push({ id: 'google-link', presetId: 'gmail', name: 'Gmail', color: '#EA4335' })
    return apps
  }, [configs, statuses, presets, cursorOn, keys, gstat])
  /** An API-key app's key is saved (a connector's, or a native app's by its preset id). */
  const keyed = (p: ConnectorPreset, cfg: ConnectorConfig | undefined): boolean => (isNativeKeyApp(p) ? keys.has(p.id) : !!cfg && keys.has(cfg.id))
  /** What's missing before an app can connect: its one-time setup, Google setup or API key. */
  const setupMissing = (p: ConnectorPreset | undefined, cfg: ConnectorConfig | undefined): boolean =>
    // Gmail is never "needs setup": its panel also connects through the Mail app or an app password.
    !!p && p.id !== 'gmail' && ((p.auth === 'oauth-static' && !cfg?.clientId && !p.builtinClient) || (p.auth === 'google' && !google && !cfg?.clientId && !p.builtinClient) || (p.auth === 'apikey' && !keyed(p, cfg)))
  /** SahilBot ships its own Google app: every Google app connects in one click (unless the user uses their own). */
  const googleBuiltin = useMemo(() => presets.some((p) => p.auth === 'google' && p.builtinClient), [presets])
  /** The one state an app is in (Connected, Needs sign-in again, Unavailable right now, Needs setup…). */
  const stateOf = (p: ConnectorPreset | undefined, cfg: ConnectorConfig | undefined): AppState | undefined =>
    cfg ? appState(p, status(cfg.id), { setupMissing: setupMissing(p, cfg) }) : p?.unavailable ? 'unavailable' : undefined
  const connectedPresetIds = useMemo(() => new Set(connected.map((a) => a.presetId).filter((x): x is string => !!x)), [connected])
  const catalog = useMemo(() => [VAULT, ...presets], [presets])
  const byCategory = (cat: string): ConnectorPreset[] => catalog.filter((p) => p.category === cat)

  /** Runs a connector action and shows why it failed, instead of failing silently. */
  const guard = async (fn: () => Promise<unknown>): Promise<void> => {
    setErr('')
    try { await fn() } catch (e) { setErr(clean(e)); body.current?.scrollTo({ top: 0, behavior: 'smooth' }) }
  }

  const go = (v: View): void => { setErr(''); setView(v); setMoreOpen(false) }

  const start = async (p: ConnectorPreset): Promise<void> => {
    setErr('')
    if (p.id === VAULT.id) {
      if (onOpenSettings) { onClose(); onOpenSettings('passwords') } else toast('Your saved logins are in Settings → Privacy & Security → Passwords.')
      return
    }
    // Web automation by design: open the site in SahilBot's own browser and sign in there once.
    if (p.auth === 'browser') { onBrowse(p.url); onClose(); return }
    // Built-in apps need nothing: just ask SahilBot to use them.
    // Kept in the catalog, but its server can't be used right now: say why instead of trying.
    if (p.unavailable) { setErr(`${p.name} is unavailable right now. ${p.unavailable}`); body.current?.scrollTo({ top: 0, behavior: 'smooth' }); return }
    // Cursor: its API key lives in Settings → Connected apps (Cloud Agents).
    if (p.id === 'cursor-app') { if (onOpenSettings) { onClose(); onOpenSettings('connected') } else toast('Add your Cursor API key in Settings → Connected apps.'); return }
    // Google: one tile, three ways (Sign in with Google, the Mac's Mail app, an app password).
    if (p.id === 'gmail') { go('gmail'); return }
    // Native API-key apps (Resend): the key panel, to add, replace or forget the key.
    if (isNativeKeyApp(p)) { setKeyFor(p); go('key'); return }
    if (p.auth === 'app') { toast(`${p.name} is built in. Just ask SahilBot, e.g. "${p.url === 'app:cursor' ? 'open this project in Cursor' : p.url === 'app:mail' ? 'what needs a reply in my inbox today?' : p.url === 'app:research' ? 'what do the latest guidelines and meta-analyses say about active surveillance for prostate cancer?' : 'add a reminder for tomorrow at 9'}".`); return }
    const existing = configOf(p)
    // Google apps with no client at all (no built-in one, none of the user's own): set Google up first.
    if (p.auth === 'google' && !p.builtinClient && !google && !existing?.clientId && status(existing?.id ?? '')?.state !== 'connected') { setGoogleFor(p); go('google'); return }
    // Apps without self-registration and no built-in client yet: create their OAuth app once, then one click.
    if (p.auth === 'oauth-static' && !p.builtinClient && !existing?.clientId) { setSetupFor(p); go('setup'); return }
    // API-key apps: paste the key once (it goes to the Keychain), then they connect.
    if (p.auth === 'apikey' && !(existing && keys.has(existing.id))) { setKeyFor(p); go('key'); return }
    if (existing) {
      if (status(existing.id)?.state === 'connected') { setOpen(existing.id); go('manage'); return }
      try { await api.connectors.connect(existing.id) } catch (e) { setErr(clean(e)) }
      return
    }
    // Known servers connect in one click; custom needs details.
    if (p.id !== 'custom') {
      try {
        const saved = await api.connectors.save({ name: p.name, kind: 'remote', url: p.url, preset: p.id, enabled: true })
        await load()
        await api.connectors.connect(saved.id)
      } catch (e) {
        setErr(clean(e))
      }
      return
    }
    setForm({ preset: p, name: p.id === 'custom' ? '' : p.name, kind: 'remote', url: p.url, command: '', headerName: '', headerValue: '', clientId: '', clientSecret: '' })
    go('form')
  }

  const submit = async (): Promise<void> => {
    if (!form) return
    setErr('')
    try {
      const [command, ...args] = form.command.trim().split(/\s+/)
      const saved = await api.connectors.save({
        name: form.name.trim() || form.preset.name, kind: form.kind, preset: form.preset.id, enabled: true,
        ...(form.kind === 'remote' ? { url: form.url.trim(), ...(form.headerName ? { headerName: form.headerName.trim(), headerValue: form.headerValue } : {}), ...(form.clientId ? { clientId: form.clientId.trim(), clientSecret: form.clientSecret.trim() || undefined } : {}) } : { command, args })
      })
      setForm(null)
      setOpen(saved.id)
      go('manage')
      await load()
      await api.connectors.connect(saved.id)
    } catch (e) {
      setErr(clean(e))
    }
  }

  const setTool = async (c: ConnectorConfig, tool: string, on: boolean): Promise<void> => {
    // Optimistic: the switch moves at once; the saved config comes back through onChange.
    setConfigs((all) => all.map((x) => (x.id === c.id ? { ...x, disabledTools: on ? (x.disabledTools ?? []).filter((n) => n !== tool) : [...(x.disabledTools ?? []), tool] } : x)))
    try { await api.connectors.setToolEnabled(c.id, tool, on) } catch (e) { setErr(clean(e)); void load() }
  }

  /** Re-tests every switched-on app at once and sums up how they are. */
  const checkAll = async (): Promise<void> => {
    setChecking(true)
    setChecked('')
    setErr('')
    try {
      const sts = await api.connectors.checkAll()
      setStatuses(sts)
      const states = configs.filter((c) => c.enabled).map((c) => appState(presets.find((p) => p.id === c.preset), sts.find((s) => s.id === c.id), { setupMissing: setupMissing(presets.find((p) => p.id === c.preset), c) }))
      setChecked(checkSummary(states))
      setTests({})
    } catch (e) {
      setErr(clean(e))
    } finally {
      setChecking(false)
    }
  }

  /** The fix for an app that needs setup: its one-time OAuth app, Google setup, or API key. */
  const openSetup = (p: ConnectorPreset): void => {
    if (p.auth === 'apikey') { setKeyFor(p); go('key') } else if (p.auth === 'google') { setGoogleFor(p); go('google') } else if (p.setup) { setSetupFor(p); go('setup') }
  }

  const testOne = async (c: ConnectorConfig): Promise<void> => {
    setTests((t) => ({ ...t, [c.id]: { ok: true, text: 'Testing…' } }))
    try {
      const st = await api.connectors.test(c.id)
      setTests((t) => ({ ...t, [c.id]: { ok: st.state === 'connected', text: healthText(st) } }))
    } catch (e) {
      setTests((t) => ({ ...t, [c.id]: { ok: false, text: clean(e) } }))
    }
  }

  /** An app's one-time setup is saved: connect it (the browser opens to sign in on the app's own page). */
  const afterSetup = async (p: ConnectorPreset, clientId: string, clientSecret: string): Promise<void> => {
    const existing = configOf(p)
    const saved = await api.connectors.save({ ...(existing ?? { name: p.name, kind: 'remote', url: p.url, preset: p.id, enabled: true }), clientId, ...(clientSecret ? { clientSecret } : {}) })
    setSetupFor(null)
    setOpen(saved.id)
    go('manage')
    await load()
    try { await api.connectors.connect(saved.id) } catch (e) { setErr(clean(e)) }
  }

  /** A key was accepted (or refused): show the app in Connected apps either way, with its status. */
  const afterKey = async (st: ConnectorStatus): Promise<void> => {
    await load()
    if (st.state !== 'connected') return
    const p = keyFor
    setKeyFor(null)
    // A native app has no connector to manage: back to the catalog, connected.
    if (isNativeKeyApp(p ?? undefined)) { go('browse'); toast(`${p!.name} is connected. Just ask, e.g. "email the report to amy@example.com with ${p!.name}".`); return }
    setOpen(st.id)
    go('manage')
  }

  /** Google is set up: connect the app that was waiting for it (the browser opens to sign in). */
  const afterGoogle = async (info: { clientId: string; hasSecret: boolean }): Promise<void> => {
    setGoogle(info)
    const p = googleFor
    setGoogleFor(null)
    go(p ? 'manage' : 'browse')
    if (!p) { toast('Google is set up. Connect Gmail, Calendar or Drive with one click each.'); return }
    try {
      const existing = configOf(p)
      const saved = existing ?? await api.connectors.save({ name: p.name, kind: 'remote', url: p.url, preset: p.id, enabled: true })
      setOpen(saved.id)
      await load()
      await api.connectors.connect(saved.id)
    } catch (e) {
      setErr(clean(e))
    }
  }

  // ---------------------------------------------------------------- rows

  const item = (p: ConnectorPreset): ReactNode => {
    const cfg = configOf(p)
    const st = cfg ? status(cfg.id) : undefined
    const busy = st?.state === 'connecting' || st?.state === 'signing_in'
    const as = p.id === VAULT.id || p.auth === 'app' || p.auth === 'browser' ? undefined : stateOf(p, cfg)
    const [label, tone] =
      p.id === VAULT.id ? ['Open', 'ghost'] :
      p.id === 'cursor-app' ? (cursorOn ? ['Connected', 'done'] : ['Add key', 'add']) :
      p.id === 'gmail' && as !== 'reauth' ? (gstat?.link || st?.state === 'connected' ? ['Connected', 'done'] : busy ? ['Connecting…', 'ghost'] : ['Connect', 'add']) :
      isNativeKeyApp(p) ? (keys.has(p.id) ? ['Connected', 'done'] : ['Add key', 'add']) :
      p.auth === 'app' ? ['Built in', 'ok'] :
      p.auth === 'browser' ? ['Sign in', 'ghost'] :
      st?.state === 'connected' ? ['Connected', 'done'] :
      busy ? ['Connecting…', 'ghost'] :
      as === 'unavailable' && p.unavailable ? ['Unavailable', 'ghost'] :
      as === 'reauth' ? ['Reconnect', 'solid'] :
      p.auth === 'oauth-static' && !cfg?.clientId && !p.builtinClient ? ['Set up', 'ghost'] :
      p.auth === 'apikey' && !keyed(p, cfg) ? ['Add key', 'add'] :
      cfg ? ['Connect', 'solid'] : ['Add', 'add']
    const badge = st?.state === 'connected' || as === 'unavailable' || (isNativeKeyApp(p) && keys.has(p.id)) || p.id === 'gmail' ? null : connectBadge(p)
    const glink = p.id === 'gmail' ? gstat?.link : null
    const act = (): void => { if (!busy) void start(p) }
    return (
      <div key={p.id} className="ca-item" role="button" tabIndex={0} data-testid={`preset-${p.id}`} data-state={st?.state} data-app-state={as}
        onClick={act} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act() } }}>
        {p.id === VAULT.id
          ? <span className="ca-icon vault" style={{ width: 44, height: 44, borderRadius: 12 }}><I.Shield size={22} /></span>
          : <AppIcon src={icons[p.id]} name={p.name} color={p.color} />}
        <span className="ca-item-text">
          <b>{p.name}{badge && <small className={`ca-badge ui-pill ${BADGE_STYLE[badge].cls}`} data-testid={`badge-${p.id}`} title={badgeTitle(badge, p)}>{badge}</small>}</b>
          <span>{as === 'unavailable' && p.unavailable && !cfg ? `${APP_STATE_TEXT.unavailable}: ${p.unavailable}` : as === 'reauth' || as === 'unavailable' || (as === 'setup' && st?.state === 'error') ? APP_STATE_TEXT[as] : st?.state === 'needs_auth' || st?.state === 'error' || st?.state === 'reconnecting' ? STATE_TEXT[st.state] : p.auth === 'google' && p.id !== 'gmail' && !p.builtinClient && !google && !cfg ? `${p.description} One-time Google setup first.` : p.auth === 'oauth-static' && !p.builtinClient && !cfg?.clientId ? `${p.description} One-time setup first.` : glink ? `Connected${glink.address ? ` · ${glink.address}` : ''} · via ${GOOGLE_METHOD[glink.method]}` : p.auth === 'apikey' && !keyed(p, cfg) ? `${p.description} Paste your API key once.` : p.description}</span>
        </span>
        {tone === 'done' && onTry && (
          <button className="ca-try" onClick={(e) => { e.stopPropagation(); onClose(); onTry(`What's new in ${p.name}?`) }} data-testid={`try-app-${p.id}`} title={`Start a chat that uses ${p.name}`}>Try it</button>
        )}
        <span className={`ca-btn ${tone}`} aria-disabled={busy || undefined}>
          {tone === 'add' && <I.Plus size={13} />}{tone === 'done' && <I.Check size={13} />}{label}
        </span>
      </div>
    )
  }

  /**
   * A catalog section: what connects right away first (one click, built in, SahilBot's browser), then
   * a clearly labelled "Needs a one-time setup" group at the end (own OAuth app, Google setup or API
   * key still missing). `limit` caps each part in the All view; View all opens the whole category.
   */
  const section = (title: string, items: ConnectorPreset[], opts: { limit?: number; setupLimit?: number; viewAll?: string; note?: string; count?: boolean } = {}): ReactNode => {
    if (!items.length) return null
    // An app the user already set up (own client, Google setup, saved key) is ready now, not "needs setup".
    const { ready, setup: setupAll } = splitSection(items)
    const setup = setupAll.filter((p) => setupMissing(p, configOf(p)))
    const readyAll = [...ready, ...setupAll.filter((p) => !setup.includes(p))]
    const shown = opts.limit ? readyAll.slice(0, opts.limit) : readyAll
    const setupShown = opts.setupLimit !== undefined ? setup.slice(0, opts.setupLimit) : setup
    const hidden = readyAll.length - shown.length + setup.length - setupShown.length
    return (
      <section className="ca-section" key={title} data-testid={`section-${title}`}>
        <div className="ca-section-head">
          <h3>{title}{opts.count !== false && <span className="ca-section-n" data-testid="section-count" style={{ marginLeft: 6, fontWeight: 500, fontSize: '0.85em', color: 'var(--text-3, #888)' }}>{items.length}</span>}</h3>
          {opts.note && <span className="ca-note">{opts.note}</span>}
          {opts.viewAll && hidden > 0 && (
            <button className="ca-viewall" onClick={() => setChip(opts.viewAll!)}>View all {items.length}<I.Chevron size={13} style={{ transform: 'rotate(-90deg)' }} /></button>
          )}
        </div>
        {shown.length > 0 && <div className="ca-list" data-testid="section-ready">{shown.map(item)}</div>}
        {setupShown.length > 0 && (
          <div className="ca-setup-group" data-testid="section-setup">
            <div className="ca-setup-head">
              <span>{SETUP_GROUP}</span>
              <span className="ca-note">{setup.length} {setup.length === 1 ? 'app' : 'apps'} · your own app or API key, once</span>
            </div>
            <div className="ca-list">{setupShown.map(item)}</div>
          </div>
        )}
      </section>
    )
  }

  const openSkill = (): void => { if (onOpenSettings) { onClose(); onOpenSettings('rules') } else toast('SahilBot uses skills on its own when they fit. Manage them in Settings → Advanced → Rules & skills.') }
  const skillRow = (s: Skill): ReactNode => (
    <div key={s.name} className="ca-item" role="button" tabIndex={0} data-testid={`skill-${s.name}`}
      onClick={() => openSkill()}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSkill() } }}>
      <span className="ca-icon skill" style={{ width: 44, height: 44, borderRadius: 12 }}><I.Sparkle size={20} /></span>
      <span className="ca-item-text"><b>{prettySkill(s.name)}</b><span>{s.description}</span></span>
      <span className="ca-btn ok">{s.source === 'builtin' ? 'Built in' : 'Yours'}</span>
    </div>
  )

  // ---------------------------------------------------------------- views

  const browse = (): ReactNode => {
    const query = q.trim()
    if (query) {
      // Name, description, category and the category's everyday words ("tickets" → Support); best matches first.
      const apps = searchApps(query, catalog)
      const sk = skills.filter((s) => matches(query, s.name.replace(/-/g, ' '), s.description, s.category)).slice(0, 12)
      if (!apps.length && !sk.length) {
        return (
          <div className="ca-empty">
            <b>No apps or skills match “{query}”.</b>
            <span>Any MCP server works: add it by URL or command.</span>
            <button className="btn" onClick={() => { const c = presets.find((p) => p.id === 'custom'); if (c) void start(c) }}>Add a custom MCP server</button>
          </div>
        )
      }
      return (
        <>
          {section('Apps', apps)}
          {sk.length > 0 && (
            <section className="ca-section">
              <div className="ca-section-head"><h3>Skills</h3><span className="ca-note">SahilBot uses these on its own when they fit</span></div>
              <div className="ca-list">{sk.map(skillRow)}</div>
            </section>
          )}
        </>
      )
    }
    if (chip !== 'All') {
      return section(chip, byCategory(chip), chip === 'Built in' ? { note: 'Nothing to connect' } : {})
    }
    return (
      <>
        {section('Recommended for you', recommended(presets, connectedPresetIds), { count: false, note: 'One click each' })}
        {SECTION_ORDER.map((cat) => section(cat, byCategory(cat), { limit: 6, setupLimit: 3, viewAll: cat, note: cat === 'Built in' ? 'Nothing to connect' : undefined }))}
        <p className="ca-foot">Connect opens the app's own sign-in page in your default browser; tokens and API keys stay in your Mac's Keychain. Connected tools load only when a task needs them.</p>
      </>
    )
  }

  const manage = (): ReactNode => (
    <>
      {configs.length === 0 && !cursorOn && (
        <div className="ca-empty">
          <b>No apps connected yet.</b>
          <span>Connect an app and SahilBot can use it in any chat.</span>
          <button className="btn" onClick={() => go('browse')}>Browse apps</button>
        </div>
      )}
      {checked && view === 'manage' && <div className="hint" data-testid="check-all-result" style={{ margin: '0 0 10px' }}>{checked}</div>}
      <div className="ca-manage">
        {cursorOn && <div className="ca-app" data-testid="cursor-cloud-connection">
          <AppIcon src={icons['cursor-app']} name="Cursor" color="#111111" />
          <div><b>Cursor</b><div className="hint">Cloud Agents · API key saved</div></div>
          <button className="btn" onClick={() => { if (onOpenSettings) { onClose(); onOpenSettings('connected') } }}>Manage key</button>
        </div>}
        {configs.map((c) => {
          const st = status(c.id)
          const preset = presets.find((p) => p.id === c.preset)
          const names = st?.toolNames ?? []
          const off = new Set(c.disabledTools ?? [])
          const on = names.filter((n) => !off.has(n)).length
          const state = st?.state ?? (c.enabled ? 'disconnected' : 'off')
          const busy = state === 'connecting' || state === 'signing_in'
          const as = appState(preset, st, { setupMissing: setupMissing(preset, c) })
          // The four states people act on get their own words; the rest keep the connection's own text.
          const shown = as === 'reauth' || as === 'unavailable' || as === 'setup' ? APP_STATE_TEXT[as] : STATE_TEXT[state]
          const expanded = open === c.id && state === 'connected' && names.length > 0
          return (
            <div className={`ca-app${expanded ? ' open' : ''}`} key={c.id}>
              <div className="conn-row ca-app-row" data-testid="connector-row" data-state={st?.state} data-app-state={as}>
                <AppIcon src={preset ? icons[preset.id] : undefined} name={c.name} color={preset?.color} size={40} />
                <div className="conn-text">
                  <b>{c.name}</b>
                  <span className={`ca-status ${state} app-${as}`} data-testid="connector-state">
                    <i />{shown}
                    {state === 'connected' ? ` · ${off.size && names.length ? `${on} of ${names.length}` : st?.tools ?? 0} tools` : ''}
                    {state === 'reconnecting' && st?.retryAt ? ` · try ${st.attempt ?? 1} at ${new Date(st.retryAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}` : ''}
                    {st?.error ? ` · ${st.error}` : ''}
                  </span>
                </div>
                {state === 'connected' && names.length > 0 && (
                  <button className="ca-tools-btn" onClick={() => setOpen(expanded ? null : c.id)} aria-expanded={expanded}>
                    Tools<I.Chevron size={13} style={{ transform: expanded ? 'rotate(180deg)' : undefined }} />
                  </button>
                )}
                <button className="btn" disabled={busy} title="Checks the connection by listing the app's tools" data-testid="connector-test" onClick={() => void testOne(c)}>Test</button>
                {state === 'connected' ? (
                  <button className="btn" onClick={() => void guard(() => api.connectors.disconnect(c.id))}>Disconnect</button>
                ) : as === 'reauth' ? (
                  <button className="btn primary" disabled={busy} title={`Sign in to ${c.name} again`} data-testid="connector-reconnect" onClick={() => void guard(() => api.connectors.connect(c.id))}>Reconnect</button>
                ) : as === 'unavailable' && preset?.unavailable ? (
                  <button className="btn" disabled title={preset.unavailable}>Unavailable</button>
                ) : as === 'setup' && preset && (preset.auth === 'apikey' || preset.auth === 'google' || preset.setup) ? (
                  <button className="btn primary" data-testid="connector-finish-setup" onClick={() => openSetup(preset)}>{preset.auth === 'apikey' ? 'Add key' : 'Set up'}</button>
                ) : (
                  <button className="btn primary" disabled={busy} onClick={() => void guard(() => api.connectors.connect(c.id))}>
                    {busy ? 'Connecting…' : state === 'needs_auth' ? 'Sign in' : 'Reconnect'}
                  </button>
                )}
                {preset?.setup && preset.builtinClient && c.clientId ? (
                  <button className="btn" title={`Forget your own ${c.name} app and sign in with SahilBot's`} data-testid="connector-use-builtin" onClick={() => void guard(async () => { await api.connectors.useBuiltinClient(c.id); await load(); await api.connectors.connect(c.id) })}>Use SahilBot's app</button>
                ) : preset?.setup ? (
                  <button className="btn" title={preset.builtinClient ? `Sign in to ${c.name} with an OAuth app you registered yourself` : `Change the OAuth app ${c.name} signs in with`} data-testid="connector-setup" onClick={() => { setSetupFor(preset); go('setup') }}>{preset.builtinClient ? 'Use your own app' : 'Setup'}</button>
                ) : null}
                {preset?.auth === 'apikey' && (
                  <button className="btn" title={`Replace the ${c.name} API key`} data-testid="connector-key" onClick={() => { setKeyFor(preset); go('key') }}>Key</button>
                )}
                {preset?.auth === 'oauth' && preset.apiKey && (keys.has(c.id) ? (
                  <button className="btn" title={`Forget the API key and sign in to ${c.name} with one click instead`} data-testid="connector-key-clear" onClick={() => void guard(async () => { await api.connectors.clearApiKey(c.id); await load(); await api.connectors.connect(c.id) })}>Sign in instead of key</button>
                ) : (
                  <button className="btn" title={`${c.name} also takes an API key`} data-testid="connector-key-alt" onClick={() => { setKeyFor(preset); go('key') }}>Use an API key instead</button>
                ))}
                <button className="icon-btn" title="Remove" aria-label={`Remove ${c.name}`} onClick={() => { if (confirm(`Remove ${c.name}? You can add it again later.`)) void guard(() => api.connectors.remove(c.id)) }}><I.Trash size={15} /></button>
              </div>
              {tests[c.id] && (
                <div className={`hint ${tests[c.id].ok ? 'ok' : 'error'}`} data-testid="connector-test-result" style={{ margin: '2px 0 8px 52px' }}>{tests[c.id].text}</div>
              )}
              {expanded && (
                <div className="ca-tools" data-testid="connector-tools">
                  <div className="ca-tools-head">
                    <span>Tools SahilBot can use</span>
                    <span className="ca-note">Off tools are never offered to the agent</span>
                  </div>
                  {names.map((n) => {
                    const enabled = !off.has(n)
                    return (
                      <label className="ca-tool" key={n}>
                        <span title={n}>{prettyTool(n)}</span>
                        <button type="button" role="switch" aria-checked={enabled} className={`ca-switch${enabled ? ' on' : ''}`} data-testid={`tool-${n}`}
                          onClick={() => void setTool(c, n, !enabled)}><i /></button>
                      </label>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
      {(google || configs.some((c) => presets.find((p) => p.id === c.preset)?.auth === 'google')) && (
        <p className="ca-foot">
          {google ? `Google apps use your own OAuth client …${google.clientId.split('-')[0].slice(-4)}. ` : googleBuiltin ? 'Google apps sign in with SahilBot\'s own Google app. ' : 'Google apps need a one-time setup. '}
          {google && googleBuiltin && <button className="ca-viewall" onClick={() => void guard(async () => { await api.connectors.clearGoogleClient(); await load() })} data-testid="google-use-builtin">Use SahilBot's Google app</button>}
          <button className="ca-viewall" onClick={() => { setGoogleFor(null); go('google') }} data-testid="google-setup-open">{google ? 'Change your Google app' : googleBuiltin ? 'Use your own Google app' : 'Set up Google once'}</button>
        </p>
      )}
    </>
  )

  const formView = (): ReactNode => form && (
    <div className="conn-form">
      <h3>{form.preset.id === 'custom' ? 'Custom MCP server' : form.preset.name}</h3>
      <div className="field"><label>Name</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Semrush" /></div>
      <div className="field"><label>Type</label>
        <div className="seg">
          <button className={form.kind === 'remote' ? 'on' : ''} onClick={() => setForm({ ...form, kind: 'remote' })}>Remote (URL)</button>
          <button className={form.kind === 'stdio' ? 'on' : ''} onClick={() => setForm({ ...form, kind: 'stdio' })}>Local (command)</button>
        </div>
      </div>
      {form.kind === 'remote' ? (
        <>
          <div className="field"><label>Server URL</label><input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://example.com/mcp" data-testid="conn-url" /></div>
          <div className="field"><label>API key header (optional)</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input value={form.headerName} onChange={(e) => setForm({ ...form, headerName: e.target.value })} placeholder="Authorization" style={{ flex: 1 }} />
              <input type="password" value={form.headerValue} onChange={(e) => setForm({ ...form, headerValue: e.target.value })} placeholder="Bearer …" style={{ flex: 2 }} />
            </div>
          </div>
          <div className="hint">Leave the header empty to sign in with OAuth in your browser.</div>
          <details style={{ margin: '10px 0 4px' }} open={!!form.clientId}>
            <summary className="hint" style={{ cursor: 'pointer' }}>OAuth client (only if the server can't register SahilBot itself)</summary>
            <div className="hint" style={{ margin: '6px 0' }}>Create an OAuth app in the service's developer settings with this redirect URL: <CopyText text={CUSTOM_REDIRECT} /></div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} placeholder="Client ID" spellCheck={false} autoComplete="off" style={{ flex: 1 }} data-testid="conn-client-id" />
              <input type="password" value={form.clientSecret} onChange={(e) => setForm({ ...form, clientSecret: e.target.value })} placeholder="Client secret (if any)" autoComplete="off" style={{ flex: 1 }} />
            </div>
          </details>
        </>
      ) : (
        <div className="field"><label>Command</label><input value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} placeholder="npx -y @some/mcp-server" data-testid="conn-command" /></div>
      )}
      <div className="modal-actions">
        <button className="btn" onClick={() => { setForm(null); go('browse') }}>Cancel</button>
        <button className="btn primary" onClick={() => void submit()} data-testid="conn-save">{form.kind === 'remote' && !form.headerName ? 'Sign in' : 'Connect'}</button>
      </div>
    </div>
  )

  // ---------------------------------------------------------------- frame

  const moreLabel = MORE_CATEGORIES.includes(chip) ? chip : 'More'
  const title = view === 'manage' ? 'Your apps' : view === 'form' ? 'Add an app'
    : view === 'google' ? (googleBuiltin ? 'Use your own Google app' : 'Set up Google once')
    : view === 'setup' && setupFor ? (setupFor.builtinClient ? `Use your own ${setupFor.name} app` : `Set up ${setupFor.name} once`)
    : view === 'key' && keyFor ? (keyFor.auth === 'oauth' ? `Use a ${keyFor.name} API key instead` : `Connect ${keyFor.name}`)
    : view === 'gmail' ? 'Connect Google' : 'Connect Apps'

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal connect-modal ca" data-testid="connect-apps-modal" role="dialog" aria-modal="true" aria-label={title}>
        <header className="ca-head">
          {view !== 'browse' && (
            <button className="icon-btn ca-back" aria-label="Back" onClick={() => { setForm(null); setSetupFor(null); setKeyFor(null); go('browse') }}>
              <I.Chevron size={18} style={{ transform: 'rotate(90deg)' }} />
            </button>
          )}
          <h2>{title}</h2>
          {view === 'browse' && (
            <button className="ca-count" onClick={() => go('manage')} data-testid="connected-count">
              <IconStack apps={connected} icons={icons} max={3} />
              Your apps ({connected.length})<I.Chevron size={13} style={{ transform: 'rotate(-90deg)' }} />
            </button>
          )}
          {view === 'manage' && configs.length > 0 && (
            <button className="btn" disabled={checking} title="Re-tests every connected app" data-testid="connectors-check-all" onClick={() => void checkAll()}>{checking ? 'Checking…' : 'Check all'}</button>
          )}
          {view === 'manage' && (
            <button className="btn ca-add-custom" onClick={() => { const c = presets.find((p) => p.id === 'custom'); if (c) void start(c) }}><I.Plus size={14} />Custom server</button>
          )}
          <button className="icon-btn" aria-label="Close" onClick={onClose}><I.Close size={16} /></button>
        </header>

        {view === 'browse' && (
          <div className="ca-toolbar">
            <div className="ca-search">
              <I.Search size={15} />
              <input placeholder="Search apps and skills" value={q} onChange={(e) => setQ(e.target.value)} data-testid="conn-search" autoFocus />
              {q && <button className="ca-clear" aria-label="Clear search" onClick={() => setQ('')}><I.Close size={12} /></button>}
            </div>
          </div>
        )}
        {view === 'browse' && !q.trim() && (
          <div className="ca-chips" role="tablist">
            {['All', ...MAIN_CHIPS].map((c) => (
              <button key={c} role="tab" aria-selected={chip === c} className={`ca-chip${chip === c ? ' on' : ''}`} onClick={() => { setChip(c); setMoreOpen(false) }}>{c}</button>
            ))}
            <div className="ca-more">
              <button role="tab" aria-selected={moreLabel !== 'More'} className={`ca-chip${moreLabel !== 'More' ? ' on' : ''}`} onClick={() => setMoreOpen((o) => !o)} aria-expanded={moreOpen}>
                {moreLabel}<I.Chevron size={13} />
              </button>
              {moreOpen && (
                <>
                  <div className="ca-more-scrim" onMouseDown={() => setMoreOpen(false)} />
                  <div className="ca-menu" role="menu">
                    {MORE_CATEGORIES.map((c) => (
                      <button key={c} role="menuitem" className={chip === c ? 'on' : ''} onClick={() => { setChip(c); setMoreOpen(false) }}>
                        <span>{c}</span><span className="ca-menu-n">{byCategory(c).length}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        <div className="ca-body" ref={body}>
          {err && <div className="ca-err">{err}</div>}
          {view === 'browse' && browse()}
          {view === 'manage' && manage()}
          {view === 'form' && formView()}
          {view === 'setup' && setupFor && (
            <AppSetup
              preset={setupFor}
              hasClient={!!configOf(setupFor)?.clientId}
              onCancel={() => { setSetupFor(null); go('browse') }}
              onDone={(id, secret) => afterSetup(setupFor, id, secret)} />
          )}
          {view === 'key' && keyFor && (
            <ApiKeyPanel
              preset={keyFor}
              hasKey={keyed(keyFor, configOf(keyFor))}
              onForget={isNativeKeyApp(keyFor) && keys.has(keyFor.id) ? async () => { await api.connectors.clearApiKey(keyFor.id); setKeyFor(null); go('browse'); await load() } : undefined}
              onCancel={() => { setKeyFor(null); go('browse') }}
              onDone={(st) => afterKey(st)} />
          )}
          {view === 'gmail' && (
            <GoogleConnect
              status={gstat}
              gmailPreset={presets.find((p) => p.id === 'gmail')}
              onChanged={load}
              onSignIn={async () => {
                const p = presets.find((x) => x.id === 'gmail')
                if (!p) return
                const st = await api.connectors.connectPreset(p.id)
                if (st.state === 'connected') await api.google.useOauth()
                await load()
              }}
              onOwnApp={() => { const p = presets.find((x) => x.id === 'gmail'); if (p) { setGoogleFor(p); go('google') } }}
              onDisconnectOauth={async () => { const id = gstat?.oauth.configId; if (id) await api.connectors.disconnect(id) }}
              onDone={() => go('browse')} />
          )}
          {view === 'google' && (
            <GoogleSetup
              forApp={googleFor?.name}
              builtin={googleBuiltin}
              onCancel={() => { setGoogleFor(null); go(googleFor ? 'browse' : 'manage') }}
              onDone={(info) => void afterGoogle(info)} />
          )}
        </div>
      </div>
    </div>
  )
}

/** "Working · 23 tools · 340 ms" for a Test connection result. */
function healthText(st: ConnectorStatus): string {
  if (st.state === 'connected') return `Working · ${st.toolNames?.length ?? st.tools} tools${typeof st.latencyMs === 'number' ? ` · answered in ${st.latencyMs} ms` : ''}`
  if (st.state === 'needs_auth') return st.reason === 'expired' ? 'Needs sign-in again: press Reconnect.' : 'Needs sign-in: press Sign in.'
  if (st.state === 'reconnecting') return `Not reachable right now${st.error ? ` (${st.error})` : ''}. Reconnecting on its own.`
  return `${STATE_TEXT[st.state]}${st.error ? `: ${st.error}` : ''}`
}

// ---------------------------------------------------------------- one-time OAuth app (oauth-static apps)

/** A value the user pastes elsewhere, with a Copy button. */
function CopyText({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <code style={{ userSelect: 'all', padding: '1px 6px', borderRadius: 6, background: 'var(--bubble-ai)' }} data-testid="setup-redirect">{text}</code>
      <button type="button" className="ca-btn ghost" style={{ padding: '2px 8px' }}
        onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }).catch(() => undefined) }}>{copied ? 'Copied' : 'Copy'}</button>
    </span>
  )
}

/** Light checks on a pasted client ID/secret (main checks again). */
export function clientProblem(clientId: string, secret: string, needsSecret: boolean): string | null {
  const id = clientId.trim()
  if (!id) return 'Paste the client ID.'
  if (/\s/.test(id)) return 'The client ID has spaces in it; copy it again.'
  if (id.length < 4 || id.length > 300) return 'That doesn\'t look like a client ID; copy it again.'
  if (needsSecret && !secret.trim()) return 'Paste the client secret too.'
  if (secret && /\s/.test(secret.trim())) return 'The client secret has spaces in it; copy it again.'
  return null
}

/**
 * One-time setup for an app whose MCP server doesn't let apps register themselves (Slack, GitHub,
 * HubSpot…): the provider's exact steps with links, the redirect URL to copy, then the client ID
 * (and secret). Afterwards the app connects in one click, signing in on its own page.
 */
export function AppSetup({ preset, hasClient, onDone, onCancel }: {
  preset: ConnectorPreset
  hasClient?: boolean
  onDone: (clientId: string, clientSecret: string) => Promise<void> | void
  onCancel?: () => void
}) {
  const g = preset.setup
  const [clientId, setClientId] = useState('')
  const [secret, setSecret] = useState('')
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  if (!g) return <div className="hint">{preset.name} has no setup steps.</div>
  const problem = clientProblem(clientId, secret, g.needsSecret)
  const save = async (): Promise<void> => {
    setTouched(true)
    if (problem) return
    setBusy(true)
    setErr('')
    try { await onDone(clientId.trim(), secret.trim()) } catch (e) { setErr(clean(e)) } finally { setBusy(false) }
  }
  return (
    <div className="conn-form" data-testid="app-setup">
      {preset.builtinClient ? (
        <p className="ca-lede" style={{ marginTop: 0 }} data-testid="own-app-lede">
          You don't need this: {preset.name} already connects in one click with SahilBot's own {preset.name} app. Use your own app only if your workspace requires it (an admin-approved app, other permissions). It takes about {g.minutes} minutes.
        </p>
      ) : (
        <p className="ca-lede" style={{ marginTop: 0 }}>
          {preset.name}'s MCP server only signs in apps registered with {preset.name}, and SahilBot doesn't ship its own {preset.name} app yet, so this takes about {g.minutes} minutes, once. Then {preset.name} connects with one click and you sign in on {preset.name}'s own page.
        </p>
      )}
      <div className="field"><label>Redirect URL (paste this into {preset.name})</label><CopyText text={g.redirectUri} /></div>
      <ol style={{ margin: '0 0 12px', paddingLeft: 20, display: 'grid', gap: 12 }}>
        {g.steps.map((s) => (
          <li key={s.title}>
            <b>{s.title}</b>
            <div className="hint" style={{ margin: '2px 0 4px' }}>{s.text}</div>
            {!!s.links?.length && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {s.links.map(([label, href]) => (
                  <a key={href} className="ca-btn ghost" href={href} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>{label} ↗</a>
                ))}
              </div>
            )}
          </li>
        ))}
      </ol>
      <div className="field"><label>Client ID{g.idHint ? <span className="ca-note"> · {g.idHint}</span> : null}</label>
        <input value={clientId} onChange={(e) => setClientId(e.target.value)} onBlur={() => clientId && setTouched(true)} placeholder="Client ID" spellCheck={false} autoComplete="off" data-testid="setup-client-id" />
      </div>
      <div className="field"><label>Client secret{g.needsSecret ? '' : ' (optional)'}</label>
        <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={g.needsSecret ? 'Client secret' : 'Leave empty if the app uses PKCE only'} autoComplete="off" data-testid="setup-client-secret" />
      </div>
      {(touched && problem) || err ? <div className="hint error" data-testid="setup-error">{err || problem}</div> : null}
      <div className="hint">The secret is kept in your Mac's Keychain. {g.docs ? <a href={g.docs} target="_blank" rel="noreferrer">{preset.name}'s guide ↗</a> : null}</div>
      <div className="modal-actions">
        {onCancel && <button className="btn" onClick={onCancel}>Cancel</button>}
        <button className="btn primary" disabled={busy || (touched && !!problem)} onClick={() => void save()} data-testid="setup-save">{busy ? 'Saving…' : hasClient ? `Save and reconnect ${preset.name}` : `Save and connect ${preset.name}`}</button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- API key (apps whose official server takes your own key)

/**
 * Connect with an API key: a link to the vendor's key page, a paste box, Connect. The key goes
 * straight to main (then the Keychain) and is never shown again, here or anywhere: this panel only
 * learns whether one is saved. On success SahilBot lists the app's tools.
 */
export function ApiKeyPanel({ preset, hasKey, onDone, onCancel, onForget, compact }: {
  preset: ConnectorPreset
  hasKey?: boolean
  onDone: (st: ConnectorStatus) => Promise<void> | void
  onCancel?: () => void
  /** Forget the saved key (native apps, whose key isn't tied to a connector to remove). */
  onForget?: () => Promise<void>
  compact?: boolean
}) {
  const spec = preset.apiKey
  const [key, setKey] = useState('')
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [ok, setOk] = useState('')
  if (!spec) return <div className="hint">{preset.name} doesn't use an API key.</div>
  const problem = keyProblem(key, preset)
  /** "Paste key": main reads the clipboard now (only on this click), checks the key's shape, saves and verifies it. */
  const paste = async (): Promise<void> => {
    setBusy(true)
    setErr('')
    setOk('')
    try {
      const st = await api.connectors.pasteApiKey(preset.id)
      if (st.state === 'connected') setOk(`Connected · ${st.toolNames?.length ?? st.tools} tool${(st.toolNames?.length ?? st.tools) === 1 ? '' : 's'}`)
      else setErr(st.error ?? 'It didn\'t connect. Check the key and try again.')
      await onDone(st)
    } catch (e) {
      setErr(clean(e))
    } finally {
      setBusy(false)
    }
  }
  const save = async (): Promise<void> => {
    setTouched(true)
    if (problem) return
    setBusy(true)
    setErr('')
    setOk('')
    try {
      const st = await api.connectors.setApiKey(preset.id, key)
      // The paste box empties either way: the key now lives only in main.
      setKey('')
      setTouched(false)
      if (st.state === 'connected') setOk(`Connected · ${st.toolNames?.length ?? st.tools} tools`)
      else setErr(st.error ?? 'It didn\'t connect. Check the key and try again.')
      await onDone(st)
    } catch (e) {
      setErr(clean(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="conn-form ca-key" data-testid="api-key-panel">
      {!compact && (
        <p className="ca-lede" style={{ marginTop: 0 }}>
          {preset.auth === 'oauth'
            ? `${preset.name} connects in one click without a key. If you'd rather use a ${preset.name} API key (a service account, say), paste it here: it's kept in your Mac's Keychain, only sent to ${preset.name}, and used instead of signing in.`
            : `${preset.name} connects with your own API key. Paste it once: it's kept in your Mac's Keychain and only sent to ${preset.name}.`}
        </p>
      )}
      {/* The common case needs no typing: open the key page, copy the key there, press Paste key. */}
      <div className="field">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <a className="btn primary" href={spec.getKeyUrl} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }} data-testid="api-key-link">1. Get your {preset.name} key ↗</a>
          <button className="btn primary" disabled={busy} onClick={() => void paste()} data-testid="api-key-paste" title="Reads the key you copied (only now, only this once) and connects">{busy ? 'Connecting…' : hasKey ? '2. Paste new key' : '2. Paste key'}</button>
          {onForget && <button className="btn" disabled={busy} onClick={() => void onForget()} data-testid="api-key-forget">Forget key</button>}
        </div>
        <span className="hint" style={{ margin: '6px 0 0' }}>{spec.hint} Copy it, then press Paste key.</span>
      </div>
      {(touched && problem) || err ? <div className="hint error" data-testid="api-key-error">{err || problem}</div> : null}
      {ok && <div className="hint ok" data-testid="api-key-ok">{ok}</div>}
      <div className="field">
        <label>Or paste it here by hand{hasKey ? <span className="ca-note"> · replaces the saved key</span> : null}</label>
        <input type="password" value={key} onChange={(e) => { setKey(e.target.value); setErr(''); setOk('') }} onBlur={() => key && setTouched(true)}
          onKeyDown={(e) => { if (e.key === 'Enter') void save() }}
          placeholder={spec.placeholder ?? 'API key'} spellCheck={false} autoComplete="off" autoFocus data-testid="api-key-input" />
      </div>
      <div className="modal-actions">
        {onCancel && <button className="btn" onClick={onCancel}>Cancel</button>}
        <button className="btn" disabled={busy || (touched && !!problem)} onClick={() => void save()} data-testid="api-key-save">{busy ? 'Connecting…' : hasKey ? `Replace key and reconnect` : `Connect ${preset.name}`}</button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- Connect Google (one tile, three ways)

/** Same checks as main (mail/gmail-direct.ts), for feedback while typing. */
export function appPasswordUiProblem(raw: string): string | null {
  const p = raw.replace(/[\s-]+/g, '').toLowerCase()
  if (!p) return null
  return /^[a-z]{16}$/.test(p) ? null : `An app password is 16 letters (spaces don't matter); this has ${p.length}.`
}

/**
 * Google, three ways in this order: Sign in with Google (one click, when this build ships a Google client;
 * "Use your own Google Cloud app" under Advanced), the Mac's Mail app (one click, when Mail has a Google
 * account), or an app password (16 letters; needs 2-Step Verification). Once connected it says how, with
 * Disconnect. The app password goes straight to main (then the Keychain) and is never shown again.
 */
function GoogleConnect({ status, gmailPreset, onChanged, onSignIn, onOwnApp, onDisconnectOauth, onDone }: {
  status: GoogleConnectStatus | null
  gmailPreset?: ConnectorPreset
  onChanged: () => Promise<void>
  onSignIn: () => Promise<void>
  onOwnApp: () => void
  onDisconnectOauth: () => Promise<void>
  onDone: () => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [addr, setAddr] = useState('')
  const [pass, setPass] = useState('')
  const [adv, setAdv] = useState(false)
  /** The panel's own status, with Apple Mail's Google accounts (asked only here). */
  const [full, setFull] = useState<GoogleConnectStatus | null>(null)
  useEffect(() => { let alive = true; void api.google.status(true).then((x) => { if (alive) setFull(x) }).catch(() => undefined); return () => { alive = false } }, [status?.link?.method, status?.link?.address])
  const run = async (what: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(what)
    setErr('')
    try { await fn(); await onChanged() } catch (e) { setErr(clean(e)) } finally { setBusy(null) }
  }
  // The link and sign-in state come from Connect apps' own refresh; the Mail accounts from this panel's check.
  const st = status ? { ...status, mail: full?.mail ?? [] } : full
  if (!st) return <div className="hint">Checking Google…</div>
  const link = st.link
  if (link) {
    return (
      <div className="conn-form" data-testid="google-connect">
        <div className="hint ok" data-testid="google-connected">Connected{link.address ? ` · ${link.address}` : ''} · via {GOOGLE_METHOD[link.method]}</div>
        <p className="ca-lede">Chats can use your Gmail now: just ask, e.g. "what needs a reply in my inbox today?"</p>
        {err && <div className="hint error">{err}</div>}
        <div className="modal-actions">
          <button className="btn" disabled={!!busy} data-testid="google-disconnect" onClick={() => void run('off', async () => { if (link.method === 'oauth') await onDisconnectOauth(); await api.google.disconnect() })}>{busy ? 'Disconnecting…' : 'Disconnect'}</button>
          <button className="btn primary" onClick={onDone}>Done</button>
        </div>
      </div>
    )
  }
  const canSignIn = st.oauth.builtin || st.oauth.ownClient
  const passProblem = appPasswordUiProblem(pass)
  return (
    <div className="conn-form ca-google" data-testid="google-connect">
      {err && <div className="hint error" data-testid="google-error">{err}</div>}
      <div className="field">
        <label>Sign in with Google</label>
        <button className={`btn${canSignIn ? ' primary' : ''}`} disabled={!canSignIn || !!busy} data-testid="google-signin" onClick={() => void run('oauth', onSignIn)}>{busy === 'oauth' ? 'Finish signing in in your browser…' : 'Sign in with Google'}</button>
        {!canSignIn && <span className="hint" style={{ margin: 0 }}>Not in this copy of SahilBot yet. Use {st.mail.length ? 'the Mail app or ' : ''}an app password below, or your own Google Cloud app (Advanced).</span>}
        <button className="link-btn" onClick={() => setAdv((v) => !v)} aria-expanded={adv} data-testid="google-advanced">Advanced</button>
        {adv && <button className="btn" onClick={onOwnApp} data-testid="google-own-app">Use your own Google Cloud app…</button>}
      </div>
      {st.mail.length > 0 && (
        <div className="field" data-testid="google-mail-option">
          <label>Use the Mac's Mail app</label>
          {st.mail.map((m) => (
            <button key={m.address} className="btn" disabled={!!busy} data-testid="google-use-mail" onClick={() => void run('mail', () => api.google.useMail(m.address))}>Use {m.address} from Mail</button>
          ))}
          <span className="hint" style={{ margin: '6px 0 0' }}>No sign-in: SahilBot works with the Google account Mail already has.</span>
        </div>
      )}
      <div className="field">
        <label>App password (16 letters)</label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="you@gmail.com" type="email" autoComplete="off" spellCheck={false} aria-label="Gmail address" data-testid="google-app-address" style={{ flex: '1 1 180px' }} />
          <input value={pass} onChange={(e) => setPass(e.target.value)} placeholder="abcd efgh ijkl mnop" type="password" autoComplete="off" spellCheck={false} aria-label="App password" data-testid="google-app-password" style={{ flex: '1 1 160px' }} />
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
          <a className="btn" href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }} data-testid="google-app-password-link">Make an app password ↗</a>
          <button className="btn primary" disabled={!!busy || !addr.trim() || !pass.trim() || !!passProblem} data-testid="google-app-connect"
            onClick={() => void run('app', async () => { await api.google.useAppPassword(addr.trim(), pass); setPass('') })}>{busy === 'app' ? 'Checking with Gmail…' : 'Connect'}</button>
        </div>
        <span className="hint" style={{ margin: '6px 0 0' }}>{passProblem ?? 'Needs 2-Step Verification on your Google account. The password stays in your Mac\'s Keychain.'}</span>
      </div>
      {gmailPreset && <span className="hint">{gmailPreset.description}</span>}
    </div>
  )
}

// ---------------------------------------------------------------- Set up Google once

/** Same checks as main (connectors.validateGoogleClient), for feedback while typing. */
export function googleClientProblem(clientId: string, clientSecret: string): string | null {
  const id = clientId.trim()
  const sec = clientSecret.trim()
  if (!id) return 'Paste the client ID.'
  if (/\s/.test(id)) return 'The client ID has spaces in it; copy it again.'
  if (!/^\d{5,}-[a-z0-9_]{8,}\.apps\.googleusercontent\.com$/i.test(id)) return 'A client ID ends in .apps.googleusercontent.com (e.g. 1234567890-abc123….apps.googleusercontent.com).'
  if (!sec) return 'Paste the client secret too (it starts with GOCSPX-).'
  if (/\s/.test(sec) || sec.length < 16 || sec.length > 80 || (!/^GOCSPX-/.test(sec) && !/^[A-Za-z0-9_-]{20,40}$/.test(sec))) return 'That doesn\'t look like a Google client secret (it usually starts with GOCSPX-).'
  return null
}

const CONSOLE = 'https://console.cloud.google.com'
const GOOGLE_STEPS: Array<{ title: string; text: string; links: Array<[string, string]> }> = [
  { title: 'Create a Google Cloud project', text: 'Any name works, e.g. "SahilBot". It\'s free; no billing needed.', links: [['Create project', `${CONSOLE}/projectcreate`]] },
  {
    title: 'Turn on the Gmail, Calendar and Drive APIs',
    text: 'With the new project picked at the top of the page, press Enable on each. If the API Library also lists MCP versions of them, enable those too. Using Google Docs, Sheets, Slides or BigQuery as well? Enable their APIs in the same project.',
    links: [['Gmail API', `${CONSOLE}/apis/library/gmail.googleapis.com`], ['Calendar API', `${CONSOLE}/apis/library/calendar-json.googleapis.com`], ['Drive API', `${CONSOLE}/apis/library/drive.googleapis.com`], ['Docs API', `${CONSOLE}/apis/library/docs.googleapis.com`], ['Sheets API', `${CONSOLE}/apis/library/sheets.googleapis.com`], ['Slides API', `${CONSOLE}/apis/library/slides.googleapis.com`], ['BigQuery API', `${CONSOLE}/apis/library/bigquery.googleapis.com`], ['Search "MCP"', `${CONSOLE}/apis/library?q=mcp`]]
  },
  {
    title: 'Set up the consent screen',
    text: 'Get started → app name "SahilBot", your email → Audience: External → create. Then under Audience → Test users, add your own Google address. Leave it in Testing: only you can sign in.',
    links: [['Consent screen', `${CONSOLE}/auth/overview`], ['Test users', `${CONSOLE}/auth/audience`]]
  },
  { title: 'Create a Desktop OAuth client', text: 'Application type: Desktop app, name "SahilBot" → Create. Copy the Client ID and the Client secret it shows.', links: [['Create client', `${CONSOLE}/auth/clients/create`]] },
  { title: 'Paste them here', text: 'SahilBot uses this one client for Gmail, Calendar and Drive. The secret is kept in your Mac\'s Keychain; your email never goes through anyone else\'s servers.', links: [] }
]

/**
 * "Set up Google once": step-by-step with direct links into Google Cloud Console, then the client ID
 * and secret, checked as you type and shared by every Google app. Also shown inside the in-chat
 * Connect card when a task needs Gmail, Calendar or Drive.
 */
export function GoogleSetup({ forApp, onDone, onCancel, compact, builtin }: {
  forApp?: string
  onDone: (info: { clientId: string; hasSecret: boolean }) => void
  onCancel?: () => void
  compact?: boolean
  /** SahilBot ships its own Google app: this panel is only "Use your own Google app". */
  builtin?: boolean
}) {
  const [current, setCurrent] = useState<{ clientId: string; hasSecret: boolean } | null | undefined>(undefined)
  const [editing, setEditing] = useState(false)
  const [clientId, setClientId] = useState('')
  const [secret, setSecret] = useState('')
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => { void api.connectors.googleClient().then(setCurrent).catch(() => setCurrent(null)) }, [])
  const problem = googleClientProblem(clientId, secret)

  const save = async (): Promise<void> => {
    setTouched(true)
    if (problem) return
    setBusy(true)
    setErr('')
    try {
      const info = await api.connectors.setGoogleClient(clientId.trim(), secret.trim())
      setCurrent(info)
      setEditing(false)
      setSecret('')
      onDone(info)
    } catch (e) {
      setErr(clean(e))
    } finally {
      setBusy(false)
    }
  }

  if (current === undefined) return <div className="hint">Loading…</div>
  if (current && !editing) {
    return (
      <div className="conn-form" data-testid="google-setup">
        <div className="hint">Google is set up with client …{current.clientId.split('-')[0].slice(-4)}{current.hasSecret ? ' (secret in your Keychain)' : ''}. Gmail, Calendar and Drive each connect with one click and their own Google sign-in.</div>
        <div className="modal-actions">
          {onCancel && <button className="btn" onClick={onCancel}>Back</button>}
          <button className="btn" onClick={() => setEditing(true)}>Use a different client</button>
          <button className="btn primary" onClick={() => onDone(current)} data-testid="google-setup-continue">{forApp ? `Connect ${forApp}` : 'Done'}</button>
        </div>
      </div>
    )
  }
  return (
    <div className="conn-form" data-testid="google-setup">
      {!compact && (builtin
        ? <p className="ca-lede" style={{ marginTop: 0 }} data-testid="own-app-lede">You don't need this: Google apps already connect in one click with SahilBot's own Google app. Use your own Google Cloud app only if you want sign-ins to go through a project you control. It takes about 5 minutes.</p>
        : <p className="ca-lede" style={{ marginTop: 0 }}>Google only lets you sign in apps registered with it, and SahilBot doesn't ship its own Google app yet, so this takes about 5 minutes, once. {forApp ? `Then ${forApp} connects` : 'Then Gmail, Calendar and Drive connect'} with one click.</p>)}
      <ol style={{ margin: '0 0 12px', paddingLeft: 20, display: 'grid', gap: compact ? 8 : 12 }}>
        {GOOGLE_STEPS.map((s) => (
          <li key={s.title}>
            <b>{s.title}</b>
            <div className="hint" style={{ margin: '2px 0 4px' }}>{s.text}</div>
            {s.links.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {s.links.map(([label, href]) => (
                  <a key={href} className="ca-btn ghost" href={href} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>{label} ↗</a>
                ))}
              </div>
            )}
          </li>
        ))}
      </ol>
      <div className="field"><label>Client ID</label>
        <input value={clientId} onChange={(e) => setClientId(e.target.value)} onBlur={() => clientId && setTouched(true)} placeholder="1234567890-abc123.apps.googleusercontent.com" spellCheck={false} autoComplete="off" data-testid="google-client-id" />
      </div>
      <div className="field"><label>Client secret</label>
        <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="GOCSPX-…" autoComplete="off" data-testid="google-client-secret" />
      </div>
      {(touched && problem) || err ? <div className="hint error" data-testid="google-setup-error">{err || problem}</div> : null}
      <div className="hint">Google may ask you to sign in again about once a week while the app is in Testing. Publishing it (Audience → Publish app) stops that; Google may show an "unverified app" notice you can continue past, since it's your own app.</div>
      <div className="modal-actions">
        {onCancel && <button className="btn" onClick={onCancel}>Cancel</button>}
        {current && <button className="btn" onClick={() => setEditing(false)}>Keep the current client</button>}
        <button className="btn primary" disabled={busy || (touched && !!problem)} onClick={() => void save()} data-testid="google-setup-save">{busy ? 'Saving…' : forApp ? `Save and connect ${forApp}` : 'Save'}</button>
      </div>
    </div>
  )
}
