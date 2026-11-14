import { createHmac, randomBytes } from 'node:crypto'

// Onshape API-key request signing, as documented at https://onshape-public.github.io/docs/auth/apikeys/
// ("Request Signature"). The string to sign is, lowercased and newline-separated:
//   method, On-Nonce, Date, Content-Type, URL path, URL query string, and a trailing newline
// (the trailing "\n" is in Onshape's own Node sample; the prose list omits it, the sample wins).
// The signature is base64(HMAC-SHA256(secretKey, string)), sent as
//   Authorization: On <accessKey>:HmacSHA256:<signature>
// together with the Date (within 5 minutes of Onshape's clock) and On-Nonce headers it was made with.
// A 307 redirect must be signed again for the new URL (its server and query can differ).

export interface SignInput {
  method: string
  /** The full request URL (path and query are what get signed). */
  url: string
  nonce: string
  /** An RFC 7231 date, e.g. "Mon, 11 Apr 2016 20:08:56 GMT". */
  date: string
  contentType: string
  accessKey: string
  secretKey: string
}

/** The exact (lowercased) string Onshape signs for a request. */
export function stringToSign(i: Pick<SignInput, 'method' | 'url' | 'nonce' | 'date' | 'contentType'>): string {
  const u = new URL(i.url)
  const query = u.search.startsWith('?') ? u.search.slice(1) : u.search
  return `${i.method}\n${i.nonce}\n${i.date}\n${i.contentType}\n${u.pathname}\n${query}\n`.toLowerCase()
}

/** The Authorization header value: "On <accessKey>:HmacSHA256:<base64 signature>". */
export function createSignature(i: SignInput): string {
  const hmac = createHmac('sha256', i.secretKey).update(stringToSign(i)).digest('base64')
  return `On ${i.accessKey}:HmacSHA256:${hmac}`
}

/** A 25-character alphanumeric nonce (Onshape needs at least 16, alphanumeric, unique per request). */
export function makeNonce(): string {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = randomBytes(25)
  let out = ''
  for (const b of bytes) out += abc[b % abc.length]
  return out
}

/** Headers that sign one request: Date, On-Nonce, Content-Type and Authorization. */
export function signedHeaders(o: { method: string; url: string; contentType: string; accessKey: string; secretKey: string; now?: Date; nonce?: string }): Record<string, string> {
  const date = (o.now ?? new Date()).toUTCString()
  const nonce = o.nonce ?? makeNonce()
  return {
    Date: date,
    'On-Nonce': nonce,
    'Content-Type': o.contentType,
    Authorization: createSignature({ method: o.method, url: o.url, nonce, date, contentType: o.contentType, accessKey: o.accessKey, secretKey: o.secretKey })
  }
}

/** Basic authorization ("local testing only" in Onshape's docs); kept for completeness, not used by default. */
export function basicAuth(accessKey: string, secretKey: string): string {
  return `Basic ${Buffer.from(`${accessKey}:${secretKey}`).toString('base64')}`
}
