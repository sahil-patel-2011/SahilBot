import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Rule } from '@shared/types'
import { slug } from './skills'

// Rules: standing instructions the agent always follows (like Cursor rules). Built-in packs ship with
// the app (read-only, switch on or off); you and the agents can add your own. A rule applies
// everywhere, to one bot, or to one project. Enabled rules go into the system prompt of new chats.

export class RuleStore {
  private statePath: string

  constructor(private dir: string, private builtinDir: string) {
    mkdirSync(dir, { recursive: true })
    this.statePath = join(dir, '_enabled.json')
  }

  private enabledMap(): Record<string, boolean> {
    try { return JSON.parse(readFileSync(this.statePath, 'utf8')) as Record<string, boolean> } catch { return {} }
  }

  list(): Rule[] {
    const on = this.enabledMap()
    const read = (dir: string, source: Rule['source']): Rule[] => !existsSync(dir) ? [] : readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => {
      const r = parse(readFileSync(join(dir, f), 'utf8'), f.replace(/\.md$/, ''), source)
      return { ...r, enabled: on[r.name] ?? r.enabled }
    })
    const mine = read(this.dir, 'you')
    const builtin = read(this.builtinDir, 'builtin').filter((b) => !mine.some((m) => m.name === b.name))
    return [...mine, ...builtin].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.category.localeCompare(b.category) || a.name.localeCompare(b.name))
  }

  save(r: { name: string; text: string; scope?: string; category?: string; source?: Rule['source'] }): Rule {
    const name = slug(r.name)
    if (!name) throw new Error('Give the rule a short name.')
    const rule: Rule = { name, text: r.text.trim().slice(0, 4000), scope: r.scope || 'everywhere', category: r.category || 'Mine', enabled: true, source: r.source ?? 'you' }
    writeFileSync(join(this.dir, `${name}.md`), render(rule))
    this.setEnabled(name, true)
    return rule
  }

  setEnabled(name: string, enabled: boolean): void {
    const on = this.enabledMap()
    on[name] = enabled
    writeFileSync(this.statePath, JSON.stringify(on, null, 2))
  }

  remove(name: string): void {
    rmSync(join(this.dir, `${slug(name)}.md`), { force: true })
  }

  /** Rules for a new chat with this bot / in this project. */
  block(botId?: string, projectId?: string): string {
    return this.list()
      .filter((r) => r.enabled && (r.scope === 'everywhere' || r.scope === `bot:${botId}` || r.scope === `project:${projectId}`))
      .map((r) => `- ${r.text.replace(/\n+/g, ' ')}`)
      .join('\n')
  }
}

function render(r: Rule): string {
  return `---\nname: ${r.name}\nscope: ${r.scope}\ncategory: ${r.category}\nenabled: ${r.enabled}\nsource: ${r.source}\n---\n\n${r.text}\n`
}

function parse(text: string, fallback: string, source: Rule['source']): Rule {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  const meta = m ? Object.fromEntries(m[1].split('\n').map((l) => l.match(/^(\w+):\s*(.*)$/)).filter((x): x is RegExpMatchArray => !!x).map((x) => [x[1], x[2].trim()])) : {}
  return {
    name: meta.name || fallback,
    text: (m ? m[2] : text).trim(),
    scope: meta.scope || 'everywhere',
    category: meta.category || 'General',
    enabled: meta.enabled ? meta.enabled === 'true' : source !== 'builtin',
    source: source === 'builtin' ? 'builtin' : meta.source === 'learned' ? 'learned' : 'you'
  }
}
