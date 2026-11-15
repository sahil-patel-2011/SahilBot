// `electron` for the preload script when SahilBot runs in a browser (SahilBot Server's web UI). The
// preload (src/preload/index.ts) is built unchanged against this: ipcRenderer travels over the server's
// WebSocket, contextBridge puts the API on window. So the browser gets exactly the Mac app's window.foreman.

import { decode, encode, type ClientMsg, type ServerMsg } from '../codec'

type Listener = (event: unknown, ...args: unknown[]) => void

const listeners = new Map<string, Set<Listener>>()
const pending = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void; ch: string }>()
let ws: WebSocket | null = null
let nextId = 1
let queue: string[] = []
let open = false
let everOpened = false
let downSince = 0
let retry = 1000
const status = { connected: false, device: null as null | { id: string; name: string }, version: '' }

/** foreman-file://local/… (files the app serves to its own window) → the same file through the server. */
function rewrite(v: unknown, depth = 0): unknown {
  if (depth > 40) return v
  if (typeof v === 'string') return v.startsWith('foreman-file://local/') ? `${location.origin}/foreman-file/local/${v.slice('foreman-file://local/'.length)}` : v
  if (Array.isArray(v)) return v.map((x) => rewrite(x, depth + 1))
  if (v && typeof v === 'object' && !(v instanceof Uint8Array) && !(v instanceof Float32Array) && !(v instanceof Date)) {
    const o: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) o[k] = rewrite(x, depth + 1)
    return o
  }
  return v
}

/** Delivers an event to the page's listeners (also used for events made here, like a notification click). */
export function emitLocal(ch: string, ...args: unknown[]): void {
  for (const fn of [...(listeners.get(ch) ?? [])]) {
    try { fn({ sender: null }, ...args) } catch (e) { console.error(`[sahilbot] ${ch} listener:`, e) }
  }
}

function out(msg: ClientMsg): void {
  const text = encode(msg)
  if (ws && open) ws.send(text)
  else if (msg.t === 'call' || msg.t === 'send') queue.push(text)
}

function focusState(): void {
  out({ t: 'focus', focused: document.hasFocus(), visible: document.visibilityState === 'visible' })
}

function banner(text: string | null): void {
  let el = document.getElementById('sb-server-banner')
  if (!text) { el?.remove(); return }
  if (!el) {
    el = document.createElement('div')
    el.id = 'sb-server-banner'
    el.setAttribute('role', 'status')
    el.style.cssText = 'position:fixed;left:50%;top:10px;transform:translateX(-50%);z-index:2147483647;background:#1f1f1f;color:#fff;font:500 13px/1.3 -apple-system,system-ui,sans-serif;padding:8px 14px;border-radius:999px;box-shadow:0 4px 18px rgba(0,0,0,.25);pointer-events:none'
    document.documentElement.appendChild(el)
  }
  el.textContent = text
}

async function signedIn(): Promise<boolean> {
  try { return (await fetch('/api/session', { credentials: 'same-origin' })).status !== 401 } catch { return true }
}

function connect(): void {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
  const sock = new WebSocket(url)
  ws = sock
  sock.onopen = () => {
    open = true
    retry = 1000
    const q = queue
    queue = []
    for (const t of q) sock.send(t)
    focusState()
  }
  sock.onmessage = (m) => {
    let msg: ServerMsg
    try { msg = decode<ServerMsg>(String(m.data)) } catch { return }
    if (msg.t === 'ret') {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if (msg.ok) p.ok(rewrite(msg.v))
      else p.fail(new Error(msg.e))
    } else if (msg.t === 'ev') emitLocal(msg.ch, ...(rewrite(msg.args) as unknown[]))
    else if (msg.t === 'hello') {
      status.connected = true
      status.device = msg.device
      status.version = msg.version
      banner(null)
      // Back after a real outage: events were missed, so the app starts over from the server's state.
      if (everOpened && downSince && Date.now() - downSince > 1500) location.reload()
      everOpened = true
      downSince = 0
      window.dispatchEvent(new CustomEvent('sahilbot:server', { detail: { ...status } }))
    } else if (msg.t === 'bye') {
      banner(msg.reason === 'server stopping' ? 'SahilBot Server is restarting…' : `Signed out: ${msg.reason}`)
    }
  }
  sock.onclose = async (e) => {
    open = false
    status.connected = false
    if (!downSince) downSince = Date.now()
    for (const [id, p] of pending) { pending.delete(id); p.fail(new Error(`Error invoking remote method '${p.ch}': Error: Lost the connection to SahilBot Server. Try again.`)) }
    window.dispatchEvent(new CustomEvent('sahilbot:server', { detail: { ...status } }))
    if (e.code === 4001 || !(await signedIn())) { location.replace('/pair'); return }
    banner('Reconnecting to SahilBot Server…')
    setTimeout(connect, retry)
    retry = Math.min(10_000, retry * 1.7)
  }
}

if (typeof window !== 'undefined' && typeof WebSocket !== 'undefined') {
  connect()
  document.addEventListener('visibilitychange', focusState)
  window.addEventListener('focus', focusState)
  window.addEventListener('blur', focusState)
  setInterval(() => { if (open) out({ t: 'ping' }) }, 20_000)
}

export const serverStatus = status

export const ipcRenderer = {
  invoke(ch: string, ...args: unknown[]): Promise<unknown> {
    return new Promise((ok, fail) => {
      const id = nextId++
      pending.set(id, { ok, fail, ch })
      out({ t: 'call', id, ch, args })
    })
  },
  send(ch: string, ...args: unknown[]): void { out({ t: 'send', ch, args }) },
  sendSync(): never { throw new Error('sendSync is not available in the browser.') },
  postMessage(): void { /* not used */ },
  on(ch: string, fn: Listener) {
    const set = listeners.get(ch) ?? new Set()
    set.add(fn)
    listeners.set(ch, set)
    return ipcRenderer
  },
  once(ch: string, fn: Listener) {
    const w: Listener = (e, ...a) => { ipcRenderer.removeListener(ch, w); fn(e, ...a) }
    return ipcRenderer.on(ch, w)
  },
  removeListener(ch: string, fn: Listener) { listeners.get(ch)?.delete(fn); return ipcRenderer },
  off(ch: string, fn: Listener) { return ipcRenderer.removeListener(ch, fn) },
  removeAllListeners(ch?: string) { if (ch) listeners.delete(ch); else listeners.clear(); return ipcRenderer }
}

export const contextBridge = {
  exposeInMainWorld(key: string, api: unknown): void {
    ;(window as unknown as Record<string, unknown>)[key] = api
  }
}

/** Dropped files have no path in a browser: the preload then sends their bytes instead. */
export const webUtils = { getPathForFile: (): string => '' }
export const webFrame = { setZoomFactor: (): void => undefined, getZoomFactor: (): number => 1, setVisualZoomLevelLimits: (): Promise<void> => Promise.resolve() }

export default { ipcRenderer, contextBridge, webUtils, webFrame }
