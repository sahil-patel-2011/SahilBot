import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { PageInfo, PagePanelStatus } from '@shared/types'
import { api } from '../api'
import { toast } from '../lib/toast'
import * as I from '../icons'

/** A file that may be a Page (create_page saves them as "<workspace>/pages/<name>.html"). Main has the final say. */
export const isPageCandidate = (p: string | null | undefined): p is string => !!p && /[\\/]pages[\\/][^\\/]+\.html?$/i.test(p)

const errText = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

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

/**
 * Where the live page goes. The page itself is not in this window: main lays a native view from the
 * isolated pages session over this box (no window.foreman, no network, no WebRTC), so we keep its bounds
 * in sync and hide it while a modal is open. The data-* attributes are what main reports about it.
 */
function PageSurface({ info, version, hidden }: { info: PageInfo; version: number; hidden: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<PagePanelStatus | null>(null)
  const rev = `${Math.round(info.updatedAt)}-${version}`
  // Leaving the page (another file, another tab, panel closed) closes it and stops its scripts. Declared
  // first so its cleanup reaches main before the next page's show.
  useLayoutEffect(() => () => { void api.pages.show(null) }, [info.path])
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    let alive = true
    const sync = (): void => {
      const r = el.getBoundingClientRect()
      const bounds = hidden || r.width < 10 || r.height < 10 ? null : { x: r.left, y: r.top, width: r.width, height: r.height }
      api.pages.show(info.path, rev, bounds).then((s) => { if (alive && s) setStatus(s) }).catch(() => undefined)
    }
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    window.addEventListener('resize', sync)
    return () => {
      alive = false
      ro.disconnect()
      window.removeEventListener('resize', sync)
    }
  }, [info.path, rev, hidden])
  return (
    <div ref={box} className="page-frame" data-testid="page-view" title={info.title}
      data-isolation={status?.isolation ?? 'pending'} data-partition={status?.partition} data-webrtc={status?.webrtc} data-guard={status ? String(status.guard) : undefined}>
      <span className="spin" />
    </div>
  )
}

/** Side-panel view of a Page: toolbar (reload, open in window, export PDF, show in Finder) and the live page. */
export function PageView({ path, fallback, hidden = false }: { path: string; fallback?: ReactNode; hidden?: boolean }) {
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
        <PageSurface info={info} version={version} hidden={hidden} />
      </div>
    </div>
  )
}
