import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolDef } from '../types'

// SahilBot's own manual (docs/*.md, shipped with the app), searchable: when the agent isn't sure how a tool,
// feature or setting works, it looks it up here instead of guessing or asking the user. Keyword search (BM25 over
// the pages' sections, headings weighted up), no model call, read-only.

export interface ManualSection {
  page: string
  heading: string
  text: string
}

/** Pages written for maintainers, not for the assistant at work: still readable, ranked lower. */
const MAINTAINER = new Set(['oauth-registration.md', 'harness-comparison.md', 'connectors-status.md', 'chatgpt-plan.md', 'model-routing.md'])
const STOP = new Set('a an and are as at be by can do does for from how i if in into is it its me my of on or so that the this to was what when where which who why will with you your'.split(' '))

export const tokens = (s: string): string[] =>
  s.toLowerCase().replace(/[`*_>#|()[\]{}"']/g, ' ').split(/[^a-z0-9.+-]+/).map((w) => w.replace(/^[.+-]+|[.+-]+$/g, '')).filter((w) => w.length > 1 && !STOP.has(w)).map(stem)

/** A light stemmer: "keys" ≈ "key", "restoring" ≈ "restore", "verified" ≈ "verify". */
function stem(w: string): string {
  if (w.length <= 4) return w
  return w.replace(/(ies)$/, 'y').replace(/(ied)$/, 'y').replace(/(ing|ed|es|s)$/, '').replace(/e$/, '')
}

/** Splits a page into its "## …" sections (the text before the first one is the intro, under the page title). */
export function sections(page: string, text: string): ManualSection[] {
  const lines = text.split('\n')
  const title = (lines.find((l) => /^#\s/.test(l)) ?? `# ${page}`).replace(/^#\s+/, '').trim()
  const out: ManualSection[] = []
  let heading = title
  let buf: string[] = []
  const flush = (): void => { const t = buf.join('\n').trim(); if (t) out.push({ page, heading, text: t }); buf = [] }
  for (const l of lines) {
    const m = /^(##|###)\s+(.*)$/.exec(l)
    if (m) { flush(); heading = m[1] === '###' ? `${heading.split(' › ')[0]} › ${m[2].trim()}` : m[2].trim(); continue }
    if (/^#\s/.test(l)) continue
    buf.push(l)
  }
  flush()
  return out
}

export class Manual {
  private cache?: { key: string; secs: ManualSection[]; df: Map<string, number>; avg: number; toks: string[][]; head: string[][]; titles: Map<string, string> }

  constructor(private dir: string) {}

  pages(): string[] {
    try { return readdirSync(this.dir).filter((f) => f.endsWith('.md')).sort() } catch { return [] }
  }

  private load() {
    const pages = this.pages()
    const key = pages.map((p) => { try { return `${p}:${statSync(join(this.dir, p)).mtimeMs}` } catch { return p } }).join('|')
    if (this.cache?.key === key) return this.cache
    const secs: ManualSection[] = []
    const titles = new Map<string, string>()
    for (const p of pages) {
      const text = readFileSync(join(this.dir, p), 'utf8')
      titles.set(p, (/^#\s+(.*)$/m.exec(text)?.[1] ?? p).trim())
      secs.push(...sections(p, text))
    }
    const toks = secs.map((s) => tokens(s.text))
    const head = secs.map((s) => tokens(`${titles.get(s.page)} ${s.heading} ${s.page.replace(/\.md$/, '').replace(/-/g, ' ')}`))
    const df = new Map<string, number>()
    toks.forEach((t, i) => { for (const w of new Set([...t, ...head[i]])) df.set(w, (df.get(w) ?? 0) + 1) })
    const avg = toks.reduce((n, t) => n + t.length, 0) / Math.max(1, toks.length)
    this.cache = { key, secs, df, avg, toks, head, titles }
    return this.cache
  }

  /** The best-matching sections for a question (BM25 on the text; the page title and heading count 3x). */
  search(query: string, k = 6): Array<ManualSection & { score: number; title: string }> {
    const c = this.load()
    const q = [...new Set(tokens(query))]
    if (!q.length) return []
    const N = c.secs.length
    const scored = c.secs.map((s, i) => {
      const tf = new Map<string, number>()
      for (const w of c.toks[i]) tf.set(w, (tf.get(w) ?? 0) + 1)
      const hs = new Set(c.head[i])
      let score = 0
      for (const w of q) {
        const df = c.df.get(w) ?? 0
        if (!df) continue
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
        const f = tf.get(w) ?? 0
        const len = c.toks[i].length
        score += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * len / c.avg))
        if (hs.has(w)) score += idf * 3
      }
      if (MAINTAINER.has(s.page)) score *= 0.6
      return { ...s, score, title: c.titles.get(s.page) ?? s.page }
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score)
    // At most two sections from one page, so several pages show up.
    const per = new Map<string, number>()
    return scored.filter((x) => { const n = per.get(x.page) ?? 0; per.set(x.page, n + 1); return n < 2 }).slice(0, k)
  }

  /** One page, or one of its sections (by heading, loosely matched). */
  read(page: string, heading?: string, max = 12_000): { page: string; heading?: string; text: string; cut: boolean } {
    const raw = page.trim().replace(/^docs\//, '')
    if (/[\\/]|\.\./.test(raw)) throw new Error('Give a page name from the manual, like "coding-agents.md".')
    const file = raw.endsWith('.md') ? raw : `${raw}.md`
    if (!/^[a-z0-9._-]+\.md$/i.test(file)) throw new Error('Give a page name from the manual, like "coding-agents.md".')
    const path = join(this.dir, file)
    if (!existsSync(path)) throw new Error(`No manual page "${file}". Pages: ${this.pages().join(', ')}`)
    const text = readFileSync(path, 'utf8')
    let body = text
    let found: string | undefined
    if (heading?.trim()) {
      const want = heading.trim().toLowerCase()
      const secs = sections(file, text)
      const s = secs.find((x) => x.heading.toLowerCase() === want) ?? secs.find((x) => x.heading.toLowerCase().includes(want))
      if (!s) throw new Error(`No section "${heading}" in ${file}. Sections: ${secs.map((x) => x.heading).join(' · ')}`)
      body = `## ${s.heading}\n${s.text}`
      found = s.heading
    }
    const cut = body.length > max
    return { page: file, heading: found, text: cut ? `${body.slice(0, max)}\n…(cut: read a section with "heading" for the rest)` : body, cut }
  }
}

type Args = { action: 'search' | 'read'; query?: string; page?: string; heading?: string }

export function manualTool(docsDir: string): ToolDef<Args> {
  const manual = new Manual(docsDir)
  return {
    name: 'manual',
    label: 'Manual',
    core: true,
    group: 'Help',
    effect: 'read',
    description: 'SahilBot\'s own manual: how your tools, features and settings work, and how to do business, engineering, coding-agent, medical and other work with them. Use it before guessing or asking the user how something works. search(query): the best-matching sections with page and heading. read(page, heading?): a page or one section.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['search', 'read'] },
        query: { type: 'string', maxLength: 300, description: 'search: what you want to know, in plain words' },
        page: { type: 'string', maxLength: 80, description: 'read: a page name, e.g. "coding-agents.md"' },
        heading: { type: 'string', maxLength: 120, description: 'read: one section of the page' }
      },
      required: ['action'],
      additionalProperties: false
    },
    async run(a) {
      if (a.action === 'read') {
        if (!a.page) throw new Error('read needs "page" (search first if you don\'t know it).')
        const r = manual.read(a.page, a.heading)
        return { text: `# ${r.page}${r.heading ? ` › ${r.heading}` : ''}\n\n${r.text}`, display: `Read the manual: ${r.page}${r.heading ? ` › ${r.heading}` : ''}` }
      }
      const q = (a.query ?? '').trim()
      if (!q) throw new Error('search needs "query".')
      const hits = manual.search(q)
      if (!hits.length) return { text: `Nothing in the manual matches "${q}". Pages: ${manual.pages().join(', ')}`, display: 'Manual: no match' }
      const clip = (t: string): string => { const s = t.replace(/\s+/g, ' ').trim(); return s.length > 420 ? `${s.slice(0, 420)}…` : s }
      return {
        text: `Manual sections for "${q}" (best first). Read one with manual(action="read", page, heading).\n\n${hits.map((h, i) => `${i + 1}. ${h.page} › ${h.heading}\n   ${clip(h.text)}`).join('\n')}`,
        display: `Manual: ${hits.length} sections for “${q.slice(0, 40)}”`
      }
    }
  }
}
