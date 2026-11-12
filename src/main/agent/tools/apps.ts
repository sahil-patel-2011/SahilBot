import { execFile } from 'node:child_process'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import type { ToolContext, ToolDef } from '../types'

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
const agentPath = (): string | undefined => AGENT_PATHS.find((p) => existsSync(p))

/** Paths the agent may hand to Cursor: the workspace and anything the user attached. */
function allowed(p: string, ctx: ToolContext): string {
  const abs = isAbsolute(p) ? p : resolve(ctx.workspaceDir, p)
  const real = existsSync(abs) ? realpathSync(abs) : abs
  const roots = [ctx.workspaceDir, ...(ctx.state.roots ?? [])].map((r) => (existsSync(r) ? realpathSync(r) : r))
  if (!roots.some((r) => real === r || real.startsWith(r + sep))) throw new Error(`${p} is outside the workspace and the folders attached to this chat. Attach the folder first.`)
  return real
}

type CursorArgs = {
  action: 'status' | 'open' | 'agent' | 'cloud_launch' | 'cloud_list' | 'cloud_status' | 'cloud_followup' | 'cloud_stop'
  path?: string; line?: number; task?: string; folder?: string; repo?: string; ref?: string; id?: string; model?: string
}

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
    if (res.status === 401 || res.status === 403) throw new Error('Cursor rejected the API key. Add a valid one in Settings → API Keys & Servers (Cursor dashboard → API Keys).')
    if (res.status === 409) throw new Error('That Cursor agent is still working. Check its status, or wait before sending a follow-up.')
    throw new Error(`Cursor API ${res.status}: ${text.slice(0, 300)}`)
  }
  return text ? JSON.parse(text) : {}
}

export function cursorTool(cursorKey: () => string | undefined = () => undefined): ToolDef<CursorArgs> {
  return {
    name: 'cursor',
    label: 'Cursor',
    group: 'Cursor (code editor and agents)',
    effect: (a) => (['status', 'cloud_list', 'cloud_status'].includes(a.action) ? 'read' : a.action === 'open' ? 'write_local' : 'write_external'),
    // Cursor agents can change code and run commands: always confirm in Auto.
    consequential: (a) => ['agent', 'cloud_launch', 'cloud_followup', 'cloud_stop'].includes(a.action),
    describe: (a) => a.action === 'agent' ? `Ask Cursor's agent to work in ${a.folder}: "${(a.task ?? '').slice(0, 160)}"`
      : a.action === 'cloud_launch' ? `Start a Cursor cloud agent on ${a.repo}: "${(a.task ?? '').slice(0, 160)}"`
        : a.action === 'cloud_followup' ? `Send Cursor agent ${a.id} a follow-up: "${(a.task ?? '').slice(0, 160)}"`
          : a.action === 'cloud_stop' ? `Stop Cursor agent ${a.id}` : a.action === 'open' ? `Open ${a.path} in Cursor` : 'Check Cursor',
    description: 'Cursor, the AI code editor, and its agents. status: what is installed and connected. open: show a file or folder in Cursor (path, line). agent: run Cursor\'s agent on this Mac in a project folder (task, folder) and get its report. Cloud agents (needs a Cursor API key): cloud_launch(task, repo GitHub URL, ref?, model?) starts an agent that works on the repo and can open a PR; cloud_list; cloud_status(id) shows progress, result and branch/PR; cloud_followup(id, task) sends more instructions; cloud_stop(id).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'open', 'agent', 'cloud_launch', 'cloud_list', 'cloud_status', 'cloud_followup', 'cloud_stop'] },
        path: { type: 'string', description: 'For open: file or folder (absolute, or relative to the workspace)' },
        line: { type: 'integer', minimum: 1, description: 'For open: line to jump to' },
        task: { type: 'string', description: 'For agent, cloud_launch, cloud_followup: the instructions, specific and complete' },
        folder: { type: 'string', description: 'For agent: the project folder to work in' },
        repo: { type: 'string', description: 'For cloud_launch: GitHub repository URL, e.g. https://github.com/me/app' },
        ref: { type: 'string', description: 'For cloud_launch: branch or ref to start from (default: the default branch)' },
        id: { type: 'string', description: 'For cloud_status, cloud_followup, cloud_stop: the agent id (bc-…)' },
        model: { type: 'string', description: 'Optional Cursor model id' }
      },
      required: ['action'],
      additionalProperties: false,
      allOf: [
        { if: { properties: { action: { const: 'open' } } }, then: { required: ['path'] } },
        { if: { properties: { action: { const: 'agent' } } }, then: { required: ['task', 'folder'] } },
        { if: { properties: { action: { const: 'cloud_launch' } } }, then: { required: ['task', 'repo'] } },
        { if: { properties: { action: { enum: ['cloud_status', 'cloud_stop'] } } }, then: { required: ['id'] } },
        { if: { properties: { action: { const: 'cloud_followup' } } }, then: { required: ['id', 'task'] } }
      ]
    },
    async run(a, ctx) {
      const key = cursorKey()
      if (a.action.startsWith('cloud_') && !key) throw new Error('Cursor cloud agents need a Cursor API key. Ask the user to add it in Settings → API Keys & Servers (from the Cursor dashboard → API Keys).')
      switch (a.action) {
        case 'status': {
          const agent = agentPath()
          return {
            text: `Cursor app: ${cursorInstalled() ? 'installed' : 'not installed (cursor.com/download)'}\nCursor agent on this Mac: ${agent ? `installed (${agent})` : 'not installed. The user can install it with: curl https://cursor.com/install -fsS | bash'}\nCursor cloud agents: ${key ? 'connected (API key saved)' : 'not connected (add a Cursor API key in Settings)'}`,
            display: cursorInstalled() ? 'Cursor is installed' : 'Cursor not installed'
          }
        }
        case 'open': {
          if (!cursorInstalled()) throw new Error('Cursor is not installed. Get it at cursor.com/download.')
          const p = allowed(a.path!, ctx)
          if (existsSync(CURSOR_CLI)) await run(CURSOR_CLI, a.line && statSync(p).isFile() ? ['-g', `${p}:${a.line}`] : [p], { timeout: 15_000 })
          else await run('open', ['-a', 'Cursor', p], { timeout: 15_000 })
          return { text: `Opened ${p} in Cursor.`, display: `opened ${p.split('/').pop()}`, path: p }
        }
        case 'agent': {
          const agent = agentPath()
          if (!agent) throw new Error('Cursor\'s agent isn\'t installed on this Mac. Tell the user they can install it with: curl https://cursor.com/install -fsS | bash (then sign in with cursor-agent login), or use a Cursor cloud agent.')
          const folder = allowed(a.folder!, ctx)
          if (!statSync(folder).isDirectory()) throw new Error(`${a.folder} is not a folder.`)
          const args = ['-p', '--force', '--trust', '--output-format', 'text', ...(a.model ? ['--model', a.model] : []), a.task!]
          const out = await run(agent, args, { cwd: folder, timeout: 20 * 60_000, signal: ctx.signal })
          return { text: `Cursor's agent finished in ${folder}:\n\n${out.trim() || '(no output)'}`, display: 'Cursor agent finished' }
        }
        case 'cloud_launch': {
          const r = await cursorApi(key!, 'POST', '/v1/agents', { prompt: { text: a.task }, repos: [{ url: a.repo, ...(a.ref ? { startingRef: a.ref } : {}) }], ...(a.model ? { model: { id: a.model } } : {}), autoCreatePR: true }, ctx.signal)
          return { text: `Started Cursor cloud agent ${r.agent?.id} (${r.run?.status ?? 'creating'}). Watch it at ${r.agent?.url ?? 'cursor.com/agents'}. Check progress with cloud_status.`, display: `started ${r.agent?.id}` }
        }
        case 'cloud_list': {
          const r = await cursorApi(key!, 'GET', '/v1/agents?limit=20', undefined, ctx.signal)
          const items = (r.items ?? []) as Array<{ id: string; name?: string; status: string; repos?: Array<{ url: string }>; updatedAt?: string }>
          return { text: items.length ? items.map((x) => `- ${x.id} · ${x.name ?? ''} · ${x.status} · ${x.repos?.map((rp) => rp.url).join(', ') ?? ''} · ${x.updatedAt ?? ''}`).join('\n') : 'No Cursor cloud agents.', display: `${items.length} Cursor agents` }
        }
        case 'cloud_status': {
          const ag = await cursorApi(key!, 'GET', `/v1/agents/${encodeURIComponent(a.id!)}`, undefined, ctx.signal)
          const runInfo = ag.latestRunId ? await cursorApi(key!, 'GET', `/v1/agents/${encodeURIComponent(a.id!)}/runs/${encodeURIComponent(ag.latestRunId)}`, undefined, ctx.signal) : null
          const branches = (runInfo?.git?.branches ?? []) as Array<{ repoUrl: string; branch: string; prUrl?: string }>
          return {
            text: `Agent ${ag.id} (${ag.name ?? ''}): ${ag.status}\nLatest run: ${runInfo?.status ?? 'none'}${runInfo?.durationMs ? ` · ${Math.round(runInfo.durationMs / 1000)}s` : ''}\n${branches.map((b) => `Branch ${b.branch} on ${b.repoUrl}${b.prUrl ? ` · PR ${b.prUrl}` : ''}`).join('\n')}\n${runInfo?.result ? `Result:\n${typeof runInfo.result === 'string' ? runInfo.result : JSON.stringify(runInfo.result).slice(0, 4000)}` : ''}\nOpen: ${ag.url ?? ''}`,
            display: `${ag.id} · ${runInfo?.status ?? ag.status}`
          }
        }
        case 'cloud_followup': {
          const r = await cursorApi(key!, 'POST', `/v1/agents/${encodeURIComponent(a.id!)}/runs`, { prompt: { text: a.task } }, ctx.signal)
          return { text: `Sent the follow-up to ${a.id} (run ${r.run?.id ?? r.id ?? ''}, ${r.run?.status ?? r.status ?? 'queued'}).`, display: `follow-up sent to ${a.id}` }
        }
        case 'cloud_stop': {
          const ag = await cursorApi(key!, 'GET', `/v1/agents/${encodeURIComponent(a.id!)}`, undefined, ctx.signal)
          if (!ag.latestRunId) return { text: `${a.id} has no running work.`, display: 'nothing to stop' }
          await cursorApi(key!, 'POST', `/v1/agents/${encodeURIComponent(a.id!)}/runs/${encodeURIComponent(ag.latestRunId)}/cancel`, {}, ctx.signal)
          return { text: `Stopped ${a.id}'s current run.`, display: `stopped ${a.id}` }
        }
      }
    }
  }
}

// ------------------------------------------------------------------ Apple Notes, Reminders, Calendar

/** Runs a JavaScript for Automation snippet with JSON in and out (no string splicing into scripts). */
async function jxa(fn: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
  const script = `function run(argv) { const input = JSON.parse(argv[0]); return JSON.stringify((${fn})(input)); }`
  try {
    const out = await run('osascript', ['-l', 'JavaScript', '-e', script, JSON.stringify(input)], { timeout: 30_000, signal })
    return JSON.parse(out || 'null')
  } catch (e) {
    const m = (e as Error).message
    if (/-1743|not allowed|Not authorized/i.test(m)) throw new Error('macOS blocked access. The user can allow SahilBot in System Settings → Privacy & Security → Automation, then try again.')
    throw e
  }
}

type MacArgs = {
  action: 'notes_search' | 'notes_create' | 'reminders_list' | 'reminders_add' | 'calendar_events' | 'calendar_add'
  query?: string; title?: string; body?: string; list?: string; due?: string; days?: number; start?: string; end?: string; calendar?: string
}

export function macAppsTool(): ToolDef<MacArgs> {
  return {
    name: 'mac_apps',
    label: 'Mac apps',
    group: 'Apple Notes, Reminders, Calendar',
    // Notes and invites can contain text written by other people.
    untrusted: true,
    effect: (a) => (/_(search|list|events)$/.test(a.action) ? 'read' : 'write_local'),
    describe: (a) => (a.action === 'notes_create' ? `Create a note "${a.title}"` : a.action === 'reminders_add' ? `Add reminder "${a.title}"${a.due ? ` due ${a.due}` : ''}` : a.action === 'calendar_add' ? `Add "${a.title}" to your calendar at ${a.start}` : a.action.replace('_', ' ')),
    description: 'The Mac\'s own Notes, Reminders and Calendar apps (no setup; macOS asks once). notes_search(query): find notes. notes_create(title, body). reminders_list(list?): open reminders. reminders_add(title, due? ISO date-time, list?). calendar_events(days? default 7): upcoming events. calendar_add(title, start, end? ISO date-times, calendar?): add an event to the user\'s own calendar (no invitees).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['notes_search', 'notes_create', 'reminders_list', 'reminders_add', 'calendar_events', 'calendar_add'] },
        query: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, list: { type: 'string' },
        due: { type: 'string', description: 'ISO 8601, e.g. 2026-11-14T09:00' },
        days: { type: 'integer', minimum: 1, maximum: 60 },
        start: { type: 'string', description: 'ISO 8601' }, end: { type: 'string', description: 'ISO 8601' }, calendar: { type: 'string' }
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
          const r = (await jxa(`(i) => { const N = Application('Notes'); const q = i.query.toLowerCase();
            return N.notes().filter((n) => (n.name() + ' ' + n.plaintext()).toLowerCase().includes(q)).slice(0, 10)
              .map((n) => ({ title: n.name(), modified: n.modificationDate().toISOString(), text: n.plaintext().slice(0, 600) })) }`, { query: a.query }, sig)) as Array<{ title: string; modified: string; text: string }>
          return { text: r.length ? r.map((n) => `## ${n.title} (${n.modified.slice(0, 10)})\n${n.text}`).join('\n\n') : 'No notes match.', display: `${r.length} notes`}
        }
        case 'notes_create': {
          await jxa(`(i) => { const N = Application('Notes'); const n = N.Note({ name: i.title, body: i.body.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/\\n/g,'<br>') }); N.defaultAccount().defaultFolder().notes.push(n); return true }`, { title: a.title, body: a.body }, sig)
          return { text: `Created the note "${a.title}" in Notes.`, display: `created note "${a.title}"` }
        }
        case 'reminders_list': {
          const r = (await jxa(`(i) => { const R = Application('Reminders'); const lists = i.list ? R.lists.whose({ name: i.list })() : R.lists();
            const out = []; for (const l of lists) for (const x of l.reminders.whose({ completed: false })()) { out.push({ list: l.name(), title: x.name(), due: x.dueDate() ? x.dueDate().toISOString() : null }); if (out.length >= 50) return out } return out }`, { list: a.list ?? null }, sig)) as Array<{ list: string; title: string; due: string | null }>
          return { text: r.length ? r.map((x) => `- ${x.title}${x.due ? ` (due ${x.due.slice(0, 16).replace('T', ' ')})` : ''} [${x.list}]`).join('\n') : 'No open reminders.', display: `${r.length} reminders` }
        }
        case 'reminders_add': {
          await jxa(`(i) => { const R = Application('Reminders'); const l = i.list ? R.lists.whose({ name: i.list })()[0] || R.defaultList() : R.defaultList();
            const props = { name: i.title }; if (i.due) props.dueDate = new Date(i.due); if (i.body) props.body = i.body; l.reminders.push(R.Reminder(props)); return true }`, { title: a.title, due: a.due ?? null, list: a.list ?? null, body: a.body ?? null }, sig)
          return { text: `Added the reminder "${a.title}"${a.due ? ` due ${a.due}` : ''}.`, display: `added reminder "${a.title}"` }
        }
        case 'calendar_events': {
          const r = (await jxa(`(i) => { const C = Application('Calendar'); const from = new Date(); const to = new Date(Date.now() + i.days * 864e5); const out = [];
            for (const c of C.calendars()) { for (const e of c.events.whose({ _and: [{ startDate: { _greaterThan: from } }, { startDate: { _lessThan: to } }] })()) out.push({ cal: c.name(), title: e.summary(), start: e.startDate().toISOString(), end: e.endDate().toISOString(), where: e.location() || '' }) }
            return out.sort((a, b) => a.start < b.start ? -1 : 1).slice(0, 60) }`, { days: a.days ?? 7 }, sig)) as Array<{ cal: string; title: string; start: string; end: string; where: string }>
          return { text: r.length ? r.map((e) => `- ${new Date(e.start).toLocaleString()} – ${new Date(e.end).toLocaleTimeString()}: ${e.title}${e.where ? ` @ ${e.where}` : ''} [${e.cal}]`).join('\n') : 'No events in that range.', display: `${r.length} events`}
        }
        case 'calendar_add': {
          const start = new Date(a.start!)
          if (Number.isNaN(start.getTime())) throw new Error('start must be an ISO date-time, e.g. 2026-11-14T09:00')
          const end = a.end ? new Date(a.end) : new Date(start.getTime() + 3600_000)
          await jxa(`(i) => { const C = Application('Calendar'); const c = i.calendar ? C.calendars.whose({ name: i.calendar })()[0] : C.calendars().find((x) => { try { return x.writable() } catch (e) { return false } }) || C.calendars()[0];
            c.events.push(C.Event({ summary: i.title, startDate: new Date(i.start), endDate: new Date(i.end) })); return true }`, { title: a.title, start: start.toISOString(), end: end.toISOString(), calendar: a.calendar ?? null }, sig)
          return { text: `Added "${a.title}" on ${start.toLocaleString()}.`, display: `added "${a.title}"` }
        }
      }
    }
  }
}
