import { useEffect, useMemo, useState } from 'react'
import type { MemoryImportPreview, MemoryKind } from '@shared/types'
import { IMPORT_SECTION_LABEL, IMPORT_SECTIONS, MEMORY_IMPORT_PROMPT, type ImportSection } from '@shared/memory-import'
import { api } from '../api'
import * as I from '../icons'
import { toast } from '../lib/toast'
import '../styles-vault.css'

// "Import memory to SahilBot": copy a prompt into another assistant, paste what it exports, review every
// item (keep or drop, edit, change its category), then save. Instructions become rules every chat
// follows; everything else becomes shared memories dated by the export. Used from Settings → Memory,
// onboarding (embedded, skippable) and the command palette.

type Row = MemoryImportPreview['items'][number] & { on: boolean; key: number }
type Choice = MemoryKind | 'instruction'

const CHOICES: Array<{ v: Choice; label: string }> = [
  { v: 'instruction', label: 'Instruction (rule)' },
  { v: 'profile', label: 'About you' },
  { v: 'preference', label: 'Preference' },
  { v: 'person', label: 'Person' },
  { v: 'location', label: 'Place' },
  { v: 'work', label: 'Work' },
  { v: 'project', label: 'Project' },
  { v: 'trip', label: 'Trip' },
  { v: 'date', label: 'Date' },
  { v: 'link', label: 'Link' },
  { v: 'rule', label: 'Rule (as a memory)' },
  { v: 'fact', label: 'Other fact' }
]

const clean = (e: unknown): string => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

function shortDate(d: string): string {
  const t = new Date(`${d}T12:00:00Z`)
  return Number.isNaN(t.getTime()) ? d : t.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export interface ImportDone { memories: number; rules: number }

export function ImportMemoryDialog(p: { onClose: () => void; onDone?: (r: ImportDone) => void; embedded?: boolean; cancelTestId?: string }) {
  const [text, setText] = useState('')
  const [preview, setPreview] = useState<MemoryImportPreview | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [showDropped, setShowDropped] = useState(false)

  // Esc closes (the modal form only; onboarding has its own buttons).
  useEffect(() => {
    if (p.embedded) return
    const k = (e: KeyboardEvent): void => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); p.onClose() } }
    window.addEventListener('keydown', k, true)
    return () => window.removeEventListener('keydown', k, true)
  }, [p.embedded, p.onClose])

  const copy = async (): Promise<void> => {
    try {
      await api.memory.copyImportPrompt()
    } catch {
      try { await navigator.clipboard.writeText(MEMORY_IMPORT_PROMPT) } catch { toast('Couldn\'t copy. Select the prompt and press ⌘C.', 'error'); return }
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  const read = async (): Promise<void> => {
    if (!text.trim()) return
    setBusy(true)
    try {
      const pv = await api.memory.importPreview(text)
      setPreview(pv)
      setRows(pv.items.map((i, key) => ({ ...i, on: true, key })))
      setShowDropped(false)
    } catch (e) { toast(clean(e), 'error') } finally { setBusy(false) }
  }

  const picked = rows.filter((r) => r.on && r.content.trim())
  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await api.memory.importSave(picked.map((x) => ({ content: x.content.trim(), category: x.category, date: x.date ?? null, asRule: !!x.asRule })))
      const parts = [r.memories && `${r.memories} ${r.memories === 1 ? 'memory' : 'memories'}`, r.rules && `${r.rules} ${r.rules === 1 ? 'rule' : 'rules'}`].filter(Boolean)
      toast(parts.length ? `Added ${parts.join(' and ')} to SahilBot` : 'Nothing new to add: it was all saved already', 'ok')
      p.onDone?.({ memories: r.memories, rules: r.rules })
    } catch (e) { toast(clean(e), 'error') } finally { setBusy(false) }
  }

  const set = (key: number, patch: Partial<Row>): void => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  const choose = (key: number, v: Choice): void => set(key, v === 'instruction' ? { asRule: true, category: 'rule' } : { asRule: false, category: v })

  const groups = useMemo(() => IMPORT_SECTIONS.map((s) => ({ s, rows: rows.filter((r) => (r.section ?? 'other') === s) })).filter((g) => g.rows.length), [rows])

  const body = preview === null ? (
    <>
      <ol className="imp-steps">
        <li>
          <div className="imp-step-head"><span className="imp-num">1</span>Copy this prompt into a chat with your other AI provider</div>
          <div className="imp-prompt-wrap">
            <div className="imp-prompt" tabIndex={0} aria-label="Prompt to copy" aria-readonly="true" role="textbox" data-testid="memory-import-prompt">{MEMORY_IMPORT_PROMPT}</div>
            <button className={`imp-copy${copied ? ' done' : ''}`} onClick={() => void copy()} data-testid="memory-import-copy">
              {copied ? <><I.Check size={13} />Copied</> : <><I.Copy size={13} />Copy</>}
            </button>
          </div>
          <div className="imp-hint">Works with ChatGPT, Claude, Gemini and most assistants that remember you. Paste it into a new chat there.</div>
        </li>
        <li>
          <div className="imp-step-head"><span className="imp-num">2</span>Paste results below to add to SahilBot's memory</div>
          <textarea className="imp-paste" rows={5} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false}
            placeholder="Paste the whole reply here, code block and all" aria-label="Pasted results" data-testid="memory-import-text" />
          <div className="imp-hint">You'll review every item before anything is saved. Passwords, keys and account numbers are never kept.</div>
        </li>
      </ol>
      <div className="imp-actions">
        <button className="mm-btn" onClick={p.onClose} data-testid={p.cancelTestId ?? 'memory-import-cancel'}>{p.embedded ? 'Skip' : 'Cancel'}</button>
        <button className="mm-btn primary" disabled={!text.trim() || busy} onClick={() => void read()} data-testid="memory-import-preview">{busy ? 'Reading…' : 'Add to memory'}</button>
      </div>
    </>
  ) : (
    <>
      <div className="imp-sum" data-testid="memory-import-summary">
        <b>{rows.length ? `${rows.length} ${rows.length === 1 ? 'item' : 'items'} found` : 'Nothing new to add'}</b>
        {preview.duplicates > 0 && <span>{preview.duplicates} already saved</span>}
        {(preview.dropped?.length ?? 0) > 0 && <button className="link-btn" onClick={() => setShowDropped((v) => !v)} data-testid="memory-import-dropped-toggle">{preview.dropped!.length} left out for safety</button>}
        {rows.length > 1 && (
          <span className="imp-sel">
            <button className="link-btn" onClick={() => setRows(rows.map((r) => ({ ...r, on: true })))}>Select all</button>
            <button className="link-btn" onClick={() => setRows(rows.map((r) => ({ ...r, on: false })))}>None</button>
          </span>
        )}
      </div>
      {preview.complete === false && <div className="imp-note warn" data-testid="memory-import-incomplete"><I.Clock size={13} />Your other AI says this export isn't complete. Ask it to continue, then import the rest the same way.</div>}
      {preview.complete === true && <div className="imp-note"><I.Check size={13} />Your other AI says this export is complete.</div>}
      {preview.truncated && <div className="imp-note warn">That paste was very long, so only the first part was read.</div>}
      {showDropped && (
        <div className="imp-dropped" data-testid="memory-import-dropped">
          {preview.dropped!.map((d, i) => <div key={i} className="imp-drop"><span>{d.text}</span><em>{d.why}</em></div>)}
        </div>
      )}
      <div className="imp-review">
        {groups.map((g) => (
          <div key={g.s} className="imp-group">
            <div className="imp-group-head">{IMPORT_SECTION_LABEL[g.s as ImportSection]}{g.s === 'instructions' && <span> · become rules every chat follows</span>}</div>
            {g.rows.map((r) => (
              <div className={`imp-row${r.on ? '' : ' off'}`} key={r.key} data-testid="memory-import-row">
                <input type="checkbox" checked={r.on} onChange={(e) => set(r.key, { on: e.target.checked })} aria-label="Keep this item" />
                <input className="imp-input" value={r.content} onChange={(e) => set(r.key, { content: e.target.value })} spellCheck={false} aria-label="Item text" />
                {r.date && <span className="imp-date" title={`From ${r.date}`}>{shortDate(r.date)}</span>}
                <select className="mm-select" value={r.asRule ? 'instruction' : r.category} onChange={(e) => choose(r.key, e.target.value as Choice)} aria-label="Category" data-testid="memory-import-kind">
                  {CHOICES.map((c) => <option key={c.v} value={c.v}>{c.label}</option>)}
                </select>
              </div>
            ))}
          </div>
        ))}
        {!rows.length && <div className="imp-empty">Everything in that paste is already saved{preview.dropped?.length ? ', or was left out for safety' : ''}.</div>}
      </div>
      <div className="imp-actions">
        <button className="mm-btn" onClick={() => setPreview(null)} data-testid="memory-import-back">Back</button>
        <span className="imp-grow" />
        <button className="mm-btn" onClick={p.onClose} data-testid={p.cancelTestId ? `${p.cancelTestId}-review` : undefined}>{p.embedded ? 'Skip' : 'Cancel'}</button>
        <button className="mm-btn primary" disabled={!picked.length || busy} onClick={() => void save()} data-testid="memory-import-commit">
          {busy ? 'Saving…' : picked.length ? `Save ${picked.length} to memory` : 'Save to memory'}
        </button>
      </div>
    </>
  )

  if (p.embedded) return <div className="imp imp-embedded" data-testid="memory-import">{body}</div>
  return (
    <div className="scrim imp-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !text.trim()) p.onClose() }}>
      <div className="modal imp" role="dialog" aria-modal="true" aria-labelledby="imp-title" data-testid="memory-import">
        <div className="imp-head">
          <h2 id="imp-title">Import memory to SahilBot</h2>
          <button className="icon-btn" aria-label="Close" onClick={p.onClose}><I.Close size={16} /></button>
        </div>
        {preview === null && <p className="imp-sub">Bring over what another assistant has learned about you, so you don't start from scratch.</p>}
        {body}
      </div>
    </div>
  )
}
