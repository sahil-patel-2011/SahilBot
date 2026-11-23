import { useEffect, useRef, useState } from 'react'
import type { BotImportPreview, Space } from '@shared/types'
import { api } from '../api'
import { SpaceAvatar } from '../brand'
import * as I from '../icons'
import { toast } from '../lib/toast'
import { describeSchedule } from '../routines'

// Share a bot as a file, import one, duplicate one, and the main bot's morning check-in switch.
// The import preview is mounted once (BotShareHost, its own root in main.tsx) and opened from
// anywhere with importBot(): the sidebar, File → Import Bot…, Connect Apps → Bot templates.

const clean = (e: unknown): string => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** Saves the bot as a .sahilbot.json file (save dialog). */
export async function shareBot(space: Pick<Space, 'id' | 'name'>): Promise<void> {
  try {
    const r = await api.bots.exportFile(space.id)
    if (!r) return
    const file = r.path.split('/').pop()
    toast(r.redacted ? `Saved ${file}. Removed ${r.redacted} key${r.redacted === 1 ? '' : 's'}, password${r.redacted === 1 ? '' : 's'} or file path${r.redacted === 1 ? '' : 's'} from it.` : `Saved ${file}`, 'ok')
  } catch (e) { toast(clean(e), 'error') }
}

/** Makes "<name> copy" with the same look, instructions and routines (paused), and opens its chat. */
export async function duplicateBot(space: Pick<Space, 'id' | 'name'>): Promise<void> {
  try {
    await api.bots.duplicate(space.id)
    toast(`Made a copy of ${space.name}`, 'ok')
  } catch (e) { toast(clean(e), 'error') }
}

// ------------------------------------------------------------------ import

type ImportState = { preview: BotImportPreview; onDone?: () => void } | null
let current: ImportState = null
const subs = new Set<(s: ImportState) => void>()
const setImport = (s: ImportState): void => { current = s; subs.forEach((f) => f(s)) }

/** Picks a .sahilbot.json file and shows what it would create; nothing is created until the user confirms. */
export async function importBot(onDone?: () => void): Promise<void> {
  try {
    const preview = await api.bots.importPick()
    if (preview) setImport({ preview, onDone })
  } catch (e) { toast(clean(e), 'error') }
}

/** The import preview dialog. Mounted once; also answers File → Import Bot…. */
export function BotShareHost() {
  const [state, setState] = useState<ImportState>(current)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [read, setRead] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => { subs.add(setState); return () => { subs.delete(setState) } }, [])
  useEffect(() => api.onMenu((a) => { if (a === 'import-bot') void importBot() }), [])
  useEffect(() => { setErr(''); setBusy(false); setRead(false); if (state) setTimeout(() => box.current?.focus()) }, [state])
  useEffect(() => {
    if (!state) return
    // Capture phase: this Esc closes the preview only (not Settings, a panel, or a run underneath).
    const k = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setImport(null) } }
    window.addEventListener('keydown', k, true)
    return () => window.removeEventListener('keydown', k, true)
  }, [state])
  if (!state) return null
  const p = state.preview

  const create = async (): Promise<void> => {
    setBusy(true); setErr('')
    try {
      await api.bots.importConfirm(p.token)
      const done = state.onDone
      setImport(null)
      done?.()
      toast(`Added ${p.name}`, 'ok')
    } catch (e) { setErr(clean(e)); setBusy(false) }
  }

  return (
    <div className="bs-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) setImport(null) }}>
      <div className="bs-dialog" role="dialog" aria-modal="true" aria-labelledby="bs-title" tabIndex={-1} ref={box} data-testid="bot-import-preview">
        <div className="bs-head">
          <SpaceAvatar color={p.color} shape={p.shape} size={56} />
          <div className="bs-head-text">
            <h2 id="bs-title">{p.name}</h2>
            {p.label && <span className="bs-label">{p.label}</span>}
            <span className="bs-file">From {p.fileName}</span>
          </div>
          <button className="bs-x" onClick={() => setImport(null)} aria-label="Cancel" title="Cancel (Esc)"><I.Close size={15} /></button>
        </div>
        {p.description && <p className="bs-desc">{p.description}</p>}

        <div className="bs-warn" role="note">
          <I.Shield size={15} />
          <span>Read the instructions before you add this bot. They become its own instructions, so a shared bot could ask SahilBot to do things you don’t want. Your approval settings still apply, and its routines start paused.</span>
        </div>

        <div className="bs-section">Instructions</div>
        <pre className="bs-instructions" data-testid="bot-import-instructions" onScroll={(e) => { const t = e.currentTarget; if (t.scrollTop + t.clientHeight >= t.scrollHeight - 8) setRead(true) }}>{p.instructions}</pre>

        <div className="bs-section">Routines{p.routines.length ? ` · ${p.routines.length}, added paused` : ''}</div>
        {p.routines.length === 0 ? <div className="bs-empty">None</div> : (
          <ul className="bs-routines">
            {p.routines.map((r, i) => (
              <li key={i}>
                <span className="bs-r-head"><I.Clock size={13} /><b>{r.title}</b><span>{describeSchedule(r.schedule)}</span></span>
                <span className="bs-r-prompt">{r.prompt}</span>
              </li>
            ))}
          </ul>
        )}

        {(p.skills.length > 0 || p.unknownSkills.length > 0) && (
          <>
            <div className="bs-section">Skills</div>
            <div className="bs-chips">
              {p.skills.map((s) => <span key={s} className="bs-chip">{s}</span>)}
              {p.unknownSkills.map((s) => <span key={s} className="bs-chip off" title="Not on this Mac: skipped">{s}</span>)}
            </div>
          </>
        )}
        {p.warnings.length > 0 && <ul className="bs-notes">{p.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
        {err && <div className="bs-err" role="alert">{err}</div>}

        <div className="bs-actions">
          <span className="bs-hint">{read || p.instructions.length < 600 ? 'Nothing is created until you add it.' : 'Scroll through the instructions to read them all.'}</span>
          <button className="btn" onClick={() => setImport(null)} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={() => void create()} disabled={busy} data-testid="bot-import-confirm">{busy ? 'Adding…' : 'Add bot'}</button>
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ bot details rows

/** Bot details: Share as template and Duplicate. (A morning check-in is something you ask the bot for in chat.) */
export function BotShareRows({ space }: { space: Space }) {
  if (space.kind !== 'bot') return null
  return (
    <>
      <div className="bd-section-title">Share</div>
      <div className="bd-card bs-card">
        <button className="bd-row bd-row-btn bs-row-btn" onClick={() => void shareBot(space)} data-testid="bot-share">
          <span className="bs-row-icon"><I.Share size={15} /></span>
          <span className="bd-row-text">Share as template…<span className="bs-row-sub">A file with its look, instructions and routines. No chats, memories or keys.</span></span>
        </button>
        <button className="bd-row bd-row-btn bs-row-btn" onClick={() => void duplicateBot(space)} data-testid="bot-duplicate">
          <span className="bs-row-icon"><I.Copy size={15} /></span>
          <span className="bd-row-text">Duplicate bot</span>
        </button>
      </div>
    </>
  )
}
