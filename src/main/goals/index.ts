import type { ToolDef } from '../agent/types'
import type { GoalManager } from './manager'

export { GoalManager, GOAL_DEFAULTS, GOAL_LIMITS, GOAL_TOOLS, doneCount, fmtTime, money, parseEndDate, progressScore, type GoalDeps, type CreateGoal } from './manager'
export { GoalStore } from './store'
export { parseWhen, parseClock, nextMarketOpen, nextMarketClose } from './when'

/**
 * bots_overview (the morning check-in's summary) with a Goals section added: open goals, what needs the
 * user, next check-ins and spend. Wraps the existing tool so checkin.ts stays as it is.
 */
export function withGoalsOverview(tool: ToolDef<Record<string, never>>, goals: GoalManager, botName: (botId: string) => string): ToolDef<Record<string, never>> {
  return {
    ...tool,
    description: `${tool.description} Also lists long-running goals: progress, next check-in, spend, and goals that need the user.`,
    async run(args, ctx) {
      const base = await tool.run(args, ctx)
      const lines = goals.overview(botName)
      if (!lines) return base
      const text = base.text.startsWith('Nothing open') ? `Goals:\n${lines}` : `${base.text}\n\nGoals:\n${lines}`
      return { ...base, text, display: 'summarized your bots and goals' }
    }
  }
}
