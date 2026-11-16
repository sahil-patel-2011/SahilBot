import { useEffect, useState } from 'react'
import type { Attachment, WorkingFolder } from '@shared/types'
import { api } from '../api'
import * as I from '../icons'
import { categoryFor, chipDetail, folderName, humanSize } from '../lib/attachments'
import { toast } from '../lib/toast'
import { Popover } from './Popover'
import '../styles-attachments.css'

// The composer's attachment pieces: chips (icon, name, type and size, remove, image thumbnails), the
// "Drop files or folders" overlay, live folder counts, and the Working folder chip.

const clean = (e: unknown): string => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

function Icon({ a }: { a: Attachment }) {
  const c = categoryFor(a)
  if (c === 'folder') return <I.Folder size={15} />
  if (c === 'image') return <I.Image size={15} />
  if (c === 'binary') return <I.Paperclip size={15} />
  return <I.File size={15} />
}

/** Chips for what's attached: inline images (data URLs) first, then files and folders. */
export function AttachmentChips({ images, atts, onRemoveImage, onRemove }: {
  images: string[]
  atts: Attachment[]
  onRemoveImage: (i: number) => void
  onRemove: (path: string) => void
}) {
  if (!images.length && !atts.length) return null
  return (
    <div className="attachments" data-testid="attachments">
      {images.map((src, i) => (
        <div className="a image" key={`i${i}`} data-testid="attachment-chip" data-kind="image">
          <img src={src} alt="Pasted image" />
          <button onClick={() => onRemoveImage(i)} aria-label="Remove image" title="Remove">×</button>
        </div>
      ))}
      {atts.map((a) => {
        const thumb = a.kind === 'image' && a.dataUrl
        return (
          <div className={`a ${a.kind}${thumb ? '' : ' att-chip'}`} key={a.path} title={[a.path, a.note].filter(Boolean).join('\n')} data-testid="attachment-chip" data-kind={categoryFor(a)}>
            {thumb ? <img src={a.dataUrl} alt={a.name} /> : (
              <span className="att-pill">
                <Icon a={a} />
                <span className="att-text">
                  <span className="att-name">{a.name}</span>
                  <span className="att-sub" data-testid="attachment-detail">{chipDetail(a)}{a.kind === 'folder' && a.files === undefined ? <span className="att-scan"> · counting…</span> : null}</span>
                </span>
              </span>
            )}
            <button onClick={() => onRemove(a.path)} aria-label={`Remove ${a.name}`} title="Remove">×</button>
          </div>
        )
      })}
    </div>
  )
}

/** Shown over the composer while something is dragged over it. */
export function DropOverlay({ show }: { show: boolean }) {
  if (!show) return null
  return (
    <div className="drop-overlay" data-testid="drop-overlay" aria-hidden>
      <I.Paperclip size={18} /><span>Drop files or folders</span>
    </div>
  )
}

/**
 * Counts what SahilBot can index in attached folders (ignore rules applied), live, so a big folder shows
 * progress: "Folder · 12,400 files". Updates the attachments through `update`.
 */
export function useFolderCounts(atts: Attachment[], update: (path: string, patch: Partial<Attachment>) => void): void {
  const pending = atts.filter((a) => a.kind === 'folder' && a.files === undefined).map((a) => a.path).join('\n')
  useEffect(() => {
    if (!pending) return
    const want = new Set(pending.split('\n'))
    const off = api.attach.onScan((e) => { if (want.has(e.path)) update(e.path, { files: e.files, ...(e.truncated ? { truncated: true } : {}) }) })
    for (const p of want) {
      void api.attach.scanFolder(p).then((r) => update(p, { files: r.files, truncated: !!r.truncated, size: r.bytes })).catch(() => update(p, { files: 0 }))
    }
    return off
  }, [pending])
}

/** Folders picked this session, newest first (main accepts only those: attach:useFolder). Not saved anywhere. */
const recentFolders: string[] = []
const remember = (path: string): void => {
  const i = recentFolders.indexOf(path)
  if (i >= 0) recentFolders.splice(i, 1)
  recentFolders.unshift(path)
  recentFolders.length = Math.min(recentFolders.length, 4)
}

/** The Folder chip's project choices (Home only, before the chat exists). */
export interface FolderProjects {
  list: Array<{ id: string; name: string; color: string; folder: string | null }>
  /** The open project, if any. */
  current: string | null
  onPick: (id: string | null) => void
  onNew: () => void
}

/**
 * One "Folder" chip under the box: where this chat works. A plain folder (relative paths, file tools and
 * commands start there; anywhere else asks first), a project (its folder, instructions and chats) on Home,
 * or a folder picked earlier this session. A new chat (no thread yet) keeps the choice as a draft and sends
 * it with the first message.
 */
export function WorkFolderChip({ threadId, inherited, draft, onDraft, projects }: {
  threadId?: string
  /** The bot's or project's folder, used when the chat doesn't pick one. */
  inherited?: string | null
  draft: string | null
  onDraft: (path: string | null) => void
  projects?: FolderProjects
}) {
  const [wf, setWf] = useState<WorkingFolder | null>(null)
  useEffect(() => {
    setWf(null)
    if (!threadId) return
    const load = (): void => { void api.attach.folder(threadId).then(setWf).catch(() => undefined) }
    load()
    // The first message of a new chat sets its folder in main: look again when that message arrives.
    return api.chat.onEvent((e) => { if (e.threadId === threadId && e.type === 'message' && e.message.role === 'user') load() })
  }, [threadId])
  const path = threadId ? wf?.path ?? null : draft ?? inherited ?? null
  const source = threadId ? wf?.source ?? null : draft ? 'chat' : inherited ? 'bot' : null
  const project = projects?.current ? projects.list.find((x) => x.id === projects.current) : undefined
  const pick = async (): Promise<void> => {
    try {
      if (threadId) { const r = await api.attach.pickFolder(threadId); if (r) { setWf(r); if (r.path) remember(r.path) } }
      else { const r = await api.attach.pick('folder'); const f = r.added.find((a) => a.kind === 'folder'); if (f) { remember(f.path); onDraft(f.path) } }
    } catch (e) { toast(clean(e), 'error') }
  }
  const useRecent = async (dir: string): Promise<void> => {
    try {
      if (threadId) setWf(await api.attach.useFolder(threadId, dir))
      else onDraft(dir)
      remember(dir)
    } catch (e) { toast(clean(e), 'error') }
  }
  const clear = async (): Promise<void> => {
    try {
      if (threadId) setWf(await api.attach.clearFolder(threadId))
      else onDraft(null)
    } catch (e) { toast(clean(e), 'error') }
  }
  const recents = recentFolders.filter((r) => r !== path).slice(0, 3)
  const label = project && !draft ? project.name : path ? folderName(path) : 'Folder'
  const whose = source === 'bot' ? ' (the bot\'s)' : source === 'project' ? ' (the project\'s)' : ''
  return (
    <Popover
      label={<><I.Folder size={14} /><span className="wf-name">{label}</span><I.Chevron size={12} className="wf-chev" /></>}
      className={`under-pick wf-pick${path || project ? ' on' : ''}`}
      title={project && !draft ? `Working in the project ${project.name}${path ? ` (${path})` : ''}` : path ? `Working folder: ${path}${whose}. Files and commands start here; anywhere else asks first.` : 'Choose where this chat works: a folder on your Mac or a project'}
      testId="working-folder">
      {(close) => (
        <div className="wf-menu">
          <div className="menu-head">{project && !draft ? `Project · ${project.name}` : `Folder${source === 'bot' ? ' · the bot\'s' : source === 'project' ? ' · the project\'s' : ''}`}</div>
          {path && <div className="wf-path" data-testid="working-folder-path">{path.replace(/^\/Users\/[^/]+/, '~')}</div>}
          <button className="menu-item" onClick={() => { close(); void pick() }} data-testid="working-folder-pick"><I.Folder size={15} /><span className="wf-item-text">{path ? 'Work in another folder…' : 'Work in a folder…'}<span className="sub">SahilBot reads, writes and runs commands there. Anywhere else asks first.</span></span></button>
          {recents.map((r) => (
            <button key={r} className="menu-item" onClick={() => { close(); void useRecent(r) }} data-testid="working-folder-recent" title={r}><I.Clock size={15} /><span className="wf-item-text">{folderName(r)}<span className="sub">{r.replace(/^\/Users\/[^/]+/, '~')}</span></span></button>
          ))}
          {path && source === 'chat' && <button className="menu-item" onClick={() => { close(); void clear() }} data-testid="working-folder-clear"><I.Close size={15} />{inherited ? 'Use the bot\'s folder' : 'No folder'}</button>}
          {projects && (
            <>
              <div className="menu-sep" />
              <div className="menu-head">Use a project<span className="menu-head-sub">a folder with its own instructions and chats</span></div>
              {projects.list.map((x) => (
                <button key={x.id} className="menu-item" role="menuitemradio" aria-checked={x.id === projects.current} onClick={() => { close(); projects.onPick(x.id) }} data-testid="folder-project">
                  <span className="check">{x.id === projects.current && <I.Check size={14} />}</span>{x.name}
                </button>
              ))}
              {projects.current && <button className="menu-item" onClick={() => { close(); projects.onPick(null) }} data-testid="folder-no-project"><span className="check" />No project</button>}
              <button className="menu-item" onClick={() => { close(); projects.onNew() }} data-testid="folder-new-project"><I.Plus size={15} />New project…</button>
            </>
          )}
        </div>
      )}
    </Popover>
  )
}

export { humanSize }

/** Bot details → "Works in folder": the bot's chats work there (relative paths, commands, search) unless a chat picks its own. */
export function BotFolderRow({ space, onChanged }: { space: { id: string; kind: string; folder: string | null }; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  if (space.kind !== 'bot') return null
  const run = async (f: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try { const r = await f(); if (r) onChanged() } catch (e) { toast(clean(e), 'error') } finally { setBusy(false) }
  }
  return (
    <div className="bd-row" data-testid="bot-folder-row">
      <span className="bd-row-text">Works in folder
        <span className="bd-row-sub">{space.folder ? <span className="bot-folder-path" data-testid="bot-folder-path">{space.folder}</span> : 'Its files and commands start there. Anywhere else asks first.'}</span>
      </span>
      <span style={{ display: 'flex', gap: 6 }}>
        <button className="bd-btn" disabled={busy} onClick={() => void run(() => api.attach.pickBotFolder(space.id))} data-testid="bot-folder-pick">{space.folder ? 'Change…' : 'Choose…'}</button>
        {space.folder && <button className="bd-btn" disabled={busy} onClick={() => void run(() => api.attach.clearBotFolder(space.id))} data-testid="bot-folder-clear" aria-label="Stop working in this folder">None</button>}
      </span>
    </div>
  )
}
