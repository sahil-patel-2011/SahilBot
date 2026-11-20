// The app's request/response channels and its events, independent of how they travel.
//
// Handlers are registered once (registerHandler) and events go out once (broadcast). Transports attach as
// adapters: in the Mac app, Electron IPC (rpc-electron.ts) carries them to the window; on SahilBot Server,
// a WebSocket hub (src/server/hub.ts) carries them to paired browsers. Neither side of a handler knows which.

/** Who is calling: the transport, plus what it knows about the caller (never trusted for auth on its own). */
export interface RpcContext {
  transport: 'electron' | 'ws' | 'worker' | 'test'
  /** Electron: the sending WebContents. */
  sender?: unknown
  /** Electron: the sending frame. */
  senderFrame?: unknown
  /** WebSocket: the paired device that made the call. */
  deviceId?: string
  /** WebSocket: the connection (one device may have several tabs). */
  sessionId?: string
}

export type RpcHandler = (ctx: RpcContext, ...args: unknown[]) => unknown

export interface RpcAdapter {
  /** A channel became available (also called for every channel registered before the adapter attached). */
  onRegister?(channel: string): void
  onUnregister?(channel: string): void
  /** An event for the UI. */
  send?(event: string, args: unknown[]): void
}

const handlers = new Map<string, RpcHandler>()
const adapters = new Set<RpcAdapter>()

export class RpcError extends Error {
  constructor(message: string, readonly code: 'unknown-channel' | 'denied' | 'handler' = 'handler') {
    super(message)
    this.name = 'RpcError'
  }
}

/** Registers a channel's handler. A channel has one handler: registering it again replaces it. */
export function registerHandler(channel: string, fn: RpcHandler): void {
  const had = handlers.has(channel)
  handlers.set(channel, fn)
  if (had) for (const a of adapters) a.onUnregister?.(channel)
  for (const a of adapters) a.onRegister?.(channel)
}

export function unregisterHandler(channel: string): void {
  if (!handlers.delete(channel)) return
  for (const a of adapters) a.onUnregister?.(channel)
}

export function hasHandler(channel: string): boolean {
  return handlers.has(channel)
}

export function channels(): string[] {
  return [...handlers.keys()]
}

/** Runs a channel's handler. Unknown channels reject (like Electron's "No handler registered"). */
export async function invoke(channel: string, ctx: RpcContext, args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel)
  if (!fn) throw new RpcError(`No handler registered for '${channel}'`, 'unknown-channel')
  return await fn(ctx, ...args)
}

/** Sends an event to every attached transport (each decides which of its clients get it). */
export function broadcast(event: string, ...args: unknown[]): void {
  for (const a of adapters) {
    try { a.send?.(event, args) } catch (e) { console.error(`[rpc] ${event}:`, (e as Error).message) }
  }
}

/** Attaches a transport; returns a function that detaches it. */
export function addAdapter(a: RpcAdapter): () => void {
  adapters.add(a)
  for (const ch of handlers.keys()) a.onRegister?.(ch)
  return () => {
    if (!adapters.delete(a)) return
    for (const ch of handlers.keys()) a.onUnregister?.(ch)
  }
}

/** Tests only: forget every handler and adapter. */
export function resetRpc(): void {
  handlers.clear()
  adapters.clear()
}
