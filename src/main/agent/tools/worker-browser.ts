import { lookup } from 'node:dns/promises'
import { request as http, type IncomingMessage } from 'node:http'
import { request as https } from 'node:https'
import { BlockList, isIPv4 } from 'node:net'
import { parseHTML } from 'linkedom'
import { classify } from '../../phone/net'
import { CONSEQUENTIAL } from '../permissions'
import type { ToolDef } from '../types'
import { readable } from './web'

const MAX_BODY = 2 * 1024 * 1024
const MAX_SESSIONS = 32
const RESERVED = new BlockList()
for (const [subnet, bits] of [['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24]] as const) RESERVED.addSubnet(subnet, bits)

export const isBrowserAddress = (ip: string): boolean => isIPv4(ip) && classify(ip) === 'public' && !RESERVED.check(ip)

export function publicPageUrl(value: string): URL {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || !url.hostname.includes('.') || url.href.length > 4096) {
    throw new Error('Use a public HTTP or HTTPS page address.')
  }
  url.hash = ''
  return url
}

async function readPublicPage(raw: string, outer: AbortSignal): Promise<{ url: string; html: string }> {
  const signal = AbortSignal.any([outer, AbortSignal.timeout(15_000)])
  let url = publicPageUrl(raw)
  for (let redirects = 0; redirects <= 4; redirects++) {
    const { address } = await lookup(url.hostname, { family: 4 })
    if (!isBrowserAddress(address)) throw new Error('The worker browser only opens public websites.')
    signal.throwIfAborted()
    // Pin the connection to the address we checked. Keep the original host for TLS and Host headers.
    const res = await new Promise<IncomingMessage>((ok, fail) => {
      const req = (url.protocol === 'https:' ? https : http)(url, {
        signal, agent: false, family: 4,
        lookup: (_name, _options, callback) => callback(null, address, 4),
        headers: { Accept: 'text/html,application/xhtml+xml,text/plain', 'User-Agent': 'SahilBot Worker Browser' }
      }, ok)
      req.once('error', fail)
      req.end()
    })
    const status = res.statusCode ?? 0
    if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
      res.destroy()
      const next = publicPageUrl(new URL(res.headers.location, url).href)
      if (url.protocol === 'https:' && next.protocol !== 'https:') throw new Error('The website redirected to an insecure page.')
      url = next
      continue
    }
    if (status < 200 || status >= 300) { res.destroy(); throw new Error(`The site answered HTTP ${status}.`) }
    const type = String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    if (!['text/html', 'application/xhtml+xml', 'text/plain'].includes(type)) { res.destroy(); throw new Error('The worker browser can read HTML and plain text pages.') }
    if (Number(res.headers['content-length']) > MAX_BODY) { res.destroy(); throw new Error('The page is too large for the worker browser.') }
    const chunks: Buffer[] = []
    let size = 0
    for await (const data of res) {
      const chunk = Buffer.from(data)
      size += chunk.length
      if (size > MAX_BODY) throw new Error('The page is too large for the worker browser.')
      chunks.push(chunk)
    }
    return { url: url.href, html: Buffer.concat(chunks).toString('utf8') }
  }
  throw new Error('The website redirected too many times.')
}

type Page = { url: string; title: string; text: string; links: Array<{ ref: string; url: string; text: string }> }
type Args = { action: 'navigate' | 'snapshot' | 'follow'; url?: string; ref?: string }

/** The server's text browser. No script execution, shared cookie jar, downloads, or screen. */
export function workerBrowserTool(load = readPublicPage): ToolDef<Args> {
  const sessions = new Map<string, Page>()
  return {
    name: 'browser',
    label: 'Worker browser',
    group: 'Browser',
    core: true,
    effect: 'read',
    untrusted: true,
    description: 'Browse public pages in this worker’s background text browser. navigate opens a public HTTP(S) page. snapshot reads the current page and its numbered links. follow opens a link ref from the current page. Use connected apps for signed-in work.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['action'],
      properties: { action: { enum: ['navigate', 'snapshot', 'follow'] }, url: { type: 'string', maxLength: 4096 }, ref: { type: 'string', pattern: '^link[0-9]{1,3}$' } }
    },
    async run(a, ctx) {
      let page = sessions.get(ctx.threadId)
      if (a.action !== 'snapshot') {
        const address = a.action === 'navigate' ? a.url : page?.links.find((link) => link.ref === a.ref)?.url
        if (!address) throw new Error(a.action === 'navigate' ? 'Enter the page address.' : 'Use a link ref from the current snapshot.')
        const { url, html } = await load(publicPageUrl(address).href, ctx.signal)
        const { document } = parseHTML(html)
        const links: Page['links'] = []
        const seen = new Set<string>()
        for (const node of document.querySelectorAll('a[href]')) {
          if (links.length >= 50) break
          const text = node.textContent?.replace(/\s+/g, ' ').trim().slice(0, 100) ?? ''
          if (!text || CONSEQUENTIAL.test(text)) continue
          try {
            const href = publicPageUrl(new URL(node.getAttribute('href')!, url).href).href
            if (href === url || seen.has(href)) continue
            seen.add(href)
            links.push({ url: href, text, ref: `link${links.length + 1}` })
          } catch { /* skip non-page links */ }
        }
        const content = readable(html, url)
        page = { url, title: content.title.slice(0, 240), text: content.text.slice(0, 12_000), links }
      }
      if (!page) throw new Error('Open a page with navigate first.')
      sessions.delete(ctx.threadId)
      sessions.set(ctx.threadId, page)
      while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value!)
      const links = page.links.map((link) => `[${link.ref}] ${link.text}`).join('\n')
      return { text: `# ${page.title}\n${page.url}\n\n${page.text}${links ? `\n\nLinks\n${links}` : ''}`, display: page.title, read: true, sources: [{ title: page.title, url: page.url }] }
    }
  }
}
