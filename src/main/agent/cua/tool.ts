import type { ToolDef } from '../types'
import { DISAGREE_REASONS, REPORT_STATUSES } from './protocol'
import type { CuaOrchestrator } from './session'

// The executor's line to the planner (agent/cua). Loaded only when a request runs as Planner + executor.
// Effect 'read': it only talks to the planner model; it can't click, type or approve anything. Its output is
// untrusted (the planner reads the screen), so the loop's taint checks cover anything the planner relays.

type Args = { status: string; checkpoint?: number; sees: string; evidence?: string; reason?: string; why?: string; suggestion?: string }

export function checkpointTool(orchestrator: () => CuaOrchestrator | undefined): ToolDef<Args> {
  return {
    name: 'checkpoint',
    label: 'Planner',
    group: 'Computer use',
    effect: 'read',
    untrusted: true,
    available: (state) => !!state.cua,
    description: `Report to the PLANNER (Planner ⇄ Executor computer use) and get its decision back.
- status "done": the current checkpoint's "done when" is met on screen; give evidence (what shows it).
- status "disagree": you believe the planner's step is wrong, impossible, risky or already done, or the screen contradicts the plan. Stop acting first. Give reason, what you see, why, and your suggestion.
- status "blocked": you tried a few different ways and can't get further.
- status "progress": a short update when unsure how to go on.
sees: what is on screen now in a few lines (app, window, the relevant fields and values). The latest screenshot goes along automatically.`,
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: REPORT_STATUSES },
        checkpoint: { type: 'integer', minimum: 1, description: 'The checkpoint number this report is about (default: the current one)' },
        sees: { type: 'string', description: 'What is on screen now, briefly' },
        evidence: { type: 'string', description: 'For done: how the success criteria are met' },
        reason: { type: 'string', enum: DISAGREE_REASONS, description: 'For disagree / blocked' },
        why: { type: 'string', description: 'For disagree / blocked: why' },
        suggestion: { type: 'string', description: 'For disagree / blocked: what you would do instead' }
      },
      required: ['status', 'sees'],
      additionalProperties: false
    },
    async run(a, ctx) {
      const o = orchestrator()
      if (!o) return { text: 'No planner is set up: carry on and finish the task yourself.', display: 'no planner' }
      return o.report(a as unknown as Record<string, unknown>, ctx)
    }
  }
}
