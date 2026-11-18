import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { McpActivity, McpNewClient, McpStatus } from '@shared/types'
import { api } from '../api'
import * as I from '../icons'
import { toast } from '../lib/toast'
import '../styles-mcp.css'
import { ClampText } from './ui'
import { BrainScopeEditor, scopeLine, useBrainNames } from './BrainScopeEditor'

// Settings → Connected apps → Let apps on this Mac use SahilBot: let Cursor, Claude Code, Claude Desktop and
// Shortcuts use your bots through a local server. Off by default; one revocable token per app.

const clean = (e: unknown): string => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

function ago(t: number | null): string {
  if (!t) return 'never'
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  return d < 30 ? `${d} d ago` : new Date(t).toLocaleDateString()
}

const time = (t: number): string => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

function Block({ title, sub, children }: { title?: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <section className="set-section">
      {title && <div className="set-label">{title}</div>}
      {sub && <div className="set-sub">{sub}</div>}
      <div className="set-card">{children}</div>
    </section>
  )
}

function Line({ title, sub, children, testId }: { title: ReactNode; sub?: ReactNode; children?: ReactNode; testId?: string }) {
  return (
    <div className="set-row" data-testid={testId}>
      <div className="set-row-text"><div className="set-row-title">{title}</div>{sub && <ClampText>{sub}</ClampText>}</div>
      {children && <div className="set-row-ctl">{children}</div>}
    </div>
  )
}

function CopyBtn({ text, label = 'Copy', testId }: { text: string; label?: string; testId?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button className="btn mcp-copy" data-testid={testId} onClick={() => {
      void navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1400) }).catch(() => toast('Couldn\'t copy. Select the text and press ⌘C.', 'error'))
    }}>{done ? <I.Check size={13} /> : <I.Copy size={13} />}{done ? 'Copied' : label}</button>
  )
}

const TABS = [
  { id: 'cursor', label: 'Cursor', hint: <>Paste into <code>~/.cursor/mcp.json</code> (or merge into its <code>mcpServers</code>), then reload Cursor.</> },
  { id: 'claudeCode', label: 'Claude Code', hint: <>Run this in Terminal. Add <code>--scope user</code> to use it in every project.</> },
  { id: 'claudeDesktop', label: 'Claude Desktop', hint: <>Claude → Settings → Developer → Edit Config, merge into <code>claude_desktop_config.json</code>, then restart Claude. It uses SahilBot's small bridge command.</> },
  { id: 'codex', label: 'Codex CLI', hint: <>Add to <code>~/.codex/config.toml</code>, then restart Codex. It uses SahilBot's small bridge command.</> },
  { id: 'curl', label: 'Shortcuts & scripts', hint: <>For Shortcuts, use "Get Contents of URL" with method POST, these headers and this JSON body. The reply is in <code>result.content[0].text</code>.</> },
  { id: 'chatgpt', label: 'ChatGPT', hint: <>Why ChatGPT isn't on this list yet.</> }
] as const

/** The token, shown once, with configs for each app. */
function NewClient({ created, onDone }: { created: McpNewClient; onDone: () => void }) {
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('cursor')
  const cur = TABS.find((t) => t.id === tab)!
  return (
    <div className="mcp-new" data-testid="mcp-new-client">
      <div className="mcp-new-head">
        <I.Key size={15} />
        <div>
          <b>{created.client.name} is connected</b>
          <div className="hint">Copy the token or a config now. SahilBot keeps only a fingerprint of it, so it can't be shown again.</div>
        </div>
      </div>
      <div className="mcp-token">
        <code data-testid="mcp-token">{created.token}</code>
        <CopyBtn text={created.token} label="Copy token" testId="mcp-copy-token" />
      </div>
      <div className="mcp-tabs" role="tablist">
        {TABS.map((t) => <button key={t.id} role="tab" aria-selected={tab === t.id} className={`mcp-tab${tab === t.id ? ' on' : ''}`} onClick={() => setTab(t.id)} data-testid={`mcp-tab-${t.id}`}>{t.label}</button>)}
      </div>
      <div className="hint mcp-tab-hint">{cur.hint}</div>
      <div className="mcp-snippet">
        <pre data-testid={`mcp-snippet-${tab}`}>{created.snippets[tab] ?? ''}</pre>
        {tab !== 'chatgpt' && <CopyBtn text={created.snippets[tab] ?? ''} />}
      </div>
      <div className="mcp-new-foot">
        <span className="hint">Treat the token like a password: anyone with it can ask your bots (what they do still needs your OK).</span>
        <button className="btn primary" onClick={onDone} data-testid="mcp-done">Done</button>
      </div>
    </div>
  )
}

function ActivityRow({ a }: { a: McpActivity }) {
  return (
    <div className={`mcp-act${a.ok ? '' : ' bad'}`}>
      <span className="mcp-act-time">{time(a.at)}</span>
      <span className="mcp-act-app">{a.client}</span>
      <span className="mcp-act-tool">{a.tool}</span>
      <span className="mcp-act-detail">{a.detail ?? ''}{a.ms !== undefined && a.ms >= 1000 ? ` · ${(a.ms / 1000).toFixed(1)} s` : ''}</span>
    </div>
  )
}

export function McpSettings() {
  const [st, setSt] = useState<McpStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [created, setCreated] = useState<McpNewClient | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [filter, setFilter] = useState<string | null>(null)
  const [scopeOpen, setScopeOpen] = useState<string | null>(null)
  const names = useBrainNames()
  const refresh = useCallback((): void => { void api.mcp.status().then(setSt).catch(() => undefined) }, [])
  useEffect(() => {
    refresh()
    return api.mcp.onChange(refresh)
  }, [refresh])

  if (!st) return null
  const toggle = async (on: boolean, newPort = false): Promise<void> => {
    setBusy(true)
    try { setSt(await api.mcp.setEnabled(on, newPort ? { newPort: true } : undefined)) } catch (e) { toast(clean(e), 'error') } finally { setBusy(false) }
    if (!on) setCreated(null)
  }
  const connect = async (): Promise<void> => {
    if (!name.trim()) return
    try {
      setCreated(await api.mcp.createClient(name.trim()))
      setName('')
      refresh()
    } catch (e) { toast(clean(e), 'error') }
  }
  const revoke = async (id: string): Promise<void> => {
    try { setSt(await api.mcp.revokeClient(id)); setConfirm(null); toast('Revoked. That app can no longer connect.') } catch (e) { toast(clean(e), 'error') }
  }
  const setScope = async (id: string, patch: Parameters<typeof api.mcp.setScope>[1]): Promise<void> => {
    try { setSt(await api.mcp.setScope(id, patch)) } catch (e) { toast(clean(e), 'error') }
  }
  const activity = st.activity.filter((a) => !filter || a.clientId === filter)
  const shown = showAll ? activity : activity.slice(0, 12)

  return (
    <div className="mcp" data-testid="mcp-settings">
      <Block title="Connected apps (MCP)" sub={<>Let apps on this Mac, like Claude Desktop, Claude Code, Cursor and Codex, ask your bots and search your brain (people, clients, projects, deals, meetings and promises, with sources), only as much of it as you share with each app. Each app gets its own token. What an app sends is treated as coming from that app, not from you: bots work in Ask mode for it, and anything consequential, or any look at your private data (files, commands, screen, mail, signed-in websites, knowledge base, memories), waits for your approval here. Public web searches, web pages and market data don't ask. Saved passwords and token-like secrets are removed from what goes back to the app.</>}>
        <Line title="Allow apps to connect" testId="mcp-enabled-row"
          sub={st.running && st.url ? <>Listening on <code>{st.url}</code> (this Mac only)</> : st.error ? <span className="mcp-err">{st.error}</span> : 'Off. Nothing can connect.'}>
          <button role="switch" aria-checked={st.enabled} aria-label="Allow apps to connect" disabled={busy} className={`switch${st.enabled ? ' on' : ''}`} onClick={() => void toggle(!st.enabled)} data-testid="mcp-enabled"><i /></button>
        </Line>
        {!st.running && st.portInUse ? (
          <Line title={`Port ${st.portInUse} is in use`} testId="mcp-port-in-use"
            sub="Another program holds the port your apps are set up for, so SahilBot stayed off. Use a new port, then update the URL in your apps (the stdio bridge picks it up on its own).">
            <button className="btn" disabled={busy} onClick={() => void toggle(true, true)} data-testid="mcp-new-port">Use a new port</button>
          </Line>
        ) : null}
        {st.running && !created && (
          <Line title="Connect an app" sub="Name it after the app; you'll get a token and a ready-made config.">
            <div className="key-edit">
              <input className="set-input" value={name} maxLength={40} placeholder="e.g. Cursor" spellCheck={false}
                onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void connect()} data-testid="mcp-client-name" />
              <button className="btn" disabled={!name.trim()} onClick={() => void connect()} data-testid="mcp-connect">Connect</button>
            </div>
          </Line>
        )}
        {created && <NewClient created={created} onDone={() => setCreated(null)} />}
      </Block>

      {st.clients.length > 0 && (
        <Block title="Apps">
          {st.clients.map((c) => (<div key={c.id}>
            <Line testId={`mcp-client-${c.name}`} title={c.name}
              sub={<>Last used {ago(c.lastUsedAt)} · connected {new Date(c.createdAt).toLocaleDateString()}{c.bots ? ` · ${c.bots} ${c.bots === 1 ? 'bot chat' : 'bot chats'}` : ''}{c.scope ? <><br /><span className="scope-sum" data-testid={`mcp-scope-sum-${c.name}`}>Sees: {scopeLine(c.scope, names)}</span></> : null}</>}>
              <button className="link-btn" onClick={() => setScopeOpen(scopeOpen === c.id ? null : c.id)} data-testid={`mcp-scope-${c.name}`}>{scopeOpen === c.id ? 'Done' : 'What it can see'}</button>
              <button className="link-btn" onClick={() => { setFilter(filter === c.id ? null : c.id); setShowAll(false) }}>{filter === c.id ? 'All activity' : 'Activity'}</button>
              {confirm === c.id
                ? <><button className="btn danger" onClick={() => void revoke(c.id)} data-testid={`mcp-revoke-confirm-${c.name}`}>Revoke now</button><button className="link-btn" onClick={() => setConfirm(null)}>Cancel</button></>
                : <button className="btn" onClick={() => setConfirm(c.id)} data-testid={`mcp-revoke-${c.name}`}>Revoke</button>}
            </Line>
            {scopeOpen === c.id && c.scope && <BrainScopeEditor scope={c.scope} onChange={(p) => void setScope(c.id, p)} testId={`mcp-scope-editor`} />}
          </div>))}
        </Block>
      )}

      {(st.clients.length > 0 || st.activity.length > 0) && (
        <Block title={filter ? `Recent activity: ${st.clients.find((c) => c.id === filter)?.name ?? 'app'}` : 'Recent activity'} sub="Every call is logged here (message text isn't).">
          {shown.length === 0 ? <Line title="Nothing yet" /> : (
            <div className="mcp-acts" data-testid="mcp-activity">
              {shown.map((a, i) => <ActivityRow key={`${a.at}-${i}`} a={a} />)}
              {activity.length > shown.length && <button className="link-btn mcp-more" onClick={() => setShowAll(true)}>Show all {activity.length}</button>}
            </div>
          )}
        </Block>
      )}

      <Block title="Links for Shortcuts, Raycast and Alfred" sub="These open SahilBot with the message typed in for you. Nothing is sent until you press Enter.">
        <Line title={<code>sahilbot://ask?bot=Writer&amp;text=Hello</code>} sub="Opens that bot's chat with the text in the message box.">
          <CopyBtn text="sahilbot://ask?bot=SahilBot&text=" />
        </Line>
        <Line title={<code>sahilbot://new?bot=Writer</code>} sub="Starts a new chat with that bot (add &amp;text=… to fill it in).">
          <CopyBtn text="sahilbot://new?bot=SahilBot" />
        </Line>
      </Block>
    </div>
  )
}
