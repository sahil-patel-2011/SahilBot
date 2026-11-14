// Anthropic's server tools: web search and web fetch run on Anthropic's servers inside the request.
//
// Reference: shared/tool-use-concepts.md § Server-Side Tools: Web Search and Web Fetch
// ({"type": "web_search_20260209", "name": "web_search"}, {"type": "web_fetch_20260209", "name":
// "web_fetch"}; dynamic filtering is built in, no beta header; don't add eager_input_streaming to server
// tools) and the web search / web fetch pages it points to (live-sources.md): the response carries
// server_tool_use blocks, then web_search_tool_result (content: web_search_result items with url, title,
// page_age, encrypted_content — or a web_search_tool_result_error) and web_fetch_tool_result (content: a
// web_fetch_result with url and a document, or a web_fetch_tool_result_error); text blocks carry
// citations (web_search_result_location: url, title, cited_text; char_location for fetched documents).
// usage.server_tool_use counts web_search_requests / web_fetch_requests. Web search costs $10 per 1,000
// searches (shared/managed-agents-core.md list cost); web fetch costs nothing beyond its tokens. Results
// must go back exactly as received (encrypted_content), so the assistant turn is replayed unchanged.
//
// Everything a server tool brought in is outside content: its text joins the run's untrusted list, so
// the taint check treats actions built from it exactly like actions built from fetch_page output.

/** $ per web search (shared/managed-agents-core.md: "web searches at $10 per 1,000"). */
export const WEB_SEARCH_USD = 0.01
/** Searches and fetches per request (bounds the cost of one turn; failed ones count too). */
export const SEARCH_MAX_USES = 8
export const FETCH_MAX_USES = 10
/** Fetched pages are cut to about this many tokens before they reach the context. */
export const FETCH_MAX_TOKENS = 60_000

export function serverToolDefs(web: { search: string; fetch: string }, want: { search: boolean; fetch: boolean }): Record<string, unknown>[] {
  return [
    ...(want.search ? [{ type: web.search, name: 'web_search', max_uses: SEARCH_MAX_USES }] : []),
    ...(want.fetch ? [{ type: web.fetch, name: 'web_fetch', max_uses: FETCH_MAX_USES, citations: { enabled: true }, max_content_tokens: FETCH_MAX_TOKENS }] : [])
  ]
}

export interface ServerFindings {
  /** Pages the search found (title + url), for the source pills. */
  found: Array<{ title: string; url: string }>
  /** Pages actually read (fetched, or cited from a search result). */
  read: Array<{ title: string; url: string }>
  /** Outside text that reached the model: titles, cited passages, fetched page text (for the taint check). */
  untrusted: string[]
  searches: number
  fetches: number
  /** Searches/fetches that came back as an error code. */
  errors: string[]
}

type Block = { type?: string; [k: string]: unknown }
const UNTRUSTED_CAP = 20_000

/** What the server tools in one response did (from the content blocks and usage). */
export function serverFindings(content: unknown[], usage?: { server_tool_use?: { web_search_requests?: number | null; web_fetch_requests?: number | null } | null } | null): ServerFindings {
  const out: ServerFindings = { found: [], read: [], untrusted: [], searches: 0, fetches: 0, errors: [] }
  const seen = new Set<string>()
  const add = (list: Array<{ title: string; url: string }>, title: unknown, url: unknown): void => {
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return
    const key = `${list === out.read ? 'r' : 'f'}|${url}`
    if (seen.has(key)) return
    seen.add(key)
    list.push({ title: typeof title === 'string' && title ? title : url, url })
  }
  let searchBlocks = 0
  let fetchBlocks = 0
  for (const b of content as Block[]) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'web_search_tool_result') {
      searchBlocks++
      const c = b.content as Block | Block[] | undefined
      if (Array.isArray(c)) {
        for (const r of c) {
          if (r?.type !== 'web_search_result') continue
          add(out.found, r.title, r.url)
          out.untrusted.push(`${String(r.title ?? '')} ${String(r.url ?? '')}`.trim())
        }
      } else if (c && typeof c === 'object' && typeof c.error_code === 'string') out.errors.push(`web_search: ${c.error_code}`)
    } else if (b.type === 'web_fetch_tool_result') {
      fetchBlocks++
      const c = b.content as Block | undefined
      if (c?.type === 'web_fetch_result') {
        const doc = c.content as { title?: unknown; source?: { type?: string; data?: unknown } } | undefined
        add(out.read, doc?.title, c.url)
        if (doc?.source?.type === 'text' && typeof doc.source.data === 'string') out.untrusted.push(doc.source.data.slice(0, UNTRUSTED_CAP))
        else out.untrusted.push(String(c.url ?? ''))
      } else if (c && typeof c.error_code === 'string') out.errors.push(`web_fetch: ${c.error_code}`)
    } else if (b.type === 'text' && Array.isArray(b.citations)) {
      for (const cit of b.citations as Block[]) {
        if (cit?.type === 'web_search_result_location') add(out.read, cit.title, cit.url)
        if (typeof cit?.cited_text === 'string' && cit.cited_text) out.untrusted.push(cit.cited_text)
      }
    }
  }
  const u = usage?.server_tool_use
  out.searches = Math.max(Number(u?.web_search_requests ?? 0) || 0, 0) || searchBlocks
  out.fetches = Math.max(Number(u?.web_fetch_requests ?? 0) || 0, 0) || fetchBlocks
  out.untrusted = out.untrusted.filter(Boolean)
  return out
}

/** Server tool fees for one response, in dollars (web search only; web fetch is free beyond tokens). */
export const serverToolUsd = (f: Pick<ServerFindings, 'searches'>): number => f.searches * WEB_SEARCH_USD
