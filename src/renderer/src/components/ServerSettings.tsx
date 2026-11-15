import { useEffect, useState } from 'react'
import type { RemoteServerStatus, ServerAuditEntry, ServerDeviceInfo, ServerInfo } from '@shared/types'
import { api } from '../api'
import { toast } from '../lib/toast'

// Settings → Server (in a browser connected to SahilBot Server) and Settings → Always-on server (Mac app).
// docs/server.md has the whole design.

const clean = (e: unknown): string => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const ago = (iso?: string): string => {
  if (!iso) return 'never'
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`
}
const uptime = (s: number): string => (s < 3600 ? `${Math.round(s / 60)} min` : s < 172800 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} days`)

function Section({ title, sub, children }: { title?: string; sub?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="set-section">
      {title && <div className="set-label">{title}</div>}
      {sub && <div className="set-sub">{sub}</div>}
      <div className="set-card">{children}</div>
    </section>
  )
}

function Row({ title, sub, children, testId }: { title: React.ReactNode; sub?: React.ReactNode; children?: React.ReactNode; testId?: string }) {
  return (
    <div className="set-row" data-testid={testId}>
      <div className="set-row-text"><div className="set-row-title">{title}</div>{sub && <div className="set-row-sub">{sub}</div>}</div>
      {children && <div className="set-row-ctl">{children}</div>}
    </div>
  )
}

const b64uToBytes = (s: string): Uint8Array => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

/** Web Push on this device: permission, the service worker, the subscription. */
async function enablePush(): Promise<string> {
  const server = api.server
  if (!server) return 'Not connected to a server.'
  if (!('Notification' in window)) return 'This browser has no notifications. On iPhone and iPad, add SahilBot to the Home Screen first (Share → Add to Home Screen), then open it from there.'
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') return 'Notifications are blocked for this site in the browser’s settings.'
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'ok-inpage'
  if (!window.isSecureContext) return 'ok-inpage'
  const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
  await navigator.serviceWorker.ready
  const key = await server.pushKey()
  if (!key) return 'ok-inpage'
  const sub = await reg.pushManager.getSubscription() ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(key) as BufferSource })
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } }
  return (await server.pushSubscribe(json)) ? 'ok' : 'The server refused this browser’s push address.'
}

export function ServerPage() {
  const server = api.server!
  const [info, setInfo] = useState<ServerInfo | null>(null)
  const [devices, setDevices] = useState<ServerDeviceInfo[]>([])
  const [audit, setAudit] = useState<ServerAuditEntry[] | null>(null)
  const [code, setCode] = useState<{ code: string; expires: number } | null>(null)
  const [pushMsg, setPushMsg] = useState<string>('')

  const load = async (): Promise<void> => {
    try { setInfo(await server.info()); setDevices(await server.devices()) } catch (e) { toast(clean(e)) }
  }
  useEffect(() => {
    void load()
    const t = setInterval(() => void server.info().then(setInfo).catch(() => undefined), 5000)
    return () => clearInterval(t)
  }, [])

  const me = devices.find((d) => d.current)
  const active = devices.filter((d) => !d.revokedAt)
  return (
    <div data-testid="server-settings">
      <h2>Server</h2>
      <Section title="This server" sub="SahilBot runs here around the clock: bots, routines and connected apps keep working while your devices are off.">
        {info ? <>
          <Row title="Status" sub={`SahilBot ${info.version} · up ${uptime(info.uptime)} · ${info.platform} ${info.arch} · Node ${info.node}`} testId="server-status"><span className="conn ok">Running</span></Row>
          <Row title="Work" sub={`${info.runs.running} of ${info.runs.limit} runs going${info.runs.queued ? `, ${info.runs.queued} waiting` : ''}${info.runs.pressure ? ' (waiting for memory)' : ''} · busiest: ${info.runs.maxRunning} at once`} />
          <Row title="Memory" sub={`SahilBot uses ${info.memory.rssMB} MB · ${info.memory.freeMB} MB of ${Math.round(info.memory.totalMB / 1024)} GB free · load ${info.load[0]} on ${info.cores} cores`} />
          <Row title="Saved keys" sub={({ credential: 'Sealed with a systemd credential.', env: 'Sealed with SAHILBOT_MASTER_KEY.', passphrase: 'Sealed with your passphrase.', keyfile: 'Sealed with a key file on the server (protected by file permissions). A passphrase or systemd credential is stronger: see docs/server.md.' } as Record<string, string>)[info.keySource]} />
          <Row title="Not on the server" sub={`Needs the Mac app: ${info.unavailable.join('; ')}.`} />
        </> : <Row title="Loading…" />}
      </Section>

      <Section title="This device" sub="Get a notification when a bot needs you or finishes, even with SahilBot closed.">
        <Row title={me ? me.name : 'This browser'} sub={pushMsg || (me?.push ? 'Notifications are on.' : 'Notifications are off.')} testId="server-push">
          <button className="btn" onClick={() => void enablePush().then((r) => {
            setPushMsg(r === 'ok' ? 'Notifications are on.' : r === 'ok-inpage' ? 'On while SahilBot is open in this browser (this browser can’t receive them when closed).' : r)
            void load()
          }).catch((e) => setPushMsg(clean(e)))} data-testid="server-push-on">{me?.push ? 'Re-check' : 'Turn on'}</button>
          {me?.push && <button className="link-btn" onClick={() => void server.pushTest().then(() => toast('Sent a test notification.'))}>Test</button>}
        </Row>
      </Section>

      <Section title="Paired devices" sub="Phones and computers that can use this server. Remove one you lost or no longer use: it is signed out at once.">
        {active.map((d) => (
          <Row key={d.id} title={<>{d.name}{d.current && <span className="conn ok" style={{ marginLeft: 8 }}>This device</span>}</>} sub={`${d.kind === 'app' ? 'Mac app' : 'Browser'} · paired ${ago(d.createdAt)} · last seen ${ago(d.lastSeen)}${d.lastIp ? ` from ${d.lastIp}` : ''}${d.sessions ? ` · ${d.sessions} open` : ''}${d.push ? ' · notifications' : ''}`} testId={`server-device-${d.id}`}>
            <button className="link-btn danger" onClick={() => {
              if (!window.confirm(d.current ? 'Remove this device? You will need a new pairing code to come back.' : `Remove ${d.name}? It is signed out right away.`)) return
              void server.revokeDevice(d.id).then(setDevices).catch((e) => toast(clean(e)))
            }} data-testid={`server-revoke-${d.id}`}>Remove</button>
          </Row>
        ))}
        <Row title="Pair another device" sub={code ? `Enter this code on the other device (works once, until ${new Date(code.expires).toLocaleTimeString()}).` : 'Shows a one-time code to enter on the new device.'}>
          {code ? <code className="server-code" data-testid="server-pair-code" style={{ fontSize: 18, letterSpacing: '.08em' }}>{code.code}</code>
            : <button className="btn" onClick={() => void server.pairingCode().then(setCode).catch((e) => toast(clean(e)))} data-testid="server-pair-new">New code</button>}
        </Row>
      </Section>

      <Section title="Access log" sub="Pairings, sign-ins, approvals and removals, newest first.">
        {audit === null
          ? <Row title="Recent activity"><button className="btn" onClick={() => void server.audit(100).then(setAudit)} data-testid="server-audit">Show</button></Row>
          : audit.slice(0, 100).map((e, i) => <Row key={i} title={e.kind} sub={`${new Date(e.at).toLocaleString()}${e.device ? ` · ${devices.find((d) => d.id === e.device)?.name ?? e.device}` : ''}${e.ip ? ` · ${e.ip}` : ''}${e.detail ? ` · ${e.detail}` : ''}`} />)}
      </Section>
    </div>
  )
}

/** Mac app: link this Mac to a SahilBot Server (status, open its web UI). */
export function AlwaysOnServerPage() {
  const remote = api.remoteServer
  const [st, setSt] = useState<RemoteServerStatus | null>(null)
  const [url, setUrl] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => { void remote?.status(true).then(setSt).catch((e) => setErr(clean(e))) }, [])
  if (!remote) return null
  const connect = async (): Promise<void> => {
    setBusy(true); setErr('')
    try { const s = await remote.connect(url.trim(), code.trim()); setSt(s); setCode('') } catch (e) { setErr(clean(e)) } finally { setBusy(false) }
  }
  return (
    <div data-testid="always-on-settings">
      <h2>Always-on server</h2>
      <Section title="SahilBot Server" sub="Run your bots around the clock on a Raspberry Pi 5, a small VM or a Mac mini, and reach them from this Mac or your phone, even while traveling. Setup takes about five minutes: see docs/server.md.">
        {st?.linked ? <>
          <Row title={st.url} sub={st.online === false ? `Can’t reach it right now${st.error ? `: ${st.error}` : ''}.` : st.info ? `Online · SahilBot ${st.info.version} on ${st.info.platform} ${st.info.arch} · up ${uptime(st.info.uptime)} · ${st.info.bots} bots, ${st.info.routines} routines · ${st.info.running} running${st.info.queued ? `, ${st.info.queued} waiting` : ''} · ${st.info.rssMB} MB` : 'Checking…'} testId="remote-status">
            <span className={`conn ${st.online === false ? 'bad' : 'ok'}`}>{st.online === false ? 'Offline' : 'Linked'}</span>
          </Row>
          {st.pinned && <Row title="Certificate" sub={`Self-signed, pinned: ${st.pinned.slice(0, 23)}…`} />}
          <Row title="Open the server’s app" sub="Opens it in your browser, already signed in. Bots, chats, routines and approvals there run on the server.">
            <button className="btn primary" onClick={() => void remote.openUi().catch((e) => setErr(clean(e)))} data-testid="remote-open">Open server UI</button>
          </Row>
          <Row title="Refresh or unlink" sub="Unlinking removes this Mac from the server’s paired devices.">
            <button className="btn" onClick={() => void remote.status(true).then(setSt)}>Refresh</button>
            <button className="link-btn danger" onClick={() => void remote.disconnect().then(setSt)} data-testid="remote-disconnect">Unlink</button>
          </Row>
        </> : <>
          <Row title="Server address" sub="The URL your server prints, e.g. https://raspberrypi.your-tailnet.ts.net">
            <input className="set-input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" spellCheck={false} data-testid="remote-url" />
          </Row>
          <Row title="Pairing code" sub="On the server: sahilbot-server pair">
            <input className="set-input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXXX-XXXXX" spellCheck={false} data-testid="remote-code" />
            <button className="btn primary" disabled={busy || !url.trim() || !code.trim()} onClick={() => void connect()} data-testid="remote-connect">{busy ? 'Linking…' : 'Link'}</button>
          </Row>
        </>}
        {err && <Row title={<span className="conn bad">{err}</span>} />}
      </Section>
    </div>
  )
}
