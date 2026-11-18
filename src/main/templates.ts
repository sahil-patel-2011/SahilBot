import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BotShape, BotTemplate, Schedule } from '@shared/types'

// Bot templates: ready-made bots shipped as JSON files in packs/templates (one file per bot).
// Adding one creates the bot with its instructions, its suggested routines (paused until the user
// turns them on) and a chat that opens with the bot's own intro message.

export const TEMPLATE_SHAPES: BotShape[] = ['blob', 'drop', 'square', 'pebble', 'star', 'triangle', 'circle', 'hex']
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

/** Problems with a schedule, or [] when it's valid. */
export function scheduleProblems(s: unknown): string[] {
  const x = s as Partial<Record<string, unknown>> | null
  if (!x || typeof x !== 'object') return ['schedule missing']
  switch (x.type) {
    case 'daily': return typeof x.time === 'string' && TIME.test(x.time) ? [] : ['daily needs time HH:MM']
    case 'weekly': {
      const out: string[] = []
      if (!Array.isArray(x.days) || !x.days.length || !x.days.every((d) => typeof d === 'string' && DAYS.includes(d.slice(0, 3).toLowerCase()))) out.push('weekly needs days like ["mon","wed"]')
      if (typeof x.time !== 'string' || !TIME.test(x.time)) out.push('weekly needs time HH:MM')
      return out
    }
    case 'every': return typeof x.minutes === 'number' && x.minutes >= 15 ? [] : ['every needs minutes >= 15']
    case 'cron': return typeof x.expr === 'string' && x.expr.trim().split(/\s+/).length === 5 ? [] : ['cron needs a 5-field expr']
    // A one-off date would be in the past for most people adding the template.
    case 'once': return ['templates cannot use one-off schedules']
    default: return [`unknown schedule type ${String(x.type)}`]
  }
}

/** Problems with a template file's contents, or [] when it's valid. */
export function templateProblems(t: unknown, skillNames?: string[]): string[] {
  const x = t as Partial<BotTemplate> | null
  if (!x || typeof x !== 'object') return ['not an object']
  const out: string[] = []
  const str = (k: keyof BotTemplate, min = 1): void => { if (typeof x[k] !== 'string' || (x[k] as string).trim().length < min) out.push(`${k} missing`) }
  str('id'); str('name'); str('description'); str('instructions', 200); str('starterMessage', 20)
  if (typeof x.id === 'string' && !/^[a-z0-9-]+$/.test(x.id)) out.push('id must be lowercase-dashed')
  if (typeof x.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(x.color)) out.push('color must be #RRGGBB')
  if (!TEMPLATE_SHAPES.includes(x.shape as BotShape)) out.push(`shape must be one of ${TEMPLATE_SHAPES.join(', ')}`)
  if (typeof x.description === 'string' && x.description.length > 90) out.push('description must fit on one line (90 chars)')
  if (!Array.isArray(x.routines)) out.push('routines must be an array')
  else x.routines.forEach((r, i) => {
    if (!r || typeof r.title !== 'string' || !r.title.trim()) out.push(`routine ${i}: title missing`)
    if (!r || typeof r.prompt !== 'string' || r.prompt.trim().length < 20) out.push(`routine ${i}: prompt missing`)
    for (const p of scheduleProblems(r?.schedule)) out.push(`routine ${i}: ${p}`)
  })
  if (x.skills !== undefined) {
    if (!Array.isArray(x.skills) || !x.skills.every((s) => typeof s === 'string')) out.push('skills must be names')
    else if (skillNames) for (const s of x.skills) if (!skillNames.includes(s)) out.push(`unknown skill ${s}`)
  }
  const list = (k: 'sources' | 'starterTasks', max: number, len: number): void => {
    const v = x[k]
    if (v === undefined) return
    if (!Array.isArray(v) || !v.length || v.length > max || !v.every((s) => typeof s === 'string' && s.trim().length > 0 && s.length <= len)) out.push(`${k} must be 1-${max} short strings`)
    else if (new Set(v.map((s) => s.toLowerCase())).size !== v.length) out.push(`${k} has duplicates`)
  }
  list('sources', 6, 40)
  list('starterTasks', 6, 80)
  if (x.group !== undefined && x.group !== 'function') out.push('group must be "function"')
  if (x.group === 'function' && (!x.sources || !x.starterTasks)) out.push('function bots need sources and starterTasks')
  return out
}

/** Every valid template in a folder, sorted by name. Invalid files are skipped (tests catch them). */
export function loadTemplates(dir: string): BotTemplate[] {
  if (!existsSync(dir)) return []
  const out: BotTemplate[] = []
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    try {
      const t = JSON.parse(readFileSync(join(dir, f), 'utf8')) as BotTemplate
      if (!templateProblems(t).length) out.push({ ...t, routines: t.routines ?? [], skills: t.skills ?? [] })
    } catch { /* skip */ }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** The bot's instructions file: its job, plus what it should know about its paused routines and skills. */
export function templatePrompt(t: BotTemplate): string {
  const parts = [`You are ${t.name}, a SahilBot bot. ${t.description}`, '', t.instructions.trim()]
  if (t.routines.length) {
    parts.push('', '# Suggested routines', 'These were created paused when the user added you. When it fits, offer to turn one on (or change its time) and only enable it after the user says yes:')
    for (const r of t.routines) parts.push(`- ${r.title}`)
  }
  if (t.skills?.length) parts.push('', '# Skills that help with this job', `Load these when they fit: ${t.skills.join(', ')}.`)
  if (t.sources?.length) parts.push('', '# Apps this job uses', `Suggested apps: ${t.sources.join(', ')}. Use the ones that are connected; if one you need isn't, say so and suggest connecting it in Connect apps (don't guess its data).`)
  return parts.join('\n') + '\n'
}

export interface TemplateDeps {
  createBot(name: string, color: string, shape: BotShape): { spaceId: string; threadId: string }
  setPrompt(spaceId: string, text: string): void
  createRoutine(r: { title: string; prompt: string; schedule: Schedule; spaceId: string }): void
  /** meta.suggestions: starter tasks shown as chips under the message (they fill the chat box). */
  postAssistant(threadId: string, text: string, meta?: Record<string, unknown>): void
  changed(): void
}

/** Creates a bot from a template: instructions, paused routines and its first message. */
export function addTemplate(t: BotTemplate, d: TemplateDeps): { spaceId: string; threadId: string } {
  const { spaceId, threadId } = d.createBot(t.name, t.color, t.shape)
  d.setPrompt(spaceId, templatePrompt(t))
  for (const r of t.routines) {
    try { d.createRoutine({ title: r.title, prompt: r.prompt, schedule: r.schedule, spaceId }) } catch { /* a bad routine never blocks the bot */ }
  }
  if (t.starterTasks?.length) d.postAssistant(threadId, t.starterMessage.trim(), { suggestions: t.starterTasks })
  else d.postAssistant(threadId, t.starterMessage.trim())
  d.changed()
  return { spaceId, threadId }
}
