import type { PermissionMode, ToolEffect } from '@shared/types'

export type JsonSchema = Record<string, unknown>

export interface ToolOutput {
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
  threadId: string
  signal: AbortSignal
  workspaceDir: string
  docsDir: string
  /** Pauses the run and asks the user; resolves with their answer. */
  askUser(question: string, options?: string[]): Promise<string>
  /** Several clarifying questions in one card; resolves with the answers (JSON array of strings). */
  askMany?(questions: Array<{ question: string; options?: string[] }>): Promise<string>
  /** Shows a plan for approval; resolves with "approve" or the user's requested changes. */
  proposePlan?(plan: { goal: string; steps: string[]; assumptions?: string[]; risks?: string[] }): Promise<string>
  /** Per-thread state persisted between runs. */
  state: ThreadState
  /** Load tools by name into the thread's tool set (find_tools). */
  loadTools(names: string[]): string[]
  /** Search across tools not currently loaded. */
  searchTools(query: string): Array<{ name: string; description: string; loaded: boolean }>
  readResult(id: string): string | undefined
  /** Offers a one-click connect card for an app that isn't connected; resolves true once connected. */
  offerConnect?(query: string): Promise<string[]>
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
  /** What running it can do to the world. May depend on arguments (browser actions). */
  /** `roots`: the chat's attached folders, so a path inside one resolves. */
  effect: ToolEffect | ((args: A, call: { roots: string[] }) => ToolEffect)
  /** Always in the tool list. Everything else is loaded through find_tools. */
  core?: boolean
  /** Listed only when this returns true (e.g. the cloud advisor needs a key and a local model). */
  available?: (state: ThreadState) => boolean
  /** Group label for find_tools results, e.g. "Gmail". */
  group?: string
  /** Output comes from outside (web pages, email): wrapped as untrusted and used for taint checks. */
  untrusted?: boolean
  /**
   * For write_external calls: false when the action is routine (sign in, next page, search, save a draft),
   * so Auto mode runs it. Omitted means consequential: Auto asks.
   */
  consequential?: (args: A, call: { threadId: string; unattended?: boolean; state?: ThreadState }) => boolean | 'project'
  /** Returns a reason when this call falls on the hard-stop list. */
  hardStop?: (args: A) => string | null
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
  /** A voice conversation: spoken-style prompt and a 16k window. */
  voice?: boolean
  /** Messages up to and including `boundaryId` are represented by `summary`. */
  /** tainted: the summarized turns held outside content; the summary is shown as untrusted data. */
  compaction?: { boundaryId: string; summary: string; at?: number; tainted?: boolean }
  /** Auto mode: the tier the last request was routed to (follow-ups keep it). */
  lastTier?: 0 | 1 | 2 | 3
  /** Helper agents: how deep this one is (1 = started by the chat's agent) and the chat it all started in. */
  depth?: number
  rootId?: string
  /** The team card in the root chat that this helper reports into. */
  rootCallId?: string
  /** The agent's working notes for a long task: key facts, decisions, paths, IDs. Kept through compaction. */
  notes?: string
  /** Hybrid mode: cloud consultations used in the current request. */
  consults?: number
  /**
   * Per-run <context> blocks (date, memories, project notes) pinned to the user message that started
   * each run, by message id (`speakerId/messageId` in groups). Kept so earlier turns stay byte-identical.
   */
  pins?: Record<string, string>
  /**
   * 'quick': only small talk so far, so requests carry the small tool set (registry QUICK_TOOLS). Once a
   * request needs more it becomes 'full' for good, so the tool list (and the cached prefix) stays put.
   */
  toolMode?: 'quick' | 'full'
  /**
   * Project folders as this chat first saw them (git top level → commit, origin URL, git config hash):
   * Autonomous installs and pulls only run while the lockfile and origin still match (tools/shell.ts).
   */
  projectTrust?: Record<string, { head: string; origin: string; config: string; at: number }>
  /** Install config or git internals this chat wrote ('*': it touched some): installs and pulls ask again. */
  written?: string[]
}

export const emptyState = (): ThreadState => ({ loaded: [], alwaysAllow: [], todos: [] })

export interface Decision {
  verdict: 'allow' | 'ask' | 'deny'
  reason?: string
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
   * its folder, git fetch/pull): Autonomous runs it; Ask and Auto treat it as consequential.
   */
  consequential?: boolean | 'project'
  /** A run with nobody watching (routine, goal wake-up, helper): Autonomous works like Auto. */
  unattended?: boolean
}
