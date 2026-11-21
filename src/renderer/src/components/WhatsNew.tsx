import { useEffect, useState } from 'react'
import { RELEASES, releaseDate, type Release } from '@shared/release-notes'
import { bytesText } from '@shared/bytes'
import { api } from '../api'

// What's new: every release, newest first, each with its version (YY.MM.DD, like Tesla's), date, download
// size and what changed. In Settings → Updates, and once after an update (WhatsNewOnce).

type Sizes = Array<{ version: string; build: number; size: number; date: string }>

function useSizes(): Sizes {
  const [sizes, setSizes] = useState<Sizes>([])
  useEffect(() => { void api.update.history?.().then(setSizes).catch(() => undefined) }, [])
  return sizes
}

const sizeOf = (sizes: Sizes, v: string): number | undefined => sizes.filter((s) => s.version === v).sort((a, b) => b.build - a.build)[0]?.size

function ReleaseCard({ r, open, onToggle, size, current }: { r: Release; open: boolean; onToggle: () => void; size?: number; current: boolean }) {
  return (
    <article className={`wn-release${open ? ' open' : ''}`} data-testid="release" data-version={r.version}>
      <button className="wn-head" onClick={onToggle} aria-expanded={open}>
        <span className="wn-version">{r.version}</span>
        <span className="wn-title"><b>{r.title}</b><span>{releaseDate(r)}{size ? ` · ${bytesText(size)}` : ''}{current ? ' · installed' : ''}</span></span>
        <span className="wn-caret" aria-hidden>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="wn-body">
          <ul className="wn-highlights">{r.highlights.map((h) => <li key={h}>{h}</li>)}</ul>
          {r.sections.map((s) => (
            <section key={s.title}>
              <h4>{s.title}</h4>
              <ul>{s.items.map((i) => <li key={i}>{i}</li>)}</ul>
            </section>
          ))}
        </div>
      )}
    </article>
  )
}

/** Every release (Settings → Updates). */
export function WhatsNewList({ current }: { current?: string }) {
  const sizes = useSizes()
  const [open, setOpen] = useState<string>(RELEASES[0]?.version ?? '')
  return (
    <div className="wn-list" data-testid="whats-new">
      {RELEASES.map((r) => <ReleaseCard key={r.version} r={r} open={open === r.version} onToggle={() => setOpen(open === r.version ? '' : r.version)} size={sizeOf(sizes, r.version)} current={!!current?.startsWith(`${r.version} `)} />)}
    </div>
  )
}

const SEEN = 'sahilbot:whats-new-seen'

/** After an update: the new version's notes, once. */
export function WhatsNewOnce() {
  const [show, setShow] = useState<Release | null>(null)
  const sizes = useSizes()
  useEffect(() => {
    void Promise.all([api.update.status(), api.update.upgradedFrom?.() ?? Promise.resolve(null)]).then(([st, from]) => {
      const latest = RELEASES[0]
      if (!latest || !st.current?.startsWith(`${latest.version} `)) return
      let seen: string | null = null
      try { seen = localStorage.getItem(SEEN) } catch { /* ignore */ }
      if (seen === latest.version) return
      // Shown after an update (main knows the version this Mac ran before); a fresh install just remembers it.
      if (from) setShow(latest)
      else { try { localStorage.setItem(SEEN, latest.version) } catch { /* ignore */ } }
    }).catch(() => undefined)
  }, [])
  if (!show) return null
  const close = (): void => { try { localStorage.setItem(SEEN, show.version) } catch { /* ignore */ } setShow(null) }
  return (
    <div className="wn-overlay" role="dialog" aria-modal="true" aria-label={`What's new in ${show.version}`} onClick={close} data-testid="whats-new-once">
      <div className="wn-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="wn-dialog-kicker">SahilBot updated · {show.version}{sizeOf(sizes, show.version) ? ` · ${bytesText(sizeOf(sizes, show.version))}` : ''}</div>
        <h2>{show.title}</h2>
        <ReleaseCard r={show} open onToggle={() => undefined} current />
        <div className="wn-actions"><button className="btn primary" onClick={close} autoFocus>Got it</button></div>
      </div>
    </div>
  )
}
