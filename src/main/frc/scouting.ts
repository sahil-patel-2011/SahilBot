// Scouting data from Statbotics (EPA ratings and predictions, no key) and The Blue Alliance API v3
// (schedules, results, rankings; needs a read key from https://www.thebluealliance.com/account).
// Statbotics API: https://api.statbotics.io/docs  ·  TBA API: https://www.thebluealliance.com/apidocs
// Responses are cached in memory; everything returned is outside data (untrusted).

export const STATBOTICS = 'https://api.statbotics.io/v3'
export const TBA = 'https://www.thebluealliance.com/api/v3'
const UA = 'SahilBot/1.0 (FRC software assistant)'
const SB_TTL = 10 * 60_000

type Fetch = typeof fetch
interface Cached { at: number; body: unknown; etag?: string; maxAgeMs: number }
const cache = new Map<string, Cached>()
export const clearScoutingCache = (): void => cache.clear()

export async function getJson(url: string, opts: { signal?: AbortSignal; headers?: Record<string, string>; fetchImpl?: Fetch; ttlMs?: number } = {}): Promise<{ body: unknown; cached: boolean }> {
  const hit = cache.get(url)
  if (hit && Date.now() - hit.at < hit.maxAgeMs) return { body: hit.body, cached: true }
  const f = opts.fetchImpl ?? fetch
  const headers: Record<string, string> = { 'user-agent': UA, accept: 'application/json', ...opts.headers }
  if (hit?.etag) headers['if-none-match'] = hit.etag
  const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000)
  const res = await f(url, { headers, signal })
  const host = new URL(url).host
  if (res.status === 304 && hit) { hit.at = Date.now(); return { body: hit.body, cached: true } }
  if (res.status === 401) throw new Error(`${host} refused the request (401). The Blue Alliance needs a read API key: add it in Settings → Keys (get one at https://www.thebluealliance.com/account).`)
  if (res.status === 404) throw new Error(`${host}: not found (404). Check the team number or event key (event keys look like 2026casj).`)
  const text = await res.text()
  // Statbotics answers 500 with an empty {} or [] when its database is offline (e.g. in the offseason).
  if (res.status >= 500) throw new Error(`${host} is unavailable right now (${res.status}${/^\s*(\{\}|\[\])\s*$/.test(text) ? ', empty body' : ''}). Try again later, or use The Blue Alliance / the event's website.`)
  if (!res.ok) throw new Error(`${host} answered ${res.status}: ${text.slice(0, 160)}`)
  let body: unknown
  try { body = JSON.parse(text) } catch { throw new Error(`${host} sent something that isn't JSON.`) }
  const cc = res.headers.get('cache-control') ?? ''
  const maxAge = Number(cc.match(/max-age=(\d+)/)?.[1])
  cache.set(url, { at: Date.now(), body, etag: res.headers.get('etag') ?? undefined, maxAgeMs: /no-cache|no-store/.test(cc) ? 0 : Number.isFinite(maxAge) ? maxAge * 1000 : (opts.ttlMs ?? SB_TTL) })
  if (cache.size > 300) cache.delete(cache.keys().next().value!)
  return { body, cached: false }
}

// ---------------------------------------------------------------- formatting (exported for tests)

const num = (x: unknown, d = 1): string => (typeof x === 'number' && Number.isFinite(x) ? x.toFixed(d) : '?')
/** EPA total: a number since mid-2026, an object {mean, sd} before that. */
export const epaTotal = (epa: any): number | undefined => {
  const t = epa?.total_points
  return typeof t === 'number' ? t : typeof t?.mean === 'number' ? t.mean : undefined
}
const rec = (r: any): string => (r && typeof r.wins === 'number' ? `${r.wins}-${r.losses}-${r.ties}` : '?')

export function formatTeam(team: any, teamYear?: any): string {
  const L = [`# Team ${team?.team ?? '?'}: ${team?.name ?? ''}`]
  L.push(`${[team?.state, team?.country].filter(Boolean).join(', ')}${team?.district ? ` · district ${team.district}` : ''} · rookie year ${team?.rookie_year ?? '?'}${team?.active === false ? ' · inactive' : ''}`)
  if (team?.record) L.push(`All-time record ${rec(team.record)} (win rate ${num((team.record.winrate ?? 0) * 100, 0)}%)`)
  if (team?.norm_epa) L.push(`Normalized EPA: current ${num(team.norm_epa.current, 0)}, recent ${num(team.norm_epa.recent, 0)}, best ${num(team.norm_epa.max, 0)}`)
  if (teamYear) {
    const e = teamYear.epa ?? {}
    L.push('', `## ${teamYear.year}`)
    L.push(`EPA ${num(epaTotal(e))} points${e.stats ? ` (start ${num(e.stats.start)}, pre-champs ${num(e.stats.pre_champs)}, peak ${num(e.stats.max)})` : ''}`)
    const r = e.ranks ?? {}
    const rk = (x: any, label: string): string | null => (x?.rank ? `${label} #${x.rank}/${x.team_count}` : null)
    const ranks = [rk(r.total, 'world'), rk(r.country, 'country'), rk(r.state, 'state'), rk(r.district, 'district')].filter(Boolean)
    if (ranks.length) L.push(`EPA rank: ${ranks.join(', ')}`)
    if (e.breakdown) L.push(`Breakdown: ${Object.entries(e.breakdown).filter(([k, v]) => typeof v === 'number' && !/^rp_\d$/.test(k)).map(([k, v]) => `${k} ${num(v)}`).join(', ')}`)
    if (teamYear.record) L.push(`Season record ${rec(teamYear.record)}`)
    if (teamYear.competing?.next_event_name) L.push(`Next event: ${teamYear.competing.next_event_name} (${teamYear.competing.next_event_key}, week ${teamYear.competing.next_event_week})`)
  }
  L.push('', `Source: Statbotics (https://www.statbotics.io/team/${team?.team ?? ''}). EPA estimates a team's average point contribution; treat it as a model, not a measurement.`)
  return L.join('\n')
}

export function formatEvent(event: any, teamEvents: any[]): string {
  const L = [`# ${event?.name ?? event?.key} (${event?.key})`]
  L.push(`${event?.start_date ?? '?'} → ${event?.end_date ?? '?'} · ${event?.type ?? ''} · week ${event?.week ?? '?'} · ${event?.num_teams ?? teamEvents.length} teams · ${event?.status_str ?? event?.status ?? ''}`)
  if (event?.epa) L.push(`EPA: max ${num(event.epa.max)}, top-8 ${num(event.epa.top_8)}, top-24 ${num(event.epa.top_24)}, mean ${num(event.epa.mean)}`)
  const wp = event?.metrics?.win_prob
  if (wp?.count) L.push(`Prediction accuracy so far: ${num((wp.acc ?? 0) * 100, 0)}% of ${wp.count} matches`)
  const rows = [...teamEvents].sort((a, b) => (epaTotal(b.epa) ?? 0) - (epaTotal(a.epa) ?? 0))
  if (rows.length) {
    L.push('', '| EPA rank | Team | EPA | Qual rank | Qual record | RP/match | Playoffs |', '|---|---|---|---|---|---|---|')
    rows.slice(0, 80).forEach((t, i) => {
      const q = t.record?.qual ?? {}
      const el = t.record?.elim ?? {}
      L.push(`| ${i + 1} | ${t.team} ${t.team_name ?? ''} | ${num(epaTotal(t.epa))} | ${q.rank ?? '–'} | ${rec(q)} | ${num(q.rps_per_match, 2)} | ${el.alliance ? `alliance ${el.alliance}${el.is_captain ? ' (captain)' : ''}, ${rec(el)}` : '–'} |`)
    })
  }
  L.push('', `Source: Statbotics (https://www.statbotics.io/event/${event?.key ?? ''}).`)
  return L.join('\n')
}

export function formatSbMatches(matches: any[], team?: number): string {
  const L = [`| Match | Red | Blue | Predicted (red win %) | Result |`, '|---|---|---|---|---|']
  const sorted = [...matches].sort((a, b) => (a.time ?? 0) - (b.time ?? 0) || (a.match_number ?? 0) - (b.match_number ?? 0))
  for (const m of sorted.slice(0, 150)) {
    const red = (m.alliances?.red?.team_keys ?? []).join(' ')
    const blue = (m.alliances?.blue?.team_keys ?? []).join(' ')
    const p = m.pred ?? {}
    const r = m.result ?? {}
    const res = typeof r.red_score === 'number' ? `${r.red_score}-${r.blue_score} ${r.winner ?? ''}` : m.status ?? 'upcoming'
    L.push(`| ${m.match_name ?? m.key} | ${red} | ${blue} | ${num(p.red_score, 0)}-${num(p.blue_score, 0)} (${num((p.red_win_prob ?? NaN) * 100, 0)}%) | ${res} |`)
  }
  const played = sorted.filter((m) => typeof m.result?.red_score === 'number' && m.pred?.winner)
  const right = played.filter((m) => m.pred.winner === m.result.winner).length
  if (played.length) L.push('', `Statbotics picked the winner in ${right} of ${played.length} played matches.`)
  if (team) L.unshift(`# Matches for team ${team}`, '')
  return L.join('\n')
}

export function formatTbaMatches(matches: any[]): string {
  const order: Record<string, number> = { pm: 0, qm: 1, ef: 2, qf: 3, sf: 4, f: 5 }
  const sorted = [...matches].sort((a, b) => (order[a.comp_level] ?? 9) - (order[b.comp_level] ?? 9) || a.set_number - b.set_number || a.match_number - b.match_number)
  const L = ['| Match | Red | Blue | Score | Winner | Time |', '|---|---|---|---|---|---|']
  for (const m of sorted.slice(0, 200)) {
    const t = m.actual_time ?? m.predicted_time ?? m.time
    const red = m.alliances?.red ?? {}, blue = m.alliances?.blue ?? {}
    const strip = (k: string[]): string => (k ?? []).map((x) => x.replace(/^frc/, '')).join(' ')
    const scored = typeof red.score === 'number' && red.score >= 0
    L.push(`| ${m.key?.split('_')[1] ?? m.key} | ${strip(red.team_keys)} | ${strip(blue.team_keys)} | ${scored ? `${red.score}-${blue.score}` : '–'} | ${scored ? m.winning_alliance || 'tie' : '–'} | ${t ? new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 16) + 'Z' : '?'} |`)
  }
  return L.join('\n')
}

export function formatTbaRankings(r: any): string {
  const sortNames = (r?.sort_order_info ?? []).map((s: any) => s.name)
  const L = [`| Rank | Team | Record | Played | ${sortNames.slice(0, 3).join(' | ')} |`, `|---|---|---|---|${sortNames.slice(0, 3).map(() => '---|').join('')}`]
  for (const x of (r?.rankings ?? []).slice(0, 80)) L.push(`| ${x.rank} | ${String(x.team_key).replace(/^frc/, '')} | ${rec(x.record)} | ${x.matches_played} | ${(x.sort_orders ?? []).slice(0, 3).map((v: number) => num(v, 2)).join(' | ')} |`)
  return L.join('\n')
}

export function formatTbaStatus(s: any): string {
  if (!s) return 'No status for that team at that event.'
  const clean = (x?: string): string => (x ?? '').replace(/<[^>]+>/g, '')
  return [clean(s.overall_status_str), s.alliance_status_str ? `Alliance: ${clean(s.alliance_status_str)}` : '', s.playoff_status_str ? `Playoffs: ${clean(s.playoff_status_str)}` : '', s.next_match_key ? `Next match: ${s.next_match_key}` : '', s.last_match_key ? `Last match: ${s.last_match_key}` : '', s.pit_location ? `Pit: ${s.pit_location}` : ''].filter(Boolean).join('\n')
}

export const teamNum = (t: unknown): number => {
  const n = Number(String(t ?? '').replace(/^frc/i, '').trim())
  if (!Number.isInteger(n) || n <= 0 || n > 99999) throw new Error('team must be a team number like 254.')
  return n
}
export const eventKey = (k: unknown): string => {
  const s = String(k ?? '').trim().toLowerCase()
  if (!/^\d{4}[a-z0-9]{2,16}$/.test(s)) throw new Error('event must be an event key like 2026casj (year + event code; find it on statbotics.io or thebluealliance.com).')
  return s
}
