// A tiny, forgiving XML reader for the Office Open XML parts we inspect (document.xml, slideN.xml,
// chartN.xml). No DTDs, no namespaces resolution: element names keep their prefix ("w:p", "a:t").

export interface XNode {
  name: string
  attrs: Record<string, string>
  children: XNode[]
  /** Text directly inside this element (decoded). */
  text: string
  parent?: XNode
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : m
    }
    return ENT[e.toLowerCase()] ?? m
  })
}

export function parseXml(xml: string): XNode {
  const root: XNode = { name: '#root', attrs: {}, children: [], text: '' }
  let cur = root
  const re = /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|([^<]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    if (m[6] !== undefined) { cur.text += decodeXml(m[6]); continue }
    if (m[5] !== undefined) { cur.text += m[5]; continue }
    if (!m[2]) continue
    if (m[1]) {
      // Close: walk up to the matching element (tolerates stray tags).
      let n: XNode | undefined = cur
      while (n && n.name !== m[2]) n = n.parent
      if (n?.parent) cur = n.parent
      continue
    }
    const attrs: Record<string, string> = {}
    for (const a of m[3].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decodeXml(a[2] ?? a[3] ?? '')
    const node: XNode = { name: m[2], attrs, children: [], text: '', parent: cur }
    cur.children.push(node)
    if (!m[4]) cur = node
  }
  return root
}

/** Every descendant (depth first) named `name`. */
export function all(n: XNode, name: string, out: XNode[] = []): XNode[] {
  for (const c of n.children) {
    if (c.name === name) out.push(c)
    all(c, name, out)
  }
  return out
}

/** The first descendant named `name`. */
export function first(n: XNode, name: string): XNode | undefined {
  for (const c of n.children) {
    if (c.name === name) return c
    const f = first(c, name)
    if (f) return f
  }
  return undefined
}

/** A direct child named `name`. */
export function child(n: XNode, name: string): XNode | undefined {
  return n.children.find((c) => c.name === name)
}

/** All text of the `tag` elements under n (w:t for Word, a:t for slides), joined. */
export function textOf(n: XNode, tag: string): string {
  return all(n, tag).map((t) => t.text).join('')
}

/** True when n sits inside an element named `name`. */
export function within(n: XNode, name: string): boolean {
  for (let p = n.parent; p; p = p.parent) if (p.name === name) return true
  return false
}
