import type { ActivitySettings, ActivityStatus, PermissionState } from '@shared/types'
import { activityLines, previewText, TIMELINE_WINDOW_MS, type ActivitySource } from './context'
import { classify, MESSAGING_APPS, normalizeDomain, PASSWORD_MANAGERS, SCRIPTABLE_BROWSERS, SENSITIVE_DOMAINS, type Rules } from './rules'
import { automationError } from '../permissions-center'
import { sampleOnce, SYSTEM_EVENTS_CHECK_JS, type Jxa } from './sampler'
import { ActivityStore, type Session } from './store'

// "Know what I'm working on": on by default (and so is learning from it), with nothing that prompts:
// window titles wait for the user's own permission check (System Events) and browser tabs for each
// browser they allowed; without those only the front app's name is seen. While SahilBot runs and it's
// on (and not paused), one
// look every minute while the Mac is in use (idle under 5 minutes, screen unlocked), plus one shortly
// after the user switches away from SahilBot. Everything stays in this Mac's database; it leaves only
// inside the <context> block of the user's own runs on a local model (a cloud model only with "Also
// share with cloud models", off by default), and to the learning pass unless the user turns that off. What's
// past its retention is pruned on every read too, so nothing older is ever shown or sent.

export const SAMPLE_EVERY_MS = 60_000
export const IDLE_LIMIT_S = 5 * 60
export const SETTINGS_KEY = 'activity:settings'
const PERMS_KEY = 'activity:permissions'

export const DEFAULT_ACTIVITY: ActivitySettings = {
  enabled: true, windowTitles: true, browserTabs: true, learn: true, retentionHours: 24, excludedApps: [], excludedDomains: [], pausedUntil: null, shareWithCloud: false
}

/** Stored settings carry `version` and `explicit` (the keys the user set themselves), for later default changes. */
export const ACTIVITY_SETTINGS_VERSION = 2
const SETTING_KEYS: Array<keyof ActivitySettings> = ['enabled', 'windowTitles', 'browserTabs', 'learn', 'retentionHours', 'excludedApps', 'excludedDomains', 'shareWithCloud']

/**
 * The keys the user set themselves. Version 2 records them; before that, the settings were only ever
 * written by the user's own changes, so every key stored then counts as theirs (kept as stored).
 */
export function activityExplicit(v: unknown): string[] {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return []
  const x = v as Record<string, unknown>
  if (typeof x.version === 'number' && x.version >= ACTIVITY_SETTINGS_VERSION) {
    return Array.isArray(x.explicit) ? SETTING_KEYS.filter((k) => (x.explicit as unknown[]).includes(k)) : []
  }
  return SETTING_KEYS.filter((k) => k in x)
}

const list = (v: unknown, clean: (s: string) => string, max = 100): string[] => {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const x of v) {
    const s = typeof x === 'string' ? clean(x) : ''
    if (s && !out.includes(s) && out.length < max) out.push(s)
  }
  return out
}

/**
 * Settings as saved. Nothing saved yet (or a key never written): the defaults, so on. A value that is
 * there but odd reads as off (enabled, learn and cloud sharing are on only when exactly true); hours 1–72.
 */
export function cleanActivitySettings(v: unknown): ActivitySettings {
  const x = (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Partial<Record<keyof ActivitySettings, unknown>>
  const h = typeof x.retentionHours === 'number' && Number.isFinite(x.retentionHours) ? Math.round(x.retentionHours) : DEFAULT_ACTIVITY.retentionHours
  return {
    enabled: x.enabled === undefined ? DEFAULT_ACTIVITY.enabled : x.enabled === true,
    windowTitles: x.windowTitles !== false,
    browserTabs: x.browserTabs !== false,
    learn: x.learn === undefined ? DEFAULT_ACTIVITY.learn : x.learn === true,
    retentionHours: Math.max(1, Math.min(72, h)),
    excludedApps: list(x.excludedApps, (s) => s.replace(/[\r\n]+/g, ' ').trim().slice(0, 80)),
    excludedDomains: list(x.excludedDomains, normalizeDomain),
    pausedUntil: typeof x.pausedUntil === 'number' && Number.isFinite(x.pausedUntil) ? x.pausedUntil : null,
    shareWithCloud: x.shareWithCloud === true
  }
}

interface StoredPerms { systemEvents: boolean | null; browsers: Array<{ app: string; state: PermissionState; detail?: string }> }

export interface ActivityDeps {
  db: { sql: import('node:sqlite').DatabaseSync; getSetting<T>(key: string): T | undefined; setSetting(key: string, value: unknown): void }
  jxa: Jxa
  accessibility: () => boolean
  /** 'active' | 'idle' | 'locked' | 'unknown' (powerMonitor.getSystemIdleState). */
  idleState: (limitS: number) => string
  /** User-initiated automation check for one app (may show macOS's one-time prompt). */
  automation: (app: string) => Promise<{ app: string; state: PermissionState; detail?: string }>
  now?: () => number
  self?: Rules['self']
  onChange?: () => void
  /** Never look (hidden test runs): settings and the preview still work. */
  noSampling?: boolean
  /** Timers (tests drive tick() themselves). */
  setInterval?: (fn: () => void, ms: number) => unknown
  /** The first look after starting (default: 2 s later). */
  kick?: (fn: () => void) => void
  clearInterval?: (h: unknown) => void
}

export class ActivityService implements ActivitySource {
  readonly store: ActivityStore
  private timer: unknown = null
  private busy = false
  private lastSampleAt: number | null = null
  private soonTimer: ReturnType<typeof setTimeout> | null = null
  private lastSoon = 0

  constructor(private d: ActivityDeps) {
    this.store = new ActivityStore(d.db)
  }

  private now(): number { return this.d.now ? this.d.now() : Date.now() }

  settings(): ActivitySettings {
    return cleanActivitySettings(this.d.db.getSetting(SETTINGS_KEY))
  }

  /** The keys the user set themselves (see activityExplicit). */
  explicitChoices(): string[] { return activityExplicit(this.d.db.getSetting(SETTINGS_KEY)) }

  private save(next: ActivitySettings, touched: string[] = []): void {
    const explicit = new Set([...this.explicitChoices(), ...touched.filter((k) => (SETTING_KEYS as string[]).includes(k))])
    this.d.db.setSetting(SETTINGS_KEY, { version: ACTIVITY_SETTINGS_VERSION, ...next, explicit: SETTING_KEYS.filter((k) => explicit.has(k)) })
  }

  private perms(): StoredPerms {
    const p = this.d.db.getSetting<Partial<StoredPerms>>(PERMS_KEY) ?? {}
    return { systemEvents: typeof p.systemEvents === 'boolean' ? p.systemEvents : null, browsers: Array.isArray(p.browsers) ? p.browsers.filter((b) => b && typeof b.app === 'string') : [] }
  }

  private savePerms(p: StoredPerms): void { this.d.db.setSetting(PERMS_KEY, p) }

  paused(s = this.settings()): boolean {
    return !!s.pausedUntil && s.pausedUntil > this.now()
  }

  /** On and not paused: collecting, and sharing with the user's own runs. */
  sharing(): boolean {
    const s = this.settings()
    return s.enabled && !this.paused(s)
  }

  /** "Also share with cloud models" (off by default: only local models get the section). */
  shareWithCloud(): boolean {
    const s = this.settings()
    return s.enabled && s.shareWithCloud
  }

  /** Starts the minute timer (only when on). Called at launch and whenever settings change. */
  start(): void {
    const s = this.settings()
    if (s.enabled) this.store.prune(this.now(), s.retentionHours)
    if (!s.enabled || this.d.noSampling) { this.stop(); return }
    if (this.timer) return
    const si = this.d.setInterval ?? ((fn: () => void, ms: number) => { const h = setInterval(fn, ms); h.unref?.(); return h })
    this.timer = si(() => void this.tick(), SAMPLE_EVERY_MS)
    ;(this.d.kick ?? ((fn: () => void) => { setTimeout(fn, 2000).unref?.() }))(() => void this.tick())
  }

  /** On quit (and when turned off): nothing more is collected. */
  stop(): void {
    if (this.timer) (this.d.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>)))(this.timer)
    this.timer = null
    if (this.soonTimer) clearTimeout(this.soonTimer)
    this.soonTimer = null
  }

  /** The user just switched to another app: one look shortly after (at most every 10 s). */
  soon(delayMs = 1500): void {
    if (!this.timer || this.soonTimer || this.now() - this.lastSoon < 10_000) return
    this.lastSoon = this.now()
    this.soonTimer = setTimeout(() => { this.soonTimer = null; void this.tick() }, delayMs)
    ;(this.soonTimer as { unref?: () => void }).unref?.()
  }

  /** One look, if allowed right now. Returns what happened (for tests and the log). */
  async tick(): Promise<'off' | 'paused' | 'idle' | 'busy' | 'skipped' | 'none' | 'sampled'> {
    const s = this.settings()
    if (!s.enabled || this.d.noSampling) return 'off'
    if (this.paused(s)) return 'paused'
    let idle = 'unknown'
    try { idle = this.d.idleState(IDLE_LIMIT_S) } catch { idle = 'unknown' }
    if (idle !== 'active') return 'idle'
    if (this.busy) return 'busy'
    this.busy = true
    try {
      const p = this.perms()
      const allowed = p.browsers.filter((b) => b.state === 'granted').map((b) => b.app)
      const r = await sampleOnce({
        jxa: this.d.jxa, accessibility: this.d.accessibility,
        windowTitles: s.windowTitles && p.systemEvents === true, browserTabs: s.browserTabs, browsers: allowed
      })
      if (r.denied) {
        if (r.denied.systemEvents) p.systemEvents = false
        if (r.denied.browser) p.browsers = p.browsers.map((b) => (b.app === r.denied!.browser ? { ...b, state: 'denied' as PermissionState } : b))
        this.savePerms(p)
      }
      // Settings may have changed (turned off, paused) while the script ran.
      const s2 = this.settings()
      if (!s2.enabled || this.paused(s2)) return s2.enabled ? 'paused' : 'off'
      const v = classify(r.raw, { ...s2, self: this.d.self })
      const now = this.now()
      this.store.prune(now, s2.retentionHours)
      if ('skip' in v) return v.skip === 'empty' ? 'none' : 'skipped'
      this.store.add({ ...v.sample, at: now })
      this.lastSampleAt = now
      this.d.onChange?.()
      return 'sampled'
    } catch {
      return 'none'
    } finally {
      this.busy = false
    }
  }

  /** The section's lines for a run starting now ([] when off, paused or nothing recent). */
  lines(now = this.now()): string[] {
    if (!this.sharing()) return []
    this.store.prune(now, this.settings().retentionHours)
    return activityLines({ now, latest: this.store.latest(), sessions: this.store.sessions(now - TIMELINE_WINDOW_MS) })
  }

  set(patch: Partial<ActivitySettings>): ActivityStatus {
    const cur = this.settings()
    const { pausedUntil: _p, ...rest } = patch
    const next = cleanActivitySettings({ ...cur, ...rest })
    const touched = Object.keys(rest).filter((k) => (rest as Record<string, unknown>)[k] !== undefined)
    this.save(next, touched)
    // Off: what was collected goes too (learning from it stops with it), and cloud sharing resets.
    if (cur.enabled && !next.enabled) { this.store.clear(); this.lastSampleAt = null; this.save({ ...next, shareWithCloud: false, pausedUntil: null }) }
    if (next.enabled) this.store.prune(this.now(), next.retentionHours)
    this.start()
    this.d.onChange?.()
    return this.status()
  }

  /** Pause for `minutes` (0 resumes). */
  pause(minutes = 60): ActivityStatus {
    const cur = this.settings()
    const m = Math.max(0, Math.min(24 * 60, Math.round(Number(minutes) || 0)))
    this.save({ ...cur, pausedUntil: m ? this.now() + m * 60_000 : null })
    this.d.onChange?.()
    return this.status()
  }

  clear(): ActivityStatus {
    this.store.clear()
    this.lastSampleAt = null
    this.d.onChange?.()
    return this.status()
  }

  /**
   * The user's own check (a click in Settings): System Events (window titles) and each scriptable
   * browser that's running. macOS may show its one-time prompt for each; nothing in the background ever does.
   */
  async checkPermissions(running: (bundleId: string) => boolean = () => true): Promise<ActivityStatus> {
    const p = this.perms()
    const se: PermissionState = await this.d.jxa(SYSTEM_EVENTS_CHECK_JS, {}, 20_000)
      .then((r) => (r === 'ok' ? 'granted' as const : 'unknown' as const))
      .catch((e: Error) => automationError(String(e?.message ?? e)))
    p.systemEvents = se === 'granted' ? true : se === 'denied' ? false : p.systemEvents
    const browsers: StoredPerms['browsers'] = []
    for (const b of SCRIPTABLE_BROWSERS) {
      const prev = p.browsers.find((x) => x.app === b.name)
      if (!running(b.bundleId)) { if (prev) browsers.push(prev); continue }
      const r = await this.d.automation(b.name).catch((e: Error) => ({ app: b.name, state: 'unknown' as PermissionState, detail: e.message }))
      // Not running when asked: keep what an earlier check found.
      browsers.push(r.state === 'unknown' && prev ? prev : { app: b.name, state: r.state, ...(r.detail ? { detail: r.detail.slice(0, 160) } : {}) })
    }
    p.browsers = browsers
    this.savePerms(p)
    this.d.onChange?.()
    return this.status()
  }

  /** Learning API: the timeline, only while "Let SahilBot learn from my activity" is on (else null). */
  timelineForLearning(sinceMs = 24 * 60 * 60_000): Session[] | null {
    const s = this.settings()
    if (!s.enabled || !s.learn || this.paused(s)) return null
    this.store.prune(this.now(), s.retentionHours)
    return this.store.sessions(this.now() - sinceMs).reverse()
  }

  status(): ActivityStatus {
    const s = this.settings()
    const now = this.now()
    if (s.enabled) this.store.prune(now, s.retentionHours)
    const p = this.perms()
    let accessibility = false
    try { accessibility = !!this.d.accessibility() } catch { accessibility = false }
    const paused = this.paused(s)
    const reason = !s.enabled ? 'Off.' : paused ? `Paused until ${new Date(s.pausedUntil!).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}.` : undefined
    const c = this.store.counts()
    return {
      settings: s,
      collecting: s.enabled && !paused && !!this.timer,
      ...(reason ? { reason } : {}),
      permissions: { accessibility, systemEvents: p.systemEvents, browsers: p.browsers },
      lastSampleAt: this.lastSampleAt ?? this.store.latest()?.at ?? null,
      samples: c.samples,
      sessions: c.sessions,
      preview: previewText(this.lines(now)),
      timeline: s.enabled ? this.store.timeline(now - Math.min(s.retentionHours, 12) * 60 * 60_000, now) : [],
      builtIn: { passwordManagers: PASSWORD_MANAGERS.map((x) => x.name), messaging: MESSAGING_APPS.map((x) => x.name), sensitiveDomains: SENSITIVE_DOMAINS.length }
    }
  }
}
