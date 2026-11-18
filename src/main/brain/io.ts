import { buildSearchSpec, parseSearchRows } from '../mail/core'
import { gmailRead, gmailSearch, gmailSession, type GmailCreds } from '../mail/gmail-direct'
import type { MailRunner } from '../mail/runner'
import { SEARCH } from '../mail/scripts'
import { FullDiskAccessError, chatMessages, recentChats, withChatDb } from '../messages/chatdb'
import { clip, type BrainIO, type ConnectorIO, type RawItem } from './sources'

// The brain's live reads in the Mac app: connected apps (MCP connectors), Gmail by app password (IMAP,
// read-only: nothing is marked read), Apple Mail while it's open (never launched for this) and Messages
// (chat.db, read-only; only with the user's opt-in and Full Disk Access). Tests use fakes instead.

const secs = (t: number): number => Math.floor(t / 1000)
const FILTER = '-in:drafts -in:spam -in:chats -category:promotions -category:social -category:forums'

export interface LiveDeps {
  connectors: { presetState(p: string): 'connected' | 'needs_auth' | 'absent'; presetServerTools(p: string): string[]; callPresetTool(p: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> }
  gmailCreds: () => GmailCreds | null
  mail?: MailRunner
  /** "Mail (all your accounts)" is set up in Connect apps. */
  mailConfigured: () => boolean
}

export function liveIO(d: LiveDeps): BrainIO {
  const connectors: ConnectorIO = {
    state: (p) => d.connectors.presetState(p),
    tools: (p) => d.connectors.presetServerTools(p),
    call: (p, tool, args, signal) => d.connectors.callPresetTool(p, tool, args, signal)
  }
  let textsCheck: { at: number; v: 'ok' | 'no-access' | 'absent' } | null = null
  return {
    connectors,
    gmailImap: {
      available: () => !!d.gmailCreds(),
      async read(o) {
        const creds = d.gmailCreds()
        if (!creds) throw new Error('Gmail (app password) is not connected')
        const q = `after:${secs(o.after)}${o.before ? ` before:${secs(o.before)}` : ''} ${FILTER}`
        return gmailSession(creds, {}, async (imap, all) => {
          const rows = await gmailSearch(imap, all, q, o.limit)
          const out: RawItem[] = []
          for (const r of rows) {
            const at = Date.parse(r.date) || 0
            let text = ''
            let bulk = false
            let mid = ''
            try {
              const full = await gmailRead(imap, all, r.uid, 300_000)
              text = full?.mail.text ?? ''
              bulk = !!full?.mail.headers.has('list-unsubscribe')
              mid = full?.mail.messageId ?? ''
            } catch { /* headers only */ }
            out.push({
              source: 'gmail-imap', id: `${r.uid}:${at}`, kind: 'email', at, title: clip(r.subject, 200), from: clip(r.from, 200), to: r.to.slice(0, 10), text: clip(text), bulk, labels: r.labels,
              ...(mid ? { link: `https://mail.google.com/mail/u/0/#search/rfc822msgid%3A${encodeURIComponent(mid.replace(/^<|>$/g, ''))}` } : {})
            })
          }
          return out
        })
      },
      async count(after) {
        const creds = d.gmailCreds()
        if (!creds) return 0
        return gmailSession(creds, {}, async (imap, all) => { await imap.select(all, false); return (await imap.search(`after:${secs(after)} ${FILTER}`)).length })
      }
    },
    appleMail: {
      available: () => !!d.mail && d.mailConfigured(),
      async read(o) {
        const spec = buildSearchSpec({ since: new Date(o.after).toISOString(), ...(o.before ? { before: new Date(o.before).toISOString() } : {}), limit: Math.min(50, o.limit), snippets: true })
        // Never launches Mail: a closed Mail is just "nothing this time".
        const r = await d.mail!.call<{ rows: unknown[] }>(SEARCH, spec, { signal: o.signal, launch: false, timeoutMs: 60_000 })
        return parseSearchRows(r.rows).map((m) => ({ source: 'apple-mail', id: m.id, kind: 'email' as const, at: Date.parse(m.date) || 0, title: clip(m.subject, 200), from: clip(m.from, 200), text: clip(m.snippet ?? '') }))
      }
    },
    texts: {
      available() {
        if (textsCheck && Date.now() - textsCheck.at < 5 * 60_000) return textsCheck.v
        let v: 'ok' | 'no-access' | 'absent' = 'ok'
        try { withChatDb(() => true) } catch (e) { v = e instanceof FullDiskAccessError ? 'no-access' : 'absent' }
        textsCheck = { at: Date.now(), v }
        return v
      },
      read(o) {
        return withChatDb((db) => {
          const out: RawItem[] = []
          for (const c of recentChats(db, 40).filter((x) => x.lastAt > o.after)) {
            for (const m of chatMessages(db, [c.id], 30)) {
              if (m.fromMe || m.at <= o.after || (o.before && m.at > o.before) || !m.text.trim()) continue
              out.push({ source: 'texts', id: String(m.id), kind: 'chat', at: m.at, title: clip(c.name || m.sender, 120), from: clip(m.sender, 120), text: clip(m.text, 1200) })
            }
            if (out.length >= o.limit * 2) break
          }
          return out
        })
      }
    }
  }
}
