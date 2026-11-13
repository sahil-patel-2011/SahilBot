import type { Space } from '@shared/types'
import { findBot } from '../agent/tools/handoff'

// sahilbot:// links for Shortcuts, Raycast and Alfred. They only OPEN SahilBot with the composer filled
// in: nothing is ever sent until the user presses Enter, whatever the link says. The text is kept short
// (blank-line runs collapsed, MAX_TEXT_CHARS), the composer says it came from a link, and if it is sent
// unedited it is marked meta.fromLink: relayed text, untrusted like another bot's handoff.
//   sahilbot://ask?bot=Writer&text=Draft%20a%20reply   → that bot's chat, text in the composer
//   sahilbot://new?bot=Writer[&text=…]                  → a new chat with that bot
// Without bot (or bot=SahilBot) both open a new SahilBot chat.

export const SCHEME = 'sahilbot'
/** Longest link accepted at all, and longest text put in the composer. */
export const MAX_URL_CHARS = 16_000
export const MAX_TEXT_CHARS = 500
export const MAX_BOT_CHARS = 80

export interface UrlAction {
  kind: 'ask' | 'new'
  bot: string | null
  text: string
  /** The text was cut to MAX_TEXT_CHARS. */
  truncated: boolean
}

export type ParsedUrl = { ok: true; action: UrlAction } | { ok: false; error: string }

/** Control characters out (newlines and tabs stay), including bidi overrides that hide text. */
const cleanText = (s: string): string => s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g, '')

export function parseSahilbotUrl(raw: unknown): ParsedUrl {
  if (typeof raw !== 'string' || !raw) return { ok: false, error: 'Empty link.' }
  if (raw.length > MAX_URL_CHARS) return { ok: false, error: 'That link is too long.' }
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return { ok: false, error: 'That link isn\'t a valid sahilbot:// link.' }
  }
  if (u.protocol !== `${SCHEME}:`) return { ok: false, error: 'Not a sahilbot:// link.' }
  // sahilbot://ask?… (host) and sahilbot:ask?… / sahilbot:///ask?… (path) all name the action.
  const action = (u.hostname || u.pathname.replace(/^\/+/, '').split('/')[0]).toLowerCase()
  if (action !== 'ask' && action !== 'new') return { ok: false, error: `Unknown action "${action.slice(0, 20)}". Use sahilbot://ask or sahilbot://new.` }
  const botRaw = cleanText(u.searchParams.get('bot') ?? '').replace(/\s+/g, ' ').trim()
  if (botRaw.length > MAX_BOT_CHARS) return { ok: false, error: 'That bot name is too long.' }
  // Blank-line runs (and whitespace-only lines) collapse to one blank line, so nothing hides below the fold.
  let text = cleanText(u.searchParams.get('text') ?? u.searchParams.get('q') ?? '').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim()
  const truncated = text.length > MAX_TEXT_CHARS
  if (truncated) text = text.slice(0, MAX_TEXT_CHARS)
  // Anything else (send=1, auto=true, submit…) is ignored on purpose: links never send.
  return { ok: true, action: { kind: action, bot: botRaw || null, text, truncated } }
}

export type ResolvedTarget = { botId: string | null; unknownBot?: string }

/** Which bot a link means: null = SahilBot itself (also when the named bot doesn't exist). */
export function resolveUrlBot(action: UrlAction, spaces: Space[]): ResolvedTarget {
  if (!action.bot) return { botId: null }
  const bots = spaces.filter((s) => s.kind === 'bot')
  const b = findBot(bots.filter((x) => !x.hidden), action.bot) ?? findBot(bots, action.bot)
  if (!b) return { botId: null, unknownBot: action.bot }
  return { botId: b.isMain ? null : b.id }
}

/**
 * Script that puts text in the main window's composer if it's empty (never sends). It goes in as link
 * text: the composer shows "Text from a link — review before sending" and marks it if sent unedited.
 */
export function prefillScript(text: string): string {
  // JSON.stringify makes a safe JS string literal (U+2028/2029 are valid in string literals since ES2019).
  return `(() => { const t = ${JSON.stringify(text)}; const el = document.querySelector('[data-testid="composer-input"]'); if (!el) return 'wait'; if (el.value === t) return 'ok'; if (el.value) return 'typed'; window.dispatchEvent(new CustomEvent('sahilbot:compose-link', { detail: t })); return 'ok' })()`
}
