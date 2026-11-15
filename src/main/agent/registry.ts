import type { Tier } from '@shared/types'
import type { WireTool } from '../llm/client'
import type { ThreadState, ToolDef } from './types'
import { toolUnavailable } from '../runtime'

/**
 * The tool set for a chat (conversation, questions, lookups): web search, page reading, memory, and
 * find_tools, which loads a connected app's tools (the chat keeps going) or any work tool (the run turns into
 * agent work from the next step: see escalate). These lead the full list too, in this order.
 */
export const CHAT_TOOLS = ['find_tools', 'web_search', 'fetch_page', 'memory'] as const
const CHAT = new Set<string>(CHAT_TOOLS)
/** Older name of the chat tool set. */
export const QUICK_TOOLS = CHAT_TOOLS

/**
 * Small windows (registry chooseProfile): the built-in tools listed up front. Everything else (propose_plan,
 * review_document, cursor, mac_apps, agents, schedule, message_bot…) is one find_tools call away, and stays
 * listed once loaded. 'tiny' keeps fewer still, for when even 'small' leaves too little room.
 */
export const SMALL_TOOLS = ['find_tools', 'web_search', 'fetch_page', 'memory', 'ask_user', 'todo', 'notes', 'file_read', 'file_write', 'file_manage', 'run_command', 'create_document', 'browser'] as const
export const TINY_TOOLS = ['find_tools', 'web_search', 'fetch_page', 'memory', 'ask_user', 'todo', 'file_read', 'file_write', 'run_command'] as const
const SMALL = new Set<string>(SMALL_TOOLS)
const TINY = new Set<string>(TINY_TOOLS)

export type ToolProfile = 'small' | 'tiny'
/** Windows up to this size (local models on 16-32K Macs) start on the 'small' profile. */
export const SMALL_WINDOW = 32768
/** The most of the input budget (window minus the reply's room) the system prompt and tools may take. */
export const FIXED_SHARE = 0.4
/**
 * Above SMALL_WINDOW: the full agent set may take up to half the input budget. On a 64K local window that
 * keeps every tool (documents, plans, team, schedule…) and still leaves ~30K for the conversation, which
 * compaction now keeps intact (notes and brief survive); a slimmer set there cost more than it saved.
 */
export const FIXED_SHARE_LARGE = 0.5

/** A chat thread (the older 'quick' mode counts as one). */
export const chatMode = (state: Pick<ThreadState, 'toolMode'>): boolean => state.toolMode === 'chat' || state.toolMode === 'quick'

/** A connected app's tool (MCP): marked, or registered by Connectors with an "[App] …" description and its group. */
export const isConnectorTool = (t: ToolDef): boolean =>
  t.connector === true || (!t.core && !!t.group && t.description.startsWith(`[${t.group}]`))

/**
 * Tools a chat may use without turning into agent work: the chat set, connected apps' tools (their own
 * permissions still apply), and read-only lookups that aren't always listed (read_result, research, stock
 * quotes, knowledge_search…). Anything else (files, the browser, the screen, code, documents, plans) is work.
 */
export const chatAllowed = (t: ToolDef): boolean => CHAT.has(t.name) || (!t.core && (isConnectorTool(t) || t.effect === 'read'))

/**
 * The profile for a window: windows up to SMALL_WINDOW start slim; any window steps down while the system
 * prompt and tools (`fixedFor`, in tokens) would take more than FIXED_SHARE (FIXED_SHARE_LARGE above SMALL_WINDOW) of the input budget. Big cloud
 * windows stay on the full set. `floor` keeps a run from stepping back up mid-run (the prefix stays put).
 */
export function chooseProfile(window: number, input: number, fixedFor: (p: ToolProfile | undefined) => number, floor?: ToolProfile): ToolProfile | undefined {
  const order: Array<ToolProfile | undefined> = window <= SMALL_WINDOW ? ['small', 'tiny'] : [undefined, 'small', 'tiny']
  const start = floor ? order.indexOf(floor) : 0
  const share = window <= SMALL_WINDOW ? FIXED_SHARE : FIXED_SHARE_LARGE
  for (const p of order.slice(Math.max(0, start))) if (fixedFor(p) <= share * input) return p
  return 'tiny'
}

/**
 * Whether a run may use the chat path: the request reads as a chat (intent classifyTask), in a chat that has
 * only been chat so far, with no plan in progress, not a helper, routine, group or intro run. Anything else
 * runs the full agent. 'full' is for good: the prompt and tool list stay the same from then on.
 */
export function chatEligible(o: {
  chat: boolean
  state: Pick<ThreadState, 'toolMode' | 'todos' | 'depth'>
  helper?: boolean
  unattended?: boolean
  group?: boolean
  /** False when the chat already has replies: a chat from before the chat path counts as full. */
  newChat?: boolean
}): boolean {
  if (!o.chat || o.helper || o.unattended || o.group) return false
  if (o.state.toolMode === 'full' || o.state.depth) return false
  if (o.state.toolMode === undefined && o.newChat === false) return false
  return !o.state.todos.some((t) => t.status !== 'done')
}

/**
 * Older selection rule, kept for callers that size small talk by its router tier: small talk (tier 0) on a
 * local model with no plan, team, deep research or plan-first request.
 */
export function quickEligible(o: {
  tier?: Tier
  local: boolean
  state: Pick<ThreadState, 'toolMode' | 'todos' | 'depth' | 'loaded'>
  flags?: Record<string, unknown>
  helper?: boolean
  unattended?: boolean
  group?: boolean
  newChat?: boolean
}): boolean {
  if (o.tier !== 0 || !o.local) return false
  const f = o.flags ?? {}
  if (f.team || f.deepResearch || f.planFirst || o.state.loaded.length) return false
  return chatEligible({ chat: true, state: o.state, helper: o.helper, unattended: o.unattended, group: o.group, newChat: o.newChat })
}

/** Sets the thread's tool mode for a new run. 'full' is for good. */
export function chooseToolMode(state: ThreadState, chat: boolean): 'chat' | 'full' {
  state.toolMode = chat && state.toolMode !== 'full' ? 'chat' : 'full'
  return state.toolMode
}

// ---------------------------------------------------------------------------------------------------
// Compact schemas for small windows: the same tools and parameters (names, types, enums, required), with a
// short description and short parameter notes. Arguments are still checked against the full schema (validate.ts).
// ---------------------------------------------------------------------------------------------------

/** Whole sentences up to `max` characters (a word-boundary cut with "…" when the first one is longer). */
export function shortText(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  // A sentence ends at . ! or ? before a capital letter, a bracket or the end ("e.g. this" doesn't end one).
  let end = -1
  for (const m of clean.matchAll(/[.!?](?=\s+[A-Z(["'\u201c]|$)/g)) {
    if ((m.index ?? 0) + 1 > max) break
    end = (m.index ?? 0) + 1
  }
  if (end >= Math.min(40, max / 2)) return clean.slice(0, end)
  const cut = clean.slice(0, max - 1)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max / 2)).replace(/[\s,;:(]+$/, '')}…`
}

/** Keys that only explain or constrain conditionally (the app still validates with the full schema). */
const DROP = new Set(['examples', 'default', 'allOf', 'if', 'then', 'else', '$comment', 'title', 'deprecated'])

/** The JSON type of a schema node, for a collapsed optional structure. */
const typeOf = (n: Record<string, unknown>): unknown => n.type ?? (n.properties ? 'object' : n.items ? 'array' : undefined)

/**
 * `depth`: how deep in the parameters this node is (the tool's parameters are 0). Optional structures below
 * the top level collapse to their type (and a short note): the shape of an optional table column format or
 * chart series is looked up when needed (a wrong guess gets a precise repair message from validate.ts).
 */
function compactNode(node: unknown, required: boolean, depth = 0): unknown {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node
  const n = node as Record<string, unknown>
  const nested = !!n.properties || (!!n.items && typeof n.items === 'object' && !!((n.items as Record<string, unknown>).properties || (n.items as Record<string, unknown>).items || (n.items as Record<string, unknown>).anyOf))
  if (!required && depth >= 2 && (nested || n.anyOf || n.oneOf)) {
    const t = typeOf(n)
    return { ...(t ? { type: t } : {}), ...(typeof n.description === 'string' && n.description.trim() ? { description: shortText(n.description, 40) } : {}) }
  }
  const out: Record<string, unknown> = {}
  const req = new Set(Array.isArray(n.required) ? (n.required as string[]) : [])
  for (const [k, v] of Object.entries(n)) {
    if (DROP.has(k)) continue
    if (k === 'description') {
      // Required parameters keep a short note; optional ones only a very short one (their name says the rest).
      if (typeof v === 'string' && v.trim()) out.description = shortText(v, required ? 72 : 40)
      continue
    }
    if (k === 'properties' && v && typeof v === 'object') {
      out.properties = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([name, p]) => [name, compactNode(p, req.has(name), depth + 1)]))
    } else if (k === 'items') out.items = compactNode(v, required, depth + 1)
    else if ((k === 'anyOf' || k === 'oneOf') && Array.isArray(v)) out[k] = v.map((x) => compactNode(x, required, depth + 1))
    else out[k] = v
  }
  return out
}

/** One tool as a compact wire tool: the first sentence or two of its description and short parameter notes. */
export function compactWire(t: Pick<ToolDef, 'name' | 'description' | 'parameters'>): WireTool {
  return { type: 'function', function: { name: t.name, description: shortText(t.description, 200), parameters: compactNode(t.parameters, true) as Record<string, unknown> } }
}

export class ToolRegistry {
  private tools = new Map<string, ToolDef>()

  register(...defs: ToolDef[]): void {
    // SahilBot Server leaves out tools that need a Mac screen or Electron's browser (src/main/runtime.ts).
    for (const d of defs) if (!toolUnavailable(d.name)) this.tools.set(d.name, d)
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

  /** Core tools: the chat set first (fixed order), then the rest in registration order. */
  core(): ToolDef[] {
    const core = this.all().filter((t) => t.core)
    const chat = CHAT_TOOLS.map((n) => core.find((t) => t.name === n)).filter((t): t is ToolDef => !!t)
    return [...chat, ...core.filter((t) => !CHAT.has(t.name))]
  }

  /** The built-in tools listed up front for this thread's mode and profile. */
  private visible(state: ThreadState): ToolDef[] {
    const core = this.core()
    if (chatMode(state)) return core.filter((t) => CHAT.has(t.name))
    if (state.toolProfile === 'tiny') return core.filter((t) => TINY.has(t.name))
    if (state.toolProfile === 'small') return core.filter((t) => SMALL.has(t.name))
    return core
  }

  /**
   * The thread's tools: the built-in ones its mode and profile list (the chat set first, then registration
   * order), then everything it loaded, in load order (connector tools, on-demand tools, and built-in ones a
   * chat or a small window loaded). No cap: the list only ever grows at the end, so the cached prompt prefix
   * stays valid.
   */
  listFor(state: ThreadState): ToolDef[] {
    const visible = this.visible(state)
    const seen = new Set(visible.map((t) => t.name))
    const loaded = state.loaded.map((n) => this.tools.get(n)).filter((t): t is ToolDef => !!t && !seen.has(t.name))
    // Swarm helpers and council members: only their allowed tools (state.toolAllow).
    return [...visible, ...loaded].filter((t) => (!t.available || t.available(state)) && (!state.toolAllow || state.toolAllow.includes(t.name)))
  }

  /** In this thread's tool list right now. */
  listed(state: ThreadState, name: string): boolean {
    return this.listFor(state).some((t) => t.name === name)
  }

  /**
   * A chat that needs more than chat: every tool from the next step on. True when a call (or a tool the
   * chat loaded) is work, not a lookup (see chatAllowed). Unknown names don't count.
   */
  escalate(state: ThreadState, calledNames: string[]): boolean {
    if (!chatMode(state)) return false
    const work = (n: string): boolean => { const t = this.tools.get(n); return !!t && !chatAllowed(t) }
    if (!calledNames.some(work) && !state.loaded.some(work)) return false
    state.toolMode = 'full'
    return true
  }

  search(query: string, state: ThreadState): Array<{ name: string; description: string; loaded: boolean; score: number }> {
    const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1)
    // Built-in tools that this thread's mode or profile doesn't list can be found (and loaded) too.
    const listed = new Set(this.listFor(state).map((t) => t.name))
    return this.all()
      .filter((t) => !t.core || !listed.has(t.name))
      .map((t) => {
        const hay = `${t.name} ${t.group ?? ''} ${t.description}`.toLowerCase()
        const score = words.reduce((n, w) => n + (hay.includes(w) ? (t.name.includes(w) || (t.group ?? '').toLowerCase().includes(w) ? 3 : 1) : 0), 0)
        return { name: t.name, description: t.description, loaded: listed.has(t.name), score }
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      // Only strong matches: a tool that merely mentions the word ("notes" in a long description) isn't loaded
      // next to the app's own tools.
      .filter((r, _i, all) => r.score * 2 >= all[0].score)
  }

  /**
   * Appends tools to the thread's set. Returns names actually added. A built-in tool the thread doesn't list
   * yet (a chat, or a small window) is added too; in a chat, a work tool turns the thread into agent work.
   */
  load(state: ThreadState, names: string[]): string[] {
    const added: string[] = []
    for (const n of names) {
      const t = this.tools.get(n)
      if (!t || this.listed(state, n) || state.loaded.includes(n) || (state.toolAllow && !state.toolAllow.includes(n))) continue
      state.loaded.push(n)
      added.push(n)
      if (chatMode(state) && !chatAllowed(t)) state.toolMode = 'full'
    }
    return added
  }

  /** Wire format; `compact` for small windows (compactWire). */
  wire(list: ToolDef[], o: { compact?: boolean } = {}): WireTool[] {
    return list.map((t) => (o.compact ? compactWire(t) : { type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
  }
}
