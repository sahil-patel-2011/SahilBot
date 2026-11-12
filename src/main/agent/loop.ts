import { randomUUID } from 'node:crypto'
import type { ApprovalAnswer, Attachment, ChatEvent, Effort, TeamMember, Message, PendingRequest, SendInput, Space, Thread, Tier, ToolCall, ToolEffect } from '@shared/types'
import type { Db } from '../db'
import type { MemoryStore } from '../memory'
import type { SettingsStore } from '../settings'
import type { SpaceFiles } from '../spaces'
import { samplingFor } from '../llm/catalog'
import { isLocal, streamChat, type WireMessage } from '../llm/client'
import type { Endpoints } from '../llm/endpoints'
import { teamCapacity } from '../llm/models'
import { decide as route, pick } from '../llm/router'
import { ContextManager, OUTPUT_RESERVE, ResultStore, ServerTokenCounter, SUMMARY_INSTRUCTIONS, wrapToolOutput, type TokenCounter } from './context'
import { containsSecret, decide, isTainted } from './permissions'
import { VOICE_SUFFIX, groupNote, harnessPrompt } from './prompt'
import type { ToolRegistry } from './registry'
import type { ThreadState, ToolContext, ToolDef, ToolOutput } from './types'
import { check, repairPrompt } from './validate'
import { LoopGuard, fixName, recoverToolCalls } from './recover'

/**
 * No fixed step count: a run gets a budget that grows with the agent's own plan and with progress
 * (each finished plan item buys more room). HARD_CAP only stops a runaway loop.
 */
export const START_BUDGET = 24
export const HARD_CAP = 160
export const PER_PLAN_ITEM = 10

export interface AgentDeps {
  db: Db
  settings: SettingsStore
  /** Which server each model lives on, and the models Auto can use. */
  endpoints: Endpoints
  spaces: SpaceFiles
  memory: MemoryStore
  /** Learned procedures; their index goes in the prompt. */
  skills?: { index(max?: number): string }
  /** Standing rules; enabled ones go in the prompt. */
  rules?: { block(botId?: string, projectId?: string): string }
  registry: ToolRegistry
  results: ResultStore
  docsDir: string
  emit: (e: ChatEvent) => void
  /** Plain-text vault secrets, used only to block leaks. */
  secretValues: () => string[]
  /** Clamp the window to what the model can actually hold on this Mac. */
  fitWindow: (model: string, window: number) => number
  /** Catalog matches for an unconnected app, and a one-click connect returning the new tool names. */
  connectors?: { suggest(q: string): import('@shared/types').ConnectorPreset[]; connectPreset(id: string): Promise<{ state: string; toolNames?: string[] }> }
  /** Override for tests. */
  counter?: (baseUrl: string, model: string) => TokenCounter
}

interface Pending {
  request: PendingRequest
  resolve: (answer: string) => void
}

interface Run {
  ctrl: AbortController
  pending: Map<string, Pending>
  /** The bot speaking right now (groups have several per user message). */
  speaker?: Space
  group: boolean
  /** Scheduled run with nobody watching: anything that would ask is skipped instead. */
  unattended?: boolean
  /** A helper agent working for another agent (Team of Experts). */
  helper?: boolean
}

const HELPER_NOTE = (depth: number): string => `

# You are a helper agent
You are one of several helper agents working in parallel for a lead agent on a bigger job. The message below is your part.
- You can't see the lead's conversation, and nobody can approve actions for you: anything that needs the user's OK is skipped, so leave it for the lead and say what you would do.
- Work fully and on your own: look things up, read pages and files, run commands, make files when your part needs it. Don't stop early, and check what you report.
- Finish with a report for the lead: what you found (with source URLs and exact names, numbers and dates), files you made (full paths), and anything you couldn't do or confirm. Complete but compact.${depth < 2 ? '\n- If your part is itself big, you may split it with the agents tool.' : '\n- Do the work yourself; you can\'t start more helpers.'}`


const MAX_BOT_HOPS = 4

const LEVELS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
/**
 * Adaptive thinking: the chosen level is the center, shifted by how hard the request is. Small talk
 * answers at low; quick questions one step down; hard tasks one step up (never past Extra unless Max
 * was chosen). The model's own adaptive thinking then decides within that level.
 */
export function adaptiveEffort(base: Effort, tier?: Tier): Effort {
  const i = LEVELS.indexOf(base)
  if (tier === undefined || base === 'max') return base
  if (tier === 0) return 'low'
  if (tier === 1) return LEVELS[Math.max(0, i - 1)]
  if (tier === 3) return LEVELS[Math.min(3, Math.max(i, i + 1))]
  return base
}

/** How a request was sized: its difficulty, why, and whether Auto picked the model (manual = the user did). */
type Routed = { tier: Tier; why: string; label?: string; manual?: boolean }

/** What one bot sees in a group chat: its own turns as assistant, other bots' replies as quoted user text. */
export function perspective(messages: Message[], speakerId: string): Message[] {
  return messages.flatMap((m) => {
    const bot = m.meta?.botId as string | undefined
    if (!bot || bot === speakerId) return [m]
    if (m.role === 'tool') return []
    if (m.role === 'assistant') return m.content ? [{ ...m, role: 'user' as const, toolCalls: undefined, content: `[${String(m.meta?.botName)}]: ${m.content}` }] : []
    return [m]
  })
}

/** Members addressed as @Name in `text`, in the order they appear. */
export function mentioned(text: string, members: Space[]): Space[] {
  const lower = text.toLowerCase()
  return members
    .map((b) => ({ b, i: lower.indexOf(`@${b.name.toLowerCase()}`) }))
    .filter((x) => x.i >= 0)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.b)
}

const pretty = (raw: string): string => {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

export class Agent {
  private runs = new Map<string, Run>()

  constructor(private d: AgentDeps) {}

  isRunning(threadId: string): boolean {
    return this.runs.has(threadId)
  }

  pending(threadId: string): PendingRequest[] {
    return [...(this.runs.get(threadId)?.pending.values() ?? [])].map((p) => p.request)
  }

  respond(threadId: string, requestId: string, answer: string): void {
    const run = this.runs.get(threadId)
    const p = run?.pending.get(requestId)
    if (!p) return
    run!.pending.delete(requestId)
    this.d.emit({ threadId, type: 'resolved', id: requestId })
    p.resolve(answer)
  }

  stop(threadId: string): void {
    const run = this.runs.get(threadId)
    if (!run) return
    run.ctrl.abort()
    for (const id of [...run.pending.keys()]) this.respond(threadId, id, 'deny')
  }

  /** Resolves once the message is stored and the run has started; `done` resolves when the run ends. */
  async send(input: SendInput, opts: { unattended?: boolean } = {}): Promise<{ done: Promise<'finished' | 'stopped' | 'error'> }> {
    const thread = this.d.db.getThread(input.threadId)
    if (!thread) throw new Error('Thread not found')
    if (this.runs.has(thread.id)) throw new Error('SahilBot is still working in this thread. Stop it first or wait.')

    const history = this.d.db.listMessages(thread.id)
    const lastUserAt = [...history].reverse().find((m) => m.role === 'user')?.createdAt ?? 0
    const notes: string[] = []
    for (const m of history) {
      const r = m.meta?.reactions as { user?: string; userAt?: number } | undefined
      if (m.role === 'assistant' && r?.user && (r.userAt ?? 0) > lastUserAt) notes.push(`[The user reacted ${r.user} to your message: "${m.content.replace(/\s+/g, ' ').slice(0, 80)}"]`)
    }
    if (input.note) notes.push(input.note)
    if (input.team) notes.push('[Team of Experts is on for this request: 1) Write your plan with todo. 2) Send the research and independent parts to helper agents with the agents tool, in parallel, as many as genuinely help (each with a complete, self-contained task and what to report). 3) Compare their reports, check anything that matters, fill gaps yourself. 4) Then do the rest of the job yourself, carefully, and double-check the result before you answer.]')

    if (input.voice) {
      const st = this.d.db.getState(thread.id)
      if (!st.voice) {
        st.voice = true
        this.d.db.setState(thread.id, st)
      }
    }

    // Attached files and folders (already verified as user-picked by main) become this thread's roots.
    const att = input.attachments ?? []
    const images = [...(input.images ?? []), ...att.filter((a) => a.kind === 'image' && a.dataUrl).map((a) => a.dataUrl!)]
    if (att.length) {
      const state = this.d.db.getState(thread.id)
      state.roots = [...new Set([...(state.roots ?? []), ...att.map((a) => a.path)])]
      this.d.db.setState(thread.id, state)
      const files = att.filter((a) => a.kind !== 'folder')
      const folders = att.filter((a) => a.kind === 'folder')
      if (files.length) notes.push(`[Attached files — read them with file_read using these exact paths; you may edit them (a backup is kept):\n${files.map((f) => `- ${f.path}${f.size ? ` (${Math.round(f.size / 1024)} KB)` : ''}${f.kind === 'image' ? ' (image, shown to you)' : ''}`).join('\n')}]`)
      if (folders.length) notes.push(`[Attached folders — you can list, read, create, edit and move files inside them with absolute paths; deleting asks the user:\n${folders.map((f) => `- ${f.path}/`).join('\n')}]`)
    }
    const user = this.d.db.insertMessage({
      threadId: thread.id, role: 'user', content: input.text, kind: 'normal', status: 'done',
      images: images.length ? images : undefined,
      meta: {
        ...(notes.length ? { note: notes.join('\n') } : {}),
        ...(att.length ? { files: att.filter((a) => a.kind !== 'folder').map((a) => ({ name: a.name, path: a.path })), folders: att.filter((a) => a.kind === 'folder').map((a) => a.path) } : {}),
        ...(input.meta ?? {}),
        ...(input.team ? { team: true } : {})
      }
    })
    this.d.emit({ threadId: thread.id, type: 'message', message: user })
    if (thread.title === 'New thread') {
      const title = input.text.replace(/\s+/g, ' ').trim().slice(0, 60) || att[0]?.name || 'New thread'
      this.d.emit({ threadId: thread.id, type: 'thread', thread: this.d.db.updateThread(thread.id, { title }) })
    }

    // Project chats can always work in the project's folder.
    const sp = this.d.db.getSpace(thread.spaceId)
    if (sp?.kind === 'project' && sp.folder) {
      const st = this.d.db.getState(thread.id)
      if (!(st.roots ?? []).includes(sp.folder)) {
        st.roots = [...(st.roots ?? []), sp.folder]
        this.d.db.setState(thread.id, st)
      }
    }
    return this.start(thread, input.text, opts)
  }

  /**
   * After the first exchange, a local model names the chat in a few words. Cloud models keep the
   * first-message title so no extra paid request is made.
   */
  private async autoTitle(threadId: string): Promise<void> {
    const s = this.d.settings.get()
    const thread = this.d.db.getThread(threadId)
    const space = thread && this.d.db.getSpace(thread.spaceId)
    if (process.env.FOREMAN_NO_AUTOTITLE || !thread || !space || (space.kind !== 'project' && !space.isMain)) return
    // Titles come from a small local model, never a paid one.
    const titleModel = s.taskModels.background || pick(this.d.endpoints.usable().filter((m) => m.note !== 'remote'), 0)?.id
    if (!titleModel) return
    const ep = this.d.endpoints.for(titleModel)
    if (!isLocal(ep.baseUrl)) return
    const ms = this.d.db.listMessages(threadId).filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content && !m.meta?.hidden)
    const firstUser = ms.find((m) => m.role === 'user')
    if (!firstUser || ms.filter((m) => m.role === 'user').length !== 1 || thread.title !== firstUser.content.replace(/\s+/g, ' ').trim().slice(0, 60)) return
    const reply = ms.find((m) => m.role === 'assistant')?.content ?? ''
    let title = ''
    try {
      for await (const part of streamChat({
        baseUrl: ep.baseUrl, apiKey: ep.apiKey, model: titleModel, maxTokens: 24, signal: AbortSignal.timeout(20_000),
        sampling: { ...samplingFor(titleModel, s.sampling), temperature: 0.2 },
        messages: [
          { role: 'system', content: 'Write a short title (2-6 words) for this chat. Reply with the title only: no quotes, no punctuation at the end. /no_think' },
          { role: 'user', content: `User: ${firstUser.content.slice(0, 600)}\nAssistant: ${reply.slice(0, 600)}` }
        ]
      })) if (part.type === 'content') title += part.text
    } catch {
      return
    }
    title = title.replace(/<[^>]+>/g, '').replace(/^["'\s#*]+|["'.\s*]+$/g, '').split('\n')[0].slice(0, 60)
    if (title.length < 3 || this.runs.has(threadId)) return
    this.d.emit({ threadId, type: 'thread', thread: this.d.db.updateThread(threadId, { title }) })
  }

  /** Regenerate: drop everything after your last message and run again (only the tail changes). */
  retry(threadId: string): void {
    const thread = this.d.db.getThread(threadId)
    if (!thread || this.runs.has(threadId)) throw new Error('SahilBot is still working in this thread.')
    const lastUser = [...this.d.db.listMessages(threadId)].reverse().find((m) => m.role === 'user' && !m.meta?.hidden)
    if (!lastUser) throw new Error('Nothing to retry yet.')
    this.d.db.deleteAfter(threadId, lastUser.id)
    this.d.emit({ threadId, type: 'thread', thread })
    this.start(thread, lastUser.content)
  }

  /** Edit and resend your last message. */
  editLast(threadId: string, text: string): void {
    const thread = this.d.db.getThread(threadId)
    if (!thread || this.runs.has(threadId)) throw new Error('SahilBot is still working in this thread.')
    const lastUser = [...this.d.db.listMessages(threadId)].reverse().find((m) => m.role === 'user' && !m.meta?.hidden)
    if (!lastUser) throw new Error('Nothing to edit yet.')
    lastUser.content = text
    this.d.db.updateMessage(lastUser)
    this.d.db.deleteAfter(threadId, lastUser.id)
    this.d.emit({ threadId, type: 'message', message: lastUser })
    this.start(thread, text)
  }

  /** A new bot introduces itself: a hidden instruction the user never sees, then a normal run. */
  intro(threadId: string, instruction: string): void {
    const thread = this.d.db.getThread(threadId)
    if (!thread || this.runs.has(threadId)) return
    this.d.db.insertMessage({ threadId, role: 'user', content: instruction, kind: 'normal', status: 'done', meta: { hidden: true } })
    this.start(thread, '')
  }

  private start(thread: Thread, userText: string, opts: { unattended?: boolean } = {}): { done: Promise<'finished' | 'stopped' | 'error'> } {
    const space = this.d.db.getSpace(thread.spaceId)
    const group = space?.kind === 'group'
    const run: Run = { ctrl: new AbortController(), pending: new Map(), group, unattended: opts.unattended }
    this.runs.set(thread.id, run)
    this.d.emit({ threadId: thread.id, type: 'run', status: 'started' })
    const done = this.speakers(thread, run, space, userText)
      .catch((e) => { this.notice(thread.id, `Run failed: ${(e as Error).message}`); return 'error' as const })
      .finally(() => { if (this.runs.get(thread.id) === run) this.runs.delete(thread.id) })
    return { done }
  }

  /** One speaker for a normal chat; for a group, the addressed bots (or all), then any bots they @mention. */
  private async speakers(thread: Thread, run: Run, space: Space | undefined, userText: string): Promise<'finished' | 'stopped' | 'error'> {
    let status: 'finished' | 'stopped' | 'error' = 'finished'
    let error: string | undefined
    try {
      if (!space || space.kind !== 'group') {
        status = await this.loop(thread, run, space)
      } else {
        const members = space.members.map((id) => this.d.db.getSpace(id)).filter((b): b is Space => !!b)
        if (!members.length) throw new Error('This group has no bots. Add some in its settings.')
        const queue = mentioned(userText, members)
        if (!queue.length) queue.push(...members)
        let hops = 0
        while (queue.length && status === 'finished') {
          const bot = queue.shift()!
          run.speaker = bot
          status = await this.loop(thread, run, bot)
          const said = [...this.d.db.listMessages(thread.id)].reverse().find((m) => m.role === 'assistant' && m.meta?.botId === bot.id && m.content)
          for (const next of mentioned(said?.content ?? '', members)) {
            if (next.id !== bot.id && hops < MAX_BOT_HOPS && !queue.includes(next)) {
              queue.push(next)
              hops++
            }
          }
        }
      }
    } catch (e) {
      status = 'error'
      error = (e as Error).message
      if (!(e as { shown?: boolean }).shown) this.notice(thread.id, `Something went wrong: ${error}`)
    }
    // Unregister before announcing the end, so a message sent the instant the UI unlocks is accepted.
    this.runs.delete(thread.id)
    if (status === 'finished') void this.autoTitle(thread.id)
    const t = this.d.db.updateThread(thread.id, { unread: true }, true)
    this.d.emit({ threadId: thread.id, type: 'thread', thread: t })
    this.d.emit({ threadId: thread.id, type: 'run', status, error })
    return status
  }

  // -------------------------------------------------------------------------

  private systemFor(thread: Thread, state: ThreadState, speaker?: Space, group?: Space): string {
    const build = (bot: Space | undefined): string => {
      const s = this.d.settings.get()
      return harnessPrompt({
        date: new Date(),
        userName: s.userName,
        workspaceDir: s.workspaceDir,
        memories: this.d.memory.block(),
        spacePrompt: this.d.spaces.getPrompt(bot?.id ?? thread.spaceId),
        spaceName: bot?.name ?? 'SahilBot',
        projectFolder: bot?.kind === 'project' ? bot.folder ?? undefined : undefined,
        skills: this.d.skills?.index(),
        rules: this.d.rules?.block(bot?.id ?? thread.spaceId, bot?.kind === 'project' ? bot.id : undefined),
        ...(bot?.kind === 'project' ? this.projectContext(bot.id, thread.id) : {})
      })
    }
    if (group && speaker) {
      state.snapshots ??= {}
      if (!state.snapshots[speaker.id]) {
        const others = group.members.map((id) => this.d.db.getSpace(id)?.name).filter((n): n is string => !!n && n !== speaker.name)
        state.snapshots[speaker.id] = build(speaker) + groupNote(speaker.name, group.name, others)
      }
      return state.snapshots[speaker.id]
    }
    if (!state.systemSnapshot) state.systemSnapshot = build(this.d.db.getSpace(thread.spaceId)) + (state.voice ? VOICE_SUFFIX : '')
    return state.systemSnapshot
  }

  /** Helper agents started per chat (the whole tree counts toward the limit). */
  private teamUsed = new Map<string, number>()
  /** Final team per agents call, attached to its tool result. */
  private lastTeam = new Map<string, TeamMember[]>()
  /** Live team cards by the root agents call. */
  private boards = new Map<string, TeamMember[]>()

  /**
   * Team of Experts: each task runs as its own hidden agent thread with the same tools and rules, in
   * parallel up to what this Mac can hold, all on the lead's model (one model loaded, not several).
   * Helpers can't get approvals, so anything that needs one is left for the lead.
   */
  private async runTeam(parent: Thread, run: Run, callId: string, tasks: Array<{ title: string; task: string }>): Promise<Array<{ title: string; status: string; report: string }>> {
    const { db } = this.d
    const pstate = db.getState(parent.id)
    const depth = (pstate.depth ?? 0) + 1
    if (depth > 2) throw new Error('Helper agents can only go two levels deep. Do this part yourself.')
    const rootId = pstate.rootId ?? parent.id
    const model = this.lastModel.get(parent.id) ?? parent.model ?? this.d.settings.get().defaultModel
    const cap = teamCapacity(this.d.endpoints.last?.models.find((m) => m.id === model))
    const used = this.teamUsed.get(rootId) ?? 0
    if (used + tasks.length > cap.maxAgents) {
      throw new Error(`This Mac can run ${cap.maxAgents} helper agents per task with this model (${cap.why}); ${Math.max(0, cap.maxAgents - used)} left. Combine the work into fewer, bigger tasks or do the rest yourself.`)
    }
    this.teamUsed.set(rootId, used + tasks.length)
    const space = db.getSpace(parent.spaceId)
    const members: TeamMember[] = tasks.map((t, i) => ({ id: `${callId}-${i}`, title: t.title, status: 'queued', depth, model }))
    // One card in the lead's chat shows the whole team, helpers of helpers included.
    const rootCallId = depth === 1 ? callId : pstate.rootCallId ?? callId
    const board = this.boards.get(rootCallId) ?? []
    board.push(...members)
    this.boards.set(rootCallId, board)
    const show = (): void => this.d.emit({ threadId: rootId, type: 'team', callId: rootCallId, members: board.map((m) => ({ ...m })) })
    show()
    const children: string[] = []
    const tick = setInterval(() => {
      children.forEach((cid, i) => {
        if (!cid || members[i].status !== 'working') return
        const last = [...db.listMessages(cid)].reverse().find((m) => m.role === 'tool' || (m.role === 'assistant' && m.content))
        members[i].detail = last?.role === 'tool' ? String(last.meta?.display ?? last.toolName ?? '') : last?.content.replace(/\s+/g, ' ').slice(0, 90)
      })
      show()
    }, 1500)

    let next = 0
    const results: Array<{ title: string; status: string; report: string }> = new Array(tasks.length)
    const worker = async (): Promise<void> => {
      while (next < tasks.length) {
        const i = next++
        if (run.ctrl.signal.aborted) { members[i].status = 'stopped'; results[i] = { title: tasks[i].title, status: 'stopped', report: '' }; continue }
        members[i].status = 'working'
        show()
        const child = db.createThread(parent.spaceId, parent.permissionMode, model, parent.id)
        children[i] = child.id
        db.updateThread(child.id, { title: tasks[i].title })
        const st = db.getState(child.id)
        st.roots = pstate.roots
        st.depth = depth
        st.rootId = rootId
        st.rootCallId = rootCallId
        st.systemSnapshot = this.systemFor(child, { ...st }) + HELPER_NOTE(depth)
        db.setState(child.id, st)
        db.insertMessage({ threadId: child.id, role: 'user', content: tasks[i].task, kind: 'normal', status: 'done' })
        const crun: Run = { ctrl: new AbortController(), pending: new Map(), group: false, unattended: true, helper: true }
        const stop = (): void => crun.ctrl.abort()
        run.ctrl.signal.addEventListener('abort', stop, { once: true })
        this.runs.set(child.id, crun)
        let status: string
        try {
          status = await this.loop(db.getThread(child.id)!, crun, space)
        } catch {
          status = 'error'
        } finally {
          this.runs.delete(child.id)
          run.ctrl.signal.removeEventListener('abort', stop)
        }
        const report = [...db.listMessages(child.id)].reverse().find((m) => m.role === 'assistant' && m.kind === 'normal' && m.content && !m.meta?.superseded)?.content ?? ''
        members[i].status = status === 'finished' ? 'done' : status === 'stopped' ? 'stopped' : 'failed'
        members[i].detail = report.replace(/\s+/g, ' ').slice(0, 120)
        results[i] = { title: tasks[i].title, status: members[i].status, report }
        show()
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(cap.parallel, tasks.length) }, worker))
    } finally {
      clearInterval(tick)
      show()
    }
    if (depth === 1) {
      // Keep the final team on the tool result so the card survives a restart.
      this.lastTeam.set(callId, board.map((m) => ({ ...m })))
      this.boards.delete(rootCallId)
    }
    return results
  }

  /** What a project's chats share: its memories and a line about each other chat in it. */
  private projectContext(projectId: string, threadId: string): { projectNotes: string; projectChats: string } {
    const projectNotes = this.d.memory.block(2000, projectId)
    const lines: string[] = []
    let used = 0
    for (const t of this.d.db.listThreads(projectId).filter((x) => x.id !== threadId).slice(0, 12)) {
      const st = this.d.db.getState(t.id)
      const ms = this.d.db.listMessages(t.id).filter((m) => (m.role === 'user' || m.role === 'assistant') && m.kind === 'normal' && m.content && !m.meta?.hidden)
      const gist = (st.compaction?.summary.match(/Goal[:\s#]*\n?([^\n]+)/i)?.[1] ?? ms.find((m) => m.role === 'user')?.content ?? '').replace(/\s+/g, ' ').slice(0, 140)
      const outcome = [...ms].reverse().find((m) => m.role === 'assistant')?.content.replace(/\s+/g, ' ').slice(0, 160) ?? ''
      const line = `- "${t.title}" (${new Date(t.updatedAt).toISOString().slice(0, 10)}): ${gist}${outcome ? ` → ${outcome}` : ''}`
      if (used + line.length > 2400) break
      lines.push(line)
      used += line.length
    }
    return { projectNotes, projectChats: lines.join('\n') }
  }

  private notice(threadId: string, text: string): void {
    const m = this.d.db.insertMessage({ threadId, role: 'assistant', content: text, kind: 'notice', status: 'done' })
    this.d.emit({ threadId, type: 'message', message: m })
  }

  private ask(threadId: string, run: Run, req: Omit<PendingRequest, 'id' | 'threadId'>): Promise<string> {
    const request: PendingRequest = { ...req, id: randomUUID(), threadId }
    return new Promise((resolve) => {
      if (run.ctrl.signal.aborted) return resolve('deny')
      run.pending.set(request.id, { request, resolve })
      this.d.emit({ threadId, type: 'pending', request })
    })
  }

  /** The model each run actually used (Auto picks per request). */
  private lastModel = new Map<string, string>()

  /**
   * Resolve "auto" (or a model that's gone) to a concrete model. Auto routes by how hard the request
   * is; voice conversations use the voice model setting when one is chosen.
   */
  private async chooseModel(requested: string, thread: Thread, state: import('./types').ThreadState): Promise<{ model: string; routed?: Routed }> {
    const s = this.d.settings.get()
    if (!this.d.endpoints.last) await this.d.endpoints.list().catch(() => undefined)
    // Nothing fits comfortably: still use what's installed (the server can run it, just slower).
    let usable = this.d.endpoints.usable()
    if (!usable.length) usable = (this.d.endpoints.last?.models ?? []).filter((m) => m.installed && !s.hiddenModels.includes(m.id))
    const last = [...this.d.db.listMessages(thread.id)].reverse().find((m) => m.role === 'user' && !m.meta?.hidden)
    const files = [...((last?.meta?.files as Array<{ name: string; path: string }>) ?? []).map((f) => ({ kind: /\.(png|jpe?g|gif|webp|heic)$/i.test(f.path) ? 'image' : 'file', path: f.path, name: f.name })),
      ...((last?.meta?.folders as string[]) ?? []).map((p) => ({ kind: 'folder', path: p, name: p }))] as Attachment[]
    const r = route({
      text: last?.content ?? '', attachments: files, images: last?.images?.length ?? 0, previousTier: state.lastTier,
      voice: !!state.voice, openPlan: state.todos.some((t) => t.status !== 'done')
    })
    // A chosen model keeps its choice; the difficulty still sets how hard it thinks.
    if (state.voice && s.taskModels.voice && (requested === 'auto' || !requested)) return this.remember(thread.id, s.taskModels.voice, { tier: r.tier, why: r.why, manual: true })
    if (requested && requested !== 'auto') { state.lastTier = r.tier; return this.remember(thread.id, requested, { tier: r.tier, why: r.why, manual: true }) }
    // Voice conversations: a small, fast local model so replies start right away (unless the request is hard).
    const fast = state.voice && r.tier <= 2 ? pick(usable.filter((m) => m.note !== 'remote' && m.tier <= 1), 0) : undefined
    const chosen = fast ?? pick(usable, r.tier, { needsVision: !!last?.images?.length })
    if (!chosen) throw new Error('No models are available. Start Ollama or LM Studio, or add an API key in Settings → Models.')
    state.lastTier = r.tier
    return this.remember(thread.id, chosen.id, { tier: r.tier, why: r.why, label: chosen.label })
  }

  private remember(threadId: string, model: string, routed?: Routed): { model: string; routed?: Routed } {
    this.lastModel.set(threadId, model)
    return { model, routed }
  }

  private async loop(thread: Thread, run: Run, space: Space | undefined): Promise<'finished' | 'stopped' | 'error'> {
    const { db, settings, registry, results } = this.d
    const s = settings.get()
    const group = run.group ? db.getSpace(thread.spaceId) : undefined
    const speaker = group ? space : undefined
    const state = db.getState(thread.id)
    const { model, routed } = await this.chooseModel(speaker?.model || db.getThread(thread.id)?.model || space?.model || s.defaultModel, thread, state)
    const ep = this.d.endpoints.for(model)
    const claude = ep.provider === 'anthropic'
    // Voice keeps a 16k window so replies start fast; Claude gets a larger window (1M available, cached).
    // Auto (0): the largest window that fits this Mac with this model; Claude gets plenty (cached).
    const window = Math.min(claude ? Math.max(s.contextWindow, 131072) : this.d.fitWindow(model, s.contextWindow || 131072), state.voice ? 16384 : Infinity)
    const system = this.systemFor(thread, state, speaker, group)
    db.setState(thread.id, state)
    const view = (ms: Message[]): Message[] => (speaker ? perspective(ms, speaker.id) : ms)

    const counter = this.d.counter?.(ep.baseUrl, model) ?? new ServerTokenCounter(ep.baseUrl, model)
    const cm = new ContextManager(counter, (text, maxTokens) => this.summarize(model, text, maxTokens, run.ctrl.signal), results)

    // Untrusted text seen in this thread, for the taint check on outside actions.
    const history = db.listMessages(thread.id)
    const untrusted: string[] = history.filter((m) => m.role === 'tool' && m.meta?.untrusted).slice(-20).map((m) => m.content)
    const userText = history.filter((m) => m.role === 'user').map((m) => m.content).join('\n')
    const failures = new Map<string, number>()
    const guard = new LoopGuard()
    let nudged = false
    let linkChecked = false
    let verified = false
    // Set by execute(): did this run change anything or research anything? Then it gets a self-check pass.
    const track = { changed: false, researched: false }
    const runStart = Date.now()
    let status: 'finished' | 'stopped' | 'error' = 'finished'
    let budget = START_BUDGET
    let actions = 0
    state.consults = 0
    let doneItems = state.todos.filter((t) => t.status === 'done').length
    const planPos = (): { at: number; of: number } | undefined => {
      if (!state.todos.length) return undefined
      const i = state.todos.findIndex((t) => t.status !== 'done')
      return { at: i < 0 ? state.todos.length : i + 1, of: state.todos.length }
    }

    try {
      for (let step = 1; step <= budget; step++) {
        if (run.ctrl.signal.aborted) throw new DOMException('stopped', 'AbortError')
        const tools = registry.listFor(state)
        const wireTools = registry.wire(tools)
        const prepared = await cm.prepare({ system, toolsJson: JSON.stringify(wireTools), messages: view(db.listMessages(thread.id)), state, window, appendOnly: claude, allowCompact: !claude || step === 1 })
        if (prepared.compacted) {
          db.setState(thread.id, state)
          const marker = db.insertMessage({
            threadId: thread.id, role: 'assistant', kind: 'compacted', status: 'done', content: prepared.compacted.summary,
            meta: { before: prepared.compacted.before, after: prepared.compacted.after, boundaryId: prepared.compacted.boundaryId }
          })
          this.d.emit({ threadId: thread.id, type: 'message', message: marker })
        }
        this.d.emit({ threadId: thread.id, type: 'progress', step, actions, plan: planPos(), used: prepared.used, window, model, routed })

        // Keep the plan in view on long runs (appended at the end, so the cached prefix is untouched).
        const open = state.todos.filter((t) => t.status !== 'done')
        const late = step >= budget - 2 ? ' You are close to this run\'s step budget: finish the current item, then summarize what is done and what is left.' : ''
        if (open.length && (prepared.compacted || (step > 1 && step % 5 === 0) || late)) prepared.wire.push({ role: 'user', content: `[Plan reminder from the app]${late}\n${planText(state)}` })
        else if (late) prepared.wire.push({ role: 'user', content: `[From the app]${late}` })

        const assistant = await this.stream(thread.id, model, prepared.wire, wireTools, window, run, speaker, routed)
        if (!assistant.toolCalls?.length) {
          // Some local models write the call as text; recover it rather than ending the run.
          const known = new Set(registry.all().map((t) => t.name))
          const rec = recoverToolCalls(assistant.content, known)
          if (rec.calls.length) {
            assistant.toolCalls = rec.calls.map((c) => ({ ...c, id: `${c.id}-${randomUUID().slice(0, 8)}` }))
            assistant.content = rec.rest
            assistant.meta = { ...assistant.meta, recoveredToolCalls: true }
            db.updateMessage(assistant)
            this.d.emit({ threadId: thread.id, type: 'message', message: assistant })
          }
        }
        if (!assistant.toolCalls?.length) {
          // Links the model cites must come from something it actually retrieved (or the user typed).
          const all = db.listMessages(thread.id)
          const seen = all.filter((m) => m.role === 'tool' || m.role === 'user').map((m) => m.content).join('\n')
          const unseen = citedUrls(assistant.content).filter((u) => !seen.includes(u) && !seen.includes(u.replace(/\/$/, '')))
          if (unseen.length && !linkChecked && step < HARD_CAP) {
            budget = Math.max(budget, step + 1)
            linkChecked = true
            db.insertMessage({ threadId: thread.id, role: 'user', kind: 'normal', status: 'done', meta: { hidden: true }, content: `[From the app] Your reply cites links that don't appear in any source you retrieved in this conversation:\n${unseen.map((u) => `- ${u}`).join('\n')}\nVerify them with fetch_page or web_search, or remove them. Then give your final answer again.` })
            assistant.meta = { ...assistant.meta, superseded: true }
            db.updateMessage(assistant)
            this.d.emit({ threadId: thread.id, type: 'message', message: assistant })
            continue
          }
          // Sources this run read (or found) ride along for the UI's source pills.
          const srcs = sourcesSince(all, runStart)
          if (srcs.length) {
            assistant.meta = { ...assistant.meta, sources: srcs }
            db.updateMessage(assistant)
            this.d.emit({ threadId: thread.id, type: 'message', message: assistant })
          }
          // Double-check real work: anything that changed something, and research beyond a quick lookup.
          // A quick answer or one search stays fast (the link check above still guards citations).
          if ((track.changed || (track.researched && (actions >= 3 || state.todos.length > 0))) && !verified && !run.helper && step < HARD_CAP && !process.env.FOREMAN_NO_VERIFY) {
            budget = Math.max(budget, step + 1)
            verified = true
            this.d.emit({ threadId: thread.id, type: 'drafting', tool: 'verify' })
            assistant.meta = { ...assistant.meta, superseded: true }
            db.updateMessage(assistant)
            this.d.emit({ threadId: thread.id, type: 'message', message: assistant })
            db.insertMessage({ threadId: thread.id, role: 'user', kind: 'normal', status: 'done', meta: { hidden: true }, content: `[From the app] Before you finish, double-check your work:\n${track.changed ? '- Confirm each change actually happened (re-read the file, snapshot the page, or list the result).\n' : ''}${track.researched ? '- Check every fact, number and date in your answer against the sources you read; drop anything you can\'t back up.\n' : ''}${actions >= 8 ? '- If this took a non-obvious procedure or several tries, save what worked with memory(action="save_skill") so next time is faster.\n' : ''}- Fix anything that's wrong.\nThen write your final answer from scratch in plain, simple words: what you did, what you found, and anything the user should know. The user never saw your draft (this reply replaces it), so don't mention a draft, an earlier answer, corrections, or this check; a short "I opened the file to confirm it saved" is fine.` })
            continue
          }
          // Don't stop with an unfinished plan: one nudge per run.
          if (open.length && !nudged && step < HARD_CAP) {
            budget = Math.max(budget, step + 1)
            nudged = true
            db.insertMessage({ threadId: thread.id, role: 'user', kind: 'normal', status: 'done', content: `[From the app] Your plan still has open items:\n${planText(state)}\nContinue working on them, or update the plan with todo (mark items done, or remove ones that no longer apply) and explain why.`, meta: { hidden: true } })
            continue
          }
          break
        }

        for (const call of assistant.toolCalls) {
          if (run.ctrl.signal.aborted) throw new DOMException('stopped', 'AbortError')
          await this.execute(thread, run, state, call, { failures, untrusted, userText, guard, track })
          db.setState(thread.id, state)
        }

        actions += assistant.toolCalls.length
        // The budget follows the agent's own plan, and grows while it keeps finishing items.
        const nowDone = state.todos.filter((t) => t.status === 'done').length
        if (state.todos.length) budget = Math.max(budget, Math.min(HARD_CAP, step + (state.todos.length - nowDone) * PER_PLAN_ITEM + 4))
        if (nowDone > doneItems) budget = Math.min(HARD_CAP, budget + (nowDone - doneItems) * 4)
        doneItems = nowDone

        if (step === budget) {
          // Out of room: one text-only turn to report what's done and what's left (adapted from opencode max-steps, MIT).
          const wrap = await cm.prepare({ system, toolsJson: '[]', messages: view(db.listMessages(thread.id)), state, window })
          wrap.wire.push({ role: 'user', content: '[From the app] This run has used its step budget. Do not call tools. Reply with a short summary: what you finished, what is left, and what the user should say to continue.' })
          await this.stream(thread.id, model, wrap.wire, [], window, run, speaker, routed)
        }
      }
    } catch (e) {
      if (run.ctrl.signal.aborted || (e as Error).name === 'AbortError') status = 'stopped'
      else {
        status = 'error'
        if (!(e as { shown?: boolean }).shown) this.notice(thread.id, `Something went wrong: ${(e as Error).message}`)
      }
    }
    db.setState(thread.id, state)
    return status
  }

  /** One model call, streamed into a new assistant message. */
  private async stream(threadId: string, model: string, wire: WireMessage[], tools: ReturnType<ToolRegistry['wire']>, window: number, run: Run, speaker?: Space, routed?: Routed): Promise<Message> {
    const s = this.d.settings.get()
    const ep = this.d.endpoints.for(model)
    const meta = { ...(speaker ? botMeta(speaker) : {}), ...(routed && !routed.manual ? { routed } : {}) }
    const m = this.d.db.insertMessage({ threadId, role: 'assistant', content: '', kind: 'normal', status: 'streaming', model, meta: Object.keys(meta).length ? meta : undefined })
    this.d.emit({ threadId, type: 'message', message: m })
    let flushAt = Date.now()
    // A reply may open with <react>emoji</react> to react to the user's message; strip it from the text.
    let head = ''
    let headDone = false
    const reactTo = [...this.d.db.listMessages(threadId)].reverse().find((x) => x.role === 'user')
    const takeHead = (text: string): string | null => {
      if (headDone) return text
      head += text
      const t = head.trimStart()
      const done = t.match(/^<react>\s*([^<\s]{1,12})\s*<\/react>\s*/)
      if (done) {
        headDone = true
        if (reactTo) this.d.emit({ threadId, type: 'message', message: this.d.db.react(reactTo.id, 'bot', done[1]) })
        return t.slice(done[0].length) || null
      }
      if (('<react>'.startsWith(t) || t.startsWith('<react>')) && t.length < 40) return null
      headDone = true
      return head
    }
    try {
      for await (const part of streamChat({
        baseUrl: ep.baseUrl,
        apiKey: ep.apiKey,
        model,
        messages: wire,
        tools,
        sampling: samplingFor(model, s.sampling),
        maxTokens: OUTPUT_RESERVE,
        contextWindow: window,
        signal: run.ctrl.signal,
        // Voice answers right away; otherwise thinking adapts to the problem around the chosen level.
        effort: this.d.db.getState(threadId).voice ? 'low' : adaptiveEffort(s.thinking, routed?.tier)
      })) {
        if (part.type === 'content') {
          const text = takeHead(part.text)
          if (text === null) continue
          m.content += text
          this.d.emit({ threadId, type: 'delta', messageId: m.id, content: text })
        } else if (part.type === 'reasoning') {
          m.reasoning = (m.reasoning ?? '') + part.text
          this.d.emit({ threadId, type: 'delta', messageId: m.id, reasoning: part.text })
        } else if (part.type === 'tool_calls') {
          // Some servers reuse ids like "call_0" every step; results are matched by id, so make them unique.
          // Claude's ids are already unique and must match its stored blocks exactly.
          m.toolCalls = part.calls.map((c) => (c.id.startsWith('toolu_') ? c : { ...c, id: `${c.id || 'call'}-${randomUUID().slice(0, 8)}` }))
        } else if (part.type === 'tool_pending') {
          this.d.emit({ threadId, type: 'drafting', tool: part.name })
        } else if (part.type === 'raw') {
          m.meta = { ...m.meta, raw: { provider: part.provider, model: part.model, content: part.content } }
        } else if (part.type === 'usage') {
          m.meta = { ...m.meta, promptTokens: part.promptTokens, completionTokens: part.completionTokens }
        } else if (part.type === 'finish' && part.reason === 'length') {
          m.meta = { ...m.meta, truncated: true }
        }
        if (Date.now() - flushAt > 500) {
          this.d.db.updateMessage(m)
          flushAt = Date.now()
        }
      }
      m.status = 'done'
    } catch (e) {
      m.status = run.ctrl.signal.aborted ? 'stopped' : 'error'
      if (m.status === 'error') {
        m.meta = { ...m.meta, error: (e as Error).message }
        // The bubble already shows it; the run's catch shouldn't post it a second time.
        ;(e as Error & { shown?: boolean }).shown = true
      }
      this.d.db.updateMessage(m)
      this.d.emit({ threadId, type: 'message', message: m })
      throw e
    }
    this.d.db.updateMessage(m)
    this.d.emit({ threadId, type: 'message', message: m })
    this.d.emit({ threadId, type: 'drafting', tool: null })
    return m
  }

  private async summarize(model: string, transcript: string, maxTokens: number, signal: AbortSignal): Promise<string> {
    const s = this.d.settings.get()
    let out = ''
    const ep = this.d.endpoints.for(model)
    for await (const part of streamChat({
      baseUrl: ep.baseUrl,
      apiKey: ep.apiKey,
      model,
      messages: [{ role: 'system', content: SUMMARY_INSTRUCTIONS }, { role: 'user', content: transcript }],
      sampling: { ...samplingFor(model, s.sampling), temperature: 0.3 },
      maxTokens,
      signal
    })) {
      if (part.type === 'content') out += part.text
    }
    return out
  }

  private toolMessage(threadId: string, call: ToolCall, content: string, meta: Record<string, unknown>, images?: string[]): void {
    const speaker = this.runs.get(threadId)?.speaker
    if (speaker && this.runs.get(threadId)?.group) meta = { ...meta, ...botMeta(speaker) }
    const m = this.d.db.insertMessage({
      threadId, role: 'tool', toolCallId: call.id, toolName: call.name, content, kind: 'normal', status: 'done', meta, images
    })
    this.d.emit({ threadId, type: 'message', message: m })
  }

  private async execute(
    thread: Thread,
    run: Run,
    state: ThreadState,
    call: ToolCall,
    ctx: { failures: Map<string, number>; untrusted: string[]; userText: string; guard: LoopGuard; track: { changed: boolean; researched: boolean } }
  ): Promise<void> {
    const { registry } = this.d
    const s = this.d.settings.get()
    const mode = this.d.db.getThread(thread.id)?.permissionMode ?? thread.permissionMode

    const fixed = fixName(call.name, new Set(registry.all().map((t) => t.name)))
    if (fixed && fixed !== call.name) call = { ...call, name: fixed }
    const repeat = ctx.guard.check(call)
    if (repeat) return this.toolMessage(thread.id, call, repeat, { status: 'error', label: call.name, display: 'repeated call skipped' })

    const tool = registry.get(call.name)
    if (!tool) {
      const names = registry.listFor(state).map((t) => t.name).join(', ')
      return this.toolMessage(thread.id, call, `Unknown tool "${call.name}". Available: ${names}. Use find_tools to load others.`, { status: 'invalid', label: call.name })
    }
    // A known tool the model called without loading it: load it so the next request lists it.
    if (!tool.core && !state.loaded.includes(tool.name)) registry.load(state, [tool.name])

    // 1. Schema check, with one repair retry per tool.
    const checked = check(tool, call.arguments)
    if (!checked.ok) {
      const n = (ctx.failures.get(tool.name) ?? 0) + 1
      ctx.failures.set(tool.name, n)
      return this.toolMessage(thread.id, call, repairPrompt(tool, checked.error, n < 2), { status: 'invalid', label: tool.label, display: 'invalid arguments' })
    }
    ctx.failures.delete(tool.name)
    const args = checked.args

    // 2. Permission.
    const effect: ToolEffect = typeof tool.effect === 'function' ? tool.effect(args) : tool.effect
    const hardStop = tool.hardStop?.(args) ?? null
    const tainted = (effect === 'write_external' || effect === 'destructive') && isTainted(args, ctx.untrusted, ctx.userText)
    const decision = decide({
      mode,
      effect,
      tool: tool.name,
      alwaysAllowed: state.alwaysAllow.includes(tool.name),
      hardStop,
      hardStopsEnabled: s.advanced.hardStopsEnabled,
      tainted,
      leaksSecret: containsSecret(args, this.d.secretValues()),
      consequential: tool.consequential ? tool.consequential(args) : true
    })
    const baseMeta = { label: tool.label, effect, args: call.arguments }
    if (decision.verdict === 'deny') {
      return this.toolMessage(thread.id, call, `Blocked: ${decision.reason}`, { ...baseMeta, status: 'denied', display: 'blocked' })
    }
    if (decision.verdict === 'ask' && run.unattended) {
      const why = run.helper
        ? 'Skipped: helper agents can\'t get the user\'s approval. Do not retry. In your report, say exactly what you would do so the lead agent can do it.'
        : 'Skipped: this ran on a schedule with nobody to approve it. Do not retry. In your summary, tell the user exactly what you would do so they can approve it later.'
      return this.toolMessage(thread.id, call, why, { ...baseMeta, status: 'denied', display: 'Skipped (needs approval)' })
    }
    if (decision.verdict === 'ask') {
      const answer = (await this.ask(thread.id, run, {
        kind: 'approval', tool: tool.name, label: tool.label, effect, args: pretty(call.arguments), reason: decision.reason,
        summary: tool.describe?.(args)
      })) as ApprovalAnswer
      if (answer === 'deny') {
        return this.toolMessage(thread.id, call, 'The user declined this action. Do not retry it. Ask what they would like instead, or continue without it.', { ...baseMeta, status: 'denied', display: 'Skipped' })
      }
      if (answer === 'always' && !state.alwaysAllow.includes(tool.name)) state.alwaysAllow.push(tool.name)
    }

    // 3. Run.
    const toolCtx: ToolContext = {
      threadId: thread.id,
      signal: run.ctrl.signal,
      workspaceDir: s.workspaceDir,
      docsDir: this.d.docsDir,
      state,
      askUser: (question, options) => this.ask(thread.id, run, { kind: 'question', question, options }),
      loadTools: (names) => registry.load(state, names),
      searchTools: (q) => registry.search(q, state),
      readResult: (id) => this.d.results.get(id),
      offerConnect: async (q) => {
        const preset = this.d.connectors?.suggest(q)[0]
        if (!preset || run.unattended) return []
        const answer = await this.ask(thread.id, run, { kind: 'connect', preset, question: `Connect ${preset.name}?` })
        return answer === 'connected' ? registry.search(preset.name, state).map((h) => h.name) : []
      },
      spawnAgents: (tasks) => this.runTeam(thread, run, call.id, tasks),
      model: this.lastModel.get(thread.id)
    }
    let out: ToolOutput
    try {
      out = await tool.run(args, toolCtx)
    } catch (e) {
      if (run.ctrl.signal.aborted) throw e
      const msg = (e as Error).message
      return this.toolMessage(thread.id, call, `Error: ${msg}${ctx.guard.error(tool.name, msg) ?? ''}`, { ...baseMeta, status: 'error', display: msg.slice(0, 80) })
    }

    // 4. Store: big outputs go to disk; everything is wrapped as data.
    const cm = this.lastModel.get(thread.id) ?? thread.model ?? s.defaultModel
    const cep = this.d.endpoints.for(cm)
    const counter = this.d.counter?.(cep.baseUrl, cm) ?? new ServerTokenCounter(cep.baseUrl, cm)
    const id = `r-${call.id.replace(/[^\w-]/g, '').slice(-12)}-${Date.now().toString(36)}`
    const off = await this.d.results.maybeOffload(out.text, id, counter)
    if (tool.untrusted) ctx.untrusted.push(out.text)
    ctx.guard.record(call, out.text)
    if (effect !== 'read') ctx.track.changed = true
    if (tool.name === 'web_search' || tool.name === 'fetch_page' || (tool.name === 'browser' && /get_text|snapshot|navigate/.test(call.arguments))) ctx.track.researched = true
    const team = this.lastTeam.get(call.id)
    if (team) this.lastTeam.delete(call.id)
    this.toolMessage(thread.id, call, wrapToolOutput(tool.name, off.text, !!tool.untrusted), {
      ...baseMeta, ...(team ? { team } : {}), status: 'ok', display: out.display, path: out.path, sources: out.sources, read: out.read, untrusted: !!tool.untrusted, offloaded: off.offloaded ? id : undefined, tokens: off.tokens
    }, out.images)
  }
}

export function citedUrls(text: string): string[] {
  return [...new Set([...text.matchAll(/https?:\/\/[^\s)\]>"'`]+/g)].map((m) => m[0].replace(/[.,;:!?]+$/, '')))]
}

/** Pages read in this run first, then search results, deduplicated. */
function sourcesSince(ms: Message[], since: number): Array<{ title: string; url: string }> {
  const tools = ms.filter((m) => m.role === 'tool' && m.createdAt >= since && Array.isArray(m.meta?.sources))
  const read = tools.filter((m) => m.meta?.read).flatMap((m) => m.meta!.sources as Array<{ title: string; url: string }>)
  const found = tools.filter((m) => !m.meta?.read).flatMap((m) => m.meta!.sources as Array<{ title: string; url: string }>)
  const out = new Map<string, { title: string; url: string }>()
  for (const s of [...read, ...found]) if (!out.has(s.url)) out.set(s.url, s)
  return [...out.values()].slice(0, read.length ? Math.max(read.length, 3) : 5)
}

function planText(state: ThreadState): string {
  const mark = { pending: '[ ]', in_progress: '[>]', done: '[x]' } as const
  return state.todos.map((t) => `${mark[t.status]} ${t.text}`).join('\n')
}

function botMeta(b: Space): Record<string, unknown> {
  return { botId: b.id, botName: b.name, botColor: b.color }
}

export type { ToolDef }
