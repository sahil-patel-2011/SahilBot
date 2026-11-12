import { useEffect, useState, type ReactNode } from 'react'
import type { Space, Thread } from '@shared/types'
import { api } from '../api'
import * as I from '../icons'

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
      {composer}
      <div className="outputs">
        <h2>Chats in this project</h2>
        {chats.length === 0 && <div className="hint">Start one above. Every chat here can read and edit files in the project folder.</div>}
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
