import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { GRACE_MS, LidAwake, installScript, parseBattery, sudoersRule, wantLidAwake, type Power, type Run } from '../../src/main/lid-awake'

const AC: Power = { onBattery: false, percent: 80 }

describe('working with the lid closed', () => {
  test('held only while something runs and for 5 minutes after; never on a low battery; off by default', () => {
    const at = 1_000_000
    expect(wantLidAwake({ setting: false, working: 3, lastWorkAt: at, now: at, power: AC })).toBe(false)
    expect(wantLidAwake({ setting: true, working: 1, lastWorkAt: at, now: at, power: AC })).toBe(true)
    expect(wantLidAwake({ setting: true, working: 0, lastWorkAt: at, now: at + GRACE_MS - 1, power: AC })).toBe(true)
    expect(wantLidAwake({ setting: true, working: 0, lastWorkAt: at, now: at + GRACE_MS, power: AC })).toBe(false)
    expect(wantLidAwake({ setting: true, working: 1, lastWorkAt: at, now: at, power: { onBattery: true, percent: 19 } })).toBe(false)
    expect(wantLidAwake({ setting: true, working: 1, lastWorkAt: at, now: at, power: { onBattery: true, percent: 50 } })).toBe(true)
  })

  test('the admin rule allows exactly the two pmset commands for this user, and is checked with visudo', () => {
    expect(sudoersRule('sam')).toBe('sam ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 1, /usr/bin/pmset -a disablesleep 0\n')
    expect(() => sudoersRule('sam ALL=(ALL) ALL')).toThrow()
    expect(() => sudoersRule('a;rm -rf /')).toThrow()
    const s = installScript('sam')
    expect(s).toMatch(/visudo -cf .* && .*chmod 440 .* && \/bin\/mv .* \/etc\/sudoers\.d\/sahilbot-lid-awake$/)
  })

  test('battery from pmset -g batt', () => {
    expect(parseBattery("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t35%; discharging;")).toEqual({ onBattery: true, percent: 35 })
    expect(parseBattery("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged;")).toEqual({ onBattery: false, percent: 100 })
  })

  test('holds while working, keeps holding through the grace period after the last chat stops, then restores sleep', async () => {
    const calls: string[] = []
    const exec: Run = async (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { code: 0, out: '' } }
    let working = 1
    let now = 0
    const lid = new LidAwake({ marker: join(mkdtempSync(join(tmpdir(), 'lid-')), 'hold'), user: 'sam', pid: 999999, setting: () => true, working: () => working, run: exec, now: () => now, power: async () => AC, platform: 'darwin' })
    await lid.refresh()
    expect(lid.on).toBe(true)
    expect(calls).toContain('/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 1')
    now = 60 * 60_000 // the run took an hour
    working = 0
    await lid.refresh()
    expect(lid.on).toBe(true) // the grace period counts from when it stopped, not when it started
    now += GRACE_MS + 1
    await lid.refresh()
    expect(lid.on).toBe(false)
    expect(calls.at(-1)).toBe('/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 0')
  })

  test('a hold left by a crash is released at the next launch; without the admin rule nothing is held', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lid-'))
    const marker = join(dir, 'hold')
    writeFileSync(marker, '123')
    const calls: string[] = []
    const lid = new LidAwake({ marker, user: 'sam', pid: 999999, setting: () => true, working: () => 1, run: async (c, a) => { calls.push([c, ...a].join(' ')); return { code: a.includes('1') ? 1 : 0, out: '' } }, power: async () => AC, platform: 'darwin' })
    await lid.recover()
    expect(calls).toContain('/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 0')
    expect(existsSync(marker)).toBe(false)
    await lid.refresh()
    expect(lid.on).toBe(false)
  })

  test('turning it on asks for an administrator once; a cancel or a non-admin account leaves it off with a plain reason', async () => {
    const mk = (osa: { code: number; out: string }, grantedAfter: boolean) => {
      let granted = false
      return new LidAwake({ marker: join(tmpdir(), 'x'), user: 'sam', pid: 1, setting: () => true, working: () => 0, platform: 'darwin', power: async () => AC,
        run: async (cmd) => {
          if (cmd === '/usr/bin/osascript') { if (osa.code === 0 && grantedAfter) granted = true; return osa }
          return { code: granted ? 0 : 1, out: '' }
        } })
    }
    await expect(mk({ code: 0, out: '' }, true).grant()).resolves.toBeUndefined()
    await expect(mk({ code: 1, out: 'execution error: User canceled. (-128)' }, false).grant()).rejects.toThrow(/Cancelled/)
    await expect(mk({ code: 1, out: 'not an administrator' }, false).grant()).rejects.toThrow(/administrator account/)
    await expect(new LidAwake({ marker: 'x', user: 'sam', pid: 1, setting: () => true, working: () => 0, platform: 'linux' }).grant()).rejects.toThrow(/only for Macs/)
  })
})
