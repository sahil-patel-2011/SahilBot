import { toast } from '../lib/toast'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { BotTemplate, ConnectorConfig, ConnectorPreset, ConnectorStatus, Skill } from '@shared/types'
import { api } from '../api'
import * as I from '../icons'
import { SpaceAvatar } from '../brand'
import { AppIcon, IconStack, connectedApps, useAppIcons } from './ConnectedIcons'
import { MAIN_CHIPS, MORE_CATEGORIES, SECTION_ORDER, matches, recommended } from '../lib/connect-catalog'

const STATE_TEXT: Record<ConnectorStatus['state'], string> = {
  off: 'Off', disconnected: 'Disconnected', connecting: 'Connecting…', signing_in: 'Finish signing in in your browser…',
  needs_auth: 'Needs sign-in', connected: 'Connected', error: 'Error'
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

type View = 'browse' | 'manage' | 'templates' | 'form'
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
  const body = useRef<HTMLDivElement>(null)
  const icons = useAppIcons()

  const load = async (): Promise<void> => {
    const r = await api.connectors.list()
    setConfigs(r.configs)
    setStatuses(r.statuses)
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
    if (p.auth === 'app') { toast(`${p.name} is built in. Just ask SahilBot, e.g. "${p.url === 'app:cursor' ? 'open this project in Cursor' : 'add a reminder for tomorrow at 9'}".`); return }
    const existing = configOf(p)
    if (existing) {
      if (status(existing.id)?.state === 'connected') { setOpen(existing.id); go('manage'); return }
      try { await api.connectors.connect(existing.id) } catch (e) { setErr(clean(e)) }
      return
    }
    // Known servers connect in one click; Google needs your client ID; custom needs details.
    if (p.id !== 'custom' && p.auth !== 'google') {
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
      cfg ? ['Connect', 'solid'] : ['Add', 'ghost']
    const act = (): void => { if (!busy) void start(p) }
    return (
      <div key={p.id} className="ca-item" role="button" tabIndex={0} data-testid={`preset-${p.id}`} data-state={st?.state}
        onClick={act} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act() } }}>
        {p.id === VAULT.id
          ? <span className="ca-icon vault" style={{ width: 44, height: 44, borderRadius: 12 }}><I.Shield size={22} /></span>
          : <AppIcon src={icons[p.id]} name={p.name} color={p.color} />}
        <span className="ca-item-text">
          <b>{p.name}</b>
          <span>{st?.state === 'needs_auth' || st?.state === 'error' ? STATE_TEXT[st.state] : p.description}</span>
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
                    {st?.error ? ` · ${st.error}` : ''}
                  </span>
                </div>
                {state === 'connected' && names.length > 0 && (
                  <button className="ca-tools-btn" onClick={() => setOpen(expanded ? null : c.id)} aria-expanded={expanded}>
                    Tools<I.Chevron size={13} style={{ transform: expanded ? 'rotate(180deg)' : undefined }} />
                  </button>
                )}
                {state === 'connected' ? (
                  <button className="btn" onClick={() => void guard(() => api.connectors.disconnect(c.id))}>Disconnect</button>
                ) : (
                  <button className="btn primary" disabled={busy} onClick={() => void guard(() => api.connectors.connect(c.id))}>
                    {busy ? 'Connecting…' : state === 'needs_auth' ? 'Sign in' : 'Reconnect'}
                  </button>
                )}
                <button className="icon-btn" title="Remove" aria-label={`Remove ${c.name}`} onClick={() => { if (confirm(`Remove ${c.name}? You can add it again later.`)) void guard(() => api.connectors.remove(c.id)) }}><I.Trash size={15} /></button>
              </div>
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
    </>
  )

  const gallery = (): ReactNode => (
    <>
      <p className="ca-lede">Ready-made bots with a job, the right skills and suggested routines. Routines start paused until you turn them on.</p>
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
      {form.preset.auth === 'google' && (
        <>
          <div className="hint" style={{ margin: '6px 0 10px' }}>
            Google only signs in apps registered to you. Once: open Google Cloud Console → APIs &amp; Services → Credentials → Create credentials → OAuth client ID → <b>Desktop app</b>, and enable the {form.preset.name} API. Paste the client ID (and secret) here; the secret is kept in your Keychain.
          </div>
          <div className="field"><label>OAuth client ID</label><input value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} placeholder="1234-abc.apps.googleusercontent.com" data-testid="conn-client-id" /></div>
          <div className="field"><label>Client secret</label><input type="password" value={form.clientSecret} onChange={(e) => setForm({ ...form, clientSecret: e.target.value })} placeholder="GOCSPX-…" /></div>
        </>
      )}
      {form.preset.auth === 'google' ? null : form.kind === 'remote' ? (
        <>
          <div className="field"><label>Server URL</label><input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://example.com/mcp" data-testid="conn-url" /></div>
          <div className="field"><label>API key header (optional)</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input value={form.headerName} onChange={(e) => setForm({ ...form, headerName: e.target.value })} placeholder="Authorization" style={{ flex: 1 }} />
              <input type="password" value={form.headerValue} onChange={(e) => setForm({ ...form, headerValue: e.target.value })} placeholder="Bearer …" style={{ flex: 2 }} />
            </div>
          </div>
          <div className="hint">Leave the header empty to sign in with OAuth in your browser.</div>
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
  const title = view === 'manage' ? 'Connected apps' : view === 'templates' ? 'Bot templates' : view === 'form' ? 'Add an app' : 'Connect Apps'

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal connect-modal ca" data-testid="connect-apps-modal" role="dialog" aria-label={title}>
        <header className="ca-head">
          {view !== 'browse' && (
            <button className="icon-btn ca-back" aria-label="Back" onClick={() => { setForm(null); go('browse') }}>
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
        </div>
      </div>
    </div>
  )
}
