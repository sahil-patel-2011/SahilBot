import { execFile, execFileSync } from 'node:child_process'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'
import { runCheck } from '../../code/checks'
import { backoff, briefGaps, cloudRunning, composeCursorPrompt, type CursorBrief, describeCloud, formatReview, newRunState, prUrlsOf, pullRequestCheckState, readCursorEvent, readCursorJson, type RepoFacts, reviewCursorChange } from '../../code/cursor'
import { formatFindings, gh, ghInstalled, git, scanDiffForSecrets } from '../../code/git'
import { clip, runProcess, stripAnsi } from '../../code/proc'
import { detectProject } from '../../code/project'
import { isGitRepo } from '../../code/search'
import { renderNotes } from '../notes'
import type { ToolContext, ToolDef } from '../types'
import { classify } from './shell'

// Apps on this Mac that work with no setup: Cursor (open files, hand coding tasks to Cursor's agent)
// and Apple Notes, Reminders and Calendar (through their own scripting, so macOS asks once per app).

function run(cmd: string, args: string[], opts: { cwd?: string; timeout: number; signal?: AbortSignal }): Promise<string> {
  return new Promise((ok, fail) => {
    execFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeout, signal: opts.signal, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PATH: `${process.env.PATH ?? ''}:/usr/local/bin:/opt/homebrew/bin:${join(homedir(), '.local/bin')}` } }, (err, stdout, stderr) => {
      if (err) fail(new Error((stderr || err.message).toString().trim().slice(0, 600)))
      else ok(stdout.toString())
    })
  })
}

// ------------------------------------------------------------------ Cursor

const CURSOR_APP = '/Applications/Cursor.app'
const CURSOR_CLI = `${CURSOR_APP}/Contents/Resources/app/bin/cursor`
const AGENT_PATHS = [join(homedir(), '.local/bin/cursor-agent'), '/usr/local/bin/cursor-agent', '/opt/homebrew/bin/cursor-agent', join(homedir(), '.local/bin/agent')]

export const cursorInstalled = (): boolean => existsSync(CURSOR_APP)
/** CURSOR_AGENT_PATH points at a cursor-agent installed somewhere else. */
const agentPath = (): string | undefined => [process.env.CURSOR_AGENT_PATH, ...AGENT_PATHS].find((p): p is string => !!p && existsSync(p))

/** Paths the agent may hand to Cursor: the workspace and anything the user attached. */
function allowed(p: string, ctx: Pick<ToolContext, 'workspaceDir' | 'state'>): string {
  const abs = isAbsolute(p) ? p : resolve(ctx.workspaceDir, p)
  const real = existsSync(abs) ? realpathSync(abs) : abs
  const roots = [ctx.workspaceDir, ...(ctx.state.roots ?? [])].map((r) => (existsSync(r) ? realpathSync(r) : r))
  if (!roots.some((r) => real === r || real.startsWith(r + sep))) throw new Error(`${p} is outside the workspace and the folders attached to this chat. Attach the folder first.`)
  return real
}

export type CursorArgs = {
  action: 'status' | 'open' | 'prompt' | 'agent' | 'cloud_launch' | 'cloud_list' | 'cloud_status' | 'cloud_wait' | 'cloud_followup' | 'cloud_stop' | 'cloud_review'
  path?: string; line?: number; task?: string; folder?: string; repo?: string; ref?: string; id?: string; model?: string
  /** For agent: continue the same Cursor chat in this folder (it remembers what it did). */
  resume?: boolean
  /** Structured brief: turned into a complete Cursor prompt (shown in the approval). */
  goal?: string; context?: string; files?: string[]; errors?: string; constraints?: string[]; dont_change?: string[]; acceptance?: string[]; tests?: string[]
  /** agent: run the tests/type check afterwards (default true). */
  verify?: boolean
  /** cloud_launch/cloud_followup: wait (bounded) for the run to finish. */
  wait?: boolean
  /** Minutes to wait (cloud) or to let the local agent run. */
  minutes?: number
}

/** Cursor agent chats by project folder, so follow-ups continue the same session. */
const cursorSessions = new Map<string, string>()
/** The first brief per folder (local) or cloud agent id, so follow-ups restate it and reviews check against it. */
const cursorBriefs = new Map<string, CursorArgs>()
const rememberBrief = (key: string | undefined, a: CursorArgs): void => { if (key && a.goal?.trim()) cursorBriefs.set(key, a) }
/** The brief a follow-up or resumed run continues (undefined for a fresh one). */
const firstBrief = (a: CursorArgs, mode: CursorBrief['mode'], folder?: string): CursorArgs | undefined => (mode === 'followup' && a.id ? cursorBriefs.get(a.id) : a.resume && folder ? cursorBriefs.get(folder) : undefined)

const CURSOR_API = 'https://api.cursor.com'

/** Cursor's Cloud Agents API (v1): HTTP Basic with the API key as the username. */
async function cursorApi(key: string, method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<any> {
  const res = await fetch(`${CURSOR_API}${path}`, {
    method,
    headers: { authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)])
  })
  const text = await res.text()
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error('Cursor rejected the API key. Add a valid one in Settings → Models & Keys (Cursor dashboard → API Keys).')
    if (res.status === 404) throw new Error(`Cursor has no agent or run at ${path.split('?')[0]}. Check the id with cloud_list.`)
    if (res.status === 409) throw new Error('That Cursor agent is still working. Check its status, or wait before sending a follow-up.')
    if (res.status === 429) throw new Error('Cursor is rate-limiting requests. Wait a minute before checking again.')
    throw new Error(`Cursor API ${res.status}: ${text.slice(0, 300)}`)
  }
  return text ? JSON.parse(text) : {}
}

/** The prompt a Cursor agent gets: the composed brief when a goal is given, else the raw task. */
function promptFor(a: CursorArgs, mode: CursorBrief['mode'], folder?: string): string {
  if (!a.goal?.trim()) return (a.task ?? '').trim()
  const facts: RepoFacts = {}
  if (folder && existsSync(folder)) {
    try {
      const info = detectProject(folder)
      facts.project = info
      facts.name = basename(folder)
      try { facts.branch = execFileSync('git', ['branch', '--show-current'], { cwd: folder, timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null } catch { /* not a repo */ }
      facts.existing = Object.fromEntries((a.files ?? []).map((f) => [f, existsSync(isAbsolute(f) ? f : join(folder, f))]))
    } catch { /* best effort */ }
  } else if (a.repo) facts.name = a.repo.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '')
  const first = firstBrief(a, mode, folder)
  const brief = composeCursorPrompt({ goal: a.goal, context: a.context, files: a.files, errors: a.errors, constraints: a.constraints, dontChange: a.dont_change, acceptance: a.acceptance, tests: a.tests, mode, ...(first?.goal ? { original: { goal: first.goal, acceptance: first.acceptance } } : {}) }, facts)
  return a.task?.trim() ? `${brief}\n\n# More instructions\n${a.task.trim()}` : brief
}

/**
 * Cursor is connected only by its API key (Cloud Agents): a cursor-agent CLI on this Mac never connects it
 * by itself. The CLI runs local agents only when the user turned that on (Connect apps → Cursor).
 */
export function cursorTool(cursorKey: () => string | undefined = () => undefined, getWorkspace: () => string = () => homedir(), localAllowed: () => boolean = () => false): ToolDef<CursorArgs> {
  const folderOf = (a: CursorArgs): string | undefined => (a.folder ? (isAbsolute(a.folder) ? a.folder : resolve(getWorkspace(), a.folder)) : undefined)
  const shownPrompt = (a: CursorArgs, mode: CursorBrief['mode']): string => {
    const p = promptFor(a, mode, mode === 'local' ? folderOf(a) : undefined)
    return p.length > 4000 ? `${p.slice(0, 4000)}\n…` : p
  }
  return {
    name: 'cursor',
    label: 'Cursor',
    group: 'Cursor (code editor and agents)',
    effect: (a) => (['status', 'prompt', 'cloud_list', 'cloud_status', 'cloud_wait', 'cloud_review'].includes(a.action) ? 'read' : a.action === 'open' || a.action === 'agent' ? 'write_local' : 'write_external'),
    // Cloud agents change a GitHub repo and open PRs: always confirm in Auto.
    consequential: (a) => ['cloud_launch', 'cloud_followup', 'cloud_stop'].includes(a.action),
    describe: (a) => a.action === 'agent' ? `Cursor's agent will work in ${a.folder}${a.resume ? ' (continuing its last chat)' : ''} with this prompt:\n\n${shownPrompt(a, 'local')}`
      : a.action === 'cloud_launch' ? `Start a Cursor cloud agent on ${a.repo}${a.ref ? ` (${a.ref})` : ''}; it works on a branch and opens a PR. Prompt:\n\n${shownPrompt(a, 'cloud')}`
        : a.action === 'cloud_followup' ? `Send Cursor agent ${a.id} a follow-up:\n\n${shownPrompt(a, 'followup')}`
          : a.action === 'cloud_stop' ? `Stop Cursor agent ${a.id}` : a.action === 'open' ? `Open ${a.path} in Cursor` : a.action === 'prompt' ? 'Draft a Cursor prompt' : `Cursor ${a.action.replace('_', ' ')}`,
    description: `Cursor, the AI code editor, and its agents. Delegate well-scoped coding work; review what comes back before calling it done. Cursor sees none of this chat: the brief must carry everything (skill cursor-task-brief). Results end with an automatic review against the brief; work through it before reporting.
- status: what is installed and connected. open(path, line?): show a file or folder in Cursor.
- prompt(goal, context?, files?, errors?, constraints?, dont_change?, acceptance?, tests?, folder?): draft the complete prompt a Cursor agent would get (goal, constraints, files, acceptance criteria, commands to verify, definition of done) so you can show or refine it. agent and cloud_launch take the same fields and build this prompt themselves (or take a raw task).
- agent(folder, goal… or task, resume?, verify?, minutes?): run Cursor's agent on this Mac in a project folder with live progress; returns its summary, the exact diff it made (against a restore point taken before it started), and the test/type-check results (verify, default on). resume: true continues its previous chat there (follow-ups, fixes).
- Cloud agents (need a Cursor API key): cloud_launch(repo GitHub URL, goal… or task, ref?, model?, wait?) works on a branch and opens a PR; cloud_status(id); cloud_wait(id, minutes?) checks with backoff until the run ends (bounded; then use cloud_status later or a schedule); cloud_followup(id, goal… or task, wait?); cloud_stop(id); cloud_review(id): the run's result, PR, checks and diff (via gh) for review; cloud_list.`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'open', 'prompt', 'agent', 'cloud_launch', 'cloud_list', 'cloud_status', 'cloud_wait', 'cloud_followup', 'cloud_stop', 'cloud_review'] },
        path: { type: 'string', description: 'For open: file or folder (absolute, or relative to the workspace)' },
        line: { type: 'integer', minimum: 1, description: 'For open: line to jump to' },
        goal: { type: 'string', description: 'What must be true when the agent is done, specific and complete' },
        context: { type: 'string', description: 'What you found already: relevant code, search results, how things fit together, the user\'s words' },
        files: { type: 'array', items: { type: 'string' }, description: 'Files to read or change first' },
        errors: { type: 'string', description: 'Error output or failing tests to fix' },
        constraints: { type: 'array', items: { type: 'string' } },
        dont_change: { type: 'array', items: { type: 'string' }, description: 'Files, APIs or behaviour that must stay as they are' },
        acceptance: { type: 'array', items: { type: 'string' }, description: 'Checkable acceptance criteria' },
        tests: { type: 'array', items: { type: 'string' }, description: 'Commands that must pass (default: the project\'s type check and tests)' },
        task: { type: 'string', description: 'A raw prompt instead of (or added to) the structured brief' },
        folder: { type: 'string', description: 'For agent and prompt: the project folder' },
        repo: { type: 'string', description: 'For cloud_launch: GitHub repository URL, e.g. https://github.com/me/app' },
        ref: { type: 'string', description: 'For cloud_launch: branch or ref to start from (default: the default branch)' },
        id: { type: 'string', description: 'Cloud agent id (bc-…)' },
        model: { type: 'string', description: 'Optional Cursor model id' },
        resume: { type: 'boolean', description: 'For agent: continue the previous Cursor chat in this folder (follow-ups, fixes)' },
        verify: { type: 'boolean', description: 'For agent: run the checks afterwards (default true)' },
        wait: { type: 'boolean', description: 'For cloud_launch/cloud_followup: wait for the run to finish (bounded by minutes)' },
        minutes: { type: 'integer', minimum: 1, maximum: 60, description: 'agent: time limit (default 20). cloud_wait/wait: how long to wait (default 10, max 30)' }
      },
      required: ['action'],
      additionalProperties: false,
      allOf: [
        { if: { properties: { action: { const: 'open' } } }, then: { required: ['path'] } },
        { if: { properties: { action: { const: 'prompt' } } }, then: { required: ['goal'] } },
        { if: { properties: { action: { const: 'agent' } } }, then: { required: ['folder'], anyOf: [{ required: ['task'] }, { required: ['goal'] }] } },
        { if: { properties: { action: { const: 'cloud_launch' } } }, then: { required: ['repo'], anyOf: [{ required: ['task'] }, { required: ['goal'] }] } },
        { if: { properties: { action: { enum: ['cloud_status', 'cloud_stop', 'cloud_wait', 'cloud_review'] } } }, then: { required: ['id'] } },
        { if: { properties: { action: { const: 'cloud_followup' } } }, then: { required: ['id'], anyOf: [{ required: ['task'] }, { required: ['goal'] }] } }
      ]
    },
    async run(a, ctx) {
      const key = cursorKey()
      if (a.action.startsWith('cloud_') && !key) throw new Error('Cursor isn\'t connected. Ask the user to connect it in Connect apps → Cursor with a Cursor API key (cursor.com/dashboard → Integrations → API Keys).')
      if (a.action === 'agent' && !localAllowed()) throw new Error(key ? 'Run this as a Cursor cloud agent (cloud_launch with the GitHub repo). Running Cursor\'s CLI on this Mac is off; the user can turn it on in Connect apps → Cursor.' : 'Cursor isn\'t connected. Ask the user to connect it in Connect apps → Cursor with a Cursor API key, then use a cloud agent (cloud_launch).')
      switch (a.action) {
        case 'status': {
          const agent = agentPath()
          return {
            text: `Cursor: ${key ? 'connected (cloud agents, with the user\'s API key)' : 'not connected (the user connects it in Connect apps → Cursor with a Cursor API key)'}\nCursor app (opening files): ${cursorInstalled() ? 'installed' : 'not installed (cursor.com/download)'}\nLocal agents through Cursor's CLI: ${localAllowed() ? (agent ? `on (${agent})` : 'on, but cursor-agent isn\'t installed') : 'off (the user can turn it on in Connect apps → Cursor)'}\nGitHub CLI for reviewing PRs: ${ghInstalled() ? 'installed' : 'not installed (brew install gh)'}`,
            display: key ? 'Cursor is connected' : 'Cursor not connected'
          }
        }
        case 'open': {
          if (!cursorInstalled()) throw new Error('Cursor is not installed. Get it at cursor.com/download.')
          const p = allowed(a.path!, ctx)
          if (existsSync(CURSOR_CLI)) await run(CURSOR_CLI, a.line && statSync(p).isFile() ? ['-g', `${p}:${a.line}`] : [p], { timeout: 15_000 })
          else await run('open', ['-a', 'Cursor', p], { timeout: 15_000 })
          return { text: `Opened ${p} in Cursor.`, display: `opened ${p.split('/').pop()}`, path: p }
        }
        case 'prompt': {
          const folder = a.folder ? allowed(a.folder, ctx) : undefined
          const text = promptFor(a, a.repo && !folder ? 'cloud' : 'local', folder)
          const info = folder ? detectProject(folder) : undefined
          const notes = renderNotes(ctx.state, 2500)
          const gaps = a.goal ? briefGaps({ ...a, goal: a.goal }, { projectChecks: !!(info?.test || info?.typecheck.length), notes }) : ['No goal: pass goal (plus files, context, acceptance, tests) so the brief is complete.']
          const fromNotes = notes ? `\n\nYour working notes (copy the user's constraints into constraints, and the decisions, paths and IDs Cursor needs into context):\n${notes}` : ''
          return { text: `Draft Cursor prompt (${text.length} characters).${gaps.length ? `\n\nImprove the brief first (Cursor sees none of this chat):\n${gaps.map((g) => `- ${g}`).join('\n')}` : ' The brief is complete.'}${fromNotes}\n\nShow it to the user if they want to see it, then pass the same fields to cursor(action="agent") or cloud_launch:\n\n${text}`, display: gaps.length ? `drafted a Cursor prompt (${gaps.length} gaps)` : 'drafted a Cursor prompt' }
        }
        case 'agent': return localAgent(a, ctx)
        case 'cloud_launch': {
          const prompt = promptFor(a, 'cloud')
          const r = await cursorApi(key!, 'POST', '/v1/agents', { prompt: { text: prompt }, repos: [{ url: a.repo, ...(a.ref ? { startingRef: a.ref } : {}) }], ...(a.model ? { model: { id: a.model } } : {}), autoCreatePR: true }, ctx.signal)
          const id = r.agent?.id ?? r.id
          rememberBrief(id, a)
          const started = `Started Cursor cloud agent ${id} (${r.run?.status ?? 'creating'}). Watch it at ${r.agent?.url ?? 'cursor.com/agents'}.`
          if (!a.wait || !id) return { text: `${started} Check it with cloud_wait (bounded wait with backoff) or cloud_status; then review the PR with cloud_review before reporting.`, display: `started ${id}` }
          const w = await waitCloud(key!, id, a.minutes, ctx)
          return { text: `${started}\n\n${w.text}`, display: w.display }
        }
        case 'cloud_list': {
          const r = await cursorApi(key!, 'GET', '/v1/agents?limit=20', undefined, ctx.signal)
          const items = (r.items ?? r.agents ?? []) as Array<{ id: string; name?: string; status: string; repos?: Array<{ url: string }>; updatedAt?: string }>
          return { text: items.length ? items.map((x) => `- ${x.id} · ${x.name ?? ''} · ${x.status} · ${x.repos?.map((rp) => rp.url).join(', ') ?? ''} · ${x.updatedAt ?? ''}`).join('\n') : 'No Cursor cloud agents.', display: `${items.length} Cursor agents` }
        }
        case 'cloud_status': {
          const { agent, run: latest } = await cloudState(key!, a.id!, ctx.signal)
          return { text: describeCloud(agent, latest), display: `${agent.id} · ${latest?.status ?? agent.status}` }
        }
        case 'cloud_wait': {
          const w = await waitCloud(key!, a.id!, a.minutes, ctx)
          return { text: w.text, display: w.display }
        }
        case 'cloud_followup': {
          const r = await cursorApi(key!, 'POST', `/v1/agents/${encodeURIComponent(a.id!)}/runs`, { prompt: { text: promptFor(a, 'followup') } }, ctx.signal)
          const sent = `Sent the follow-up to ${a.id} (run ${r.run?.id ?? r.id ?? ''}, ${r.run?.status ?? r.status ?? 'queued'}).`
          if (!a.wait) return { text: `${sent} Check it with cloud_wait or cloud_status.`, display: `follow-up sent to ${a.id}` }
          const w = await waitCloud(key!, a.id!, a.minutes, ctx)
          return { text: `${sent}\n\n${w.text}`, display: w.display }
        }
        case 'cloud_stop': {
          const { agent, run: latest } = await cloudState(key!, a.id!, ctx.signal)
          if (!latest || !cloudRunning(latest.status)) return { text: `${a.id} has no running work${latest ? ` (last run: ${latest.status})` : ''}.`, display: 'nothing to stop' }
          await cursorApi(key!, 'POST', `/v1/agents/${encodeURIComponent(a.id!)}/runs/${encodeURIComponent(agent.latestRunId)}/cancel`, {}, ctx.signal)
          return { text: `Stopped ${a.id}'s current run.`, display: `stopped ${a.id}` }
        }
        case 'cloud_review': {
          const { agent, run: latest } = await cloudState(key!, a.id!, ctx.signal)
          const parts = [describeCloud(agent, latest)]
          const observations: string[] = []
          let passed = 0
          if (cloudRunning(latest?.status)) parts.push('\nThe run is still going: review once it finishes (cloud_wait).')
          const prs = prUrlsOf(latest)
          if (!prs.length) parts.push('\nNo pull request yet.')
          else if (!ghInstalled()) parts.push(`\nThe GitHub CLI (gh) isn't installed, so the diff can't be fetched here. Open ${prs[0]} in the browser, or ask the user to "brew install gh".`)
          else {
            const cwd = ctx.workspaceDir
            for (const url of prs.slice(0, 2)) {
              try {
                const view = await gh(cwd, ['pr', 'view', url, '--json', 'title,state,headRefOid,baseRefOid,additions,deletions,changedFiles,statusCheckRollup'], { signal: ctx.signal })
                const v = JSON.parse(view)
                const checks = (v.statusCheckRollup ?? []) as Array<{ name?: string; context?: string; conclusion?: string; state?: string; status?: string }>
                parts.push(`\nPR ${url}: ${v.title} (${v.state}) +${v.additions} −${v.deletions} in ${v.changedFiles} files`)
                if (checks.length) parts.push(`Checks: ${checks.map((c) => `${c.name ?? c.context}=${c.conclusion || c.state || c.status}`).join(', ')}`)
                const diff = await gh(cwd, ['pr', 'diff', url, '--color', 'never'], { signal: ctx.signal, timeoutMs: 90_000 })
                const revision = JSON.parse(await gh(cwd, ['pr', 'view', url, '--json', 'headRefOid,baseRefOid'], { signal: ctx.signal }))
                if (!v.headRefOid || !v.baseRefOid || revision.headRefOid !== v.headRefOid || revision.baseRefOid !== v.baseRefOid) {
                  parts.push('The PR revision changed during review. Read it again before using the diff or checks.')
                  continue
                }
                const state = pullRequestCheckState(checks)
                const receipt = `${url} at ${v.headRefOid}: diff read, CI ${state}`
                observations.push(receipt)
                parts.push(receipt)
                if (state === 'passed') passed++
                parts.push(`Diff:\n${clip(diff.trim(), 40_000)}`)
                parts.push(formatReview(reviewCursorChange({ brief: briefOf(cursorBriefs.get(a.id!)), diff, checksRun: checks.length > 0, checksOk: state === 'unverified' ? undefined : state === 'passed', summary: latest?.result }), `cursor(action="cloud_followup", id="${a.id}", goal=…)`))
              } catch (e) { ctx.signal.throwIfAborted(); parts.push(`\nCouldn't read ${url} with gh: ${(e as Error).message}`) }
            }
            parts.push('\nReview: does the diff do exactly the goal, nothing more? Any failing checks, missing tests, secrets, or risky changes? Send fixes with cloud_followup; tell the user what you verified.')
          }
          const verified = prs.length > 0 && observations.length === prs.length
          const detail = observations.join('\n') || 'No stable revision and check results available.'
          return { text: parts.join('\n'), display: `${observations.length}/${prs.length} PR diffs read · ${passed} with passing CI`,
            verification: { criterion: `Inspected revisions and CI for Cursor agent ${a.id}`, passed: verified, detail } }
        }
      }
    }
  }
}

async function cloudState(key: string, id: string, signal?: AbortSignal): Promise<{ agent: any; run: any }> {
  const agent = await cursorApi(key, 'GET', `/v1/agents/${encodeURIComponent(id)}`, undefined, signal)
  const latest = agent.latestRunId ? await cursorApi(key, 'GET', `/v1/agents/${encodeURIComponent(id)}/runs/${encodeURIComponent(agent.latestRunId)}`, undefined, signal) : null
  return { agent, run: latest }
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((ok, fail) => {
  if (signal.aborted) return fail(new Error('Stopped.'))
  const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); ok() }, ms)
  const onAbort = (): void => { clearTimeout(t); fail(new Error('Stopped.')) }
  signal.addEventListener('abort', onAbort, { once: true })
})

/** Polls a cloud agent with growing gaps (10s → 60s) until its run ends or the time is up. */
async function waitCloud(key: string, id: string, minutes: number | undefined, ctx: ToolContext): Promise<{ text: string; display: string }> {
  const deadline = Date.now() + Math.min(minutes ?? 10, 30) * 60_000
  let last = ''
  for (let attempt = 0; ; attempt++) {
    const { agent, run: latest } = await cloudState(key, id, ctx.signal)
    const st = latest?.status ?? agent.status
    if (st !== last) { ctx.progress?.(`Cursor cloud agent ${id}: ${st}`); last = st }
    if (!cloudRunning(st)) {
      const prs = prUrlsOf(latest)
      return { text: `${describeCloud(agent, latest)}\n\n${prs.length ? `Next: review the PR with cursor(action="cloud_review", id="${id}") (diff and checks) before telling the user it's done.` : 'No PR was opened; read the result above.'}`, display: `${id} · ${st}` }
    }
    const wait = backoff(attempt) * 1000
    if (Date.now() + wait > deadline) {
      return { text: `${describeCloud(agent, latest)}\n\nStill ${st} after waiting. Check again later with cloud_wait or cloud_status (or schedule a check); don't loop on it.`, display: `${id} still ${st}` }
    }
    await sleep(wait, ctx.signal)
  }
}

/** Runs cursor-agent headless with live progress, then shows exactly what it changed and checks it. */
async function localAgent(a: CursorArgs, ctx: ToolContext): Promise<{ text: string; display: string }> {
  const agent = agentPath()
  if (!agent) throw new Error('Cursor\'s agent isn\'t installed on this Mac. Tell the user they can install it with: curl https://cursor.com/install -fsS | bash (then sign in with cursor-agent login), or use a Cursor cloud agent.')
  const folder = allowed(a.folder!, ctx)
  if (!statSync(folder).isDirectory()) throw new Error(`${a.folder} is not a folder.`)
  const prompt = promptFor(a, 'local', folder)
  if (!prompt) throw new Error('Give the agent a goal (or task).')
  if (!a.resume || !cursorBriefs.has(folder)) rememberBrief(folder, a)
  // A restore point: the working tree as it is now, so the report shows only what Cursor changed.
  const repo = await isGitRepo(folder)
  let basePoint: string | undefined
  let untrackedBefore = new Set<string>()
  if (repo) {
    basePoint = (await git(folder, ['stash', 'create'], { signal: ctx.signal }).catch(() => '')).trim() || (await git(folder, ['rev-parse', 'HEAD'], { signal: ctx.signal }).catch(() => '')).trim() || undefined
    untrackedBefore = new Set((await git(folder, ['ls-files', '--others', '--exclude-standard'], { signal: ctx.signal }).catch(() => '')).split('\n').filter(Boolean))
  }
  const prev = a.resume ? cursorSessions.get(folder) : undefined
  const args = ['-p', '--force', '--trust', '--output-format', 'stream-json', ...(a.model ? ['--model', a.model] : []), ...(prev ? ['--resume', prev] : []), prompt]
  const st = newRunState()
  // Cursor's events are few (a line per tool call or message): pass each one on, none dropped.
  const tick = { push: (l: string): void => { try { ctx.progress?.(l) } catch { /* progress is best-effort */ } }, flush: (): void => undefined }
  ctx.progress?.(`Cursor agent starting in ${basename(folder)}…`)
  const r = await runProcess(agent, args, {
    cwd: folder,
    timeoutMs: Math.min(a.minutes ?? 20, 60) * 60_000,
    signal: ctx.signal,
    maxChars: 8_000_000,
    onLine: (l, stream) => {
      const p = stream === 'stdout' ? readCursorEvent(l, st) : null
      if (p) tick.push(p)
    }
  })
  tick.flush()
  readCursorJson(r.stdout, st)
  if (st.sessionId) cursorSessions.set(folder, st.sessionId)
  if (r.stopped) throw new Error('Stopped. Cursor\'s agent was stopped part-way; check git diff for partial changes.')
  const summary = (st.result ?? st.lastText ?? '').trim()
  if ((r.code !== 0 && !summary) || st.isError) {
    const why = stripAnsi(r.stderr || r.stdout).trim().split('\n').slice(-8).join('\n')
    if (/login|auth|unauthori/i.test(why)) throw new Error('Cursor\'s agent isn\'t signed in. Ask the user to run "cursor-agent login" in Terminal once.')
    throw new Error(`Cursor's agent ${r.timedOut ? `ran out of time (${Math.min(a.minutes ?? 20, 60)} min)` : 'failed'}: ${(summary || why).slice(0, 800)}`)
  }
  const parts = [`Cursor's agent finished in ${folder}${prev ? ' (continued its previous chat)' : ''}${st.durationMs ? ` after ${Math.round(st.durationMs / 1000)}s` : ''}${r.timedOut ? ' (time limit reached)' : ''}.`, '', 'Its summary (verify it; don\'t just trust it):', summary || '(no summary)']
  let changed = false
  let fullDiff = ''
  let freshFiles: string[] = []
  if (repo && basePoint) {
    const stat = (await git(folder, ['diff', '--stat', basePoint], { signal: ctx.signal }).catch(() => '')).trim()
    const diff = (await git(folder, ['diff', basePoint], { signal: ctx.signal, timeoutMs: 60_000 }).catch(() => '')).trim()
    const fresh = (await git(folder, ['ls-files', '--others', '--exclude-standard'], { signal: ctx.signal }).catch(() => '')).split('\n').filter((f) => f && !untrackedBefore.has(f))
    changed = !!stat || fresh.length > 0
    fullDiff = diff
    freshFiles = fresh
    parts.push('', `What it changed (against restore point ${basePoint.slice(0, 10)}; undo with: git stash && git checkout ${basePoint.slice(0, 10)} -- . if needed, which asks the user):`)
    parts.push(stat || '(no changes to tracked files)')
    if (fresh.length) parts.push(`New files: ${fresh.slice(0, 40).join(', ')}`)
    if (diff) parts.push('', clip(diff, 30_000))
    const secrets = scanDiffForSecrets(diff)
    if (secrets.length) parts.push('', `Warning: the changes may contain secrets:\n${formatFindings(secrets)}`)
  } else {
    changed = st.filesTouched.size > 0
    parts.push('', st.filesTouched.size ? `Files it wrote: ${[...st.filesTouched].slice(0, 40).join(', ')}` : '(not a git repo: no diff available)')
  }
  if (st.commands.length) parts.push('', `Commands it ran: ${st.commands.slice(0, 15).map((c) => `\`${c.slice(0, 100)}\``).join(', ')}`)
  let verdict = ''
  let checksOk: boolean | undefined
  if (a.verify !== false && changed) {
    const info = detectProject(folder)
    const specs = (a.tests?.length ? a.tests : [...info.typecheck.map((t) => t.command), ...(info.test ? [info.test.command] : [])])
      .filter((c) => ['read', 'write_local'].includes(classify(c).effect))
    if (specs.length) {
      parts.push('', 'Verification:')
      let ok = true
      for (const cmd of specs.slice(0, 4)) {
        const tool = info.test?.command === cmd ? info.test.tool : info.typecheck.find((t) => t.command === cmd)?.tool ?? (/tsc/.test(cmd) ? 'tsc' : /pytest/.test(cmd) ? 'pytest' : 'generic')
        const kind = info.typecheck.some((t) => t.command === cmd) || /\btsc\b|mypy|cargo check|go vet/.test(cmd) ? 'typecheck' as const : 'test' as const
        const res = await runCheck({ cwd: folder, kind, spec: { command: cmd, tool, kind }, timeoutMs: 10 * 60_000, signal: ctx.signal, progress: ctx.progress, tailLines: 20 })
        parts.push(res.text)
        ok &&= res.ok
        if (res.stopped) break
      }
      verdict = ok ? 'checks passed' : 'checks failed'
      checksOk = ok
      parts.push('', ok ? 'All checks passed. Still read the diff for scope and style before reporting.' : 'Checks failed: send Cursor a follow-up with the failures (agent with resume: true and errors), or fix it yourself with the code tool.')
    } else parts.push('', 'No test or type-check command found: review the diff by reading it, and run the app if you can.')
  }
  // The automatic review: against the first brief for this folder (a resumed run keeps the original criteria).
  if (repo && basePoint) parts.push(formatReview(reviewCursorChange({ brief: briefOf(a.resume ? cursorBriefs.get(folder) ?? a : a), diff: fullDiff, newFiles: freshFiles, checksOk, checksRun: checksOk !== undefined, summary }), `cursor(action="agent", folder, resume: true, goal=…, errors=…)`))
  return { text: parts.join('\n'), display: `Cursor agent ${changed ? 'made changes' : 'finished (no changes)'}${verdict ? ` · ${verdict}` : ''}` }
}

/** The tool's fields as a brief for the review. */
function briefOf(a: CursorArgs | undefined): Partial<CursorBrief> | undefined {
  return a ? { goal: a.goal ?? a.task, files: a.files, dontChange: a.dont_change, acceptance: a.acceptance } : undefined
}

// ------------------------------------------------------------------ Apple Notes, Reminders, Calendar

/** Runs a JavaScript for Automation snippet with JSON in and out (no string splicing into scripts). */
export const jxaLimits = { timeoutMs: 30_000, hintMs: 3000 }

/**
 * Runs a JavaScript for Automation snippet with JSON in and out (no string splicing into scripts). The first time,
 * macOS asks "SahilBot wants to control Reminders" and the script waits behind that dialog: after a moment the
 * working line says so, and a timeout says what to click instead of a raw osascript error.
 */
async function jxa(fn: string, input: unknown, signal?: AbortSignal, timeout = jxaLimits.timeoutMs, progress?: (text: string) => void, exec: typeof run = run): Promise<unknown> {
  const script = `function run(argv) { const input = JSON.parse(argv[0]); return JSON.stringify((${fn})(input)); }`
  const app = /Application\('(\w+)'\)/.exec(fn)?.[1] ?? 'the app'
  const hint = progress ? setTimeout(() => progress(`macOS may be asking to let SahilBot use ${app}. Look for its dialog and click OK`), jxaLimits.hintMs) : undefined
  const start = Date.now()
  try {
    const out = await exec('osascript', ['-l', 'JavaScript', '-e', script, JSON.stringify(input)], { timeout, signal })
    return JSON.parse(out || 'null')
  } catch (e) {
    const m = (e as Error).message
    if (/-1743|not allowed|Not authorized/i.test(m)) throw new Error('macOS blocked access. The user can allow SahilBot in System Settings → Privacy & Security → Automation, then try again.')
    if (!signal?.aborted && Date.now() - start >= timeout - 500) throw new Error(`macOS is waiting for the user to allow SahilBot to control ${app} (its dialog may be behind other windows). They can allow it in that dialog or in System Settings → Privacy & Security → Automation, then try again.`)
    throw e
  } finally {
    if (hint) clearTimeout(hint)
  }
}

/** For tests: jxa with a stand-in for osascript. */
export const jxaForTest = (fn: string, input: unknown, o: { signal?: AbortSignal; progress?: (t: string) => void; exec: typeof run }): Promise<unknown> => jxa(fn, input, o.signal, undefined, o.progress, o.exec)

type MacArgs = {
  action: 'notes_search' | 'notes_create' | 'reminders_list' | 'reminders_add' | 'calendar_events' | 'calendar_add'
  query?: string; title?: string; body?: string; list?: string; due?: string; days?: number; start?: string; end?: string; calendar?: string
  from?: string; to?: string
}

/** One calendar event as the scripts return it (others: it has invitees or an organizer, so other people wrote parts of it). */
export interface MacEvent { cal: string; title: string; start: string; end: string; where: string; allDay?: boolean; others?: boolean }

/**
 * The window calendar_events reads: from the start of today (so an event in progress, or today's all-day event,
 * is included) for `days` days, or the exact from/to the model gives ("tomorrow" = from and to of that day).
 */
export function calendarRange(a: { days?: number; from?: string; to?: string }, now = new Date()): { from: Date; to: Date } {
  const parse = (s?: string): Date | undefined => {
    if (!s) return undefined
    // A bare date ("2026-11-25") is that day on the user's clock, not midnight UTC.
    const d = /^\d{4}-\d{2}-\d{2}$/.test(s.trim()) ? new Date(`${s.trim()}T00:00`) : new Date(s)
    return Number.isNaN(d.getTime()) ? undefined : d
  }
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const from = parse(a.from) ?? today
  let to = parse(a.to)
  // A bare end date means through the end of that day.
  if (to && a.to && /^\d{4}-\d{2}-\d{2}$/.test(a.to.trim())) to = new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1)
  if (!to || to <= from) to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + (a.days ?? (a.from ? 1 : 7)), from.getHours(), from.getMinutes())
  return { from, to }
}

// EventKit (through the JavaScript-ObjC bridge) expands repeating events into each occurrence and finds events that
// started before the window but are still on; Calendar.app's scripting does neither (only a series' first event
// matches a date filter). EventKit needs Calendar access: asked once (the dialog waits up to a minute), and when
// it's refused or unavailable the scripting path still answers.
const CALENDAR_EVENTS = `(i) => {
  const from = new Date(i.from), to = new Date(i.to), out = []
  try {
    ObjC.import('EventKit')
    const status = () => Number($.EKEventStore.authorizationStatusForEntityType(0))
    if (status() === 0) {
      const asker = $.EKEventStore.alloc.init
      let done = false
      const cb = () => { done = true }
      // The completion block may never be called through the bridge: the status itself says when the user answered.
      try {
        if (asker.respondsToSelector('requestFullAccessToEventsWithCompletion:')) asker.requestFullAccessToEventsWithCompletion(cb)
        else asker.requestAccessToEntityTypeCompletion(0, cb)
      } catch (err) { done = true }
      const until = Date.now() + 60000
      while (!done && status() === 0 && Date.now() < until) $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.25))
    }
    if (status() === 3) {
      const store = $.EKEventStore.alloc.init
      const pred = store.predicateForEventsWithStartDateEndDateCalendars($.NSDate.dateWithTimeIntervalSince1970(from.getTime() / 1000), $.NSDate.dateWithTimeIntervalSince1970(to.getTime() / 1000), null)
      const evs = store.eventsMatchingPredicate(pred)
      for (let k = 0; k < Number(evs.count); k++) {
        const e = evs.objectAtIndex(k)
        out.push({ cal: ObjC.unwrap(e.calendar.title) || '', title: ObjC.unwrap(e.title) || '(no title)', start: new Date(Number(e.startDate.timeIntervalSince1970) * 1000).toISOString(), end: new Date(Number(e.endDate.timeIntervalSince1970) * 1000).toISOString(), where: ObjC.unwrap(e.location) || '', allDay: !!e.isAllDay, others: !!e.hasAttendees })
      }
      return { via: 'eventkit', events: out.sort((a, b) => a.start < b.start ? -1 : 1).slice(0, 80) }
    }
  } catch (err) { /* no EventKit here: Calendar's own scripting below */ }
  const C = Application('Calendar')
  for (const c of C.calendars()) {
    for (const e of c.events.whose({ _and: [{ endDate: { _greaterThan: from } }, { startDate: { _lessThan: to } }] })()) {
      let others = false
      try { others = e.attendees().length > 0 } catch (err) { others = false }
      out.push({ cal: c.name(), title: e.summary(), start: e.startDate().toISOString(), end: e.endDate().toISOString(), where: e.location() || '', allDay: !!e.alldayEvent(), others })
    }
  }
  return { via: 'calendar', events: out.sort((a, b) => a.start < b.start ? -1 : 1).slice(0, 80) }
}`

/** The events as the model reads them, on the user's clock. */
export function formatEvents(events: MacEvent[], range: { from: Date; to: Date }, via: string): string {
  // Scripting matches only a repeating series' first event: say so whenever it was the way in, events or not.
  const caveat = via === 'calendar' ? '\n(Read through Calendar scripting, which can miss repeating events: say so if the user relies on this list; allowing SahilBot full Calendar access in System Settings → Privacy & Security → Calendars fixes that.)' : ''
  if (!events.length) return `No events from ${range.from.toLocaleString()} to ${range.to.toLocaleString()} in the Mac's Calendar app. A Google Calendar, if connected, is read with its own tools.${caveat}`
  const day = (d: Date): string => d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
  return events.map((e) => {
    const s = new Date(e.start), en = new Date(e.end)
    const when = e.allDay ? `${day(s)} (all day)` : `${day(s)} ${s.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} – ${en.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
    return `- ${when}: ${e.title}${e.where ? ` @ ${e.where}` : ''} [${e.cal}]${e.others ? ' (invite)' : ''}`
  }).join('\n') + caveat
}

type Jxa = (fn: string, input: unknown, signal?: AbortSignal, timeout?: number, progress?: (text: string) => void) => Promise<unknown>

export function macAppsTool(o: { jxa?: Jxa } = {}): ToolDef<MacArgs> {
  const script = o.jxa ?? jxa
  return {
    name: 'mac_apps',
    label: 'Mac apps',
    group: 'Apple Notes, Reminders, Calendar',
    // Notes and invites can contain text written by other people: those results are outside content (each
    // result says so). The user's own reminders and events aren't, so reading them doesn't make a later send ask.
    effect: (a) => (/_(search|list|events)$/.test(a.action) ? 'read' : 'write_local'),
    describe: (a) => (a.action === 'notes_create' ? `Create a note "${a.title}"` : a.action === 'reminders_add' ? `Add reminder "${a.title}"${a.due ? ` due ${a.due}` : ''}` : a.action === 'calendar_add' ? `Add "${a.title}" to your calendar at ${a.start}` : a.action.replace('_', ' ')),
    description: 'The Mac\'s Notes, Reminders and Calendar (macOS asks once). notes_search(query). notes_create(title, body). reminders_list(list?). reminders_add(title, due?, list?). calendar_events(from?, to?, days?): a bare date is its whole day; else days from today (default 7). calendar_add(title, start, end?, calendar?): on the user\'s own calendar (no invitees). Times ISO 8601.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['notes_search', 'notes_create', 'reminders_list', 'reminders_add', 'calendar_events', 'calendar_add'] },
        query: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, list: { type: 'string' },
        due: { type: 'string', description: 'ISO 8601, e.g. 2026-11-14T09:00' },
        days: { type: 'integer', minimum: 1, maximum: 60 },
        from: { type: 'string' }, to: { type: 'string' },
        start: { type: 'string' }, end: { type: 'string' }, calendar: { type: 'string' }
      },
      required: ['action'],
      additionalProperties: false,
      allOf: [
        { if: { properties: { action: { const: 'notes_search' } } }, then: { required: ['query'] } },
        { if: { properties: { action: { const: 'notes_create' } } }, then: { required: ['title', 'body'] } },
        { if: { properties: { action: { const: 'reminders_add' } } }, then: { required: ['title'] } },
        { if: { properties: { action: { const: 'calendar_add' } } }, then: { required: ['title', 'start'] } }
      ]
    },
    async run(a, ctx) {
      const sig = ctx.signal
      switch (a.action) {
        case 'notes_search': {
          const r = (await script(`(i) => { const N = Application('Notes'); const q = i.query.toLowerCase();
            return N.notes().filter((n) => (n.name() + ' ' + n.plaintext()).toLowerCase().includes(q)).slice(0, 10)
              .map((n) => ({ title: n.name(), modified: n.modificationDate().toISOString(), text: n.plaintext().slice(0, 600) })) }`, { query: a.query }, sig, undefined, ctx.progress)) as Array<{ title: string; modified: string; text: string }>
          return { text: r.length ? r.map((n) => `## ${n.title} (${n.modified.slice(0, 10)})\n${n.text}`).join('\n\n') : 'No notes match.', display: `${r.length} notes`, untrusted: r.length > 0 }
        }
        case 'notes_create': {
          await script(`(i) => { const N = Application('Notes'); const n = N.Note({ name: i.title, body: i.body.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/\\n/g,'<br>') }); N.defaultAccount().defaultFolder().notes.push(n); return true }`, { title: a.title, body: a.body }, sig, undefined, ctx.progress)
          return { text: `Created the note "${a.title}" in Notes.`, display: `created note "${a.title}"` }
        }
        case 'reminders_list': {
          const r = (await script(`(i) => { const R = Application('Reminders'); const lists = i.list ? R.lists.whose({ name: i.list })() : R.lists();
            const out = []; for (const l of lists) for (const x of l.reminders.whose({ completed: false })()) { out.push({ list: l.name(), title: x.name(), due: x.dueDate() ? x.dueDate().toISOString() : null }); if (out.length >= 50) return out } return out }`, { list: a.list ?? null }, sig, undefined, ctx.progress)) as Array<{ list: string; title: string; due: string | null }>
          return { text: r.length ? r.map((x) => `- ${x.title}${x.due ? ` (due ${x.due.slice(0, 16).replace('T', ' ')})` : ''} [${x.list}]`).join('\n') : 'No open reminders.', display: `${r.length} reminders` }
        }
        case 'reminders_add': {
          await script(`(i) => { const R = Application('Reminders'); const l = i.list ? R.lists.whose({ name: i.list })()[0] || R.defaultList() : R.defaultList();
            const props = { name: i.title }; if (i.due) props.dueDate = new Date(i.due); if (i.body) props.body = i.body; l.reminders.push(R.Reminder(props)); return true }`, { title: a.title, due: a.due ?? null, list: a.list ?? null, body: a.body ?? null }, sig, undefined, ctx.progress)
          return { text: `Added the reminder "${a.title}"${a.due ? ` due ${a.due}` : ''}.`, display: `added reminder "${a.title}"` }
        }
        case 'calendar_events': {
          const range = calendarRange(a)
          // A minute and a half: the first read can wait on macOS's Calendar access dialog.
          const r = (await script(CALENDAR_EVENTS, { from: range.from.toISOString(), to: range.to.toISOString() }, sig, 90_000, ctx.progress)) as { via: string; events: MacEvent[] } | MacEvent[]
          const events = Array.isArray(r) ? r : r?.events ?? []
          // Only invites carry other people's words (their titles, places and notes).
          return { text: formatEvents(events, range, Array.isArray(r) ? 'calendar' : r?.via ?? 'calendar'), display: `${events.length} events`, ...(events.some((e) => e.others) ? { untrusted: true } : {}) }
        }
        case 'calendar_add': {
          const start = new Date(a.start!)
          if (Number.isNaN(start.getTime())) throw new Error('start must be an ISO date-time, e.g. 2026-11-14T09:00')
          const end = a.end ? new Date(a.end) : new Date(start.getTime() + 3600_000)
          await script(`(i) => { const C = Application('Calendar'); const c = i.calendar ? C.calendars.whose({ name: i.calendar })()[0] : C.calendars().find((x) => { try { return x.writable() } catch (e) { return false } }) || C.calendars()[0];
            c.events.push(C.Event({ summary: i.title, startDate: new Date(i.start), endDate: new Date(i.end) })); return true }`, { title: a.title, start: start.toISOString(), end: end.toISOString(), calendar: a.calendar ?? null }, sig, undefined, ctx.progress)
          return { text: `Added "${a.title}" on ${start.toLocaleString()}.`, display: `added "${a.title}"` }
        }
      }
    }
  }
}
