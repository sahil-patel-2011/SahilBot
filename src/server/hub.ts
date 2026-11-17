// The paired browsers: one WebSocket session per open tab. Calls go to the RPC registry (src/main/rpc.ts)
// as if the main window made them; events and notifications go out to every session.

import { randomBytes } from 'node:crypto'
import { invoke, RpcError, type RpcAdapter } from '../main/rpc'
import { decode, encode, type ClientMsg, type ServerMsg } from './codec'
import type { AuditLog } from './audit'
import { host, type NotifyPayload, type NotifyResult, type UiLink } from './host'
import type { WsConnection } from './ws'

export interface Session {
  id: string
  deviceId: string
  deviceName: string
  ip: string
  ws: WsConnection
  focused: boolean
  visible: boolean
  openedAt: number
  calls: number
}

/** Channels a browser may never call: they show saved secrets in the clear (use the Mac app for those). */
export const DENIED_CHANNELS: Record<string, string> = {
  'vault:reveal': 'Showing saved passwords is turned off on SahilBot Server. Use the SahilBot Mac app.',
  'vault:totpCode': 'Showing authenticator codes is turned off on SahilBot Server. Use the SahilBot Mac app.',
  'vault:exportBackup': 'Vault backups are made in the SahilBot Mac app.'
}

/** Calls that approve or answer something a bot asked, or change what a bot may do: written to the audit log (no answer text). */
const APPROVALS = new Set(['chat:respond', 'purchase:respond', 'vault:authRespond', 'needsYou:answer', 'botAutonomy:setLevel'])

export interface PushSender {
  /** Sends a Web Push to a device that subscribed; resolves true when the push service took it. */
  send(deviceId: string, payload: NotifyPayload): Promise<boolean>
  has(deviceId: string): boolean
}

/**
 * A host's own say over a call before the registry runs it (Phone access in the Mac app): refuse it with a
 * reason, answer it here instead, or let it through (undefined).
 */
export type CallHook = (ch: string, args: unknown[], s: Session) => { deny: string } | { answer: () => unknown } | undefined

export class Hub implements UiLink {
  readonly sessions = new Map<string, Session>()
  private offline = new Map<string, NotifyPayload[]>()
  private beat: ReturnType<typeof setInterval>
  /** Active devices (for notify('all')). */
  activeDevices: () => string[] = () => []
  push?: PushSender
  /** A session opened or closed, or focus changed. */
  onChange?: () => void

  constructor(private o: { audit: AuditLog; version: string; onDirectSend: (ch: string, args: unknown[]) => void; heartbeatMs?: number; hook?: CallHook; events?: (event: string) => boolean; host?: 'mac' | 'server' }) {
    const ms = o.heartbeatMs ?? 25_000
    this.beat = setInterval(() => {
      const stale = Date.now() - ms * 2.5
      for (const s of this.sessions.values()) {
        if (s.ws.lastSeen < stale) s.ws.terminate()
        else s.ws.ping()
      }
    }, ms)
    this.beat.unref?.()
  }

  adapter(): RpcAdapter {
    return { send: (event, args) => this.send(event, args) }
  }

  attach(ws: WsConnection, device: { id: string; name: string }, ip: string): Session {
    const s: Session = { id: randomBytes(8).toString('hex'), deviceId: device.id, deviceName: device.name, ip, ws, focused: false, visible: true, openedAt: Date.now(), calls: 0 }
    this.sessions.set(s.id, s)
    this.o.audit.write('session.open', { device: device.id, ip, detail: device.name })
    this.out(s, { t: 'hello', runtime: 'server', version: this.o.version, device, platform: process.platform, ...(this.o.host ? { host: this.o.host } : {}) })
    // Notifications that came while this device was away.
    const missed = this.offline.get(device.id)
    if (missed?.length) { this.offline.delete(device.id); for (const p of missed) this.out(s, { t: 'ev', ch: 'server:notify', args: [{ ...p, missed: true }] }) }
    ws.on('message', (data: string | Buffer, binary: boolean) => { if (!binary) void this.onMessage(s, String(data)) })
    ws.on('close', () => {
      this.sessions.delete(s.id)
      this.o.audit.write('session.close', { device: device.id, ip, detail: `${s.calls} calls, ${Math.round((Date.now() - s.openedAt) / 1000)}s` })
      this.onChange?.()
    })
    this.onChange?.()
    return s
  }

  private out(s: Session, msg: ServerMsg): void {
    try { s.ws.send(encode(msg)) } catch { /* closing */ }
  }

  private async onMessage(s: Session, text: string): Promise<void> {
    let msg: ClientMsg
    try { msg = decode<ClientMsg>(text) } catch { s.ws.close(1003, 'bad message'); return }
    if (!msg || typeof msg !== 'object') return
    if (msg.t === 'ping') { this.out(s, { t: 'pong' }); return }
    if (msg.t === 'focus') { s.focused = !!msg.focused; s.visible = !!msg.visible; this.onChange?.(); return }
    if (msg.t === 'send') { if (typeof msg.ch === 'string') this.o.onDirectSend(msg.ch, Array.isArray(msg.args) ? msg.args : []); return }
    if (msg.t !== 'call' || typeof msg.id !== 'number' || typeof msg.ch !== 'string') return
    const { id, ch } = msg
    const args = Array.isArray(msg.args) ? msg.args : []
    s.calls++
    const denied = DENIED_CHANNELS[ch]
    if (denied) {
      this.o.audit.write('call.denied', { device: s.deviceId, ip: s.ip, detail: ch })
      this.out(s, { t: 'ret', id, ok: false, e: `Error invoking remote method '${ch}': Error: ${denied}` })
      return
    }
    const hooked = this.o.hook?.(ch, args, s)
    if (hooked && 'deny' in hooked) {
      this.o.audit.write('call.denied', { device: s.deviceId, ip: s.ip, detail: ch })
      this.out(s, { t: 'ret', id, ok: false, e: `Error invoking remote method '${ch}': Error: ${hooked.deny}` })
      return
    }
    if (APPROVALS.has(ch)) this.o.audit.write('call.approval', { device: s.deviceId, ip: s.ip, detail: `${ch} ${String(args[0] ?? '').slice(0, 40)}` })
    try {
      const v = hooked ? await hooked.answer() : await invoke(ch, { transport: 'ws', deviceId: s.deviceId, sessionId: s.id }, args)
      this.out(s, { t: 'ret', id, ok: true, v })
    } catch (e) {
      const m = e instanceof RpcError && e.code === 'unknown-channel' ? `No handler registered for '${ch}'` : `Error invoking remote method '${ch}': ${e instanceof Error ? `${e.name === 'Error' ? 'Error' : e.name}: ${e.message}` : String(e)}`
      this.out(s, { t: 'ret', id, ok: false, e: m })
    }
  }

  // ---------------------------------------------------------------- UiLink

  send(event: string, args: unknown[]): void {
    if (event === 'chat:event') {
      const t = (args[0] as { threadId?: string } | undefined)?.threadId
      if (t) { host.noteThread = t; queueMicrotask(() => { if (host.noteThread === t) host.noteThread = undefined }) }
    }
    if (!this.sessions.size || (this.o.events && !this.o.events(event))) return
    const text = encode({ t: 'ev', ch: event, args })
    for (const s of this.sessions.values()) { try { s.ws.send(text) } catch { /* closing */ } }
  }

  focused(): boolean { return [...this.sessions.values()].some((s) => s.focused && s.visible) }
  connected(): boolean { return this.sessions.size > 0 }

  private recentNotes = new Map<string, number>()

  notify(deviceIds: string[] | 'all', payload: NotifyPayload): NotifyResult {
    // The same news about the same chat from two places (the app's own notification and the Needs-you
    // queue) within a few seconds goes out once.
    if (payload.threadId) {
      const k = `${payload.threadId}|${payload.kind === 'question' ? 'needs-you' : payload.kind ?? ''}|${deviceIds === 'all' ? 'all' : [...deviceIds].sort().join(',')}`
      const now = Date.now()
      if (now - (this.recentNotes.get(k) ?? 0) < 5000) return { delivered: [], queued: [], pushed: [] }
      this.recentNotes.set(k, now)
      if (this.recentNotes.size > 500) for (const [x, t] of this.recentNotes) if (now - t > 5000) this.recentNotes.delete(x)
    }
    const ids = deviceIds === 'all' ? this.activeDevices() : [...new Set(deviceIds)].filter((d) => this.activeDevices().includes(d))
    const r: NotifyResult = { delivered: [], queued: [], pushed: [] }
    for (const id of ids) {
      const live = [...this.sessions.values()].filter((s) => s.deviceId === id)
      if (live.length) {
        for (const s of live) this.out(s, { t: 'ev', ch: 'server:notify', args: [payload] })
        r.delivered.push(id)
        // A phone with the tab open in the background still gets a push.
        if (!live.some((s) => s.visible) && this.push?.has(id)) { void this.push.send(id, payload); r.pushed.push(id) }
        continue
      }
      if (this.push?.has(id)) { void this.push.send(id, payload); r.pushed.push(id) }
      const q = this.offline.get(id) ?? []
      // One per tag (the newest), at most 50 per device.
      const kept = payload.tag ? q.filter((p) => p.tag !== payload.tag) : q
      kept.push(payload)
      this.offline.set(id, kept.slice(-50))
      r.queued.push(id)
    }
    return r
  }

  /** Ends every session of a device (revoked). */
  closeDevice(deviceId: string, reason: string): void {
    for (const s of this.sessions.values()) if (s.deviceId === deviceId) { this.out(s, { t: 'bye', reason }); s.ws.close(4001, reason) }
    this.offline.delete(deviceId)
  }

  list(): Array<Omit<Session, 'ws'>> {
    return [...this.sessions.values()].map(({ ws: _w, ...s }) => s)
  }

  dispose(): void {
    clearInterval(this.beat)
    for (const s of this.sessions.values()) { this.out(s, { t: 'bye', reason: 'server stopping' }); s.ws.close(1001, 'server stopping') }
  }
}
