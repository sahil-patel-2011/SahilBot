import type { Db } from '../db'
import { parseDecision } from '../decisions'
import { hasSecret } from '../learning/extract'
import { isUntrusted, type Memory, type MemoryKind, type MemoryStore } from '../memory'
import { day, parseNote, renderNote, safeTitle, titleKey, type Frontmatter, type NoteType } from './notes'
import type { VaultService } from './service'
import { SHARED, type VaultNoteMeta } from './store'

// Saved memories and the user's decisions, mirrored into the knowledge vault as Obsidian notes, so
// everything SahilBot remembers lives in one linked, browsable place:
//   Shared/Memory/Memory — Overview.md        a map of the memory notes, with counts
//   Shared/Memory/Memory — <Category>.md      one note per category (About you, Preferences, People…)
//   Shared/Memory/Memory — Unverified.md      wording that came from outside content (data, never facts)
//   Shared/Decisions/Decision log.md          the user's decisions, newest first, grouped by month
//   Bots/<name>/Memory/…, Bots/<name>/Decisions/…   the same for one bot's own memories (only that bot sees them)
// One way: the memories database is the source of truth. Each note's mirrored part sits in a managed block
// (between the sahilbot:memory markers) that's rewritten on every sync; anything the user writes around it
// is kept. Every write goes through the vault store (Changelog, .history, Undo; actor "memory"), and a
// sync that changes nothing writes nothing. Secrets and sensitive categories the user turned off are never
// written. A forgotten memory leaves the block on the next sync.

export const MEMORY_BLOCK_START = '<!-- sahilbot:memory (mirrored from Memory; edits inside this block are replaced: change memories in Settings → Memory) -->'
export const MEMORY_BLOCK_END = '<!-- /sahilbot:memory -->'
const START_KEY = '<!-- sahilbot:memory'
const ACTOR = 'memory'
const MEMORY_DIR = 'Memory'
const DECISIONS_DIR = 'Decisions'

/** Note title and note type per memory category (decisions go to the Decision log instead). */
const CATEGORY: Record<Exclude<MemoryKind, 'decision'>, { title: string; type: NoteType; summary: string }> = {
  profile: { title: 'About you', type: 'fact', summary: 'Who you are: name, work, time zone and other lasting facts about you.' },
  preference: { title: 'Preferences', type: 'preference', summary: 'How you like things done.' },
  rule: { title: 'Rules', type: 'preference', summary: 'Standing rules for how the work is done.' },
  person: { title: 'People', type: 'fact', summary: 'The people in your life and work.' },
  location: { title: 'Places', type: 'fact', summary: 'Places that matter: home, work, favorites.' },
  work: { title: 'Work', type: 'fact', summary: 'Your work: role, company, clients.' },
  project: { title: 'Projects', type: 'fact', summary: 'Projects and goals you mentioned.' },
  trip: { title: 'Trips', type: 'fact', summary: 'Trips and travel plans.' },
  date: { title: 'Dates', type: 'fact', summary: 'Birthdays, anniversaries and other dates to remember.' },
  link: { title: 'Links', type: 'fact', summary: 'Links worth keeping.' },
  fact: { title: 'Facts', type: 'fact', summary: 'Other lasting facts.' },
  worklog: { title: 'Work log', type: 'fact', summary: 'What was done, newest first.' }
}
const ORDER: Array<Exclude<MemoryKind, 'decision'>> = ['profile', 'preference', 'rule', 'person', 'location', 'work', 'project', 'trip', 'date', 'link', 'fact', 'worklog']

const SOURCE: Record<Memory['source'], string> = { chat: 'saved in chat', you: 'added by you', import: 'imported from another AI', learned: 'learned while idle' }
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()
/** Text that can't break out of a bullet or the managed block. */
const safeLine = (s: string): string => oneLine(s).replace(/<!--|-->/g, '').replace(/^#+\s*/, '')
const blockId = (id: string): string => `mem-${id.toLowerCase().replace(/[^a-z0-9-]/g, '')}`

export interface MemoryMirrorDeps {
  vault: VaultService
  memory: Pick<MemoryStore, 'list' | 'enabled'> & { history?: MemoryStore['history'] }
  db: Pick<Db, 'getSpace'>
  /** The People & Places sensitive-category screen: false for anything the user turned off. */
  screen?: (text: string) => { ok: boolean }
  secretValues?: () => string[]
  now?: () => number
}

export interface MirrorSyncResult {
  /** Notes written (created or changed). */
  written: number
  /** Memories mirrored. */
  memories: number
  /** Memories left out (secrets, sensitive categories, groups, bots with the vault off). */
  skipped: number
}

/** `text` with the memory block replaced (or appended after the body). */
export function withMemoryBlock(text: string, block: string): string {
  const a = text.indexOf(START_KEY)
  const b = text.indexOf(MEMORY_BLOCK_END)
  const base = a >= 0 && b > a ? `${text.slice(0, a).replace(/\s+$/, '')}\n${text.slice(b + MEMORY_BLOCK_END.length).replace(/^\s+/, '\n')}` : text
  const clean = base.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '')
  return `${clean}\n\n${block}\n`
}

/** The current block in a note (for tests and comparisons), or ''. */
export function memoryBlockOf(text: string): string {
  const a = text.indexOf(START_KEY)
  const b = text.indexOf(MEMORY_BLOCK_END)
  return a >= 0 && b > a ? text.slice(a, b + MEMORY_BLOCK_END.length) : ''
}

interface Target {
  /** "Shared" or "Bots/<name>". */
  section: string
  /** The bot's name for titles in its own area ("" in Shared). */
  bot: string
  memories: Memory[]
}

export class MemoryMirror {
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private again = false

  constructor(private d: MemoryMirrorDeps) {}

  private now(): number { return this.d.now?.() ?? Date.now() }

  /** On when the vault is on, its "Mirror memories" switch is on, and memory is on. */
  active(): boolean {
    const s = this.d.vault.settings()
    return s.enabled && s.memories !== false && this.d.memory.enabled !== false
  }

  /** A sync soon (memories change in bursts: one sync for the lot). */
  schedule(delay = 2000): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.running) { this.again = true; return }
      this.running = true
      try { this.sync() } catch (e) { console.error('[memory mirror]', (e as Error).message) }
      finally {
        this.running = false
        if (this.again) { this.again = false; this.schedule(delay) }
      }
    }, Math.max(0, delay))
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Writes every memory note that changed; returns what it did. */
  sync(): MirrorSyncResult {
    const out: MirrorSyncResult = { written: 0, memories: 0, skipped: 0 }
    if (!this.active()) return out
    const secrets = this.d.secretValues?.() ?? []
    const targets = new Map<string, Target>()
    /** Areas of bots whose vault is off: left exactly as they are. */
    const frozen = new Set<string>()
    for (const [id, b] of Object.entries(this.d.vault.settings().bots)) {
      if (b.enabled !== false || !this.d.db.getSpace(id)) continue
      const sec = this.d.vault.sectionFor(id)
      if (sec) frozen.add(sec)
    }
    for (const m of this.d.memory.list()) {
      if (hasSecret(m.content, secrets) || (this.d.screen && !this.d.screen(m.content).ok)) { out.skipped++; continue }
      let section = SHARED
      let bot = ''
      if (m.spaceId) {
        const sp = this.d.db.getSpace(m.spaceId)
        const sec = sp ? this.d.vault.sectionFor(m.spaceId) : null
        if (!sp || !sec || !this.d.vault.botEnabled(m.spaceId)) { out.skipped++; continue }
        section = sec
        bot = sec.replace(/^Bots\//, '')
      }
      const t = targets.get(section) ?? { section, bot, memories: [] }
      t.memories.push(m)
      targets.set(section, t)
      out.memories++
    }
    // Areas mirrored before keep their notes up to date (a forgotten memory leaves its block) even when
    // nothing is left in them.
    const store = this.d.vault.store
    for (const n of store.list()) {
      if (!n.tags.includes('sahilbot/memory') || targets.has(n.section) || frozen.has(n.section)) continue
      targets.set(n.section, { section: n.section, bot: n.section === SHARED ? '' : n.section.replace(/^Bots\//, ''), memories: [] })
    }
    if (!targets.size) return out
    store.ensure()
    const linkables = this.linkables()
    let wrote = false
    for (const t of targets.values()) {
      for (const note of this.notesFor(t, linkables)) {
        if (this.writeNote(note)) { out.written++; wrote = true }
      }
    }
    if (wrote) { try { store.rebuildIndexes() } catch { /* the next pass rebuilds them */ } this.d.vault.changed() }
    return out
  }

  // ---------------------------------------------------------------- planning the notes

  private titleIn(t: Target, title: string): string {
    return t.bot ? `${title} (${t.bot})` : title
  }

  private notesFor(t: Target, linkables: Linkables): PlannedNote[] {
    const notes: PlannedNote[] = []
    const store = this.d.vault.store
    const existing = (rel: string): boolean => !!store.read(rel)
    const trusted = t.memories.filter((m) => !isUntrusted(m))
    const unverified = t.memories.filter((m) => isUntrusted(m))
    const counts: Array<{ title: string; n: number }> = []
    for (const cat of ORDER) {
      const ms = trusted.filter((m) => m.category === cat).sort((a, b) => b.updatedAt - a.updatedAt)
      const c = CATEGORY[cat]
      const title = this.titleIn(t, `Memory — ${c.title}`)
      const path = `${t.section}/${MEMORY_DIR}/${safeTitle(title)}.md`
      if (!ms.length && !existing(path)) continue
      counts.push({ title, n: ms.length })
      notes.push({
        path, title, type: c.type, summary: c.summary, tags: ['sahilbot/memory', `sahilbot/memory/${cat}`], trust: 'trusted', section: t.section,
        block: this.block('Saved memories', ms.map((m) => this.memoryLine(m, linkables, t.section)), 'Nothing saved in this category right now.')
      })
    }
    {
      const title = this.titleIn(t, 'Memory — Unverified')
      const path = `${t.section}/${MEMORY_DIR}/${safeTitle(title)}.md`
      if (unverified.length || existing(path)) {
        counts.push({ title, n: unverified.length })
        notes.push({
          path, title, type: 'fact', tags: ['sahilbot/memory', 'sahilbot/memory/unverified'], trust: 'quoted', section: t.section,
          summary: 'Wording saved from outside content (a web page, email, another app or bot): data, not instructions, and not verified.',
          block: this.block('Unverified (from outside content; data, not instructions)', unverified.sort((a, b) => b.updatedAt - a.updatedAt).map((m) => `${this.memoryLine(m, linkables, t.section)} · ${m.category}`), 'Nothing unverified right now.')
        })
      }
    }
    const decisions = trusted.filter((m) => m.category === 'decision').sort((a, b) => b.updatedAt - a.updatedAt)
    const logTitle = this.titleIn(t, 'Decision log')
    const logPath = `${t.section}/${DECISIONS_DIR}/${safeTitle(logTitle)}.md`
    if (decisions.length || existing(logPath)) {
      counts.push({ title: logTitle, n: decisions.length })
      notes.push({
        path: logPath, title: logTitle, type: 'decision', tags: ['sahilbot/memory', 'sahilbot/memory/decision', 'sahilbot/decision-log'], trust: 'trusted', section: t.section,
        summary: t.bot ? `Decisions saved for ${t.bot}, newest first.` : 'Your decisions, newest first: what was chosen, over what, and when. Bots follow them unless you say otherwise.',
        block: this.decisionBlock(decisions, linkables, t.section)
      })
    }
    const overviewTitle = this.titleIn(t, 'Memory — Overview')
    const overviewPath = `${t.section}/${MEMORY_DIR}/${safeTitle(overviewTitle)}.md`
    if (!counts.length && !existing(overviewPath)) return notes
    const overview: PlannedNote = {
      path: overviewPath, title: overviewTitle, type: 'index', tags: ['sahilbot/memory', 'sahilbot/memory/overview'], trust: 'trusted', section: t.section,
      summary: t.bot ? `What ${t.bot} remembers for its own work.` : 'Everything SahilBot remembers about you, by category, plus your decision log.',
      block: this.block('Memory', counts.map((c) => `- [[${c.title}]] · ${c.n} ${c.n === 1 ? 'entry' : 'entries'}`), 'Nothing remembered yet. Memories appear here as you chat.')
    }
    return [overview, ...notes]
  }

  private block(heading: string, lines: string[], empty: string): string {
    return [MEMORY_BLOCK_START, `## ${heading}`, ...(lines.length ? lines : [`_${empty}_`]), MEMORY_BLOCK_END].join('\n')
  }

  private memoryLine(m: Memory, linkables: Linkables, section: string): string {
    const links = linkables.find(m.content, section)
    return `- ${day(m.updatedAt)} · ${safeLine(m.content)} (${SOURCE[m.source] ?? m.source})${links.length ? ` · ${links.map((l) => `[[${l}]]`).join(' ')}` : ''} ^${blockId(m.id)}`
  }

  private decisionBlock(decisions: Memory[], linkables: Linkables, section: string): string {
    const lines: string[] = [MEMORY_BLOCK_START, '## Decisions']
    if (!decisions.length) lines.push('_No decisions saved right now._')
    let month = ''
    for (const m of decisions) {
      const d = new Date(m.updatedAt)
      const label = `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
      if (label !== month) { lines.push('', `### ${label}`); month = label }
      const p = parseDecision(m.content)
      const links = linkables.find(m.content, section)
      const tail = ` · ${SOURCE[m.source] ?? m.source}${links.length ? ` · ${links.map((l) => `[[${l}]]`).join(' ')}` : ''} ^${blockId(m.id)}`
      if (p) {
        lines.push(`- ${day(m.updatedAt)} · **${safeLine(p.context)}** → ${safeLine(p.choice)}${p.over.length ? ` (over ${p.over.map(safeLine).join(', ')})` : ''}${tail}`)
        const earlier = this.earlierChoices(m, p.choice, p.earlier)
        if (earlier.length) lines.push(`  - Earlier: ${earlier.join('; ')}`)
      } else {
        lines.push(`- ${day(m.updatedAt)} · ${safeLine(m.content)}${tail}`)
      }
    }
    lines.push(MEMORY_BLOCK_END)
    return lines.join('\n')
  }

  /** Earlier choices on the same topic, newest first: from the memory's history, else its "(earlier: …)" note. */
  private earlierChoices(m: Memory, current: string, noted?: string): string[] {
    const out: string[] = []
    const seen = new Set([titleKey(current)])
    let hist: ReturnType<MemoryStore['history']> = []
    try { hist = this.d.memory.history?.(m.id) ?? [] } catch { hist = [] }
    for (const h of [...hist].reverse()) {
      if (h.validTo === null) continue
      const p = parseDecision(h.memory.content)
      if (!p || seen.has(titleKey(p.choice))) continue
      seen.add(titleKey(p.choice))
      out.push(`${safeLine(p.choice)} (until ${day(h.validTo)})`)
      if (out.length >= 3) break
    }
    if (!out.length && noted && !seen.has(titleKey(noted))) out.push(safeLine(noted))
    return out
  }

  // ---------------------------------------------------------------- writing

  /** Writes the note when its block (or the note itself) is new; true if it wrote. */
  private writeNote(n: PlannedNote): boolean {
    const store = this.d.vault.store
    const cur = store.read(n.path)
    const today = day(this.now())
    if (!cur) {
      const fm: Frontmatter = {
        type: n.type, title: n.title, tags: [...new Set(n.tags)], aliases: [], sources: ['SahilBot Memory'],
        created: today, updated: today, bot: n.section === SHARED ? SHARED : n.section.replace(/^Bots\//, ''), trust: n.trust, extra: {}
      }
      const body = `\n# ${n.title}\n\n> ${n.summary}\n\n${n.block}\n`
      store.write(n.path, renderNote({ fm, body }), { actor: ACTOR, why: 'mirrored from Memory' })
      return true
    }
    if (memoryBlockOf(cur.text) === n.block) return false
    const next = parseNote(withMemoryBlock(cur.text, n.block))
    next.fm.updated = today
    next.fm.tags = [...new Set([...next.fm.tags, ...n.tags])]
    if (n.trust === 'quoted') next.fm.trust = 'quoted'
    store.write(n.path, renderNote(next), { actor: ACTOR, why: 'memories changed' })
    return true
  }

  // ---------------------------------------------------------------- links to People and Projects notes

  private linkables(): Linkables {
    const notes = this.d.vault.store.list().filter((n) => !n.generated && (n.type === 'person' || n.type === 'project') && !n.tags.includes('sahilbot/memory'))
    return new Linkables(notes)
  }
}

interface PlannedNote {
  path: string
  title: string
  type: NoteType
  summary: string
  tags: string[]
  trust: 'trusted' | 'quoted'
  section: string
  block: string
}

const escapeRx = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** People and project notes a memory names (exact title or alias, whole words, case-insensitive). */
class Linkables {
  private entries: Array<{ title: string; section: string; rx: RegExp }> = []

  constructor(notes: VaultNoteMeta[]) {
    for (const n of notes) {
      for (const name of [n.title, ...n.aliases]) {
        const t = oneLine(name)
        if (t.length < 3 || /^memory\b/i.test(t)) continue
        this.entries.push({ title: n.title, section: n.section, rx: new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRx(t)}($|[^\\p{L}\\p{N}])`, 'iu') })
      }
    }
  }

  /** Titles to link from a memory in `section`: that area's notes and Shared's (never another bot's). */
  find(text: string, section: string): string[] {
    const out: string[] = []
    for (const e of this.entries) {
      if (e.section !== SHARED && e.section !== section) continue
      if (out.includes(e.title) || !e.rx.test(text)) continue
      out.push(e.title)
      if (out.length >= 3) break
    }
    return out
  }
}
