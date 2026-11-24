// A reply that says a Mac permission is missing ("turn on SahilBot in System Settings → Privacy & Security →
// Accessibility") gets a button that opens that exact switch, so nobody has to hunt through System Settings.

export type AskedPermission = 'accessibility' | 'screen' | 'automation'

export function permissionAsked(text: string): AskedPermission | undefined {
  if (!text || !/\b(turn on|enable|allow|grant|needs?|blocked|permission|switch on)\b/i.test(text)) return undefined
  if (/\bAccessibility\b/.test(text)) return 'accessibility'
  if (/\bScreen (Recording|& System Audio Recording)\b/i.test(text)) return 'screen'
  if (/\bAutomation\b/.test(text) && /Privacy & Security|System Settings/i.test(text)) return 'automation'
  return undefined
}

export const PERMISSION_BUTTON: Record<AskedPermission, string> = {
  accessibility: 'Open Accessibility settings',
  screen: 'Open Screen Recording settings',
  automation: 'Open Automation settings'
}

/** The bits of window.api.permissions the button uses (tests pass a fake). */
export interface PermissionsApi {
  request(kind: AskedPermission): Promise<'granted' | 'denied' | 'prompted' | 'opened'>
  open(kind: AskedPermission): Promise<void>
}

/**
 * The one-tap button: asks for the permission (that puts SahilBot in the list; macOS shows its own prompt only the
 * very first time) and opens the pane on that list whenever no window of its own came up, so the tap always lands
 * on the switch.
 */
export async function openPermission(api: PermissionsApi, kind: AskedPermission): Promise<void> {
  try {
    const r = await api.request(kind)
    if (r === 'prompted') await api.open(kind)
  } catch {
    await api.open(kind).catch(() => undefined)
  }
}
