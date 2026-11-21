// What you typed in the message box but haven't sent: kept per chat (and one for a new chat) in this
// Mac's local storage, so it survives switching chats, quitting and updating. Sending or clearing the box
// forgets it; drafts untouched for 30 days are dropped.

const PREFIX = 'sahilbot:draft:'
const MAX_AGE = 30 * 24 * 3600_000

const key = (threadId?: string | null): string => `${PREFIX}${threadId || 'new'}`

export function loadDraft(threadId?: string | null, now = Date.now()): string {
  try {
    const raw = localStorage.getItem(key(threadId))
    if (!raw) return ''
    const d = JSON.parse(raw) as { text?: unknown; at?: unknown }
    if (typeof d.text !== 'string' || typeof d.at !== 'number' || now - d.at > MAX_AGE) { localStorage.removeItem(key(threadId)); return '' }
    return d.text
  } catch { return '' }
}

export function saveDraft(threadId: string | null | undefined, text: string, now = Date.now()): void {
  try {
    if (!text.trim()) localStorage.removeItem(key(threadId))
    else localStorage.setItem(key(threadId), JSON.stringify({ text: text.slice(0, 100_000), at: now }))
  } catch { /* storage full or unavailable: the draft just isn't kept */ }
}

export const clearDraft = (threadId?: string | null): void => saveDraft(threadId, '')

/** Drops drafts older than 30 days (on start). */
export function pruneDrafts(now = Date.now()): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i)
      if (k?.startsWith(PREFIX)) loadDraft(k.slice(PREFIX.length) === 'new' ? null : k.slice(PREFIX.length), now)
    }
  } catch { /* ignore */ }
}
