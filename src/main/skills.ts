import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Skill } from '@shared/types'

// Skills: procedures that worked, written down so the next run follows them instead of rediscovering
// them (Hermes-style procedural memory, in the Agent Skills SKILL.md format: frontmatter name and
// description, then the steps). Only names and descriptions go in the prompt; the body is read on demand.

const SLUG = /^[a-z0-9][a-z0-9-]{1,48}$/

export const slug = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)

export class SkillStore {
  /** dir: yours and learned skills (editable). builtinDir: the packs that ship with the app (read-only). */
  constructor(private dir: string, private builtinDir?: string) {
    mkdirSync(dir, { recursive: true })
  }

  /** The shipped packs change only with an app update (or while developing them): re-read at most every few seconds. */
  private packs?: { at: number; skills: Skill[] }

  private builtin(): Skill[] {
    if (this.packs && Date.now() - this.packs.at < 5000) return this.packs.skills
    this.packs = { at: Date.now(), skills: this.readBuiltin() }
    return this.packs.skills
  }

  private readBuiltin(): Skill[] {
    const d = this.builtinDir
    if (!d || !existsSync(d)) return []
    return readdirSync(d).filter((x) => existsSync(join(d, x, 'SKILL.md'))).map((x) => {
      const f = join(d, x, 'SKILL.md')
      return { ...parse(readFileSync(f, 'utf8'), x)!, source: 'builtin' as const, updatedAt: statSync(f).mtimeMs }
    })
  }

  private file(name: string): string {
    const s = slug(name)
    if (!SLUG.test(s)) throw new Error('Skill names use letters, numbers and dashes.')
    return join(this.dir, s, 'SKILL.md')
  }

  list(): Skill[] {
    const out: Skill[] = []
    for (const d of readdirSync(this.dir)) {
      const f = join(this.dir, d, 'SKILL.md')
      if (!existsSync(f)) continue
      const sk = parse(readFileSync(f, 'utf8'), d)
      if (sk) out.push({ ...sk, updatedAt: statSync(f).mtimeMs })
    }
    // Yours override a built-in skill with the same name.
    const all = [...out, ...this.builtin().filter((b) => !out.some((o) => o.name === b.name))]
    return all.sort((a, b) => b.uses - a.uses || Number(a.source === 'builtin') - Number(b.source === 'builtin') || b.updatedAt - a.updatedAt)
  }

  get(name: string): Skill | undefined {
    const f = this.file(name)
    if (!existsSync(f)) return this.builtin().find((b) => b.name === slug(name))
    const sk = parse(readFileSync(f, 'utf8'), slug(name))
    return sk ? { ...sk, updatedAt: statSync(f).mtimeMs } : undefined
  }

  /** `untrusted`: learned from a borderline run; kept out of the index until the user approves it. */
  save(input: { name: string; description: string; body: string; source: Skill['source']; untrusted?: boolean }): Skill {
    const name = slug(input.name)
    const f = this.file(name)
    const prev = existsSync(f) ? parse(readFileSync(f, 'utf8'), name) : undefined
    mkdirSync(join(this.dir, name), { recursive: true })
    const sk: Skill = { name, description: oneLine(input.description).slice(0, 300), body: input.body.trim().slice(0, 12_000), source: input.source, uses: prev?.uses ?? 0, updatedAt: Date.now(), ...(input.untrusted && input.source === 'learned' ? { untrusted: true } : {}) }
    writeFileSync(f, render(sk))
    return sk
  }

  /** Counts uses so the most useful skills list first. */
  used(name: string): void {
    const sk = this.get(name)
    if (sk && sk.source !== 'builtin') writeFileSync(this.file(name), render({ ...sk, uses: sk.uses + 1 }))
  }

  remove(name: string): void {
    // An empty or odd name would resolve to the skills folder itself.
    if (!SLUG.test(slug(name))) throw new Error('Skill names use letters, numbers and dashes.')
    if (!existsSync(join(this.dir, slug(name)))) throw new Error('Built-in skills can\'t be deleted; edit one to make your own version.')
    rmSync(join(this.dir, slug(name)), { recursive: true, force: true })
  }

  /**
   * The list for the system prompt. Yours and learned ones with their descriptions (they're specific);
   * built-in packs as names grouped by topic, families folded ("frc-code-{swerve, vision}"), so the prompt
   * stays small even with hundreds of packs. Which ones fit a request comes per run from suggest().
   * Skills marked `untrusted: true` are left out until approved.
   */
  index(max = 40, budget = 2000): string {
    // Unverified learned skills wait for the user's OK (Settings → Memory → What I learned); redirect packs
    // (merged into another pack, no description) aren't listed.
    const all = this.list().filter((s) => !s.untrusted && !isRedirect(s))
    const mine = all.filter((s) => s.source !== 'builtin').slice(0, max).map((s) => `- ${s.name}: ${s.description}`)
    const groups = new Map<string, string[]>()
    for (const s of all.filter((x) => x.source === 'builtin')) groups.set(s.category ?? 'General', [...(groups.get(s.category ?? 'General') ?? []), s.name])
    // Many packs: families show their first few members ("+9 more"); suggest() surfaces the rest per request.
    let packs: string[] = []
    for (const cap of [Infinity, 14, 10, 7, 5, 3]) {
      packs = [...groups].map(([cat, names]) => `- ${cat}: ${foldNames(names, cap)}`)
      if (packs.join('\n').length <= budget) break
    }
    return [...mine, ...(packs.length ? ['Built-in skills by topic:', ...packs] : [])].join('\n')
  }

  /** The skills that fit a request, best first (see rankSkills). */
  relevant(query: string, opts: SuggestOptions = {}): Ranked[] {
    return rankSkills(this.catalog(), query, { ...opts, kinds: opts.kinds ?? projectKinds(opts.folder) })
  }

  /**
   * The per-run "skills that fit this request" for the <context> block: the top few as one line each and,
   * on a big window, the best one's steps inlined when it clearly fits (so the model follows it without a
   * read_skill round trip). Bounded by `budget` characters; small windows get names and short lines only.
   */
  suggest(query: string, opts: SuggestOptions = {}): SkillSuggestion | undefined {
    const ranked = this.relevant(query, opts)
    if (!ranked.length) return undefined
    const compact = !!opts.compact
    const budget = opts.budget ?? (compact ? COMPACT_BUDGET : FULL_BUDGET)
    const top = ranked.slice(0, opts.k ?? (compact ? 3 : 5))
    const inline = !compact && top[0].score >= INLINE_MIN && (top.length < 2 || top[0].score >= top[1].score * 1.15 || top[0].score >= INLINE_SURE) ? top[0] : undefined
    const width = compact ? 90 : 150
    const lines: string[] = []
    let used = 0
    for (const r of top) {
      const d = r.skill.description.length > width ? `${r.skill.description.slice(0, width - 1)}…` : r.skill.description
      const l = `- ${r.skill.name}: ${d}${r === inline ? ' (steps below)' : ''}`
      if (used + l.length > budget * (inline ? 0.25 : 1)) break
      lines.push(l)
      used += l.length + 1
    }
    let body: SkillSuggestion['body']
    if (inline) {
      const room = budget - used - 80
      const b = clipBody(inline.skill.body, room)
      if (b) body = { name: inline.skill.name, lines: headed(b, inline.skill.name) }
    }
    return { names: top.map((r) => r.skill.name), lines, body }
  }

  /** Every usable skill with its triggers, cached until a skill file changes. */
  private catalog(): Entry[] {
    const all = this.list().filter((s) => !s.untrusted && !isRedirect(s))
    const sig = all.map((s) => `${s.name}@${s.updatedAt}`).join('|')
    if (this.cached?.sig === sig) return this.cached.entries
    const entries = all.map((s) => entry(s, this.triggersOf(s)))
    this.cached = { sig, entries: withIdf(entries) }
    return this.cached.entries
  }

  private cached?: { sig: string; entries: Entry[] }

  private triggersOf(s: Skill): string[] {
    const base = s.source === 'builtin' ? this.builtinDir : this.dir
    const f = base ? join(base, s.name, 'SKILL.md') : ''
    if (!f || !existsSync(f)) return []
    const front = readFileSync(f, 'utf8').match(/^---\n([\s\S]*?)\n---/)?.[1] ?? ''
    const m = front.match(/^triggers:\s*(.*)$/m)
    return m ? m[1].split(',').map((t) => t.trim().toLowerCase()).filter(Boolean) : []
  }
}

// ------------------------------------------------------------------ selection

export interface SuggestOptions {
  /** The run's project folder: its files hint at the stack (package.json, Cargo.toml, build.gradle…). */
  folder?: string | null
  /** Stack hints when there's no folder ('node', 'python', 'rust', 'go', 'java', 'swift'). */
  kinds?: string[]
  /** The run is in a code project (git or a build file): coding skills rank higher. */
  codeProject?: boolean
  /** Small window / lean prompt: names and short lines only, no inlined steps. */
  compact?: boolean
  /** How many to list (default 5, compact 3). */
  k?: number
  /** Characters for the whole suggestion (default 4,800 ≈ 1.2K tokens; compact 420). */
  budget?: number
}

export interface Ranked { skill: Skill; score: number }
export interface SkillSuggestion { names: string[]; lines: string[]; body?: { name: string; lines: string[] } }

const FULL_BUDGET = 4800
const COMPACT_BUDGET = 420
/** Below this a match is noise (one common word). */
const MIN_SCORE = 3
/** Inline the best skill's steps from here (clear winner), or always from INLINE_SURE. */
const INLINE_MIN = 7
const INLINE_SURE = 12

interface Entry { skill: Skill; name: Set<string>; desc: Set<string>; cat: Set<string>; triggers: string[][]; all: Set<string>; idf?: Map<string, number> }

const STOP = new Set(('a an and are as at be but by can could do does for from get go got had has have how i if in into is it its just like make me my need of on one or our please should so some that the their them then there these this to up us use using want was we what when where which while who why will with would you your yes no not too very also more most any all new way thing things help able sure ok okay let lets via per about after before over under again out than well good best really much many'
  + ' code work task something stuff file files project run running build app').split(' '))

/** Lowercase word tokens, lightly stemmed, with tech names normalized (Next.js → nextjs, C++ → cpp). */
export function tokens(text: string): string[] {
  const t = text.toLowerCase()
    .replace(/c\+\+/g, ' cpp ').replace(/c#/g, ' csharp ').replace(/\.net\b/g, ' dotnet ')
    .replace(/\b(next|node|vue|nuxt|express|three)\.js\b/g, '$1js').replace(/\bci\/cd\b/g, 'cicd')
  return t.split(/[^a-z0-9]+/).filter((w) => w.length > 1 || /\d/.test(w)).map(stem)
}

function stem(w: string): string {
  if (w.length <= 3 || /\d/.test(w)) return w
  if (w.endsWith('ies') && w.length > 4) return `${w.slice(0, -3)}y`
  if (w.endsWith('ing') && w.length > 5) return w.slice(0, -3)
  if (w.endsWith('ed') && w.length > 4) return w.slice(0, -2)
  if (w.endsWith('es') && /(ches|shes|sses|xes)$/.test(w)) return w.slice(0, -2)
  if (w.endsWith('s') && !/(ss|us|is|js)$/.test(w)) return w.slice(0, -1)
  return w
}

const content = (ws: string[]): string[] => ws.filter((w) => !STOP.has(w))

function entry(s: Skill, triggers: string[]): Entry {
  const name = new Set(content(tokens(s.name.replace(/-/g, ' '))))
  const desc = new Set(content(tokens(s.description)))
  const cat = new Set(content(tokens(s.category ?? '')))
  const trig = triggers.map((t) => tokens(t)).filter((t) => t.length)
  return { skill: s, name, desc, cat, triggers: trig, all: new Set([...name, ...desc, ...cat, ...trig.flat()]) }
}

/** Rare words count more: "wpilib" says far more than "design" across a few hundred skills. */
function withIdf(es: Entry[]): Entry[] {
  const df = new Map<string, number>()
  for (const e of es) for (const w of e.all) df.set(w, (df.get(w) ?? 0) + 1)
  const n = Math.max(es.length, 1)
  const idf = new Map([...df].map(([w, d]) => [w, Math.log(1 + n / d)]))
  return es.map((e) => ({ ...e, idf }))
}

const has = (q: string[], phrase: string[]): boolean => {
  if (phrase.length === 1) return q.includes(phrase[0])
  for (let i = 0; i + phrase.length <= q.length; i++) if (phrase.every((w, j) => q[i + j] === w)) return true
  return false
}

/** Folder files that say which stack a project uses. */
export function projectKinds(folder?: string | null): string[] {
  if (!folder || !existsSync(folder)) return []
  let names: string[] = []
  try { names = readdirSync(folder) } catch { return [] }
  const any = (...xs: string[]): boolean => xs.some((x) => names.includes(x))
  const out: string[] = []
  if (any('package.json', 'tsconfig.json')) out.push('node')
  if (any('tsconfig.json')) out.push('typescript')
  if (any('pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile')) out.push('python')
  if (any('Cargo.toml')) out.push('rust')
  if (any('go.mod')) out.push('go')
  if (any('build.gradle', 'build.gradle.kts', 'pom.xml', 'settings.gradle')) out.push('java')
  if (any('vendordeps') || names.some((n) => n === '.wpilib')) out.push('wpilib')
  if (any('Package.swift') || names.some((n) => n.endsWith('.xcodeproj') || n.endsWith('.xcworkspace'))) out.push('swift')
  if (any('pnpm-workspace.yaml', 'turbo.json', 'nx.json', 'lerna.json')) out.push('monorepo')
  return out
}

/** The playbook a stack points at, when that skill exists. */
const KIND_SKILL: Record<string, string> = { node: 'typescript-project', typescript: 'typescript-project', python: 'python-project', rust: 'rust-project', go: 'go-project', java: 'java-kotlin-wpilib', wpilib: 'frc-code-start-here', swift: 'swift-ios-app', monorepo: 'monorepo-workflow' }

/** A code change in a project ("add", "fix", "refactor"…), not a question about it. */
const CHANGE = /\b(add|implement|fix|change|update|refactor|rename|remove|support|wire|hook up|port|migrate|upgrade|bug|feature|failing|broken|error|crash|tests?)\b/i
/** Work that will run long: the working-notes skill helps it not lose track. */
const LONG = /\b(long[- ]running|long task|overnight|multi[- ]step|end[- ]to[- ]end|entire|whole (app|codebase|repo|project)|across the (codebase|repo)|from scratch|big refactor|large refactor|rewrite the|all of the|every (file|module|test))\b/i
const CURSOR = /\bcursor\b(?![- ](pagination|position|based|style|pointer|movement))/i
const FRC_CODE = /\b(code|coding|program|programming|software|java|kotlin|command|commands|subsystem class|auto routine|autonomous|pid|feedforward|tune|deploy|gradle|log|logs)\b/i
const FRC_DESIGN = /\b(cad|onshape|design|mechanism geometry|gear ratio|gearbox|bracket|plate|tube|chain|belt|weight|frame|manufactur\w*|print|cnc)\b/i
const FRC = /\b(frc|robot|robots|robotics|first robotics|wpilib|gradlerio|roborio|swerve|drivetrain|alliance|match|competition|pathplanner|choreo|photonvision|limelight|kraken|falcon 500|neo|spark max|talonfx|phoenix|advantagekit|bumpers?)\b/i
const CODEY = /\b(repo|repository|codebase|function|class|module|compile|stack ?trace|typescript|javascript|python|java|kotlin|swift|swiftui|xcode|rust|cargo|golang|react|next\.?js|node|npm|pnpm|pandas|gradle|sql|api|endpoint|unit tests?|pull request|commit|git|cli|bug|refactor)\b|\.(ts|tsx|js|py|java|kt|swift|rs|go|sql|sh)\b/i

/**
 * Ranks skills for a request: trigger phrases (multi-word ones weigh more), then name, description and
 * category words, each weighted by how rare the word is across all skills (IDF), plus context: the
 * project's stack, a code project, a Cursor hand-off, a long task. Returns those above the noise floor,
 * best first.
 */
/** A pack kept only to point at the one it was merged into: no description, or category Redirects. */
function isRedirect(s: { description?: string; category?: string }): boolean {
  return !s.description?.trim() || s.category === 'Redirects'
}

export function rankSkills(entries: Entry[], query: string, o: SuggestOptions = {}): Ranked[] {
  const q = tokens(query)
  const qc = [...new Set(content(q))]
  if (!qc.length && !o.codeProject) return []
  const codeish = !!o.codeProject || CODEY.test(query)
  const kinds = new Set(o.kinds ?? [])
  const out: Ranked[] = []
  // The stack's playbook stays in the list for a code request even when other skills score higher.
  const keep = new Set<string>()
  for (const e of entries) {
    const idf = (w: string): number => e.idf?.get(w) ?? 1
    let score = 0
    const hit = new Set<string>()
    for (const t of e.triggers) {
      if (!has(q, t)) continue
      const words = content(t)
      if (!words.length) continue
      score += words.reduce((s, w) => s + idf(w), 0) * (t.length > 1 ? 1.6 : 1.2)
      for (const w of words) hit.add(w)
    }
    // A skill that lists its triggers knows its vocabulary: a trigger hit is strong evidence, none is weak.
    const triggered = hit.size > 0
    for (const w of qc) {
      if (hit.has(w)) continue
      if (e.name.has(w)) score += idf(w) * 1.3
      else if (e.desc.has(w)) score += idf(w) * 0.7
      else if (e.cat.has(w)) score += idf(w) * 0.5
    }
    if (e.triggers.length) score *= triggered ? 1.25 : 0.8
    const cat = (e.skill.category ?? '').toLowerCase()
    const n = e.skill.name
    const coding = /coding|programming/.test(cat) || n.startsWith('frc-code-') || /^(code-review|debug-systematically|refactor-safely|git-workflow)$/.test(n)
    const technical = coding || /engineering|frc/.test(cat)
    if (score > 0 && codeish && coding) score *= 1.25
    if (score > 0 && !codeish && coding && !CURSOR.test(query)) score *= 0.8
    // In a code project, a code request rarely wants a Mac-app, office or business recipe.
    if (score > 0 && codeish && !technical) score *= o.codeProject ? 0.6 : 0.75
    // FRC: code questions want frc-code-*, mechanism and CAD questions frc-design-*.
    if (score > 0 && n.startsWith('frc-code-') && FRC_CODE.test(query)) score *= 1.3
    if (score > 0 && n.startsWith('frc-design-') && FRC_CODE.test(query) && !FRC_DESIGN.test(query)) score *= 0.8
    // FRC packs are very specific: without a robotics word they only win on strong matches.
    if (score > 0 && (/^frc/.test(cat) || n.startsWith('frc-')) && !FRC.test(query) && !kinds.has('wpilib')) score *= 0.6
    if ([...kinds].some((k) => KIND_SKILL[k] === n) && codeish) { score += 3.5; keep.add(n) }
    if (o.codeProject && n === 'coding-agent-loop' && CHANGE.test(query)) score += 6
    if (CURSOR.test(query) && /^(coding-cursor-orchestration|cursor-task-brief)$/.test(n)) score += 4
    if (LONG.test(query) && n === 'long-task-working-notes') score += 5
    // Yours and learned skills are specific to this user: a small edge on a tie.
    if (score > 0 && e.skill.source !== 'builtin') score *= 1.1
    // A one-word message ("thanks", "sure") is small talk unless it names a skill outright.
    if (score >= (qc.length <= 1 ? MIN_SCORE * 2 : MIN_SCORE)) out.push({ skill: e.skill, score: Math.round(score * 100) / 100 })
  }
  out.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
  // Keep the ones in the same league as the best (a weak tail is noise).
  return out.filter((r) => r.score >= out[0].score * 0.4 || keep.has(r.skill.name))
}

/** The body up to `room` characters, cut at a section or line boundary with a pointer to the rest. */
function clipBody(body: string, room: number): string | undefined {
  if (room < 400) return undefined
  const b = body.trim()
  if (b.length <= room) return b
  const cut = b.slice(0, room)
  const at = Math.max(cut.lastIndexOf('\n## '), cut.lastIndexOf('\n\n'))
  const end = at > room * 0.5 ? at : cut.lastIndexOf('\n')
  return `${cut.slice(0, end > 0 ? end : room).trimEnd()}\n(The rest: memory(action="read_skill", name).)`
}

/** Body lines with headings tagged by skill, so two skills' "## Steps" don't read as one (the context block skips repeated lines). */
function headed(body: string, name: string): string[] {
  return body.split('\n').map((l) => l.trimEnd()).filter(Boolean).map((l) => (/^#{1,4} /.test(l) ? `### ${name}: ${l.replace(/^#+ /, '')}` : l))
}

/** "frc-code-a, frc-code-b, frc-code-c" → "frc-code-{a, b, c}": families of three or more fold. */
export function foldNames(names: string[], cap = Infinity): string {
  const sorted = [...names].sort()
  const prefix = (n: string, parts: number): string | undefined => {
    const seg = n.split('-')
    return seg.length > parts ? `${seg.slice(0, parts).join('-')}-` : undefined
  }
  const out: string[] = []
  const done = new Set<string>()
  for (const parts of [2, 1]) {
    const fam = new Map<string, string[]>()
    for (const n of sorted) {
      if (done.has(n)) continue
      const p = prefix(n, parts)
      if (p) fam.set(p, [...(fam.get(p) ?? []), n])
    }
    for (const [p, ns] of fam) {
      if (ns.length < 3) continue
      // Hubs first when the list is cut ("start-here", "process", "agent-loop" point to the rest).
      const hub = (n: string): number => (/start-here|process|agent-loop|overview|basics/.test(n) ? 0 : 1)
      const shown = (Number.isFinite(cap) ? [...ns].sort((a, b) => hub(a) - hub(b) || a.localeCompare(b)) : ns).slice(0, cap).map((n) => n.slice(p.length))
      out.push(`${p}{${shown.join(', ')}${ns.length > cap ? `, +${ns.length - cap} more` : ''}}`)
      for (const n of ns) done.add(n)
    }
  }
  const rest = sorted.filter((n) => !done.has(n))
  const cut = Number.isFinite(cap) ? Math.max(cap * 2, 8) : Infinity
  return [...out, ...rest.slice(0, cut), ...(rest.length > cut ? [`+${rest.length - cut} more`] : [])].join(', ')
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

function render(s: Skill): string {
  return `---\nname: ${s.name}\ndescription: ${oneLine(s.description)}\nsource: ${s.source === 'builtin' ? 'you' : s.source}\nuses: ${s.uses}${s.category ? `\ncategory: ${s.category}` : ''}${s.untrusted ? '\nuntrusted: true' : ''}\n---\n\n${s.body}\n`
}

function parse(text: string, fallback: string): Omit<Skill, 'updatedAt'> | undefined {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!m) return { name: fallback, description: '', body: text.trim(), source: 'you', uses: 0 }
  const meta = Object.fromEntries(m[1].split('\n').map((l) => l.match(/^(\w+):\s*(.*)$/)).filter((x): x is RegExpMatchArray => !!x).map((x) => [x[1], x[2].trim()]))
  return { name: meta.name || fallback, description: meta.description ?? '', body: m[2].trim(), source: meta.source === 'learned' ? 'learned' : 'you', uses: Number(meta.uses) || 0, category: meta.category, ...(meta.untrusted === 'true' && meta.source === 'learned' ? { untrusted: true } : {}) }
}
