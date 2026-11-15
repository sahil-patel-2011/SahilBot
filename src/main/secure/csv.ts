// Import from a password manager's CSV export (Chrome, Safari, 1Password, Bitwarden, LastPass, Firefox
// and Dashlane use the same few column names). The file is plain text: the UI tells the user to delete
// it afterwards.

/** RFC 4180 CSV: quoted fields, doubled quotes, newlines inside quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const s = String(text ?? '').replace(/^﻿/, '')
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else field += c
      continue
    }
    if (c === '"' && field === '') { quoted = true; continue }
    if (c === ',') { row.push(field); field = ''; continue }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.some((x) => x !== '')) rows.push(row)
      row = []
      continue
    }
    field += c
  }
  row.push(field)
  if (row.some((x) => x !== '')) rows.push(row)
  return rows
}

export interface CsvLogin { title: string; url: string; username: string; password: string; totp?: string; note?: string }

const COLS: Record<keyof CsvLogin, string[]> = {
  title: ['name', 'title', 'account', 'item name'],
  url: ['url', 'login_uri', 'website', 'web site', 'login url', 'uri', 'hostname', 'origin'],
  username: ['username', 'login_username', 'login', 'user', 'email', 'user name', 'login name'],
  password: ['password', 'login_password', 'pass'],
  totp: ['totp', 'otpauth', 'login_totp', 'otp', 'one-time password', 'otpurl', 'otp secret'],
  note: ['note', 'notes', 'extra', 'comments']
}

/** Logins from a CSV export. Rows without a site or password are skipped (and counted). */
export function loginsFromCsv(text: string): { logins: CsvLogin[]; skipped: number } {
  const rows = parseCsv(text)
  if (rows.length < 2) return { logins: [], skipped: 0 }
  const head = rows[0].map((h) => h.trim().toLowerCase())
  const col = (k: keyof CsvLogin): number => { for (const n of COLS[k]) { const i = head.indexOf(n); if (i >= 0) return i } return -1 }
  const idx = Object.fromEntries((Object.keys(COLS) as Array<keyof CsvLogin>).map((k) => [k, col(k)])) as Record<keyof CsvLogin, number>
  if (idx.password < 0 || idx.url < 0) throw new Error('That CSV has no "url" and "password" columns. Export logins from your password manager as CSV and try again.')
  const logins: CsvLogin[] = []
  let skipped = 0
  for (const r of rows.slice(1)) {
    const get = (k: keyof CsvLogin): string => (idx[k] >= 0 ? String(r[idx[k]] ?? '').trim() : '')
    const url = get('url'), password = idx.password >= 0 ? String(r[idx.password] ?? '') : ''
    if (!url || !password || !/^(https?:\/\/)?[\w.-]+\.[a-z]{2,}|^https?:\/\/(localhost|127\.)/i.test(url)) { skipped++; continue }
    logins.push({ title: get('title'), url, username: get('username'), password, ...(get('totp') ? { totp: get('totp') } : {}), ...(get('note') ? { note: get('note') } : {}) })
  }
  return { logins, skipped }
}
