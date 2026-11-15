// Starts SahilBot Server: the server's own pieces (master key, devices, audit, WebSocket hub, HTTP front),
// then the Mac app's main process (src/main/index.ts) on top of them, with `electron` replaced by
// ./platform/electron.ts. See docs/server.md.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { arch, cpus, freemem, loadavg, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { addAdapter, broadcast, invoke, registerHandler, type RpcContext } from '../main/rpc'
import { setDeviceNotifier } from '../main/notify'
import { configureRuns, cpuSlots, defaultMemoryLimits, defaultRunLimit, helperCeiling, runScheduler, setHelperCeiling } from '../main/agent/run-scheduler'
import { SERVER_UNAVAILABLE_TOOLS } from '../main/runtime'
import { AuditLog } from './audit'
import { Devices, formatCode, PairingCodes, RateLimiter } from './auth'
import { HttpFront } from './http'
import { Hub } from './hub'
import { host } from './host'
import { WebPush } from './push'
import { resolveMasterKey, type MasterKey } from './secrets'
import { loadTls, type TlsFiles } from './tls'
import { markReady } from './platform/electron'
import type { ServerDeviceInfo, ServerInfo } from '@shared/types'

export interface ServerConfig {
  /** The data folder (database, settings, vault, workspace defaults). */
  data: string
  port: number
  /** Address to listen on. Loopback by default; anything else requires TLS. */
  listen: string
  tls?: boolean
  cert?: string
  key?: string
  allowHosts?: string[]
  passphrase?: string
  maxRuns?: number
  /** The renderer bundle and the bridge (defaults: next to this file). */
  uiDir?: string
  bridgeFile?: string
  /** Print a pairing code on start when nothing is paired yet (default true). */
  pairOnStart?: boolean
  log?: (line: string) => void
  /** Tests: cheaper key stretching, a fake push transport. */
  scryptN?: number
  pushFetch?: typeof fetch
  heartbeatMs?: number
}

export interface RunningServer {
  url: string
  port: number
  tls: TlsFiles | null
  /** The pairing code printed at start (only when nothing was paired). */
  firstCode?: string
  devices: Devices
  codes: PairingCodes
  audit: AuditLog
  hub: Hub
  key: MasterKey
  stop(): Promise<void>
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

/** The install folder: the nearest one up with package.json (the repo in development, ~/sahilbot-server installed). */
export function installRoot(): string {
  let d = __dirname
  while (d !== dirname(d) && !existsSync(join(d, 'package.json'))) d = dirname(d)
  return existsSync(join(d, 'package.json')) ? d : process.cwd()
}

export function version(): string {
  try { return (JSON.parse(readFileSync(join(installRoot(), 'package.json'), 'utf8')) as { version: string }).version } catch { return '0.0.0' }
}

/** One server per data folder. */
function lock(dir: string): () => void {
  const file = join(dir, 'server.pid')
  if (existsSync(file)) {
    const pid = Number(readFileSync(file, 'utf8'))
    let alive = false
    try { if (pid && pid !== process.pid) { process.kill(pid, 0); alive = true } } catch { /* gone */ }
    if (alive) throw new Error(`SahilBot Server is already running on this data folder (pid ${pid}).`)
  }
  writeFileSync(file, String(process.pid))
  return () => { try { if (Number(readFileSync(file, 'utf8')) === process.pid) rmSync(file) } catch { /* gone */ } }
}

export async function startServer(cfg: ServerConfig): Promise<RunningServer> {
  const log = cfg.log ?? ((l: string) => console.log(l))
  const data = resolve(cfg.data)
  const dir = join(data, 'server')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const listenLocal = LOOPBACK.has(cfg.listen)
  if (!listenLocal && cfg.tls === false) throw new Error(`Listening on ${cfg.listen} needs TLS. Drop --no-tls, or keep the default 127.0.0.1 and use Tailscale (tailscale serve).`)
  const unlock = lock(dir)

  // The main process reads these (src/main/paths.ts, runtime.ts).
  process.env.SAHILBOT_RUNTIME = 'server'
  process.env.FOREMAN_DATA_DIR = data
  host.dataDir = data
  host.version = version()

  const key = await resolveMasterKey({ dir, passphrase: cfg.passphrase, scryptN: cfg.scryptN })
  host.safeStorage.setKey(key.key)
  const audit = new AuditLog(join(dir, 'audit.log'))
  const devices = new Devices(dir, key.key)
  const codes = new PairingCodes(join(dir, 'pairing.json'))
  const limiter = new RateLimiter({ perKey: 5, total: 20, windowMs: 15 * 60_000 })

  // ---- capacity: concurrent runs sized to this machine, swarms trimmed on small boards, CPU work pooled
  const totalGB = totalmem() / 1024 ** 3
  const limits = defaultMemoryLimits()
  configureRuns({ limit: cfg.maxRuns ?? (Number(process.env.SAHILBOT_MAX_RUNS) || defaultRunLimit()), ...limits })
  if (totalGB < 6) setHelperCeiling(6)
  cpuSlots.setSize(Math.max(1, Math.min(4, (cpus().length || 2) - 1)))

  const hub = new Hub({ audit, version: host.version, heartbeatMs: cfg.heartbeatMs, onDirectSend: (ch, args) => host.sends.emit(ch, { sender: null }, ...args) })
  hub.activeDevices = () => devices.active().map((d) => d.id)
  const push = new WebPush(dir, key.key, { fetch: cfg.pushFetch, log: (l) => log(`[push] ${l}`) })
  hub.push = push
  host.ui = hub
  addAdapter(hub.adapter())
  setDeviceNotifier((ids, payload) => hub.notify(ids, payload))
  const sched = runScheduler()
  if (sched) sched.onQueued = (t, position, reason) => broadcast('chat:event', { threadId: t.threadId, type: 'queued', position, reason })

  let tls: TlsFiles | null = null
  if (cfg.tls || cfg.cert || cfg.key || !listenLocal) tls = loadTls({ dir, certFile: cfg.cert, keyFile: cfg.key, names: cfg.allowHosts?.filter((h) => !h.startsWith('*')) })

  // ---- server channels (Settings → Server in the web UI)
  const started = Date.now()
  let url = ''
  const deviceRows = (ctx: RpcContext): ServerDeviceInfo[] => devices.list().map((d) => ({
    ...d, current: d.id === ctx.deviceId, sessions: hub.list().filter((s) => s.deviceId === d.id).length, push: push.has(d.id)
  }))
  const info = (): ServerInfo => {
    const s = runScheduler()?.stats()
    const m = process.memoryUsage()
    return {
      runtime: 'server', version: host.version, platform: process.platform, arch: arch(), node: process.versions.node, url, tls: !!tls, selfSigned: !!tls?.selfSigned,
      uptime: Math.round((Date.now() - started) / 1000),
      memory: { rssMB: Math.round(m.rss / 1048576), heapMB: Math.round(m.heapUsed / 1048576), totalMB: Math.round(totalmem() / 1048576), freeMB: Math.round(freemem() / 1048576) },
      load: loadavg().map((x) => Math.round(x * 100) / 100), cores: cpus().length,
      runs: { limit: s?.limit ?? 0, running: s?.running ?? 0, queued: s?.queued ?? 0, pressure: !!s?.pressure, maxRunning: s?.maxRunning ?? 0, admitted: s?.admitted ?? 0 },
      helperCeiling: Number.isFinite(helperCeiling()) ? helperCeiling() : null,
      keySource: key.kind, push: true,
      unavailable: [...new Set(Object.values(SERVER_UNAVAILABLE_TOOLS))]
    }
  }
  registerHandler('server:info', () => info())
  registerHandler('server:devices', (ctx) => deviceRows(ctx))
  registerHandler('server:revokeDevice', (ctx, id) => {
    const target = String(id ?? '')
    if (devices.revoke(target)) {
      audit.write('device.revoke', { device: target, detail: `by ${ctx.deviceId ?? 'server'}` })
      push.unsubscribe(target)
      hub.closeDevice(target, 'this device was removed')
    }
    return deviceRows(ctx)
  })
  registerHandler('server:renameDevice', (ctx, id, name) => {
    if (devices.rename(String(id ?? ''), String(name ?? ''))) audit.write('device.rename', { device: String(id), detail: String(name ?? '').slice(0, 60) })
    return deviceRows(ctx)
  })
  registerHandler('server:pairingCode', (ctx) => {
    const c = codes.create()
    audit.write('pair.code', { device: ctx.deviceId, detail: 'from Settings' })
    return { code: formatCode(c.code), expires: c.expires }
  })
  registerHandler('server:audit', (_ctx, limit) => audit.recent(Math.max(1, Math.min(1000, Number(limit) || 200))))
  registerHandler('server:pushKey', () => push.publicKey())
  registerHandler('server:pushSubscribe', (ctx, sub) => !!ctx.deviceId && push.subscribe(ctx.deviceId, sub))
  registerHandler('server:pushUnsubscribe', (ctx) => !!ctx.deviceId && push.unsubscribe(ctx.deviceId))
  registerHandler('server:pushTest', (ctx) => hub.notify(ctx.deviceId ? [ctx.deviceId] : [], { title: 'SahilBot Server', body: 'Notifications work on this device.', kind: 'info', tag: 'test' }))

  // ---- the main process (everything the Mac app does, minus the screen)
  host.quit = () => { void stop() }
  await import('../main/index')
  markReady()
  // whenReady() callbacks registered by the main process run before this continues.
  const { app } = await import('./platform/electron')
  await app.whenReady()
  await new Promise((r) => setImmediate(r))

  // ---- the front door
  const front = new HttpFront({
    uiDir: cfg.uiDir ?? join(installRoot(), 'out', 'renderer'),
    bridgeFile: cfg.bridgeFile ?? join(installRoot(), 'out', 'server', 'web', 'bridge.js'),
    tls: tls ?? undefined, devices, codes, limiter, audit, hub,
    policy: { allowHosts: cfg.allowHosts ?? [] },
    status: async () => {
      const i = info()
      const count = async (ch: string, pick: (x: Array<Record<string, unknown>>) => number): Promise<number> => {
        try { return pick((await invoke(ch, { transport: 'test' }, [])) as Array<Record<string, unknown>>) } catch { return 0 }
      }
      const bots = await count('spaces:list', (xs) => xs.filter((x) => x.kind === 'bot' && !x.hidden).length)
      const routines = await count('schedules:list', (xs) => xs.filter((x) => x.enabled !== false).length)
      return { version: i.version, uptime: i.uptime, bots, routines, running: i.runs.running, queued: i.runs.queued, rssMB: i.memory.rssMB, platform: i.platform, arch: i.arch, sessions: hub.list().length }
    }
  })
  const { port } = await front.listen(cfg.port, cfg.listen)
  const shownHost = listenLocal ? (cfg.listen === '::1' ? '[::1]' : '127.0.0.1') : cfg.listen === '0.0.0.0' || cfg.listen === '::' ? 'this-machine' : cfg.listen
  url = `${tls ? 'https' : 'http'}://${shownHost}:${port}`
  audit.write('server.start', { detail: `${url} key=${key.kind} v${host.version}` })

  let firstCode: string | undefined
  if (cfg.pairOnStart !== false && devices.active().length === 0) {
    const c = codes.create()
    firstCode = c.code
    audit.write('pair.code', { detail: 'first start' })
  }

  let stopping: Promise<void> | null = null
  async function stop(): Promise<void> {
    if (stopping) return stopping
    stopping = (async () => {
      audit.write('server.stop', {})
      const { app: a } = await import('./platform/electron')
      try { a.emit('before-quit', { preventDefault: () => undefined }) } catch (e) { log(`[server] before-quit: ${(e as Error).message}`) }
      try { a.emit('will-quit', { preventDefault: () => undefined }) } catch { /* best effort */ }
      hub.dispose()
      devices.dispose()
      runScheduler()?.dispose()
      await front.close()
      unlock()
    })()
    return stopping
  }

  return { url, port, tls, firstCode, devices, codes, audit, hub, key, stop }
}
