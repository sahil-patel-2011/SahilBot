// Inline Markdown for document text: **bold**, *italic* / _italic_, `code`, ~~strike~~, [text](url) and
// backslash escapes. Pure (no DOM, no Node): the editor in the renderer imports it too.

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** Characters a backslash can escape in document text. */
const ESCAPABLE = /[\\`*_[\]()~#>!|-]/

/** Only web and mail links become live links; anything else (javascript:, file:) stays plain text. */
export function safeHref(url: string): string | null {
  const u = url.trim()
  return /^(https?:\/\/|mailto:)/i.test(u) ? u : null
}

type Node =
  | { k: 'text'; s: string }
  | { k: 'code'; s: string }
  | { k: 'strong' | 'em' | 'del'; c: Node[] }
  | { k: 'link'; href: string; c: Node[] }

/** Index of the next unescaped `delim` at or after `from`, or -1. */
function findClose(s: string, delim: string, from: number): number {
  for (let i = from; i <= s.length - delim.length; i++) {
    if (s[i] === '\\') { i++; continue }
    if (s.startsWith(delim, i)) return i
  }
  return -1
}

function parse(s: string, depth = 0): Node[] {
  const out: Node[] = []
  let buf = ''
  const flush = (): void => { if (buf) { out.push({ k: 'text', s: buf }); buf = '' } }
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\\' && i + 1 < s.length && ESCAPABLE.test(s[i + 1])) { buf += s[i + 1]; i++; continue }
    if (depth < 8) {
      if (ch === '`') {
        let n = 1
        while (s[i + n] === '`') n++
        const fence = '`'.repeat(n)
        const end = s.indexOf(fence, i + n)
        if (end > i + n - 1 && end !== -1) {
          flush()
          out.push({ k: 'code', s: s.slice(i + n, end) })
          i = end + n - 1
          continue
        }
      }
      if (s.startsWith('**', i) || s.startsWith('__', i)) {
        const d = s.slice(i, i + 2)
        const end = findClose(s, d, i + 2)
        if (end > i + 2 && s[i + 2] !== ' ') {
          flush()
          out.push({ k: 'strong', c: parse(s.slice(i + 2, end), depth + 1) })
          i = end + 1
          continue
        }
      }
      if (s.startsWith('~~', i)) {
        const end = findClose(s, '~~', i + 2)
        if (end > i + 2) {
          flush()
          out.push({ k: 'del', c: parse(s.slice(i + 2, end), depth + 1) })
          i = end + 1
          continue
        }
      }
      if ((ch === '*' || ch === '_') && s[i + 1] !== ' ' && s[i + 1] !== ch) {
        // _ only opens at a word start (snake_case stays as is).
        const okOpen = ch === '*' || i === 0 || !/[\p{L}\p{N}]/u.test(s[i - 1])
        let end = okOpen ? findClose(s, ch, i + 1) : -1
        // `**` inside an em run is a strong run, not the end.
        while (end !== -1 && s[end + 1] === ch) end = findClose(s, ch, end + 2)
        if (end > i + 1 && s[end - 1] !== ' ' && (ch === '*' || end + 1 >= s.length || !/[\p{L}\p{N}]/u.test(s[end + 1]))) {
          flush()
          out.push({ k: 'em', c: parse(s.slice(i + 1, end), depth + 1) })
          i = end
          continue
        }
      }
      if (ch === '[') {
        const close = findClose(s, ']', i + 1)
        if (close !== -1 && s[close + 1] === '(') {
          // The URL may hold balanced parentheses.
          let paren = -1
          for (let k = close + 2, depthP = 0; k < s.length; k++) {
            if (s[k] === '\\') { k++; continue }
            if (s[k] === '(') depthP++
            else if (s[k] === ')') { if (depthP === 0) { paren = k; break } depthP-- }
          }
          if (paren !== -1) {
            flush()
            out.push({ k: 'link', href: s.slice(close + 2, paren).trim(), c: parse(s.slice(i + 1, close), depth + 1) })
            i = paren
            continue
          }
        }
      }
    }
    buf += ch
  }
  flush()
  return out
}

function html(nodes: Node[]): string {
  return nodes.map((n) => {
    switch (n.k) {
      case 'text': return escapeHtml(n.s).replace(/\n/g, '<br>')
      case 'code': return `<code>${escapeHtml(n.s)}</code>`
      case 'strong': return `<strong>${html(n.c)}</strong>`
      case 'em': return `<em>${html(n.c)}</em>`
      case 'del': return `<s>${html(n.c)}</s>`
      case 'link': {
        const href = safeHref(n.href)
        return href ? `<a href="${escapeHtml(href)}">${html(n.c)}</a>` : html(n.c)
      }
    }
  }).join('')
}

function plain(nodes: Node[]): string {
  return nodes.map((n) => (n.k === 'text' || n.k === 'code' ? n.s : plain(n.c))).join('')
}

/** Inline Markdown → safe HTML (escaped text; only http(s)/mailto links). */
export function inlineToHtml(md: string): string {
  return html(parse(md ?? ''))
}

/** Inline Markdown → plain text (for summaries, search and previews). */
export function inlinePlain(md: string): string {
  return plain(parse(md ?? ''))
}

/** Escapes text so it reads back as itself (used when the editor serializes typed text). */
export function escapeInline(text: string): string {
  return text.replace(/[\\`*_[\]~]/g, (c) => `\\${c}`)
}

/** A short one-line preview of inline Markdown, e.g. for version summaries. */
export function preview(md: string, max = 48): string {
  const t = inlinePlain(md).replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}
