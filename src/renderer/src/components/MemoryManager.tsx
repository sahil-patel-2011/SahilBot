import { useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent } from 'react'
import type { LearningStatus, MemoryItem, MemoryKind, Space } from '@shared/types'
import { api } from '../api'
import * as I from '../icons'
import { toast } from '../lib/toast'
import { LearningLog } from './LearningLog'
import { ImportMemoryDialog } from './ImportMemoryDialog'
import { VaultSettings } from './VaultView'
import { Toggle } from './Toggle'
import { ClampText, Disclosure, InfoTip, SetTabs } from './ui'

// Settings → Memory: one switch ("Remember things automatically": bots save what you tell them and SahilBot
// fills in what they missed while you're away), then what's remembered as a plain list: search, category
// chips, click to edit, delete with Undo. What was learned, the knowledge vault and People & Places are
// one tab or click away; memory off and cloud learning sit under Advanced.

const KINDS: Array<{ k: MemoryKind; label: string; one: string }> = [
  { k: 'profile', label: 'About you', one: 'About you' },
  { k: 'preference', label: 'Preferences', one: 'Preference' },
  { k: 'decision', label: 'Decisions', one: 'Decision' },
  { k: 'person', label: 'People', one: 'Person' },
  { k: 'location', label: 'Places', one: 'Place' },
  { k: 'work', label: 'Work', one: 'Work' },
  { k: 'project', label: 'Projects', one: 'Project' },
  { k: 'date', label: 'Dates', one: 'Date' },
  { k: 'trip', label: 'Trips', one: 'Trip' },
  { k: 'rule', label: 'Rules', one: 'Rule' },
  { k: 'link', label: 'Links', one: 'Link' },
  { k: 'fact', label: 'Other', one: 'Fact' },
  { k: 'worklog', label: 'Work log', one: 'Work log' }
]
const KIND_ONE = Object.fromEntries(KINDS.map((x) => [x.k, x.one])) as Record<MemoryKind, string>
const PAGE = 60

type Draft = { id: string; text: string; kind: MemoryKind; scope: string }

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

/** The learning status, live (Settings → Memory: the switch, Advanced and the Learned tab's count). */
function useLearning(): [LearningStatus | null, () => void] {
  const [st, setSt] = useState<LearningStatus | null>(null)
  const load = (): void => void api.learning.status().then(setSt).catch(() => undefined)
  useEffect(() => {
    load()
    let t: ReturnType<typeof setTimeout> | null = null
    const off = api.learning.onChanged(() => { if (!t) t = setTimeout(() => { t = null; load() }, 250) })
    return () => { off(); if (t) clearTimeout(t) }
  }, [])
  return [st, load]
}

export function MemoryPage({ spaces, tab, onTab }: { spaces: Space[]; tab: string; onTab: (t: string) => void }) {
  const [learn, reloadLearn] = useLearning()
  const [waiting, setWaiting] = useState(0)
  useEffect(() => {
    const load = (): void => void api.learning.list(300).then((xs) => setWaiting(xs.filter((x) => x.pending).length)).catch(() => undefined)
    load()
    return api.learning.onChanged(load)
  }, [])
  const auto = learn?.enabled ?? true
  // Only the switch that changed is sent: it's recorded as the user's own choice (settings.ts).
  const setLearning = async (patch: { enabled?: boolean; cloudAllowed?: boolean; dailyUsd?: number }): Promise<void> => {
    try { await api.settings.set({ learning: patch as never }); reloadLearn() } catch (e) { toast(clean(e), 'error') }
  }
  const tabs = [
    { id: 'memories', label: 'Memories' },
    { id: 'learned', label: <>Learned{waiting > 0 && <span className="set-tab-badge" title="Waiting for your OK">{waiting}</span>}</> },
    { id: 'vault', label: 'Knowledge vault' }
  ]
  const cur = tabs.some((t) => t.id === tab) ? tab : 'memories'
  return (
    <>
      <h2>Memory</h2>
      <div className="set-sub">What your bots know about you. It stays on this Mac.</div>
      <section className="set-section">
        <div className="set-card">
          <div className="set-row" data-setting="remember-auto" data-testid="memory-auto-row">
            <div className="set-row-text">
              <div className="set-row-title">Remember things automatically
                <InfoTip>Bots save lasting things you mention (preferences, decisions, people, places, routines, goals) and tell you in a few words. While SahilBot is open and you're away, it also reviews recent chats for anything they missed, using a local model first or a cloud model within a small daily cap. Passwords and other secrets are never saved; anything from a web page or email is kept only as a quoted fact.</InfoTip>
              </div>
              <ClampText>{auto ? 'Bots save what matters as you talk, and fill in what they missed while you\'re away.' : 'Off: bots save only when you ask them to remember something.'}</ClampText>
            </div>
            <div className="set-row-ctl"><Toggle on={auto} onChange={(v) => void setLearning({ enabled: v })} label="Remember things automatically" testId="memory-auto" /></div>
          </div>
        </div>
      </section>
      <SetTabs value={cur} tabs={tabs} onChange={onTab} label="Memory"
        extra={<button type="button" className="link-btn" data-setting="people-places" onClick={() => window.dispatchEvent(new CustomEvent('sahilbot:open-vault', { detail: { path: null, tab: 'people' } }))} data-testid="memory-people">People &amp; Places <I.External size={12} /></button>} />
      {cur === 'memories' && <MemoryList spaces={spaces} />}
      {cur === 'learned' && <div data-setting="learned"><LearningLog spaces={spaces} /></div>}
      {cur === 'vault' && <div data-setting="knowledge-vault"><VaultSettings /></div>}
      <MemoryAdvanced learn={learn} setLearning={setLearning} />
    </>
  )
}

/** Memory → Advanced: memory itself on or off, cloud learning and its daily cap, and when learning last ran. */
function MemoryAdvanced({ learn, setLearning }: { learn: LearningStatus | null; setLearning: (p: { cloudAllowed?: boolean; dailyUsd?: number }) => Promise<void> }) {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [cap, setCap] = useState('')
  useEffect(() => { void api.memory.getEnabled().then(setEnabled).catch(() => undefined) }, [])
  useEffect(() => { if (learn && cap === '') setCap(learn.settings.dailyUsd.toFixed(2)) }, [learn, cap])
  const toggle = async (on: boolean): Promise<void> => {
    setEnabled(on)
    try {
      await api.memory.setEnabled(on)
      toast(on ? 'Memory is on' : 'Memory is off. Bots won\'t use or save memories.', 'ok')
    } catch (e) { setEnabled(!on); toast(clean(e), 'error') }
  }
  const saveCap = (): void => {
    const n = Number(cap.replace(/[^0-9.]/g, ''))
    if (!Number.isFinite(n) || n < 0) { setCap(learn?.settings.dailyUsd.toFixed(2) ?? '0.25'); return }
    const v = Math.min(5, Math.round(n * 100) / 100)
    setCap(v.toFixed(2))
    if (v !== learn?.settings.dailyUsd) void setLearning({ dailyUsd: v })
  }
  const st = learn
  const line = !st ? 'Loading…'
    : st.running ? `Learning now${st.job ? `: ${st.job.toLowerCase()}` : ''}…`
    : !st.enabled ? 'Background learning is off.'
    : st.blocked ? st.blocked
    : `${st.lastRunAt ? `Last ran ${new Date(st.lastRunAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}${st.lastSummary ? `: ${st.lastSummary}` : ''}.` : 'Runs the first time you\'re away for 2 minutes.'}${st.model ? ` ${st.cloud ? 'Cloud' : 'Local'} model: ${st.model}${st.cloud ? ` · $${st.spentTodayUsd.toFixed(2)} of $${st.settings.dailyUsd.toFixed(2)} today` : ''}.` : ''}`
  return (
    <Disclosure title="Advanced" sub="Memory off, cloud learning" testId="memory-advanced">
      <section className="set-section">
        <div className="set-card">
          <div className="set-row" data-setting="memory-enabled">
            <div className="set-row-text">
              <div className="set-row-title">Use memory</div>
              <ClampText>{enabled === false ? 'Off: bots don\'t read or save memories. What\'s saved is kept until you delete it.' : 'Off stops bots from reading or saving memories at all.'}</ClampText>
            </div>
            <div className="set-row-ctl"><Toggle on={enabled !== false} onChange={(v) => void toggle(v)} label="Use memory" testId="memory-enabled" /></div>
          </div>
          <div className="set-row" data-setting="learning-cloud">
            <div className="set-row-text">
              <div className="set-row-title">Use cloud models for learning<InfoTip>Only when no local model is available. The ChatGPT plan is used first when it's connected; otherwise the cheapest capable model. Stops at the daily cap, counts toward your monthly limit, and is skipped when the monthly limit is None.</InfoTip></div>
              <ClampText>{line}</ClampText>
            </div>
            <div className="set-row-ctl">
              {st?.settings.cloudAllowed && (
                <label className="ll-cap" title="Daily cap for learning">
                  <span>$</span>
                  <input inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} onBlur={saveCap} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} aria-label="Daily cap in dollars" data-testid="learning-cap" />
                  <span>/day</span>
                </label>
              )}
              <Toggle on={!!st?.settings.cloudAllowed} onChange={(v) => void setLearning({ cloudAllowed: v })} label="Use cloud models for learning" testId="learning-cloud" />
            </div>
          </div>
        </div>
      </section>
    </Disclosure>
  )
}

/** The memories themselves: search, category chips, click to edit, delete with Undo, add, import. */
export function MemoryList({ spaces }: { spaces: Space[] }) {
  const [items, setItems] = useState<MemoryItem[] | null>(null)
  const [q, setQ] = useState('')
  const [kind, setKind] = useState<'all' | MemoryKind>('all')
  const [scope, setScope] = useState<'all' | 'me' | string>('all')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [adding, setAdding] = useState<{ text: string; scope: string } | null>(null)
  const [importing, setImporting] = useState(false)
  const [more, setMore] = useState(false)

  const reload = (): void => { void api.memory.list().then(setItems).catch(() => setItems([])) }
  useEffect(reload, [])

  const owners = useMemo(() => spaces.filter((s) => s.kind !== 'group'), [spaces])
  const byId = useMemo(() => new Map(spaces.map((s) => [s.id, s])), [spaces])
  const scopeName = (id: string | null): string => (id ? byId.get(id)?.name ?? 'Removed bot' : 'About you')
  const all = items ?? []
  const bots = useMemo(() => [...new Set(all.filter((m) => m.spaceId).map((m) => m.spaceId!))], [all])
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const inScope = all.filter((m) => scope === 'all' || (scope === 'me' ? !m.spaceId : m.spaceId === scope))
  // The work log is a diary, not facts: it has its own chip and stays out of "All" unless searched.
  const counts = useMemo(() => {
    const c = new Map<string, number>()
    for (const m of inScope) c.set(m.category, (c.get(m.category) ?? 0) + 1)
    return c
  }, [inScope])
  const chips = KINDS.filter((x) => counts.get(x.k))
  const shown = inScope
    .filter((m) => (kind === 'all' ? m.category !== 'worklog' || words.length > 0 : m.category === kind) && matches(m, words, scopeName(m.spaceId)))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const list = more ? shown : shown.slice(0, PAGE)
  useEffect(() => { if (kind !== 'all' && !counts.get(kind)) setKind('all') }, [counts, kind])

  const saveDraft = async (): Promise<void> => {
    if (!draft) return
    const cur = all.find((m) => m.id === draft.id)
    const text = draft.text.trim()
    if (!cur || !text) { setDraft(null); return }
    const sc = draft.scope || null
    if (text !== cur.content || draft.kind !== cur.category || sc !== cur.spaceId) {
      try { await api.memory.update(cur.id, text, { category: draft.kind, spaceId: sc }); reload() } catch (e) { toast(clean(e), 'error') }
    }
    setDraft(null)
  }

  // Deleting is immediate, with Undo in the toast (the same memory comes back: id, kind, scope, dates).
  const forget = async (m: MemoryItem): Promise<void> => {
    try {
      await api.memory.remove(m.id)
      setItems((xs) => (xs ?? []).filter((x) => x.id !== m.id))
      toast('Memory deleted', 'ok', { action: { label: 'Undo', run: () => void api.memory.restore(m).then(reload).catch((e) => toast(clean(e), 'error')) } })
    } catch (e) { toast(clean(e), 'error') }
  }

  const add = async (): Promise<void> => {
    const text = adding?.text.trim()
    if (!adding || !text) return
    try { await api.memory.add(text, adding.scope || null); setAdding({ ...adding, text: '' }); reload() } catch (e) { toast(clean(e), 'error') }
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
            <button className="mm-text" title="Click to edit" onClick={() => setDraft({ id: m.id, text: m.content, kind: m.category, scope: m.spaceId ?? '' })} data-testid="memory-text">{m.content}</button>
          )}
          {!editing && (
            <div className="mm-meta">
              <span>{KIND_ONE[m.category] ?? 'Fact'}</span>
              {m.spaceId && <span className="mm-scope bot" style={sp ? ({ '--mm-dot': sp.color } as CSSProperties) : undefined}><i className="mm-dot" />{scopeName(m.spaceId)}</span>}
              <span>{savedOn(m.updatedAt)}</span>
              {m.source === 'import' && <span>Imported</span>}
              {m.source === 'learned' && <span title="Learned while SahilBot was idle (see the Learned tab)">Learned</span>}
              {m.provenance === 'untrusted' && <span className="ll-tag" title="Saved after reading outside content (a web page, email, another app or bot). Kept for this bot only, shown to it as unverified, never as a rule.">Unverified</span>}
            </div>
          )}
        </div>
        {!editing && (
          <div className="mm-actions">
            <button className="icon-btn" title="Delete" aria-label={`Delete: ${m.content.slice(0, 60)}`} onClick={() => void forget(m)} data-testid="memory-forget"><I.Trash size={14} /></button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="mm" data-testid="memory-manager" data-setting="memory-list">
      <div className="mm-toolbar">
        <label className="mm-search">
          <I.Search size={14} />
          <input placeholder="Search memories" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} aria-label="Search memories" data-testid="memory-search"
            onKeyDown={(e) => { if (e.key === 'Escape' && q) { e.stopPropagation(); setQ('') } }} />
          {q && <button className="mm-clear" aria-label="Clear search" onClick={() => setQ('')}><I.Close size={12} /></button>}
        </label>
        {bots.length > 0 && (
          <select className="mm-select" value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Whose memories" data-testid="memory-scope">
            <option value="all">Everyone</option>
            <option value="me">About you</option>
            {bots.map((id) => <option key={id} value={id}>{scopeName(id)}</option>)}
          </select>
        )}
        <button className="mm-btn" onClick={() => setAdding(adding ? null : { text: '', scope: '' })} data-testid="memory-add-open"><I.Plus size={14} />Add</button>
        <button className="mm-btn" onClick={() => setImporting(true)} data-testid="memory-import-open" data-setting="memory-import"><I.Down size={14} />Import</button>
      </div>

      {chips.length > 1 && (
        <div className="mm-chips" role="tablist" aria-label="Filter by kind">
          <button role="tab" aria-selected={kind === 'all'} className={`mm-chip${kind === 'all' ? ' on' : ''}`} onClick={() => setKind('all')} data-testid="memory-chip-all">All<span>{inScope.filter((m) => m.category !== 'worklog').length}</span></button>
          {chips.map((c) => (
            <button key={c.k} role="tab" aria-selected={kind === c.k} className={`mm-chip${kind === c.k ? ' on' : ''}`} onClick={() => setKind(c.k)} data-testid={`memory-chip-${c.k}`}>{c.label}<span>{counts.get(c.k)}</span></button>
          ))}
        </div>
      )}

      {adding && (
        <div className="set-card mm-add-card">
          <div className="mm-add">
            <input className="set-input" autoFocus placeholder="Something every bot should know, e.g. “My time zone is Eastern”" value={adding.text} aria-label="New memory"
              onChange={(e) => setAdding({ ...adding, text: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') void add(); if (e.key === 'Escape') { e.stopPropagation(); setAdding(null) } }} data-testid="memory-add" />
            <select className="mm-select" value={adding.scope} onChange={(e) => setAdding({ ...adding, scope: e.target.value })} aria-label="Belongs to">
              <option value="">About you</option>
              {owners.map((s) => <option key={s.id} value={s.id}>Only {s.name}</option>)}
            </select>
            <button className="mm-btn primary" disabled={!adding.text.trim()} onClick={() => void add()} data-testid="memory-add-save">Add</button>
          </div>
        </div>
      )}

      {importing && <ImportMemoryDialog onClose={() => setImporting(false)} onDone={() => { setImporting(false); reload() }} />}

      <section className="set-section mm-list">
        <div className="set-card">
          {items === null ? <div className="set-empty">Loading…</div>
            : shown.length === 0 ? (
              <div className="mm-empty">
                {all.length === 0 ? <>Nothing yet. Bots save what matters as you talk (“Noted: …”), or <button className="link-btn" onClick={() => setImporting(true)}>import from ChatGPT, Claude or Gemini</button>.</>
                  : <>No memories match{q ? ` “${q}”` : ''}.</>}
              </div>
            ) : list.map(row)}
          {list.length < shown.length && <button className="link-btn mm-more" onClick={() => setMore(true)}>Show all {shown.length}</button>}
        </div>
      </section>
    </div>
  )
}
