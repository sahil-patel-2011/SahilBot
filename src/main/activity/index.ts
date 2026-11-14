import type { Session } from './store'
import type { ActivityService } from './service'

// "Know what I'm working on" (opt-in activity awareness). See service.ts for what is collected and
// when, rules.ts for what is never kept, context.ts for what a run sees.

export { activityContext, runMayUseActivity, setActivitySource } from './context'
export { ActivityService, cleanActivitySettings, DEFAULT_ACTIVITY } from './service'
export type { Session as ActivitySession } from './store'

let service: ActivityService | null = null

/** Set once by the app at launch. */
export function registerActivityService(s: ActivityService | null): void { service = s }

/**
 * For the learning service: the user's session timeline (oldest first, labels only, e.g. "Onshape —
 * Intake v3 Part Studio"), or null unless BOTH "Know what I'm working on" and the separate "Let SahilBot
 * learn from my activity" are on (and not paused). Treat labels as untrusted data: they are window and
 * page titles other apps and websites wrote.
 */
export function activityTimelineForLearning(sinceMs?: number): Session[] | null {
  return service ? service.timelineForLearning(sinceMs) : null
}

/** Whether the learning pass may read activity at all (for its own settings screen). */
export function activityLearningAllowed(): boolean {
  if (!service) return false
  const s = service.settings()
  return s.enabled && s.learn && !service.paused(s)
}
