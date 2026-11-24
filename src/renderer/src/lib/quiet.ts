import type { Message } from '@shared/types'
import { describe, type Step } from './steps'
import { filesFromSteps } from './ux'
import { pagesFromSteps } from '../components/PageCard'
import { stocksFromSteps } from '../components/StockCard'
import { videosFromSteps } from '../components/VideoCard'
import { docsFromSteps } from '../components/doc/DocCard'

// The quiet chat (Developer mode off): what a finished run leaves in the conversation besides its messages.
// Commands, reads, searches and plans stay out of sight; what the user would want to know about stays in:
// the files, pages and pictures it made, and the actions that changed something outside the chat.

/** Only committed changes get a short action line; reads and declined proposals stay quiet. */
function notable(s: Step, display: string): string | undefined {
  const action = String(args(s).action ?? '')
  if (/^(not started|budget unchanged|cancelled by|skipped|denied|no reply)/i.test(display)) return undefined
  if (s.call.name === 'schedule') return ({ create: 'Created a routine', update: 'Changed a routine', delete: 'Removed a routine', pause: 'Paused a routine', resume: 'Resumed a routine' } as Record<string, string>)[action]
  if (s.call.name === 'goal') return ({ create: 'Started a goal', update: 'Updated a goal', pause: 'Paused a goal', resume: 'Resumed a goal', done: 'Completed a goal', cancel: 'Cancelled a goal' } as Record<string, string>)[action]
  if (s.call.name === 'follow_up') return 'Set a follow-up'
  if (s.call.name === 'message_bot') return /no reply|still working/i.test(display) ? undefined : 'Consulted another bot'
  if (s.call.name === 'price_alert') return action === 'cancel' ? 'Cancelled a price alert' : !action || action === 'create' ? 'Set a price alert' : undefined
  return undefined
}

/** A connected app's call that sends, posts, books or creates something (its own name says so). */
const OUTWARD = /(^|_)(send|post|reply|create|add|book|schedule|publish|invite|share|comment)(_|$)/

export interface QuietAction { key: string; text: string; failed?: boolean }

/** Tools that act outside the chat: when one errors, the quiet chat says so (nothing silently doesn't happen). */
const ACTS = new Set(['schedule', 'goal', 'follow_up', 'message_bot', 'price_alert', 'mail', 'mac_apps', 'cursor'])
const acts = (s: Step): boolean => ACTS.has(s.call.name) || (s.call.name.startsWith('mcp__') && OUTWARD.test(s.call.name.split('__').pop() ?? ''))

const ok = (s: Step): boolean => s.result?.meta?.status === 'ok'
const args = (s: Step): Record<string, unknown> => { try { return JSON.parse(s.call.arguments) as Record<string, unknown> } catch { return {} } }

/** One short line per action that changed something outside the chat. */
export function quietActions(steps: Step[]): QuietAction[] {
  const out: QuietAction[] = []
  for (const s of steps) {
    if (s.result?.meta?.status === 'error' && acts(s)) { out.push({ key: s.call.id, text: `Didn't work · ${describe(s)[1]}`, failed: true }); continue }
    if (!ok(s)) continue
    const display = typeof s.result?.meta?.display === 'string' ? s.result.meta.display as string : ''
    const base = notable(s, display)
    if (base) { out.push({ key: s.call.id, text: display ? `${base} · ${display}` : base }); continue }
    if (s.call.name === 'mail' && /^send|^reply/.test(String(args(s).action ?? ''))) { out.push({ key: s.call.id, text: display ? `Sent · ${display}` : 'Sent an email' }); continue }
    if (s.call.name.startsWith('mcp__') && OUTWARD.test(s.call.name.split('__').pop() ?? '')) out.push({ key: s.call.id, text: describe(s)[1] })
  }
  return out
}

/** Pictures a run made (the image tool), as file paths. */
export function galleryFromSteps(steps: Step[]): Array<{ key: string; path: string }> {
  return steps.flatMap((s) => (ok(s) && Array.isArray(s.result?.meta?.gallery) ? (s.result!.meta!.gallery as string[]).map((path, i) => ({ key: `${s.call.id}-${i}`, path })) : []))
}

/** Whether a finished run left anything to show in the quiet chat. */
export function hasQuietContent(steps: Step[], docs: boolean): boolean {
  return quietActions(steps).length > 0 || galleryFromSteps(steps).length > 0 || filesFromSteps(steps).length > 0 || pagesFromSteps(steps).length > 0 ||
    stocksFromSteps(steps).length > 0 || videosFromSteps(steps).length > 0 || (docs && docsFromSteps(steps).length > 0)
}

/** What a run made that the chat shows as a card (files, pictures, pages, videos, documents), its steps aside. */
export function hasMadeArtifacts(steps: Step[], docs: boolean): boolean {
  return galleryFromSteps(steps).length > 0 || filesFromSteps(steps).length > 0 || pagesFromSteps(steps).length > 0 ||
    stocksFromSteps(steps).length > 0 || videosFromSteps(steps).length > 0 || (docs && docsFromSteps(steps).length > 0)
}

/** Lines the quiet chat leaves out: notes about models and thinking. */
export const internalNotice = (m: Pick<Message, 'meta'>): boolean => !!m.meta?.internal

/** "12s", "1:05", "1:02:09": how long the turn has been running. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`
}

/**
 * When the current turn started: when you sent the message it answers (not when the app noticed the run),
 * else when the run started (a routine, a handoff, Continue).
 */
export function turnStart(messages: Message[], runSince: number | undefined): number {
  const since = runSince ?? Date.now()
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user' || m.meta?.hidden || m.meta?.steer) continue
    return m.createdAt <= since && since - m.createdAt < 10 * 60_000 ? m.createdAt : since
  }
  return since
}
