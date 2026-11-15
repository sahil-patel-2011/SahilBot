import { createHash } from 'node:crypto'
import type { ModelInfo, Settings } from '@shared/types'
import { isLocal, isOllama, keepAliveValue, localDefaults, pinContextWindow, type WireTool } from './client'
import { machine, root } from './models'
import { isAuto, pick } from './router'
import { timer } from './timing'
import { localOff } from '@shared/local-mode'

// Local model warm-up. The first message after launch (or after switching models) otherwise waits for
// Ollama to load the model (seconds to a minute for a big one) and then to read the whole system prompt
// and tool list (often 10k+ tokens). In the background, SahilBot loads the model it expects to use, at
// the exact context size chat requests will ask for (a different num_ctx would load it again), and reads
// the main bot's prompt prefix once so the server has it cached.

export interface LoadedModel {
  name: string
  sizeBytes: number
  /** Ollama 0.11+: the context size it was loaded with. */
  contextLength?: number
}

export interface WarmResult {
  status: 'warmed' | 'skipped'
  model?: string
  reason?: string
  numCtx?: number
  ms?: number
}

/** Warm-up runs in the real app only: not in tests or hidden (automation) runs. */
export function warmupAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return !env.VITEST && env.NODE_ENV !== 'test' && !env.SAHILBOT_HIDDEN
}

const sameModel = (a: string, b: string): boolean => a === b || a.replace(/:latest$/, '') === b.replace(/:latest$/, '')

/** Models Ollama has in memory right now (undefined when it can't say). */
export async function loadedModels(baseUrl: string, signal?: AbortSignal): Promise<LoadedModel[] | undefined> {
  try {
    const r = await fetch(`${root(baseUrl)}/api/ps`, { signal: signal ?? AbortSignal.timeout(2000) })
    if (!r.ok) return undefined
    const j = (await r.json()) as { models?: Array<{ name?: string; model?: string; size?: number; context_length?: number }> }
    return (j.models ?? []).map((m) => ({ name: m.name ?? m.model ?? '', sizeBytes: m.size ?? 0, contextLength: m.context_length }))
  } catch {
    return undefined
  }
}

/**
 * The local model to warm: the chosen default when it's a local model; with Auto, the model used most
 * recently (if it's still usable here), else what Auto would pick for everyday tasks. Only Ollama
 * models that fit this Mac.
 */
export function warmTarget(o: { usable: ModelInfo[]; defaultModel: string; recent?: string; explicit?: string }): ModelInfo | undefined {
  const local = o.usable.filter((m) => m.installed && m.note !== 'remote' && m.note !== 'added by you' && (m.fits || m.maxFittingWindow >= 16384))
  const want = o.explicit && !isAuto(o.explicit) ? o.explicit : !isAuto(o.defaultModel) ? o.defaultModel : undefined
  if (want) return local.find((m) => sameModel(m.id, want))
  const recent = o.recent ? local.find((m) => sameModel(m.id, o.recent!)) : undefined
  return recent ?? pick(local, 2)
}

/**
 * True when loading `target` would put a second large model in memory, or overflow what the GPU may
 * use, next to models already loaded: then SahilBot leaves memory to what the user is running.
 */
export function crowds(target: ModelInfo, loaded: LoadedModel[], budgetGB: number): boolean {
  const GB = 1024 ** 3
  const others = loaded.filter((l) => !sameModel(l.name, target.id))
  if (!others.length) return false
  const need = target.requiredGB || (target.sizeBytes ?? 0) / GB
  const used = others.reduce((n, l) => n + l.sizeBytes / GB, 0)
  const large = (gb: number): boolean => gb >= budgetGB * 0.3
  return (large(need) && others.some((l) => large(l.sizeBytes / GB))) || need + used > budgetGB
}

/** The model most recently used for a reply (from the database). */
export function lastUsedModel(db: { sql: { prepare(q: string): { get(...a: unknown[]): unknown } } }): string | undefined {
  try {
    const row = db.sql.prepare(`SELECT json_extract(data, '$.model') AS m FROM messages WHERE role = 'assistant' AND json_extract(data, '$.model') IS NOT NULL ORDER BY rowid DESC LIMIT 1`).get() as { m?: string } | undefined
    return row?.m || undefined
  } catch {
    return undefined
  }
}

export interface WarmupDeps {
  endpoints: { last: { models: ModelInfo[] } | null; list(): Promise<unknown>; usable(): ModelInfo[]; for(model: string): { baseUrl: string } }
  settings: { get(): Pick<Settings, 'defaultModel' | 'contextWindow' | 'localKeepAlive' | 'local'> }
  /** The window chat requests use for this model (the agent's fitWindow). */
  fitWindow(model: string, window: number): number
  recentModel?(): string | undefined
  /** The main bot's system prompt and tool list, to read into the server's cache. */
  prefix?(window?: number): { system: string; tools: WireTool[] } | undefined
  /** Free GPU memory budget in GB (defaults to this Mac's). */
  budgetGB?(): number
  /** A chat is running: don't reload its model or push its prompt out of the server's cache. */
  busy?(): boolean
}

export class Warmup {
  private chain: Promise<unknown> = Promise.resolve()
  /** What was last read into the cache per model (model, window and prompt), so it isn't redone. */
  private primed = new Map<string, string>()
  private ctrl?: AbortController

  constructor(private d: WarmupDeps) {}

  /** Warm in the background (errors are ignored); one warm-up at a time. */
  soon(model?: string): void {
    this.chain = this.chain.then(() => this.run(model)).catch(() => undefined)
  }

  /** Stops a warm-up in progress (a real request is about to start anyway). */
  cancel(): void {
    this.ctrl?.abort()
  }

  async run(model?: string): Promise<WarmResult> {
    const t = timer('warmup')
    const res = await this.warm(model).catch((e: Error) => ({ status: 'skipped' as const, reason: e.message }))
    t.end({ ...res })
    return { ...res, ms: Math.round(t.elapsed()) }
  }

  private async warm(explicit?: string): Promise<WarmResult> {
    if (this.d.busy?.()) return { status: 'skipped', reason: 'a chat is running' }
    const s = this.d.settings.get()
    // Local models are off (the default until the user opts in): never load one.
    if (localOff(s)) return { status: 'skipped', reason: 'local models are off' }
    if (!this.d.endpoints.last) await this.d.endpoints.list()
    const target = warmTarget({ usable: this.d.endpoints.usable(), defaultModel: s.defaultModel, recent: this.d.recentModel?.(), explicit })
    if (!target) return { status: 'skipped', reason: 'no local model to warm' }
    const { baseUrl } = this.d.endpoints.for(target.id)
    if (!isLocal(baseUrl) || !(await isOllama(baseUrl))) return { status: 'skipped', model: target.id, reason: 'not an Ollama model' }
    const numCtx = this.d.fitWindow(target.id, s.contextWindow || 131072)
    const keepAlive = s.localKeepAlive || localDefaults.keepAlive
    localDefaults.keepAlive = keepAlive

    const loaded = await loadedModels(baseUrl)
    const mine = loaded?.find((l) => sameModel(l.name, target.id))
    if (loaded && !mine && crowds(target, loaded, this.d.budgetGB?.() ?? machine().budgetGB)) {
      return { status: 'skipped', model: target.id, reason: 'another large model is loaded' }
    }
    this.ctrl = new AbortController()
    const signal = AbortSignal.any([this.ctrl.signal, AbortSignal.timeout(180_000)])
    const opts = { num_ctx: numCtx }
    const loadedRight = !!mine && (mine.contextLength === undefined || mine.contextLength === numCtx)
    if (!loadedRight) {
      // An empty prompt only loads the model (at this context size) and sets how long it stays.
      const r = await fetch(`${root(baseUrl)}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: target.id, prompt: '', keep_alive: keepAliveValue(keepAlive), options: opts }), signal })
      if (!r.ok) return { status: 'skipped', model: target.id, reason: `load failed (${r.status})` }
      await r.text()
    }
    // Chat requests to this model use this window (the same one the agent computes for it).
    pinContextWindow(baseUrl, target.id, numCtx)

    // Read the main bot's prompt prefix into the server's cache: a new chat then starts right away.
    const prefix = this.d.busy?.() ? undefined : this.d.prefix?.(numCtx)
    if (prefix) {
      const key = createHash('sha1').update(`${numCtx}\n${prefix.system}\n${JSON.stringify(prefix.tools)}`).digest('hex')
      if (this.primed.get(target.id) !== key || !loadedRight) {
        const r = await fetch(`${root(baseUrl)}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: target.id, messages: [{ role: 'system', content: prefix.system }], tools: prefix.tools.length ? prefix.tools : undefined, stream: false, keep_alive: keepAliveValue(keepAlive), options: { ...opts, num_predict: 1 } }),
          signal
        })
        if (r.ok) {
          await r.text()
          this.primed.set(target.id, key)
        }
      }
    }
    return { status: 'warmed', model: target.id, numCtx, reason: loadedRight ? 'already loaded' : undefined }
  }
}
