import { toast } from '../lib/toast'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { BotTemplate, ConnectorConfig, ConnectorPreset, ConnectorStatus, Skill } from '@shared/types'
import { api } from '../api'
import * as I from '../icons'
import { SpaceAvatar } from '../brand'
import { AppIcon, IconStack, connectedApps, useAppIcons } from './ConnectedIcons'
import { CUSTOM_REDIRECT, MAIN_CHIPS, MORE_CATEGORIES, SECTION_ORDER, connectBadge, matches, recommended } from '../lib/connect-catalog'
import { importBot } from './BotShare'

const STATE_TEXT: Record<ConnectorStatus['state'], string> = {
  off: 'Off', disconnected: 'Disconnected', connecting: 'Connecting…', signing_in: 'Finish signing in in your browser…',
  needs_auth: 'Needs sign-in', connected: 'Connected', error: 'Error', reconnecting: 'Reconnecting…'
}

/** SahilBot's own saved-logins vault, listed under Password Managers (opens Settings → Passwords). */
const VAULT: ConnectorPreset = {
  id: 'sahilbot-vault', name: 'SahilBot Vault', url: 'app:vault', color: '#3A3A3C', category: 'Password Managers', auth: 'app',
  description: 'Saved logins SahilBot types into sites for you, encrypted in your Keychain.'
}

const clean = (e: unknown): string => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const prettyTool = (n: string): string => n.replace(/[_\-.]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
const ACRONYMS = /^(pdf|pcb|sql|seo|ci|api|ios|gdt|dfm)$/i
const prettySkill = (n: string): string => n.split('-').map((w) => (ACRONYMS.test(w) ? w.toUpperCase() : w)).join(' ').replace(/^\w/, (c) => c.toUpperCase())

type View = 'browse' | 'manage' | 'templates' | 'form' | 'google' | 'setup'
type Form = { preset: ConnectorPreset; name: string; kind: 'remote' | 'stdio'; url: string; command: string; headerName: string; headerValue: string; clientId: string; clientSecret: string }

/**
 * Connect Apps: browse the catalog, connect apps (OAuth in your browser, Google client ID, custom MCP
 * servers, or no-setup browser sign-in), manage connected apps and their tools, and add bot templates.
 * Spec: design/bot-ui.md → Connect Apps.
 */
export function ConnectApps({ onClose, onBrowse, onOpenBot, onOpenSettings }: {
  onClose: () => void
  onBrowse: (url: string) => void
  /** Open a bot's chat after adding a template (falls back to a toast). */
  onOpenBot?: (spaceId: string, threadId?: string) => void
  /** Open Settings at a page (falls back to a toast). */
  onOpenSettings?: (page: 'passwords' | 'rules') => void
}) {
  const [presets, setPresets] = useState<ConnectorPreset[]>([])
  const [configs, setConfigs] = useState<ConnectorConfig[]>([])
  const [statuses, setStatuses] = useState<ConnectorStatus[]>([])
  const [skills, setSkills] = useState<Skill[]>([])
  const [templates, setTemplates] = useState<BotTemplate[]>([])
  const [form, setForm] = useState<Form | null>(null)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  const [view, setView] = useState<View>('browse')
  const [chip, setChip] = useState<string>('All')
  const [moreOpen, setMoreOpen] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const [adding, setAdding] = useState<string | null>(null)
  /** The Google app waiting for "Set up Google once" to finish (connects right after). */
  const [googleFor, setGoogleFor] = useState<ConnectorPreset | null>(null)
  const [google, setGoogle] = useState<{ clientId: string; hasSecret: boolean } | null>(null)
  /** The app whose one-time OAuth setup is open (oauth-static presets). */
  const [setupFor, setSetupFor] = useState<ConnectorPreset | null>(null)
  /** Test connection results by connector id. */
  const [tests, setTests] = useState<Record<string, { ok: boolean; text: string }>>({})
  const body = useRef<HTMLDivElement>(null)
  const icons = useAppIcons()

  const load = async (): Promise<void> => {
    const r = await api.connectors.list()
    setConfigs(r.configs)
    setStatuses(r.statuses)
    setGoogle(await api.connectors.googleClient().catch(() => null))
  }
  useEffect(() => {
    void api.connectors.presets().then(setPresets)
    void api.skills.list().then(setSkills).catch(() => undefined)
    void load()
    return api.connectors.onChange(() => void load())
  }, [])
  useEffect(() => {
    if (view === 'templates' && !templates.length) void api.templates.list().then(setTemplates).catch((e) => setErr(clean(e)))
  }, [view, templates.length])
  useEffect(() => {
    // preventDefault: this Esc is spent closing this (the chat's run and the details panel leave it alone).
    const k = (e: KeyboardEvent): void => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); onClose() } }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  useEffect(() => { body.current?.scrollTo({ top: 0 }) }, [view, chip])

  const status = (id: string): ConnectorStatus | undefined => statuses.find((s) => s.id === id)
  const configOf = (p: ConnectorPreset): ConnectorConfig | undefined => configs.find((c) => c.preset === p.id)
  const connected = useMemo(() => connectedApps(configs, statuses, presets), [configs, statuses, presets])
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
      if (onOpenSettings) { onClose(); onOpenSettings('passwords') } else toast('Your saved logins are in Settings → Passwords.')
      return
    }
    // No-setup apps: just open the site in SahilBot's browser and sign in once.
    if (p.auth === 'browser') { onBrowse(p.url); onClose(); return }
    // Built-in apps need nothing: just ask SahilBot to use them.
    if (p.auth === 'app') { toast(`${p.name} is built in. Just ask SahilBot, e.g. "${p.url === 'app:cursor' ? 'open this project in Cursor' : p.url === 'app:mail' ? 'what needs a reply in my inbox today?' : 'add a reminder for tomorrow at 9'}".`); return }
    const existing = configOf(p)
    // Google apps without the shared client (and without their own): set Google up first.
    if (p.auth === 'google' && !google && !existing?.clientId && status(existing?.id ?? '')?.state !== 'connected') { setGoogleFor(p); go('google'); return }
    // Apps without self-registration: create their OAuth app once, then they connect in one click.
    if (p.auth === 'oauth-static' && !existing?.clientId) { setSetupFor(p); go('setup'); return }
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

  const addTemplate = async (t: BotTemplate): Promise<void> => {
    setErr('')
    setAdding(t.id)
    try {
      const r = await api.templates.add(t.id)
      onClose()
      if (onOpenBot) onOpenBot(r.spaceId, r.threadId)
      else toast('Added — find it in your sidebar')
    } catch (e) {
      setErr(clean(e))
    } finally {
      setAdding(null)
    }
  }

  const setTool = async (c: ConnectorConfig, tool: string, on: boolean): Promise<void> => {
    // Optimistic: the switch moves at once; the saved config comes back through onChange.
    setConfigs((all) => all.map((x) => (x.id === c.id ? { ...x, disabledTools: on ? (x.disabledTools ?? []).filter((n) => n !== tool) : [...(x.disabledTools ?? []), tool] } : x)))
    try { await api.connectors.setToolEnabled(c.id, tool, on) } catch (e) { setErr(clean(e)); void load() }
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
    const [label, tone] =
      p.id === VAULT.id ? ['Open', 'ghost'] :
      p.auth === 'app' ? ['Built in', 'ok'] :
      p.auth === 'browser' ? ['Open', 'ghost'] :
      st?.state === 'connected' ? ['Connected', 'done'] :
      busy ? ['Connecting…', 'ghost'] :
      p.auth === 'oauth-static' && !cfg?.clientId ? ['Set up', 'ghost'] :
      cfg ? ['Connect', 'solid'] : ['Add', 'ghost']
    const badge = st?.state === 'connected' ? null : connectBadge(p)
    const act = (): void => { if (!busy) void start(p) }
    return (
      <div key={p.id} className="ca-item" role="button" tabIndex={0} data-testid={`preset-${p.id}`} data-state={st?.state}
        onClick={act} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act() } }}>
        {p.id === VAULT.id
          ? <span className="ca-icon vault" style={{ width: 44, height: 44, borderRadius: 12 }}><I.Shield size={22} /></span>
          : <AppIcon src={icons[p.id]} name={p.name} color={p.color} />}
        <span className="ca-item-text">
          <b>{p.name}{badge && <small className={`ca-badge ${badge === 'One click' ? 'one-click' : 'setup'}`} data-testid={`badge-${p.id}`} title={badge === 'One click' ? 'Sign in on the app\'s own page; nothing to set up' : p.auth === 'google' ? 'One-time Google setup (about 5 minutes), then one click' : `One-time setup at ${p.name} (about ${p.setup?.minutes ?? 5} minutes), then one click`}
            style={{ marginLeft: 8, padding: '1px 7px', borderRadius: 999, fontSize: 11, fontWeight: 600, verticalAlign: 1, background: badge === 'One click' ? 'color-mix(in srgb, var(--ok, #2e9d5b) 16%, transparent)' : 'color-mix(in srgb, var(--text-3, #888) 18%, transparent)', color: badge === 'One click' ? 'var(--ok, #2e9d5b)' : 'var(--text-2, #666)' }}>{badge}</small>}</b>
          <span>{st?.state === 'needs_auth' || st?.state === 'error' || st?.state === 'reconnecting' ? STATE_TEXT[st.state] : p.auth === 'google' && !google && !cfg ? `${p.description} One-time Google setup first.` : p.auth === 'oauth-static' && !cfg?.clientId ? `${p.description} One-time setup first.` : p.description}</span>
        </span>
        <span className={`ca-btn ${tone}`} aria-disabled={busy || undefined}>
          {label}{tone === 'done' && <I.Check size={13} />}
        </span>
      </div>
    )
  }

  const section = (title: string, items: ConnectorPreset[], opts: { limit?: number; viewAll?: string; note?: string } = {}): ReactNode => {
    if (!items.length) return null
    const shown = opts.limit ? items.slice(0, opts.limit) : items
    return (
      <section className="ca-section" key={title}>
        <div className="ca-section-head">
          <h3>{title}</h3>
          {opts.note && <span className="ca-note">{opts.note}</span>}
          {opts.viewAll && items.length > shown.length && (
            <button className="ca-viewall" onClick={() => setChip(opts.viewAll!)}>View all {items.length}<I.Chevron size={13} style={{ transform: 'rotate(-90deg)' }} /></button>
          )}
        </div>
        <div className="ca-list">{shown.map(item)}</div>
      </section>
    )
  }

  const openSkill = (): void => { if (onOpenSettings) { onClose(); onOpenSettings('rules') } else toast('SahilBot uses skills on its own when they fit. Manage them in Settings → Rules & Skills.') }
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
      const apps = catalog.filter((p) => matches(query, p.name, p.description, p.category))
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
      return section(chip, byCategory(chip), chip === 'Built in' ? { note: 'No setup' } : {})
    }
    return (
      <>
        {section('Recommended for you', recommended(presets, connectedPresetIds))}
        {SECTION_ORDER.map((cat) => section(cat, byCategory(cat), { limit: 6, viewAll: cat, note: cat === 'Built in' ? 'No setup' : undefined }))}
        <p className="ca-foot">Sign-in happens in your browser; tokens stay in your Mac's Keychain. Connected tools load only when a task needs them.</p>
      </>
    )
  }

  const manage = (): ReactNode => (
    <>
      {configs.length === 0 && (
        <div className="ca-empty">
          <b>No apps connected yet.</b>
          <span>Connect an app and SahilBot can use it in any chat.</span>
          <button className="btn" onClick={() => go('browse')}>Browse apps</button>
        </div>
      )}
      <div className="ca-manage">
        {configs.map((c) => {
          const st = status(c.id)
          const preset = presets.find((p) => p.id === c.preset)
          const names = st?.toolNames ?? []
          const off = new Set(c.disabledTools ?? [])
          const on = names.filter((n) => !off.has(n)).length
          const state = st?.state ?? (c.enabled ? 'disconnected' : 'off')
          const busy = state === 'connecting' || state === 'signing_in'
          const expanded = open === c.id && state === 'connected' && names.length > 0
          return (
            <div className={`ca-app${expanded ? ' open' : ''}`} key={c.id}>
              <div className="conn-row ca-app-row" data-testid="connector-row" data-state={st?.state}>
                <AppIcon src={preset ? icons[preset.id] : undefined} name={c.name} color={preset?.color} size={40} />
                <div className="conn-text">
                  <b>{c.name}</b>
                  <span className={`ca-status ${state}`}>
                    <i />{STATE_TEXT[state]}
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
                ) : (
                  <button className="btn primary" disabled={busy} onClick={() => void guard(() => api.connectors.connect(c.id))}>
                    {busy ? 'Connecting…' : state === 'needs_auth' ? 'Sign in' : 'Reconnect'}
                  </button>
                )}
                {preset?.setup && (
                  <button className="btn" title={`Change the OAuth app ${c.name} signs in with`} data-testid="connector-setup" onClick={() => { setSetupFor(preset); go('setup') }}>Setup</button>
                )}
                <button className="icon-btn" title="Remove" aria-label={`Remove ${c.name}`} onClick={() => { if (confirm(`Remove ${c.name}? You can add it again later.`)) void guard(() => api.connectors.remove(c.id)) }}><I.Trash size={15} /></button>
              </div>
              {tests[c.id] && (
                <div className="hint" data-testid="connector-test-result" style={{ margin: '2px 0 8px 52px', color: tests[c.id].ok ? 'var(--ok, #2e9d5b)' : 'var(--danger)' }}>{tests[c.id].text}</div>
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
          {google ? `Google apps use your OAuth client …${google.clientId.split('-')[0].slice(-4)}. ` : 'Google apps need a one-time setup. '}
          <button className="ca-viewall" onClick={() => { setGoogleFor(null); go('google') }} data-testid="google-setup-open">{google ? 'Change Google setup' : 'Set up Google once'}</button>
        </p>
      )}
    </>
  )

  const gallery = (): ReactNode => (
    <>
      <p className="ca-lede">Ready-made bots with a job, the right skills and suggested routines. Routines start paused until you turn them on.</p>
      <button className="ca-btn bs-import-btn" onClick={() => void importBot(onClose)} data-testid="template-import"><I.Share size={14} />Import from file…</button>
      {!templates.length && !err && <div className="ca-empty"><span>Loading templates…</span></div>}
      <div className="ca-templates">
        {templates.map((t) => (
          <div className="ca-template" key={t.id} data-testid={`template-${t.id}`}>
            <SpaceAvatar color={t.color} shape={t.shape} size={48} />
            <div className="ca-template-text">
              <b>{t.name}</b>
              <span className="ca-by">by SahilBot</span>
              <span className="ca-template-desc">{t.description}</span>
              {t.routines.length > 0 && <span className="ca-template-meta"><I.Clock size={12} />{t.routines.length} suggested routine{t.routines.length === 1 ? '' : 's'} · paused</span>}
            </div>
            <button className="ca-btn solid" disabled={!!adding} onClick={() => void addTemplate(t)}>{adding === t.id ? 'Adding…' : 'Add'}</button>
          </div>
        ))}
      </div>
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
  const title = view === 'manage' ? 'Connected apps' : view === 'templates' ? 'Bot templates' : view === 'form' ? 'Add an app' : view === 'google' ? 'Set up Google once' : view === 'setup' && setupFor ? `Set up ${setupFor.name} once` : 'Connect Apps'

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal connect-modal ca" data-testid="connect-apps-modal" role="dialog" aria-label={title}>
        <header className="ca-head">
          {view !== 'browse' && (
            <button className="icon-btn ca-back" aria-label="Back" onClick={() => { setForm(null); setSetupFor(null); go('browse') }}>
              <I.Chevron size={18} style={{ transform: 'rotate(90deg)' }} />
            </button>
          )}
          <h2>{title}</h2>
          {view === 'browse' && (
            <button className="ca-count" onClick={() => go('manage')} data-testid="connected-count">
              <IconStack apps={connected} icons={icons} max={3} />
              {connected.length} connected<I.Chevron size={13} style={{ transform: 'rotate(-90deg)' }} />
            </button>
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
            <button className="ca-templates-btn" onClick={() => go('templates')} data-testid="bot-templates"><I.Users size={15} />Bot templates</button>
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
          {view === 'templates' && gallery()}
          {view === 'form' && formView()}
          {view === 'setup' && setupFor && (
            <AppSetup
              preset={setupFor}
              hasClient={!!configOf(setupFor)?.clientId}
              onCancel={() => { setSetupFor(null); go('browse') }}
              onDone={(id, secret) => afterSetup(setupFor, id, secret)} />
          )}
          {view === 'google' && (
            <GoogleSetup
              forApp={googleFor?.name}
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
  if (st.state === 'needs_auth') return 'Needs sign-in: press Sign in.'
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
      <p className="ca-lede" style={{ marginTop: 0 }}>
        {preset.name}'s MCP server only signs in apps registered with {preset.name}, so this takes about {g.minutes} minutes, once. Then {preset.name} connects with one click and you sign in on {preset.name}'s own page.
      </p>
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
      {(touched && problem) || err ? <div className="hint" style={{ color: 'var(--danger)' }} data-testid="setup-error">{err || problem}</div> : null}
      <div className="hint">The secret is kept in your Mac's Keychain. {g.docs ? <a href={g.docs} target="_blank" rel="noreferrer">{preset.name}'s guide ↗</a> : null}</div>
      <div className="modal-actions">
        {onCancel && <button className="btn" onClick={onCancel}>Cancel</button>}
        <button className="btn primary" disabled={busy || (touched && !!problem)} onClick={() => void save()} data-testid="setup-save">{busy ? 'Saving…' : hasClient ? `Save and reconnect ${preset.name}` : `Save and connect ${preset.name}`}</button>
      </div>
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
    text: 'With the new project picked at the top of the page, press Enable on each. If the API Library also lists MCP versions of them, enable those too.',
    links: [['Gmail API', `${CONSOLE}/apis/library/gmail.googleapis.com`], ['Calendar API', `${CONSOLE}/apis/library/calendar-json.googleapis.com`], ['Drive API', `${CONSOLE}/apis/library/drive.googleapis.com`], ['Search "MCP"', `${CONSOLE}/apis/library?q=mcp`]]
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
export function GoogleSetup({ forApp, onDone, onCancel, compact }: {
  forApp?: string
  onDone: (info: { clientId: string; hasSecret: boolean }) => void
  onCancel?: () => void
  compact?: boolean
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
      {!compact && <p className="ca-lede" style={{ marginTop: 0 }}>Google only lets you sign in apps registered to you, so this takes about 5 minutes, once. {forApp ? `Then ${forApp} connects` : 'Then Gmail, Calendar and Drive connect'} with one click.</p>}
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
      {(touched && problem) || err ? <div className="hint" style={{ color: 'var(--danger)' }} data-testid="google-setup-error">{err || problem}</div> : null}
      <div className="hint">Google may ask you to sign in again about once a week while the app is in Testing. Publishing it (Audience → Publish app) stops that; Google may show an "unverified app" notice you can continue past, since it's your own app.</div>
      <div className="modal-actions">
        {onCancel && <button className="btn" onClick={onCancel}>Cancel</button>}
        {current && <button className="btn" onClick={() => setEditing(false)}>Keep the current client</button>}
        <button className="btn primary" disabled={busy || (touched && !!problem)} onClick={() => void save()} data-testid="google-setup-save">{busy ? 'Saving…' : forApp ? `Save and connect ${forApp}` : 'Save'}</button>
      </div>
    </div>
  )
}
