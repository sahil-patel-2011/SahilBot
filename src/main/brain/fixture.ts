import { readFileSync } from 'node:fs'
import type { ConnectorIO } from './sources'

// Hidden tests and screenshots only (dev builds): fake connected apps for the brain, from a JSON file named
// by SAHILBOT_BRAIN_FIXTURE. Each preset says whether it's connected, which tools its server offers, and
// what each tool answers (a list answers in turn, its last answer repeating). Never used by a release build.

interface FixturePreset { state?: 'connected' | 'needs_auth' | 'absent'; tools?: string[]; calls?: Record<string, string | string[] | unknown> }

export function fixtureConnectors(file: string): ConnectorIO & { calls: Array<{ preset: string; tool: string; args: Record<string, unknown> }> } {
  const data = JSON.parse(readFileSync(file, 'utf8')) as { presets?: Record<string, FixturePreset> }
  const presets = data.presets ?? {}
  const turn = new Map<string, number>()
  const calls: Array<{ preset: string; tool: string; args: Record<string, unknown> }> = []
  return {
    calls,
    state: (p) => presets[p]?.state ?? 'absent',
    tools: (p) => (presets[p]?.state === 'connected' ? presets[p]?.tools ?? Object.keys(presets[p]?.calls ?? {}) : []),
    async call(p, tool, args) {
      calls.push({ preset: p, tool, args })
      const x = presets[p]
      if (x?.state !== 'connected') throw new Error(`${p} is not connected`)
      let ans = x.calls?.[tool]
      if (ans === undefined) throw new Error(`${p} has no ${tool} tool`)
      // { byArg: "threadId", answers: { "<id>": … } }: the answer for that argument's value.
      const keyed = ans as { byArg?: string; answers?: Record<string, unknown> }
      if (keyed && typeof keyed === 'object' && !Array.isArray(keyed) && typeof keyed.byArg === 'string') ans = keyed.answers?.[String(args[keyed.byArg])] ?? '{}'
      const list = Array.isArray(ans) ? ans : [ans]
      const n = turn.get(`${p}:${tool}`) ?? 0
      turn.set(`${p}:${tool}`, n + 1)
      const v = list[Math.min(n, list.length - 1)]
      return typeof v === 'string' ? v : JSON.stringify(v)
    }
  }
}
