// What the headless Electron stand-in (platform/electron.ts) needs from the running server: where data
// lives, the secrets key, and how to reach the paired browsers. Set by boot.ts before the main process
// code loads.

import { EventEmitter } from 'node:events'
import { ServerSafeStorage } from './secrets'
import type { NotifyPayload, NotifyResult } from '../main/notify'

export type { NotifyPayload, NotifyResult }

export interface UiLink {
  /** Sends an event to every connected browser. */
  send(event: string, args: unknown[]): void
  /** Some browser has the app open and in front. */
  focused(): boolean
  /** Some browser has the app open. */
  connected(): boolean
  /** Notifications to paired devices ('all' = every active device). */
  notify(deviceIds: string[] | 'all', payload: NotifyPayload): NotifyResult
}

const noUi: UiLink = { send: () => undefined, focused: () => false, connected: () => false, notify: () => ({ delivered: [], queued: [], pushed: [] }) }

export const host = {
  dataDir: '',
  version: '0.0.0',
  safeStorage: new ServerSafeStorage(null),
  ui: noUi as UiLink,
  /** ipcMain.on listeners (fire-and-forget messages from the page, e.g. voice frames). */
  sends: new EventEmitter(),
  /** protocol.handle() handlers (foreman-file:), served over HTTP to the paired browsers. */
  protocols: new Map<string, (req: Request) => Response | Promise<Response>>(),
  /** The chat of the chat:event being sent right now (a notification made in the same turn is about it). */
  noteThread: undefined as string | undefined,
  /** app.quit() asks the server to shut down. */
  quit: (): void => undefined,
  ready: false
}
