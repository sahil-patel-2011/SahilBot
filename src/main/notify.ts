// Notifications to the user's paired devices (phones, laptops) when SahilBot runs as an always-on server.
//
// Anything in the main process may call notifyDevices(): approvals and questions waiting, a routine's
// result, a long run finishing. On SahilBot Server it reaches every paired browser that's connected (an
// in-page notification), keeps the rest for when they reconnect, and sends Web Push where a device turned
// it on. In the Mac app no notifier is set and it does nothing (the app shows its own macOS notifications).

export interface NotifyPayload {
  title: string
  body?: string
  /** The chat to open when it's clicked. */
  threadId?: string
  /** Replaces an earlier notification with the same tag on the device. */
  tag?: string
  kind?: 'needs-you' | 'question' | 'done' | 'error' | 'routine' | 'info'
}

export interface NotifyResult {
  /** Devices with the app open right now. */
  delivered: string[]
  /** Devices offline now: shown when they reconnect. */
  queued: string[]
  /** Devices reached by Web Push. */
  pushed: string[]
}

type Notifier = (deviceIds: string[] | 'all', payload: NotifyPayload) => NotifyResult

let notifier: Notifier | null = null

/** Set by the server (src/server/boot.ts). */
export function setDeviceNotifier(fn: Notifier | null): void {
  notifier = fn
}

/** Whether paired devices can be notified (true on SahilBot Server). */
export function canNotifyDevices(): boolean {
  return !!notifier
}

/** Notifies paired devices ('all' = every active one). No-op in the Mac app. */
export function notifyDevices(deviceIds: string[] | 'all', payload: NotifyPayload): NotifyResult {
  if (!notifier) return { delivered: [], queued: [], pushed: [] }
  try { return notifier(deviceIds, { ...payload, title: String(payload.title).slice(0, 120), body: payload.body?.slice(0, 300) }) } catch { return { delivered: [], queued: [], pushed: [] } }
}
