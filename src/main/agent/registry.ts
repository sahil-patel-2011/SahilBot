import type { WireTool } from '../llm/client'
import type { ThreadState, ToolDef } from './types'


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

  core(): ToolDef[] {
    return this.all().filter((t) => t.core)
  }

  /**
   * Built-in tools first in registration order, then connector tools in load order. No cap: the list
   * only ever grows at the end, so the cached prompt prefix stays valid.
   */
  listFor(state: ThreadState): ToolDef[] {
    const loaded = state.loaded.map((n) => this.tools.get(n)).filter((t): t is ToolDef => !!t && !t.core)
    return [...this.core(), ...loaded].filter((t) => !t.available || t.available(state))
  }

  search(query: string, state: ThreadState): Array<{ name: string; description: string; loaded: boolean; score: number }> {
    const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1)
    return this.all()
      .filter((t) => !t.core)
      .map((t) => {
        const hay = `${t.name} ${t.group ?? ''} ${t.description}`.toLowerCase()
        const score = words.reduce((n, w) => n + (hay.includes(w) ? (t.name.includes(w) || (t.group ?? '').toLowerCase().includes(w) ? 3 : 1) : 0), 0)
        return { name: t.name, description: t.description, loaded: state.loaded.includes(t.name), score }
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
  }

  /** Appends tools to the thread's set. Returns names actually added. */
  load(state: ThreadState, names: string[]): string[] {
    const added: string[] = []
    for (const n of names) {
      const t = this.tools.get(n)
      if (!t || t.core || state.loaded.includes(n)) continue
      state.loaded.push(n)
      added.push(n)
    }
    return added
  }

  wire(list: ToolDef[]): WireTool[] {
    return list.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
  }
}
