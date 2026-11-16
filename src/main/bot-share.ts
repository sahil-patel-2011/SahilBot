import { randomUUID } from 'node:crypto'
import type { BotImportPreview, BotShape, BotTemplate, Schedule, ScheduledTask, SharedBotFile, Space } from '@shared/types'
import { scheduleProblems, TEMPLATE_SHAPES } from './templates'

// Share a bot as a file, import one, or duplicate one.
// A shared file carries only the bot's look, job (instructions), skill names and suggested routines.
// Whatever it says is untrusted: it is checked strictly, cleaned of hidden characters, shown to the
// user in full, and only becomes a bot (with its routines paused) after they confirm.

export const BOT_FILE_EXT = '.sahilbot.json'
export const BOT_FILE_MAX_BYTES = 256 * 1024
export const LIMITS = { name: 60, label: 80, description: 200, instructions: 20_000, skills: 30, routines: 10, routineTitle: 100, routinePrompt: 4000 } as const

const TOP_KEYS = ['format', 'version', 'name', 'color', 'shape', 'label', 'description', 'instructions', 'skills', 'routines']
const SCHEDULE_KEYS: Record<string, string[]> = { daily: ['type', 'time'], weekly: ['type', 'days', 'time'], every: ['type', 'minutes'], cron: ['type', 'expr'] }
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/

// ------------------------------------------------------------------ cleaning untrusted text

/** Zero-width and direction-changing characters that could hide or disguise text in a preview. */
const HIDDEN = /[​-‏‪-‮⁠-⁤⁦-⁩﻿­]/g
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

/** Removes control and hidden characters (keeps newlines and tabs); counts what it removed. */
export function cleanText(s: string): { text: string; removed: number } {
  const n = s.replace(/\r\n?/g, '\n')
  const text = n.replace(CONTROL, '').replace(HIDDEN, '')
  return { text, removed: n.length - text.length }
}

/** One line: whitespace collapsed. */
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

// ------------------------------------------------------------------ export

const KEY_PATTERNS: RegExp[] = [
  /\bsk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bya29\.[0-9A-Za-z_-]{20,}/g,
  /\b(?:Bearer|Token)\s+[A-Za-z0-9._~+/=-]{20,}/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g
]
/** Absolute paths on this Mac (home, volumes, temp) and ~/ paths. */
const PATH_PATTERN = /(?<![\w.~/:-])(?:~|\/(?:Users|Volumes|private|home|var\/folders|tmp)(?=\/))(?:\/[^\s"'`<>()[\]{},;]+)+\/?|\bfile:\/\/[^\s"'`<>()]+/g

/** Removes secrets (exact values, then key-shaped strings) and local file paths. */
export function scrub(text: string, secrets: string[]): { text: string; redacted: number } {
  let redacted = 0
  let out = text
  for (const v of [...new Set(secrets)].filter((x) => x && x.length >= 6).sort((a, b) => b.length - a.length)) {
    if (!out.includes(v)) continue
    redacted += out.split(v).length - 1
    out = out.split(v).join('[secret removed]')
  }
  for (const re of KEY_PATTERNS) out = out.replace(re, () => { redacted++; return '[key removed]' })
  out = out.replace(PATH_PATTERN, () => { redacted++; return '[file path removed]' })
  return { text: out, redacted }
}

/**
 * Splits a bot's system prompt into what its author wrote and what SahilBot added when it was made
 * from a template or an import (the "You are …" line, the routines list and the skills line).
 */
export function splitPrompt(prompt: string): { description: string | null; instructions: string; skills: string[] } {
  let lines = prompt.replace(/\r\n?/g, '\n').split('\n')
  let description: string | null = null
  const first = /^You are (.+?), a SahilBot bot\.\s*(.*)$/.exec(lines[0] ?? '')
  // Written by SahilBot when the bot was made (the bot may have been renamed since).
  if (first) {
    description = first[2].trim() || null
    lines = lines.slice(1)
  }
  const skills: string[] = []
  const out: string[] = []
  let skip = false
  for (const l of lines) {
    if (/^# /.test(l)) {
      skip = l.trim() === '# Suggested routines' || l.trim() === '# Skills that help with this job'
      if (skip) continue
    }
    if (skip) {
      const m = /^Load these when they fit: (.+?)\.?$/.exec(l.trim())
      if (m) for (const sk of m[1].split(',')) if (sk.trim()) skills.push(sk.trim())
      continue
    }
    out.push(l)
  }
  return { description, instructions: out.join('\n').trim(), skills }
}

export interface ExportInput {
  space: Pick<Space, 'name' | 'color' | 'shape' | 'label'>
  prompt: string
  routines: Array<Pick<ScheduledTask, 'title' | 'prompt' | 'schedule'>>
  /** Skills that exist on this Mac (only these are written). */
  skillNames: string[]
  /** Secret values (API keys, passwords, tokens) to remove wherever they appear. */
  secrets: string[]
}

/** The file contents for a bot, cleaned of secrets and file paths. Always passes botFileProblems. */
export function botFileFor(x: ExportInput): { file: SharedBotFile; redacted: number } {
  let redacted = 0
  const clip = (s: string, max: number): string => {
    const r = scrub(cleanText(s).text, x.secrets)
    redacted += r.redacted
    return r.text.slice(0, max)
  }
  const parts = splitPrompt(x.prompt)
  const name = oneLine(clip(x.space.name, LIMITS.name)) || 'Shared bot'
  const label = oneLine(clip(x.space.label ?? '', LIMITS.label))
  const description = oneLine(clip(parts.description ?? '', LIMITS.description))
  const instructions = clip(parts.instructions, LIMITS.instructions).trim() || `You are ${name}.`
  const known = new Set(x.skillNames)
  const skills = [...new Set(parts.skills)].filter((s) => known.has(s) && SKILL_NAME.test(s)).slice(0, LIMITS.skills)
  const routines: SharedBotFile['routines'] = []
  for (const r of x.routines) {
    if (routines.length >= LIMITS.routines) break
    // One-off reminders would be in the past for whoever imports the file.
    if (scheduleProblems(r.schedule).length) continue
    const title = oneLine(clip(r.title.replace(/^⏰\s*/, ''), LIMITS.routineTitle))
    const prompt = clip(r.prompt, LIMITS.routinePrompt).trim()
    if (!title || !prompt) continue
    routines.push({ title, prompt, schedule: cleanSchedule(r.schedule) })
  }
  const shape: BotShape = TEMPLATE_SHAPES.includes(x.space.shape) ? x.space.shape : 'blob'
  const color = /^#[0-9a-fA-F]{6}$/.test(x.space.color) ? x.space.color : '#7C5CFF'
  const file: SharedBotFile = {
    format: 'sahilbot.bot', version: 1, name, color, shape,
    ...(label ? { label } : {}), ...(description ? { description } : {}),
    instructions, skills, routines
  }
  return { file, redacted }
}

/** Only the keys a schedule of its type has. */
function cleanSchedule(s: Schedule): Schedule {
  switch (s.type) {
    case 'daily': return { type: 'daily', time: s.time }
    case 'weekly': return { type: 'weekly', days: s.days.map((d) => d.slice(0, 3).toLowerCase()), time: s.time }
    case 'every': return { type: 'every', minutes: s.minutes }
    case 'cron': return { type: 'cron', expr: s.expr.trim() }
    default: return s
  }
}

// ------------------------------------------------------------------ import

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
const extraKeys = (o: Record<string, unknown>, allowed: string[]): string[] => Object.keys(o).filter((k) => !allowed.includes(k))

/** Problems with a shared bot file's parsed contents, or [] when it's valid. Strict: unknown keys fail. */
export function botFileProblems(x: unknown): string[] {
  if (!isObj(x)) return ['The file is not a SahilBot bot.']
  const out: string[] = []
  for (const k of extraKeys(x, TOP_KEYS)) out.push(`unexpected field "${k.slice(0, 40)}"`)
  if (x.format !== 'sahilbot.bot') out.push('not a SahilBot bot file (format)')
  if (x.version !== 1) out.push('made by a newer SahilBot (version)')
  const text = (k: string, max: number, required: boolean, min = 1): void => {
    const v = x[k]
    if (v === undefined && !required) return
    if (typeof v !== 'string') { out.push(`${k} must be text`); return }
    if (v.trim().length < min) out.push(`${k} is empty`)
    if (v.length > max) out.push(`${k} is longer than ${max.toLocaleString('en-US')} characters`)
  }
  text('name', LIMITS.name, true)
  text('label', LIMITS.label, false, 0)
  text('description', LIMITS.description, false, 0)
  text('instructions', LIMITS.instructions, true)
  if (typeof x.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(x.color)) out.push('color must be #RRGGBB')
  if (!TEMPLATE_SHAPES.includes(x.shape as BotShape)) out.push('shape is not one SahilBot knows')
  if (!Array.isArray(x.skills)) out.push('skills must be a list')
  else {
    if (x.skills.length > LIMITS.skills) out.push(`more than ${LIMITS.skills} skills`)
    if (!x.skills.every((s) => typeof s === 'string' && SKILL_NAME.test(s))) out.push('skills must be skill names like "deep-web-research"')
  }
  if (!Array.isArray(x.routines)) out.push('routines must be a list')
  else {
    if (x.routines.length > LIMITS.routines) out.push(`more than ${LIMITS.routines} routines`)
    x.routines.slice(0, LIMITS.routines + 1).forEach((r, i) => {
      const at = `routine ${i + 1}`
      if (!isObj(r)) { out.push(`${at} is not an object`); return }
      for (const k of extraKeys(r, ['title', 'prompt', 'schedule'])) out.push(`${at}: unexpected field "${k.slice(0, 40)}"`)
      if (typeof r.title !== 'string' || !r.title.trim() || r.title.length > LIMITS.routineTitle) out.push(`${at}: title missing or too long`)
      if (typeof r.prompt !== 'string' || !r.prompt.trim() || r.prompt.length > LIMITS.routinePrompt) out.push(`${at}: instructions missing or too long`)
      const s = r.schedule
      if (!isObj(s)) { out.push(`${at}: schedule missing`); return }
      const allowed = SCHEDULE_KEYS[String(s.type)]
      if (allowed) for (const k of extraKeys(s, allowed)) out.push(`${at}: unexpected schedule field "${k.slice(0, 40)}"`)
      for (const p of scheduleProblems(s)) out.push(`${at}: ${p}`)
      if (s.type === 'every' && (!Number.isInteger(s.minutes) || (s.minutes as number) > 10_080)) out.push(`${at}: every needs whole minutes up to a week`)
      if (s.type === 'weekly' && Array.isArray(s.days) && s.days.length > 7) out.push(`${at}: too many days`)
      if (s.type === 'cron' && (typeof s.expr !== 'string' || s.expr.length > 100 || !/^[\d*,/\- A-Za-z]+$/.test(s.expr))) out.push(`${at}: cron has characters SahilBot doesn't use`)
    })
  }
  return out
}

/** Reads a file's text into a bot file, or throws with what's wrong (in plain words). */
export function parseBotFile(raw: string, bytes: number): SharedBotFile {
  if (bytes > BOT_FILE_MAX_BYTES) throw new Error(`That file is too big for a bot (${Math.round(bytes / 1024)} KB; the limit is ${BOT_FILE_MAX_BYTES / 1024} KB).`)
  let data: unknown
  try { data = JSON.parse(raw.replace(/^﻿/, '')) } catch { throw new Error('That file isn\'t a SahilBot bot (it isn\'t valid JSON).') }
  const problems = botFileProblems(data)
  if (problems.length) throw new Error(`That bot file can't be imported: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? `; and ${problems.length - 5} more` : ''}.`)
  return data as SharedBotFile
}

/** What the import would create: cleaned text, the skills this Mac has, and notes for the user. */
export function importPreview(f: SharedBotFile, fileName: string, skillNames: string[]): BotImportPreview {
  let removed = 0
  const c = (s: string): string => { const r = cleanText(s); removed += r.removed; return r.text }
  const known = new Set(skillNames)
  const skills = [...new Set(f.skills)]
  const preview: BotImportPreview = {
    token: randomUUID(),
    fileName: oneLine(c(fileName)).slice(0, 120),
    name: oneLine(c(f.name)) || 'Imported bot',
    color: f.color,
    shape: f.shape,
    label: oneLine(c(f.label ?? '')) || null,
    description: oneLine(c(f.description ?? '')) || null,
    instructions: c(f.instructions).trim(),
    routines: f.routines.map((r) => ({ title: oneLine(c(r.title)), prompt: c(r.prompt).trim(), schedule: cleanSchedule(r.schedule) })),
    skills: skills.filter((s) => known.has(s)),
    unknownSkills: skills.filter((s) => !known.has(s)),
    warnings: []
  }
  if (removed) preview.warnings.push(`Removed ${removed} hidden or control character${removed === 1 ? '' : 's'} from the file's text.`)
  if (preview.unknownSkills.length) preview.warnings.push(`Skipped skill${preview.unknownSkills.length === 1 ? '' : 's'} this Mac doesn't have: ${preview.unknownSkills.join(', ')}.`)
  return preview
}

/** The template the import creates: SahilBot writes the bot's first message itself (never the file). */
export function importTemplate(p: BotImportPreview): BotTemplate {
  const n = p.routines.length
  return {
    id: 'imported',
    name: p.name,
    color: p.color,
    shape: p.shape,
    description: p.description ?? p.label ?? 'A bot imported from a shared file.',
    instructions: p.instructions,
    starterMessage: `Hi, I'm ${p.name}. I was imported from a shared bot file, so my instructions came with it: you can read or change them any time in Customize.` +
      (n ? ` I brought ${n} suggested routine${n === 1 ? '' : 's'}; ${n === 1 ? 'it stays' : 'they stay'} paused until you turn ${n === 1 ? 'it' : 'them'} on.` : '') +
      ' What should I start with?',
    routines: p.routines,
    skills: p.skills
  }
}

/** Imports waiting for the user's OK: one use each, gone after 30 minutes. */
export class PendingImports {
  private items = new Map<string, { preview: BotImportPreview; at: number }>()
  constructor(private now = () => Date.now(), private ttl = 30 * 60_000) {}
  put(p: BotImportPreview): void {
    for (const [k, v] of this.items) if (this.now() - v.at > this.ttl) this.items.delete(k)
    this.items.set(p.token, { preview: p, at: this.now() })
  }
  take(token: string): BotImportPreview {
    const hit = this.items.get(String(token))
    this.items.delete(String(token))
    if (!hit || this.now() - hit.at > this.ttl) throw new Error('That import expired. Choose the file again.')
    return hit.preview
  }
}

// ------------------------------------------------------------------ duplicate

export interface DuplicateDeps {
  getSpace(id: string): Space | undefined
  getPrompt(spaceId: string): string
  routines(spaceId: string): ScheduledTask[]
  createBot(name: string, color: string, shape: BotShape): { spaceId: string; threadId: string }
  setPrompt(spaceId: string, text: string): void
  /** Label and notifications (a bot's model is always Auto: never copied). */
  updateSpace(spaceId: string, patch: Partial<Pick<Space, 'label' | 'model' | 'notify'>>): void
  /** Creates it paused. */
  createRoutine(r: { title: string; prompt: string; schedule: Schedule; spaceId: string }): void
  postAssistant(threadId: string, text: string): void
  changed(): void
}

/** "<name> copy", within the name limit. */
export function copyName(name: string): string {
  const suffix = ' copy'
  return `${name.slice(0, LIMITS.name - suffix.length).trim()}${suffix}`
}

/** Copies a bot's name, look, label, instructions and routines (paused). Chats and memories stay behind. */
export function duplicateBot(id: string, d: DuplicateDeps): { spaceId: string; threadId: string } {
  const src = d.getSpace(id)
  if (!src) throw new Error('That bot no longer exists.')
  if (src.kind !== 'bot') throw new Error('Only bots can be duplicated.')
  const prompt = d.getPrompt(src.id)
  const made = d.createBot(copyName(src.name), src.color, src.shape === 'mascot' ? 'blob' : src.shape)
  d.setPrompt(made.spaceId, prompt)
  d.updateSpace(made.spaceId, { label: src.label ?? null, notify: src.notify !== false })
  let copied = 0
  for (const r of d.routines(src.id)) {
    try { d.createRoutine({ title: r.title, prompt: r.prompt, schedule: r.schedule, spaceId: made.spaceId }); copied++ } catch { /* a one-off in the past can't be copied */ }
  }
  d.postAssistant(made.threadId, `I'm a copy of ${src.name}: same instructions and look${src.label ? ', same label' : ''}` +
    (copied ? `, and ${copied} routine${copied === 1 ? '' : 's'} (paused until you turn ${copied === 1 ? 'it' : 'them'} on)` : '') +
    `. Its chats and memories weren't copied, so I start fresh. What should I work on?`)
  d.changed()
  return made
}
