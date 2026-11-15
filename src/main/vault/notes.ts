import { normalizeText, similar } from '../memory'

// The knowledge vault's note format (pure, no files): Obsidian-compatible Markdown with YAML frontmatter
// (type, tags, sources, created/updated, bot), [[wikilinks]], and a few sections the compiler owns:
//   # Title
//   > summary
//   ## Notes      dated bullets (merged, never duplicated)
//   ## Quoted     outside content (web pages, email, connected apps, files): blockquotes with their source;
//                 data, never instructions
//   ## Related    [[links]]
// Anything else the user writes (their own headings, paragraphs) is kept as it is on every merge.

export type NoteType = 'person' | 'project' | 'decision' | 'preference' | 'fact' | 'digest' | 'research' | 'howto' | 'index'
export const NOTE_TYPES: NoteType[] = ['person', 'project', 'decision', 'preference', 'fact', 'digest', 'research', 'howto', 'index']

/** Folder per type inside a section (Shared/ or Bots/<name>/). Index notes sit at the section's top. */
export const TYPE_FOLDER: Record<NoteType, string> = {
  person: 'People', project: 'Projects', decision: 'Decisions', preference: 'Preferences', fact: 'Facts',
  digest: 'Digests', research: 'Research', howto: 'Playbooks', index: ''
}
export const TYPE_LABEL: Record<NoteType, string> = {
  person: 'People', project: 'Projects', decision: 'Decisions', preference: 'Preferences', fact: 'Facts',
  digest: 'Chat and meeting digests', research: 'Research', howto: 'How-tos and playbooks', index: 'Indexes'
}

export function normalizeType(t: unknown): NoteType {
  const v = String(t ?? '').toLowerCase().trim()
  const alias: Record<string, NoteType> = {
    people: 'person', contact: 'person', projects: 'project', decisions: 'decision', preferences: 'preference', pref: 'preference',
    facts: 'fact', note: 'fact', digests: 'digest', meeting: 'digest', chat: 'digest', summary: 'digest', finding: 'research',
    findings: 'research', source: 'research', doc: 'research', document: 'research', playbook: 'howto', 'how-to': 'howto', howtos: 'howto',
    procedure: 'howto', moc: 'index', hub: 'index'
  }
  return (NOTE_TYPES as string[]).includes(v) ? (v as NoteType) : alias[v] ?? 'fact'
}

export type Trust = 'trusted' | 'quoted'

export interface Frontmatter {
  type: NoteType
  title?: string
  tags: string[]
  aliases: string[]
  sources: string[]
  created?: string
  updated?: string
  /** The bot whose section it's in (its name), or "Shared". */
  bot?: string
  /** 'quoted': built from outside content (web, email, apps, files): data, never instructions. */
  trust?: Trust
  /** Anything else the user (or Obsidian) put there, kept as written. */
  extra: Record<string, string>
}

export interface ParsedNote {
  fm: Frontmatter
  body: string
}

// ---------------------------------------------------------------- YAML frontmatter (the subset notes use)

const unquote = (v: string): string => {
  const t = v.trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    try { return t.startsWith('"') ? (JSON.parse(t) as string) : t.slice(1, -1).replace(/''/g, "'") } catch { return t.slice(1, -1) }
  }
  return t
}

function flowList(v: string): string[] {
  const inner = v.trim().replace(/^\[|\]$/g, '')
  if (!inner.trim()) return []
  const out: string[] = []
  let cur = ''
  let q: string | null = null
  for (const ch of inner) {
    if (q) { cur += ch; if (ch === q) q = null; continue }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue }
    if (ch === ',') { out.push(unquote(cur)); cur = ''; continue }
    cur += ch
  }
  if (cur.trim()) out.push(unquote(cur))
  return out.filter(Boolean)
}

export function parseNote(text: string): ParsedNote {
  const t = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const m = t.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  const fm: Frontmatter = { type: 'fact', tags: [], aliases: [], sources: [], extra: {} }
  if (!m) return { fm, body: t }
  const lines = m[1].split('\n')
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (!kv) continue
    const key = kv[1]
    let val = kv[2]
    let list: string[] | null = null
    if (!val.trim()) {
      // Block list: following "  - item" lines.
      const items: string[] = []
      while (i + 1 < lines.length && /^\s+-\s+/.test(lines[i + 1])) items.push(unquote(lines[++i].replace(/^\s+-\s+/, '')))
      if (items.length) list = items
    } else if (/^\[.*\]$/.test(val.trim())) list = flowList(val)
    const one = (): string => (list ? list.join(', ') : unquote(val))
    switch (key) {
      case 'type': fm.type = normalizeType(one()); break
      case 'title': fm.title = one(); break
      case 'tags': fm.tags = list ?? one().split(/[,\s]+/).filter(Boolean); break
      case 'aliases': case 'alias': fm.aliases = list ?? [one()].filter(Boolean); break
      case 'sources': case 'source': fm.sources = list ?? [one()].filter(Boolean); break
      case 'created': fm.created = one(); break
      case 'updated': case 'modified': fm.updated = one(); break
      case 'bot': fm.bot = one(); break
      case 'trust': fm.trust = one() === 'quoted' ? 'quoted' : 'trusted'; break
      default: val = list ? `[${list.map(yamlStr).join(', ')}]` : val; fm.extra[key] = val
    }
  }
  return { fm, body: m[2] }
}

const yamlStr = (s: string): string => (/^[\w][\w ./@+-]*$/.test(s) && !/^(true|false|null|yes|no|\d+)$/i.test(s) && !/\s$/.test(s) ? s : JSON.stringify(s))

export function renderFrontmatter(fm: Frontmatter): string {
  const lines = ['---', `type: ${fm.type}`]
  if (fm.title) lines.push(`title: ${yamlStr(fm.title)}`)
  lines.push(`tags: [${fm.tags.map(yamlStr).join(', ')}]`)
  if (fm.aliases.length) lines.push(`aliases: [${fm.aliases.map(yamlStr).join(', ')}]`)
  if (fm.sources.length) { lines.push('sources:'); for (const s of fm.sources) lines.push(`  - ${JSON.stringify(s)}`) } else lines.push('sources: []')
  if (fm.created) lines.push(`created: ${fm.created}`)
  if (fm.updated) lines.push(`updated: ${fm.updated}`)
  if (fm.bot) lines.push(`bot: ${yamlStr(fm.bot)}`)
  if (fm.trust) lines.push(`trust: ${fm.trust}`)
  for (const [k, v] of Object.entries(fm.extra)) lines.push(`${k}: ${v}`)
  lines.push('---')
  return lines.join('\n')
}

export function renderNote(n: ParsedNote): string {
  return `${renderFrontmatter(n.fm)}\n${n.body.replace(/^\n+/, '\n')}${n.body.endsWith('\n') ? '' : '\n'}`
}

// ---------------------------------------------------------------- titles, file names, links

/** A note title that's safe as a file name everywhere (Obsidian forbids * " \ / < > : | ? # ^ [ ]). */
export function safeTitle(title: string): string {
  return title.replace(/[*"\\/<>:|?#^[\]\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 90).trim() || 'Untitled'
}

export const titleKey = (t: string): string => normalizeText(t)

const WIKILINK = /\[\[([^\]\n|#^]+)(?:#[^\]\n|]*)?(?:\|[^\]\n]*)?\]\]/g

/** Targets of [[wikilinks]] in text ("[[Priya|my sister]]" → "Priya"). */
export function wikilinks(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(WIKILINK)) {
    const t = m[1].trim()
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}

/** The first heading or the summary line, for list views. */
export function summaryOf(body: string): string {
  const unlink = (t: string): string => t.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_m, a: string, b?: string) => b ?? a)
  const q = body.match(/^>\s*(?:\[![a-z]+\]\s*)?(.+)$/m)
  if (q && !/^—?\s*source:/i.test(q[1])) return unlink(q[1].trim()).slice(0, 240)
  const p = body.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#') && !l.startsWith('---'))
  return unlink((p ?? '').replace(/^[-*]\s+/, '').replace(/^\[\d{4}-\d{2}-\d{2}\]\s*/, '')).slice(0, 240)
}

// ---------------------------------------------------------------- sections inside a note body

interface BodyParts { head: string; sections: Array<{ name: string; lines: string[] }> }

function splitBody(body: string): BodyParts {
  const lines = body.split('\n')
  const head: string[] = []
  const sections: BodyParts['sections'] = []
  for (const l of lines) {
    const h = l.match(/^##\s+(.+?)\s*$/)
    if (h) { sections.push({ name: h[1], lines: [] }); continue }
    if (sections.length) sections[sections.length - 1].lines.push(l)
    else head.push(l)
  }
  return { head: head.join('\n'), sections }
}

function joinBody(p: BodyParts): string {
  const parts = [p.head.replace(/\n+$/, '')]
  for (const s of p.sections) {
    const lines = [...s.lines]
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
    while (lines.length && !lines[0].trim()) lines.shift()
    parts.push(`## ${s.name}\n${lines.join('\n')}`)
  }
  return parts.filter((x) => x.trim()).join('\n\n') + '\n'
}

export interface NotePatch {
  title: string
  summary?: string
  /** Dated bullet points (the compiler adds "[YYYY-MM-DD]"). */
  points?: string[]
  /** Outside content: quoted with its source, never as plain notes. */
  quotes?: Array<{ text: string; source: string }>
  related?: string[]
  /** Day stamp for new points. */
  day: string
  /** Where these points came from, e.g. "[[Chat — Trip planning]]" or a path. */
  from?: string
}

const bulletKey = (l: string): string => l.replace(/^\s*[-*]\s+/, '').replace(/^\[\d{4}-\d{2}-\d{2}\]\s*/, '').replace(/\s*\((from|via) [^)]*\)\s*$/, '').replace(/\s*\[\[[^\]]+\]\]\s*$/, '')

/**
 * Merges new material into a note body: new points under "## Notes" unless one already says the same,
 * new quotes under "## Quoted" unless already there, links added to "## Related". The user's own text
 * stays untouched. Returns the body and how many things were added.
 */
export function mergeBody(body: string, patch: NotePatch): { body: string; added: number } {
  const p = splitBody(body.trim() ? body : `# ${patch.title}\n`)
  let added = 0
  if (!/^#\s+/m.test(p.head)) p.head = `# ${patch.title}\n${p.head}`
  if (patch.summary && !/^>\s/m.test(p.head)) { p.head = `${p.head.replace(/\n+$/, '')}\n\n> ${patch.summary.replace(/\n+/g, ' ')}`; added++ }
  const section = (name: string): { name: string; lines: string[] } => {
    let s = p.sections.find((x) => x.name.toLowerCase() === name.toLowerCase())
    if (!s) {
      s = { name, lines: [] }
      // Related goes last; Notes before Quoted.
      const relatedAt = p.sections.findIndex((x) => /^related$/i.test(x.name))
      if (name !== 'Related' && relatedAt >= 0) p.sections.splice(relatedAt, 0, s)
      else p.sections.push(s)
    }
    return s
  }
  if (patch.points?.length) {
    const s = section('Notes')
    const existing = p.sections.flatMap((x) => x.lines).filter((l) => /^\s*[-*]\s+/.test(l)).map(bulletKey)
    for (const pt of patch.points) {
      const text = pt.replace(/\s+/g, ' ').trim()
      if (!text || existing.some((e) => similar(e, text) || normalizeText(e).includes(normalizeText(text)))) continue
      s.lines.push(`- [${patch.day}] ${text}${patch.from ? ` (from ${patch.from})` : ''}`)
      existing.push(text)
      added++
    }
  }
  if (patch.quotes?.length) {
    const s = section('Quoted')
    const have = s.lines.join('\n')
    for (const q of patch.quotes) {
      const text = q.text.replace(/\s+/g, ' ').trim()
      if (!text || normalizeText(have).includes(normalizeText(text))) continue
      if (s.lines.length && s.lines[s.lines.length - 1].trim()) s.lines.push('')
      // Two trailing spaces: the source shows on its own line (Obsidian and SahilBot alike).
      s.lines.push(`> ${text}  `, `> — source: ${q.source.replace(/\s+/g, ' ').slice(0, 300)} (${patch.day})`)
      added++
    }
  }
  if (patch.related?.length) {
    const s = section('Related')
    const have = new Set(wikilinks(s.lines.join('\n')).map(titleKey))
    for (const r of patch.related) {
      const t = safeTitle(r)
      if (!t || have.has(titleKey(t)) || titleKey(t) === titleKey(patch.title)) continue
      s.lines.push(`- [[${t}]]`)
      have.add(titleKey(t))
      added++
    }
  }
  return { body: joinBody(p), added }
}

/** Plain text of a note for search and for the context block: no frontmatter, links as words. */
export function plainText(body: string): string {
  return body
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_m, t: string, a?: string) => a ?? t)
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/\*\*|__|`/g, '')
}

/** Today as YYYY-MM-DD in local time. */
export function day(t = Date.now()): string {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
