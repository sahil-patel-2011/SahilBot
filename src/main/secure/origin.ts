import { isPublicSuffix, registrableDomain } from '../psl'

export function normalizeOrigin(s: string): string {
  const t = String(s ?? '').trim()
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(t) ? t : `https://${t}`)
    if (!/^https?:$/.test(u.protocol) || !u.hostname) throw new Error('bad')
    return u.origin
  } catch {
    throw new Error(`"${s}" is not a valid site`)
  }
}

/**
 * Whether a saved item's site matches a page. Exact origin (scheme, host and port) by default. With
 * `subdomains` (opted into per item), a page on a subdomain of the saved host also matches
 * (login.example.com for example.com), but never across a public suffix: a login saved for github.io
 * or vercel.app never matches someone's alice.github.io, and the page must share the saved host's
 * registrable domain (Public Suffix List).
 */
export function originMatches(saved: string, pageUrl: string, o: { subdomains?: boolean } = {}): boolean {
  try {
    const a = new URL(saved), b = new URL(pageUrl)
    if (!/^https?:$/.test(a.protocol) || a.protocol !== b.protocol) return false
    if (a.port !== b.port) return false
    if (b.hostname === a.hostname) return true
    if (!o.subdomains) return false
    if (!b.hostname.endsWith(`.${a.hostname}`)) return false
    if (isPublicSuffix(a.hostname)) return false
    const reg = registrableDomain(a.hostname)
    return !!reg && reg.includes('.') && registrableDomain(b.hostname) === reg
  } catch {
    return false
  }
}

/** Loopback hosts count as secure (browsers treat them as secure contexts): the only http pages a value may go to. */
export function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h)
}

/** HTTPS, or http on this Mac's own loopback address. */
export function isSecurePage(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || (u.protocol === 'http:' && isLoopback(u.hostname))
  } catch {
    return false
  }
}

export function originOfUrl(url: string): string {
  try { return new URL(url).origin } catch { return '' }
}

/** Same site (registrable domain), for a form that sends to another host of the same company. */
export function sameSiteUrls(a: string, b: string): boolean {
  try {
    const x = new URL(a), y = new URL(b)
    if (x.hostname === y.hostname) return true
    const rx = registrableDomain(x.hostname), ry = registrableDomain(y.hostname)
    return !!rx && rx === ry && rx.includes('.')
  } catch {
    return false
  }
}
