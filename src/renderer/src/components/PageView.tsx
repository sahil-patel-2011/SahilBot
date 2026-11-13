import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { PageInfo } from '@shared/types'
import { api } from '../api'
import { toast } from '../lib/toast'
import * as I from '../icons'

/** A file that may be a Page (create_page saves them as "<workspace>/pages/<name>.html"). Main has the final say. */
export const isPageCandidate = (p: string | null | undefined): p is string => !!p && /[\\/]pages[\\/][^\\/]+\.html?$/i.test(p)

const errText = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/**
 * The page in a sandboxed iframe: scripts run, but with an opaque origin (no allow-same-origin), so it
 * can't reach window.foreman, the app's storage or cookies; no popups, forms or top navigation. The file is
 * served with a strict CSP (no network) as both a header and a <meta>.
 */
export function PageFrame({ info, className, title, version = 0, thumbnail = false }: { info: PageInfo; className?: string; title?: string; version?: number; thumbnail?: boolean }) {
  return (
    <iframe
      key={`${info.path}:${info.updatedAt}:${version}`}
      className={className}
      src={`${info.url}?v=${Math.round(info.updatedAt)}-${version}`}
      title={title ?? info.title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; display-capture 'none'"
      loading={thumbnail ? 'lazy' : 'eager'}
      {...(thumbnail ? { tabIndex: -1, 'aria-hidden': true } : {})}
    />
  )
}

/** Keeps a page's info fresh: reloads when the agent updates it (update_page) or on demand. */
export function usePage(path: string | null): { info: PageInfo | null; error: string | null; version: number; reload: () => void } {
  const [info, setInfo] = useState<PageInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const load = useCallback(() => {
    if (!path) return () => undefined
    let alive = true
    api.pages.info(path).then((x) => { if (alive) { setInfo(x); setError(null) } }).catch((e) => { if (alive) setError(errText(e)) })
    return () => { alive = false }
  }, [path])
  useEffect(() => { setInfo(null); setError(null); return load() }, [load])
  useEffect(() => api.chat.onEvent((e) => {
    if (e.type === 'message' && e.message.role === 'tool' && e.message.meta?.path === path && e.message.meta?.status === 'ok') load()
  }), [path, load])
  return { info, error, version, reload: () => { load(); setVersion((v) => v + 1) } }
}

/** Side-panel view of a Page: toolbar (reload, open in window, export PDF, show in Finder) and the live page. */
export function PageView({ path, fallback }: { path: string; fallback?: ReactNode }) {
  const { info, error, version, reload } = usePage(path)
  const [exporting, setExporting] = useState(false)
  if (error) return fallback ? <>{fallback}</> : <div className="right-body">{error}</div>
  if (!info) return <div className="right-body"><span className="spin" /></div>

  const exportPdf = async (): Promise<void> => {
    setExporting(true)
    try {
      const out = await api.pages.exportPdf(info.path)
      toast(`Saved ${out.split('/').pop()}`, 'ok')
    } catch (e) {
      toast(`Couldn't export the PDF: ${errText(e)}`, 'error')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="page-pane" data-testid="page-pane">
      <div className="page-bar">
        <span className="page-badge" aria-hidden><I.Sparkle size={13} /></span>
        <span className="page-title" title={info.path}>{info.title}</span>
        <button className="icon-btn" onClick={reload} title="Reload" aria-label="Reload page">↻</button>
        <button className="icon-btn" onClick={() => void api.pages.openWindow(info.path).catch((e) => toast(errText(e), 'error'))} title="Open in window" aria-label="Open in window" data-testid="page-open-window"><I.External size={15} /></button>
        <button className="icon-btn" onClick={() => void exportPdf()} disabled={exporting} title="Export PDF" aria-label="Export PDF" data-testid="page-export-pdf">
          {exporting ? <span className="spin" /> : <span className="page-pdf">PDF</span>}
        </button>
        <button className="icon-btn" onClick={() => void api.files.reveal(info.path)} title="Show in Finder" aria-label="Show in Finder"><I.Folder size={15} /></button>
      </div>
      <div className="page-body">
        <PageFrame info={info} className="page-frame" version={version} />
      </div>
    </div>
  )
}
