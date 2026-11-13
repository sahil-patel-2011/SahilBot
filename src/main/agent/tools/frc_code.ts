import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { extractSeries, formatSummary, listEntries, seriesCsv, summarizeWpilog } from '../../frc/logsummary'
import { checkVendordeps, formatScan, formatVendordeps, scanProject } from '../../frc/project'
import { eventKey, formatEvent, formatSbMatches, formatTbaMatches, formatTbaRankings, formatTbaStatus, formatTeam, getJson, STATBOTICS, TBA, teamNum } from '../../frc/scouting'
import { isWpilog } from '../../frc/wpilog'
import type { ToolContext, ToolDef } from '../types'
import { resolvePath } from './files'

// FRC software helpers: read robot logs (.wpilog), check vendor libraries, scan a robot project for
// common bugs, and pull scouting data (Statbotics, The Blue Alliance). All read-only. Deploying,
// building and simulating go through run_command (see the frc-code-build-deploy skill).

type Action = 'wpilog_summary' | 'wpilog_series' | 'vendordep_check' | 'project_scan' | 'scouting'
type Query = 'team' | 'event' | 'team_events' | 'matches' | 'tba_matches' | 'tba_rankings' | 'tba_status'
export interface FrcArgs {
  action: Action
  path?: string
  entries?: string[]
  max_points?: number
  start_s?: number
  end_s?: number
  format?: 'json' | 'csv'
  brownout_v?: number
  low_v?: number
  loop_ms?: number
  query?: Query
  team?: number | string
  event?: string
  year?: number
}

const MAX_LOG_BYTES = 768 * 1024 * 1024

export interface FrcDeps {
  workspace: () => string
  tbaKey: () => string | undefined
  fetchImpl?: typeof fetch
}

export function frcCodeTool(d: FrcDeps): ToolDef<FrcArgs> {
  const where = (p: string | undefined, ctx: ToolContext): string => {
    if (!p) throw new Error('path is required: a .wpilog file or the robot project folder (relative to the workspace, or inside a folder the user attached).')
    return resolvePath(p, d.workspace(), ctx.state.roots ?? [])
  }
  const readLog = (p: string | undefined, ctx: ToolContext): { full: string; buf: Buffer } => {
    const full = where(p, ctx)
    if (!existsSync(full)) throw new Error(`No such file: ${p}`)
    const st = statSync(full)
    if (st.isDirectory()) throw new Error(`${p} is a folder. Pass one .wpilog file (roboRIO logs are in /home/lvuser/logs or /U/logs on a USB stick; download them with AdvantageScope or DataLogTool).`)
    if (st.size > MAX_LOG_BYTES) throw new Error(`${basename(full)} is ${(st.size / 1e6).toFixed(0)} MB; too large to read here. Trim it in AdvantageScope or DataLogTool first.`)
    const buf = readFileSync(full)
    if (!isWpilog(buf)) throw new Error(`${basename(full)} is not a WPILib .wpilog file${/\.hoot$/i.test(full) ? ' (CTRE .hoot logs need converting to .wpilog first: Phoenix Tuner X → Log Extractor, or the owlet CLI)' : /\.dslog|\.dsevents$/i.test(full) ? ' (.dslog/.dsevents are Driver Station logs; open them in AdvantageScope or the DS Log Viewer)' : ''}.`)
    return { full, buf }
  }
  const sb = async (path: string, ctx: ToolContext): Promise<any> => (await getJson(`${STATBOTICS}${path}`, { signal: ctx.signal, fetchImpl: d.fetchImpl })).body
  const tba = async (path: string, ctx: ToolContext): Promise<any> => {
    const key = d.tbaKey()
    if (!key) throw new Error('The Blue Alliance needs a read API key. Ask the user to create one at https://www.thebluealliance.com/account and paste it in Settings → Keys (The Blue Alliance). Statbotics queries (team, event, team_events, matches) work without a key.')
    return (await getJson(`${TBA}${path}`, { signal: ctx.signal, headers: { 'X-TBA-Auth-Key': key }, fetchImpl: d.fetchImpl })).body
  }

  return {
    name: 'frc_code',
    label: 'FRC code',
    group: 'FRC robotics',
    effect: 'read',
    // Scouting comes from the internet and logs/projects can carry other people's text: treat as data.
    untrusted: true,
    description: 'FRC robot software helpers (read-only). action: wpilog_summary (path to a WPILib .wpilog: duration, robot modes, battery dips/brownouts, loop overruns, CAN errors/utilization, motor currents and temperatures, error messages), wpilog_series (path + entries: extract named signals downsampled for charts/pages; entries may end with "[i]" for an array element or "#field" for a struct field like "Pose#translation.x"; omit entries to list them), vendordep_check (path to robot project: vendor libraries, versions, season mismatches), project_scan (path to robot project: subsystems, commands, bindings, CAN IDs, plus heuristic bug checks), scouting (query: team | event | team_events | matches from Statbotics; tba_matches | tba_rankings | tba_status from The Blue Alliance, needs a key in Settings). To build, simulate or deploy use run_command with ./gradlew (read the frc-code-build-deploy skill first; never deploy without the user asking).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['wpilog_summary', 'wpilog_series', 'vendordep_check', 'project_scan', 'scouting'] },
        path: { type: 'string', description: '.wpilog file (log actions) or robot project folder (vendordep_check, project_scan)' },
        entries: { type: 'array', items: { type: 'string' }, maxItems: 12, description: 'wpilog_series: entry names or parts of names' },
        max_points: { type: 'integer', minimum: 10, maximum: 5000, description: 'wpilog_series: points per series after downsampling (default 300)' },
        start_s: { type: 'number', description: 'wpilog_series: window start, robot seconds' },
        end_s: { type: 'number', description: 'wpilog_series: window end, robot seconds' },
        format: { type: 'string', enum: ['json', 'csv'], description: 'wpilog_series output (default json)' },
        brownout_v: { type: 'number', description: 'wpilog_summary: brownout voltage (default 6.75, roboRIO 2 default)' },
        low_v: { type: 'number', description: 'wpilog_summary: voltage that counts as a dip (default 7.5)' },
        loop_ms: { type: 'number', description: 'wpilog_summary: loop budget in ms (default 20)' },
        query: { type: 'string', enum: ['team', 'event', 'team_events', 'matches', 'tba_matches', 'tba_rankings', 'tba_status'] },
        team: { type: ['integer', 'string'], description: 'Team number, e.g. 254' },
        event: { type: 'string', description: 'Event key, e.g. 2026casj' },
        year: { type: 'integer', minimum: 2002, maximum: 2100 }
      },
      required: ['action'],
      additionalProperties: false,
      allOf: [
        { if: { properties: { action: { enum: ['wpilog_summary', 'wpilog_series', 'vendordep_check', 'project_scan'] } } }, then: { required: ['path'] } },
        { if: { properties: { action: { const: 'scouting' } } }, then: { required: ['query'] } }
      ]
    },
    describe: (a) => (a.action === 'scouting' ? `Look up FRC scouting data (${a.query})` : `FRC ${a.action.replace('_', ' ')} on ${a.path ?? ''}`),
    async run(a, ctx) {
      switch (a.action) {
        case 'wpilog_summary': {
          const { full, buf } = readLog(a.path, ctx)
          const s = summarizeWpilog(buf, { brownoutV: a.brownout_v, lowV: a.low_v, loopBudgetMs: a.loop_ms })
          s.file = basename(full)
          return { text: formatSummary(s), display: `Log summary: ${basename(full)} (${s.durationS}s)` }
        }
        case 'wpilog_series': {
          const { full, buf } = readLog(a.path, ctx)
          if (!a.entries?.length) {
            const list = listEntries(buf)
            const lines = list.slice(0, 600).map((e) => `${e.name} (${e.type})`)
            return { text: `${list.length} entries in ${basename(full)}${list.length > 600 ? ' (first 600)' : ''}:\n${lines.join('\n')}\n\nCall again with entries to extract values.`, display: `Listed ${list.length} log entries` }
          }
          const r = extractSeries(buf, a.entries, { maxPoints: a.max_points ?? 300, startS: a.start_s, endS: a.end_s })
          const head = [`Series from ${basename(full)} (time in robot seconds; downsampled with LTTB, booleans/strings as change points).`]
          if (r.unmatched.length) head.push(`No entry matched: ${r.unmatched.join(', ')}. Call with no entries to list them.`)
          head.push(...r.notes)
          const body = a.format === 'csv' ? seriesCsv(r) : JSON.stringify(r.series.map((s) => ({ name: s.name, type: s.type, samples: s.total, points: s.points })))
          return { text: `${head.join('\n')}\n\n${body}`, display: `Extracted ${r.series.length} series from ${basename(full)}` }
        }
        case 'vendordep_check': {
          const dir = where(a.path, ctx)
          if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`${a.path} is not a folder. Pass the robot project root (the folder with build.gradle).`)
          const r = checkVendordeps(dir)
          return { text: formatVendordeps(r, dir), display: `Vendordeps: ${r.deps.length} libraries, ${r.findings.length} finding(s)` }
        }
        case 'project_scan': {
          const dir = where(a.path, ctx)
          if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`${a.path} is not a folder. Pass the robot project root (the folder with build.gradle).`)
          const s = scanProject(dir)
          return { text: formatScan(s), display: `Scanned ${s.javaFiles} files: ${s.subsystems.length} subsystems, ${s.findings.length} finding(s)` }
        }
        case 'scouting': {
          const year = a.year ?? new Date().getFullYear()
          switch (a.query) {
            case 'team': {
              const t = teamNum(a.team)
              const team = await sb(`/team/${t}`, ctx)
              let ty: any
              try { ty = await sb(`/team_year/${t}/${year}`, ctx) } catch { ty = undefined }
              return { text: formatTeam(team, ty) + (ty ? '' : `\n(No ${year} season data on Statbotics yet.)`), display: `Statbotics: team ${t}`, sources: [{ title: `Statbotics team ${t}`, url: `https://www.statbotics.io/team/${t}` }] }
            }
            case 'event': {
              const k = eventKey(a.event)
              const [event, teams] = await Promise.all([sb(`/event/${k}`, ctx), sb(`/team_events?event=${k}&limit=200`, ctx)])
              return { text: formatEvent(event, Array.isArray(teams) ? teams : []), display: `Statbotics: ${k}`, sources: [{ title: `Statbotics ${k}`, url: `https://www.statbotics.io/event/${k}` }] }
            }
            case 'team_events': {
              const t = teamNum(a.team)
              const rows = await sb(`/team_events?team=${t}&year=${year}&limit=50`, ctx)
              const list = (Array.isArray(rows) ? rows : []).map((x: any) => `- ${x.event_name ?? x.event} (${x.event}, week ${x.week ?? '?'}): EPA ${typeof x.epa?.total_points === 'number' ? x.epa.total_points.toFixed(1) : (x.epa?.total_points?.mean?.toFixed?.(1) ?? '?')}, qual rank ${x.record?.qual?.rank ?? '–'}/${x.record?.qual?.num_teams ?? '?'}, record ${x.record?.total ? `${x.record.total.wins}-${x.record.total.losses}-${x.record.total.ties}` : '?'}${x.record?.elim?.alliance ? `, alliance ${x.record.elim.alliance}` : ''} · ${x.status ?? ''}`)
              return { text: `# Team ${t} events in ${year} (Statbotics)\n${list.join('\n') || 'No events found.'}`, display: `Statbotics: ${t} events ${year}`, sources: [{ title: `Statbotics team ${t}`, url: `https://www.statbotics.io/team/${t}` }] }
            }
            case 'matches': {
              const k = a.event ? eventKey(a.event) : undefined
              const t = a.team !== undefined ? teamNum(a.team) : undefined
              if (!k && !t) throw new Error('matches needs event (and optionally team), or team with year.')
              const q = [k ? `event=${k}` : `year=${year}`, t ? `team=${t}` : '', 'limit=200'].filter(Boolean).join('&')
              const rows = await sb(`/matches?${q}`, ctx)
              return { text: formatSbMatches(Array.isArray(rows) ? rows : [], t), display: `Statbotics matches ${k ?? year}${t ? ` · ${t}` : ''}`, sources: [{ title: 'Statbotics', url: k ? `https://www.statbotics.io/event/${k}` : `https://www.statbotics.io/team/${t}` }] }
            }
            case 'tba_matches': {
              const k = eventKey(a.event)
              const rows = await tba(a.team !== undefined ? `/team/frc${teamNum(a.team)}/event/${k}/matches/simple` : `/event/${k}/matches/simple`, ctx)
              return { text: `# Matches at ${k} (The Blue Alliance)\n${formatTbaMatches(Array.isArray(rows) ? rows : [])}`, display: `TBA matches ${k}`, sources: [{ title: `The Blue Alliance ${k}`, url: `https://www.thebluealliance.com/event/${k}` }] }
            }
            case 'tba_rankings': {
              const k = eventKey(a.event)
              const r = await tba(`/event/${k}/rankings`, ctx)
              return { text: `# Rankings at ${k} (The Blue Alliance)\n${r ? formatTbaRankings(r) : 'No rankings yet.'}`, display: `TBA rankings ${k}`, sources: [{ title: `The Blue Alliance ${k}`, url: `https://www.thebluealliance.com/event/${k}#rankings` }] }
            }
            case 'tba_status': {
              const k = eventKey(a.event)
              const t = teamNum(a.team)
              const s = await tba(`/team/frc${t}/event/${k}/status`, ctx)
              return { text: `# Team ${t} at ${k} (The Blue Alliance)\n${formatTbaStatus(s)}`, display: `TBA status ${t} @ ${k}`, sources: [{ title: `The Blue Alliance ${k}`, url: `https://www.thebluealliance.com/team/${t}` }] }
            }
            default: throw new Error('scouting needs query: team, event, team_events, matches, tba_matches, tba_rankings or tba_status.')
          }
        }
      }
    }
  }
}
