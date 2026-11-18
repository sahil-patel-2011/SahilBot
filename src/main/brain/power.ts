import { execFile } from 'node:child_process'

// The Mac's power state for the brain's schedule: on battery, the charge left, and Low Power Mode, from
// `pmset` (read every few minutes, never on every tick). Anything unreadable counts as wall power.

export interface PowerState { onBattery: boolean; percent?: number; lowPower?: boolean }

const run = (args: string[]): Promise<string> => new Promise((ok) => {
  execFile('/usr/bin/pmset', args, { timeout: 3000 }, (e, out) => ok(e ? '' : String(out)))
})

/** "Now drawing from 'Battery Power' … 15%; discharging" and "lowpowermode 1" → the state. */
export function parsePmset(batt: string, settings: string, onBattery?: boolean): PowerState {
  const pct = /(\d{1,3})%/.exec(batt)
  const fromBattery = /Battery Power/i.test(batt) ? true : /AC Power/i.test(batt) ? false : !!onBattery
  const low = /^\s*lowpowermode\s+1\b/im.test(settings)
  return { onBattery: fromBattery, ...(pct ? { percent: Math.min(100, Number(pct[1])) } : {}), ...(low ? { lowPower: true } : {}) }
}

export async function readPower(onBattery: () => boolean): Promise<PowerState> {
  if (process.platform !== 'darwin') return { onBattery: onBattery() }
  const [batt, settings] = await Promise.all([run(['-g', 'batt']), run(['-g'])])
  return parsePmset(batt, settings, onBattery())
}
