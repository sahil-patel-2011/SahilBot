import type { PendingRequest } from '@shared/types'
import { looksLikeSecret } from './browser/teach'

/**
 * The one-line body of a "needs you" notification. Notifications can show on the lock screen, so
 * calls whose arguments are the sensitive part (a command, typed text, file contents) get a generic
 * line, saved-login actions never show details, saved passwords are masked, and any body with
 * something that looks like a key, token, card number or password falls back to a generic line.
 */
export function needsYouBody(r: PendingRequest, passwords: string[] = []): string {
  const generic = genericLine(r)
  if (r.kind === 'approval') {
    const fixed = argumentFreeLine(r)
    if (fixed) return fixed
  }
  const lower = (x: string): string => (/^[A-Z][a-z]/.test(x) ? x[0].toLowerCase() + x.slice(1) : x)
  const n = r.questions?.length ?? 0
  let t = r.kind === 'approval' ? (r.summary ? `Asks to ${lower(r.summary)}` : generic)
    : r.kind === 'question' ? (r.question ?? generic)
      : r.kind === 'questions' ? `${r.questions?.[0]?.question ?? 'Has a few questions'}${n > 1 ? ` (+${n - 1} more)` : ''}`
        : r.kind === 'plan' ? `Plan ready for your OK: ${r.plan?.goal ?? ''}`
          : r.kind === 'connect' ? `Wants to connect ${r.preset?.name ?? 'an app'}` : generic
  for (const pw of passwords) if (pw.length >= 4 && t.includes(pw)) return generic
  t = t.replace(/\s+/g, ' ').trim()
  if (hasSecret(t)) return generic
  return t.length > 140 ? `${t.slice(0, 139)}…` : t
}

/** The line used when the details can't be shown. */
function genericLine(r: PendingRequest): string {
  switch (r.kind) {
    case 'approval': return `Asks to use ${r.label ?? r.tool ?? 'a tool'}`
    case 'question': case 'questions': return 'Has a question for you'
    case 'plan': return 'Has a plan ready for your OK'
    case 'connect': return `Wants to connect ${r.preset?.name ?? 'an app'}`
    default: return 'Waiting for you'
  }
}

function action(r: PendingRequest): string | undefined {
  try {
    const a = (JSON.parse(r.args ?? '{}') as { action?: unknown }).action
    return typeof a === 'string' ? a : undefined
  } catch {
    return /"action"\s*:\s*"(\w+)"/.exec(r.args ?? '')?.[1]
  }
}

/** Approvals whose arguments are the sensitive part: a fixed line, never the arguments. */
function argumentFreeLine(r: PendingRequest): string | undefined {
  const tool = r.tool ?? ''
  if (/vault|secret|password/i.test(tool) || /"fill_secret"|saved login|password field/i.test(`${r.args ?? ''} ${r.reason ?? ''}`)) return 'Asks to use one of your saved logins'
  const a = action(r)
  if (tool === 'run_command') return 'Wants to run a command'
  if (tool === 'computer' && (a === 'type' || a === 'key')) return 'Wants to type on your Mac'
  if (tool === 'browser' && (a === 'type' || a === 'fill_form' || a === 'select')) return 'Wants to type in the browser'
  if (tool === 'file_write') return 'Wants to write a file'
  return undefined
}

/** Whole text, or any word or quoted piece of it, looks like a secret. */
function hasSecret(t: string): boolean {
  if (looksLikeSecret(t)) return true
  const pieces = [...t.split(/[\s"'`“”‘’()[\]{},;]+/), ...[...t.matchAll(/["'`“”]([^"'`“”]+)["'`“”]/g)].map((m) => m[1])]
  // Card and account numbers written in groups ("4242 4242 4242 4242").
  pieces.push(...[...t.matchAll(/\d(?:[ -]?\d){12,18}/g)].map((m) => m[0]))
  return pieces.some((p) => p.length >= 6 && looksLikeSecret(p.replace(/[.,:;!?]+$/, '')))
}
