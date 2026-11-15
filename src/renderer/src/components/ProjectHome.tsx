import { useEffect, useState, type ReactNode } from 'react'
import type { KnowledgeHit, Space, Thread } from '@shared/types'
import { api } from '../api'
import * as I from '../icons'
import { KB_CSS, KnowledgeResult, useKnowledgeStatus } from './KnowledgeSettings'

/** A project: a folder, standing instructions, and its own chats. */
export function ProjectHome({ project, onOpen, onEdit, composer }: { project: Space; onOpen: (t: Thread) => void; onEdit: () => void; composer: ReactNode }) {
  const [chats, setChats] = useState<Thread[]>([])
  const [instructions, setInstructions] = useState('')
  useEffect(() => {
    void api.threads.list(project.id).then(setChats)
    void api.spaces.getPrompt(project.id).then(setInstructions)
  }, [project.id])
  return (
    <div className="home project-home" data-testid="project-home">
      <div className="project-head">
        <span className="project-icon" style={{ background: project.color }}><I.Folder size={22} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ margin: 0, textAlign: 'left', fontSize: 26 }}>{project.name}</h1>
          <button className="hint project-folder" onClick={() => project.folder && void api.files.reveal(project.folder)} title="Show in Finder">{project.folder}</button>
        </div>
        <button className="btn" onClick={onEdit}><I.Edit size={14} /> Edit</button>
      </div>
      <div className="project-instructions">
        <b>Instructions</b>
        <div className="hint">{instructions.trim() ? instructions.trim().slice(0, 400) : 'None yet. Add them with Edit: every chat in this project follows them.'}</div>
      </div>
      <ProjectKnowledge project={project} />
      {composer}
      <div className="outputs">
        <h2>Chats in this project</h2>
        {chats.length === 0 && <div className="hint">Start one above. Every chat here works in the project folder: it reads, edits and searches files there and runs commands in it. Drop or paste files, folders and screenshots on the box to attach more.</div>}
        {chats.map((t) => (
          <button key={t.id} className="project-chat" onClick={() => onOpen(t)}>
            <span>{t.title}</span>
            <span className="hint">{new Date(t.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

/** "Knowledge: N files indexed · Search…": the project folder's part of the knowledge base. */
function ProjectKnowledge({ project }: { project: Space }) {
  const [st] = useKnowledgeStatus()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<KnowledgeHit[] | null>(null)
  const [err, setErr] = useState('')
  const src = st?.sources.find((x) => x.kind === 'project' && x.spaceId === project.id) ?? st?.sources.find((x) => !!project.folder && x.path === project.folder)
  if (!st || !project.folder) return null
  const count = src ? (src.problem ? `not indexed (${src.problem})` : `${src.files.toLocaleString()} file${src.files === 1 ? '' : 's'} indexed`) : 'not indexed yet'
  const run = (): void => {
    if (!q.trim() || !src) return
    setErr('')
    void api.knowledge.search(q.trim(), { folder: src.path, k: 6 }).then((r) => setHits(r.hits)).catch((e: Error) => setErr(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')))
  }
  return (
    <div className="project-instructions" data-testid="project-knowledge">
      <div className="kb-block">
        <b>Knowledge</b>
        <span className="hint">{count}{st.indexing && !st.paused ? ' · updating…' : ''}{st.paused ? ' · paused' : ''}</span>
        {src && !src.problem && !open && <button className="link-btn" onClick={() => setOpen(true)} data-testid="project-knowledge-search">Search…</button>}
      </div>
      {open && (
        <form className="kb-block" style={{ marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); run() }}>
          <input className="set-input" autoFocus placeholder={`Search ${project.name}…`} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { setOpen(false); setHits(null) } }} />
          <button className="btn" type="submit"><I.Search size={13} /></button>
        </form>
      )}
      {err && <div className="hint">{err}</div>}
      {open && hits && (hits.length ? <div className="kb-hits">{hits.map((h, i) => <KnowledgeResult key={`${h.citation}-${i}`} h={h} />)}</div> : <div className="hint" style={{ marginTop: 6 }}>No matches in this project.</div>)}
      <style>{KB_CSS}</style>
    </div>
  )
}
