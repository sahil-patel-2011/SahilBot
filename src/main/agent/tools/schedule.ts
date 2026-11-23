import type { Schedule } from '@shared/types'
import type { Db } from '../../db'
import { describeSchedule, type Scheduler } from '../../scheduler'
import type { ToolDef } from '../types'

type Args = { action: 'create' | 'list' | 'update' | 'delete' | 'pause' | 'resume'; title?: string; prompt?: string; when?: Schedule; id?: string }

/** Reminders and recurring tasks. Runs happen unattended: anything needing approval is skipped and reported. */
export function scheduleTool(scheduler: Scheduler, db: Db): ToolDef<Args> {
  return {
    name: 'schedule',
    label: 'Schedule',
    group: 'Schedule',
    effect: (a) => (a.action === 'list' ? 'read' : a.action === 'create' ? 'write_external' : 'write_local'),
    // Creating a schedule is routine, but if its instructions came from a web page or email, Auto asks.
    consequential: () => false,
    describe: (a) => (a.action === 'create' && a.when ? `Schedule "${a.title}" ${describeSchedule(a.when)}` : `${a.action} scheduled task ${a.id ?? ''}`),
    description: `Reminders and recurring tasks that run on their own later (in this bot's chat).
- create {title, prompt, when}: prompt is the instruction you will receive when it runs, written so it stands alone ("Check my inbox for invoices and summarize them").
  when is one of: {type:"once", at:"2026-11-12T09:00"} (local time), {type:"daily", time:"09:00"}, {type:"weekly", days:["mon","thu"], time:"08:30"}, {type:"every", minutes:60}, {type:"cron", expr:"0 9 * * 1-5"}.
- update {id, and any of title, prompt, when}: change a routine in place ("move it to 9:10 and add Saturdays"); its history is kept.
- list, delete {id}, pause {id}, resume {id}.
Scheduled runs can't ask for approval: actions that would need it are skipped and reported.`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'update', 'delete', 'pause', 'resume'] },
        title: { type: 'string', maxLength: 80 },
        prompt: { type: 'string', maxLength: 8000 },
        id: { type: 'string' },
        when: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['once', 'daily', 'weekly', 'every', 'cron'] },
            at: { type: 'string' }, time: { type: 'string', pattern: '^\\d{1,2}:\\d{2}$' },
            days: { type: 'array', items: { type: 'string' } }, minutes: { type: 'integer', minimum: 1 }, expr: { type: 'string' }
          },
          required: ['type']
        }
      },
      required: ['action'],
      additionalProperties: false,
      allOf: [
        { if: { properties: { action: { const: 'create' } } }, then: { required: ['title', 'prompt', 'when'] } },
        { if: { properties: { action: { enum: ['update', 'delete', 'pause', 'resume'] } } }, then: { required: ['id'] } }
      ]
    },
    async run(a, ctx) {
      const thread = db.getThread(ctx.threadId)
      if (a.action === 'create') {
        // SahilBot's routines run in the chat that made them; other bots have one conversation anyway.
        const t = scheduler.create({ title: a.title!, prompt: a.prompt!, schedule: a.when!, spaceId: thread?.spaceId ?? '', threadId: thread && db.getSpace(thread.spaceId)?.isMain ? thread.id : null })
        return { text: `Scheduled "${t.title}" (${describeSchedule(t.schedule)}), id ${t.id}. Next run: ${new Date(t.nextRun!).toLocaleString(undefined, { timeZoneName: 'short' })}.`, display: `"${t.title}" ${describeSchedule(t.schedule)}` }
      }
      if (a.action === 'list') {
        const ts = scheduler.list()
        if (!ts.length) return { text: 'No scheduled tasks.', display: 'none scheduled' }
        return { text: ts.map((t) => `- [${t.id}] ${t.title}: ${describeSchedule(t.schedule)}${t.enabled ? `, next ${t.nextRun ? new Date(t.nextRun).toLocaleString() : 'never'}` : ' (paused)'}${t.lastStatus ? `, last: ${t.lastStatus}` : ''}`).join('\n'), display: `${ts.length} scheduled` }
      }
      if (a.action === 'update') {
        if (a.title === undefined && a.prompt === undefined && !a.when) throw new Error('update needs at least one of title, prompt or when.')
        const t = scheduler.update(a.id!, { ...(a.title !== undefined ? { title: a.title } : {}), ...(a.prompt !== undefined ? { prompt: a.prompt } : {}), ...(a.when ? { schedule: a.when } : {}) })
        return { text: `Updated "${t.title}" (${describeSchedule(t.schedule)}).${t.nextRun ? ` Next run: ${new Date(t.nextRun).toLocaleString(undefined, { timeZoneName: 'short' })}.` : ''}`, display: `"${t.title}" ${describeSchedule(t.schedule)}` }
      }
      if (a.action === 'delete') {
        scheduler.remove(a.id!)
        return { text: `Deleted scheduled task ${a.id}.`, display: `deleted ${a.id}` }
      }
      const t = scheduler.update(a.id!, { enabled: a.action === 'resume' })
      return { text: `${a.action === 'resume' ? 'Resumed' : 'Paused'} "${t.title}".`, display: `${a.action}d ${t.title}` }
    }
  }
}
