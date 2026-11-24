import { useEffect, useState, type ReactNode } from 'react'
import type { DocInfo, FilePreview, Space, Thread } from '@shared/types'
import { api } from '../api'
import { toast } from '../lib/toast'
import { Mascot, SpaceAvatar } from '../brand'
import * as I from '../icons'
import { BotStatusLine } from './FunctionBots'

export type RecentFile = Awaited<ReturnType<typeof api.files.recent>>[number]

function greeting(name: string): string {
  const first = name.split(' ')[0]
  if (first) return `Welcome, ${first}`
  const h = new Date().getHours()
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

export function ago(t: number): string {
  const s = Math.max(1, Math.round((Date.now() - t) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  if (s < 86400 * 7) return `${Math.round(s / 86400)}d ago`
  return new Date(t).toLocaleDateString()
}

/** A page-like thumbnail of a file SahilBot made: the first lines of a doc, a slide, a sheet, or the image. */
export function FileCard({ f, onOpen }: { f: RecentFile; onOpen: (path: string) => void }) {
  const [pv, setPv] = useState<FilePreview | null>(null)
  const [snip, setSnip] = useState('')
  const ext = f.name.split('.').pop()?.toLowerCase() ?? ''
  useEffect(() => {
    void api.files.preview(f.path).then(setPv).catch(() => setPv(null))
    if (['pdf', 'docx', 'pptx'].includes(ext)) void api.files.snippet(f.path).then(setSnip)
  }, [f.path, ext])
  const lines = (pv?.text || snip || (pv?.slides?.[0]?.texts.join('\n') ?? '')).replace(/[#*_`>]/g, '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 7)
  return (
    <button className="file-card" onClick={() => onOpen(f.path)} title={f.path} data-testid="file-card">
      <div className={`file-thumb t-${ext}`}>
        {pv?.kind === 'image' ? <img src={pv.url} alt="" />
          : pv?.kind === 'video' ? <video src={`${pv.url}#t=0.5`} muted preload="metadata" />
          : pv?.kind === 'sheets' && pv.sheets?.[0] ? (
            <div className="paper sheet">{pv.sheets[0].rows.slice(0, 6).map((r, i) => <div key={i} className="sheet-row">{r.slice(0, 4).map((c, j) => <span key={j}>{String(c ?? '')}</span>)}</div>)}</div>
          ) : (
            <div className={`paper${pv?.kind === 'slides' ? ' slide' : ''}`}>
              {lines.length ? <>
                <div className="paper-title">{lines[0]}</div>
                {lines.slice(1).map((l, i) => <div key={i} className="paper-line">{l}</div>)}
              </> : <>
                <span className="bar w60" /><span className="bar w90" /><span className="bar w80" /><span className="bar w70" />
              </>}
            </div>
          )}
        <span className="file-ext">{ext.toUpperCase()}</span>
      </div>
      <div className="file-meta"><span className="file-name">{f.name}</span><span className="file-when">{ago(f.createdAt)}</span></div>
    </button>
  )
}

/**
 * Your bots, first thing: each one's state, a Talk button (a voice conversation with that bot: it can go do the
 * work and tell you when it's done) and Open (its ongoing chat).
 */
export function BotDeck({ bots, needSpaces, onOpen, onTalk, onNewBot, onSetup }: {
  bots: Space[]
  needSpaces?: Set<string>
  onOpen: (id: string) => void
  onTalk: (id: string) => void
  onNewBot?: () => void
  /** A "New bot" that sets itself up with you in its chat (talk: by voice). */
  onSetup?: (talk: boolean) => void
}) {
  const list = bots.filter((b) => b.kind === 'bot' && !b.hidden && !b.isMain)
  return (
    <section className="bot-deck" data-testid="bot-deck">
      {list.length > 0 && <div className="home-files-head"><span>Your bots</span>{(onSetup || onNewBot) && <button className="link-btn" onClick={() => (onSetup ? onSetup(false) : onNewBot?.())} data-testid="deck-new-bot">New bot</button>}</div>}
      {list.length === 0 ? (
        <div className="bot-card setup" data-testid="deck-make-bot">
          <button className="bot-card-main" onClick={() => (onSetup ? onSetup(false) : onNewBot?.())} title="Set up your first bot">
            <span className="bot-card-new" aria-hidden="true"><I.Plus size={18} /></span>
            <span className="bot-card-text">
              <b>New bot</b>
              <small>A teammate with its own job that keeps working and remembers.</small>
            </span>
          </button>
          <div className="bot-card-actions">
            <button className="btn small primary" onClick={() => onSetup?.(true)} data-testid="deck-setup-talk" disabled={!onSetup}><I.Wave size={14} /> Talk</button>
            <button className="btn small ghost" onClick={() => (onSetup ? onSetup(false) : onNewBot?.())} data-testid="deck-setup">Set up</button>
          </div>
        </div>
      ) : (
        <div className="bot-grid">
          {list.map((b) => (
            <div key={b.id} className={`bot-card${needSpaces?.has(b.id) ? ' needs' : ''}`} data-testid="bot-card" data-id={b.id}>
              <button className="bot-card-main" onClick={() => onOpen(b.id)} title={`Open ${b.name}`}>
                <SpaceAvatar color={b.color} shape={b.shape} icon={b.icon} size={34} />
                <span className="bot-card-text">
                  <b>{b.name}</b>
                  {b.label && <small>{b.label}</small>}
                  {needSpaces?.has(b.id) ? <span className="bot-card-need">Needs you</span> : <BotStatusLine space={b} />}
                </span>
              </button>
              <div className="bot-card-actions">
                <button className="btn small primary" onClick={() => onTalk(b.id)} data-testid="bot-talk" aria-label={`Talk to ${b.name}`}><I.Wave size={14} /> Talk</button>
                <button className="btn small ghost" onClick={() => onOpen(b.id)} data-testid="bot-open">Open</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

/**
 * The home screen, like Grok Bot's: a greeting and the message box, nothing else. No bot cards, idea chips or
 * recent files under it (your bots are in the sidebar; files are in Library).
 */
export function Home({ userName, composer }: {
  userName: string
  onOpenFile?: (path: string) => void
  onViewFiles?: () => void
  composer: ReactNode
  refreshKey?: unknown
}) {
  return (
    <div className="home">
      <div className="home-hero">
        <div className="welcome"><Mascot size={40} /><h1>{greeting(userName)}</h1></div>
        {composer}
      </div>
    </div>
  )
}

/** Everything SahilBot has made, newest first. */
/** Artifact kinds by file extension (the filter chips on the Artifacts page). */
export const ARTIFACT_KINDS = [
  { id: 'docs', label: 'Documents', ext: ['docx', 'doc', 'md', 'txt', 'rtf', 'odt', 'pages', 'html', 'htm'] },
  { id: 'pdf', label: 'PDFs', ext: ['pdf'] },
  { id: 'slides', label: 'Presentations', ext: ['pptx', 'ppt', 'key', 'odp'] },
  { id: 'sheets', label: 'Spreadsheets', ext: ['xlsx', 'xls', 'csv', 'numbers', 'ods', 'tsv'] },
  { id: 'images', label: 'Images', ext: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic', 'avif'] },
  { id: 'media', label: 'Audio & video', ext: ['mp3', 'wav', 'm4a', 'aac', 'mp4', 'mov', 'webm'] }
] as const
export const artifactKind = (name: string): string => {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return ARTIFACT_KINDS.find((k) => (k.ext as readonly string[]).includes(ext))?.id ?? 'other'
}

/** Files the Document tab opens and saves back (src/main/docspace/import.ts EDITABLE). */
const EDITABLE_EXT = /\.(docx|pdf|pptx|md|markdown|txt|html?|xlsx|csv|tsv)$/i

/** Opens a file in its chat's Document tab (App listens for sahilbot:open-doc). */
async function editFile(f: RecentFile): Promise<void> {
  try {
    const d = await api.docs.importFile(f.path, f.threadId)
    window.dispatchEvent(new CustomEvent('sahilbot:open-doc', { detail: d }))
  } catch (e) { toast((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error') }
}

type NewKind = 'doc' | 'slides' | 'sheet' | 'dashboard'
const NEW_KINDS: Array<{ kind: NewKind; label: string; hint: string }> = [
  { kind: 'doc', label: 'Docs', hint: 'Reports, letters, plans' },
  { kind: 'slides', label: 'Slides', hint: 'Decks you and SahilBot build' },
  { kind: 'sheet', label: 'Sheets', hint: 'Tables with formulas' },
  { kind: 'dashboard', label: 'Dashboards', hint: 'Numbers, charts and notes' }
]

function NewKindIcon({ kind }: { kind: NewKind }) {
  const p = { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
  if (kind === 'slides') return <svg {...p}><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M12 17v3M8 21h8M7 9h6M7 12h9" /></svg>
  if (kind === 'dashboard') return <svg {...p}><rect x="3" y="3" width="8" height="8" rx="2" /><rect x="13" y="3" width="8" height="5" rx="2" /><rect x="13" y="10" width="8" height="11" rx="2" /><rect x="3" y="13" width="8" height="8" rx="2" /></svg>
  if (kind === 'sheet') return <svg {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M3 14h18M9 4v16M15 4v16" /></svg>
  return <svg {...p}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></svg>
}

/** Make something new (Docs, Slides, Sheets) and the documents already being worked on. */
function MakeNew() {
  const [recent, setRecent] = useState<Array<DocInfo & { slides: boolean; kind?: 'slides' | 'dashboard' }>>([])
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => { void api.docs.recent?.(12).then(setRecent).catch(() => undefined) }, [])
  const open = (d: { docId: string; threadId: string }): void => { window.dispatchEvent(new CustomEvent('sahilbot:open-doc', { detail: d })) }
  const make = async (kind: NewKind): Promise<void> => {
    setBusy(kind)
    try { open(await api.docs.createNew(kind)) } catch (e) { toast((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error') } finally { setBusy(null) }
  }
  return (
    <>
      <div className="make-new" data-testid="make-new">
        {NEW_KINDS.map((k) => (
          <button key={k.kind} className={`make-tile k-${k.kind}`} onClick={() => void make(k.kind)} disabled={!!busy} data-testid={`make-${k.kind}`}>
            <span className="make-icon"><NewKindIcon kind={k.kind} /></span>
            <b>{k.label}</b>
            <span>{busy === k.kind ? 'Opening…' : k.hint}</span>
          </button>
        ))}
      </div>
      {recent.length > 0 && (
        <>
          <h2 className="page-h2">Your documents</h2>
          <div className="doc-recent" data-testid="doc-recent">
            {recent.map((d) => {
              const kind: NewKind = d.type === 'sheet' ? 'sheet' : d.kind ?? (d.slides ? 'slides' : 'doc')
              return (
                <button key={d.id} className={`doc-recent-card k-${kind}`} onClick={() => open({ docId: d.id, threadId: d.threadId })} title={`Open “${d.title}”`}>
                  <span className="make-icon small"><NewKindIcon kind={kind} /></span>
                  <span className="doc-recent-text"><b>{d.title}</b><span>{kind === 'slides' ? 'Deck' : kind === 'sheet' ? 'Sheet' : kind === 'dashboard' ? 'Dashboard' : 'Document'} · {d.lastAuthor === 'bot' ? 'SahilBot' : 'You'} · {ago(d.updatedAt)}</span></span>
                </button>
              )
            })}
          </div>
          <h2 className="page-h2">Files</h2>
        </>
      )}
    </>
  )
}

/** Artifacts: every file SahilBot's agents made (documents, PDFs, decks, sheets, images, audio), filterable by kind. */
export function FilesView({ onOpenFile, onOpenChat }: { onOpenFile: (path: string) => void; onOpenChat: (threadId: string) => void }) {
  const [files, setFiles] = useState<RecentFile[] | null>(null)
  const [q, setQ] = useState('')
  const [kind, setKind] = useState('all')
  useEffect(() => { void (api.files.artifacts ? api.files.artifacts(500) : api.files.recent(200)).then(setFiles).catch(() => setFiles([])) }, [])
  const counts = new Map<string, number>()
  for (const f of files ?? []) counts.set(artifactKind(f.name), (counts.get(artifactKind(f.name)) ?? 0) + 1)
  const chips = [{ id: 'all', label: 'All', n: files?.length ?? 0 }, ...ARTIFACT_KINDS.map((k) => ({ id: k.id as string, label: k.label as string, n: counts.get(k.id) ?? 0 })), { id: 'other', label: 'Other', n: counts.get('other') ?? 0 }].filter((c) => c.id === 'all' || c.n > 0)
  const shown = (files ?? []).filter((f) => (kind === 'all' || artifactKind(f.name) === kind) && (!q || `${f.name} ${f.threadTitle}`.toLowerCase().includes(q.toLowerCase())))
  return (
    <div className="page" data-testid="files-view">
      <div className="page-head"><h1>Library</h1><input className="set-input page-search" placeholder="Search your library" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="set-sub">Start a doc, deck, sheet or dashboard, or open what your bots made. Click a file to preview it.</div>
      <MakeNew />
      {chips.length > 2 && (
        <div className="artifact-chips" role="tablist" aria-label="Kind" data-testid="artifact-kinds">
          {chips.map((c) => <button key={c.id} role="tab" aria-selected={kind === c.id} className={`artifact-chip${kind === c.id ? ' on' : ''}`} onClick={() => setKind(c.id)} data-testid={`artifact-kind-${c.id}`}>{c.label} <span>{c.n}</span></button>)}
        </div>
      )}
      {files === null ? <div className="hint">Loading…</div> : shown.length === 0 ? <div className="empty-state"><I.File size={22} /><div>{files.length ? 'Nothing matches.' : 'No files yet. Ask a bot for a report, a deck, a spreadsheet or an image, and it shows up here.'}</div></div> : (
        <div className="file-grid">
          {shown.map((f) => (
            <div key={f.path} className="file-wrap">
              <FileCard f={f} onOpen={onOpenFile} />
              <div className="file-actions">
                {EDITABLE_EXT.test(f.name) && <button className="file-edit" onClick={() => void editFile(f)} data-testid="artifact-edit" title="Open in SahilBot's editor: change the text, fonts and layout, then save it back">Edit</button>}
                <button className="file-from" onClick={() => onOpenChat(f.threadId)}>from “{f.threadTitle.replace(/^⏰ /, '')}”</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** All projects as cards, plus New project. */
export function ProjectsView({ spaces, onOpen, onNew }: { spaces: Space[]; onOpen: (id: string) => void; onNew: () => void }) {
  const projects = spaces.filter((s) => s.kind === 'project' && !s.hidden)
  const [counts, setCounts] = useState<Record<string, Thread[]>>({})
  useEffect(() => {
    void Promise.all(projects.map(async (p) => [p.id, await api.threads.list(p.id)] as const)).then((xs) => setCounts(Object.fromEntries(xs)))
  }, [spaces]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="page" data-testid="projects-view">
      <div className="page-head"><h1>Projects</h1><button className="btn primary" onClick={onNew} data-testid="new-project"><I.Plus size={15} /> New project</button></div>
      <div className="set-sub">A project is a folder, instructions and chats that share what they learn with each other.</div>
      {projects.length === 0 ? <div className="empty-state"><I.Folder size={22} /><div>No projects yet. Make one for a client, a codebase or anything you keep coming back to.</div></div> : (
        <div className="project-grid">
          {projects.map((p) => {
            const ts = counts[p.id] ?? []
            return (
              <button key={p.id} className="project-card" onClick={() => onOpen(p.id)}>
                <span className="project-icon" style={{ background: p.color }}><I.Folder size={18} /></span>
                <b>{p.name}</b>
                <span className="hint">{p.folder ? p.folder.replace(/^\/Users\/[^/]+/, '~') : 'No folder'}</span>
                <span className="hint">{ts.length} chat{ts.length === 1 ? '' : 's'}{ts[0] ? ` · ${ago(ts[0].updatedAt)}` : ''}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
