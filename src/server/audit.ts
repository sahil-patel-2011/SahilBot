// The remote-access audit log: one JSON line per event (pairing, sign-ins, sessions, revocations,
// consequential calls). Rotated at 5 MB, keeping one old file. Never holds tokens, codes or secrets.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

export type AuditKind =
  | 'server.start' | 'server.stop'
  | 'pair.code' | 'pair.ok' | 'pair.fail' | 'pair.limited'
  | 'auth.fail' | 'origin.denied' | 'host.denied'
  | 'session.open' | 'session.close'
  | 'device.revoke' | 'device.rename'
  | 'call.denied' | 'call.approval'

export interface AuditEntry {
  at: string
  kind: AuditKind
  ip?: string
  device?: string
  detail?: string
}

const MAX_BYTES = 5 * 1024 * 1024

export class AuditLog {
  constructor(private file: string, private echo: (line: string) => void = () => undefined) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  }

  write(kind: AuditKind, e: Omit<AuditEntry, 'at' | 'kind'> = {}): void {
    const entry: AuditEntry = { at: new Date().toISOString(), kind, ...e }
    if (entry.detail) entry.detail = entry.detail.slice(0, 300)
    try {
      if (existsSync(this.file) && statSync(this.file).size > MAX_BYTES) renameSync(this.file, `${this.file}.1`)
      appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
    } catch (err) { console.error('[audit]', (err as Error).message) }
    this.echo(`${entry.kind}${entry.device ? ` device=${entry.device}` : ''}${entry.ip ? ` ip=${entry.ip}` : ''}${entry.detail ? ` ${entry.detail}` : ''}`)
  }

  /** The newest entries first. */
  recent(limit = 200): AuditEntry[] {
    const lines: string[] = []
    for (const f of [this.file, `${this.file}.1`]) {
      if (lines.length >= limit || !existsSync(f)) continue
      lines.push(...readFileSync(f, 'utf8').split('\n').filter(Boolean).reverse())
    }
    return lines.slice(0, limit).flatMap((l) => { try { return [JSON.parse(l) as AuditEntry] } catch { return [] } })
  }
}
