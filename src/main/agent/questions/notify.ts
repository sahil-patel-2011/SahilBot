import { canNotifyDevices, notifyDevices as toDevices } from '../../notify'

// Paired devices (SahilBot Server on an always-on machine, reached from a phone): questions, approvals and
// digests go through the server's notify(deviceIds, payload) hook (src/main/notify.ts). In the Mac app no
// notifier is set and nothing is sent. Bodies are already safe for a lock screen (needs-you.ts), never
// arguments or secrets.

export interface DeviceNotifyPayload {
  kind: 'question' | 'approval' | 'digest' | 'update'
  title: string
  body: string
  botId: string
  threadId?: string
  /** The Needs-you item (questions and approvals): the device's notification is replaced, not stacked. */
  itemId?: string
}

export const hasDeviceNotifier = (): boolean => canNotifyDevices()

/** Best effort: a failing device or server never affects the bot. */
export function notifyDevices(p: DeviceNotifyPayload, deviceIds: string[] | 'all' = 'all'): void {
  try {
    toDevices(deviceIds, {
      title: p.title, body: p.body, ...(p.threadId ? { threadId: p.threadId } : {}),
      tag: p.itemId ? `needs-you:${p.itemId}` : p.kind === 'digest' ? `digest:${p.botId}` : undefined,
      kind: p.kind === 'question' ? 'question' : p.kind === 'approval' ? 'needs-you' : p.kind === 'digest' ? 'routine' : 'info'
    })
  } catch { /* never fails the caller */ }
}
