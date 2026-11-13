import { forClaude } from './anthropic'

// Constrained decoding for a broken tool call. When a local model's tool arguments fail the schema, one
// quick non-streaming request asks the same model for just the arguments, with the server forcing its
// output to match the tool's JSON schema: Ollama's `format` (a JSON schema), or `response_format:
// json_schema` on OpenAI-compatible local servers (llama.cpp server, LM Studio, vLLM). Only used on that
// retry, so normal streaming stays as fast as before. Returns the arguments as a JSON string, or null.

export interface ConstrainedInput {
  baseUrl: string
  apiKey?: string
  model: string
  /** Ollama's native API (else OpenAI-compatible). */
  ollama: boolean
  tool: { name: string; description: string; parameters: Record<string, unknown> }
  /** The arguments the model sent, and why they failed. */
  bad: string
  error: string
  /** What the user asked (so the model can fill the arguments in). */
  request?: string
  signal?: AbortSignal
  /** Keeps the model's window (Ollama reloads a model when num_ctx changes). */
  numCtx?: number
}

/**
 * The schema servers can enforce: conditional rules (if/then) aren't supported by grammar converters,
 * so they move into the prompt (the agent still validates the full schema afterwards).
 */
export function enforceableSchema(parameters: Record<string, unknown>, description = ''): { schema: Record<string, unknown>; rules: string } {
  const c = forClaude(parameters, description)
  return { schema: c.schema, rules: c.description.slice(description.length).trim() }
}

const root = (u: string): string => u.replace(/\/+$/, '').replace(/\/v1$/, '')

/** URL and body for the constrained request (pure: tested without a server). */
export function constrainedRequest(i: ConstrainedInput): { url: string; body: Record<string, unknown> } {
  const { schema, rules } = enforceableSchema(i.tool.parameters, i.tool.description)
  const system = 'You fix tool calls. Reply with only the JSON arguments object for the tool, matching its schema. No prose.'
  const user = [
    `Tool: ${i.tool.name}`,
    `What it does: ${i.tool.description.slice(0, 600)}`,
    rules ? `Rules: ${rules}` : '',
    i.request ? `The user's request: ${i.request.slice(0, 1500)}` : '',
    `Your previous arguments: ${i.bad.slice(0, 3000)}`,
    `Why they were rejected: ${i.error.slice(0, 600)}`,
    'Write the corrected arguments.'
  ].filter(Boolean).join('\n')
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }]
  if (i.ollama) {
    return {
      url: `${root(i.baseUrl)}/api/chat`,
      body: { model: i.model, messages, stream: false, format: schema, think: false, options: { temperature: 0, ...(i.numCtx ? { num_ctx: i.numCtx } : {}) } }
    }
  }
  return {
    url: `${i.baseUrl.replace(/\/+$/, '')}/chat/completions`,
    body: {
      model: i.model, messages, stream: false, temperature: 0, max_tokens: 4096,
      response_format: { type: 'json_schema', json_schema: { name: i.tool.name.replace(/[^\w-]/g, '_').slice(0, 64), schema, strict: true } }
    }
  }
}

/** The arguments the server returned, as a JSON object string, or null. */
export function constrainedResult(body: unknown, ollama: boolean): string | null {
  const b = body as { message?: { content?: string }; choices?: Array<{ message?: { content?: string } }> }
  const text = (ollama ? b.message?.content : b.choices?.[0]?.message?.content)?.trim()
  if (!text) return null
  try {
    const v = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''))
    return v && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : null
  } catch {
    return null
  }
}

/** One constrained retry. Any failure (server without schema support, timeout) → null: the normal repair prompt follows. */
export async function constrainedArgs(i: ConstrainedInput): Promise<string | null> {
  const { url, body } = constrainedRequest(i)
  const timeout = AbortSignal.timeout(60_000)
  const signal = i.signal ? AbortSignal.any([i.signal, timeout]) : timeout
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(i.apiKey ? { authorization: `Bearer ${i.apiKey}` } : {}) }, body: JSON.stringify(body), signal })
  if (!res.ok) return null
  return constrainedResult(await res.json(), i.ollama)
}
