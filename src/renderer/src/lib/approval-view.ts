import type { PendingRequest } from '@shared/types'

// What an approval card says, in plain words, and what it previews: the file it will save, the command it
// will run, the button it will click, the message it will send. Pure (unit-tested in
// tests/unit/approval-view.test.ts); components/Agent.tsx renders it. The raw arguments stay available behind
// "Technical details".

export type ApprovalPreview =
  | { kind: 'file'; name: string; where: string; text: string; markdown: boolean; lines: number; more: number; append: boolean }
  | { kind: 'command'; command: string; cwd?: string; why?: string; background: boolean }
  | { kind: 'click'; target: string; role?: string; site?: string }
  | { kind: 'message'; to?: string; subject?: string; body?: string; channel?: string }
  | { kind: 'fields'; rows: Array<[string, string]> }

export interface ApprovalView {
  /** The headline, with the one important name in bold: [before, bold, after]. */
  title: [string, string, string]
  /** One quiet line under the title (what kind of action, why it asks). */
  preview?: ApprovalPreview
}

const PREVIEW_LINES = 10
const base = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p
const parse = (s?: string): Record<string, unknown> => {
  if (!s) return {}
  try { const v = JSON.parse(s); return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {} } catch { return {} }
}
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)
const list = (v: unknown): string | undefined => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').join(', ') || undefined : str(v))
const pretty = (k: string): string => k.replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase())

/** First lines of a file's content, and how many more there are. */
function excerpt(content: string): { text: string; lines: number; more: number } {
  const all = content.replace(/\r\n/g, '\n').split('\n')
  const shown = all.slice(0, PREVIEW_LINES)
  return { text: shown.join('\n').slice(0, 1600), lines: all.length, more: Math.max(0, all.length - shown.length) }
}

/** "a/b/notes.md" → "in your workspace"; "/Users/me/Clients/plan.md" → "in Clients". */
function whereOf(path: string): string {
  if (!/^(\/|~|[A-Za-z]:\\)/.test(path)) {
    const dir = path.split(/[\\/]/).slice(0, -1).filter(Boolean)
    return dir.length ? `in ${dir.join('/')} (your workspace)` : 'in your workspace'
  }
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.length > 1 ? `in ${parts[parts.length - 2]}` : ''
}

const MESSAGE_TOOL = /(^|_)(send|reply|post|forward|message|chat|dm|sms|email|mail|publish|tweet|comment)(_|$)|slack|gmail|outlook|teams|discord|telegram|whatsapp|imessage/i

export function approvalView(req: Pick<PendingRequest, 'tool' | 'label' | 'summary' | 'args'>): ApprovalView {
  const tool = req.tool ?? ''
  const a = parse(req.args)
  const name = req.label ?? (tool || 'this action')

  // Files.
  if (tool === 'file_write' && str(a.path) && typeof a.content === 'string') {
    const path = a.path as string
    const ex = excerpt(a.content)
    const append = a.mode === 'append'
    return {
      title: [append ? 'Add to ' : 'Save ', base(path), ` ${whereOf(path)}`.trimEnd()],
      preview: { kind: 'file', name: base(path), where: whereOf(path), markdown: /\.(md|markdown|txt)$/i.test(path), append, ...ex }
    }
  }
  if (tool === 'file_edit' && str(a.path) && typeof a.new_string === 'string') {
    const path = a.path as string
    return { title: ['Edit ', base(path), ` ${whereOf(path)}`.trimEnd()], preview: { kind: 'file', name: base(path), where: whereOf(path), markdown: false, append: false, ...excerpt(a.new_string) } }
  }
  if (tool === 'create_document' && (str(a.path) || str(a.title))) {
    const target = str(a.path) ? base(a.path as string) : (a.title as string)
    return { title: ['Create ', target, str(a.path) ? ` ${whereOf(a.path as string)}`.trimEnd() : ''], preview: fieldsOf(a, ['path', 'title', 'format']) }
  }
  if (tool === 'file_manage' && str(a.path)) {
    const p = a.path as string
    if (a.op === 'delete') return { title: ['Move ', base(p), ' to the Trash'] }
    if (a.op === 'mkdir') return { title: ['Create the folder ', base(p), ` ${whereOf(p)}`.trimEnd()] }
    if (str(a.to)) return { title: [a.op === 'copy' ? 'Copy ' : 'Move ', base(p), ` to ${a.to as string}`] }
  }

  // Terminal commands: the command itself, and the one-line reason the tool gave.
  if (tool === 'run_command' && str(a.command)) {
    const why = req.summary?.split(' · ').slice(1).join(' · ').trim()
    const background = !!a.background
    return {
      title: [background ? 'Start a command in the background' : 'Run a command in Terminal', '', ''],
      preview: { kind: 'command', command: a.command as string, cwd: str(a.cwd), why: why || undefined, background }
    }
  }

  // Browser: "Click button "Submit" on example.com" → Click **Submit** on example.com.
  if (tool === 'browser') {
    const m = /^Click (\w[\w ]*?) "(.+)" on (.+)$/.exec(req.summary ?? '')
    if (m) return { title: ['Click ', m[2], ` on ${m[3]}`], preview: { kind: 'click', target: m[2], role: m[1], site: m[3] } }
    const t = /^Type "(.+)" into (\w[\w ]*?) "(.+)"(?: and press Enter)? on (.+)$/.exec(req.summary ?? '')
    if (t) return { title: ['Type into ', t[3], ` on ${t[4]}`], preview: { kind: 'fields', rows: [['Text', t[1]]] } }
  }

  // Email and messages: who, about what, and the start of the message.
  const to = list(a.to) ?? list(a.recipients) ?? list(a.recipient) ?? list(a.email)
  const channel = str(a.channel) ?? str(a.channel_id) ?? str(a.conversation)
  const body = str(a.body) ?? str(a.text) ?? str(a.message) ?? str(a.content)
  if ((to || channel) && body && (MESSAGE_TOOL.test(tool) || MESSAGE_TOOL.test(name))) {
    const draft = a.action === 'create_draft'
    const verb = draft ? 'Open a draft to ' : channel && !to ? 'Post in ' : 'Send to '
    return {
      title: [verb, to ?? channel ?? '', ''],
      preview: { kind: 'message', to, channel: to ? channel : undefined, subject: str(a.subject) ?? str(a.title), body: body.slice(0, 1200) }
    }
  }

  // Everything else: the tool's own words, and its simple settings as a short list.
  const summary = req.summary?.trim()
  const fields = fieldsOf(a)
  return { title: summary ? [summary, '', ''] : ['Allow ', name, '?'], preview: fields.rows.length ? fields : undefined }
}

/** Up to five short, readable settings ("Title: Q3 plan"); long or nested values stay in Technical details. */
function fieldsOf(a: Record<string, unknown>, only?: string[]): { kind: 'fields'; rows: Array<[string, string]> } {
  const rows: Array<[string, string]> = []
  for (const [k, v] of Object.entries(a)) {
    if (only && !only.includes(k)) continue
    if (rows.length >= 5) break
    const t = typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : Array.isArray(v) && v.every((x) => typeof x === 'string') ? v.join(', ') : null
    if (t === null || !t.trim() || t.length > 160) continue
    rows.push([pretty(k), t])
  }
  return { kind: 'fields', rows }
}
