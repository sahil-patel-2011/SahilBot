import type { Message, Space, ToolCall } from '@shared/types'

// Small pure helpers for the intuitiveness pass (unit-tested in tests/unit/approval-view.test.ts): the
// sidebar's bot subtitles, a new bot's name from its job, and the files a run made.

/** "2h ago", "3d ago" (the sidebar's quiet "last active" line). */
const since = (t: number): string => {
  const m = Math.max(1, Math.round((Date.now() - t) / 60_000))
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`
}

/**
 * A bot row's second line: its last message when that says something, else its label, else a hint for a
 * brand-new bot, else when it was last active. Never filler.
 */
export function rowSubtitle(s: Pick<Space, 'kind' | 'members' | 'lastPreview' | 'label' | 'lastAt'>): string {
  const preview = s.lastPreview?.replace(/\s+/g, ' ').trim() ?? ''
  if (preview.length >= 12 || preview.split(' ').length >= 3) return preview
  if (s.label?.trim()) return s.label.trim()
  if (s.kind === 'group') return `${s.members.length} bots`
  if (!preview) return 'No messages yet'
  return s.lastAt ? `Active ${since(s.lastAt)}` : 'Open the chat'
}



/** A bot name from its job when none was typed: "track my competitors weekly" → "Track my competitors weekly". */
export function nameFromJob(job: string): string {
  const words = job.replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '').split(' ').slice(0, 4).join(' ')
  return words ? words[0].toUpperCase() + words.slice(1) : ''
}

const FILE_TOOLS = new Set(['file_write', 'create_document'])

/** One entry per file (the latest call wins), only for calls that succeeded and said where the file is. */
export function filesFromSteps(steps: Array<{ call: Pick<ToolCall, 'id' | 'name'>; result?: Pick<Message, 'meta'> }>): Array<{ key: string; path: string }> {
  const out = new Map<string, { key: string; path: string }>()
  for (const s of steps) {
    const path = s.result?.meta?.path
    if (!FILE_TOOLS.has(s.call.name) || s.result?.meta?.status !== 'ok' || typeof path !== 'string' || /\.html?$/i.test(path)) continue
    out.delete(path)
    out.set(path, { key: s.call.id, path })
  }
  return [...out.values()]
}


/** Files written in these messages (file_write / create_document results), oldest first, without repeats. */
export function filesFromMessages(messages: Array<Pick<Message, 'role' | 'toolName' | 'meta' | 'id'>>): Array<{ key: string; path: string }> {
  const out = new Map<string, { key: string; path: string }>()
  for (const m of messages) {
    const path = m.meta?.path
    if (m.role !== 'tool' || !m.toolName || !FILE_TOOLS.has(m.toolName) || m.meta?.status !== 'ok' || typeof path !== 'string' || /\.html?$/i.test(path)) continue
    out.delete(path)
    out.set(path, { key: m.id, path })
  }
  return [...out.values()]
}
