import { useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent } from 'react'
import type { MemoryImportPreview, MemoryItem, MemoryKind, Space } from '@shared/types'
import { api } from '../api'
import * as I from '../icons'
import { toast } from '../lib/toast'
import { LearningLog } from './LearningLog'

// Settings → Memory: everything SahilBot remembers, shared ("About you") or per bot. Search, filter,
// edit inline, forget, import from another assistant, or switch memory off.

const KINDS: Array<{ k: MemoryKind; label: string; one: string }> = [
  { k: 'profile', label: 'About you', one: 'About you' },
  { k: 'preference', label: 'Preferences', one: 'Preference' },
  { k: 'rule', label: 'Rules', one: 'Rule' },
  { k: 'person', label: 'People', one: 'Person' },
  { k: 'location', label: 'Places', one: 'Place' },
  { k: 'work', label: 'Work', one: 'Work' },
  { k: 'project', label: 'Projects', one: 'Project' },
  { k: 'trip', label: 'Trips', one: 'Trip' },
  { k: 'date', label: 'Dates', one: 'Date' },
  { k: 'link', label: 'Links', one: 'Link' },
  { k: 'fact', label: 'Other facts', one: 'Fact' },
  { k: 'worklog', label: 'Work log', one: 'Work log' }
]
const KIND_ONE = Object.fromEntries(KINDS.map((x) => [x.k, x.one])) as Record<MemoryKind, string>
const LOG_PREVIEW = 6

type Filter = 'all' | 'me' | string
type Draft = { id: string; text: string; kind: MemoryKind; scope: string }
type PreviewRow = MemoryImportPreview['items'][number] & { on: boolean }

const clean = (e: unknown): string => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

function savedOn(t: number): string {
  const d = new Date(t)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })
}

function matches(m: MemoryItem, words: string[], scopeName: string): boolean {
  if (!words.length) return true
  const hay = `${m.content} ${KIND_ONE[m.category] ?? ''} ${scopeName}`.toLowerCase()
  return words.every((w) => hay.includes(w))
}

export function MemoryManager({ spaces }: { spaces: Space[] }) {
  const [items, setItems] = useState<MemoryItem[] | null>(null)
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [adding, setAdding] = useState({ text: '', scope: '' })
  const [openLogs, setOpenLogs] = useState(false)
  const [importing, setImporting] = useState(false)

  const reload = (): void => { void api.memory.list().then(setItems) }
  useEffect(() => {
    reload()
    void api.memory.getEnabled().then(setEnabled)
  }, [])

  const owners = useMemo(() => spaces.filter((s) => s.kind !== 'group'), [spaces])
  const byId = useMemo(() => new Map(spaces.map((s) => [s.id, s])), [spaces])
  const scopeName = (id: string | null): string => (id ? byId.get(id)?.name ?? 'Removed bot' : 'About you')
  const all = items ?? []

  // Chips: All, About you, then each bot or project that has memories of its own.
  const chips = useMemo(() => {
    const counts = new Map<string, number>()
    for (const m of all) if (m.spaceId) counts.set(m.spaceId, (counts.get(m.spaceId) ?? 0) + 1)
    return [...counts.entries()].map(([id, n]) => ({ id, n, space: byId.get(id) })).sort((a, b) => (a.space?.isMain ? -1 : 0) - (b.space?.isMain ? -1 : 0) || b.n - a.n)
  }, [all, byId])
  useEffect(() => {
    if (filter !== 'all' && filter !== 'me' && !chips.some((c) => c.id === filter)) setFilter('all')
  }, [chips, filter])

  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = all.filter((m) => (filter === 'all' || (filter === 'me' ? !m.spaceId : m.spaceId === filter)) && matches(m, words, scopeName(m.spaceId)))
  const groups = KINDS.map(({ k, label }) => {
    const ms = shown.filter((m) => m.category === k)
    ms.sort((a, b) => (k === 'worklog' ? b.createdAt - a.createdAt : b.updatedAt - a.updatedAt))
    return { k, label, ms }
  }).filter((g) => g.ms.length)

  const toggle = async (on: boolean): Promise<void> => {
    setEnabled(on)
    try {
      await api.memory.setEnabled(on)
      toast(on ? 'Memory is on' : 'Memory is off. Bots won\'t use or save memories.', 'ok')
    } catch (e) {
      setEnabled(!on)
      toast(clean(e), 'error')
    }
  }

  const saveDraft = async (): Promise<void> => {
    if (!draft) return
    const cur = all.find((m) => m.id === draft.id)
    const text = draft.text.trim()
    if (!cur || !text) { setDraft(null); return }
    const scope = draft.scope || null
    if (text !== cur.content || draft.kind !== cur.category || scope !== cur.spaceId) {
      try {
        await api.memory.update(cur.id, text, { category: draft.kind, spaceId: scope })
        reload()
      } catch (e) { toast(clean(e), 'error') }
    }
    setDraft(null)
  }

  const forget = async (m: MemoryItem): Promise<void> => {
    setConfirm(null)
    try {
      await api.memory.remove(m.id)
      setItems((xs) => (xs ?? []).filter((x) => x.id !== m.id))
      toast('Forgotten', 'ok')
    } catch (e) { toast(clean(e), 'error') }
  }

  const add = async (): Promise<void> => {
    const text = adding.text.trim()
    if (!text) return
    try {
      await api.memory.add(text, adding.scope || null)
      setAdding((a) => ({ ...a, text: '' }))
      reload()
    } catch (e) { toast(clean(e), 'error') }
  }

  const editKeys = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') { e.stopPropagation(); setDraft(null) }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void saveDraft() }
  }

  const row = (m: MemoryItem) => {
    const sp = m.spaceId ? byId.get(m.spaceId) : undefined
    const editing = draft?.id === m.id
    return (
      <div className={`mm-row${editing ? ' editing' : ''}`} key={m.id} data-testid="memory-row">
        <div className="mm-main">
          {editing ? (
            <>
              <textarea className="mm-edit" autoFocus rows={Math.min(5, Math.max(1, Math.ceil(draft.text.length / 70)))} value={draft.text}
                onChange={(e) => setDraft({ ...draft, text: e.target.value })} onKeyDown={editKeys} aria-label="Edit memory" data-testid="memory-edit" />
              <div className="mm-edit-bar">
                <select className="mm-select" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as MemoryKind })} aria-label="Kind">
                  {KINDS.map((x) => <option key={x.k} value={x.k}>{x.one}</option>)}
                </select>
                <select className="mm-select" value={draft.scope} onChange={(e) => setDraft({ ...draft, scope: e.target.value })} aria-label="Belongs to">
                  <option value="">About you (every bot)</option>
                  {owners.map((s) => <option key={s.id} value={s.id}>Only {s.name}</option>)}
                </select>
                <span className="mm-grow" />
                <button className="mm-btn" onClick={() => setDraft(null)}>Cancel</button>
                <button className="mm-btn primary" onClick={() => void saveDraft()} data-testid="memory-save">Save</button>
              </div>
            </>
          ) : (
            <button className="mm-text" title="Click to edit" onClick={() => { setConfirm(null); setDraft({ id: m.id, text: m.content, kind: m.category, scope: m.spaceId ?? '' }) }}>{m.content}</button>
          )}
          {!editing && (
            <div className="mm-meta">
              <span className={`mm-scope${m.spaceId ? ' bot' : ''}`} style={sp ? ({ '--mm-dot': sp.color } as CSSProperties) : undefined}>
                {m.spaceId && <i className="mm-dot" />}{m.spaceId ? scopeName(m.spaceId) : 'About you'}
              </span>
              <span>Saved {savedOn(m.createdAt)}</span>
              {m.updatedAt - m.createdAt > 60_000 && <span>Updated {savedOn(m.updatedAt)}</span>}
              {m.source === 'import' && <span>Imported</span>}
              {m.source === 'you' && <span>Added by you</span>}
              {m.source === 'learned' && <span title="Learned while SahilBot was idle (see What I learned below)">Learned</span>}
              {m.provenance === 'untrusted' && <span className="ll-tag" title="Saved after reading outside content (a web page, email, another app or bot). Kept for this bot only, shown to it as unverified, never as a rule.">Unverified (from outside content)</span>}
            </div>
          )}
        </div>
        {!editing && (confirm === m.id ? (
          <div className="mm-confirm" role="group" aria-label="Confirm forget">
            <span>Forget this?</span>
            <button className="mm-btn" onClick={() => setConfirm(null)}>Keep</button>
            <button className="mm-btn danger" autoFocus onClick={() => void forget(m)} data-testid="memory-forget-confirm">Forget</button>
          </div>
        ) : (
          <div className="mm-actions">
            <button className="icon-btn" title="Edit" aria-label="Edit" onClick={() => setDraft({ id: m.id, text: m.content, kind: m.category, scope: m.spaceId ?? '' })}><I.Edit size={14} /></button>
            <button className="icon-btn" title="Forget" aria-label="Forget" onClick={() => setConfirm(m.id)} data-testid="memory-forget"><I.Trash size={14} /></button>
          </div>
        ))}
      </div>
    )
  }

  const meCount = all.filter((m) => !m.spaceId).length

  return (
    <div className={`mm${enabled === false ? ' off' : ''}`} data-testid="memory-manager">
      <section className="set-section">
        <div className="set-card">
          <div className="set-row">
            <div className="set-row-text">
              <div className="set-row-title">Use memory</div>
              <div className="set-row-sub">{enabled === false
                ? 'Off: bots don\'t read or save memories. What\'s saved below is kept until you delete it.'
                : 'Bots remember what matters across chats: facts about you are shared, each bot keeps its own rules and work log.'}</div>
            </div>
            <div className="set-row-ctl">
              <button role="switch" aria-checked={enabled !== false} aria-label="Use memory" className={`switch${enabled !== false ? ' on' : ''}`} onClick={() => void toggle(enabled === false)} data-testid="memory-enabled"><i /></button>
            </div>
          </div>
        </div>
      </section>

      <div className="mm-toolbar">
        <label className="mm-search">
          <I.Search size={14} />
          <input placeholder="Search memories" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} data-testid="memory-search"
            onKeyDown={(e) => { if (e.key === 'Escape' && q) { e.stopPropagation(); setQ('') } }} />
          {q && <button className="mm-clear" aria-label="Clear search" onClick={() => setQ('')}><I.Close size={12} /></button>}
        </label>
        <button className={`mm-btn${importing ? ' on' : ''}`} onClick={() => setImporting((v) => !v)} data-testid="memory-import-open"><I.Down size={14} />Import memories</button>
      </div>

      <div className="mm-chips" role="tablist" aria-label="Filter memories">
        <button role="tab" aria-selected={filter === 'all'} className={`mm-chip${filter === 'all' ? ' on' : ''}`} onClick={() => setFilter('all')}>All<span>{all.length}</span></button>
        <button role="tab" aria-selected={filter === 'me'} className={`mm-chip${filter === 'me' ? ' on' : ''}`} onClick={() => setFilter('me')}>About you<span>{meCount}</span></button>
        {chips.map((c) => (
          <button key={c.id} role="tab" aria-selected={filter === c.id} className={`mm-chip${filter === c.id ? ' on' : ''}`} onClick={() => setFilter(c.id)}
            style={c.space ? ({ '--mm-dot': c.space.color } as CSSProperties) : undefined}>
            <i className="mm-dot" />{c.space?.name ?? 'Removed bot'}<span>{c.n}</span>
          </button>
        ))}
      </div>

      {importing && <ImportPanel onClose={() => setImporting(false)} onDone={() => { setImporting(false); reload() }} />}

      <section className="set-section mm-list">
        {items === null ? <div className="set-card"><div className="set-empty">Loading…</div></div>
          : groups.length === 0 ? (
            <div className="set-card"><div className="mm-empty">
              {all.length === 0 ? <>Nothing yet. Bots save things as you talk (“I'll remember that…”), or add one below, or <button className="link-btn" onClick={() => setImporting(true)}>import from ChatGPT or Claude</button>.</>
                : <>No memories match{q ? ` “${q}”` : ''}.</>}
            </div></div>
          ) : groups.map((g) => {
            const ms = g.k === 'worklog' && !openLogs && !words.length ? g.ms.slice(0, LOG_PREVIEW) : g.ms
            return (
              <div className="mm-group" key={g.k}>
                <div className="mm-group-head"><span>{g.label}</span><span className="mm-count">{g.ms.length}</span></div>
                <div className="set-card">
                  {ms.map(row)}
                  {ms.length < g.ms.length && <button className="link-btn mm-more" onClick={() => setOpenLogs(true)}>Show all {g.ms.length}</button>}
                </div>
              </div>
            )
          })}
      </section>

      <section className="set-section">
        <div className="set-label">Add a memory</div>
        <div className="set-card">
          <div className="mm-add">
            <input className="set-input" placeholder="Something every bot should know, e.g. “My time zone is Eastern”" value={adding.text}
              onChange={(e) => setAdding({ ...adding, text: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') void add() }} data-testid="memory-add" />
            <select className="mm-select" value={adding.scope} onChange={(e) => setAdding({ ...adding, scope: e.target.value })} aria-label="Belongs to">
              <option value="">About you</option>
              {owners.map((s) => <option key={s.id} value={s.id}>Only {s.name}</option>)}
            </select>
            <button className="mm-btn primary" disabled={!adding.text.trim()} onClick={() => void add()}><I.Plus size={14} />Add</button>
          </div>
        </div>
      </section>

      <LearningLog spaces={spaces} />
    </div>
  )
}

/** Paste an export from another assistant → preview with checkboxes → add the chosen lines (shared). */
function ImportPanel({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState('')
  const [rows, setRows] = useState<PreviewRow[] | null>(null)
  const [counts, setCounts] = useState({ duplicates: 0, skipped: 0 })
  const [busy, setBusy] = useState(false)

  const preview = async (): Promise<void> => {
    setBusy(true)
    try {
      const p = await api.memory.importPreview(text)
      setRows(p.items.map((i) => ({ ...i, on: true })))
      setCounts({ duplicates: p.duplicates, skipped: p.skipped })
    } catch (e) { toast(clean(e), 'error') } finally { setBusy(false) }
  }

  const picked = (rows ?? []).filter((r) => r.on && r.content.trim())
  const commit = async (): Promise<void> => {
    setBusy(true)
    try {
      const n = await api.memory.importCommit(picked.map((r) => ({ content: r.content.trim(), category: r.category })))
      toast(n === 1 ? 'Added 1 memory' : `Added ${n} memories`, 'ok')
      onDone()
    } catch (e) { toast(clean(e), 'error') } finally { setBusy(false) }
  }
  const set = (i: number, patch: Partial<PreviewRow>): void => setRows((rs) => (rs ?? []).map((r, j) => (j === i ? { ...r, ...patch } : r)))

  return (
    <section className="set-section mm-import" data-testid="memory-import">
      <div className="set-card">
        <div className="mm-import-head">
          <div>
            <div className="set-row-title">Import memories</div>
            <div className="set-row-sub">
              From ChatGPT: Settings → Personalization → Manage memories, select everything and copy. From Claude or another assistant: ask it to
              “list everything you remember about me”, then copy the answer. Any notes work too, one fact per line. Imports are shared with every bot.
            </div>
          </div>
          <button className="icon-btn" aria-label="Close import" onClick={onClose}><I.Close size={14} /></button>
        </div>
        {rows === null ? (
          <>
            <textarea className="mm-paste" rows={8} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} autoFocus
              placeholder={'- Prefers concise answers\n- Lives in Atlanta, GA\n- Always ask before sending email'} data-testid="memory-import-text" />
            <div className="mm-import-bar">
              <span className="mm-hint">Nothing is saved until you choose what to add.</span>
              <span className="mm-grow" />
              <button className="mm-btn primary" disabled={!text.trim() || busy} onClick={() => void preview()} data-testid="memory-import-preview">{busy ? 'Reading…' : 'Preview'}</button>
            </div>
          </>
        ) : (
          <>
            <div className="mm-import-sum">
              {rows.length ? `Found ${rows.length} new ${rows.length === 1 ? 'memory' : 'memories'}` : 'Nothing new to add'}
              {counts.duplicates > 0 && ` · ${counts.duplicates} already saved`}
              {counts.skipped > 0 && ` · ${counts.skipped} lines skipped (headings, filler or secrets)`}
              {rows.length > 1 && (
                <span className="mm-sel">
                  <button className="link-btn" onClick={() => setRows(rows.map((r) => ({ ...r, on: true })))}>All</button>
                  <button className="link-btn" onClick={() => setRows(rows.map((r) => ({ ...r, on: false })))}>None</button>
                </span>
              )}
            </div>
            <div className="mm-preview">
              {rows.map((r, i) => (
                <label className={`mm-prow${r.on ? '' : ' off'}`} key={i} data-testid="memory-import-row">
                  <input type="checkbox" checked={r.on} onChange={(e) => set(i, { on: e.target.checked })} />
                  <input className="mm-pinput" value={r.content} onChange={(e) => set(i, { content: e.target.value })} spellCheck={false} aria-label="Memory text" />
                  <select className="mm-select" value={r.category} onChange={(e) => set(i, { category: e.target.value as MemoryKind })} aria-label="Kind">
                    {KINDS.filter((x) => x.k !== 'worklog').map((x) => <option key={x.k} value={x.k}>{x.one}</option>)}
                  </select>
                </label>
              ))}
            </div>
            <div className="mm-import-bar">
              <button className="mm-btn" onClick={() => setRows(null)}>Back</button>
              <span className="mm-grow" />
              <button className="mm-btn primary" disabled={!picked.length || busy} onClick={() => void commit()} data-testid="memory-import-commit">
                {busy ? 'Adding…' : `Add ${picked.length || ''} to memory`.replace('  ', ' ')}
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  )
}
