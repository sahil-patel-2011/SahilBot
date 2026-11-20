import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import type { ModelInfo, Tier } from '@shared/types'
import type { ChatgptPlanStatus, PlanLimitWindow, PlanModelEntry } from '@shared/chatgpt-plan'
import { openaiInfo, openaiRank } from '../openai-models'
import { codexEnv, codexVersion, run, findCodex, loginStatus, userMcpServers, type LoginMode, type McpServerOff } from './detect'
import { CODEX_INSTALL_URL, PLAN_DEFAULT, PLAN_PROVIDER, PLAN_PROVIDER_NAME, isPlanModel, planModelId } from './ids'
import { AppServer } from './rpc'

// The ChatGPT plan provider's state: whether Codex is installed and signed in with ChatGPT, the models
// Codex offers that plan, its usage limits, and the user's two choices (on/off, "use my plan first").
// Everything comes from Codex's documented commands and app-server methods; nothing reads Codex's
// credential files. See docs/chatgpt-plan.md.

interface Prefs {
  enabled: boolean
  preferPlan: boolean
  codexPath?: string
}

interface CodexModel {
  id?: string
  model?: string
  displayName?: string
  hidden?: boolean
  isDefault?: boolean
  supportedReasoningEfforts?: Array<string | { reasoningEffort?: string; effort?: string }>
  inputModalities?: string[]
}

/** Codex's rate-limit snapshot (account/rateLimits/read, account/rateLimits/updated). */
export interface RateLimitSnapshot {
  limitId?: string
  limitName?: string
  primary?: { usedPercent?: number; windowDurationMins?: number; resetsAt?: number } | null
  secondary?: { usedPercent?: number; windowDurationMins?: number; resetsAt?: number } | null
  rateLimitReachedType?: string | null
}

export const windowLabel = (mins?: number): string => {
  if (!mins) return 'Usage limit'
  if (mins >= 10_000 && mins <= 10_200) return 'Weekly limit'
  if (mins % 1440 === 0) return `${mins / 1440}-day limit`
  if (mins % 60 === 0) return `${mins / 60}-hour limit`
  return `${mins}-minute limit`
}

/** Codex reports resetsAt in Unix seconds; accept milliseconds too. */
const toMs = (t?: number): number | undefined => (typeof t === 'number' && t > 0 ? (t < 1e12 ? t * 1000 : t) : undefined)

export function limitWindows(rl: RateLimitSnapshot | undefined): PlanLimitWindow[] {
  if (!rl) return []
  const out: PlanLimitWindow[] = []
  for (const w of [rl.primary, rl.secondary]) {
    if (!w || typeof w.usedPercent !== 'number') continue
    out.push({ usedPercent: Math.max(0, Math.min(100, w.usedPercent)), windowMins: w.windowDurationMins, resetsAt: toMs(w.resetsAt), label: windowLabel(w.windowDurationMins) })
  }
  return out
}

/** Efforts a Codex model takes, as plain strings. */
export function effortsOf(m: CodexModel): string[] {
  return (m.supportedReasoningEfforts ?? []).map((e) => (typeof e === 'string' ? e : e.reasoningEffort ?? e.effort ?? '')).filter(Boolean)
}

export interface PlanHooks {
  /** Open a URL in the user's browser (Electron shell.openExternal). */
  openExternal(url: string): void | Promise<void>
  /** Something changed worth refreshing Settings and the model list for. */
  changed?(): void
}

export class ChatgptPlan {
  private dir = ''
  private version = '0.0.0'
  private hooks: PlanHooks = { openExternal: () => undefined }
  private p: Prefs = { enabled: false, preferPlan: false }
  private bin?: string
  private ver?: string
  private login: LoginMode | 'unknown' = 'unknown'
  private loginText?: string
  private email?: string
  private planType?: string
  private codexModels: CodexModel[] = []
  private windows = new Map<string, number>()
  private rate?: RateLimitSnapshot
  private limitedUntil?: number
  private limitMessage?: string
  private problem?: string
  private checkedAt = 0
  private refreshing: Promise<ChatgptPlanStatus> | null = null
  /** Bumped by reset(): a check still running from before doesn't write its results. */
  private gen = 0
  private signIn: AppServer | null = null
  private userServers: McpServerOff[] = []

  configure(o: { dir: string; version?: string; hooks?: PlanHooks }): void {
    this.dir = o.dir
    if (o.version) this.version = o.version
    if (o.hooks) this.hooks = o.hooks
    this.p = this.load()
  }

  get appVersion(): string {
    return this.version
  }

  get workDir(): string {
    return this.dir
  }

  private file(): string {
    return join(this.dir, 'chatgpt-plan.json')
  }

  private load(): Prefs {
    try {
      const j = JSON.parse(readFileSync(this.file(), 'utf8')) as Partial<Prefs>
      return { enabled: !!j.enabled, preferPlan: !!j.preferPlan, ...(typeof j.codexPath === 'string' && j.codexPath ? { codexPath: j.codexPath } : {}) }
    } catch {
      return { enabled: false, preferPlan: false }
    }
  }

  private save(): void {
    if (!this.dir) return
    try {
      mkdirSync(this.dir, { recursive: true })
      writeFileSync(this.file(), JSON.stringify(this.p, null, 2))
    } catch { /* prefs are a convenience */ }
  }

  prefs(): Readonly<Prefs> {
    return this.p
  }

  setPrefs(patch: { enabled?: boolean; preferPlan?: boolean; codexPath?: string | null }): void {
    if (patch.enabled !== undefined) this.p.enabled = patch.enabled
    if (patch.preferPlan !== undefined) this.p.preferPlan = patch.preferPlan
    if (patch.codexPath !== undefined) {
      if (patch.codexPath) this.p.codexPath = patch.codexPath
      else delete this.p.codexPath
      this.checkedAt = 0
    }
    this.save()
    this.hooks.changed?.()
  }

  /** The codex executable found by the last check. */
  codexBin(): string | undefined {
    return this.bin
  }

  /** User MCP servers to switch off in SahilBot's runs (from the last check). */
  disabledServers(): McpServerOff[] {
    return this.userServers
  }

  /** Ready to run plan models. */
  connected(): boolean {
    return this.p.enabled && !!this.bin && this.login === 'chatgpt'
  }

  /** Codex said the plan's limit is reached, and the reset time hasn't passed. */
  limited(now = Date.now()): boolean {
    if (this.limitedUntil === undefined) return false
    if (now >= this.limitedUntil) { this.limitedUntil = undefined; this.limitMessage = undefined; return false }
    return true
  }

  /** Plan models may be used right now (connected and not over the limit). */
  available(): boolean {
    return this.connected() && !this.limited()
  }

  /** GPT work skips the pay-per-token OpenAI API while the plan can take it. */
  prefersPlan(): boolean {
    return this.p.preferPlan && this.available()
  }

  /** The limit was hit: plan models sit out of Auto until the reset (or an hour when Codex doesn't say). */
  markLimited(message: string, resetsAt?: number): void {
    const reset = toMs(resetsAt) ?? this.nextReset() ?? Date.now() + 60 * 60_000
    this.limitedUntil = reset
    this.limitMessage = message
    this.hooks.changed?.()
  }

  private nextReset(): number | undefined {
    // The window that's full (or the furthest one when none says 100%).
    const ws = limitWindows(this.rate).filter((w) => w.resetsAt)
    const full = ws.filter((w) => w.usedPercent >= 100)
    const pick = (full.length ? full : ws).sort((a, b) => (b.resetsAt ?? 0) - (a.resetsAt ?? 0))[0]
    return pick?.resetsAt
  }

  updateRateLimits(rl: unknown): void {
    if (!rl || typeof rl !== 'object') return
    const next = rl as RateLimitSnapshot
    this.rate = { ...this.rate, ...next, primary: next.primary ?? this.rate?.primary, secondary: next.secondary ?? this.rate?.secondary }
    this.hooks.changed?.()
  }

  /** Codex said it's no longer signed in. */
  markSignedOut(text?: string): void {
    this.login = 'none'
    if (text) this.loginText = text
    this.hooks.changed?.()
  }

  /** Default reasoning efforts per Codex model (for mapping SahilBot's thinking levels). */
  effortsFor(codexId: string | undefined): string[] {
    const m = this.codexModels.find((x) => (x.model ?? x.id) === codexId) ?? this.codexModels.find((x) => x.isDefault)
    return m ? effortsOf(m) : []
  }

  status(): ChatgptPlanStatus {
    const problem = this.problem ?? (!this.bin ? 'Codex isn\'t installed on this Mac.'
      : this.login === 'apikey' || this.login === 'accesstoken' ? 'Codex is signed in with an API key or access token, which bills per token, not your ChatGPT plan. Sign in with ChatGPT instead.'
      : this.login === 'none' ? 'Codex isn\'t signed in. Sign in with ChatGPT to use your plan.' : undefined)
    return {
      enabled: this.p.enabled,
      preferPlan: this.p.preferPlan,
      installed: !!this.bin,
      path: this.bin,
      version: this.ver,
      login: this.login,
      loginText: this.loginText,
      email: this.email,
      planType: this.planType,
      connected: this.connected(),
      signingIn: !!this.signIn && !this.signIn.exited,
      models: this.entries(),
      limits: limitWindows(this.rate),
      limitedUntil: this.limited() ? this.limitedUntil : undefined,
      limitMessage: this.limited() ? this.limitMessage : undefined,
      problem,
      checkedAt: this.checkedAt,
      installUrl: CODEX_INSTALL_URL
    }
  }

  private entries(): PlanModelEntry[] {
    const list = this.codexModels.filter((m) => !m.hidden && (m.model ?? m.id))
    if (!list.length) return [{ id: PLAN_DEFAULT, label: 'Codex default', isDefault: true }]
    return list.map((m) => {
      const codexId = (m.model ?? m.id)!
      return { id: planModelId(codexId), codexId, label: m.displayName || openaiInfo(codexId)?.label || codexId, ...(m.isDefault ? { isDefault: true } : {}) }
    })
  }

  windowFor(id?: string): number | undefined {
    const entry = id || this.codexModels.find((m) => m.isDefault)?.model
    return entry ? this.windows.get(entry) : undefined
  }

  /** The plan's models for the model list (only when connected and cloud models are allowed). */
  models(): ModelInfo[] {
    if (!this.connected()) return []
    return this.entries().map((e) => {
      const info = e.codexId ? openaiInfo(e.codexId) : undefined
      const cm = this.codexModels.find((m) => (m.model ?? m.id) === e.codexId)
      return {
        id: e.id,
        provider: PLAN_PROVIDER,
        providerName: PLAN_PROVIDER_NAME,
        enabled: true,
        installed: true,
        label: `${e.label} · ChatGPT plan`,
        blurb: 'Runs through Codex on your ChatGPT plan: uses the plan\'s limits, no API charges. SahilBot\'s tools and approvals still apply.',
        tier: (info?.tier ?? 3) as Tier,
        rank: (e.codexId ? openaiRank(e.codexId) : undefined) ?? 0,
        vision: cm?.inputModalities ? cm.inputModalities.includes('image') : true,
        tools: true,
        requiredGB: 0,
        maxFittingWindow: this.windowFor(e.codexId) ?? 131072,
        fits: true,
        note: 'remote',
        contextTokens: this.windowFor(e.codexId) ?? 272_000,
        ...(info?.maxOutput ? { maxOutputTokens: info.maxOutput } : {}),
        price: { input: 0, output: 0 }
      } satisfies ModelInfo
    })
  }

  /** May Auto (Endpoints.usable) use this model now? Plan models need the plan; OpenAI API models step aside on "plan first". */
  allows(m: Pick<ModelInfo, 'id' | 'provider'>): boolean {
    if (isPlanModel(m.id) || m.provider === PLAN_PROVIDER) return this.available()
    if (m.provider === 'openai' && this.prefersPlan()) return false
    return true
  }

  /** A fresh check when the last is older than maxAgeMs (shared by concurrent callers). */
  async refreshIfStale(maxAgeMs = 5 * 60_000): Promise<ChatgptPlanStatus> {
    if (Date.now() - this.checkedAt < maxAgeMs) return this.status()
    return this.refresh()
  }

  refresh(): Promise<ChatgptPlanStatus> {
    this.refreshing ??= this.check().finally(() => { this.refreshing = null })
    return this.refreshing
  }

  private async check(): Promise<ChatgptPlanStatus> {
    const gen = this.gen
    // Results are written only if no reset() happened meanwhile.
    const commit = (f: () => void): void => { if (gen === this.gen) f() }
    try {
      const bin = await findCodex(this.p.codexPath)
      if (!bin) {
        commit(() => { this.bin = this.ver = undefined; this.login = 'unknown'; this.problem = undefined })
        return this.status()
      }
      const ver = await codexVersion(bin).catch(() => undefined)
      const st = await loginStatus(bin)
      let acct: Awaited<ReturnType<ChatgptPlan['readAccount']>> | undefined
      let problem: string | undefined
      let servers: McpServerOff[] = []
      const windows = new Map<string, number>()
      if (st.mode === 'chatgpt') {
        acct = await this.readAccount(bin).catch((e: Error) => { problem = `Couldn't read your plan from Codex: ${e.message}`; return undefined })
        // The CLI and API can give the same model different limits. Read the installed CLI's catalog.
        const raw = await run(bin, ['debug', 'models'], { timeoutMs: 8000 })
        if (!raw.code) try {
          for (const row of JSON.parse(raw.stdout).models ?? []) {
            const cap = row.max_context_window ?? row.context_window
            if (typeof row.slug === 'string' && Number.isSafeInteger(cap) && cap > 0) windows.set(row.slug, cap)
          }
        } catch { /* Older CLI. Use the conservative plan window. */ }
        servers = await userMcpServers(bin).catch(() => [])
      }
      commit(() => {
        this.bin = bin
        this.ver = ver
        this.login = acct?.login ?? st.mode
        this.loginText = st.text
        this.problem = problem
        this.userServers = servers
        this.windows = windows
        if (acct) {
          this.email = acct.email
          this.planType = acct.planType
          if (acct.rate) this.rate = acct.rate
          if (acct.models?.length) this.codexModels = acct.models
        }
      })
    } catch (e) {
      commit(() => { this.problem = `Couldn't check Codex: ${(e as Error).message}` })
    } finally {
      commit(() => { this.checkedAt = Date.now() })
      this.hooks.changed?.()
    }
    return this.status()
  }

  /** account/read, account/rateLimits/read and model/list from a short-lived app-server. */
  private async readAccount(bin: string): Promise<{ login?: LoginMode; email?: string; planType?: string; rate?: RateLimitSnapshot; models?: CodexModel[] }> {
    const srv = new AppServer({ bin, args: ['app-server'], env: codexEnv(bin) })
    const out: { login?: LoginMode; email?: string; planType?: string; rate?: RateLimitSnapshot; models?: CodexModel[] } = {}
    try {
      await srv.initialize(this.version)
      const acct = await srv.request<{ account?: { type?: string; email?: string | null; planType?: string | null } | null; requiresOpenaiAuth?: boolean }>('account/read', {}, 15_000).catch(() => undefined)
      if (acct?.account) {
        if (acct.account.type && acct.account.type !== 'chatgpt') out.login = acct.account.type === 'apiKey' ? 'apikey' : 'accesstoken'
        out.email = acct.account.email ?? undefined
        out.planType = acct.account.planType ?? undefined
      } else if (acct && acct.account === null) {
        out.login = 'none'
      }
      const rl = await srv.request<{ rateLimits?: RateLimitSnapshot }>('account/rateLimits/read', {}, 15_000).catch(() => undefined)
      if (rl?.rateLimits) out.rate = rl.rateLimits
      const seen = new Set<string>()
      let cursor: string | null = null
      do {
        type Page = { data?: CodexModel[]; nextCursor?: string }
        const ml: Page | undefined = await srv.request<Page>('model/list', cursor ? { cursor } : {}, 15_000).catch(() => undefined)
        if (ml?.data?.length) (out.models ??= []).push(...ml.data)
        cursor = ml?.nextCursor ?? null
        if (!cursor || seen.has(cursor)) break
        seen.add(cursor)
      } while (true)
      return out
    } finally {
      srv.close()
    }
  }

  /**
   * Turns the provider on. Signed in with ChatGPT already: done. Otherwise Codex's own sign-in starts
   * (app-server account/login/start, type "chatgpt"): OpenAI's page opens in the browser, Codex receives
   * the result and stores it its own way, and SahilBot only waits for the "completed" notification.
   */
  async connect(o: { signIn?: boolean } = {}): Promise<ChatgptPlanStatus> {
    if (o.signIn) {
      this.setPrefs({ enabled: true })
      if (!this.bin) await this.refresh()
      if (this.bin) await this.startSignIn()
      return this.status()
    }
    this.setPrefs({ enabled: true })
    const st = await this.refresh()
    // Signed in with an API key: switching Codex to ChatGPT is the user's call (the button, or Terminal).
    if (!st.installed || st.login === 'chatgpt' || st.login === 'apikey' || st.login === 'accesstoken') return st
    await this.startSignIn()
    return this.status()
  }

  private async startSignIn(): Promise<void> {
    if (this.signIn && !this.signIn.exited) return
    const srv = new AppServer({
      bin: this.bin!, args: ['app-server'], env: codexEnv(this.bin!),
      onNotification: (method, params) => {
        if (method !== 'account/login/completed') return
        const p = (params ?? {}) as { success?: boolean; error?: string | null }
        if (!p.success && p.error) this.problem = `Sign-in didn't finish: ${p.error}`
        this.signIn = null
        srv.close()
        void this.refresh()
      },
      onExit: () => { if (this.signIn === srv) { this.signIn = null; this.hooks.changed?.() } }
    })
    this.signIn = srv
    try {
      await srv.initialize(this.version)
      const r = await srv.request<{ type?: string; authUrl?: string; loginId?: string }>('account/login/start', { type: 'chatgpt' }, 30_000)
      if (!r?.authUrl || !/^https:\/\//i.test(r.authUrl)) throw new Error('Codex didn\'t return a sign-in page.')
      await this.hooks.openExternal(r.authUrl)
      // Give up waiting after 10 minutes (the user can start again).
      setTimeout(() => { if (this.signIn === srv) { this.signIn = null; srv.close(); this.hooks.changed?.() } }, 10 * 60_000).unref?.()
      this.hooks.changed?.()
    } catch (e) {
      this.signIn = null
      srv.close()
      this.problem = `Couldn't start Codex's sign-in: ${(e as Error).message}. Try "Sign in in Terminal".`
      this.hooks.changed?.()
    }
  }

  /** Opens Terminal running `codex login` (a .command file, so no Automation permission is needed). */
  async loginInTerminal(): Promise<{ ok: boolean; error?: string }> {
    if (!this.bin) await this.refresh()
    if (!this.bin) return { ok: false, error: 'Codex isn\'t installed.' }
    if (process.platform !== 'darwin') return { ok: false, error: 'Run "codex login" in a terminal.' }
    const f = join(this.dir || '/tmp', 'codex-login.command')
    const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
    try {
      mkdirSync(this.dir, { recursive: true })
      writeFileSync(f, `#!/bin/zsh -l\n# Opened by SahilBot: OpenAI's own Codex sign-in. SahilBot never sees your credentials.\n${q(this.bin)} login\necho\necho "Done. You can close this window and go back to SahilBot."\n`)
      chmodSync(f, 0o700)
      await new Promise<void>((ok, fail) => execFile('/usr/bin/open', ['-a', 'Terminal', f], (err) => (err ? fail(err) : ok())))
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }

  disconnect(): void {
    this.setPrefs({ enabled: false })
    if (this.signIn) { this.signIn.close(); this.signIn = null }
  }

  /** For tests. */
  reset(): void {
    this.p = { enabled: false, preferPlan: false }
    this.bin = this.ver = this.loginText = this.email = this.planType = this.limitedUntil = this.limitMessage = this.problem = undefined
    this.login = 'unknown'
    this.codexModels = []
    this.rate = undefined
    this.checkedAt = 0
    this.userServers = []
    this.refreshing = null
    this.gen++
    if (this.signIn) { this.signIn.kill(); this.signIn = null }
  }

  exists(): boolean {
    return !!this.dir && existsSync(this.file())
  }
}

/** The app's one instance (configured in index.ts; tests configure their own directory). */
export const chatgptPlan = new ChatgptPlan()
