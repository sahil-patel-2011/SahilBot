import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ObsidianFolderCheck, ObsidianVaultChoice, VaultChangeInfo, VaultGraph, VaultLevel, VaultNoteFull, VaultNoteInfo, VaultNoteType, VaultSearchHit, VaultStatus } from '@shared/vault'
import { api } from '../api'
import * as I from '../icons'
import { toast } from '../lib/toast'
import { render } from './Markdown'
import { Toggle } from './Toggle'
import '../styles-vault.css'
import { ClampText, Disclosure } from './ui'
import { PeopleView } from './PeopleView'
import { ContextMenu } from './ContextMenu'

// The Vault view: the notes your bots keep (src/main/vault), like a small Obsidian. A list with search
// and area filters, the note itself with clickable [[links]] and its backlinks, a graph of how notes
// link, and every change with Undo. Open in Obsidian, reveal in Finder, export as a zip.

const TYPE_LABEL: Record<VaultNoteType, string> = {
  person: 'People', project: 'Projects', decision: 'Decisions', preference: 'Preferences', fact: 'Facts',
  digest: 'Digests', research: 'Research', howto: 'How-tos', index: 'Indexes'
}
const TYPE_COLOR: Record<VaultNoteType, string> = {
  person: '#e5484d', project: '#3b82f6', decision: '#a855f7', preference: '#f59e0b', fact: '#6b7280',
  digest: '#10b981', research: '#0ea5e9', howto: '#ff6a1a', index: '#9ca3af'
}
const TYPE_ORDER: VaultNoteType[] = ['person', 'project', 'decision', 'preference', 'howto', 'research', 'fact', 'digest', 'index']

const clean = (e: unknown): string => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const areaName = (s: string): string => (s === 'Shared' ? 'Shared' : s === OBSIDIAN ? 'Your Obsidian vault' : s.replace(/^Bots\//, ''))
/** The section of the user's own notes in their Obsidian vault (read-only here; paths "obsidian:…"). */
const OBSIDIAN = 'Obsidian'
const OBSIDIAN_BADGE = 'In your Obsidian vault'
const when = (t: number): string => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

/** [[links]] → Markdown links the view intercepts (unresolved ones look different and offer to create). */
function linkify(body: string, resolved: Record<string, string | null>): string {
  return body.replace(/\[\[([^\]\n|#]+)(#[^\]\n|]*)?(?:\|([^\]\n]+))?\]\]/g, (_m, target: string, _h: string | undefined, alias: string | undefined) => {
    const t = target.trim()
    const label = (alias ?? t).replace(/[[\]]/g, '')
    const path = resolved[t]
    return path ? `[${label}](#vault:${encodeURIComponent(path)})` : `[${label}](#vault-missing:${encodeURIComponent(t)})`
  })
}

type Tab = 'note' | 'graph' | 'changes' | 'people'

export function VaultView(p: { onClose: () => void; initialPath?: string | null; initialTab?: Tab }) {
  const [status, setStatus] = useState<VaultStatus | null>(null)
  const [notes, setNotes] = useState<VaultNoteInfo[] | null>(null)
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<VaultSearchHit[] | null>(null)
  const [area, setArea] = useState<string>('all')
  const [path, setPath] = useState<string | null>(p.initialPath ?? null)
  const [note, setNote] = useState<VaultNoteFull | null>(null)
  const [tab, setTab] = useState<Tab>(p.initialTab ?? 'note')
  const [more, setMore] = useState<{ x: number; y: number } | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [confirmTrash, setConfirmTrash] = useState(false)
  const [creating, setCreating] = useState<string | null>(null)

  const [theirs, setTheirs] = useState<VaultNoteInfo[]>([])
  const load = useCallback(async (): Promise<void> => {
    const [st, ns] = await Promise.all([api.notesVault.status(), api.notesVault.list()])
    setStatus(st)
    setNotes(ns)
    // "Use my Obsidian vault": the user's own notes, listed read-only.
    setTheirs(st.obsidianVault?.enabled ? await api.notesVault.obsidianNotes().catch(() => []) : [])
  }, [])
  useEffect(() => { void load(); return api.notesVault.onChanged(() => void load()) }, [load])

  // The first note to show: the one asked for, else Home.
  useEffect(() => {
    if (path || !notes) return
    const home = notes.find((n) => n.path === 'Home.md') ?? notes.find((n) => !n.generated)
    if (home) setPath(home.path)
  }, [notes, path])
  useEffect(() => { if (p.initialPath) { setPath(p.initialPath); setTab('note') } }, [p.initialPath])

  useEffect(() => {
    if (!path) { setNote(null); return }
    let live = true
    void api.notesVault.read(path).then((n) => { if (live) { setNote(n); setEditing(null); setConfirmTrash(false) } })
    return () => { live = false }
  }, [path, notes])

  useEffect(() => {
    const t = q.trim()
    if (!t) { setHits(null); return }
    const id = setTimeout(() => void api.notesVault.search(t).then(setHits).catch(() => setHits([])), 160)
    return () => clearTimeout(id)
  }, [q])

  // Esc closes the view (not while editing or typing a search).
  useEffect(() => {
    const k = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (editing !== null) { e.preventDefault(); setEditing(null); return }
      if (creating !== null) { e.preventDefault(); setCreating(null); return }
      if (q) { e.preventDefault(); setQ(''); return }
      e.preventDefault()
      p.onClose()
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [editing, creating, q, p])

  const areas = useMemo(() => [...[...new Set((notes ?? []).filter((n) => !n.generated).map((n) => n.section))].sort((a, b) => (a === 'Shared' ? -1 : b === 'Shared' ? 1 : a.localeCompare(b))), ...(theirs.length ? [OBSIDIAN] : [])], [notes, theirs.length])
  const shown = area === OBSIDIAN ? [] : (notes ?? []).filter((n) => !n.generated && (area === 'all' || n.section === area))
  const theirsShown = area === 'all' || area === OBSIDIAN ? theirs : []
  const groups = useMemo(() => TYPE_ORDER.map((t) => ({ t, ns: shown.filter((n) => n.type === t).sort((a, b) => b.mtime - a.mtime) })).filter((g) => g.ns.length), [shown])

  const open = (rel: string): void => { setPath(rel); setTab('note') }

  const onDocClick = (e: React.MouseEvent): void => {
    const a = (e.target as HTMLElement).closest('a') as HTMLAnchorElement | null
    if (!a) return
    const href = a.getAttribute('href') ?? ''
    if (href.startsWith('#vault:')) { e.preventDefault(); open(decodeURIComponent(href.slice(7))); return }
    if (href.startsWith('#vault-missing:')) {
      e.preventDefault()
      const title = decodeURIComponent(href.slice(15))
      void api.notesVault.create({ title, section: note?.section && !note.generated ? note.section : 'Shared' }).then((rel) => { toast(`New note “${title}”`, 'ok'); open(rel) }).catch((err) => toast(clean(err), 'error'))
      return
    }
    if (/^https?:/.test(href)) { e.preventDefault(); window.dispatchEvent(new CustomEvent('foreman:open-link', { detail: href })) }
  }

  const html = useMemo(() => (note ? render(linkify(note.body.replace(/^#\s+.*\n/, ''), note.resolved)) : ''), [note])

  const obsidian = async (): Promise<void> => {
    try {
      const how = await api.notesVault.openInObsidian(note?.path)
      if (how === 'finder') toast('Obsidian isn\'t installed, so the vault opened in Finder. Any Markdown app can open it.', 'info')
    } catch (e) { toast(clean(e), 'error') }
  }
  const exportZip = async (): Promise<void> => {
    try { const out = await api.notesVault.exportZip(); toast(`Exported to ${out.split('/').slice(-2).join('/')}`, 'ok') } catch (e) { toast(clean(e), 'error') }
  }
  const compile = async (): Promise<void> => {
    try { await api.notesVault.compileNow(); toast('Compiling the vault in the background', 'ok') } catch (e) { toast(clean(e), 'error') }
  }
  const newNote = async (): Promise<void> => {
    const title = creating?.trim()
    setCreating(null)
    if (!title) return
    try { const rel = await api.notesVault.create({ title, section: area !== 'all' ? area : 'Shared' }); open(rel); setEditing(null) } catch (e) { toast(clean(e), 'error') }
  }
  const saveEdit = async (): Promise<void> => {
    if (!note || editing === null) return
    try { const n = await api.notesVault.save(note.path, editing); setNote(n); setEditing(null); toast('Saved (the old version is kept)', 'ok') } catch (e) { toast(clean(e), 'error') }
  }
  const trash = async (): Promise<void> => {
    if (!note) return
    try { await api.notesVault.trash(note.path); setPath(null); toast('Moved to the vault\'s trash. Undo it in Changes.', 'ok') } catch (e) { toast(clean(e), 'error') }
  }

  const listItem = (n: { path: string; title: string; sub: string }) => (
    <button key={n.path} className={`vault-item${n.path === path ? ' on' : ''}`} onClick={() => open(n.path)} data-testid="vault-item">
      <b>{n.title}</b>
      {n.sub && <span>{n.sub}</span>}
    </button>
  )

  return (
    <div className={`vault${tab === 'people' ? ' vault-people' : ''}`} data-testid="vault-view">
      <aside className="vault-side">
        <div className="vault-side-head">
          <div className="vault-title">
            <I.ListIcon size={16} />Notes
            <span className="hint">{status ? `${status.notes} notes` : ''}</span>
            <button className="icon-btn" title="New note" aria-label="New note" onClick={() => setCreating('')} data-testid="vault-new"><I.Plus size={15} /></button>
            <button className="icon-btn" title="Close (Esc)" aria-label="Close vault" onClick={p.onClose} data-testid="vault-close"><I.Close size={15} /></button>
          </div>
          {creating !== null && (
            <label className="vault-search">
              <I.Plus size={13} />
              <input autoFocus value={creating} onChange={(e) => setCreating(e.target.value)} placeholder="New note title, then Return" aria-label="New note title" data-testid="vault-new-title"
                onKeyDown={(e) => { if (e.key === 'Enter') void newNote(); if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setCreating(null) } }} onBlur={() => { if (!creating.trim()) setCreating(null) }} />
            </label>
          )}
          <label className="vault-search">
            <I.Search size={13} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search notes" spellCheck={false} aria-label="Search notes" data-testid="vault-search" />
            {q && <button aria-label="Clear search" onClick={() => setQ('')}><I.Close size={11} /></button>}
          </label>
          {areas.length > 1 && !hits && (
            <div className="vault-filters" role="tablist" aria-label="Areas">
              <button className={`vault-chip${area === 'all' ? ' on' : ''}`} onClick={() => setArea('all')}>All</button>
              {areas.map((a) => <button key={a} className={`vault-chip${area === a ? ' on' : ''}`} onClick={() => setArea(a)}>{areaName(a)}</button>)}
            </div>
          )}
        </div>
        <div className="vault-list">
          {notes === null ? <div className="vault-empty">Loading…</div>
            : hits ? (hits.length ? hits.map((h) => listItem({ path: h.path, title: h.title, sub: `${h.source === 'obsidian' ? OBSIDIAN_BADGE : areaName(h.section)} · ${h.snippet}` })) : <div className="vault-empty">No notes match “{q}”.</div>)
              : (
                <>
                  {listItem({ path: 'Home.md', title: 'Home', sub: 'The map of everything' })}
                  {groups.map((g) => (
                    <div key={g.t}>
                      <div className="vault-group">{TYPE_LABEL[g.t]}</div>
                      {g.ns.map((n) => listItem({ path: n.path, title: n.title, sub: `${area === 'all' ? `${areaName(n.section)} · ` : ''}${n.summary}` }))}
                    </div>
                  ))}
                  {theirsShown.length > 0 && (
                    <div data-testid="vault-obsidian-notes">
                      <div className="vault-group">{OBSIDIAN_BADGE} ({theirsShown.length})</div>
                      {theirsShown.slice(0, 500).map((n) => listItem({ path: n.path, title: n.title, sub: `${n.path.replace(/^obsidian:/, '').split('/').slice(0, -1).join('/') || 'Vault root'}${n.summary ? ` · ${n.summary}` : ''}` }))}
                    </div>
                  )}
                  {!groups.length && !theirsShown.length && <div className="vault-empty">No notes yet. While SahilBot is open and idle it turns your chats, files and decisions into linked notes here. Bots can also write notes as they work.</div>}
                </>
              )}
        </div>
      </aside>

      <section className="vault-main">
        <div className="vault-bar">
          <div className="vault-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'note'} className={tab === 'note' ? 'on' : ''} onClick={() => setTab('note')} data-testid="vault-tab-note">Note</button>
            <button role="tab" aria-selected={tab === 'graph'} className={tab === 'graph' ? 'on' : ''} onClick={() => setTab('graph')} data-testid="vault-tab-graph">Graph</button>
            <button role="tab" aria-selected={tab === 'changes'} className={tab === 'changes' ? 'on' : ''} onClick={() => setTab('changes')} data-testid="vault-tab-changes">Changes</button>
            <button role="tab" aria-selected={tab === 'people'} className={tab === 'people' ? 'on' : ''} onClick={() => setTab('people')} data-testid="vault-tab-people">People &amp; Places</button>
          </div>
          <span className="grow" />
          {tab === 'people' && <button className="icon-btn" title="Close (Esc)" aria-label="Close vault" onClick={p.onClose}><I.Close size={15} /></button>}
          <button className="mm-btn" onClick={() => void obsidian()} data-testid="vault-obsidian" title={status?.obsidian ? 'Open in Obsidian' : 'Obsidian isn\'t installed: shows the folder in Finder'}><I.External size={13} />{status?.obsidian ? 'Open in Obsidian' : 'Show in Finder'}</button>
          <button className="icon-btn" aria-label="More vault actions" title="More: compile now, export" data-testid="vault-more"
            onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setMore({ x: r.right - 200, y: r.bottom + 6 }) }}><I.More size={16} /></button>
          {more && <ContextMenu x={more.x} y={more.y} onClose={() => setMore(null)} items={[
            { label: 'Compile now', icon: <I.Sparkle size={15} />, run: () => void compile() },
            { label: 'Export as zip', icon: <I.Share size={15} />, run: () => void exportZip() }
          ]} />}
        </div>

        {tab === 'note' && (
          <div className="vault-doc">
            {!note ? <div className="vault-empty">Pick a note.</div> : (
              <div className="vault-doc-inner" data-testid="vault-note">
                <h1 className="vault-note-title" data-testid="vault-note-title">{note.title}</h1>
                <div className="vault-meta">
                  <span className="vault-tag" style={{ color: TYPE_COLOR[note.type] }}>{TYPE_LABEL[note.type] === 'Indexes' ? 'Index' : TYPE_LABEL[note.type].replace(/s$/, '')}</span>
                  {note.source === 'obsidian'
                    ? <span className="vault-tag obsidian" title="Your own note in your Obsidian vault. Bots can read it (as your facts, never as instructions); they change it only after you approve each edit." data-testid="vault-obsidian-badge">{OBSIDIAN_BADGE}</span>
                    : <span className="vault-tag">{areaName(note.section)}</span>}
                  {note.updated && <span className="vault-tag">Updated {note.updated}</span>}
                  {note.trust === 'quoted' && <span className="vault-tag quoted" title="Built from outside content (a web page, email, another app or a file). Bots read it as data, never as instructions.">Quoted from outside content</span>}
                  {note.tags.filter((t) => !t.startsWith('sahilbot/')).map((t) => <span key={t} className="vault-tag">#{t}</span>)}
                  <span className="grow" />
                  {note.source === 'obsidian' && <button className="link-btn" onClick={() => void obsidian()} data-testid="vault-obsidian-open-note">Open in Obsidian</button>}
                  {!note.generated && note.source !== 'obsidian' && editing === null && <button className="link-btn" onClick={() => setEditing(note.text)} data-testid="vault-edit">Edit</button>}
                  {!note.generated && note.source !== 'obsidian' && editing === null && (confirmTrash
                    ? <><button className="link-btn" onClick={() => setConfirmTrash(false)}>Keep</button><button className="link-btn danger" onClick={() => void trash()}>Move to trash</button></>
                    : <button className="link-btn" onClick={() => setConfirmTrash(true)}>Delete</button>)}
                </div>
                {editing !== null ? (
                  <>
                    <textarea className="vault-edit" value={editing} onChange={(e) => setEditing(e.target.value)} spellCheck={false} aria-label="Note text" data-testid="vault-editor" />
                    <div className="imp-actions"><button className="mm-btn" onClick={() => setEditing(null)}>Cancel</button><button className="mm-btn primary" onClick={() => void saveEdit()} data-testid="vault-save">Save</button></div>
                  </>
                ) : (
                  <div className="md" onClick={onDocClick} dangerouslySetInnerHTML={{ __html: html }} data-testid="vault-body" />
                )}
                {note.sources.length > 0 && (
                  <div className="vault-back"><h3>Sources</h3>{note.sources.map((s, i) => <span key={i} className="vault-back-ctx">{s}</span>)}</div>
                )}
                <div className="vault-back" data-testid="vault-backlinks">
                  <h3>Backlinks ({note.backlinks.length})</h3>
                  {note.backlinks.length ? note.backlinks.map((b) => (
                    <button key={b.path} onClick={() => open(b.path)} data-testid="vault-backlink">{b.title}{b.context && <span className="vault-back-ctx">{b.context}</span>}</button>
                  )) : <span className="vault-back-ctx">No other note links here yet.</span>}
                </div>
              </div>
            )}
          </div>
        )}
        {tab === 'graph' && <GraphView current={path} onOpen={open} />}
        {tab === 'changes' && <ChangesView onOpen={open} />}
        {tab === 'people' && <PeopleView onOpenNote={open} />}
      </section>
    </div>
  )
}

// ------------------------------------------------------------------ graph (SVG, a small force layout)

interface Pos { x: number; y: number }

function layout(g: VaultGraph, w: number, h: number): Map<string, Pos> {
  const n = g.nodes.length
  const pos = new Map<string, Pos & { vx: number; vy: number }>()
  g.nodes.forEach((node, i) => {
    const a = (i / Math.max(1, n)) * Math.PI * 2 * 7.3
    const r = Math.min(w, h) * 0.38 * Math.sqrt((i + 1) / Math.max(1, n))
    pos.set(node.id, { x: w / 2 + Math.cos(a) * r, y: h / 2 + Math.sin(a) * r, vx: 0, vy: 0 })
  })
  const k = Math.sqrt((w * h) / Math.max(1, n)) * 0.55
  const list = [...pos.values()]
  const iters = n > 200 ? 120 : 220
  for (let it = 0; it < iters; it++) {
    const temp = (1 - it / iters) * k * 0.6
    for (let i = 0; i < list.length; i++) {
      const a = list[i]
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j]
        let dx = a.x - b.x, dy = a.y - b.y
        const d2 = Math.max(1, dx * dx + dy * dy)
        const f = (k * k) / d2
        dx *= f; dy *= f
        a.vx += dx; a.vy += dy; b.vx -= dx; b.vy -= dy
      }
    }
    for (const e of g.edges) {
      const a = pos.get(e.from), b = pos.get(e.to)
      if (!a || !b) continue
      const dx = a.x - b.x, dy = a.y - b.y
      const d = Math.max(1, Math.sqrt(dx * dx + dy * dy))
      const f = d / k
      a.vx -= (dx / d) * f * d * 0.5; a.vy -= (dy / d) * f * d * 0.5
      b.vx += (dx / d) * f * d * 0.5; b.vy += (dy / d) * f * d * 0.5
    }
    for (const p of list) {
      p.vx += (w / 2 - p.x) * 0.02; p.vy += (h / 2 - p.y) * 0.02
      const v = Math.sqrt(p.vx * p.vx + p.vy * p.vy) || 1
      const step = Math.min(v, temp)
      p.x = Math.min(w - 20, Math.max(20, p.x + (p.vx / v) * step))
      p.y = Math.min(h - 20, Math.max(20, p.y + (p.vy / v) * step))
      p.vx = 0; p.vy = 0
    }
  }
  return pos
}

function GraphView({ current, onOpen }: { current: string | null; onOpen: (path: string) => void }) {
  const [g, setG] = useState<VaultGraph | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 900, h: 600 })
  useEffect(() => { void api.notesVault.graph().then(setG) }, [])
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: Math.max(320, el.clientWidth), h: Math.max(260, el.clientHeight) }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // At most 300 nodes: the best-connected ones.
  const shown = useMemo(() => {
    if (!g) return null
    if (g.nodes.length <= 300) return g
    const deg = new Map<string, number>()
    for (const e of g.edges) { deg.set(e.from, (deg.get(e.from) ?? 0) + 1); deg.set(e.to, (deg.get(e.to) ?? 0) + 1) }
    const keep = new Set([...g.nodes].sort((a, b) => (deg.get(b.id) ?? 0) - (deg.get(a.id) ?? 0)).slice(0, 300).map((n) => n.id))
    return { nodes: g.nodes.filter((n) => keep.has(n.id)), edges: g.edges.filter((e) => keep.has(e.from) && keep.has(e.to)) }
  }, [g])
  const pos = useMemo(() => (shown ? layout(shown, size.w, size.h) : null), [shown, size.w, size.h])
  const degree = useMemo(() => {
    const d = new Map<string, number>()
    for (const e of shown?.edges ?? []) { d.set(e.from, (d.get(e.from) ?? 0) + 1); d.set(e.to, (d.get(e.to) ?? 0) + 1) }
    return d
  }, [shown])
  const types = [...new Set((shown?.nodes ?? []).map((n) => n.type))]
  return (
    <div className="vault-graph" ref={box} data-testid="vault-graph">
      {!shown || !pos ? <div className="vault-empty">Drawing the graph…</div> : !shown.nodes.length ? <div className="vault-empty">No notes to draw yet.</div> : (
        <svg viewBox={`0 0 ${size.w} ${size.h}`} role="img" aria-label={`Graph of ${shown.nodes.length} notes and ${shown.edges.length} links`}>
          {shown.edges.map((e, i) => { const a = pos.get(e.from)!, b = pos.get(e.to)!; return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} /> })}
          {shown.nodes.map((n) => {
            const p = pos.get(n.id)!
            const r = 4 + Math.min(8, (degree.get(n.id) ?? 0) * 1.2)
            const label = shown.nodes.length <= 80 || (degree.get(n.id) ?? 0) >= 2 || n.id === current
            return (
              <g key={n.id} className={n.id === current ? 'on' : ''} onClick={() => onOpen(n.id)} data-testid="vault-graph-node">
                <title>{`${n.title} (${areaName(n.section)})`}</title>
                <circle cx={p.x} cy={p.y} r={r} fill={TYPE_COLOR[n.type]} opacity={n.trust === 'quoted' ? 0.55 : 1} />
                {label && <text x={p.x + r + 3} y={p.y + 3.5}>{n.title.length > 28 ? `${n.title.slice(0, 27)}…` : n.title}</text>}
              </g>
            )
          })}
        </svg>
      )}
      {!!types.length && <div className="vault-graph-legend">{types.map((t) => <span key={t}><i style={{ background: TYPE_COLOR[t] }} />{TYPE_LABEL[t]}</span>)}</div>}
    </div>
  )
}

// ------------------------------------------------------------------ changes, with Undo

function ChangesView({ onOpen }: { onOpen: (path: string) => void }) {
  const [list, setList] = useState<VaultChangeInfo[] | null>(null)
  useEffect(() => { void api.notesVault.changes(300).then(setList) }, [])
  const undo = async (id: string): Promise<void> => {
    try { setList(await api.notesVault.undo(id)); toast('Undone', 'ok') } catch (e) { toast(clean(e), 'error') }
  }
  const verb = { create: 'Created', update: 'Updated', trash: 'Moved to trash', restore: 'Restored', revert: 'Undid' }
  return (
    <div className="vault-changes" data-testid="vault-changes">
      {list === null ? <div className="vault-empty">Loading…</div> : !list.length ? <div className="vault-empty">No changes yet.</div> : list.map((c) => (
        <div key={c.id} className="vault-change" data-testid="vault-change">
          <time>{when(c.at)}</time>
          <span className="what">{verb[c.op]} <button className="link-btn" onClick={() => onOpen(c.path)}>{c.title}</button>{c.why ? <span className="hint"> · {c.why}</span> : null}</span>
          <span className="who">{c.actor === 'you' ? 'You' : c.actor === 'you (in Obsidian)' ? 'You (in Obsidian)' : c.actor === 'compiler' ? 'While idle' : c.actor.replace(/^bot:/, '')}</span>
          {c.undoneAt ? <span className="hint">Undone</span> : c.canUndo && <button className="mm-btn" onClick={() => void undo(c.id)}>Undo</button>}
        </div>
      ))}
    </div>
  )
}

// ------------------------------------------------------------------ settings pieces

const LEVELS: Array<{ v: VaultLevel; label: string }> = [{ v: 'normal', label: 'Normal' }, { v: 'aggressive', label: 'More' }]

function openVault(path?: string): void {
  window.dispatchEvent(new CustomEvent('sahilbot:open-vault', { detail: { path: path ?? null } }))
}

/** Settings → Memory → Knowledge vault. */
export function VaultSettings() {
  const [st, setSt] = useState<VaultStatus | null>(null)
  const [dir, setDir] = useState('')
  useEffect(() => {
    const load = (): void => { void api.notesVault.status().then((s) => { setSt(s); setDir(s.settings.dir) }) }
    load()
    return api.notesVault.onChanged(load)
  }, [])
  if (!st) return null
  const set = async (patch: Parameters<typeof api.notesVault.setSettings>[0]): Promise<void> => {
    try { setSt(await api.notesVault.setSettings(patch)) } catch (e) { toast(clean(e), 'error') }
  }
  const s = st.settings
  return (
    <section className="set-section vault-set" data-testid="vault-settings">
      <div className="set-label">Notes</div>
      <div className="set-card">
        <div className="set-row">
          <div className="set-row-text">
            <div className="set-row-title">Keep a knowledge vault</div>
            <ClampText>Linked Markdown notes (Obsidian-style) about you, your people, projects, decisions and research. Compiled from chats, files and connected apps while SahilBot is open and idle; each bot gets the most relevant notes before every task. {st.notes} notes so far.</ClampText>
          </div>
          <div className="set-row-ctl"><Toggle on={s.enabled} onChange={(v) => void set({ enabled: v })} label="Keep a knowledge vault" testId="vault-enabled" /></div>
        </div>
        <div className="set-row">
          <div className="set-row-text"><div className="set-row-title">Mirror memories and decisions into the vault</div><ClampText>Every saved memory goes in a note per category (Shared/Memory), and your decisions go in a dated Decision log (Shared/Decisions). A bot's own memories stay in its own area. Change memories in Memory; the vault copy follows.</ClampText></div>
          <div className="set-row-ctl"><Toggle on={s.memories !== false} onChange={(v) => void set({ memories: v })} label="Mirror memories and decisions" testId="vault-memories" /></div>
        </div>
        <Disclosure title="Advanced" sub="Folder and digests" testId="vault-advanced">
          <div className="set-row">
            <div className="set-row-text">
              <div className="set-row-title">Folder</div>
              <ClampText>Open it in Obsidian or any Markdown app. Default: {st.defaultRoot}</ClampText>
            </div>
            <div className="set-row-ctl">
              <input className="set-input" style={{ width: 260 }} value={dir} placeholder={st.defaultRoot} spellCheck={false} onChange={(e) => setDir(e.target.value)}
                onBlur={() => { if (dir.trim() !== s.dir) void set({ dir: dir.trim() }) }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} aria-label="Vault folder" />
            </div>
          </div>
          <div className="set-row">
            <div className="set-row-text"><div className="set-row-title">Digest important documents</div><ClampText>Summaries of documents the knowledge base indexed, quoted with their file as the source.</ClampText></div>
            <div className="set-row-ctl"><Toggle on={s.docs} onChange={(v) => void set({ docs: v })} label="Digest documents" /></div>
          </div>
          <div className="set-row">
            <div className="set-row-text"><div className="set-row-title">Daily activity digest</div><ClampText>Only when “Know what I'm working on” and “Let SahilBot learn from my activity” are both on. Never sent to cloud models.</ClampText></div>
            <div className="set-row-ctl"><Toggle on={s.activity} onChange={(v) => void set({ activity: v })} label="Activity digest" /></div>
          </div>
        </Disclosure>
        <div className="set-row">
          <div className="set-row-text"><ClampText>{st.lastSummary ? `Last compile: ${st.lastSummary}${st.lastCompiledAt ? ` (${when(st.lastCompiledAt)})` : ''}.` : 'Compiles the next time SahilBot is idle.'} Uses the same model and budget as learning (local first; cloud only if you allowed it).</ClampText></div>
          <div className="set-row-ctl">
            <button className="mm-btn" onClick={() => openVault()} data-testid="vault-open">Open vault</button>
            <button className="mm-btn" onClick={() => void api.notesVault.openInObsidian().catch((e) => toast(clean(e), 'error'))}>{st.obsidian ? 'Open in Obsidian' : 'Show in Finder'}</button>
          </div>
        </div>
      </div>
      <ObsidianSettings st={st} onStatus={setSt} />
    </section>
  )
}

/**
 * Settings → Memory → Knowledge vault → Use my Obsidian vault: SahilBot keeps its notes in a subfolder of
 * the user's own vault, reads the rest (minus excluded folders) for search and recall, and picks up edits
 * made in Obsidian (logged in Changes, with Undo).
 */
function ObsidianSettings({ st, onStatus }: { st: VaultStatus; onStatus: (s: VaultStatus) => void }) {
  const o = st.settings.obsidian
  const os = st.obsidianVault
  const [found, setFound] = useState<ObsidianVaultChoice[] | null>(null)
  const [plain, setPlain] = useState<ObsidianFolderCheck | null>(null)
  const [sub, setSub] = useState(o.subfolder)
  const [ex, setEx] = useState(o.exclude.join('\n'))
  const [busy, setBusy] = useState(false)
  useEffect(() => { void api.notesVault.obsidianDetect().then(setFound).catch(() => setFound([])) }, [])
  useEffect(() => { setSub(o.subfolder) }, [o.subfolder])
  useEffect(() => { setEx(o.exclude.join('\n')) }, [o.exclude.join('\n')])
  const set = async (patch: Parameters<typeof api.notesVault.setSettings>[0]['obsidian']): Promise<boolean> => {
    try { onStatus(await api.notesVault.setSettings({ obsidian: patch })); return true } catch (e) { toast(clean(e), 'error'); return false }
  }
  const use = async (path: string): Promise<void> => { setPlain(null); if (await set({ vault: path, enabled: true })) toast('SahilBot now keeps its notes in your Obsidian vault', 'ok') }
  const pick = async (): Promise<void> => {
    try {
      const r = await api.notesVault.obsidianPick()
      if (!r) return
      if (r.isVault) await use(r.path)
      else setPlain(r)
    } catch (e) { toast(clean(e), 'error') }
  }
  const copy = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await api.notesVault.obsidianCopyExisting()
      toast(r.copied ? `Copied ${r.copied} note${r.copied > 1 ? 's' : ''} into ${o.subfolder}/${r.renamed ? ` (${r.renamed} renamed with a number, since a note with that name was there)` : ''}. Your old folder is unchanged; Undo is in Changes.` : 'There were no notes to copy.', 'ok')
    } catch (e) { toast(clean(e), 'error') } finally { setBusy(false) }
  }
  const choices = (found ?? []).filter((v) => v.path !== o.vault || !o.enabled)
  const last = os?.lastPickedUp
  return (
    <>
      <div className="set-label">Use my Obsidian vault</div>
      <div className="set-card" data-testid="obsidian-section">
        <div className="set-row">
          <div className="set-row-text">
            <div className="set-row-title">Use my Obsidian vault</div>
            <ClampText>SahilBot keeps its own notes in one folder of your vault ({o.subfolder}/, with its history and trash inside it), reads the rest of your notes for search and recall, and picks up the edits you make in Obsidian. It never changes your other notes unless you approve each edit, and never reads the folders you exclude.</ClampText>
          </div>
          <div className="set-row-ctl">
            <Toggle on={o.enabled} onChange={(v) => { if (!v) void set({ enabled: false }); else if (o.vault) void set({ enabled: true }); else void pick() }} label="Use my Obsidian vault" testId="obsidian-enabled" />
          </div>
        </div>
        <div className="set-row">
          <div className="set-row-text">
            <div className="set-row-title">Vault</div>
            <ClampText>{o.vault ? `${o.vault}${os && !os.exists ? ' (not found: SahilBot uses its own folder until it\'s back)' : os && !os.isVault ? ' (a plain folder, not opened in Obsidian yet)' : ''}` : 'Pick one of the vaults Obsidian knows, or choose its folder.'}</ClampText>
            {choices.length > 0 && (
              <div className="vault-obs-choices" data-testid="obsidian-detected">
                {choices.map((v) => (
                  <button key={v.path} className="vault-chip" title={v.path} onClick={() => void use(v.path)} data-testid="obsidian-choice">{v.name}</button>
                ))}
              </div>
            )}
            {plain && (
              <div className="vault-obs-warn" role="alert" data-testid="obsidian-plain-warning">
                “{plain.name}” has no .obsidian folder, so Obsidian hasn't opened it as a vault. SahilBot can still use it (open it in Obsidian later with “Open folder as vault”).
                <div className="vault-obs-actions">
                  <button className="mm-btn" onClick={() => setPlain(null)}>Cancel</button>
                  <button className="mm-btn primary" onClick={() => void use(plain.path)} data-testid="obsidian-plain-confirm">Use it anyway</button>
                </div>
              </div>
            )}
          </div>
          <div className="set-row-ctl"><button className="mm-btn" onClick={() => void pick()} data-testid="obsidian-pick">Choose folder…</button></div>
        </div>
        <div className="set-row">
          <div className="set-row-text">
            <div className="set-row-title">SahilBot's folder in your vault</div>
            <ClampText>Home, Changelog, Shared and each bot's notes go here, so the rest of your vault stays as it is.</ClampText>
          </div>
          <div className="set-row-ctl">
            <input className="set-input" style={{ width: 180 }} value={sub} placeholder="SahilBot" spellCheck={false} onChange={(e) => setSub(e.target.value)} aria-label="SahilBot's folder in your vault" data-testid="obsidian-subfolder"
              onBlur={() => { if (sub.trim() !== o.subfolder) void set({ subfolder: sub.trim() || 'SahilBot' }) }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
          </div>
        </div>
        <div className="set-row">
          <div className="set-row-text">
            <div className="set-row-title">Never read</div>
            <ClampText>Folders or notes SahilBot never reads, searches or sends to a model, one per line, from the vault's top (e.g. Private/ or Journal/2024/). Hidden folders like .obsidian and .trash are always skipped.</ClampText>
          </div>
          <div className="set-row-ctl">
            <textarea className="set-input vault-obs-exclude" rows={3} value={ex} placeholder={'Private/\nJournal/'} spellCheck={false} onChange={(e) => setEx(e.target.value)} aria-label="Folders SahilBot never reads" data-testid="obsidian-exclude"
              onBlur={() => { const list = ex.split('\n').map((l) => l.trim()).filter(Boolean); if (list.join('\n') !== o.exclude.join('\n')) void set({ exclude: list }) }} />
          </div>
        </div>
        {o.enabled && os && (
          <div className="set-row">
            <div className="set-row-text" data-testid="obsidian-status">
              <ClampText>{[os.exists ? (os.watching ? 'Watching for your edits' : 'Checking for your edits every 30 seconds') : 'Vault folder not found', `${os.notes} of your notes readable`, last ? `last change picked up: ${last.title} (${when(last.at)})` : 'no edits from Obsidian yet'].join(' · ')}</ClampText>
            </div>
            <div className="set-row-ctl">
              <button className="mm-btn" onClick={() => void api.notesVault.obsidianRescan().then(onStatus).catch((e) => toast(clean(e), 'error'))} data-testid="obsidian-rescan">Check now</button>
              <button className="mm-btn" onClick={() => void api.notesVault.openInObsidian().catch((e) => toast(clean(e), 'error'))} data-testid="obsidian-open">Open in Obsidian</button>
            </div>
          </div>
        )}
        {o.enabled && os && os.previousNotes > 0 && (
          <div className="set-row">
            <div className="set-row-text">
              <div className="set-row-title">Copy my existing notes</div>
              <ClampText>Copies the {os.previousNotes} notes in {os.previousRoot} into {o.subfolder}/ (a note that's there already gets a number). That folder stays exactly as it is; turning this off goes back to it.</ClampText>
            </div>
            <div className="set-row-ctl"><button className="mm-btn" disabled={busy} onClick={() => void copy()} data-testid="obsidian-copy">{busy ? 'Copying…' : 'Copy my existing notes'}</button></div>
          </div>
        )}
      </div>
    </>
  )
}

/** The bot details panel's rows: vault on/off and how much this bot remembers. */
export function VaultBotRows({ spaceId }: { spaceId: string }) {
  const [st, setSt] = useState<VaultStatus | null>(null)
  useEffect(() => {
    const load = (): void => { void api.notesVault.status().then(setSt).catch(() => undefined) }
    load()
    return api.notesVault.onChanged(load)
  }, [spaceId])
  if (!st) return null
  const mine = st.settings.bots[spaceId] ?? {}
  const on = st.settings.enabled && mine.enabled !== false
  const level = mine.level ?? st.settings.level
  const set = async (patch: { enabled?: boolean | null; level?: VaultLevel | null }): Promise<void> => {
    try { setSt(await api.notesVault.setBot(spaceId, patch)) } catch (e) { toast(clean(e), 'error') }
  }
  return (
    <>
      <div className="bd-row">
        <span className="bd-row-text">Vault{!st.settings.enabled && <span className="hint"> (off in Settings → Memory)</span>}</span>
        <Toggle on={on} onChange={(v) => void set({ enabled: v ? null : false })} label="Vault" testId="bot-vault" />
      </div>
      {on && (
        <div className="bd-row">
          <span className="bd-row-text">How much to remember</span>
          <div className="vault-seg" role="radiogroup" aria-label="How much to remember">
            {LEVELS.map((l) => <button key={l.v} role="radio" aria-checked={level === l.v} className={level === l.v ? 'on' : ''} onClick={() => void set({ level: l.v === st.settings.level ? null : l.v })} data-testid={`bot-vault-${l.v}`}>{l.label}</button>)}
          </div>
        </div>
      )}
    </>
  )
}
