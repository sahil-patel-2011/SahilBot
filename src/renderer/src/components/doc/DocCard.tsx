import { useEffect, useState } from 'react'
import type { DocInfo, Message, ToolCall } from '@shared/types'
import { api } from '../../api'
import * as I from '../../icons'

export const DOC_TOOLS = ['doc_create', 'doc_edit', 'doc_export']

type DocMeta = { id: string; title: string; type: 'doc' | 'sheet'; version: number; summary: string; author: 'user' | 'bot' }

/** Documents a run made or changed, one per document (the latest call wins). */
export function docsFromSteps(steps: Array<{ call: Pick<ToolCall, 'id' | 'name'>; result?: Pick<Message, 'meta' | 'createdAt'> }>): Array<{ key: string; doc: DocMeta; at?: number; created: boolean; exported?: string }> {
  const out = new Map<string, { key: string; doc: DocMeta; at?: number; created: boolean; exported?: string }>()
  for (const s of steps) {
    if (!DOC_TOOLS.includes(s.call.name) || s.result?.meta?.status !== 'ok') continue
    const doc = s.result.meta.doc as DocMeta | undefined
    if (!doc?.id) continue
    const prev = out.get(doc.id)
    out.delete(doc.id)
    out.set(doc.id, {
      key: s.call.id, doc, at: s.result.createdAt,
      created: (prev?.created ?? false) || s.call.name === 'doc_create',
      exported: typeof s.result.meta.exported === 'string' ? s.result.meta.exported : prev?.exported
    })
  }
  return [...out.values()]
}

/** A chat's documents, kept current as documents change. */
export function useThreadDocs(threadId: string | null | undefined): DocInfo[] {
  const [docs, setDocs] = useState<DocInfo[]>([])
  useEffect(() => {
    setDocs([])
    if (!threadId) return
    let alive = true
    const load = (): void => { api.docs.list(threadId).then((xs) => { if (alive) setDocs(xs) }).catch(() => undefined) }
    load()
    const off = api.docs.onEvent((e) => { if (e.threadId === threadId) load() })
    return () => { alive = false; off() }
  }, [threadId])
  return docs
}

/** One document's info, kept current. */
export function useDocInfo(id: string): DocInfo | null | undefined {
  const [info, setInfo] = useState<DocInfo | null | undefined>(undefined)
  useEffect(() => {
    let alive = true
    const load = (): void => { api.docs.get(id).then(({ content: _c, computed: _v, ...i }) => { if (alive) setInfo(i) }).catch(() => { if (alive) setInfo(null) }) }
    load()
    const off = api.docs.onEvent((e) => { if (e.docId === id) load() })
    return () => { alive = false; off() }
  }, [id])
  return info
}

export function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  return new Date(at).toLocaleDateString()
}

export const DocIcon = ({ size = 16, sheet = false }: { size?: number; sheet?: boolean }) => sheet ? (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3.5" y="4" width="17" height="16" rx="2.5" /><path d="M3.5 9.5h17M3.5 15h17M9.5 4v16" />
  </svg>
) : (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" /><path d="M14 3v5h5M8.5 13h7M8.5 16.5h5" />
  </svg>
)

/** Documents already opened this session, so scrolling back doesn't pop the panel again. */
const autoOpened = new Set<string>()

/**
 * Inline card for a live document in the chat: its title, type and latest change, with Open (the
 * Document tab). A document the bot just made or changed opens beside the chat by itself.
 */
export function DocCard({ doc, at, exported, onOpen }: { doc: DocMeta; at?: number; exported?: string; onOpen: (id: string) => void }) {
  const info = useDocInfo(doc.id)
  useEffect(() => {
    const key = `${doc.id}@${at ?? 0}`
    if (!at || Date.now() - at > 20_000 || autoOpened.has(key)) return
    autoOpened.add(key)
    onOpen(doc.id)
  }, [doc.id, at, onOpen])
  const sheet = (info?.type ?? doc.type) === 'sheet'
  const title = info?.title ?? doc.title
  const who = (info?.lastAuthor ?? doc.author) === 'user' ? 'You' : 'SahilBot'
  const sub = info === null ? 'This document was deleted.' : `v${info?.version ?? doc.version} · ${who}${info ? ` ${ago(info.updatedAt)}` : ''}: ${info?.lastSummary ?? doc.summary}`
  return (
    <div className={`doc-card${info === null ? ' missing' : ''}`} data-testid="doc-card">
      <button className="doc-card-icon" onClick={() => onOpen(doc.id)} disabled={info === null} tabIndex={-1} aria-hidden><DocIcon size={22} sheet={sheet} /></button>
      <div className="doc-card-text">
        <span className="doc-card-kind">{sheet ? 'Sheet' : 'Document'} · live</span>
        <b className="doc-card-title" title={title}>{title}</b>
        <span className="doc-card-sub" title={sub}>{sub}</span>
        {exported && (
          <button className="doc-card-file" onClick={() => void api.files.open(exported).catch(() => api.files.reveal(exported))} title={exported}>
            <I.File size={12} /> {exported.split('/').pop()}
          </button>
        )}
      </div>
      <div className="doc-card-actions">
        <button className="btn primary" onClick={() => onOpen(doc.id)} disabled={info === null} data-testid="doc-card-open">Open</button>
      </div>
    </div>
  )
}
