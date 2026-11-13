import { useEffect, useState } from 'react'
import type { Message, ToolCall } from '@shared/types'
import { api } from '../api'
import { toast } from '../lib/toast'
import * as I from '../icons'
import { usePage } from './PageView'

export const PAGE_TOOLS = ['create_page', 'update_page']

/** Pages a run made or changed, one per file (the latest call wins), from tool calls and their results. */
export function pagesFromSteps(steps: Array<{ call: Pick<ToolCall, 'id' | 'name' | 'arguments'>; result?: Pick<Message, 'meta' | 'createdAt'> }>): Array<{ key: string; path: string; title?: string; at?: number }> {
  const out = new Map<string, { key: string; path: string; title?: string; at?: number }>()
  for (const s of steps) {
    if (!PAGE_TOOLS.includes(s.call.name) || s.result?.meta?.status !== 'ok' || typeof s.result.meta.path !== 'string') continue
    let title: string | undefined
    try { const a = JSON.parse(s.call.arguments) as { title?: unknown }; if (typeof a.title === 'string') title = a.title } catch { /* partial args */ }
    const path = s.result.meta.path
    out.delete(path)
    out.set(path, { key: s.call.id, path, title: title ?? out.get(path)?.title, at: s.result.createdAt })
  }
  return [...out.values()]
}

/** Pages already shown this session, so a re-render or scroll-back doesn't pop the panel again. */
const autoOpened = new Set<string>()

/**
 * Inline card for a Page in the chat: title, a thumbnail, Open (side panel) and Open in window.
 * The thumbnail is a picture main renders in the isolated pages session (no live page in the app window).
 * `at` = when the tool result arrived; a just-made page opens in the side panel by itself.
 */
export function PageCard({ path, title, at, onOpen }: { path: string; title?: string; at?: number; onOpen: (path: string) => void }) {
  const { info, error } = usePage(path)
  const [thumb, setThumb] = useState<string | null>(null)

  useEffect(() => {
    if (!info) return
    let alive = true
    api.pages.thumbnail(info.path).then((t) => { if (alive) setThumb(t) }).catch(() => undefined)
    return () => { alive = false }
  }, [info?.path, info?.updatedAt])

  useEffect(() => {
    const key = `${path}@${at ?? 0}`
    if (!at || Date.now() - at > 20_000 || autoOpened.has(key)) return
    autoOpened.add(key)
    onOpen(path)
  }, [path, at, onOpen])

  const name = info?.title ?? title ?? path.split('/').pop() ?? 'Page'
  const open = (): void => onOpen(path)
  return (
    <div className={`page-card${error ? ' missing' : ''}`} data-testid="page-card">
      <button className="page-thumb" onClick={open} disabled={!!error} aria-label={`Open ${name}`} tabIndex={-1}>
        {thumb && !error ? <img className="page-thumb-img" src={thumb} alt="" draggable={false} /> : <span className="page-thumb-icon"><I.Sparkle size={22} /></span>}
      </button>
      <div className="page-card-text">
        <span className="page-card-kind"><I.Sparkle size={11} /> Page</span>
        <b className="page-card-title" title={info?.path ?? path}>{name}</b>
        <span className="page-card-sub">{error ? 'This page was moved or deleted.' : 'Interactive · opens beside the chat'}</span>
      </div>
      <div className="page-card-actions">
        <button className="btn primary" onClick={open} disabled={!!error} data-testid="page-card-open">Open</button>
        <button className="icon-btn" disabled={!!error} title="Open in window" aria-label="Open in window"
          onClick={() => void api.pages.openWindow(path).catch((e: Error) => toast(e.message, 'error'))}><I.External size={15} /></button>
      </div>
    </div>
  )
}
