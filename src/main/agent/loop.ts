import { randomUUID } from 'node:crypto'
import { usageScope } from '../usage'
import type { ApprovalAnswer, Attachment, ChatEvent, Effort, TeamMember, Message, ModelInfo, PendingRequest, PermissionMode, SendInput, Space, Thread, Tier, ToolCall, ToolEffect } from '@shared/types'
import type { Db } from '../db'
import type { MemoryStore } from '../memory'
import type { SettingsStore } from '../settings'
import type { SpaceFiles } from '../spaces'
import { samplingFor } from '../llm/catalog'
import { collectText, isLocal, streamChat, type WireMessage } from '../llm/client'
import type { Endpoints } from '../llm/endpoints'
import { teamCapacity } from '../llm/models'
import { def as providerDef } from '../llm/providers'
import { decide as route, pick } from '../llm/router'
import { ContextManager, OUTPUT_RESERVE, ResultStore, ServerTokenCounter, SUMMARY_INSTRUCTIONS, wrapToolOutput, type TokenCounter } from './context'
import { checkTaint, containsSecret, decide, memoryProvenance, memoryRisk, ruleVerdict, stricterMode } from './permissions'
import { VOICE_SUFFIX, groupNote, harnessPrompt } from './prompt'
import type { ToolRegistry } from './registry'
import type { Decision, PermissionInput, ThreadState, ToolContext, ToolDef, ToolOutput } from './types'
import type { HandoffHost } from './tools/handoff'
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
  connectors?: { suggest(q: string): import('@shared/types').ConnectorPreset[]; connectPreset(id: string): Promise<{ state: string; toolNames?: string[] }>; disabledToolNames?(): Set<string> }
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
  /** Messages sent while this run works (steering, or another bot's handoff), added at the start of the next step. */
  steers?: Array<{ text: string; meta?: Record<string, unknown> }>
  /** Resolves when the run (and its group speakers) has ended. */
  done?: Promise<'finished' | 'stopped' | 'error'>
  /**
   * A cap on the permission mode for this run only: a handoff from a bot in a stricter mode, or a helper
   * of a capped run. The stricter of this and the chat's own mode applies; the chat's mode is unchanged.
   */
  modeCap?: PermissionMode
  /** Every outside action asks as tainted for this run (started by a handoff from a run that read untrusted content). */
  forceTaint?: boolean
  /** Taint context a helper agent starts from: its lead's untrusted text and the user's own words. */
  seed?: { untrusted: string[]; userText: string }
  /** Live taint state while the run works, for handoffs it sends and helpers it starts. */
  taint?: { untrusted: string[]; userText: () => string; tainted: () => boolean }
}

/** Messages that look like the user's but aren't their words: another bot's handoff, or a Teach recording (page strings). */
export const isRelayed = (m: Pick<Message, 'meta'>): boolean => !!(m.meta?.handoff || m.meta?.teach || m.meta?.helperTask)

/**
 * The user's own words in a chat, for the taint check. Handoffs, Teach recordings (except the name and
 * goal lines the user typed in the Teach bar), helper tasks and the app's hidden notes are left out.
 */
export function userTextOf(messages: Message[]): string {
  return messages.filter((m) => m.role === 'user' && !m.meta?.hidden).map((m) => {
    if (m.meta?.teach) return m.content.split('\n').slice(0, 2).filter((l) => /^(Teach|Goal): /.test(l)).join('\n')
    return isRelayed(m) ? '' : m.content
  }).filter(Boolean).join('\n')
}

/** The untrusted text a relayed message carries (a Teach recording's note has the page's selectors and URLs). */
export function relayedText(m: Pick<Message, 'content' | 'meta'>): string {
  return [m.content, m.meta?.teach && typeof m.meta?.note === 'string' ? m.meta.note : ''].filter(Boolean).join('\n')
}

const HELPER_NOTE = (depth: number): string => `

# You are a helper agent
You are one of several helper agents working in parallel for a lead agent on a bigger job. The message below is your part.
- You can't see the lead's conversation, and nobody can approve actions for you: anything that needs the user's OK is skipped, so leave it for the lead and say what you would do.
- Work fully and on your own: look things up, read pages and files, run commands, make files when your part needs it. Don't stop early, and check what you report.
- Finish with a report for the lead, key findings first: what you found (with source URLs and exact names, numbers and dates), files you made (full paths), and anything you couldn't do or confirm. Complete but compact.${depth < 2 ? '\n- If your part is itself big, you may split it with the agents tool.' : '\n- Do the work yourself; you can\'t start more helpers.'}`


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
    // Another bot's tool output, drafts it replaced and the app's notes to it stay private to that bot.
    if (m.role === 'tool' || m.meta?.hidden || m.meta?.superseded) return []
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

  /** Every chat waiting on the user right now, with its open request ids (for a reopened window). */
  allPending(): Record<string, string[]> {
    const out: Record<string, string[]> = {}
    for (const [id, run] of this.runs) if (run.pending.size && !run.helper) out[id] = [...run.pending.keys()]
    return out
  }

  respond(threadId: string, requestId: string, answer: string): void {
    const run = this.runs.get(threadId)
    const p = run?.pending.get(requestId)
    if (!p) return
    run!.pending.delete(requestId)
    this.d.emit({ threadId, type: 'resolved', id: requestId })
    p.resolve(answer)
  }

  /**
   * Steer a running agent: the message joins the conversation at the start of its next step (after
   * the current tool results, so the history stays valid) and the agent adjusts without starting over.
   * Nothing running: it's sent as a normal message.
   */
  async steer(threadId: string, text: string, meta?: Record<string, unknown>): Promise<'steered' | 'sent'> {
    const run = this.runs.get(threadId)
    if (!run) {
      await this.send({ threadId, text, ...(meta ? { meta } : {}) })
      return 'sent'
    }
    run.steers = [...(run.steers ?? []), { text, meta }]
    this.d.emit({ threadId, type: 'steer', pending: run.steers.length })
    return 'steered'
  }

  /** Adds waiting steering messages to the conversation; returns the messages added. */
  private flushSteers(threadId: string, run: Run): Message[] {
    const texts = run.steers?.splice(0) ?? []
    const out: Message[] = []
    for (const { text, meta } of texts) {
      const m = this.d.db.insertMessage({
        threadId, role: 'user', content: text, kind: 'normal', status: 'done',
        meta: { steer: true, note: '[The user sent this while you were working. Take it into account from your next step on: change the plan if needed, don\'t redo work that is already done, and keep going.]', ...(meta ?? {}) }
      })
      this.d.emit({ threadId, type: 'message', message: m })
      out.push(m)
    }
    if (texts.length) this.d.emit({ threadId, type: 'steer', pending: 0 })
    return out
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
    if (input.planFirst) notes.push('[Plan first is on: before changing anything, look into it with read-only tools, then ask the clarifying questions you truly need in ONE ask_user call with questions (skip this if nothing is unclear), then call propose_plan and wait. Execute only after the user approves, and follow the approved plan.]')
    if (input.deepResearch) {
      input = { ...input, team: true }
      notes.push('[Deep Research is on: research this thoroughly with your team, then deliver a report. Write it with create_document as a PDF in the workspace folder "Research" (e.g. "Research/<short title>.pdf"): a title, a 5-8 sentence executive summary up top, sections with clear headings, tables for comparisons and numbers, what is uncertain or disputed, and a numbered Sources list (title and URL) that every [n] in the text points to. Re-open the PDF to check it, then reply with a short summary of the findings and the file path.]')
    }
    if (input.team) {
      const { min, max } = this.teamSize(thread)
      notes.push(`[Team of Experts is on for this request: 1) Write your plan with todo. 2) Split the research into at least ${min} focused, non-overlapping parts (up to ${max}; different sources, angles, sub-questions, options or sections) and send them all at once with the agents tool; give each helper a complete, self-contained task and say exactly what to report (findings with source URLs, numbers with dates). 3) Compile their reports: compare them, resolve disagreements, check anything important yourself, fill gaps. 4) Then finish the job yourself and double-check it before you answer: one complete, well-organized result, with sources.]`)
    }

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
        ...(input.team ? { team: true } : {}),
        ...(input.deepResearch ? { deepResearch: true } : {}),
        ...(input.planFirst ? { planFirst: true } : {})
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
      // collectText starts over when a retried request resets the stream (no doubled text).
      title = await collectText(streamChat({
        baseUrl: ep.baseUrl, apiKey: ep.apiKey, model: titleModel, maxTokens: 24, signal: AbortSignal.timeout(20_000),
        sampling: { ...samplingFor(titleModel, s.sampling), temperature: 0.2 },
        messages: [
          { role: 'system', content: 'Write a short title (2-6 words) for this chat. Reply with the title only: no quotes, no punctuation at the end. /no_think' },
          { role: 'user', content: `User: ${firstUser.content.slice(0, 600)}\nAssistant: ${reply.slice(0, 600)}` }
        ]
      }))
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
    this.rewound(threadId)
    this.d.emit({ threadId, type: 'thread', thread })
    this.start(thread, lastUser.content)
  }

  /** After retry/edit: the discarded attempt's plan goes, and a summary whose boundary was deleted goes too. */
  private rewound(threadId: string): void {
    const st = this.d.db.getState(threadId)
    st.todos = []
    const ids = new Set(this.d.db.listMessages(threadId).map((m) => m.id))
    if (st.compaction && !ids.has(st.compaction.boundaryId)) st.compaction = undefined
    this.d.db.setState(threadId, st)
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
    this.rewound(threadId)
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
    this.d.emit({ threadId: thread.id, type: 'run', status: 'started', spaceId: thread.spaceId, title: thread.title })
    // Paid requests anywhere in this run (steps, summaries, helpers) are recorded against this bot.
    const done = usageScope.run({ spaceId: thread.spaceId, threadId: thread.id }, () => this.speakers(thread, run, space, userText))
      .catch((e) => { this.notice(thread.id, `Run failed: ${(e as Error).message}`); return 'error' as const })
      .finally(() => {
        if (this.runs.get(thread.id) === run) this.runs.delete(thread.id)
        // Steered at the very end: it goes out as the next message. After a Stop it's kept in the chat
        // (the model sees it next time) but doesn't start new work on its own.
        const left = run.steers?.splice(0) ?? []
        if (!left.length) return
        this.d.emit({ threadId: thread.id, type: 'steer', pending: 0 })
        // The user's own steers go out together; each handoff stays its own message with its own meta,
        // so the user's words are never labeled as another bot's (or the other way around).
        const groups = groupSteers(left)
        if (!run.ctrl.signal.aborted) {
          void (async () => {
            // The first starts a run; the rest steer into it.
            for (const g of groups) await this.steer(thread.id, g.text, g.meta)
          })().catch((e) => this.notice(thread.id, `Couldn't send your message: ${(e as Error).message}`))
        } else {
          for (const g of groups) {
            const m = this.d.db.insertMessage({ threadId: thread.id, role: 'user', content: g.text, kind: 'normal', status: 'done', meta: { ...(g.meta ?? {}), steer: true } })
            this.d.emit({ threadId: thread.id, type: 'message', message: m })
          }
        }
      })
    run.done = done
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
    this.d.emit({ threadId: thread.id, type: 'run', status, error, spaceId: thread.spaceId, title: this.d.db.getThread(thread.id)?.title ?? thread.title })
    return status
  }

  // -------------------------------------------------------------------------

  private systemFor(thread: Thread, state: ThreadState, speaker?: Space, group?: Space): string {
    // Memories ranked for this request: shared ones plus the speaking bot's own (each group member gets its own).
    const query = [...this.d.db.listMessages(thread.id)].reverse().find((m) => m.role === 'user' && !m.meta?.hidden)?.content ?? ''
    const build = (bot: Space | undefined): string => {
      const s = this.d.settings.get()
      return harnessPrompt({
        date: new Date(),
        userName: s.userName,
        workspaceDir: s.workspaceDir,
        memories: this.d.memory.block({ spaceId: bot?.kind === 'bot' ? bot.id : null, spaceName: bot?.name, query }),
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

  /** Team of Experts size for this Mac and model: at least 10 helpers when it can run them. */
  private teamSize(thread: Thread): { min: number; max: number } {
    const s = this.d.settings.get()
    const want = thread.model || this.d.db.getSpace(thread.spaceId)?.model || s.defaultModel
    const id = want === 'auto' ? [...this.d.endpoints.usable()].sort((a, b) => b.tier - a.tier || (b.rank ?? 0) - (a.rank ?? 0))[0]?.id : want
    const cap = teamCapacity(this.d.endpoints.last?.models.find((m) => m.id === id))
    return { min: Math.min(10, cap.maxAgents), max: cap.maxAgents }
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
    // Team of Experts: the first team must be wide enough to research properly.
    const teamMode = depth === 1 && !![...db.listMessages(parent.id)].reverse().find((m) => m.role === 'user' && !m.meta?.hidden)?.meta?.team
    const min = Math.min(10, cap.maxAgents)
    if (teamMode && used === 0 && tasks.length < min) {
      throw new Error(`Team of Experts is on: send at least ${min} helpers (you sent ${tasks.length}). Split the research into ${min} or more focused parts (different sources, angles, sub-questions or options) and call agents again with all of them.`)
    }
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
        // A helper never runs looser than its lead does right now (a capped handoff run stays capped).
        const child = db.createThread(parent.spaceId, stricterMode(db.getThread(parent.id)?.permissionMode ?? parent.permissionMode, run.modeCap), model, parent.id)
        children[i] = child.id
        db.updateThread(child.id, { title: tasks[i].title })
        const st = db.getState(child.id)
        st.roots = pstate.roots
        st.depth = depth
        st.rootId = rootId
        st.rootCallId = rootCallId
        st.systemSnapshot = this.systemFor(child, { ...st }) + HELPER_NOTE(depth)
        db.setState(child.id, st)
        // The task is the lead model's words, not the user's: the helper checks taint against the user's own
        // words and everything untrusted the lead had read.
        db.insertMessage({ threadId: child.id, role: 'user', content: tasks[i].task, kind: 'normal', status: 'done', meta: { helperTask: true } })
        const crun: Run = {
          ctrl: new AbortController(), pending: new Map(), group: false, unattended: true, helper: true,
          modeCap: run.modeCap, forceTaint: run.forceTaint,
          seed: { untrusted: [...(run.taint?.untrusted ?? []).slice(-20), tasks[i].task], userText: run.taint?.userText() ?? run.seed?.userText ?? '' }
        }
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
    const chosen = await this.chooseModel(speaker?.model || db.getThread(thread.id)?.model || space?.model || s.defaultModel, thread, state)
    let model = chosen.model
    let routed = chosen.routed
    let ep = this.d.endpoints.for(model)
    let claude = ep.provider === 'anthropic'
    // Voice keeps a 16k window so replies start fast; Claude gets a larger window (1M available, cached).
    // Auto (0): the largest window that fits this Mac with this model; Claude gets plenty (cached).
    const windowFor = (m: string, isClaude: boolean): number => Math.min(isClaude ? Math.max(s.contextWindow, 131072) : this.d.fitWindow(m, s.contextWindow || 131072), state.voice ? 16384 : Infinity)
    let window = windowFor(model, claude)
    const system = this.systemFor(thread, state, speaker, group)
    db.setState(thread.id, state)
    const view = (ms: Message[]): Message[] => (speaker ? perspective(ms, speaker.id) : ms)
    // In a group, the app's nudges belong to the bot they were for.
    const mine = speaker && run.group ? botMeta(speaker) : {}

    const makeCm = (): ContextManager => {
      const counter = this.d.counter?.(ep.baseUrl, model) ?? new ServerTokenCounter(ep.baseUrl, model)
      return new ContextManager(counter, (text, maxTokens) => this.summarize(model, text, maxTokens, run.ctrl.signal), results)
    }
    let cm = makeCm()

    // Model fallback: the run's model failed (after retries) or keeps making invalid tool calls, so the
    // rest of the run moves to the next stronger usable model. The history is re-read as is.
    const tried = new Set<string>([model])
    let switches = 0
    const switchModel = (reason: string, sideways: boolean, err?: Error): boolean => {
      if (switches >= 2) return false
      const now = settings.get()
      const lastUser = [...db.listMessages(thread.id)].reverse().find((m) => m.role === 'user' && !m.meta?.hidden)
      const next = nextStronger(this.d.endpoints.usable(), model, {
        cloud: now.cloud.enabled,
        // Out of cloud budget: only a local model can carry on.
        localOnly: !!err && /cloud budget/i.test(err.message),
        exclude: tried,
        sideways,
        needsVision: !!lastUser?.images?.length
      })
      if (!next) return false
      tried.add(next.id)
      switches++
      model = next.id
      ep = this.d.endpoints.for(model)
      claude = ep.provider === 'anthropic'
      window = windowFor(model, claude)
      cm = makeCm()
      this.lastModel.set(thread.id, model)
      if (routed) routed = { ...routed, label: next.label ?? next.id }
      this.notice(thread.id, `Switched to ${next.label ?? next.id} for the rest of this task: ${reason}`)
      return true
    }
    const modelName = (): string => this.d.endpoints.last?.models.find((m) => m.id === model)?.label ?? model
    let invalidStreak = 0
    let sincePlan = 0
    let planReminded = false

    // Untrusted text seen in this thread, for the taint check on outside actions: outside tool output
    // (pages, email, other bots' replies), other bots' handoffs and Teach recordings. The user's own words
    // are only what they typed (see userTextOf).
    const history = db.listMessages(thread.id)
    const untrusted: string[] = [
      ...(run.seed?.untrusted ?? []),
      ...history.filter((m) => m.role === 'tool' && m.meta?.untrusted).slice(-20).map((m) => m.content),
      ...history.filter((m) => m.role === 'user' && isRelayed(m) && !m.meta?.helperTask).slice(-10).map(relayedText)
    ]
    let userText = [run.seed?.userText ?? '', userTextOf(history)].filter(Boolean).join('\n')
    // Set by execute(): did this run change anything or research anything? Then it gets a self-check pass.
    // sawUntrusted: this run has untrusted content in view (memory saves that read like instructions ask);
    // web: it read outside content itself, so handoffs it sends count as tainted.
    const track = {
      changed: false, researched: false,
      web: history.some((m) => m.role === 'tool' && m.meta?.untrusted) || (run.seed?.untrusted.length ?? 0) > 1 || !!run.forceTaint,
      sawUntrusted: false
    }
    // "This turn": a helper inherits its lead's; otherwise only what this run reads (or was handed) counts.
    track.sawUntrusted = (run.seed?.untrusted.length ?? 0) > 1 || !!run.forceTaint
    // A handoff caps this run's mode at the stricter of both bots' modes and, when the sender had read
    // untrusted content, makes every outside action ask. A Teach recording carries page strings.
    const relayed = (m: Message): void => {
      track.sawUntrusted = true
      if (m.meta?.teach) track.web = true
      if (!m.meta?.handoff) return
      const mode = m.meta.mode
      if (mode === 'ask' || mode === 'auto' || mode === 'bypass') run.modeCap = run.modeCap ? stricterMode(run.modeCap, mode) : mode
      if (m.meta.tainted) { run.forceTaint = true; track.web = true }
    }
    const opener = [...history].reverse().find((m) => m.role === 'user' && !m.meta?.hidden)
    if (opener && isRelayed(opener) && !opener.meta?.helperTask) relayed(opener)
    run.taint = { untrusted, userText: () => userText, tainted: () => !!run.forceTaint || track.web }
    const failures = new Map<string, number>()
    const guard = new LoopGuard()
    let nudged = false
    let teamNudged = false
    let autonomyNudged = false
    let linkChecked = false
    let verified = false
    const runStart = Date.now()
    let status: 'finished' | 'stopped' | 'error' = 'finished'
    let budget = START_BUDGET
    let actions = 0
    state.consults = 0
    // Each new request gets a fresh team budget (helpers of helpers share their root's).
    if (!run.helper) this.teamUsed.delete(thread.id)
    let doneItems = state.todos.filter((t) => t.status === 'done').length
    const planPos = (): { at: number; of: number } | undefined => {
      if (!state.todos.length) return undefined
      const i = state.todos.findIndex((t) => t.status !== 'done')
      return { at: i < 0 ? state.todos.length : i + 1, of: state.todos.length }
    }

    try {
      for (let step = 1; step <= budget; step++) {
        if (run.ctrl.signal.aborted) throw new DOMException('stopped', 'AbortError')
        // The user steered while the last step ran: their message goes in now.
        const flushed = this.flushSteers(thread.id, run)
        if (flushed.length) budget = Math.max(budget, Math.min(HARD_CAP, step + START_BUDGET))
        // A user's steer is their own words; a handoff that steered in is another bot's (untrusted).
        for (const m of flushed) {
          if (isRelayed(m)) { untrusted.push(relayedText(m)); relayed(m) }
          else userText += `\n${m.content}`
        }
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
        // Working notes ride along with the plan, and always come back right after a summary.
        const notes = state.notes ? `\nYour working notes:\n${state.notes}` : ''
        if (open.length && (prepared.compacted || (step > 1 && step % 5 === 0) || late)) prepared.wire.push({ role: 'user', content: `[Plan reminder from the app]${late}\n${planText(state)}${notes}` })
        else if (prepared.compacted && notes) prepared.wire.push({ role: 'user', content: `[From the app] Older messages were summarized.${notes}` })
        else if (late) prepared.wire.push({ role: 'user', content: `[From the app]${late}` })

        let assistant: Message
        try {
          assistant = await this.stream(thread.id, model, prepared.wire, wireTools, window, run, speaker, routed)
        } catch (e) {
          if (run.ctrl.signal.aborted || (e as Error).name === 'AbortError') throw e
          // The failed reply stays visible as an error bubble (it's left out of the history); redo this step.
          if (switchModel(`${modelName()} failed (${(e as Error).message.replace(/\s+/g, ' ').slice(0, 140)})`, true, e as Error)) { step--; continue }
          throw e
        }
        // Cut off by the output limit in the middle of a tool call: the call was dropped (see stream()),
        // never run with guessed arguments. Ask for a shorter one.
        if (assistant.meta?.droppedToolCall && step < HARD_CAP) {
          budget = Math.max(budget, step + 1)
          db.insertMessage({ threadId: thread.id, role: 'user', kind: 'normal', status: 'done', meta: { hidden: true, ...mine }, content: '[From the app] Your last reply hit the output limit in the middle of a tool call, so the call was cut off and not run. Send a shorter call: for example split long content into several file_write calls with mode "append", or do fewer edits per call.' })
          continue
        }
        if (!assistant.toolCalls?.length && !assistant.meta?.truncated) {
          // Some local models write the call as text; recover it rather than ending the run.
          const known = new Set(registry.all().map((t) => t.name))
          const rec = recoverToolCalls(assistant.content, known, this.d.connectors?.disabledToolNames?.())
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
          // (A Teach recording's addresses are in its note: pages the user opened in this conversation.)
          const seen = all.filter((m) => m.role === 'tool' || m.role === 'user').map((m) => (m.role === 'user' ? relayedText(m) : m.content)).join('\n')
          const unseen = citedUrls(assistant.content).filter((u) => !seen.includes(u) && !seen.includes(u.replace(/\/$/, '')))
          if (unseen.length && !linkChecked && step < HARD_CAP) {
            budget = Math.max(budget, step + 1)
            linkChecked = true
            db.insertMessage({ threadId: thread.id, role: 'user', kind: 'normal', status: 'done', meta: { hidden: true, ...mine }, content: `[From the app] Your reply cites links that don't appear in any source you retrieved in this conversation:\n${unseen.map((u) => `- ${u}`).join('\n')}\nVerify them with fetch_page or web_search, or remove them. Then give your final answer again.` })
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
            db.insertMessage({ threadId: thread.id, role: 'user', kind: 'normal', status: 'done', meta: { hidden: true, ...mine }, content: `[From the app] Before you finish, double-check your work:\n${track.changed ? '- Confirm each change actually happened (re-read the file, snapshot the page, or list the result).\n' : ''}${track.researched ? '- Check every fact, number and date in your answer against the sources you read; drop anything you can\'t back up.\n' : ''}${actions >= 8 ? '- If this took a non-obvious procedure or several tries, save what worked with memory(action="save_skill") so next time is faster.\n' : ''}- Fix anything that's wrong.\nThen write your final answer from scratch in plain, simple words: what you did, what you found, and anything the user should know. The user never saw your draft (this reply replaces it), so don't mention a draft, an earlier answer, corrections, or this check; a short "I opened the file to confirm it saved" is fine.` })
            continue
          }
          // Autonomy: a task stopped to ask "want me to…?" about its own next step. Do it (risky actions still ask).
          const asksToContinue = /\b(want me to|would you like me to|shall i|should i (go ahead|proceed|continue|start|do)|do you want me to|let me know if you(?:'d| would) like me to)\b[^?]{0,200}\?\s*$/i.test(assistant.content.trim())
          if (asksToContinue && (actions > 0 || open.length > 0) && !autonomyNudged && !run.unattended && step < HARD_CAP) {
            autonomyNudged = true
            budget = Math.max(budget, step + 6)
            db.insertMessage({ threadId: thread.id, role: 'user', kind: 'normal', status: 'done', meta: { hidden: true, ...mine }, content: '[From the app] Don\'t stop to ask permission for the next step of this task: do it now. The app asks the user itself before anything risky (sending, buying, deleting). Only stop to ask if it truly needs a decision that is the user\'s to make.' })
            continue
          }
          // A steering message arrived while this answer was written: keep going with it.
          if (run.steers?.length && step < HARD_CAP) { budget = Math.max(budget, step + 2); continue }
          // Team of Experts on, but no team yet: send one.
          const lastUser = [...db.listMessages(thread.id)].reverse().find((m) => m.role === 'user' && !m.meta?.hidden)
          if (lastUser?.meta?.team && !run.helper && !(this.teamUsed.get(state.rootId ?? thread.id) ?? 0) && !teamNudged && step < HARD_CAP) {
            teamNudged = true
            budget = Math.max(budget, step + 2)
            db.insertMessage({ threadId: thread.id, role: 'user', kind: 'normal', status: 'done', meta: { hidden: true, ...mine }, content: `[From the app] Team of Experts is on for this request, but you haven't used your team. Split the research into at least ${this.teamSize(thread).min} focused parts and send them with the agents tool, then compile their reports into the final answer.` })
            assistant.meta = { ...assistant.meta, superseded: true }
            db.updateMessage(assistant)
            this.d.emit({ threadId: thread.id, type: 'message', message: assistant })
            continue
          }
          // Don't stop with an unfinished plan: one nudge per run.
          if (open.length && !nudged && step < HARD_CAP) {
            budget = Math.max(budget, step + 1)
            nudged = true
            db.insertMessage({ threadId: thread.id, role: 'user', kind: 'normal', status: 'done', content: `[From the app] Your plan still has open items:\n${planText(state)}\nContinue working on them, or update the plan with todo (mark items done, or remove ones that no longer apply) and explain why.`, meta: { hidden: true, ...mine } })
            continue
          }
          break
        }

        const ran = await this.executeAll(thread, run, state, assistant.toolCalls, { failures, untrusted, userText, guard, track, window })

        actions += assistant.toolCalls.length
        // A local model that keeps calling tools that don't exist or with broken arguments: a stronger model takes over.
        for (const r of ran) {
          if (r.status === 'invalid') invalidStreak++
          else if (r.status !== 'repeat') invalidStreak = 0
        }
        if (invalidStreak >= 3 && isLocal(ep.baseUrl) && switchModel(`${modelName()} kept making invalid tool calls`, false)) invalidStreak = 0
        // Long runs keep their plan current: one reminder after 12 calls without a todo update.
        if (ran.some((r) => (r.name === 'todo' || r.name === 'propose_plan') && r.status === 'ok')) sincePlan = 0
        else sincePlan += ran.length
        if (sincePlan >= 12 && !planReminded && step < budget) {
          planReminded = true
          db.insertMessage({
            threadId: thread.id, role: 'user', kind: 'normal', status: 'done', meta: { hidden: true, ...mine },
            content: state.todos.length
              ? `[From the app] You've made ${sincePlan} tool calls since you last updated your plan. Update it with todo now: mark finished items done, set the current one in_progress, add or drop items based on what you learned, and put key facts in notes. Then continue.\n${planText(state)}`
              : `[From the app] You've made ${sincePlan} tool calls without a plan. Write one with todo now (the steps left, the current one in_progress, key facts in notes), then continue.`
          })
        }
        // The budget follows the agent's own plan, and grows while it keeps finishing items.
        const nowDone = state.todos.filter((t) => t.status === 'done').length
        if (state.todos.length) budget = Math.max(budget, Math.min(HARD_CAP, step + (state.todos.length - nowDone) * PER_PLAN_ITEM + 4))
        if (nowDone > doneItems) budget = Math.max(budget, Math.min(HARD_CAP, budget + (nowDone - doneItems) * 4))
        doneItems = nowDone

        if (step === budget) {
          // Out of room: one text-only turn to report what's done and what's left (adapted from opencode max-steps, MIT).
          // Claude needs the tool list whenever the history has tool calls (and keeps its cache with it).
          const wrapTools = claude ? wireTools : []
          const wrap = await cm.prepare({ system, toolsJson: JSON.stringify(wrapTools), messages: view(db.listMessages(thread.id)), state, window, appendOnly: claude, allowCompact: !claude })
          wrap.wire.push({ role: 'user', content: '[From the app] This run has used its step budget. Do not call tools. Reply with a short summary: what you finished, what is left, and what the user should say to continue.' })
          const last = await this.stream(thread.id, model, wrap.wire, wrapTools, window, run, speaker, routed)
          // A tool call here can't run; the reply text is the summary.
          if (last.toolCalls?.length) { last.toolCalls = undefined; last.meta = { ...last.meta, raw: undefined }; db.updateMessage(last) }
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
        // A model that can't call tools (Ollama says so) would reject the whole request: plain chat instead.
        tools: this.d.endpoints.last?.models.find((x) => x.id === model)?.tools === false ? [] : tools,
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
        } else if (part.type === 'reset') {
          // A retried or re-issued turn: everything from the failed attempt goes.
          m.content = ''
          m.reasoning = undefined
          m.toolCalls = undefined
          if (m.meta?.raw || m.meta?.truncated) m.meta = { ...m.meta, raw: undefined, truncated: undefined }
          head = ''
          headDone = false
          this.d.emit({ threadId, type: 'message', message: { ...m } })
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
      // Cut off by the output limit mid tool call: the arguments are incomplete, and a repair would turn
      // them into wrong-but-valid ones (an edit list short of items, a write without mode "append").
      // Drop the calls, as anthropic.ts does for max_tokens; the loop asks for a shorter call.
      if (m.meta?.truncated && m.toolCalls?.length) {
        m.toolCalls = undefined
        m.meta = { ...m.meta, droppedToolCall: true }
      }
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
    const ep = this.d.endpoints.for(model)
    // collectText starts over when a retried request resets the stream (no doubled summary).
    return collectText(streamChat({
      baseUrl: ep.baseUrl,
      apiKey: ep.apiKey,
      model,
      messages: [{ role: 'system', content: SUMMARY_INSTRUCTIONS }, { role: 'user', content: transcript }],
      sampling: { ...samplingFor(model, s.sampling), temperature: 0.3 },
      maxTokens,
      // Thinking models would spend the whole budget reasoning and return no summary.
      effort: 'low',
      signal
    }))
  }

  private toolMessage(threadId: string, call: ToolCall, content: string, meta: Record<string, unknown>, images?: string[]): void {
    const speaker = this.runs.get(threadId)?.speaker
    if (speaker && this.runs.get(threadId)?.group) meta = { ...meta, ...botMeta(speaker) }
    const m = this.d.db.insertMessage({
      threadId, role: 'tool', toolCallId: call.id, toolName: call.name, content, kind: 'normal', status: 'done', meta, images
    })
    this.d.emit({ threadId, type: 'message', message: m })
  }

  /** Runs one assistant turn's tool calls: consecutive safe reads together (up to 4 at once), everything else in order. */
  private async executeAll(thread: Thread, run: Run, state: ThreadState, calls: ToolCall[], ctx: ExecCtx): Promise<Array<{ name: string; status: CallStatus }>> {
    const out: Array<{ name: string; status: CallStatus }> = []
    let i = 0
    while (i < calls.length) {
      if (run.ctrl.signal.aborted) throw new DOMException('stopped', 'AbortError')
      // A batch: consecutive reads that run without asking. A repeat of a call in the batch ends it, so
      // the loop guard sees the first result before judging the repeat.
      const batch: ToolCall[] = []
      const keys = new Set<string>()
      while (i + batch.length < calls.length) {
        const c = calls[i + batch.length]
        const k = callKey(c)
        if (keys.has(k) || !this.parallelSafe(thread, run, state, c, ctx)) break
        keys.add(k)
        batch.push(c)
      }
      const group = batch.length > 1 ? batch : [calls[i]]
      const outcomes = group.length > 1
        ? await mapLimit(group, PARALLEL_TOOLS, (c) => this.perform(thread, run, state, c, ctx))
        : [await this.perform(thread, run, state, group[0], ctx)]
      // Stored in the order the model asked for them: providers match results to calls by position too.
      for (const o of outcomes) out.push({ name: o.call.name, status: this.commit(thread, o, ctx) })
      i += group.length
      this.d.db.setState(thread.id, state)
    }
    return out
  }

  /** The tool a call means, with a misspelled name fixed. */
  private resolve(call: ToolCall): ToolDef | undefined {
    const fixed = fixName(call.name, new Set(this.d.registry.all().map((t) => t.name)), this.d.connectors?.disabledToolNames?.())
    return fixed ? this.d.registry.get(fixed) : undefined
  }

  /** A read that runs without asking and doesn't touch shared state (browser, screen, the user). */
  private parallelSafe(thread: Thread, run: Run, state: ThreadState, call: ToolCall, ctx: ExecCtx): boolean {
    const tool = this.resolve(call)
    if (!tool || SERIAL_TOOLS.has(tool.name)) return false
    if (ctx.guard.check({ ...call, name: tool.name })) return false
    const checked = check(tool, call.arguments)
    if (!checked.ok) return false
    try {
      const { effect, decision } = this.permission(thread, run, state, tool, call, checked.args, ctx)
      return effect === 'read' && decision.verdict === 'allow'
    } catch {
      return false
    }
  }

  /** Effect and verdict for one call: the mode, hard stops, taint, secrets and the user's own rules. */
  private permission(thread: Thread, run: Run, state: ThreadState, tool: ToolDef, call: ToolCall, args: Record<string, unknown>, ctx: ExecCtx): { effect: ToolEffect; decision: Decision; summary?: string } {
    const s = this.d.settings.get()
    // A capped run (a handoff from a stricter bot) uses the stricter mode, for this run only.
    const mode = stricterMode(this.d.db.getThread(thread.id)?.permissionMode ?? thread.permissionMode, run.modeCap)
    const effect: ToolEffect = typeof tool.effect === 'function' ? tool.effect(args, { roots: state.roots ?? [] }) : tool.effect
    let summary: string | undefined
    try { summary = tool.describe?.(args) } catch { summary = undefined }
    const rule = ruleVerdict(s.customRules, { tool: tool.name, label: tool.label, summary, args: call.arguments })
    const decision = decideWithRule({
      mode,
      effect,
      tool: tool.name,
      alwaysAllowed: state.alwaysAllow.includes(tool.name),
      // Long-term memory: a save whose wording came from (or, after reading, reads like) fetched content asks.
      hardStop: tool.hardStop?.(args) ?? (tool.name === 'memory' ? memoryRisk(args, ctx.untrusted, ctx.userText, ctx.track.sawUntrusted) : null),
      hardStopsEnabled: s.advanced.hardStopsEnabled,
      // A handoff from a run that read untrusted content: every outside action in this run asks.
      tainted: (!!run.forceTaint && (effect === 'write_external' || effect === 'destructive')) || checkTaint(tool.name, effect, args, ctx.untrusted, ctx.userText),
      leaksSecret: containsSecret(args, this.d.secretValues()),
      consequential: tool.consequential ? tool.consequential(args, { threadId: thread.id, unattended: run.unattended }) : true
    }, rule)
    return { effect, decision, summary }
  }

  /** Stores a call's result. Loop-guard and taint bookkeeping happen here, in call order. */
  private commit(thread: Thread, o: Outcome, ctx: ExecCtx): CallStatus {
    let content = o.content
    if (o.errorFor) content += ctx.guard.error(o.errorFor.tool, o.errorFor.message) ?? ''
    if (o.output) {
      if (o.output.untrusted) {
        ctx.untrusted.push(o.output.text)
        ctx.track.sawUntrusted = true
        // A handoff's own receipt ("Handed off to …") isn't outside content; a reply or a page is.
        if (!(o.call.name === 'message_bot' && /^Handed off to /.test(o.output.text))) ctx.track.web = true
      }
      ctx.guard.record(o.call, o.output.text)
    }
    this.toolMessage(thread.id, o.call, content, o.meta, o.images)
    return o.status
  }

  /** Validates, checks permission (asking if needed) and runs one call. Nothing is stored yet. */
  private async perform(thread: Thread, run: Run, state: ThreadState, call: ToolCall, ctx: ExecCtx): Promise<Outcome> {
    const { registry } = this.d
    const s = this.d.settings.get()

    const fixed = fixName(call.name, new Set(registry.all().map((t) => t.name)), this.d.connectors?.disabledToolNames?.())
    if (fixed && fixed !== call.name) call = { ...call, name: fixed }
    const repeat = ctx.guard.check(call)
    if (repeat) return { call, status: 'repeat', content: repeat, meta: { status: 'error', label: call.name, display: 'repeated call skipped' } }

    const tool = registry.get(call.name)
    if (!tool) {
      const names = registry.listFor(state).map((t) => t.name).join(', ')
      return { call, status: 'invalid', content: `Unknown tool "${call.name}". Available: ${names}. Use find_tools to load others.`, meta: { status: 'invalid', label: call.name } }
    }
    // A known tool the model called without loading it: load it so the next request lists it.
    if (!tool.core && !state.loaded.includes(tool.name)) registry.load(state, [tool.name])

    // 1. Schema check, with one repair retry per tool.
    const checked = check(tool, call.arguments)
    if (!checked.ok) {
      const n = (ctx.failures.get(tool.name) ?? 0) + 1
      ctx.failures.set(tool.name, n)
      return { call, status: 'invalid', content: repairPrompt(tool, checked.error, n < 2), meta: { status: 'invalid', label: tool.label, display: 'invalid arguments' } }
    }
    ctx.failures.delete(tool.name)
    const args = checked.args

    // 2. Permission.
    const { effect, decision, summary } = this.permission(thread, run, state, tool, call, args, ctx)
    const baseMeta = { label: tool.label, effect, args: call.arguments }
    if (decision.verdict === 'deny') {
      return { call, status: 'denied', content: `Blocked: ${decision.reason}`, meta: { ...baseMeta, status: 'denied', display: 'blocked' } }
    }
    if (decision.verdict === 'ask' && run.unattended) {
      const why = run.helper
        ? 'Skipped: helper agents can\'t get the user\'s approval. Do not retry. In your report, say exactly what you would do so the lead agent can do it.'
        : 'Skipped: this ran on a schedule with nobody to approve it. Do not retry. In your summary, tell the user exactly what you would do so they can approve it later.'
      return { call, status: 'denied', content: why, meta: { ...baseMeta, status: 'denied', display: 'Skipped (needs approval)' } }
    }
    if (decision.verdict === 'ask') {
      const answer = (await this.ask(thread.id, run, {
        kind: 'approval', tool: tool.name, label: tool.label, effect, args: pretty(call.arguments), reason: decision.reason,
        summary
      })) as ApprovalAnswer
      if (answer === 'deny') {
        return { call, status: 'denied', content: 'The user declined this action. Do not retry it. Ask what they would like instead, or continue without it.', meta: { ...baseMeta, status: 'denied', display: 'Skipped' } }
      }
      if (answer === 'always' && !state.alwaysAllow.includes(tool.name)) state.alwaysAllow.push(tool.name)
    }

    // 3. Run.
    const provenance = tool.name === 'memory' ? memoryProvenance(args, ctx.untrusted, ctx.userText, ctx.track.sawUntrusted) : undefined
    const toolCtx: ToolContext = {
      threadId: thread.id,
      signal: run.ctrl.signal,
      workspaceDir: s.workspaceDir,
      docsDir: this.d.docsDir,
      state,
      askUser: run.unattended
        ? async () => '(Nobody can answer right now. Use your best judgment, state the assumption you made, and continue.)'
        : (question, options) => this.ask(thread.id, run, { kind: 'question', question, options }),
      // Nobody to answer on a schedule or in a helper: questions get "use your judgment", plans go ahead.
      askMany: run.unattended ? async () => '[]' : (questions) => this.ask(thread.id, run, { kind: 'questions', questions }),
      proposePlan: run.unattended ? undefined : (plan) => this.ask(thread.id, run, { kind: 'plan', plan }),
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
      outputBudget: tool.name === 'agents' ? teamShare(ctx.window) : undefined,
      model: this.lastModel.get(thread.id),
      speakerId: run.group ? run.speaker?.id : undefined,
      provenance
    }
    let out: ToolOutput
    try {
      out = await tool.run(args, toolCtx)
    } catch (e) {
      if (run.ctrl.signal.aborted) throw e
      const msg = (e as Error).message
      return { call, status: 'error', content: `Error: ${msg}`, errorFor: { tool: tool.name, message: msg }, meta: { ...baseMeta, status: 'error', display: msg.slice(0, 80) } }
    }

    // 4. Prepare to store: big outputs go to disk; everything is wrapped as data.
    const cm = this.lastModel.get(thread.id) ?? thread.model ?? s.defaultModel
    const cep = this.d.endpoints.for(cm)
    const counter = this.d.counter?.(cep.baseUrl, cm) ?? new ServerTokenCounter(cep.baseUrl, cm)
    const id = `r-${call.id.replace(/[^\w-]/g, '').slice(-12)}-${Date.now().toString(36)}`
    // The team's reports are the work itself: the lead must see them whole, so they get a big share of the window.
    const off = await this.d.results.maybeOffload(out.text, id, counter, tool.name === 'agents' ? teamShare(ctx.window) : undefined)
    if (effect !== 'read') ctx.track.changed = true
    if (tool.name === 'web_search' || tool.name === 'fetch_page' || tool.name === 'research' || (tool.name === 'browser' && /get_text|snapshot|navigate/.test(call.arguments))) ctx.track.researched = true
    const team = this.lastTeam.get(call.id)
    if (team) this.lastTeam.delete(call.id)
    return {
      call,
      status: 'ok',
      content: wrapToolOutput(tool.name, off.text, !!tool.untrusted),
      meta: { ...baseMeta, ...(team ? { team } : {}), ...(provenance && effect !== 'read' ? { provenance } : {}), status: 'ok', display: out.display, path: out.path, sources: out.sources, read: out.read, untrusted: !!tool.untrusted, offloaded: off.offloaded ? id : undefined, tokens: off.tokens },
      images: out.images,
      output: { text: out.text, untrusted: !!tool.untrusted }
    }
  }

  // ---------- handoffs between bots ----------

  /** Bots waiting on another bot's reply: waiter thread → the thread it waits on (cycle check). */
  private handoffWaits = new Map<string, string>()

  /** Waits until nothing runs in a thread (a leftover steer can start one more run). */
  async whenIdle(threadId: string, signal: AbortSignal, ms: number): Promise<'idle' | 'timeout' | 'aborted'> {
    const deadline = Date.now() + ms
    for (;;) {
      const run = this.runs.get(threadId)
      if (!run) return 'idle'
      if (signal.aborted) return 'aborted'
      const left = deadline - Date.now()
      if (left <= 0) return 'timeout'
      await new Promise<void>((resolve) => {
        // A run without a done promise (a helper's) is polled.
        const t = setTimeout(done, run.done ? left : Math.min(left, 500))
        function done(): void { clearTimeout(t); signal.removeEventListener('abort', done); resolve() }
        signal.addEventListener('abort', done, { once: true })
        void run.done?.then(done, done)
      })
    }
  }

  /** What the message_bot tool needs from the agent. */
  handoffHost(): HandoffHost {
    return {
      db: this.d.db,
      emit: (e) => this.d.emit(e),
      runInfo: (threadId) => {
        const r = this.runs.get(threadId)
        const t = this.d.db.getThread(threadId)
        return r ? {
          helper: r.helper, unattended: r.unattended, speaker: r.speaker,
          mode: t ? stricterMode(t.permissionMode, r.modeCap) : r.modeCap,
          tainted: !!r.forceTaint || !!r.taint?.tainted()
        } : undefined
      },
      isRunning: (threadId) => this.runs.has(threadId),
      send: (input, opts) => this.send(input, opts),
      steer: (threadId, text, meta) => this.steer(threadId, text, meta),
      whenIdle: (threadId, signal, ms) => this.whenIdle(threadId, signal, ms),
      waits: this.handoffWaits
    }
  }
}

type CallStatus = 'ok' | 'invalid' | 'error' | 'denied' | 'repeat'

interface ExecCtx {
  failures: Map<string, number>
  untrusted: string[]
  userText: string
  guard: LoopGuard
  track: { changed: boolean; researched: boolean; web: boolean; sawUntrusted: boolean }
  window: number
}

/** A finished call, ready to store. */
interface Outcome {
  call: ToolCall
  status: CallStatus
  content: string
  meta: Record<string, unknown>
  images?: string[]
  /** An error to count toward the repeated-error nudge (counted when stored, in call order). */
  errorFor?: { tool: string; message: string }
  /** Output for the loop guard and the taint corpus (recorded when stored, in call order). */
  output?: { text: string; untrusted: boolean }
}

/** How many read-only calls from one turn run at the same time. */
export const PARALLEL_TOOLS = 4

/**
 * Tools that never run alongside others, even when their effect is 'read': they ask the user, change
 * the plan, start agents or other bots, spend a capped budget, or drive one shared browser or screen.
 */
export const SERIAL_TOOLS = new Set(['ask_user', 'propose_plan', 'find_tools', 'todo', 'agents', 'message_bot', 'consult', 'browser', 'computer', 'cursor'])

const callKey = (c: ToolCall): string => {
  let args = c.arguments
  try { args = JSON.stringify(JSON.parse(c.arguments)) } catch { /* raw */ }
  return `${c.name}:${args}`
}

/**
 * Steers left over when a run ends, as the messages to send: the user's own consecutive steers are joined
 * into one, and each handoff (or other steer with its own meta) stays separate with its meta, so the
 * user's words never carry another bot's handoff label.
 */
export function groupSteers(left: Array<{ text: string; meta?: Record<string, unknown> }>): Array<{ text: string; meta?: Record<string, unknown> }> {
  const out: Array<{ text: string; meta?: Record<string, unknown> }> = []
  for (const x of left) {
    const plain = !x.meta || !Object.keys(x.meta).length
    const prev = out.at(-1)
    if (plain && prev && !prev.meta) prev.text += `\n\n${x.text}`
    else out.push(plain ? { text: x.text } : { text: x.text, meta: x.meta })
  }
  return out
}

/** Runs fn over items with at most `limit` in flight; results keep the input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return out
}

/**
 * decide() plus the user's custom rule for this action. 'allow' counts as always-allowed (hard stops,
 * taint and secret checks still win); 'ask' makes anything that isn't a read ask, even in Auto or Bypass.
 */
export function decideWithRule(p: PermissionInput, rule: 'allow' | 'ask' | null): Decision {
  if (rule === 'allow') return decide({ ...p, alwaysAllowed: true })
  const d = decide(p)
  if (rule === 'ask' && p.effect !== 'read' && d.verdict === 'allow') return { verdict: 'ask', reason: 'One of your approval rules says to ask first' }
  return d
}

/** Whether a model runs in the cloud (costs money, needs Cloud on). */
export const isRemoteModel = (m: ModelInfo): boolean => m.note === 'remote' || !(providerDef(m.provider)?.local ?? true)

/**
 * The model to switch to when the run's model fails: the next stronger one (tier, then rank; local
 * first when equal). `sideways` also allows an equal or weaker one when nothing stronger exists
 * (a provider outage). Cloud models only when Cloud is on and the budget isn't the problem.
 */
export function nextStronger(models: ModelInfo[], current: string, o: { cloud: boolean; localOnly?: boolean; exclude?: Set<string>; sideways?: boolean; needsVision?: boolean }): ModelInfo | undefined {
  let pool = models.filter((m) => m.id !== current && !o.exclude?.has(m.id) && m.tools !== false && m.installed !== false)
  if (!o.cloud || o.localOnly) pool = pool.filter((m) => !isRemoteModel(m))
  if (o.needsVision && pool.some((m) => m.vision)) pool = pool.filter((m) => m.vision)
  const cur = models.find((m) => m.id === current)
  const tier = cur?.tier ?? 0
  const rank = cur?.rank ?? 0
  const up = pool
    .filter((m) => m.tier > tier || (m.tier === tier && (m.rank ?? 0) > rank))
    .sort((a, b) => a.tier - b.tier || (a.rank ?? 0) - (b.rank ?? 0) || Number(isRemoteModel(a)) - Number(isRemoteModel(b)))
  if (up.length) return up[0]
  if (!o.sideways) return undefined
  return [...pool].sort((a, b) => b.tier - a.tier || (b.rank ?? 0) - (a.rank ?? 0) || Number(isRemoteModel(a)) - Number(isRemoteModel(b)))[0]
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

/** Tokens the lead's team reports may take: about a third of the window. */
const teamShare = (window: number): number => Math.max(4000, Math.floor(window * 0.33))

function botMeta(b: Space): Record<string, unknown> {
  return { botId: b.id, botName: b.name, botColor: b.color }
}

export type { ToolDef }
