import type { Tier } from '@shared/types'
import type { WireTool } from '../llm/client'
import type { ThreadState, ToolDef } from './types'

/**
 * The tool set for small talk on a local model (a fraction of the full list, so the first reply needs far
 * less prompt processing). find_tools stays so the model can load anything else, built-in tools included.
 * These lead the full list too, in this order: the quick list is a prefix of the full one, so moving from
 * quick to full reuses the cached system prompt and these tools.
 */
export const QUICK_TOOLS = ['find_tools', 'web_search', 'fetch_page', 'memory', 'ask_user'] as const
const QUICK = new Set<string>(QUICK_TOOLS)

/**
 * Whether a run may use the quick tool set: small talk (tier 0) on a local model, in a chat that has only
 * had small talk so far, with no plan, team, deep research or plan-first request, not a helper, routine or
 * group run. Anything else gets every tool. Cloud models always get the full list: their prompt cache
 * already covers it, and a different list would miss that cache.
 */
export function quickEligible(o: {
  tier?: Tier
  local: boolean
  state: Pick<ThreadState, 'toolMode' | 'todos' | 'depth' | 'loaded'>
  /** The user message's flags (team, deepResearch, planFirst). */
  flags?: Record<string, unknown>
  helper?: boolean
  unattended?: boolean
  group?: boolean
  /** False when the chat already has replies: a chat from before tool modes existed counts as full. */
  newChat?: boolean
}): boolean {
  if (o.tier !== 0 || !o.local || o.helper || o.unattended || o.group) return false
  if (o.state.toolMode === 'full' || o.state.depth || o.state.loaded.length) return false
  if (o.state.toolMode === undefined && o.newChat === false) return false
  if (o.state.todos.some((t) => t.status !== 'done')) return false
  const f = o.flags ?? {}
  return !f.team && !f.deepResearch && !f.planFirst
}

/** Sets the thread's tool mode for a new run. 'full' is for good. */
export function chooseToolMode(state: ThreadState, quick: boolean): 'quick' | 'full' {
  state.toolMode = quick && state.toolMode !== 'full' ? 'quick' : 'full'
  return state.toolMode
}

export class ToolRegistry {
  private tools = new Map<string, ToolDef>()

  register(...defs: ToolDef[]): void {
    for (const d of defs) this.tools.set(d.name, d)
  }

  unregister(predicate: (t: ToolDef) => boolean): void {
    for (const [k, t] of this.tools) if (predicate(t)) this.tools.delete(k)
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name)
  }

  all(): ToolDef[] {
    return [...this.tools.values()]
  }

  /** Core tools: the quick set first (fixed order), then the rest in registration order. */
  core(): ToolDef[] {
    const core = this.all().filter((t) => t.core)
    const quick = QUICK_TOOLS.map((n) => core.find((t) => t.name === n)).filter((t): t is ToolDef => !!t)
    return [...quick, ...core.filter((t) => !QUICK.has(t.name))]
  }

  /**
   * Built-in tools first (the quick set, then registration order), then connector tools in load order.
   * No cap: the list only ever grows at the end, so the cached prompt prefix stays valid. A thread in
   * quick mode lists only the quick set (plus anything it loaded).
   */
  listFor(state: ThreadState): ToolDef[] {
    const loaded = state.loaded.map((n) => this.tools.get(n)).filter((t): t is ToolDef => !!t && !t.core)
    const core = state.toolMode === 'quick' ? this.core().filter((t) => QUICK.has(t.name)) : this.core()
    return [...core, ...loaded].filter((t) => !t.available || t.available(state))
  }

  /** A quick-mode thread that needs more than small talk: every tool from the next step on. */
  escalate(state: ThreadState, calledNames: string[]): boolean {
    if (state.toolMode !== 'quick') return false
    if (!calledNames.some((n) => n === 'find_tools' || (this.tools.get(n)?.core && !QUICK.has(n)))) return false
    state.toolMode = 'full'
    return true
  }

  search(query: string, state: ThreadState): Array<{ name: string; description: string; loaded: boolean; score: number }> {
    const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1)
    // In quick mode the built-in tools that aren't listed can be found (and loaded) too.
    const hidden = (t: ToolDef): boolean => state.toolMode === 'quick' && !!t.core && !QUICK.has(t.name)
    return this.all()
      .filter((t) => !t.core || hidden(t))
      .map((t) => {
        const hay = `${t.name} ${t.group ?? ''} ${t.description}`.toLowerCase()
        const score = words.reduce((n, w) => n + (hay.includes(w) ? (t.name.includes(w) || (t.group ?? '').toLowerCase().includes(w) ? 3 : 1) : 0), 0)
        return { name: t.name, description: t.description, loaded: !t.core && state.loaded.includes(t.name), score }
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
  }

  /** Appends tools to the thread's set. Returns names actually added. */
  load(state: ThreadState, names: string[]): string[] {
    const added: string[] = []
    const quick = state.toolMode === 'quick'
    for (const n of names) {
      const t = this.tools.get(n)
      if (!t) continue
      // A built-in tool asked for in quick mode: the thread gets every tool.
      if (t.core) {
        if (quick && !QUICK.has(n)) { state.toolMode = 'full'; added.push(n) }
        continue
      }
      if (state.loaded.includes(n)) continue
      state.loaded.push(n)
      added.push(n)
    }
    return added
  }

  wire(list: ToolDef[]): WireTool[] {
    return list.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
  }
}
