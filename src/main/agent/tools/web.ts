import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import type { ToolDef } from '../types'

export interface SearchConfig {
  provider: 'auto' | 'none' | 'brave' | 'searxng' | 'duckduckgo'
  searxngUrl: string
  braveKey?: string
}

interface Hit {
  title: string
  url: string
  snippet: string
}

const CHUNK_CHARS = 5250 // ~1.5k tokens
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) SahilBot/0.1 Safari/537.36'

async function brave(query: string, count: number, key: string, signal: AbortSignal): Promise<Hit[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`
  const res = await fetch(url, { headers: { accept: 'application/json', 'x-subscription-token': key }, signal })
  if (!res.ok) throw new Error(`Brave Search returned ${res.status}`)
  const j = (await res.json()) as { web?: { results?: Array<{ title: string; url: string; description?: string }> } }
  return (j.web?.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: (r.description ?? '').replace(/<[^>]+>/g, '') }))
}

async function searxng(query: string, count: number, base: string, signal: AbortSignal): Promise<Hit[]> {
  const res = await fetch(`${base.replace(/\/+$/, '')}/search?q=${encodeURIComponent(query)}&format=json`, { signal })
  if (!res.ok) throw new Error(`SearXNG returned ${res.status}. JSON output must be enabled in its settings.yml (search.formats: [html, json]).`)
  const j = (await res.json()) as { results?: Array<{ title: string; url: string; content?: string }> }
  return (j.results ?? []).slice(0, count).map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? '' }))
}

/** Keyless fallback: DuckDuckGo's HTML endpoint, parsed locally. */
export async function duckduckgo(query: string, count: number, signal: AbortSignal, base = 'https://html.duckduckgo.com'): Promise<Hit[]> {
  const res = await fetch(`${base}/html/?q=${encodeURIComponent(query)}`, { headers: { 'user-agent': UA, accept: 'text/html' }, signal })
  if (!res.ok) throw new Error(`DuckDuckGo returned ${res.status}`)
  return parseDuckDuckGo(await res.text()).slice(0, count)
}

/** DuckDuckGo's lightest page: same results, different markup. */
export function parseDuckDuckGoLite(html: string): Hit[] {
  const { document } = parseHTML(html)
  const links = Array.from(document.querySelectorAll('a.result-link')) as Array<{ textContent: string | null; getAttribute(n: string): string | null }>
  const snippets = Array.from(document.querySelectorAll('td.result-snippet')) as Array<{ textContent: string | null }>
  return links.map((a, i) => {
    let href = a.getAttribute('href') ?? ''
    const m = href.match(/[?&]uddg=([^&]+)/)
    if (m) href = decodeURIComponent(m[1])
    if (href.startsWith('//')) href = `https:${href}`
    return { title: (a.textContent ?? '').trim(), url: href, snippet: (snippets[i]?.textContent ?? '').trim() }
  }).filter((h) => /^https?:/.test(h.url) && !/duckduckgo\.com\/y\.js/.test(h.url))
}

export function parseBing(html: string): Hit[] {
  const { document } = parseHTML(html)
  const out: Hit[] = []
  for (const r of Array.from(document.querySelectorAll('li.b_algo')) as Array<{ querySelector(s: string): { textContent: string | null; getAttribute(n: string): string | null } | null }>) {
    const a = r.querySelector('h2 a')
    if (!a) continue
    let href = a.getAttribute('href') ?? ''
    // Bing wraps links as /ck/a?…&u=a1<base64url of the real URL>.
    const u = href.match(/[?&]u=a1([^&]+)/)
    if (u) { try { href = Buffer.from(u[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8') } catch { /* keep */ } }
    if (!/^https?:/.test(href)) continue
    out.push({ title: (a.textContent ?? '').trim(), url: href, snippet: (r.querySelector('.b_caption p')?.textContent ?? r.querySelector('p')?.textContent ?? '').trim() })
  }
  return out
}

export function parseMojeek(html: string): Hit[] {
  const { document } = parseHTML(html)
  const out: Hit[] = []
  for (const r of Array.from(document.querySelectorAll('ul.results-standard li')) as Array<{ querySelector(s: string): { textContent: string | null; getAttribute(n: string): string | null } | null }>) {
    const a = r.querySelector('a.title') ?? r.querySelector('h2 a')
    const href = a?.getAttribute('href') ?? ''
    if (!a || !/^https?:/.test(href)) continue
    out.push({ title: (a.textContent ?? '').trim(), url: href, snippet: (r.querySelector('p.s')?.textContent ?? '').trim() })
  }
  return out
}

/** A search engine's challenge, anomaly or consent page in place of results. */
const SEARCH_BLOCKED = /anomaly-modal|anomaly\.js|unusual traffic|captcha|are you a robot|verify (that )?you are (a )?human|cf-chl|challenge-form|consent\.(google|yahoo|bing)\.|before you continue to|automated (queries|requests)|bots? (use|uses) DuckDuckGo/i

/**
 * No key needed: DuckDuckGo first, then DuckDuckGo Lite, Bing and Mojeek, each with a short timeout, so
 * one engine being blocked or down on this network doesn't stop research.
 */
export async function keyless(query: string, count: number, signal: AbortSignal): Promise<Hit[]> {
  if (process.env.FOREMAN_DDG_BASE) return duckduckgo(query, count, signal, process.env.FOREMAN_DDG_BASE)
  const q = encodeURIComponent(query)
  const engines: Array<[string, string, (h: string) => Hit[]]> = [
    ['DuckDuckGo', `https://html.duckduckgo.com/html/?q=${q}`, parseDuckDuckGo],
    ['DuckDuckGo Lite', `https://lite.duckduckgo.com/lite/?q=${q}`, parseDuckDuckGoLite],
    ['Bing', `https://www.bing.com/search?q=${q}&setlang=en`, parseBing],
    ['Mojeek', `https://www.mojeek.com/search?q=${q}`, parseMojeek]
  ]
  const errors: string[] = []
  for (const [name, url, parse] of engines) {
    if (signal.aborted) throw new DOMException('stopped', 'AbortError')
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html', 'accept-language': 'en-US,en;q=0.9' }, signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) })
      if (!res.ok) { errors.push(`${name}: ${res.status}`); continue }
      const body = await res.text()
      const hits = parse(body)
      if (hits.length) return hits.slice(0, count)
      // An anti-bot or consent page parses to nothing too (DuckDuckGo serves its with HTTP 202): that engine is blocked, not empty.
      errors.push(`${name}: ${res.status === 202 || SEARCH_BLOCKED.test(body) ? 'blocked' : 'no results'}`)
    } catch (e) {
      if (signal.aborted) throw e
      errors.push(`${name}: ${(e as Error).name === 'TimeoutError' ? 'timed out' : 'unreachable'}`)
    }
  }
  // An engine answered with a real, empty results page: that's "no results", not "search is down".
  if (errors.some((e) => e.endsWith(': no results'))) return []
  throw new Error(`Web search isn't reachable from this network right now (${errors.join('; ')}). Open well-known pages directly with fetch_page instead (the official site, or Wikipedia), and tell the user search was unavailable.`)
}

export function parseDuckDuckGo(html: string): Hit[] {
  const { document } = parseHTML(html)
  const out: Hit[] = []
  for (const r of Array.from(document.querySelectorAll('.result')) as Array<{ querySelector(s: string): { textContent: string | null; getAttribute(n: string): string | null } | null }>) {
    const a = r.querySelector('.result__a')
    if (!a) continue
    let href = a.getAttribute('href') ?? ''
    const m = href.match(/[?&]uddg=([^&]+)/)
    if (m) href = decodeURIComponent(m[1])
    if (href.startsWith('//')) href = `https:${href}`
    if (!/^https?:/.test(href) || /duckduckgo\.com\/y\.js/.test(href)) continue
    out.push({ title: (a.textContent ?? '').trim(), url: href, snippet: (r.querySelector('.result__snippet')?.textContent ?? '').trim() })
  }
  return out
}

/** Status codes sites use to turn automated readers away. */
const BLOCKED_STATUS = new Set([401, 403, 429, 503])

/** A bot wall or challenge page served in place of the real one (short, and says so). */
export function isChallengePage(title: string, text: string): boolean {
  if (text.length > 1500) return false
  const rx = /just a moment|attention required|access denied|verify (that )?you are (a )?human|are you a robot|captcha|enable javascript( and cookies)? to continue|unusual traffic|checking your browser|request blocked|bot detection|press (&|and) hold/i
  // Short, says so, and has no real paragraph (a short article about "access denied" errors is a page).
  return rx.test(`${title}\n${text}`) && !text.split(/\n+/).some((l) => l.trim().length > 280)
}

export function botWall(url: string, why: string): string {
  let host = url
  try { host = new URL(url).hostname.replace(/^www\./, '') } catch { /* keep the url */ }
  // 503 is also an ordinary outage.
  if (/\b503\b/.test(why)) return `${host} is unavailable or blocking automated reading (${why}). Don't retry it now: use another result from web_search or another reputable site for the same information. Tell the user in one sentence which site didn't load and what you used instead.`
  return `${host} blocks automated reading (${why}, a bot wall). Don't retry it: use another result from web_search or another reputable site for the same information, or open it with the browser tool only if the user needs that exact site. Never try to get past a CAPTCHA. Tell the user in one sentence which site blocked you and what you used instead.`
}

/** Extracts readable text from HTML with Readability, falling back to body text. */
export function readable(html: string, url: string): { title: string; text: string } {
  const { document } = parseHTML(html)
  try {
    const article = new Readability(document as unknown as Document, { charThreshold: 200 }).parse()
    if (article?.textContent && article.textContent.trim().length > 200) {
      return { title: article.title ?? url, text: tidy(article.textContent) }
    }
  } catch {
    /* fall through */
  }
  try {
    const { document: d2 } = parseHTML(html)
    d2.querySelectorAll('script,style,noscript,svg,nav,footer').forEach((n: { remove(): void }) => n.remove())
    return { title: d2.title || url, text: tidy(d2.body?.textContent ?? '') }
  } catch {
    // Markup the parser can't build a document from: plain text is still better than an error.
    return { title: url, text: tidy(html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')) }
  }
}

function tidy(t: string): string {
  return t.replace(/[ \t ]+/g, ' ').replace(/\n\s*\n\s*/g, '\n\n').trim()
}

export function chunk(text: string, size = CHUNK_CHARS): string[] {
  const out: string[] = []
  let rest = text
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size)
    if (cut < size * 0.5) cut = rest.lastIndexOf('. ', size) + 1
    if (cut <= 0) cut = size
    out.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut)
  }
  if (rest.trim()) out.push(rest.trim())
  return out.length ? out : ['']
}

export function webTools(getConfig: () => SearchConfig): ToolDef[] {
  const pages = new Map<string, { title: string; chunks: string[] }>()

  const webSearch: ToolDef<{ query: string; count?: number }> = {
    name: 'web_search',
    label: 'Web search',
    core: true,
    effect: 'read',
    untrusted: true,
    description: 'Search the web. Returns titles, URLs and snippets. Follow up with fetch_page to read a result.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        count: { type: 'integer', minimum: 1, maximum: 10, default: 6 }
      },
      required: ['query'],
      additionalProperties: false
    },
    async run({ query, count = 6 }, ctx) {
      const c = getConfig()
      let hits: Hit[]
      const provider = c.provider === 'auto' ? (c.braveKey ? 'brave' : c.searxngUrl ? 'searxng' : 'duckduckgo') : c.provider
      if (provider === 'brave') {
        if (!c.braveKey) throw new Error('Brave Search is selected but no API key is saved. Ask the user to add it in Settings > Web search.')
        hits = await brave(query, count, c.braveKey, ctx.signal)
      } else if (provider === 'searxng') {
        if (!c.searxngUrl) throw new Error('SearXNG is selected but no URL is set. Ask the user to set it in Settings > Web search.')
        hits = await searxng(query, count, c.searxngUrl, ctx.signal)
      } else if (provider === 'duckduckgo') {
        hits = await keyless(query, count, ctx.signal)
      } else {
        throw new Error('Web search is turned off. Ask the user to turn it on in Settings > Web search, or use the browser tool instead.')
      }
      if (!hits.length) return { text: `No results for "${query}". Try 1-2 differently worded or broader queries (drop quotes and filters). If there's still nothing, tell the user nothing reliable turned up and what you searched; don't guess.`, display: `"${query}" · no results` }
      const text = hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join('\n') +
        '\n\nSnippets can be outdated or misleading: open the most relevant 1-3 results with fetch_page before relying on them.'
      return { text, display: `"${query}" · ${hits.length} results`, sources: hits.slice(0, count).map((h) => ({ title: h.title, url: h.url })) }
    }
  }

  const fetchPage: ToolDef<{ url: string; chunk?: number }> = {
    name: 'fetch_page',
    label: 'Read page',
    core: true,
    effect: 'read',
    untrusted: true,
    description: 'Fetch a web page and return its readable text in ~1.5k-token chunks. Start with chunk 1; the result says how many chunks there are. For pages that need login or clicking, use the browser tool instead.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', pattern: '^https?://' },
        chunk: { type: 'integer', minimum: 1, default: 1 }
      },
      required: ['url'],
      additionalProperties: false
    },
    async run({ url, chunk: n = 1 }, ctx) {
      let page = pages.get(url)
      if (!page) {
        const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5' }, redirect: 'follow', signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(20_000)]) })
        if (BLOCKED_STATUS.has(res.status)) throw new Error(botWall(url, `HTTP ${res.status}`))
        if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}${res.status === 404 ? '. Don\'t guess addresses: find the right page with web_search first.' : ''}`)
        const type = res.headers.get('content-type') ?? ''
        if (/pdf|image|audio|video|octet-stream|zip/.test(type)) throw new Error(`${url} is ${type}, not a web page.`)
        const body = await res.text()
        const r = /html/.test(type) || /^\s*</.test(body) ? readable(body, res.url) : { title: url, text: body }
        if (isChallengePage(r.title, r.text)) throw new Error(botWall(url, 'a "verify you are human" page'))
        page = { title: r.title, chunks: chunk(r.text) }
        pages.set(url, page)
        if (pages.size > 30) pages.delete(pages.keys().next().value!)
      }
      const total = page.chunks.length
      const i = Math.min(Math.max(1, n), total)
      const host = new URL(url).hostname
      const next = i < total ? `\n\n[Chunk ${i} of ${total}. Call fetch_page with chunk=${i + 1} for more.]` : `\n\n[Chunk ${i} of ${total}. End of page.]`
      return { text: `# ${page.title}\n${url}\n\n${page.chunks[i - 1]}${next}`, display: `${host}${total > 1 ? ` · part ${i}/${total}` : ''}`, sources: [{ title: page.title, url }], read: true }
    }
  }

  return [webSearch, fetchPage]
}
