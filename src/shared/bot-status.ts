import type { Message } from './types'

// A bot's status on its row and card: Working / Pulling context / Done / Idle, and the model its last reply
// ran on ("runs on Claude"). Pure, so main (bots:status) and the tests share it. Auto still picks a model
// per request: "runs on" only labels the last run.

export type BotRunState = 'working' | 'context' | 'done' | 'idle'

export interface BotStatus {
  state: BotRunState
  /** The model id of the bot's last reply. */
  model?: string
  /** Which server answered it (anthropic, openai, chatgpt, ollama, lmstudio, openrouter, xai, custom). */
  provider?: string
  /** Short name for "runs on …": Claude, ChatGPT, Gemini, Grok, "Qwen3 8B on this Mac". */
  runsOn?: string
  /** When that reply came. */
  at?: number
}

/** Status by space id (bots:status). */
export type BotStatusMap = Record<string, BotStatus>

export const STATE_LABELS: Record<BotRunState, string> = { working: 'Working', context: 'Pulling context', done: 'Done', idle: 'Idle' }

/** SahilBot's own tools that gather context: the brain (about, vault, memory), files, history, the web. */
const CONTEXT_TOOLS = new Set(['about', 'vault', 'memory', 'knowledge_search', 'knowledge_status', 'chat_history', 'file_read', 'research', 'web_search', 'fetch_page', 'find_tools'])
/** Connected apps' read tools (server__tool): search, read, get, list… */
const READ_VERB = /(^|_)(search|read|get|list|find|lookup|query|fetch|recall|retrieve|describe|view|show)(_|$)/i

/** True for a tool call that only reads context (the brain, files, a connected app's search). */
export function isContextTool(name: string): boolean {
  if (CONTEXT_TOOLS.has(name)) return true
  const i = name.indexOf('__')
  return i > 0 && READ_VERB.test(name.slice(i + 2))
}

type TurnMessage = Pick<Message, 'role' | 'content' | 'kind'> & { toolCalls?: Array<{ name: string }> }

/**
 * Where a running turn is: still pulling context (it hasn't written anything yet and every tool it has called
 * only reads), or working (writing the answer, or doing something beyond reading). `messages` is the chat,
 * oldest first; only what came after the last user message counts.
 */
export function runPhase(messages: TurnMessage[]): 'context' | 'working' {
  let start = messages.length
  while (start > 0 && messages[start - 1].role !== 'user') start--
  const turn = messages.slice(start).filter((m) => m.role === 'assistant' && m.kind === 'normal')
  const last = turn.at(-1)
  if (last && last.content.trim() && !last.toolCalls?.length) return 'working'
  const calls = turn.flatMap((m) => m.toolCalls ?? [])
  return calls.every((c) => isContextTool(c.name)) ? 'context' : 'working'
}

/** The bot's state: running (its phase), else Done while a reply is unread, else Idle. */
export function botState(o: { running: boolean; phase?: 'context' | 'working'; unread: boolean }): BotRunState {
  if (o.running) return o.phase ?? 'working'
  return o.unread ? 'done' : 'idle'
}

/**
 * The status with the renderer's fresher read state: Done turns Idle as soon as you read the reply (and Idle
 * turns Done when a reply is unread), without waiting for the next status fetch. Running states stay.
 */
export function withUnread(s: BotStatus | undefined, unread: boolean): BotStatus {
  const base: BotStatus = s ?? { state: 'idle' }
  if (base.state === 'working' || base.state === 'context') return base
  return { ...base, state: unread ? 'done' : 'idle' }
}

/** A model id as a short name: "qwen3:8b" → "qwen3:8b", "meta-llama/llama-3.3-70b" → "llama-3.3-70b". */
export function shortModel(model: string): string {
  return model.replace(/^chatgpt-plan\//, '').split('/').pop() || model
}

/** Which family served a model, for "runs on …". */
export function modelFamily(provider: string | undefined, model: string): 'claude' | 'chatgpt' | 'gemini' | 'grok' | 'local' | 'server' | 'other' {
  const p = (provider ?? '').toLowerCase()
  if (/^(anthropic\/)?claude/i.test(model) || p === 'anthropic') return 'claude'
  // Local first: Ollama's gpt-oss is not ChatGPT.
  if (p === 'ollama' || p === 'lmstudio' || p === 'local') return 'local'
  if (p === 'chatgpt' || /^chatgpt-plan\//i.test(model)) return 'chatgpt'
  if (/(^|\/)gemini/i.test(model) || p === 'google' || p === 'gemini') return 'gemini'
  if (/(^|\/)grok/i.test(model) || p === 'xai') return 'grok'
  if (/^(openai\/)?(gpt-|o\d|chatgpt)/i.test(model) || p === 'openai') return 'chatgpt'
  if (p === 'custom') return 'server'
  return 'other'
}

/**
 * "Claude", "ChatGPT", "Gemini", "Grok", "Qwen3 8B on this Mac", "llama3 on your model server". `label` is
 * Auto's routed label ("Qwen3 8B · Coding"): only the model part is used.
 */
export function runsOnLabel(provider: string | undefined, model: string, label?: string): string {
  const name = (label ?? '').split(' · ')[0].trim() || shortModel(model)
  switch (modelFamily(provider, model)) {
    case 'claude': return 'Claude'
    case 'chatgpt': return 'ChatGPT'
    case 'gemini': return 'Gemini'
    case 'grok': return 'Grok'
    case 'local': return `${name} on this Mac`
    case 'server': return `${name} on your model server`
    default: return name
  }
}

/** The card's line: "Pulling context… · runs on Claude", "Idle · runs on ChatGPT", or just the state. */
export function statusText(s: BotStatus | undefined): string {
  const st = s?.state ?? 'idle'
  const label = STATE_LABELS[st] + (st === 'working' || st === 'context' ? '…' : '')
  return s?.runsOn ? `${label} · runs on ${s.runsOn}` : label
}
