import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SiteLogin, SitePlaybook, SitePlaybookSummary, TeachStep } from '@shared/types'
import { bySite, emptyPlaybook, learnFromRun, learnFromTeach, prune, teachBySite, type RunOutcome, type SiteEvent } from './learn'
import { hasKnowledge, playbookNote, playbookText, summaryOf } from './render'
import { checkNote, domainOf, safeLabel, secretsOf, unsafeText } from './safe'

// Site playbooks on disk: one JSON file per registrable domain in the data folder's "sites" directory.
// The browser tool reports each call (record); when the run ends, its calls are folded into the
// playbooks of the sites they touched (endRun). A playbook's note goes into the first navigation to its
// site in a run (noteFor). Nothing here ever stores a typed value, a code, a card or a password.

export interface PlaybookEdit {
  purpose?: string | null
  notes?: string | null
  add_pitfall?: string
  remove_pitfall?: string
  add_flow?: { name: string; steps: string[] }
  remove_flow?: string
  login?: { method?: SiteLogin['method']; saved_login?: string; sso?: string; two_factor?: SiteLogin['twoFactor']; where?: SiteLogin['where'] }
}

const MAX_EVENTS = 400
/** A run that never reported its end (crash, quit): its log is dropped after this long. */
const STALE_RUN_MS = 6 * 3_600_000

const fileName = (domain: string): string => `${domain.toLowerCase().replace(/[^a-z0-9.-]+/g, '_').replace(/^\.+/, '').slice(0, 120) || 'site'}.json`

/** "example.com", "https://shop.example.com/x" or "shop.example.com" → the registrable domain. */
export function normalizeDomain(input: string): string {
  const s = String(input ?? '').trim()
  if (!s) return ''
  return domainOf(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`)
}

export class SiteStore {
  private runs = new Map<string, { events: SiteEvent[]; noted: Set<string>; at: number }>()

  /** secrets: saved passwords, card numbers and recent one-time codes (never stored, whatever field they turn up in). */
  constructor(private dir: string, private secrets: () => string[] = () => []) {
    mkdirSync(dir, { recursive: true })
  }

  private path(domain: string): string {
    return join(this.dir, fileName(domain))
  }

  get(domainOrUrl: string): SitePlaybook | undefined {
    const d = normalizeDomain(domainOrUrl)
    if (!d) return undefined
    const f = this.path(d)
    if (!existsSync(f)) return undefined
    try {
      const pb = JSON.parse(readFileSync(f, 'utf8')) as SitePlaybook
      return pb && pb.version === 1 && pb.domain === d ? pb : undefined
    } catch {
      return undefined
    }
  }

  save(pb: SitePlaybook): void {
    const f = this.path(pb.domain)
    const tmp = `${f}.tmp`
    writeFileSync(tmp, JSON.stringify(pb, null, 1))
    renameSync(tmp, f)
  }

  list(): SitePlaybookSummary[] {
    const out: SitePlaybookSummary[] = []
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue
      try {
        const pb = JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as SitePlaybook
        if (pb?.version === 1 && pb.domain) out.push(summaryOf(pb))
      } catch { /* a damaged file: skipped */ }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  forget(domainOrUrl: string): boolean {
    const d = normalizeDomain(domainOrUrl)
    if (!d) return false
    const f = this.path(d)
    if (!existsSync(f)) return false
    rmSync(f, { force: true })
    return true
  }

  // ------------------------------------------------------------- runs

  startRun(threadId: string): void {
    this.runs.set(threadId, { events: [], noted: new Set(), at: Date.now() })
  }

  private run(threadId: string): { events: SiteEvent[]; noted: Set<string>; at: number } {
    const now = Date.now()
    for (const [k, r] of this.runs) if (now - r.at > STALE_RUN_MS) this.runs.delete(k)
    let r = this.runs.get(threadId)
    if (!r) { r = { events: [], noted: new Set(), at: now }; this.runs.set(threadId, r) }
    r.at = now
    return r
  }

  /** One browser call finished (or failed) in a run. */
  record(threadId: string, e: SiteEvent): void {
    if (!threadId) return
    const r = this.run(threadId)
    if (r.events.length < MAX_EVENTS) r.events.push(e)
  }

  /** The run ended: its calls update the playbooks of the sites it used. Returns the domains updated. */
  endRun(threadId: string, outcome: RunOutcome, now = Date.now()): string[] {
    const r = this.runs.get(threadId)
    this.runs.delete(threadId)
    if (!r?.events.length) return []
    const secrets = secretsOf(this.secrets)
    const done: string[] = []
    for (const [domain, events] of bySite(r.events)) {
      try {
        const pb = learnFromRun(this.get(domain) ?? emptyPlaybook(domain, now), events, outcome, now, secrets)
        if (!hasKnowledge(pb) && !pb.pages.length) continue
        this.save(prune(pb, secrets))
        done.push(domain)
      } catch { /* learning is best-effort: never fails a run */ }
    }
    return done
  }

  /** The note for a page the agent just opened, once per site per run ('' when there's nothing to say). */
  noteFor(url: string, threadId?: string): string {
    const d = domainOf(url)
    if (!d) return ''
    if (threadId) {
      const r = this.run(threadId)
      if (r.noted.has(d)) return ''
      r.noted.add(d)
    }
    const pb = this.get(d)
    return pb ? playbookNote(pb) : ''
  }

  /** Elements this site's playbook knows, for the browser's find. */
  locators(url: string): Array<{ role: string; label: string }> {
    return (this.get(url)?.locators ?? []).map((l) => ({ role: l.role, label: l.label }))
  }

  /** One line for the user's own browser (Safari/Chrome): what SahilBot's browser already knows here. */
  hintFor(url: string): string {
    const pb = this.get(url)
    if (!pb || !hasKnowledge(pb)) return ''
    const signedIn = pb.login?.where !== 'user-browser' && pb.login?.method && pb.login.method !== 'unknown' && pb.login.method !== 'none'
    const flows = pb.flows.filter((f) => f.successes > 0).slice(0, 2).map((f) => `"${f.name}"`)
    return `SahilBot's own browser has a playbook for ${pb.domain}${signedIn ? ' with a saved sign-in' : ''}${flows.length ? ` (known flows: ${flows.join(', ')})` : ''}. If the user doesn't need their own browser session for this, it's faster and safer to do it there: browser {action:"navigate"}.`
  }

  /** A Teach recording finished: the shown steps become a flow on each site they used. */
  learnTeach(steps: TeachStep[], name?: string, now = Date.now()): string[] {
    const secrets = secretsOf(this.secrets)
    const done: string[] = []
    for (const [domain, s] of teachBySite(steps)) {
      try {
        this.save(prune(learnFromTeach(this.get(domain) ?? emptyPlaybook(domain, now), s, name, now, secrets), secrets))
        done.push(domain)
      } catch { /* best-effort */ }
    }
    return done
  }

  text(domainOrUrl: string): string | null {
    const pb = this.get(domainOrUrl)
    return pb ? playbookText(pb) : null
  }

  /**
   * The user's (or, with their OK, the model's) edits. Text is checked for secrets and personal details.
   * `by`: 'model' when SahilBot writes it with the sites tool: kept as "added by SahilBot", never as the user's.
   */
  edit(domainOrUrl: string, e: PlaybookEdit, now = Date.now(), by: 'user' | 'model' = 'user'): SitePlaybook {
    const model = by === 'model'
    const d = normalizeDomain(domainOrUrl)
    if (!d) throw new Error('Give a site domain such as "example.com".')
    const secrets = secretsOf(this.secrets)
    const pb = this.get(d) ?? emptyPlaybook(d, now)
    if (e.purpose !== undefined) {
      pb.purpose = e.purpose === null || e.purpose === '' ? undefined : checkNote(e.purpose, secrets, 200)
      if (pb.purpose && model) pb.purposeBy = 'model'; else delete pb.purposeBy
    }
    if (e.notes !== undefined) {
      pb.notes = e.notes === null || e.notes === '' ? undefined : checkNote(e.notes, secrets, 600)
      if (pb.notes && model) pb.notesBy = 'model'; else delete pb.notesBy
    }
    if (e.add_pitfall) {
      const t = checkNote(e.add_pitfall, secrets, 180)
      if (!pb.pitfalls.some((p) => p.text === t)) pb.pitfalls.push({ kind: 'tip', text: t, count: 1, lastSeen: now, source: by })
    }
    if (e.remove_pitfall) {
      const q = e.remove_pitfall.toLowerCase()
      const before = pb.pitfalls.length
      pb.pitfalls = pb.pitfalls.filter((p) => !p.text.toLowerCase().includes(q))
      if (pb.pitfalls.length === before) throw new Error(`No pitfall mentions "${e.remove_pitfall}".`)
    }
    if (e.add_flow) {
      const name = checkNote(e.add_flow.name, secrets, 60)
      const steps = (e.add_flow.steps ?? []).map((s) => checkNote(s, secrets, 200)).slice(0, 25)
      if (!steps.length) throw new Error('A flow needs at least one step.')
      const prev = pb.flows.find((f) => f.name.toLowerCase() === name.toLowerCase())
      if (prev) { prev.steps = steps; prev.source = by }
      else pb.flows.push({ name, steps, successes: 0, failures: 0, firstSeen: now, source: by })
    }
    if (e.remove_flow) {
      const q = e.remove_flow.toLowerCase()
      const before = pb.flows.length
      pb.flows = pb.flows.filter((f) => f.name.toLowerCase() !== q)
      if (pb.flows.length === before) throw new Error(`No flow named "${e.remove_flow}". Flows: ${pb.flows.map((f) => `"${f.name}"`).join(', ') || 'none'}.`)
    }
    if (e.login) {
      const l = e.login
      const saved = l.saved_login !== undefined ? safeLabel(l.saved_login, secrets, 40) : undefined
      if (l.saved_login && !saved) throw new Error('That saved-login name can\'t be stored (it looks like a secret or personal detail). Use the login\'s name from Settings > Passwords.')
      if (l.sso && unsafeText(l.sso, secrets)) throw new Error('That SSO name can\'t be stored.')
      pb.login = {
        ...(pb.login ?? { method: 'unknown' }),
        ...(l.method ? { method: l.method } : {}),
        ...(saved ? { savedLogin: saved } : {}),
        ...(l.sso ? { sso: l.sso.slice(0, 40) } : {}),
        ...(l.two_factor ? { twoFactor: l.two_factor } : {}),
        ...(l.where ? { where: l.where } : {})
      }
      if (model) pb.login.by = 'model'; else delete pb.login.by
    }
    pb.updatedAt = now
    this.save(prune(pb, secrets))
    return pb
  }
}
