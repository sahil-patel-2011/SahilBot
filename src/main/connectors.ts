import { shell } from 'electron'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { ConnectorConfig, ConnectorPreset, ConnectorStatus, ToolEffect } from '@shared/types'
import type { ToolRegistry } from './agent/registry'
import type { ToolDef } from './agent/types'
import { CONSEQUENTIAL } from './agent/permissions'
import type { Db } from './db'
import type { Secrets } from './secrets'

// MCP connectors: remote servers with OAuth sign-in (browser + loopback callback, tokens in
// the Keychain) and local stdio servers. Each server's tools become agent tools loaded on
// demand through find_tools. Design follows opencode/Cline/OpenClaw MCP OAuth handling (MIT/Apache).

// Verified live on 2026-11-11 (each answered an MCP initialize: open, or 401 = sign-in required).
export const PRESETS: ConnectorPreset[] = [
  { id: 'cursor-app', name: 'Cursor', url: 'app:cursor', color: '#111111', category: 'No setup', auth: 'app', description: 'Built in. SahilBot opens files in Cursor and can hand coding tasks to Cursor\'s agent.' },
  { id: 'apple-notes', name: 'Notes, Reminders & Calendar', url: 'app:mac_apps', color: '#F5B400', category: 'No setup', auth: 'app', description: 'Built in. Your Mac\'s own apps; macOS asks once to allow access.' },
  { id: 'gmail-web', name: 'Gmail (no setup)', url: 'https://mail.google.com/', color: '#EA4335', category: 'No setup', auth: 'browser', description: 'Sign in once in SahilBot\'s browser; SahilBot uses Gmail like you do.' },
  { id: 'gcal-web', name: 'Google Calendar (no setup)', url: 'https://calendar.google.com/', color: '#4285F4', category: 'No setup', auth: 'browser', description: 'Sign in once in SahilBot\'s browser.' },
  { id: 'gdrive-web', name: 'Google Drive (no setup)', url: 'https://drive.google.com/', color: '#0F9D58', category: 'No setup', auth: 'browser', description: 'Sign in once in SahilBot\'s browser.' },
  { id: 'linkedin-web', name: 'LinkedIn (no setup)', url: 'https://www.linkedin.com/', color: '#0A66C2', category: 'No setup', auth: 'browser', description: 'Any site works this way: sign in once in SahilBot\'s browser.' },
  { id: 'gmail', name: 'Gmail', url: 'https://gmailmcp.googleapis.com/mcp/v1', color: '#EA4335', category: 'Google', auth: 'google', description: 'Search, read, draft and send email.' },
  { id: 'gcal', name: 'Google Calendar', url: 'https://calendarmcp.googleapis.com/mcp/v1', color: '#4285F4', category: 'Google', auth: 'google', description: 'Events, availability and invites.' },
  { id: 'gdrive', name: 'Google Drive', url: 'https://drivemcp.googleapis.com/mcp/v1', color: '#0F9D58', category: 'Google', auth: 'google', description: 'Find and read Docs, Sheets and files.' },
  { id: 'notion', name: 'Notion', url: 'https://mcp.notion.com/mcp', color: '#111111', category: 'Productivity', auth: 'oauth', description: 'Pages, databases and comments.' },
  { id: 'linear', name: 'Linear', url: 'https://mcp.linear.app/mcp', color: '#5E6AD2', category: 'Productivity', auth: 'oauth', description: 'Issues, projects and cycles.' },
  { id: 'asana', name: 'Asana', url: 'https://mcp.asana.com/v2/mcp', color: '#F06A6A', category: 'Productivity', auth: 'oauth', description: 'Tasks, projects and portfolios.' },
  { id: 'atlassian', name: 'Jira & Confluence', url: 'https://mcp.atlassian.com/v1/mcp', color: '#0052CC', category: 'Productivity', auth: 'oauth', description: 'Atlassian issues and wiki pages.' },
  { id: 'monday', name: 'monday.com', url: 'https://mcp.monday.com/mcp', color: '#FF3D57', category: 'Productivity', auth: 'oauth', description: 'Boards, items and updates.' },
  { id: 'clickup', name: 'ClickUp', url: 'https://mcp.clickup.com/mcp', color: '#7B68EE', category: 'Productivity', auth: 'oauth', description: 'Tasks, docs and spaces.' },
  { id: 'airtable', name: 'Airtable', url: 'https://mcp.airtable.com/mcp', color: '#18BFFF', category: 'Productivity', auth: 'oauth', description: 'Bases, tables and records.' },
  { id: 'slack', name: 'Slack', url: 'https://mcp.slack.com/mcp', color: '#4A154B', category: 'Productivity', auth: 'oauth', description: 'Search and post in channels.' },
  { id: 'miro', name: 'Miro', url: 'https://mcp.miro.com/', color: '#FFD02F', category: 'Productivity', auth: 'oauth', description: 'Boards, stickies and diagrams.' },
  { id: 'box', name: 'Box', url: 'https://mcp.box.com', color: '#0061D5', category: 'Productivity', auth: 'oauth', description: 'Files and folders in Box.' },
  { id: 'dropbox', name: 'Dropbox', url: 'https://mcp.dropbox.com/mcp', color: '#0061FF', category: 'Productivity', auth: 'oauth', description: 'Files and folders in Dropbox.' },
  { id: 'zapier', name: 'Zapier', url: 'https://mcp.zapier.com/api/mcp/mcp', color: '#FF4F00', category: 'Productivity', auth: 'oauth', description: 'Thousands of app actions via your Zaps.' },
  { id: 'granola', name: 'Granola', url: 'https://mcp.granola.ai/mcp', color: '#1E1E1E', category: 'Productivity', auth: 'oauth', description: 'Meeting notes and transcripts.' },
  { id: 'fireflies', name: 'Fireflies', url: 'https://mcp.fireflies.ai/mcp', color: '#E1308A', category: 'Productivity', auth: 'oauth', description: 'Meeting recordings and summaries.' },
  { id: 'gamma', name: 'Gamma', url: 'https://mcp.gamma.app/mcp', color: '#7C3AED', category: 'Productivity', auth: 'oauth', description: 'Generate decks and docs.' },
  { id: 'canva', name: 'Canva', url: 'https://mcp.canva.com/mcp', color: '#00C4CC', category: 'Productivity', auth: 'oauth', description: 'Designs, templates and exports.' },
  { id: 'figma', name: 'Figma', url: 'https://mcp.figma.com/mcp', color: '#A259FF', category: 'Productivity', auth: 'oauth', description: 'Design files and components.' },
  { id: 'jotform', name: 'Jotform', url: 'https://mcp.jotform.com/', color: '#FF6100', category: 'Productivity', auth: 'oauth', description: 'Forms and submissions.' },
  { id: 'docusign', name: 'Docusign', url: 'https://mcp.docusign.com/mcp', color: '#4C00FF', category: 'Productivity', auth: 'oauth', description: 'Agreements and envelopes.' },
  { id: 'hubspot', name: 'HubSpot', url: 'https://mcp.hubspot.com/', color: '#FF7A59', category: 'Sales & marketing', auth: 'oauth', description: 'Contacts, deals and companies.' },
  { id: 'apollo', name: 'Apollo', url: 'https://mcp.apollo.io/mcp', color: '#2E3A59', category: 'Sales & marketing', auth: 'oauth', description: 'Prospects and enrichment.' },
  { id: 'attio', name: 'Attio', url: 'https://mcp.attio.com/mcp', color: '#111827', category: 'Sales & marketing', auth: 'oauth', description: 'CRM records and lists.' },
  { id: 'close', name: 'Close', url: 'https://mcp.close.com/mcp', color: '#3A5BF0', category: 'Sales & marketing', auth: 'oauth', description: 'Leads, calls and pipeline.' },
  { id: 'pipedrive', name: 'Pipedrive', url: 'https://mcp.pipedrive.com/mcp', color: '#017737', category: 'Sales & marketing', auth: 'oauth', description: 'Deals and activities.' },
  { id: 'gong', name: 'Gong', url: 'https://mcp.gong.io/mcp', color: '#8039DF', category: 'Sales & marketing', auth: 'oauth', description: 'Call recordings and insights.' },
  { id: 'klaviyo', name: 'Klaviyo', url: 'https://mcp.klaviyo.com/mcp', color: '#232426', category: 'Sales & marketing', auth: 'oauth', description: 'Email and SMS marketing.' },
  { id: 'semrush', name: 'Semrush', url: 'https://mcp.semrush.com/v1/mcp', color: '#FF642D', category: 'Sales & marketing', auth: 'oauth', description: 'SEO, keywords and traffic.' },
  { id: 'ahrefs', name: 'Ahrefs', url: 'https://api.ahrefs.com/mcp/mcp', color: '#FF8800', category: 'Sales & marketing', auth: 'oauth', description: 'Backlinks and keyword research.' },
  { id: 'similarweb', name: 'Similarweb', url: 'https://mcp.similarweb.com/mcp', color: '#092540', category: 'Sales & marketing', auth: 'oauth', description: 'Website traffic and market data.' },
  { id: 'crunchbase', name: 'Crunchbase', url: 'https://mcp.crunchbase.com/mcp', color: '#146AFF', category: 'Sales & marketing', auth: 'oauth', description: 'Companies, funding and people.' },
  { id: 'intercom', name: 'Intercom', url: 'https://mcp.intercom.com/mcp', color: '#1F8DED', category: 'Sales & marketing', auth: 'oauth', description: 'Conversations and help center.' },
  { id: 'stripe', name: 'Stripe', url: 'https://mcp.stripe.com', color: '#635BFF', category: 'Finance & commerce', auth: 'oauth', description: 'Payments, customers and invoices.' },
  { id: 'paypal', name: 'PayPal', url: 'https://mcp.paypal.com/mcp', color: '#003087', category: 'Finance & commerce', auth: 'oauth', description: 'Invoices, orders and disputes.' },
  { id: 'square', name: 'Square', url: 'https://mcp.squareup.com/sse', color: '#3E4348', category: 'Finance & commerce', auth: 'oauth', description: 'Payments, orders and catalog.' },
  { id: 'plaid', name: 'Plaid', url: 'https://mcp.plaid.com/mcp', color: '#111111', category: 'Finance & commerce', auth: 'oauth', description: 'Bank-data integrations.' },
  { id: 'xero', name: 'Xero', url: 'https://mcp.xero.com/mcp', color: '#13B5EA', category: 'Finance & commerce', auth: 'oauth', description: 'Accounting: invoices and contacts.' },
  { id: 'github', name: 'GitHub', url: 'https://api.githubcopilot.com/mcp/', color: '#24292F', category: 'Dev & data', auth: 'oauth', description: 'Repos, issues and pull requests.' },
  { id: 'sentry', name: 'Sentry', url: 'https://mcp.sentry.dev/mcp', color: '#362D59', category: 'Dev & data', auth: 'oauth', description: 'Errors and performance issues.' },
  { id: 'vercel', name: 'Vercel', url: 'https://mcp.vercel.com', color: '#000000', category: 'Dev & data', auth: 'oauth', description: 'Deployments, logs and domains.' },
  { id: 'netlify', name: 'Netlify', url: 'https://mcp.netlify.com/mcp', color: '#00AD9F', category: 'Dev & data', auth: 'oauth', description: 'Sites and deploys.' },
  { id: 'supabase', name: 'Supabase', url: 'https://mcp.supabase.com/mcp', color: '#3ECF8E', category: 'Dev & data', auth: 'oauth', description: 'Databases, auth and storage.' },
  { id: 'neon', name: 'Neon', url: 'https://mcp.neon.tech/mcp', color: '#00E599', category: 'Dev & data', auth: 'oauth', description: 'Serverless Postgres.' },
  { id: 'posthog', name: 'PostHog', url: 'https://mcp.posthog.com/mcp', color: '#F54E00', category: 'Dev & data', auth: 'oauth', description: 'Product analytics and flags.' },
  { id: 'amplitude', name: 'Amplitude', url: 'https://mcp.amplitude.com/mcp', color: '#1E61F0', category: 'Dev & data', auth: 'oauth', description: 'Product analytics.' },
  { id: 'webflow', name: 'Webflow', url: 'https://mcp.webflow.com/mcp', color: '#4353FF', category: 'Dev & data', auth: 'oauth', description: 'Sites and CMS collections.' },
  { id: 'wix', name: 'Wix', url: 'https://mcp.wix.com/mcp', color: '#0C6EFC', category: 'Dev & data', auth: 'oauth', description: 'Sites, stores and bookings.' },
  { id: 'huggingface', name: 'Hugging Face', url: 'https://huggingface.co/mcp', color: '#FFD21E', category: 'Dev & data', auth: 'oauth', description: 'Models, datasets and Spaces.' },
  { id: 'exa', name: 'Exa search', url: 'https://mcp.exa.ai/mcp', color: '#1F40ED', category: 'Research', auth: 'none', description: 'High-quality web search and page contents. No sign-in.' },
  { id: 'deepwiki', name: 'DeepWiki', url: 'https://mcp.deepwiki.com/mcp', color: '#0F172A', category: 'Research', auth: 'none', description: 'Explains any public GitHub repo. No sign-in.' },
  { id: 'context7', name: 'Context7', url: 'https://mcp.context7.com/mcp', color: '#059669', category: 'Research', auth: 'none', description: 'Up-to-date library docs. No sign-in.' },
  { id: 'mslearn', name: 'Microsoft Learn', url: 'https://learn.microsoft.com/api/mcp', color: '#0078D4', category: 'Research', auth: 'none', description: 'Official Microsoft docs. No sign-in.' },
  { id: 'custom', name: 'Custom MCP server', url: '', color: '#7C5CFF', category: 'Other', auth: 'oauth', description: 'Any MCP server: a URL, or a local command.' }
]

const MAX_TOOL_NAME = 64
const SAFE_ENV_BLOCK = /^(NODE_OPTIONS|DYLD_|LD_|ELECTRON_)/

interface Live {
  client: Client
  tools: string[]
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}

/** server__tool, capped at 64 chars for OpenAI-style tool names. */
export function toolName(server: string, tool: string): string {
  const n = `${slug(server)}__${slug(tool)}`
  return n.length <= MAX_TOOL_NAME ? n : `${n.slice(0, MAX_TOOL_NAME - 9)}_${Buffer.from(n).toString('base64url').slice(0, 8)}`
}

/** MCP annotations and verbs decide the effect: reads run, writes follow the permission mode. */
export function effectFor(name: string, ann?: { readOnlyHint?: boolean; destructiveHint?: boolean }): ToolEffect {
  if (ann?.readOnlyHint) return 'read'
  if (ann?.destructiveHint || /(^|[_\-.])(delete|remove|trash|archive|destroy)/i.test(name)) return 'destructive'
  // Only the leading verb counts (create_report, update_view are writes), and a write verb anywhere wins (find_and_replace).
  if (/(^|[_\-.])(create|update|replace|set|add|write|edit|send|post|put|patch|insert|upsert|modify|move|rename|upload|submit|assign|merge|publish|share|invite|apply)([_\-.]|$)/i.test(name) ||
    /[a-z](Create|Update|Replace|Set|Add|Write|Edit|Send|Post|Put|Patch|Insert|Upsert|Modify|Move|Rename|Upload|Submit|Assign|Merge|Publish|Share|Invite|Apply)([A-Z]|$)/.test(name)) return 'write_external'
  // Servers often prefix their own name (notion-search, slack_list_channels); write verbs were already caught above.
  if (/^([a-z0-9]+[_\-.])?(get|list|search|read|fetch|query|find|lookup|describe|view|show|retrieve|count|stats|report|overview|research)([_\-.]|$)/i.test(name) ||
    /^(get|list|search|read|fetch|query|find|lookup|describe|view|show|retrieve|count)[A-Z]/.test(name)) return 'read'
  return 'write_external'
}

function portOf(uri?: string): number | undefined {
  try { return uri ? Number(new URL(uri).port) || undefined : undefined } catch { return undefined }
}

class Oauth implements OAuthClientProvider {
  private port = 0
  private server: Server | null = null
  private waiter: { resolve: (code: string) => void; reject: (e: Error) => void } | null = null
  private stateValue = randomUUID()

  constructor(private id: string, private secrets: Secrets, private staticClient?: { client_id: string; client_secret?: string }, private interactive = true) {}

  private key(k: string): string { return `mcp:${this.id}:${k}` }
  private read<T>(k: string): T | undefined {
    const v = this.secrets.get(this.key(k))
    return v ? (JSON.parse(v) as T) : undefined
  }
  private write(k: string, v: unknown): void { this.secrets.set(this.key(k), v === undefined ? null : JSON.stringify(v)) }

  /** A loopback listener on 127.0.0.1 receives the redirect (RFC 8252). */
  async listen(): Promise<void> {
    if (this.server) return
    this.server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1')
      const code = u.searchParams.get('code')
      const err = u.searchParams.get('error')
      if (!code && !err) { res.writeHead(404); res.end(); return } // prefetch or reload
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><meta charset=utf-8><title>SahilBot</title><body style="font:16px -apple-system;display:grid;place-items:center;height:90vh"><div>${err ? 'Sign-in was cancelled.' : 'Signed in. You can close this tab and return to SahilBot.'}</div>`)
      if (u.searchParams.get('state') && u.searchParams.get('state') !== this.stateValue) return this.waiter?.reject(new Error('Sign-in state mismatch'))
      if (err) this.waiter?.reject(new Error(`Sign-in failed: ${err}`))
      else this.waiter?.resolve(code!)
    })
    // The registered client's redirect_uris name this port, so keep it across connects.
    const saved = this.read<number>('port') ?? portOf(this.read<{ redirect_uris?: string[] }>('client')?.redirect_uris?.[0])
    const bind = (port: number): Promise<boolean> => new Promise((ok) => {
      const s = this.server!
      const fail = (): void => { s.off('listening', done); ok(false) }
      const done = (): void => { s.off('error', fail); ok(true) }
      s.once('error', fail).once('listening', done).listen(port, '127.0.0.1')
    })
    if (!saved || !(await bind(saved))) {
      if (!(await bind(0))) throw new Error('Could not open a local port for sign-in')
      // A client registered for another port would be rejected (redirect_uri mismatch): register again.
      if (saved) this.write('client', undefined)
    }
    this.port = (this.server.address() as AddressInfo).port
    if (this.port !== saved) this.write('port', this.port)
  }

  close(): void {
    this.server?.close()
    this.server = null
  }

  waitForCode(ms = 300_000): Promise<string> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Sign-in timed out after 5 minutes')), ms)
      this.waiter = { resolve: (c) => { clearTimeout(t); resolve(c) }, reject: (e) => { clearTimeout(t); reject(e) } }
    })
  }

  get redirectUrl(): string { return `http://127.0.0.1:${this.port}/callback` }
  get clientMetadata() {
    return {
      client_name: 'SahilBot',
      redirect_uris: [this.redirectUrl, `http://localhost:${this.port}/callback`],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    }
  }
  state(): string { return this.stateValue }
  clientInformation() { return this.staticClient ?? this.read<any>('client') }
  saveClientInformation(info: unknown): void { this.write('client', info); this.write('port', this.port) }
  tokens() { return this.read<any>('tokens') }
  saveTokens(t: unknown): void { this.write('tokens', t) }
  // Background connects (at launch) never open the browser; the connector shows "needs sign-in" instead.
  async redirectToAuthorization(url: URL): Promise<void> { if (this.interactive) await shell.openExternal(url.toString()) }
  saveCodeVerifier(v: string): void { this.write('verifier', v) }
  codeVerifier(): string { return this.read<string>('verifier') ?? '' }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all' || scope === 'client') this.write('client', undefined)
    if (scope === 'all' || scope === 'tokens') this.write('tokens', undefined)
    if (scope === 'all' || scope === 'verifier') this.write('verifier', undefined)
    if (scope === 'all') this.write('port', undefined)
  }
  hasTokens(): boolean { return !!this.read('tokens') }
}

export class Connectors {
  private live = new Map<string, Live>()
  private status = new Map<string, ConnectorStatus>()

  constructor(private db: Db, private secrets: Secrets, private registry: ToolRegistry, private changed: () => void) {}

  list(): ConnectorConfig[] {
    return this.db.getSetting<ConnectorConfig[]>('connectors') ?? []
  }

  /** Catalog entries that match a request and aren't connected yet (for in-chat connect cards). */
  suggest(query: string): ConnectorPreset[] {
    const q = query.toLowerCase()
    const connected = new Set(this.list().filter((c) => this.status.get(c.id)?.state === 'connected').map((c) => c.preset))
    return PRESETS.filter((p) => p.id !== 'custom' && !connected.has(p.id) && p.auth !== 'browser' && p.auth !== 'app' &&
      q.split(/[^a-z0-9.]+/).some((w) => w.length > 2 && (p.name.toLowerCase().includes(w) || p.id.startsWith(w))))
  }

  /** One-click connect for a catalog entry (OAuth opens the browser). */
  async connectPreset(id: string): Promise<ConnectorStatus> {
    const p = PRESETS.find((x) => x.id === id)
    if (!p || p.auth === 'google' || p.auth === 'browser' || p.auth === 'app' || !p.url) throw new Error('This connector needs setup in Connect apps.')
    const existing = this.list().find((c) => c.preset === id)
    const cfg = existing ?? this.save({ name: p.name, kind: 'remote', url: p.url, preset: p.id, enabled: true })
    return this.connect(cfg.id, true)
  }

  statuses(): ConnectorStatus[] {
    return this.list().map((c) => this.status.get(c.id) ?? { id: c.id, state: c.enabled ? 'disconnected' : 'off', tools: 0 })
  }

  private setStatus(s: ConnectorStatus): void {
    this.status.set(s.id, s)
    this.changed()
  }

  save(c: Omit<ConnectorConfig, 'id'> & { id?: string }): ConnectorConfig {
    if (c.kind === 'remote' && !/^https?:\/\//.test(c.url ?? '')) throw new Error('Enter the server URL (https://…).')
    if (PRESETS.find((p) => p.id === c.preset)?.auth === 'google' && !c.clientId) throw new Error('Google needs your OAuth client ID (Google Cloud Console → Credentials → Create OAuth client → Desktop app).')
    if (c.kind === 'stdio' && !c.command?.trim()) throw new Error('Enter the command that starts the server.')
    const all = this.list()
    const full: ConnectorConfig = { ...c, id: c.id ?? `${slug(c.name)}-${randomUUID().slice(0, 4)}`, enabled: c.enabled ?? true } as ConnectorConfig
    this.db.setSetting('connectors', [...all.filter((x) => x.id !== full.id), full])
    return full
  }

  async remove(id: string): Promise<void> {
    await this.disconnect(id)
    new Oauth(id, this.secrets).invalidateCredentials('all')
    this.db.setSetting('connectors', this.list().filter((c) => c.id !== id))
    this.status.delete(id)
    this.changed()
  }

  async disconnect(id: string): Promise<void> {
    const l = this.live.get(id)
    if (l) {
      this.registry.unregister((t) => l.tools.includes(t.name))
      await l.client.close().catch(() => undefined)
      this.live.delete(id)
    }
    this.setStatus({ id, state: 'disconnected', tools: 0 })
  }

  async connectAll(): Promise<void> {
    await Promise.all(this.list().filter((c) => c.enabled).map((c) => this.connect(c.id, false).catch(() => undefined)))
  }

  /** Connects; with interactive=true a remote server that needs auth opens the browser to sign in. */
  async connect(id: string, interactive = true): Promise<ConnectorStatus> {
    const c = this.list().find((x) => x.id === id)
    if (!c) throw new Error('Unknown connector')
    await this.disconnect(id)
    this.setStatus({ id, state: 'connecting', tools: 0 })
    const client = new Client({ name: 'SahilBot', version: '0.1.0' })
    try {
      if (c.kind === 'stdio') {
        const env = Object.fromEntries(Object.entries({ ...process.env, ...(c.env ?? {}) }).filter(([k, v]) => v !== undefined && !SAFE_ENV_BLOCK.test(k))) as Record<string, string>
        await client.connect(new StdioClientTransport({ command: c.command!, args: c.args ?? [], env, stderr: 'ignore' }))
      } else {
        const secret = this.secrets.get(`mcp:${id}:clientSecret`)
        const auth = new Oauth(id, this.secrets, c.clientId ? { client_id: c.clientId, ...(secret ? { client_secret: secret } : {}) } : undefined, interactive)
        await auth.listen()
        const url = new URL(c.url!)
        const headers = c.headerName && this.secrets.get(`mcp:${id}:header`) ? { [c.headerName]: this.secrets.get(`mcp:${id}:header`)! } : undefined
        const attempt = async (): Promise<void> => {
          try {
            await client.connect(new StreamableHTTPClientTransport(url, { authProvider: headers ? undefined : auth, requestInit: headers ? { headers } : undefined }))
          } catch (e) {
            if (e instanceof UnauthorizedError) throw e
            // Older servers only speak SSE.
            await client.connect(new SSEClientTransport(url, { authProvider: headers ? undefined : auth, requestInit: headers ? { headers } : undefined }))
          }
        }
        try {
          await attempt()
        } catch (e) {
          if (!(e instanceof UnauthorizedError)) throw e
          if (!interactive) { this.setStatus({ id, state: 'needs_auth', tools: 0 }); auth.close(); return this.status.get(id)! }
          this.setStatus({ id, state: 'signing_in', tools: 0 })
          const code = await auth.waitForCode()
          const t = new StreamableHTTPClientTransport(url, { authProvider: auth })
          await t.finishAuth(code)
          await attempt()
        } finally {
          auth.close()
        }
      }
      const { tools } = await client.listTools()
      const defs: ToolDef[] = tools.map((t) => this.toToolDef(c, client, t))
      this.registry.register(...defs)
      this.live.set(id, { client, tools: defs.map((d) => d.name) })
      const st: ConnectorStatus = { id, state: 'connected', tools: defs.length, toolNames: tools.map((t) => t.name) }
      this.setStatus(st)
      return st
    } catch (e) {
      await client.close().catch(() => undefined)
      const st: ConnectorStatus = { id, state: 'error', tools: 0, error: (e as Error).message.slice(0, 300) }
      this.setStatus(st)
      return st
    }
  }

  private toToolDef(c: ConnectorConfig, client: Client, t: { name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string } }): ToolDef {
    const effect = effectFor(t.name, t.annotations)
    return {
      name: toolName(c.name, t.name),
      label: c.name,
      group: c.name,
      effect,
      untrusted: true,
      // Tool names use underscores (send_email), which regex word boundaries don't split on.
      consequential: (args) => effect !== 'read' && CONSEQUENTIAL.test(`${t.name.replace(/[_\-.]+/g, ' ')} ${JSON.stringify(args).slice(0, 200)}`),
      describe: (args) => `${c.name}: ${t.annotations?.title ?? t.name.replace(/_/g, ' ')} ${JSON.stringify(args).slice(0, 160)}`,
      description: `[${c.name}] ${(t.description ?? t.name).slice(0, 900)}`,
      parameters: t.inputSchema && Object.keys(t.inputSchema).length ? t.inputSchema : { type: 'object', properties: {} },
      async run(args, ctx) {
        const r = await client.callTool({ name: t.name, arguments: args as Record<string, unknown> }, undefined, { signal: ctx.signal, timeout: 120_000 })
        const parts = (r.content ?? []) as Array<{ type: string; text?: string; data?: string; mimeType?: string; resource?: { text?: string; uri?: string } }>
        const text = parts.map((p) => (p.type === 'text' ? p.text : p.type === 'resource' ? (p.resource?.text ?? p.resource?.uri) : p.type === 'image' ? '[image attached]' : '')).filter(Boolean).join('\n')
        const images = parts.filter((p) => p.type === 'image' && p.data).map((p) => `data:${p.mimeType ?? 'image/png'};base64,${p.data}`)
        if (r.isError) throw new Error(text || `${t.name} failed`)
        return { text: text || '(no output)', images: images.length ? images : undefined, display: t.annotations?.title ?? t.name.replace(/_/g, ' ') }
      }
    }
  }
}
