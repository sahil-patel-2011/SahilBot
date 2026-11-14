import type { SiteFlow, SitePitfall, SitePitfallKind, SitePlaybook, TeachStep } from '@shared/types'
import { domainOf, elementText, hostOf, safeLabel, safePath, splitTitle, unsafeText } from './safe'

// How a playbook learns, without a model: from the log of the agent's own browser calls in a run (what
// it clicked, typed into and opened, and what each call reported back), and from Teach recordings.
// Steps are built only from the agent's actions and the role + accessible name of their targets; text
// a page shows is never turned into a step. Typed values are never kept (only "Type the text into …").

/** One browser call, as the playbook sees it (recorded by the browser tool). */
export interface SiteEvent {
  at: number
  action: string
  /** The page the action ran on. */
  url: string
  /** The page afterwards (navigations). */
  after?: string
  /** The page's title afterwards. */
  title?: string
  /** The page's title before. */
  titleBefore?: string
  target?: { role: string; name: string; password?: boolean; payment?: string; navLink?: boolean }
  fields?: Array<{ role: string; name: string; select?: boolean; secret?: boolean }>
  submit?: boolean
  submitTarget?: { role: string; name: string }
  ok: boolean
  error?: string
  /** What the call reported: navigated, changed, nochange, newtab, dialog, download, cookie-declined, cookie-acceptonly, human:<kind>, purchase-approved, purchase-declined, rate-limit, stale, covered:<what>, disabled. */
  tags: string[]
  /** fill_secret: the saved login's name (never its values) and which field. */
  login?: string
  field?: string
  /** fill_otp: where the code came from. */
  otp?: string
  section?: string
  op?: string
}

export type RunOutcome = 'finished' | 'stopped' | 'error'

const LIMITS = { pages: 25, locators: 30, flows: 10, pitfalls: 12, hosts: 8, steps: 15 }
const INTERACTIVE = new Set(['click', 'type', 'select', 'fill_form', 'fill_secret', 'fill_otp', 'fill_address', 'fill_payment', 'upload', 'dialog', 'enter'])
/** Single sign-on hosts: a page that sends you there to sign in uses SSO. */
const IDP: Array<[RegExp, string]> = [
  [/(^|\.)accounts\.google\.com$/, 'Google'], [/(^|\.)login\.microsoftonline\.com$|(^|\.)login\.live\.com$/, 'Microsoft'],
  [/(^|\.)appleid\.apple\.com$/, 'Apple'], [/(^|\.)okta\.com$|(^|\.)oktapreview\.com$/, 'Okta'], [/(^|\.)auth0\.com$/, 'Auth0'],
  [/(^|\.)github\.com$/, 'GitHub'], [/(^|\.)facebook\.com$/, 'Facebook'], [/(^|\.)onelogin\.com$/, 'OneLogin'], [/(^|\.)duosecurity\.com$/, 'Duo']
]

export function emptyPlaybook(domain: string, now = Date.now()): SitePlaybook {
  return { version: 1, domain, hosts: [], pages: [], locators: [], flows: [], pitfalls: [], visits: 0, createdAt: now, updatedAt: now }
}

/** Which playbook an event belongs to: the page it ran on (a navigation: the page it opened). */
export function eventDomain(e: SiteEvent): string {
  return e.action === 'navigate' ? domainOf(e.after ?? e.url) : domainOf(e.url) || domainOf(e.after)
}

const isSearch = (t?: { role: string; name: string }): boolean => !!t && (t.role === 'searchbox' || /\bsearch\b/i.test(t.name))

function target(t: { role: string; name: string } | undefined, secrets: string[]): string | null {
  if (!t) return null
  const label = safeLabel(t.name, secrets)
  return label ? elementText(t.role, label) : null
}

function pageName(title: string | undefined, url: string | undefined, secrets: string[]): string {
  return splitTitle(title, secrets).page || safePath(url) || '/'
}

/** One event as a playbook step, or null (reads, scrolls, and anything with an unsafe label). */
export function stepOf(e: SiteEvent, secrets: string[] = []): string | null {
  const t = target(e.target, secrets)
  const purchase = e.tags.includes('purchase-approved') ? ' (a purchase step: the user approves it on a Purchase card)' : ''
  switch (e.action) {
    case 'navigate': { const p = safePath(e.after ?? e.url); return p ? `Open ${p}` : null }
    case 'click': return t ? `Click ${t}${purchase}` : null
    case 'enter': return t ? `Press Enter in ${t}${purchase}` : null
    case 'type': return t ? `Type ${isSearch(e.target) ? 'the search text' : 'the text'} into ${t}${e.submit ? ' and press Enter' : ''}${purchase}` : null
    case 'select': return t ? `Choose an option in ${t}` : null
    case 'fill_form': {
      const names = (e.fields ?? []).map((f) => safeLabel(f.name, secrets)).filter((x): x is string => !!x)
      const sub = target(e.submitTarget, secrets)
      if (!names.length && !sub) return null
      return `Fill ${(e.fields ?? []).length} field${(e.fields ?? []).length === 1 ? '' : 's'}${names.length ? ` (${names.slice(0, 6).map((n) => `"${n}"`).join(', ')})` : ''} with fill_form${sub ? ` and click ${sub}` : ''}${purchase}`
    }
    case 'fill_secret': {
      const login = safeLabel(e.login, secrets, 40)
      return `Fill the saved login${login ? ` "${login}"` : ''} (${e.field === 'username' ? 'username' : 'password'}) with fill_secret${t ? ` into ${t}` : ''}`
    }
    case 'fill_otp': return `Fill the one-time code with fill_otp (source "${e.otp ?? 'authenticator'}")`
    case 'fill_address': return `Fill a saved ${e.section === 'billing' ? 'billing' : 'shipping'} address with fill_address`
    case 'fill_payment': return 'Fill a saved card with fill_payment (the user approves it on a Purchase card)'
    case 'dialog': return 'Answer OK to the page\'s dialog'
    case 'upload': return t ? `Upload the file into ${t}` : 'Upload the file'
    case 'extract': return 'Read the data with extract'
    case 'downloads': return e.op === 'save' ? 'Save the offered download (downloads op=save; the user approves)' : null
    default: return null
  }
}

/** Steps for a run of events: consecutive plain typing merged, repeats and empty opens dropped. */
export function stepsOf(events: SiteEvent[], secrets: string[] = []): string[] {
  const out: string[] = []
  let typing: string[] = []
  const flush = (): void => {
    if (typing.length === 1) out.push(`Type the text into ${typing[0]}`)
    else if (typing.length > 1) out.push(`Type the text into ${typing.join(', ')}`)
    typing = []
  }
  for (const e of events) {
    if (!e.ok) continue
    if (e.action === 'type' && !e.submit && !isSearch(e.target) && !e.tags.includes('purchase-approved')) {
      const t = target(e.target, secrets)
      if (t) { if (!typing.includes(t)) typing.push(t); continue }
    }
    const s = stepOf(e, secrets)
    if (!s) continue
    flush()
    if (out.at(-1) === s) continue
    // Two opens in a row: only the second one matters (the first was on the way).
    if (s.startsWith('Open ') && out.at(-1)?.startsWith('Open ')) out.pop()
    out.push(s)
  }
  flush()
  // A trailing open is where the flow ended up, not a step of it.
  while (out.length > 1 && out.at(-1)!.startsWith('Open ')) out.pop()
  return out.slice(-LIMITS.steps)
}

/** Where the sign-in part of a run ends (the first submit after the saved password or the one-time code), or -1. */
function signInEnd(events: SiteEvent[]): number {
  let last = -1
  for (let i = 0; i < events.length; i++) if (events[i].ok && ((events[i].action === 'fill_secret' && events[i].field !== 'username') || events[i].action === 'fill_otp')) last = i
  if (last < 0) return -1
  for (let i = last + 1; i < events.length; i++) {
    const e = events[i]
    if (e.ok && (e.action === 'click' || e.action === 'enter' || (e.action === 'type' && e.submit) || (e.action === 'fill_form' && e.submitTarget))) return i
  }
  return last
}

function flowName(events: SiteEvent[], secrets: string[]): string {
  // The last thing the flow did (or tried to do: a failed attempt is named like the flow it failed).
  const acts = events.filter((e) => INTERACTIVE.has(e.action))
  const last = acts.at(-1)
  const where = last ? pageName(last.titleBefore, last.url, secrets) : ''
  let label: string | null = null
  if (last?.action === 'click' || last?.action === 'enter') label = safeLabel(last.target?.name, secrets, 40)
  else if (last?.action === 'fill_form') label = safeLabel(last.submitTarget?.name, secrets, 40)
  else if (last?.action === 'type' && isSearch(last.target)) label = 'Search'
  else if (last?.action === 'type' && last.submit) label = `Submit ${safeLabel(last.target?.name, secrets, 30) ?? 'the form'}`
  const base = label ?? (where ? `Use ${where}` : 'Task')
  return where && label && label.toLowerCase() !== where.toLowerCase() ? `${base} (${where})` : base
}

function upsertFlow(pb: SitePlaybook, f: { name: string; steps: string[]; ok: boolean; source: SiteFlow['source'] }, now: number): void {
  if (!f.steps.length) return
  const sig = f.steps.join('\n')
  const same = pb.flows.find((x) => x.steps.join('\n') === sig) ?? pb.flows.find((x) => x.name === f.name)
  if (!f.ok) {
    if (same) { same.failures++; same.lastFailure = now }
    return
  }
  if (same) {
    same.successes++
    same.lastSuccess = now
    // The newest way that worked replaces an older one with the same name.
    if (same.steps.join('\n') !== sig) same.steps = f.steps
    if (same.source !== 'user') same.name = same.name || f.name
    return
  }
  pb.flows.push({ name: f.name, steps: f.steps, successes: 1, failures: 0, firstSeen: now, lastSuccess: now, source: f.source })
}

function addPitfall(pb: SitePlaybook, kind: SitePitfallKind, text: string, now: number, source: SitePitfall['source'] = 'run'): void {
  const t = text.slice(0, 180)
  const same = pb.pitfalls.find((p) => p.text === t)
  if (same) { same.count++; same.lastSeen = now; return }
  pb.pitfalls.push({ kind, text: t, count: 1, lastSeen: now, source })
}

function addPage(pb: SitePlaybook, path: string, name: string, how: string | undefined, now: number): void {
  if (!path) return
  const p = pb.pages.find((x) => x.path === path)
  if (p) {
    p.seen++
    p.lastSeen = now
    if (name && name !== path) p.name = name
    // A route through the site's own links beats "open the address".
    if (how && (!p.how || p.how === 'open the address')) p.how = how
    return
  }
  pb.pages.push({ name: name || path, path, ...(how ? { how } : {}), seen: 1, lastSeen: now })
}

function addLocator(pb: SitePlaybook, role: string, label: string, page: string | undefined, now: number): void {
  const l = pb.locators.find((x) => x.role === role && x.label === label)
  if (l) { l.uses++; l.lastUsed = now; if (page) l.page = page; return }
  pb.locators.push({ role, label, ...(page ? { page } : {}), uses: 1, lastUsed: now })
}

/** What a failed call teaches (a pitfall), if anything. */
function pitfallOfError(e: SiteEvent, secrets: string[]): [SitePitfallKind, string] | null {
  const msg = e.error ?? ''
  const t = target(e.target, secrets) ?? 'the element'
  if (/^Unknown ref|is gone from the page|matches several elements/i.test(msg)) return ['stale', 'The page re-renders while you work: refs go stale fast; snapshot (or find) right before acting.']
  if (/is disabled/i.test(msg)) return ['disabled', `${t} stays disabled until the form's required fields are filled.`]
  if (/not a dropdown/i.test(msg)) return ['tip', `${t} is not a real dropdown: click it, then click the option.`]
  if (/^Waited \d+s/i.test(msg)) return ['error', 'Slow to update after actions: use wait {text} for the result instead of snapshotting right away.']
  if (/Couldn't find card fields|card fields not found/i.test(msg)) return ['tip', 'Card fields are in a frame SahilBot can\'t fill: the user enters the card in the browser panel.']
  if (/Couldn't find .* address fields/i.test(msg)) return ['tip', 'Address fields aren\'t recognized by fill_address: fill them with fill_form.']
  if (/needs you|nobody is here to approve|can't click or submit on a shopping/i.test(msg)) return null
  if (/taken over the browser/i.test(msg)) return null
  return null
}

/**
 * Updates one site's playbook with a run's events on it (in order). Pages, element locators, the sign-in
 * method and pitfalls are learned whatever the outcome; flows are credited only when the run finished and
 * the flow's last step worked, and a failed attempt at a known flow counts as a failure.
 */
export function learnFromRun(pb: SitePlaybook, events: SiteEvent[], outcome: RunOutcome, now = Date.now(), secrets: string[] = []): SitePlaybook {
  if (!events.length) return pb
  pb.visits++
  pb.updatedAt = now
  for (const e of events) for (const u of [e.url, e.after]) {
    const h = hostOf(u)
    if (h && domainOf(u) === pb.domain && !pb.hosts.includes(h)) pb.hosts.push(h)
  }
  // The site's own name: the part of its page titles after the separator, most often seen.
  const names = new Map<string, number>()
  for (const e of events) for (const t of [e.title, e.titleBefore]) { const s = splitTitle(t, secrets).site; if (s) names.set(s, (names.get(s) ?? 0) + 1) }
  const top = [...names].sort((a, b) => b[1] - a[1])[0]?.[0]
  if (top && !pb.siteName) pb.siteName = top

  // Pages, and how they were reached.
  let prevName = ''
  for (const e of events) {
    const landed = e.action === 'navigate' ? e.after ?? e.url : e.tags.includes('navigated') ? e.after : undefined
    if (e.ok && landed && domainOf(landed) === pb.domain) {
      const path = safePath(landed)
      const name = pageName(e.title, landed, secrets)
      const via = e.action === 'click' && e.target?.navLink !== false && prevName ? target(e.target, secrets) : null
      addPage(pb, path, name, e.action === 'navigate' ? 'open the address' : via ? `${via} on ${prevName}` : undefined, now)
    }
    if (e.ok && (e.title || e.titleBefore)) prevName = pageName(e.title || e.titleBefore, e.after ?? e.url, secrets)
  }

  // Elements that worked: role + accessible name.
  for (const e of events) {
    if (!e.ok || !INTERACTIVE.has(e.action) || e.tags.includes('nochange')) continue
    const where = pageName(e.titleBefore, e.url, secrets)
    const list = [e.target, e.submitTarget, ...(e.fields ?? [])].filter((x): x is { role: string; name: string } => !!x)
    for (const t of list) {
      const label = safeLabel(t.name, secrets)
      if (label && t.role !== 'StaticText') addLocator(pb, t.role, label, where, now)
    }
  }

  // Signing in: a saved login (by name), single sign-on, and the second step.
  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    const next = e.after && domainOf(e.after) !== pb.domain ? hostOf(e.after) : ''
    const idp = next ? IDP.find(([re]) => re.test(next))?.[1] : undefined
    if (idp && e.ok && domainOf(e.url) === pb.domain) pb.login = { ...(pb.login ?? {}), method: pb.login?.method === 'password' ? 'password' : 'sso', sso: idp, where: 'sahilbot' }
    if (e.action === 'fill_secret' && e.ok) {
      const login = safeLabel(e.login, secrets, 40) ?? undefined
      pb.login = { ...(pb.login ?? {}), method: 'password', ...(login ? { savedLogin: login } : {}), loginPath: safePath(e.url) || pb.login?.loginPath, where: 'sahilbot' }
    }
    if (e.action === 'fill_otp' && e.ok) pb.login = { ...(pb.login ?? { method: 'unknown' }), twoFactor: e.otp === 'email' || e.otp === 'sms' ? e.otp : 'authenticator' }
    if (e.tags.includes('human:verification code') && !pb.login?.twoFactor) pb.login = { ...(pb.login ?? { method: 'unknown' }), twoFactor: 'unknown' }
  }

  // Pitfalls: what got in the way (learned from failures too).
  for (const e of events) {
    const t = target(e.target, secrets) ?? 'the element'
    if (e.tags.includes('cookie-declined')) addPitfall(pb, 'cookie', 'Shows a cookie banner; SahilBot declines it automatically (reject option).', now)
    if (e.tags.includes('cookie-acceptonly')) addPitfall(pb, 'cookie', 'Its cookie banner has no reject option: it stays up and can cover buttons.', now)
    const human = e.tags.find((x) => x.startsWith('human:') && x !== 'human:verification code')
    if (human) addPitfall(pb, 'human_check', `Shows a ${safeLabel(human.slice(6), secrets, 40) ?? 'human check'}: the user completes it in the browser panel.`, now)
    if (e.tags.includes('rate-limit')) addPitfall(pb, 'rate_limit', 'Rate-limits fast use ("too many requests"): go slower and wait between pages.', now)
    if (e.tags.includes('stale')) addPitfall(pb, 'stale', 'The page re-renders while you work: refs go stale fast; snapshot (or find) right before acting.', now)
    const cov = e.tags.find((x) => x.startsWith('covered:'))
    if (cov) addPitfall(pb, 'covered', `${t} can be covered by ${safeLabel(cov.slice(8).replace(/^a /, ''), secrets, 60) ?? 'an overlay'}: close or answer it first.`, now)
    if (e.tags.includes('disabled')) addPitfall(pb, 'disabled', `${t} stays disabled until the form's required fields are filled.`, now)
    if (e.ok && e.action === 'click' && e.tags.includes('nochange')) addPitfall(pb, 'no_change', `Clicking ${t} showed no visible change.`, now)
    if (e.ok && e.action === 'click' && e.tags.includes('newtab')) addPitfall(pb, 'popup', `${t} opens a new tab (tabs op=switch to follow it).`, now)
    if (e.ok && (e.action === 'click' || e.action === 'enter') && e.tags.includes('dialog')) addPitfall(pb, 'popup', `${t} opens a confirm dialog: it's answered Cancel unless you accept it with the dialog action.`, now)
    if (e.ok && e.tags.includes('download') && /export|download|csv|excel|xlsx|pdf|report/i.test(e.target?.name ?? '')) addPitfall(pb, 'tip', `Has an export: ${t} offers a file; prefer it over reading the page (downloads op=save).`, now)
    if (e.ok && e.action === 'extract') addPitfall(pb, 'tip', 'Its data reads cleanly with extract (no need to read the whole page).', now)
    if (!e.ok) { const p = pitfallOfError(e, secrets); if (p) addPitfall(pb, p[0], p[1], now) }
  }

  // Flows: the sign-in part and the task part, credited when the run finished and the last step worked.
  const split = signInEnd(events)
  const parts = split >= 0 ? [{ name: 'Sign in', events: events.slice(0, split + 1) }, { name: '', events: events.slice(split + 1) }] : [{ name: '', events }]
  for (const part of parts) {
    const acts = part.events.filter((e) => INTERACTIVE.has(e.action))
    if (!acts.length) continue
    const last = acts.at(-1)!
    const steps = stepsOf(part.events, secrets)
    if (!steps.some((s) => !s.startsWith('Open '))) continue
    const declined = part.events.some((e) => e.tags.includes('purchase-declined'))
    if (declined) continue
    const ok = outcome === 'finished' && last.ok
    if (outcome === 'stopped' && last.ok) continue
    upsertFlow(pb, { name: part.name || flowName(part.events, secrets), steps, ok, source: 'run' }, now)
    if (ok) pb.lastVerified = now
    if (ok && part.name === 'Sign in' && pb.login) pb.login.verified = now
  }
  return prune(pb)
}

/** Teach recordings: the user's own demonstration becomes a flow (shown once), plus its pages and elements. */
export function learnFromTeach(pb: SitePlaybook, steps: TeachStep[], name: string | undefined, now = Date.now(), secrets: string[] = []): SitePlaybook {
  if (!steps.length) return pb
  pb.updatedAt = now
  const out: string[] = []
  for (const s of steps) {
    const label = safeLabel(s.name, secrets)
    const el = label ? elementText(s.role || 'element', label) : null
    let step: string | null = null
    switch (s.kind) {
      case 'navigate': {
        const p = safePath(s.url)
        if (p && domainOf(s.url) === pb.domain) {
          addPage(pb, p, p, s.cause === 'address' ? 'open the address' : undefined, now)
          const h = hostOf(s.url)
          if (h && !pb.hosts.includes(h)) pb.hosts.push(h)
        }
        if (s.cause === 'address' && p) step = `Open ${p}`
        break
      }
      case 'click':
        if (el) { step = `Click ${el}`; if (s.role && s.role !== 'generic') addLocator(pb, s.role, label!, undefined, now) }
        break
      case 'type':
        if (s.secret) { step = `Fill the saved login with fill_secret${el ? ` into ${el}` : ''}`; if (/pass/i.test(`${s.name} ${s.inputType} ${s.autocomplete}`)) pb.login = { ...(pb.login ?? {}), method: 'password', where: 'sahilbot' } }
        else if (el) step = `Type the text into ${el}`
        if (el && s.role) addLocator(pb, s.role, label!, undefined, now)
        break
      case 'select':
        if (el) step = `Choose an option in ${el}`
        break
      case 'key':
        if (s.key && /^(Enter|Escape|Shift\+Enter)$/.test(s.key)) step = `Press ${s.key}${el ? ` in ${el}` : ''}`
        break
      case 'download':
        step = 'Save the offered download (downloads op=save; the user approves)'
        addPitfall(pb, 'tip', 'Has an export: a file download was part of the shown task; prefer it over reading the page (downloads op=save).', now, 'teach')
        break
      case 'tab':
        if (s.op === 'switch') step = 'Switch to the other tab (tabs op=switch)'
        break
      case 'history':
        if (s.op === 'back') step = 'Go back'
        break
    }
    if (step && out.at(-1) !== step) out.push(step)
  }
  const flowLabel = safeLabel(name, secrets, 60) ?? 'Shown task'
  if (out.length) {
    const existing = pb.flows.find((f) => f.name === flowLabel && f.source === 'teach')
    if (existing) { existing.steps = out.slice(0, LIMITS.steps + 5); existing.successes++; existing.lastSuccess = now }
    else pb.flows.push({ name: flowLabel, steps: out.slice(0, LIMITS.steps + 5), successes: 1, failures: 0, firstSeen: now, lastSuccess: now, source: 'teach' })
  }
  return prune(pb)
}

/** Keeps a playbook small: the most used and most recent entries. Also drops anything unsafe that slipped in. */
export function prune(pb: SitePlaybook, secrets: string[] = []): SitePlaybook {
  const recent = <T>(xs: T[], score: (x: T) => number, n: number): T[] => [...xs].sort((a, b) => score(b) - score(a)).slice(0, n)
  pb.pages = recent(pb.pages.filter((p) => !unsafeText(p.name, secrets) || p.name === p.path), (p) => p.seen * 1e13 + p.lastSeen, LIMITS.pages)
  pb.locators = recent(pb.locators, (l) => l.uses * 1e13 + l.lastUsed, LIMITS.locators)
  pb.flows = recent(pb.flows, (f) => (f.source === 'user' ? 1e15 : 0) + (f.successes - f.failures) * 1e13 + (f.lastSuccess ?? f.firstSeen), LIMITS.flows)
  pb.pitfalls = recent(pb.pitfalls, (p) => (p.source === 'user' ? 1e15 : 0) + p.count * 1e13 + p.lastSeen, LIMITS.pitfalls)
  pb.hosts = pb.hosts.slice(0, LIMITS.hosts)
  return pb
}

/** Groups a run's events by the site they happened on, keeping their order. */
export function bySite(events: SiteEvent[]): Map<string, SiteEvent[]> {
  const out = new Map<string, SiteEvent[]>()
  for (const e of events) {
    const d = eventDomain(e)
    if (!d) continue
    out.set(d, [...(out.get(d) ?? []), e])
  }
  return out
}

/** Teach steps grouped by the site each happened on (steps after a navigation belong to its site, per tab). */
export function teachBySite(steps: TeachStep[]): Map<string, TeachStep[]> {
  const out = new Map<string, TeachStep[]>()
  const siteOfTab = new Map<number, string>()
  for (const s of steps) {
    const tab = s.tab ?? 1
    if (s.kind === 'navigate' || (s.kind === 'tab' && s.url)) { const d = domainOf(s.url); if (d) siteOfTab.set(tab, d) }
    const d = siteOfTab.get(tab)
    if (!d) continue
    out.set(d, [...(out.get(d) ?? []), s])
  }
  return out
}
