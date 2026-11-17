import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

// Working with the lid closed (Settings → General → Routines, off by default). macOS sleeps on lid close
// whatever assertion an app holds (IOPMLib.h: "The system may still sleep for lid close"), so the only way is
// `pmset -a disablesleep 1`, which needs root. Turning the setting on asks macOS for an administrator once and
// installs a sudoers rule that allows exactly two commands: `pmset -a disablesleep 1` and `... 0`. Nothing else.
//
// While on: sleep is disabled while any chat, bot or routine is working and for GRACE_MS after the last one
// finishes (a follow-up, a check, a retry), then restored. It is never held below LOW_BATTERY on battery (a
// closed Mac in a bag), and a watchdog restores sleep if the app quits or crashes while holding it. A marker
// file remembers a hold across a crash, so the next launch restores sleep first.

export const PMSET = '/usr/bin/pmset'
export const SUDOERS = '/etc/sudoers.d/sahilbot-lid-awake'
export const GRACE_MS = 5 * 60_000
export const LOW_BATTERY = 20

export interface Power { onBattery: boolean; percent: number | null }

export type Run = (cmd: string, args: string[]) => Promise<{ code: number; out: string }>

export const run: Run = (cmd, args) => new Promise((resolve) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  p.stdout.on('data', (b: Buffer) => { out += b })
  p.stderr.on('data', (b: Buffer) => { out += b })
  p.on('error', (e) => resolve({ code: -1, out: e.message }))
  p.on('close', (code) => resolve({ code: code ?? -1, out }))
})

/** `pmset -g batt`: "Now drawing from 'AC Power'" / "… 35%; discharging". */
export function parseBattery(text: string): Power {
  const pct = text.match(/(\d{1,3})%/)
  return { onBattery: /'Battery Power'/.test(text), percent: pct ? Number(pct[1]) : null }
}

/** The sudoers rule: this user, root, no password, exactly the two pmset commands. */
export function sudoersRule(user: string): string {
  if (!/^[a-z_][a-z0-9_.-]{0,63}$/i.test(user)) throw new Error('Unexpected user name.')
  return `${user} ALL=(root) NOPASSWD: ${PMSET} -a disablesleep 1, ${PMSET} -a disablesleep 0\n`
}

/** The admin prompt's shell command: write the rule to a temp file, check it with visudo, then install it. */
export function installScript(user: string): string {
  const rule = sudoersRule(user)
  const tmp = `/tmp/sahilbot-lid-awake.${process.pid}`
  return `umask 077 && printf '%s' '${rule.replace(/'/g, '')}' > ${tmp} && /usr/sbin/visudo -cf ${tmp} && /usr/sbin/chown root:wheel ${tmp} && /bin/chmod 440 ${tmp} && /bin/mv ${tmp} ${SUDOERS}`
}

/** Whether the Mac should be held awake with the lid closed right now. */
export function wantLidAwake(o: { setting: boolean; working: number; lastWorkAt: number; now: number; power: Power }): boolean {
  if (!o.setting) return false
  if (o.power.onBattery && (o.power.percent ?? 100) < LOW_BATTERY) return false
  return o.working > 0 || o.now - o.lastWorkAt < GRACE_MS
}

export class LidAwake {
  private holding = false
  private lastWorkAt = 0
  private wasWorking = 0
  private timer?: ReturnType<typeof setTimeout>
  private watchdog?: ReturnType<typeof spawn>
  private busy: Promise<void> = Promise.resolve()

  constructor(private d: {
    marker: string; user: string; pid: number
    setting: () => boolean; working: () => number
    run?: Run; now?: () => number; power?: () => Promise<Power>
    platform?: NodeJS.Platform
  }) {}

  private get exec(): Run { return this.d.run ?? run }
  private now(): number { return (this.d.now ?? Date.now)() }

  get on(): boolean { return this.holding }

  /** The admin rule is installed (sudo would run pmset without a password). */
  async granted(): Promise<boolean> {
    if ((this.d.platform ?? process.platform) !== 'darwin') return false
    return (await this.exec('/usr/bin/sudo', ['-n', '-l', PMSET, '-a', 'disablesleep', '1'])).code === 0
  }

  /** Asks macOS for an administrator once and installs the rule. Throws with a plain reason when it can't. */
  async grant(): Promise<void> {
    if ((this.d.platform ?? process.platform) !== 'darwin') throw new Error('Working with the lid closed is only for Macs.')
    if (await this.granted()) return
    const script = installScript(this.d.user).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const r = await this.exec('/usr/bin/osascript', ['-e', `do shell script "${script}" with administrator privileges with prompt "SahilBot needs an administrator once so it can keep working while the lid is closed (it can only turn the Mac's sleep off and back on)."`])
    if (r.code !== 0) {
      if (/-128|User canceled/i.test(r.out)) throw new Error('Cancelled: nothing was changed.')
      throw new Error('macOS needs an administrator account for this. Ask an admin of this Mac to turn it on, or leave it off (the Mac then sleeps when the lid closes).')
    }
    if (!(await this.granted())) throw new Error('The permission didn\'t take. Nothing was changed.')
  }

  /** At launch: a hold left over from a crash is released first. */
  async recover(): Promise<void> {
    if (existsSync(this.d.marker)) await this.release()
  }

  /** Re-evaluates the hold (work started or stopped, the setting changed, the battery fell). */
  refresh(): Promise<void> {
    this.busy = this.busy.then(() => this.apply()).catch(() => undefined)
    return this.busy
  }

  private async apply(): Promise<void> {
    if ((this.d.platform ?? process.platform) !== 'darwin') return
    const working = this.d.working()
    // The grace period counts from when the last chat stopped (or now, while one runs).
    if (working > 0 || this.wasWorking > 0) this.lastWorkAt = this.now()
    this.wasWorking = working
    const power = this.d.power ? await this.d.power() : parseBattery((await this.exec(PMSET, ['-g', 'batt'])).out)
    const want = wantLidAwake({ setting: this.d.setting(), working, lastWorkAt: this.lastWorkAt, now: this.now(), power })
    if (want && !this.holding) await this.hold()
    else if (!want && this.holding) await this.release()
    // Check again when the grace period ends, and every minute while holding (the battery).
    if (this.timer) clearTimeout(this.timer)
    if (this.holding) { this.timer = setTimeout(() => void this.refresh(), 60_000); this.timer.unref?.() }
  }

  private async hold(): Promise<void> {
    if ((await this.exec('/usr/bin/sudo', ['-n', PMSET, '-a', 'disablesleep', '1'])).code !== 0) return
    this.holding = true
    try { mkdirSync(dirname(this.d.marker), { recursive: true }); writeFileSync(this.d.marker, String(this.d.pid)) } catch { /* best effort */ }
    // If the app dies while holding, sleep comes back on its own (real runs only, not tests' fake commands).
    if (this.d.run) return
    try {
      this.watchdog = spawn('/bin/sh', ['-c', `while kill -0 ${this.d.pid} 2>/dev/null; do sleep 10; done; /usr/bin/sudo -n ${PMSET} -a disablesleep 0`], { detached: true, stdio: 'ignore' })
      this.watchdog.unref()
    } catch { /* the marker still restores it at the next launch */ }
  }

  async release(): Promise<void> {
    await this.exec('/usr/bin/sudo', ['-n', PMSET, '-a', 'disablesleep', '0'])
    this.holding = false
    try { this.watchdog?.kill() } catch { /* gone */ }
    this.watchdog = undefined
    try { rmSync(this.d.marker, { force: true }) } catch { /* gone */ }
    if (this.timer) clearTimeout(this.timer)
  }
}
