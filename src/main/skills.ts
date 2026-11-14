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

  private builtin(): Skill[] {
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
   * built-in packs as names grouped by topic (the names say what they do), so the prompt stays small.
   * Skills marked `untrusted: true` are left out until approved.
   */
  index(max = 40): string {
    // Unverified learned skills wait for the user's OK (Settings → Memory → What I learned).
    const all = this.list().filter((s) => !s.untrusted)
    const mine = all.filter((s) => s.source !== 'builtin').slice(0, max).map((s) => `- ${s.name}: ${s.description}`)
    const groups = new Map<string, string[]>()
    for (const s of all.filter((x) => x.source === 'builtin')) groups.set(s.category ?? 'General', [...(groups.get(s.category ?? 'General') ?? []), s.name])
    const packs = [...groups].map(([cat, names]) => `- ${cat}: ${names.join(', ')}`)
    return [...mine, ...(packs.length ? ['Built-in skills by topic:', ...packs] : [])].join('\n')
  }
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
