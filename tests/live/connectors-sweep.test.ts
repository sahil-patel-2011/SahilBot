import { lookup } from 'node:dns/promises'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { ConnectorPreset } from '@shared/types'
import { LOCAL_SERVERS, PRESETS, iconDomain, isLocalPreset } from '../../src/main/connectors'

// Connector readiness sweep: for every catalog app with a server URL, the same unauthenticated,
// read-only probes used to verify the catalog by hand. Free (no model calls) and safe: it never
// registers a client, signs in, or sends a credential. Run with
//   LIVE_SWEEP=1 npx vitest run --config vitest.live.config.mts tests/live/connectors-sweep.test.ts
// It writes docs/connectors-status.json and docs/connectors-status.md. To re-check only some apps
// (their rows are replaced, the rest kept from the last full sweep):
//   LIVE_SWEEP=1 LIVE_SWEEP_IDS=render,pagerduty,brevo npx vitest run --config vitest.live.config.mts tests/live/connectors-sweep.test.ts

const UA = 'SahilBot-readiness-sweep/1 (read-only; no sign-in)'
const TIMEOUT = 15_000

type Status = 'ok' | 'warn' | 'broken' | 'unreachable'
export interface SweepRow {
  id: string
  name: string
  auth: ConnectorPreset['auth']
  url: string
  status: Status
  /** What the server answered: open, oauth-dcr, oauth-no-dcr, key, unreachable, not-mcp. */
  observed: string
  http?: number
  serverName?: string
  prm?: string
  resource?: string
  authServer?: string
  registration?: string
  pkceS256?: boolean | 'unlisted'
  publicClients?: boolean | 'unlisted'
  refresh?: boolean | 'unlisted'
  cimd?: boolean
  iconDomain?: string | null
  iconResolves?: boolean
  problems: string[]
  notes: string[]
}

/** fetch with a timeout, never following redirects off the origin (what the MCP SDK does for metadata). */
async function get(url: string, init: RequestInit = {}): Promise<{ res?: Response; error?: string; movedTo?: string }> {
  let current = url
  for (let hop = 0; hop < 4; hop++) {
    try {
      const res = await fetch(current, { ...init, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT), headers: { 'user-agent': UA, ...(init.headers as Record<string, string> ?? {}) } })
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        const next = new URL(res.headers.get('location')!, current)
        await res.body?.cancel().catch(() => undefined)
        if (next.origin !== new URL(current).origin) return { movedTo: next.href, error: `redirects to another site (${next.origin})` }
        current = next.href
        continue
      }
      return { res, ...(current !== url ? { movedTo: current } : {}) }
    } catch (e) {
      const err = e as Error & { cause?: { code?: string; message?: string } }
      return { error: err.cause?.code ?? err.cause?.message ?? err.message }
    }
  }
  return { error: 'too many redirects' }
}

/** Reads a body up to ~256 KB; an SSE stream is read until its first data: line. */
async function bodyText(res: Response): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const dec = new TextDecoder()
  let text = ''
  const sse = (res.headers.get('content-type') ?? '').includes('text/event-stream')
  const deadline = Date.now() + TIMEOUT
  try {
    while (text.length < 256_000 && Date.now() < deadline) {
      const { value, done } = await Promise.race([reader.read(), new Promise<{ value?: undefined; done: true }>((r) => setTimeout(() => r({ done: true }), Math.max(1, deadline - Date.now())))])
      if (done) break
      text += dec.decode(value, { stream: true })
      if (sse && /^data:.*\n/m.test(text)) break
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return text
}

async function json(url: string): Promise<{ data?: Record<string, any>; status?: number; error?: string; movedTo?: string }> {
  const r = await get(url, { headers: { accept: 'application/json', 'mcp-protocol-version': '2025-06-18' } })
  if (!r.res) return { error: r.error, movedTo: r.movedTo }
  const text = await bodyText(r.res)
  if (!r.res.ok) return { status: r.res.status }
  try { return { data: JSON.parse(text), status: r.res.status } } catch { return { status: r.res.status, error: 'not JSON' } }
}

function parseRpc(text: string): Record<string, any> | undefined {
  const t = text.trim()
  try { return JSON.parse(t) } catch { /* maybe SSE */ }
  const line = t.split('\n').find((l) => l.startsWith('data:'))
  if (line) try { return JSON.parse(line.slice(5).trim()) } catch { /* not JSON */ }
  return undefined
}

/** RFC 9728 candidates: the WWW-Authenticate resource_metadata URL, then path-aware, then root. */
function prmCandidates(server: URL, header?: string | null): string[] {
  const out: string[] = []
  const m = /resource_metadata="?([^",\s]+)"?/i.exec(header ?? '')
  if (m) out.push(new URL(m[1], server).href)
  const path = server.pathname.replace(/\/$/, '')
  if (path) out.push(`${server.origin}/.well-known/oauth-protected-resource${path}`)
  out.push(`${server.origin}/.well-known/oauth-protected-resource`)
  return [...new Set(out)]
}

/** RFC 8414 then OIDC discovery URLs, in the MCP SDK's order. */
function asCandidates(issuer: string): string[] {
  const u = new URL(issuer)
  const path = u.pathname.replace(/\/$/, '')
  if (!path) return [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`]
  return [`${u.origin}/.well-known/oauth-authorization-server${path}`, `${u.origin}/.well-known/openid-configuration${path}`, `${u.origin}${path}/.well-known/openid-configuration`]
}

const has = (list: unknown, v: string): boolean | 'unlisted' => (Array.isArray(list) ? list.includes(v) : 'unlisted')

export async function probe(p: ConnectorPreset): Promise<SweepRow> {
  const row: SweepRow = { id: p.id, name: p.name, auth: p.auth, url: p.url, status: 'ok', observed: '?', problems: [], notes: [] }
  const server = new URL(p.url)

  // Icon domain: the host the favicon services are asked about must exist.
  row.iconDomain = iconDomain(p)
  if (row.iconDomain) {
    try { await lookup(row.iconDomain.split('/')[0]); row.iconResolves = true } catch { row.iconResolves = false; row.problems.push(`icon domain ${row.iconDomain} does not resolve`) }
  }

  // 1. MCP initialize, unauthenticated.
  const init = await get(p.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'SahilBot-sweep', version: '1' } } })
  })
  if (init.movedTo) row.notes.push(`initialize ${init.res ? 'followed a redirect to' : 'redirects to'} ${init.movedTo}`)
  if (!init.res) {
    row.observed = 'unreachable'
    row.status = 'unreachable'
    row.problems.push(`initialize failed: ${init.error}`)
    return row
  }
  row.http = init.res.status
  const www = init.res.headers.get('www-authenticate')
  const text = await bodyText(init.res)
  const rpc = parseRpc(text)
  if (init.res.status === 200 && rpc?.result?.serverInfo?.name) row.serverName = String(rpc.result.serverInfo.name)
  const rpcError = rpc?.error ? String(rpc.error.message ?? JSON.stringify(rpc.error)).slice(0, 160) : undefined
  if (rpcError) row.notes.push(`initialize error: ${rpcError}`)

  // 2. Protected resource metadata (RFC 9728).
  let prm: Record<string, any> | undefined
  for (const u of prmCandidates(server, www)) {
    const r = await json(u)
    if (r.data && (Array.isArray(r.data.authorization_servers) || r.data.resource)) { prm = r.data; row.prm = u; break }
    if (r.error && /another site/.test(r.error)) row.notes.push(`PRM ${u} ${r.error}`)
  }
  if (prm) {
    row.resource = prm.resource
    try { if (prm.resource && new URL(prm.resource).origin !== server.origin) row.problems.push(`PRM resource ${prm.resource} is on another origin (SahilBot refuses to sign in there)`) } catch { row.notes.push(`PRM resource is not a URL: ${prm.resource}`) }
  }

  // 3. Authorization server metadata (RFC 8414 / OIDC). Legacy servers without PRM: the server's own origin.
  const issuer: string | undefined = prm?.authorization_servers?.[0] ?? (init.res.status === 401 ? server.origin : undefined)
  let as: Record<string, any> | undefined
  if (issuer) {
    row.authServer = issuer
    for (const u of asCandidates(issuer)) {
      const r = await json(u)
      if (r.data && (r.data.authorization_endpoint || r.data.token_endpoint)) { as = r.data; break }
    }
    if (!as) row.notes.push(`no authorization server metadata at ${issuer}`)
  }
  if (as) {
    row.registration = as.registration_endpoint
    row.pkceS256 = has(as.code_challenge_methods_supported, 'S256')
    row.publicClients = has(as.token_endpoint_auth_methods_supported, 'none')
    row.refresh = has(as.grant_types_supported, 'refresh_token')
    row.cimd = as.client_id_metadata_document_supported === true
  }

  // What the server is, from what it answered.
  const keyish = /api[_ -]?key|token|authori[sz]ation|bearer|unauthori[sz]ed|credential/i
  if (init.res.status === 200 && row.serverName && !rpcError) row.observed = as ? (as.registration_endpoint ? 'open+oauth-dcr' : 'open+oauth-no-dcr') : 'open'
  else if (as?.registration_endpoint) row.observed = 'oauth-dcr'
  else if (as) row.observed = 'oauth-no-dcr'
  else if ([401, 403].includes(init.res.status) || (rpcError && keyish.test(rpcError))) row.observed = 'key'
  else if (init.res.status >= 500) row.observed = 'server-error'
  else row.observed = `not-mcp (${init.res.status})`

  // 4. Does what the catalog says still match?
  const isGoogle = /(^|\.)accounts\.google\.com$/.test((() => { try { return new URL(row.authServer ?? '').hostname } catch { return '' } })())
  const broken = (m: string): void => { row.problems.push(m) }
  switch (p.auth) {
    case 'oauth':
      if (!row.observed.includes('oauth')) broken(`expected OAuth sign-in, server looks like "${row.observed}"`)
      else if (!row.registration) broken('authorization server has no registration_endpoint (no one-click DCR any more)')
      if (as && row.pkceS256 === false) broken('authorization server does not list PKCE S256')
      break
    case 'none':
      if (!row.serverName) broken(`expected an open server, initialize answered ${init.res.status}${rpcError ? ` (${rpcError})` : ''}`)
      else if (row.registration) row.notes.push(`open, and also offers OAuth with DCR (${new URL(row.registration).host}): stays no sign-in`)
      break
    case 'apikey':
      if (row.observed !== 'key' && !row.observed.startsWith('oauth')) broken(`expected the server to ask for an API key, it answered "${row.observed}"`)
      if (row.registration) row.notes.push(`server now also offers OAuth with DCR${row.pkceS256 === true ? ' + PKCE S256' : ''}${row.publicClients === true ? ' (public clients)' : ''}: could become one click if the vendor documents it`)
      else if (as) row.notes.push(`OAuth metadata but no self-registration (stays an API key unless SahilBot registers its own app)`)
      break
    case 'google':
      if (!isGoogle) broken(`expected Google sign-in (accounts.google.com), got ${row.authServer ?? 'no authorization server'}`)
      break
    case 'oauth-static':
      if (!row.observed.includes('oauth')) broken(`expected OAuth sign-in, server looks like "${row.observed}"`)
      if (row.registration) row.notes.push(`now has a registration_endpoint (${row.registration}): may be one click`)
      if (as && row.pkceS256 === false) row.notes.push('PKCE S256 not listed')
      break
  }
  if (row.publicClients === false && p.auth === 'oauth') row.notes.push('token endpoint does not list "none" auth (DCR may hand out a client secret; the SDK handles that)')
  if (row.refresh === false && (p.auth === 'oauth' || p.auth === 'oauth-static' || p.auth === 'google')) row.notes.push('no refresh_token grant listed: sign-in may be needed again when the token expires')
  if (row.pkceS256 === 'unlisted' && p.auth === 'oauth') row.notes.push('PKCE methods not listed (SahilBot sends S256 anyway)')

  if (row.problems.length) row.status = row.observed === 'unreachable' || row.observed === 'server-error' ? 'unreachable' : 'broken'
  else if (row.notes.some((n) => /registration_endpoint|could become|redirect|not resolve/.test(n))) row.status = 'warn'
  return row
}

async function mapLimit<T, R>(xs: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length)
  let i = 0
  await Promise.all(Array.from({ length: n }, async () => { for (let k = i++; k < xs.length; k = i++) out[k] = await fn(xs[k]) }))
  return out
}

function markdown(rows: SweepRow[], date: string, skipped: ConnectorPreset[]): string {
  const count = (s: Status): number => rows.filter((r) => r.status === s).length
  const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')
  const lines = [
    '# Connector readiness',
    '',
    `Swept ${date} by \`tests/live/connectors-sweep.test.ts\` (read-only: an unauthenticated MCP \`initialize\`, RFC 9728 protected-resource metadata, RFC 8414/OIDC authorization-server metadata, and a DNS lookup of each icon domain; no client was registered and nothing signed in).`,
    '',
    `**${rows.length} servers checked:** ${count('ok')} ok, ${count('warn')} warn, ${count('broken')} broken, ${count('unreachable')} unreachable. ${skipped.length} catalog entries have no https server to probe (built in, browser, custom, and local servers on this Mac, which run only their allowlisted command or loopback address).`,
    '',
    'Re-run: `LIVE_SWEEP=1 npx vitest run --config vitest.live.config.mts tests/live/connectors-sweep.test.ts`',
    '',
    '| App | Auth | Status | Server answered | Registration | PKCE S256 | Refresh | Problems / notes |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map((r) => `| ${cell(r.name)} (\`${r.id}\`) | ${r.auth} | ${r.status} | ${cell(`${r.observed}${r.http ? ` · ${r.http}` : ''}${r.serverName ? ` · ${r.serverName}` : ''}`)} | ${cell(r.registration ? new URL(r.registration).host + new URL(r.registration).pathname : '-')} | ${r.pkceS256 ?? '-'} | ${r.refresh ?? '-'} | ${cell([...r.problems, ...r.notes].join('; ') || '-')} |`),
    '',
    `Not probed (no server URL): ${skipped.map((p) => `\`${p.id}\``).join(', ')}.`,
    ''
  ]
  return lines.join('\n')
}

describe.skipIf(!process.env.LIVE_SWEEP)('live: connector readiness sweep', () => {
  test('every catalog server still answers the way its preset expects', async () => {
    const all = PRESETS.filter((p) => /^https:\/\//.test(p.url) && p.auth !== 'browser' && p.auth !== 'app' && !isLocalPreset(p))
    const skipped = PRESETS.filter((p) => !all.includes(p))
    // Every remote catalog server is probed; the only entries skipped are built in (app: URLs), browser, custom and local ones.
    expect(skipped.filter((p) => !['browser', 'app'].includes(p.auth) && !p.url.startsWith('app:') && p.id !== 'custom' && !isLocalPreset(p)).map((p) => p.id)).toEqual([])
    expect(skipped.filter(isLocalPreset).map((p) => p.id).sort()).toEqual(Object.keys(LOCAL_SERVERS).sort())
    const only = (process.env.LIVE_SWEEP_IDS ?? '').split(',').map((x) => x.trim()).filter(Boolean)
    const targets = only.length ? all.filter((p) => only.includes(p.id)) : all
    const probed = await mapLimit(targets, 8, (p) => probe(p).catch((e) => ({ id: p.id, name: p.name, auth: p.auth, url: p.url, status: 'unreachable' as Status, observed: 'unreachable', problems: [String(e)], notes: [] })))
    const date = new Date().toISOString().slice(0, 10)
    const dir = resolve('docs')
    mkdirSync(dir, { recursive: true })
    // A partial run replaces just its rows (dated), keeping the rest from the last sweep, in catalog order.
    let rows: SweepRow[] = probed
    if (only.length) {
      const prev = existsSync(resolve(dir, 'connectors-status.json')) ? (JSON.parse(readFileSync(resolve(dir, 'connectors-status.json'), 'utf8')).rows as SweepRow[]) : []
      const fresh = new Map(probed.map((r) => [r.id, { ...r, notes: [...r.notes, `re-checked ${date}`] }]))
      rows = all.map((p) => fresh.get(p.id) ?? prev.find((r) => r.id === p.id)).filter((r): r is SweepRow => !!r)
    }
    writeFileSync(resolve(dir, 'connectors-status.json'), JSON.stringify({ date, rows }, null, 2) + '\n')
    writeFileSync(resolve(dir, 'connectors-status.md'), markdown(rows, date, skipped))
    const bad = rows.filter((r) => r.status === 'broken' || r.status === 'unreachable')
    console.log(`${rows.length} probed: ${rows.filter((r) => r.status === 'ok').length} ok, ${rows.filter((r) => r.status === 'warn').length} warn, ${bad.length} broken/unreachable`)
    for (const r of [...bad, ...rows.filter((x) => x.status === 'warn')]) console.log(`${r.status.toUpperCase()} ${r.id}: ${[...r.problems, ...r.notes].join('; ')}`)
    // The report is the output; presets the app already marks unavailable are expected to fail.
    expect(bad.filter((r) => !PRESETS.find((p) => p.id === r.id)?.unavailable).map((r) => r.id)).toEqual([])
  }, 600_000)
})
