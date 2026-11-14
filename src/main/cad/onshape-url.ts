// Onshape document references: a browser URL like
//   https://cad.onshape.com/documents/<did>/w/<wid>/e/<eid>
// (w = workspace, v = version, m = microversion; every id is 24 hex characters), or the ids given one
// by one. Enterprise stacks use https://<company>.onshape.com. API keys only work on the stack where
// they were made, so requests go to the host the URL names (always an onshape.com host, over HTTPS).

export type Wvm = 'w' | 'v' | 'm'

export interface DocRef {
  did: string
  wvm?: Wvm
  wvmid?: string
  eid?: string
  /** https://cad.onshape.com, or an enterprise https://<company>.onshape.com. */
  origin?: string
}

export const DEFAULT_ORIGIN = 'https://cad.onshape.com'
const ID = /^[0-9a-f]{24}$/i

export const isOnshapeId = (s: unknown): s is string => typeof s === 'string' && ID.test(s)

/** An https origin on onshape.com (cad.onshape.com or a company stack); anything else is null. */
export function onshapeOrigin(host: string): string | null {
  const h = host.toLowerCase()
  if (h === 'onshape.com' || !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.onshape\.com$/.test(h)) return null
  return `https://${h}`
}

/**
 * Ids from an Onshape document URL. Returns null for anything that isn't one (a non-onshape host, no
 * /documents/<did>, malformed ids). Query strings and fragments are ignored.
 */
export function parseOnshapeUrl(raw: string): DocRef | null {
  const s = raw.trim()
  let u: URL
  try { u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`) } catch { return null }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  const origin = onshapeOrigin(u.hostname)
  if (!origin) return null
  const parts = u.pathname.split('/').filter(Boolean)
  const at = parts.indexOf('documents')
  if (at < 0) return null
  const rest = parts.slice(at + 1)
  // Some links use /documents/d/<did>/...; skip the "d".
  if (rest[0] === 'd' && isOnshapeId(rest[1])) rest.shift()
  const did = rest[0]
  if (!isOnshapeId(did)) return null
  const ref: DocRef = { did: did.toLowerCase(), origin }
  const kind = rest[1]
  if (kind === 'w' || kind === 'v' || kind === 'm') {
    if (!isOnshapeId(rest[2])) return null
    ref.wvm = kind
    ref.wvmid = rest[2].toLowerCase()
    if (rest[3] === 'e') {
      if (!isOnshapeId(rest[4])) return null
      ref.eid = rest[4].toLowerCase()
    }
  }
  return ref
}

/** The browser URL for a reference (for showing to the user). */
export function onshapeUrl(r: DocRef): string {
  let s = `${r.origin ?? DEFAULT_ORIGIN}/documents/${r.did}`
  if (r.wvm && r.wvmid) s += `/${r.wvm}/${r.wvmid}`
  if (r.wvm && r.wvmid && r.eid) s += `/e/${r.eid}`
  return s
}

export interface RefArgs {
  url?: string
  document_id?: string
  workspace_id?: string
  version_id?: string
  element_id?: string
}

/**
 * The reference a tool call names: a URL, separate ids, or both (separate ids fill in or override what
 * the URL lacks). Throws with a plain explanation when something is malformed.
 */
export function refFromArgs(a: RefArgs): DocRef {
  let ref: DocRef | null = null
  if (a.url) {
    ref = parseOnshapeUrl(a.url)
    if (!ref) throw new Error(`"${a.url.slice(0, 200)}" is not an Onshape document URL. Expected https://cad.onshape.com/documents/<document id>/w/<workspace id>/e/<element id> (copy it from the browser's address bar with the tab open).`)
  }
  const check = (v: string | undefined, what: string): string | undefined => {
    if (v === undefined || v === '') return undefined
    if (!ID.test(v)) throw new Error(`${what} "${v.slice(0, 60)}" is not an Onshape id (24 hex characters).`)
    return v.toLowerCase()
  }
  const did = check(a.document_id, 'document_id')
  const wid = check(a.workspace_id, 'workspace_id')
  const vid = check(a.version_id, 'version_id')
  const eid = check(a.element_id, 'element_id')
  if (wid && vid) throw new Error('Give workspace_id or version_id, not both.')
  if (!ref) {
    if (!did) throw new Error('Name the Onshape document: pass url (the document URL from the browser) or document_id.')
    ref = { did, origin: DEFAULT_ORIGIN }
  } else if (did && did !== ref.did) {
    throw new Error('document_id does not match the document in url.')
  }
  if (wid) { ref.wvm = 'w'; ref.wvmid = wid }
  if (vid) { ref.wvm = 'v'; ref.wvmid = vid }
  if (eid) ref.eid = eid
  return ref
}

/** "d/<did>/<wvm>/<wvmid>" for API paths. */
export const dwvm = (r: DocRef): string => `d/${r.did}/${r.wvm}/${r.wvmid}`
/** "d/<did>/<wvm>/<wvmid>/e/<eid>" for API paths. */
export const dwvme = (r: DocRef): string => `${dwvm(r)}/e/${r.eid}`
