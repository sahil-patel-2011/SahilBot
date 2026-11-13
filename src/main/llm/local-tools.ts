import type { Sampling } from '@shared/types'
import { GENERIC, lookup, paramsFromName } from './catalog'
import type { WireMessage } from './client'

// Small local models (14B and under) call tools far more reliably with two nudges: a cooler temperature
// on requests that offer tools, and a short primer on how a correct call looks. Both apply only to
// local servers, and both are fixed text/values per model, so the server's prompt cache stays valid.

/** Parameter count in billions, from the catalog or the name ("qwen3.5:9b" → 9). */
export function sizeB(model: string): number | undefined {
  return lookup(model)?.paramsB ?? paramsFromName(model)
}

/** A local model small enough to need help with tool calls. */
export const smallLocal = (model: string): boolean => {
  const p = sizeB(model)
  return p !== undefined && p <= 14
}

/**
 * Temperature cap on tool turns, per family: Qwen3-style thinking models keep their card's 0.6 floor
 * area (greedy decoding makes them loop) at 0.5; everything else small goes to 0.3, which keeps JSON
 * arguments and tool names exact.
 */
export function toolTemperature(model: string): number {
  return /qwen/i.test(model) ? 0.5 : 0.3
}

/**
 * Sampling for a request that offers tools to a small local model: the card's temperature, capped. A
 * temperature the user set for this model (anything other than the card's) is left alone.
 */
export function toolTurnSampling(model: string, s: Sampling, hasTools: boolean): Sampling {
  if (!hasTools || !smallLocal(model)) return s
  const card = (lookup(model)?.sampling ?? GENERIC).temperature
  if (s.temperature !== card) return s
  return { ...s, temperature: Math.min(s.temperature, toolTemperature(model)) }
}

/** Appended to the system prompt of small local models when tools are offered. */
export const TOOL_PRIMER = `

# How to call tools
- To use a tool, make a real tool call: never write the call as text, and never describe or invent its result.
- One tool per step, then wait for its result before deciding the next step.
- Arguments are JSON that match the tool's parameters exactly: double quotes, every required field, no comments, no extra fields.
- Example: the user asks "what's the weather in Paris today?" → call web_search with {"query": "Paris weather today"}, then answer from the result.
- Example: the user asks to save a shopping list → call file_write with {"path": "shopping.md", "content": "- milk\\n- eggs"}, then say where it was saved.
- If a call fails, read the error, fix the arguments, and try once more.`

/** The messages with the primer added to the system message (or as one, if there is none). */
export function withToolPrimer(messages: WireMessage[], model: string, hasTools: boolean): WireMessage[] {
  if (!hasTools || !smallLocal(model)) return messages
  const i = messages.findIndex((m) => m.role === 'system')
  if (i < 0) return [{ role: 'system', content: TOOL_PRIMER.trim() }, ...messages]
  const m = messages[i]
  if (typeof m.content !== 'string' || m.content.includes('# How to call tools')) return messages
  const out = [...messages]
  out[i] = { ...m, content: m.content + TOOL_PRIMER }
  return out
}
