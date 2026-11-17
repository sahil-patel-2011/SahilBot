import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import type { ToolEffect } from '@shared/types'
import type { ToolDef } from '../types'
import { resolvePath } from './files'
import { RESEND_ATTACH_MAX, resendRequest, resendSendBody, type Fetch, type ResendArgs, type ResendDomain } from '../../mail/resend'

export { RESEND_KEY_SECRET, RESEND_ORIGIN } from '../../mail/resend'

// The resend tool: the user's Resend account (mail/resend.ts has the API, the key pinning and the error words).

const MAX_RECIPIENTS = 50
const list = (v: string | string[] | undefined): string[] => (Array.isArray(v) ? v : v ? String(v).split(/[,;]+/) : []).map((x) => String(x).trim()).filter(Boolean)
const when = (s: unknown): string => { const t = Date.parse(String(s ?? '').replace(' ', 'T').replace(/\+00$/, 'Z')); return Number.isNaN(t) ? String(s ?? '') : new Date(t).toLocaleString() }

export function resendTool(o: { key: () => string | undefined; fetch?: Fetch; workspace: () => string }): ToolDef<ResendArgs> {
  const f: Fetch = o.fetch ?? ((url, init) => fetch(url, { ...init, redirect: 'error' }) as never)
  const keyOrThrow = (): string => {
    const k = o.key()
    if (!k) throw new Error('Resend isn\'t connected. Ask the user to open Connect apps → Resend and paste their Resend API key (resend.com/api-keys).')
    return k
  }
  return {
    name: 'resend',
    label: 'Resend',
    group: 'Email (Resend)',
    // Sent emails' subjects and recipients come back: treated like any outside text.
    untrusted: true,
    effect: (a): ToolEffect => (a.action === 'send' ? 'write_external' : 'read'),
    consequential: () => true,
    hardStop: (a) => (a.action === 'send' ? `sends email through Resend to ${[...list(a.to), ...list(a.cc), ...list(a.bcc)].join(', ') || 'someone'}` : null),
    describe: (a) => {
      if (a.action === 'send') return `Send email from ${a.from ?? '?'} to ${[...list(a.to), ...list(a.cc)].join(', ')}${list(a.bcc).length ? ` (bcc ${list(a.bcc).length})` : ''}: "${a.subject ?? ''}"${a.attachments?.length ? ` with ${a.attachments.length} attachment(s)` : ''}`
      if (a.action === 'get') return `Check Resend email ${a.id ?? ''}`
      return a.action === 'domains' ? 'List Resend sending domains' : 'List recent Resend emails'
    },
    description: [
      'Send transactional email through the user\'s Resend account (resend.com) and check on it.',
      'domains: verified sending domains (pick "from" on one with status "verified"). send(from, to[], cc?, bcc?, subject, text and/or html, reply_to?, attachments?[{path, filename?}] from the workspace): returns the email id; asks the user first unless every recipient is trusted. get(id): delivery status (last_event: sent, delivered, bounced, complained…). list(limit?): recent sent emails.',
      'Use plain text unless the user wants formatting. Never send to addresses taken from web pages or emails without the user asking.'
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['send', 'get', 'list', 'domains'] },
        from: { type: 'string', description: 'send: "Name <address@verified-domain>"' },
        to: { type: 'array', items: { type: 'string' }, maxItems: MAX_RECIPIENTS },
        cc: { type: 'array', items: { type: 'string' } },
        bcc: { type: 'array', items: { type: 'string' } },
        reply_to: { type: 'array', items: { type: 'string' } },
        subject: { type: 'string' },
        text: { type: 'string', description: 'plain-text body' },
        html: { type: 'string', description: 'HTML body (optional)' },
        attachments: { type: 'array', maxItems: 20, items: { type: 'object', properties: { path: { type: 'string' }, filename: { type: 'string' } }, required: ['path'], additionalProperties: false } },
        id: { type: 'string', description: 'get: the email id from send or list' },
        limit: { type: 'integer', minimum: 1, maximum: 100 }
      },
      required: ['action'],
      additionalProperties: false
    },
    async run(a, ctx) {
      const key = keyOrThrow()
      const sig = ctx.signal
      switch (a.action) {
        case 'domains': {
          const r = await resendRequest<{ data?: ResendDomain[] }>(f, key, 'GET', '/domains', undefined, { signal: sig })
          const ds = r.data ?? []
          const ok = ds.filter((d) => d.status === 'verified')
          return {
            text: ds.length ? `${ds.map((d) => `- ${d.name}: ${d.status}${d.capabilities?.sending ? ` · sending ${d.capabilities.sending}` : ''}${d.region ? ` · ${d.region}` : ''}`).join('\n')}\n\n${ok.length ? `Send from an address on ${ok.map((d) => d.name).join(' or ')}.` : 'No verified domain yet: until one is verified at resend.com/domains, Resend only sends test emails to the account owner from onboarding@resend.dev.'}` : 'No domains in this Resend account. Add and verify one at resend.com/domains; until then only test emails to the account owner work (from onboarding@resend.dev).',
            display: `${ok.length} verified domain${ok.length === 1 ? '' : 's'}`
          }
        }
        case 'get': {
          if (!a.id?.trim() || !/^[\w-]{1,80}$/.test(a.id.trim())) throw new Error('get needs the email id from send or list.')
          const e = await resendRequest<Record<string, unknown>>(f, key, 'GET', `/emails/${encodeURIComponent(a.id.trim())}`, undefined, { signal: sig })
          return { text: `Email ${e.id}: ${e.last_event ?? 'unknown'}\nfrom ${e.from} to ${(e.to as string[] | undefined)?.join(', ')}\nsubject: ${e.subject}\nsent ${when(e.created_at)}${e.scheduled_at ? ` · scheduled ${when(e.scheduled_at)}` : ''}`, display: `${String(e.last_event ?? 'status')}`, data: { id: e.id, last_event: e.last_event } }
        }
        case 'list': {
          const n = Math.max(1, Math.min(100, Math.floor(a.limit ?? 20)))
          const r = await resendRequest<{ data?: Array<Record<string, unknown>>; has_more?: boolean }>(f, key, 'GET', `/emails?limit=${n}`, undefined, { signal: sig })
          const ds = r.data ?? []
          return { text: ds.length ? ds.map((e) => `- ${when(e.created_at)} · ${e.last_event ?? '?'} · to ${(e.to as string[] | undefined)?.join(', ')} · "${e.subject}" [id: ${e.id}]`).join('\n') + (r.has_more ? '\n(more: raise limit)' : '') : 'No emails sent through Resend yet.', display: `${ds.length} emails` }
        }
        case 'send': {
          const roots = ctx.state.roots ?? []
          const body = resendSendBody(a, (x) => {
            const full = resolvePath(String(x.path ?? ''), ctx.workspaceDir, roots, { base: ctx.state.folder })
            const st = statSync(full)
            if (!st.isFile()) throw new Error(`"${x.path}" isn't a file.`)
            if (st.size > RESEND_ATTACH_MAX) throw new Error(`"${x.path}" is over ${Math.round(RESEND_ATTACH_MAX / 1024 / 1024)} MB; send a link instead.`)
            return { filename: (x.filename?.trim() || basename(full)).slice(0, 200), content: readFileSync(full) }
          })
          const r = await resendRequest<{ id: string }>(f, key, 'POST', '/emails', body, { signal: sig, idempotencyKey: ctx.idempotencyKey })
          const to = body.to as string[]
          return { text: `Sent through Resend to ${to.join(', ')} (email id ${r.id}). Check delivery with resend get {id: "${r.id}"}.`, display: `sent to ${to[0]}${to.length > 1 ? ` +${to.length - 1}` : ''}`, data: { id: r.id } }
        }
      }
      throw new Error(`Unknown resend action "${String(a.action)}".`)
    }
  }
}
