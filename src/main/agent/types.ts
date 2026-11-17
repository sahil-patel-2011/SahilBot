import type { PermissionMode, ToolEffect } from '@shared/types'

export type JsonSchema = Record<string, unknown>

export interface ToolOutput {
  /** Validated machine-readable result; also shown to the model and available to workflows. */
  data?: unknown
  /** Evidence produced by the implementation, never a model's assertion of success. */
  verification?: { passed: boolean; criterion: string; detail: string }
  /** Text the model sees (wrapped as data before it reaches the model). */
  text: string
  /** Images the model sees on its next step (e.g. browser screenshots). */
  images?: string[]
  /** One-line summary for the tool chip, e.g. "opened example.com". */
  display?: string
  /** A file this call created or changed, so the UI can offer to open it. */
  path?: string
  /** Web pages this call surfaced (search results) or read (read=true), for citations. */
  sources?: Array<{ title: string; url: string }>
  read?: boolean
  /**
   * Structured data for the UI, stored on the tool message's meta (e.g. { stock: StockCardData } for a
   * stock card). Never shown to the model; can't override the loop's own meta keys.
   */
  meta?: Record<string, unknown>
}

export interface ToolContext {
  runId?: string
  /** Stable across a resumed action; adapters may pass it to APIs supporting idempotency keys. */
  idempotencyKey?: string
  /** Calls the normal permission/validation/ledger path, including from workflows and verifiers. */
  invokeTool?: (name: string, args: Record<string, unknown>) => Promise<ToolOutput>
  recall?: (query: string, limit?: number) => Promise<import('../memory-system').RecallHit[]>
  threadId: string
  signal: AbortSignal
  workspaceDir: string
  docsDir: string
  /** Pauses the run and asks the user; resolves with their answer. */
  askUser(question: string, options?: string[]): Promise<string>
  /** Several clarifying questions in one card; resolves with the answers (JSON array of strings). */
  askMany?(questions: Array<{ question: string; options?: string[] }>): Promise<string>
  /**
   * An always-on bot's questions (agent/questions): answered from saved preferences, shown briefly if the
   * user is there, else posted to the Needs-you queue so the bot keeps working. Returns the tool result,
   * or null to ask the usual way.
   */
  queueQuestions?(questions: import('@shared/types').QueueQuestion[]): Promise<ToolOutput | null>
  /** Shows a plan for approval; resolves with "approve" or the user's requested changes. */
  proposePlan?(plan: { goal: string; steps: string[]; assumptions?: string[]; risks?: string[] }): Promise<string>
  /** Per-thread state persisted between runs. */
  state: ThreadState
  /** Load tools by name into the thread's tool set (find_tools). */
  loadTools(names: string[]): string[]
  /** Search across tools not currently loaded. */
  searchTools(query: string): Array<{ name: string; description: string; loaded: boolean; connector?: boolean }>
  readResult(id: string): string | undefined
  /** Offers a one-click connect card for an app that isn't connected; resolves to the app's tools once connected (empty if not). `fullName`: only an app the query names in full. */
  offerConnect?(query: string, o?: { fullName?: boolean; reason?: string }): Promise<Array<{ name: string; description: string; loaded: boolean }>>
  /** The model this run uses. */
  model?: string
  /** Group chats: the bot speaking right now (its own memories, rules and work log are its, not shared). */
  speakerId?: string
  /**
   * Where this call's text likely came from: 'web-tainted' when it carries details from, or reads like
   * instructions after, untrusted content this run read. Recorded with saved memories, skills and rules.
   */
  provenance?: 'chat' | 'web-tainted'
  /**
   * This run has untrusted content in view: it read a web page, email or another bot's or app's message,
   * started from a relayed message or link, or is a goal wake-up (always treated as tainted).
   */
  tainted?: boolean
  /** Tokens this call's output may use before it is cut short (set for tools that size their own output). */
  outputBudget?: number
  /** Runs helper agents in parallel and returns their reports (Team of Experts). */
  spawnAgents?(tasks: Array<{ title: string; task: string }>): Promise<Array<{ title: string; status: string; report: string }>>
  /** Runs a bot swarm (tools/agents.ts swarmTool → swarm/bot-swarm.ts) and returns what the lead compiles from. */
  runSwarm?(args: import('./swarm/bot-swarm').SwarmArgs): Promise<ToolOutput>
  /** Runs Max for the lead (tools/max.ts → max/host.ts): a team, a swarm, judged attempts or a mix. */
  runMax?(args: import('./max/host').MaxArgs): Promise<ToolOutput>
  /** Asks another bot (tools/ask-bot.ts): its answer, or the directory of bots with list. */
  askBot?(a: { bot?: string; question?: string; list?: boolean }): Promise<ToolOutput>
  /**
   * Live progress from a long-running call (a test run's latest output line, what a Cursor agent is
   * doing right now). Optional: tools must work without it. Shown on the tool's chip while it runs.
   */
  progress?(text: string): void
  /** The user approved this exact call (an approval card), so commands it runs aren't sandboxed. */
  approved?: boolean
  /** Run terminal commands under the write sandbox (advanced.sandboxCommands; default on). */
  sandbox?: boolean
}

export interface ToolDef<A = any> {
  name: string
  description: string
  parameters: JsonSchema
  outputSchema?: JsonSchema
  /** Retry only when the adapter explicitly guarantees that repeating the action is safe. */
  idempotent?: boolean
  /** What running it can do to the world. May depend on arguments (browser actions). */
  /** `roots`: the chat's attached folders, so a path inside one resolves. */
  effect: ToolEffect | ((args: A, call: { roots: string[]; folder?: string }) => ToolEffect)
  /** Always in the tool list. Everything else is loaded through find_tools. */
  core?: boolean
  /** Listed only when this returns true (e.g. the cloud advisor needs a key and a local model). */
  available?: (state: ThreadState) => boolean
  /** Group label for find_tools results, e.g. "Gmail". */
  group?: string
  /**
   * A connected app's tool (MCP): a chat may load and use it without turning into agent work. Optional:
   * connector tools are also recognized by their "[App] …" description and group (registry isConnectorTool).
   */
  connector?: boolean
  /** Output comes from outside (web pages, email): wrapped as untrusted and used for taint checks. */
  untrusted?: boolean
  /**
   * For write_external calls: false when the action is routine (sign in, next page, search, save a draft),
   * so Auto mode runs it. Omitted means consequential: Auto asks.
   */
  consequential?: (args: A, call: { threadId: string; unattended?: boolean; state?: ThreadState }) => boolean | 'project'
  /**
   * Returns a reason when this call falls on the hard-stop list. `call` (when the loop has it): the chat's
   * attached folders and working folder, so a path outside them can ask first.
   */
  hardStop?: (args: A, call?: { roots: string[]; folder?: string }) => string | null
  /** Plain-English description of a call for the approval card, e.g. 'Click button "Send" on acme.com'. */
  describe?: (args: A) => string
  /** Short chip label before the run finishes, e.g. "Searching the web". */
  label: string
  run(args: A, ctx: ToolContext): Promise<ToolOutput>
}

export interface TodoItem {
  text: string
  status: 'pending' | 'in_progress' | 'done'
}

export interface ThreadState {
  workerFolder?: string
  taskPolicy?: import('./runtime/store').TaskPolicy
  acceptance?: Array<{ criterion: string; tool: string; args: Record<string, unknown>; pointer?: string; equals?: unknown; contains?: string }>
  /** Non-core tools loaded into this thread, in load order (appended, never reordered). */
  loaded: string[]
  /** Tools the user allowed "always" in this thread. */
  alwaysAllow: string[]
  todos: TodoItem[]
  /** The system prompt frozen for this thread so the server's KV cache prefix stays valid. */
  systemSnapshot?: string
  /** Group chats: one frozen system prompt per member bot. */
  snapshots?: Record<string, string>
  /** Files and folders the user attached; file tools may read and change anything inside them. */
  roots?: string[]
  /** The working folder the user chose for this chat (composer → Working folder). */
  workFolder?: string
  /**
   * The working folder in effect for this run: the chat's own choice, else its bot's or project's folder.
   * Relative paths in file tools and commands start here; it's always one of `roots`. Set by the loop.
   */
  folder?: string
  /** A voice conversation: spoken-style prompt and a 16k window. */
  voice?: boolean
  /** Messages up to and including `boundaryId` are represented by `summary`. */
  /** tainted: the summarized turns held outside content; the summary is shown as untrusted data. */
  /** brief: the task brief written with it (context.ts taskBrief): the user's summarized messages verbatim, plan, notes. */
  compaction?: { boundaryId: string; summary: string; at?: number; tainted?: boolean; brief?: string }
  /** Auto mode: the tier the last request was routed to (follow-ups keep it). */
  lastTier?: 0 | 1 | 2 | 3
  /** Auto mode: the kind of task the last request was (task-classifier.ts; follow-ups keep it). */
  lastCategory?: import('../llm/task-classifier').TaskCategory
  /** Auto mode: the model Auto used for the last request (a follow-up keeps it when it is as good: routing-table keepPrevious). */
  lastAutoModel?: string
  /** Helper agents: how deep this one is (1 = started by the chat's agent) and the chat it all started in. */
  depth?: number
  rootId?: string
  /** The team card in the root chat that this helper reports into. */
  rootCallId?: string
  /** The agent's working notes for a long task: key facts, decisions, paths, IDs. Kept through compaction. */
  notes?: string
  /**
   * Structured working notes (notes tool, agent/notes.ts): fixed sections, capped and deduplicated, with the
   * user's constraints captured from their own messages. Carried verbatim in the task brief through compaction.
   */
  taskNotes?: import('./notes').TaskNotes
  /** Hybrid mode: cloud consultations used in the current request. */
  consults?: number
  /**
   * Per-run <context> blocks (date, memories, project notes) pinned to the user message that started
   * each run, by message id (`speakerId/messageId` in groups). Kept so earlier turns stay byte-identical.
   */
  pins?: Record<string, string>
  /**
   * 'chat': only chat so far (conversation, questions, lookups), so requests carry the lean chat prompt and
   * the chat tool set (registry CHAT_TOOLS, plus connected apps' and read-only tools it loaded). Once a
   * request needs real work it becomes 'full' for good, so the prompt and tool list (and the cached prefix)
   * stay put. 'quick' is the older name of 'chat' (threads saved before the chat path).
   */
  toolMode?: 'chat' | 'quick' | 'full'
  /**
   * Small context windows (local models on 16-32K): the agent's slimmer prompt and tool set ('small': compact
   * schemas and fewer always-on tools, the rest via find_tools; 'tiny': fewer still). Undefined: the full set.
   * Set by the loop for each step (registry chooseProfile), so find_tools searches what isn't listed.
   */
  toolProfile?: 'small' | 'tiny'
  /** How the last request ran ('chat' or 'agent'): a follow-up ("yes, do it") keeps it. */
  lastKind?: 'chat' | 'agent'
  /** Auto's effort for the last request (a follow-up like "continue" keeps it); undefined when a level was picked. */
  lastEffort?: import('@shared/types').Effort
  /** The last request was school work (its follow-ups are too). */
  lastStudy?: boolean
  /** The lean system prompts frozen for this thread (chat and compact; `speakerId:` keys in groups). */
  leanSnapshots?: Record<string, string>
  /** Text appended to every system prompt variant of this thread (a helper's or Heavy attempt's note). */
  snapshotNote?: string
  /**
   * Project folders as this chat first saw them (git top level → commit, origin URL, git config hash):
   * Auto's installs and pulls only run while the lockfile and origin still match (tools/shell.ts).
   */
  projectTrust?: Record<string, { head: string; origin: string; config: string; at: number }>
  /** Install config or git internals this chat wrote ('*': it touched some): installs and pulls ask again. */
  written?: string[]
  /** This chat's bot may swarm (its Swarm setting, set by the loop each run; never on helpers). */
  swarm?: 'auto' | 'always'
  /** The max tool's listing for this run: the bot's Max setting ('on': Max is on for this request); unset on helpers. */
  max?: 'off' | 'auto' | 'always' | 'on'
  /** A swarm helper or council member: only these tools are listed or run (read-only by default). */
  toolAllow?: string[]
  /** ask_bot: the bots asking in this exchange (the asker first, this bot last), for loop protection. */
  askChain?: string[]
}

export const emptyState = (): ThreadState => ({ loaded: [], alwaysAllow: [], todos: [] })

export interface Decision {
  verdict: 'allow' | 'ask' | 'deny'
  reason?: string
  /** Allowed because every recipient is trusted (agent/trusted.ts): counts toward the bot's hourly limit once it runs. */
  trusted?: boolean
}

export interface PermissionInput {
  mode: PermissionMode
  effect: ToolEffect
  tool: string
  alwaysAllowed: boolean
  hardStop: string | null
  hardStopsEnabled: boolean
  /** Arguments contain values that came from fetched content rather than from the user. */
  tainted: boolean
  /** Arguments contain a vault secret's plain text. */
  leaksSecret: boolean
  /**
   * The outside action has real consequences (sends, buys, posts, deletes). Defaults to true.
   * 'project': it reaches outside only to set up the user's own project (installs from its lockfile into
   * its folder, git fetch/pull): Auto runs it (attended); Ask treats it as consequential.
   */
  consequential?: boolean | 'project'
  /** A run with nobody watching (routine, goal wake-up, helper): Auto works cautiously (decide()). */
  unattended?: boolean
  /**
   * An always-on bot's chat (not a helper): an unattended run keeps full Auto. Its bot hard stops
   * (permissions.ts botHardStop), taint and the purchase / one-time-code gates still apply.
   */
  alwaysOn?: boolean
  /**
   * A send whose every recipient is on this bot's "Can message without asking" list or is the user
   * (agent/trusted.ts). Lifts the send hard stop in Auto and Bypass, attended or not, tainted or not.
   */
  trustedSend?: boolean
  /** Why a send to trusted people still asks (too many at once, hourly limit): added to the card's reason. */
  trustNote?: string
}
