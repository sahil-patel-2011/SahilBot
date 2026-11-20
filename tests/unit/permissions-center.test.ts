import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { NotificationPermission, SETTINGS_URL, automationError, automationStatus, fullDiskState, permissionsStatus, settingsUrl, type Probes } from '../../src/main/permissions-center'

const probes = (o: Partial<Probes> = {}): Probes => ({
  accessibility: () => true,
  media: (k) => (k === 'screen' ? 'denied' : 'not-determined'),
  notificationsSupported: () => true,
  open: () => 'missing',
  home: '/Users/me',
  ...o
})

describe('permissions center', () => {
  test('status rows with plain explanations and exact panes', () => {
    const rows = permissionsStatus(probes({ open: (p) => (p.endsWith('TCC.db') ? 'denied' : 'missing') }))
    expect(rows.map((r) => [r.kind, r.state])).toEqual([
      ['accessibility', 'granted'], ['screen', 'denied'], ['microphone', 'not-determined'], ['fullDisk', 'denied'], ['automation', 'unknown'], ['notifications', 'unknown']
    ])
    expect(rows[0].settingsUrl).toBe('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
    expect(rows[1].settingsUrl).toMatch(/Privacy_ScreenCapture$/)
    expect(rows[3].settingsUrl).toMatch(/Privacy_AllFiles$/)
    expect(rows[4].settingsUrl).toMatch(/Privacy_Automation$/)
    for (const r of rows) expect(r.enables.length).toBeGreaterThan(20)
  })
  test('a probe that throws reads as unknown, never as granted', () => {
    const rows = permissionsStatus(probes({ accessibility: () => { throw new Error('x') }, media: () => 'weird' }))
    expect(rows[0].state).toBe('unknown')
    expect(rows[1].state).toBe('unknown')
  })
  test('full disk access from protected files', () => {
    expect(fullDiskState({ home: '/h', open: () => 'missing' })).toBe('unknown')
    expect(fullDiskState({ home: '/h', open: (p) => (p.includes('Safari') ? 'ok' : 'missing') })).toBe('granted')
    expect(fullDiskState({ home: '/h', open: () => 'denied' })).toBe('denied')
  })
  test('automation per app, from osascript\'s answer', async () => {
    expect(automationError('execution error: Not authorized to send Apple events to Notes. (-1743)')).toBe('denied')
    expect(automationError('(-1744)')).toBe('not-determined')
    expect(await automationStatus('Notes', async () => ({ out: 'ok\n', err: '' }))).toEqual({ app: 'Notes', state: 'granted' })
    expect((await automationStatus('Mail', async () => ({ out: 'not running\n', err: '' }))).state).toBe('unknown')
    expect((await automationStatus('Mail', async () => ({ out: '', err: 'Not authorized to send Apple events (-1743)' }))).state).toBe('denied')
  })
  test('notifications: "Turn on" waits for macOS and remembers its answer, which the status then shows', async () => {
    type L = (event: unknown, error: string) => void
    const fake = (outcome?: 'show' | 'failed') => {
      const on: Record<string, L[]> = {}
      return {
        on(event: string, listener: L) { (on[event] ??= []).push(listener); return this },
        show() { if (outcome) setTimeout(() => on[outcome]?.forEach((l) => l({}, 'Notifications are not allowed')), 5) },
        fire(event: string) { on[event]?.forEach((l) => l({}, 'x')) }
      }
    }
    const file = join(mkdtempSync(join(tmpdir(), 'sahilbot-notes-')), 'notification-permission.json')
    const perm = new NotificationPermission(file)
    expect(perm.get()).toBe('unknown')
    expect(await perm.request(fake('show'))).toBe('granted')
    const status = () => permissionsStatus(probes({ notifications: () => perm.get() })).find((r) => r.kind === 'notifications')!
    expect(status().state).toBe('granted')
    // Remembered across restarts.
    expect(new NotificationPermission(file).get()).toBe('granted')
    // The user turned them off in System Settings: the next notification fails, and the status says so.
    perm.observe(fake('failed'))
    const later = fake()
    perm.observe(later)
    later.fire('failed')
    expect(status()).toMatchObject({ state: 'denied', detail: expect.stringMatching(/System Settings → Notifications/) })
    expect(await perm.request(fake('failed'))).toBe('denied')
    // macOS's question is still open: report it, and record the answer when it comes.
    const open = fake()
    expect(await perm.request(open, 20)).toBe('prompted')
    open.fire('show')
    expect(perm.get()).toBe('granted')
    // Unsupported here: restricted, whatever was recorded.
    expect(permissionsStatus(probes({ notificationsSupported: () => false, notifications: () => 'granted' })).find((r) => r.kind === 'notifications')!.state).toBe('restricted')
  })
  test('only the known panes can be opened', () => {
    expect(settingsUrl('microphone')).toBe(SETTINGS_URL.microphone)
    expect(() => settingsUrl('https://evil.example')).toThrow(/Unknown permission/)
  })
})
