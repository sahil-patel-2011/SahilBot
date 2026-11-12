import { toast } from '../lib/toast'
import { useEffect, useState } from 'react'
import type { ConnectorConfig, ConnectorPreset, ConnectorStatus } from '@shared/types'
import { api } from '../api'
import * as I from '../icons'

const STATE_TEXT: Record<ConnectorStatus['state'], string> = {
  off: 'Off', disconnected: 'Not connected', connecting: 'Connecting…', signing_in: 'Finish signing in in your browser…',
  needs_auth: 'Sign-in needed', connected: 'Connected', error: 'Error'
}

/** Connect apps: sign in to remote MCP servers (OAuth in your browser) or run local ones. */
export function ConnectApps({ onClose, onBrowse }: { onClose: () => void; onBrowse: (url: string) => void }) {
  const [presets, setPresets] = useState<ConnectorPreset[]>([])
  const [configs, setConfigs] = useState<ConnectorConfig[]>([])
  const [statuses, setStatuses] = useState<ConnectorStatus[]>([])
  const [form, setForm] = useState<{ preset: ConnectorPreset; name: string; kind: 'remote' | 'stdio'; url: string; command: string; headerName: string; headerValue: string; clientId: string; clientSecret: string } | null>(null)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')

  const load = async (): Promise<void> => {
    const r = await api.connectors.list()
    setConfigs(r.configs)
    setStatuses(r.statuses)
  }
  useEffect(() => {
    void api.connectors.presets().then(setPresets)
    void load()
    return api.connectors.onChange(() => void load())
  }, [])
  useEffect(() => {
    const k = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])

  const status = (id: string): ConnectorStatus | undefined => statuses.find((s) => s.id === id)

  const start = async (p: ConnectorPreset): Promise<void> => {
    setErr('')
    // No-setup apps: just open the site in SahilBot's browser and sign in once.
    if (p.auth === 'browser') { onBrowse(p.url); onClose(); return }
    // Built-in apps need nothing: just ask SahilBot to use them.
    if (p.auth === 'app') { toast(`${p.name} is built in. Just ask SahilBot, e.g. "${p.url === 'app:cursor' ? 'open this project in Cursor' : 'add a reminder for tomorrow at 9'}".`); return }
    const existing = configs.find((c) => c.preset === p.id)
    if (existing) { await api.connectors.connect(existing.id); return }
    // Known servers connect in one click; Google needs your client ID; custom needs details.
    if (p.id !== 'custom' && p.auth !== 'google') {
      try {
        const saved = await api.connectors.save({ name: p.name, kind: 'remote', url: p.url, preset: p.id, enabled: true })
        await load()
        await api.connectors.connect(saved.id)
      } catch (e) {
        setErr((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
      }
      return
    }
    setForm({ preset: p, name: p.id === 'custom' ? '' : p.name, kind: 'remote', url: p.url, command: '', headerName: '', headerValue: '', clientId: '', clientSecret: '' })
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
      await load()
      await api.connectors.connect(saved.id)
    } catch (e) {
      setErr((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal connect-modal" data-testid="connect-apps-modal">
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <h2 style={{ flex: 1 }}>Connect apps</h2>
          <button className="icon-btn" onClick={onClose}><I.Close size={16} /></button>
        </div>
        <div className="hint">SahilBot talks to apps through MCP connectors. Sign-in happens in your browser; tokens stay in your Mac's Keychain. Connected tools load only when a task needs them.</div>

        {configs.length > 0 && (
          <>
            <h3>Your connectors</h3>
            {configs.map((c) => {
              const st = status(c.id)
              const preset = presets.find((p) => p.id === c.preset)
              return (
                <div className="conn-row" key={c.id} data-testid="connector-row" data-state={st?.state}>
                  <span className="conn-logo" style={{ background: preset?.color ?? '#7C5CFF' }}>{c.name[0]}</span>
                  <div className="conn-text">
                    <b>{c.name}</b>
                    <span className={`hint conn-${st?.state}`}>{st ? STATE_TEXT[st.state] : 'Not connected'}{st?.state === 'connected' ? ` · ${st.tools} tools` : ''}{st?.error ? ` · ${st.error}` : ''}</span>
                  </div>
                  {st?.state === 'connected' ? (
                    <button className="btn" onClick={() => void api.connectors.disconnect(c.id)}>Disconnect</button>
                  ) : (
                    <button className="btn primary" disabled={st?.state === 'connecting' || st?.state === 'signing_in'} onClick={() => void api.connectors.connect(c.id)}>
                      {c.kind === 'remote' && !c.headerName ? 'Sign in' : 'Connect'}
                    </button>
                  )}
                  <button className="icon-btn" title="Remove" onClick={() => { if (confirm(`Remove ${c.name}?`)) void api.connectors.remove(c.id) }}><I.Trash size={15} /></button>
                </div>
              )
            })}
          </>
        )}

        <div className="conn-search">
          <I.Search size={15} />
          <input placeholder={`Search ${presets.length} connectors`} value={q} onChange={(e) => setQ(e.target.value)} data-testid="conn-search" />
        </div>
        {err && <div className="hint" style={{ color: 'var(--danger)' }}>{err}</div>}
        {[...new Set(presets.map((p) => p.category))].map((cat) => {
          const items = presets.filter((p) => p.category === cat && (!q.trim() || `${p.name} ${p.description} ${cat}`.toLowerCase().includes(q.toLowerCase())))
          if (!items.length) return null
          return (
            <div key={cat}>
              <h3>{cat}</h3>
              <div className="conn-grid">
                {items.map((p) => {
                  const cfg = configs.find((c) => c.preset === p.id)
                  const st = cfg ? status(cfg.id) : undefined
                  return (
                    <button key={p.id} className="conn-card" onClick={() => void start(p)} data-testid={`preset-${p.id}`}>
                      <span className="conn-head">
                        <span className="conn-logo" style={{ background: p.color, color: ['#FFD02F', '#FFD21E', '#18BFFF', '#00E599', '#3ECF8E'].includes(p.color) ? '#111' : '#fff' }}>{p.name[0]}</span>
                        {st?.state === 'connected' ? <span className="conn-badge ok">Connected</span> : p.auth === 'browser' ? <span className="conn-badge ok">No setup</span> : p.auth === 'app' ? <span className="conn-badge ok">Built in</span> : p.auth === 'none' ? <span className="conn-badge">No sign-in</span> : p.auth === 'google' ? <span className="conn-badge">Client ID</span> : null}
                      </span>
                      <b>{p.name}</b>
                      <span className="hint">{p.description}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}

        {form && (
          <div className="conn-form">
            <h3>{form.preset.name}</h3>
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
            {err && <div className="hint" style={{ color: 'var(--danger)' }}>{err}</div>}
            <div className="modal-actions">
              <button className="btn" onClick={() => setForm(null)}>Cancel</button>
              <button className="btn primary" onClick={() => void submit()} data-testid="conn-save">{form.kind === 'remote' && !form.headerName ? 'Sign in' : 'Connect'}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
