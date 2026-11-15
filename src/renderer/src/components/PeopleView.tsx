import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ContextEngineStatus, EntityCard, EntitySummary, EntityType, Trust } from '@shared/context-engine'
import { ENTITY_TYPES, SENSITIVE_CATEGORIES } from '@shared/context-engine'
import { api } from '../api'
import * as I from '../icons'
import { toast } from '../lib/toast'
import { Toggle } from './Toggle'
import { ClampText } from './ui'
import '../styles-people.css'

// Vault → People & Places: what SahilBot knows about the people, places and things in the user's life
// (src/main/context-engine). Cards with every fact's source and date; edit, merge, forget (with Undo);
// and the privacy panel: which sources it learns from, sensitive categories, export, pause.

const TYPE_LABEL: Record<EntityType, string> = {
  person: 'People', place: 'Places', organization: 'Organizations', project: 'Projects', event: 'Events', date: 'Dates', item: 'Things',
  topic: 'Topics', preference: 'Preferences', routine: 'Routines', goal: 'Goals'
}
const TRUST_LABEL: Record<Trust, string> = { user: 'You said', observed: 'Seen', quoted: 'Quoted' }
const TRUST_HINT: Record<Trust, string> = {
  user: 'Your own words (or your edit).',
  observed: 'Seen by SahilBot: a calendar event, who emailed you, or the assistant\'s own work.',
  quoted: 'Written by someone else (an email, a file, an app). Bots read it as data, never as instructions.'
}
const clean = (e: unknown): string => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const day = (t: number): string => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
const keyLabel = (k: string): string => k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())

function openVault(path: string): void {
  window.dispatchEvent(new CustomEvent('sahilbot:open-vault', { detail: { path } }))
}

export function PeopleView(p: { onOpenNote?: (path: string) => void }) {
  const [tab, setTab] = useState<'cards' | 'privacy'>('cards')
  const [list, setList] = useState<EntitySummary[] | null>(null)
  const [q, setQ] = useState('')
  const [type, setType] = useState<EntityType | 'all'>('all')
  const [id, setId] = useState<string | null>(null)
  const [card, setCard] = useState<EntityCard | null>(null)
  const [status, setStatus] = useState<ContextEngineStatus | null>(null)

  const load = useCallback(async (): Promise<void> => {
    const [ls, st] = await Promise.all([api.people.list({ query: q.trim() || undefined, type: type === 'all' ? undefined : type }), api.people.status()])
    setList(ls)
    setStatus(st)
  }, [q, type])
  useEffect(() => { void load(); return api.people.onChanged(() => void load()) }, [load])
  useEffect(() => {
    if (!id) { setCard(null); return }
    let live = true
    void api.people.card(id).then((c) => { if (live) setCard(c) })
    return () => { live = false }
  }, [id, list])
  useEffect(() => { if (!id && list?.length) setId(list.find((x) => !x.isUser)?.id ?? list[0].id) }, [list, id])

  const types = useMemo(() => ENTITY_TYPES.filter((t) => (status?.byType[t] ?? 0) > 0), [status])
  const groups = useMemo(() => ENTITY_TYPES.map((t) => ({ t, xs: (list ?? []).filter((x) => x.type === t) })).filter((g) => g.xs.length), [list])

  const forgotten = async (trashId: string, name: string): Promise<void> => {
    setId(null)
    await load()
    toast(`Forgot everything about ${name}.`, 'ok', { action: { label: 'Undo', run: () => void api.people.undo(trashId).then((c) => { if (c) setId(c.id); void load(); toast('Put back.', 'ok') }).catch((e) => toast(clean(e), 'error')) } })
  }

  return (
    <div className="ppl" data-testid="people-view">
      <aside className="ppl-side">
        <div className="ppl-side-head">
          <label className="vault-search">
            <I.Search size={14} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people, places, things" aria-label="Search people and places" data-testid="people-search" />
          </label>
          {types.length > 1 && (
            <div className="vault-filters" role="tablist" aria-label="Kinds">
              <button className={`vault-chip${type === 'all' ? ' on' : ''}`} onClick={() => setType('all')}>All</button>
              {types.map((t) => <button key={t} className={`vault-chip${type === t ? ' on' : ''}`} onClick={() => setType(t)}>{TYPE_LABEL[t]}</button>)}
            </div>
          )}
        </div>
        <div className="vault-list">
          {list === null ? <div className="vault-empty">Loading…</div> : !list.length ? (
            <div className="vault-empty">Nothing yet. While SahilBot is open and idle it learns who and what you talk about (from chats, files and the apps you allow) and keeps it here, with where each fact came from.</div>
          ) : groups.map((g) => (
            <div key={g.t}>
              <div className="vault-group">{TYPE_LABEL[g.t]}</div>
              {g.xs.map((x) => (
                <button key={x.id} className={`vault-item${x.id === id ? ' on' : ''}`} onClick={() => { setId(x.id); setTab('cards') }} data-testid="people-item">
                  <b>{x.isUser ? `${x.name} (you)` : x.name}</b>
                  <span>{x.subtitle}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </aside>
      <section className="ppl-main">
        <div className="vault-bar">
          <div className="vault-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'cards'} className={tab === 'cards' ? 'on' : ''} onClick={() => setTab('cards')} data-testid="people-tab-cards">Card</button>
            <button role="tab" aria-selected={tab === 'privacy'} className={tab === 'privacy' ? 'on' : ''} onClick={() => setTab('privacy')} data-testid="people-tab-privacy">Privacy</button>
          </div>
          <span className="grow" />
          {status && <span className="hint">{status.entities} entries · {status.facts} facts{status.settings.paused ? ' · learning paused' : ''}</span>}
          <button className="mm-btn" onClick={() => void api.people.learnNow().then(setStatus).catch((e) => toast(clean(e), 'error'))} title="Read recent chats and files for people and places now">Learn now</button>
        </div>
        {tab === 'cards' ? (
          card ? <CardView card={card} all={list ?? []} onChanged={(c) => { setCard(c); void load() }} onForgot={forgotten} onOpenNote={p.onOpenNote ?? openVault} /> : <div className="vault-empty">Pick someone or something on the left.</div>
        ) : status && <PrivacyPanel status={status} onChange={setStatus} onUndo={async (t) => { try { const c = await api.people.undo(t); await load(); if (c) { setId(c.id); setTab('cards') } toast('Put back.', 'ok') } catch (e) { toast(clean(e), 'error') } }} />}
      </section>
    </div>
  )
}

function CardView({ card, all, onChanged, onForgot, onOpenNote }: { card: EntityCard; all: EntitySummary[]; onChanged: (c: EntityCard | null) => void; onForgot: (trashId: string, name: string) => void; onOpenNote: (path: string) => void }) {
  const [name, setName] = useState<string | null>(null)
  const [fact, setFact] = useState<{ key: string; value: string; id?: string } | null>(null)
  const [merging, setMerging] = useState(false)
  const [confirm, setConfirm] = useState(false)
  useEffect(() => { setName(null); setFact(null); setMerging(false); setConfirm(false) }, [card.id])
  const patch = async (pt: Parameters<typeof api.people.update>[1]): Promise<void> => {
    try { onChanged(await api.people.update(card.id, pt)) } catch (e) { toast(clean(e), 'error') }
  }
  const forget = async (): Promise<void> => {
    try { const r = await api.people.forget(card.id); onForgot(r.trashId, card.name) } catch (e) { toast(clean(e), 'error') }
  }
  const mergeFrom = async (fromId: string): Promise<void> => {
    try { onChanged(await api.people.merge(card.id, fromId)); setMerging(false); toast('Merged. Undo is under Privacy → Recently removed.', 'ok') } catch (e) { toast(clean(e), 'error') }
  }
  return (
    <div className="vault-doc" data-testid="people-card">
      <div className="vault-doc-inner">
        {name === null ? (
          <h1 className="vault-note-title ppl-title" data-testid="people-card-name">{card.isUser ? `${card.name} (you)` : card.name}
            <button className="icon-btn" title="Rename" aria-label="Rename" onClick={() => setName(card.name)}><I.Edit size={14} /></button>
          </h1>
        ) : (
          <form className="ppl-row-form" onSubmit={(e) => { e.preventDefault(); void patch({ name: name.trim() }).then(() => setName(null)) }}>
            <input className="ppl-input" value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" autoFocus />
            <button className="mm-btn" type="submit">Save</button>
            <button className="mm-btn" type="button" onClick={() => setName(null)}>Cancel</button>
          </form>
        )}
        <div className="vault-meta">
          <select className="ppl-select" value={card.type} onChange={(e) => void patch({ type: e.target.value as EntityType })} aria-label="Kind">
            {ENTITY_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t].replace(/s$/, '')}</option>)}
          </select>
          {card.subtitle !== card.type && <span className="vault-tag">{card.subtitle}</span>}
          <span className="vault-tag">Updated {day(card.updatedAt)}</span>
          {card.trust === 'quoted' && <span className="vault-tag quoted" title={TRUST_HINT.quoted}>Only from outside content</span>}
          <span className="grow" />
          {card.vaultPath && <button className="link-btn" onClick={() => onOpenNote(card.vaultPath!)}>Vault note</button>}
          {!card.isUser && <button className="link-btn" onClick={() => setMerging((v) => !v)} data-testid="people-merge">Merge…</button>}
          {!card.isUser && (confirm
            ? <span className="ppl-confirm">Forget everything about {card.name}? <button className="mm-btn danger" onClick={() => void forget()} data-testid="people-forget-confirm">Forget</button><button className="mm-btn" onClick={() => setConfirm(false)}>Cancel</button></span>
            : <button className="link-btn danger" onClick={() => setConfirm(true)} data-testid="people-forget"><I.Trash size={13} />Forget</button>)}
        </div>
        {merging && (
          <div className="ppl-merge">
            <ClampText>Pick the duplicate to fold into {card.name}: its names, facts and links move here (Undo puts them back).</ClampText>
            <div className="ppl-merge-list">
              {all.filter((x) => x.id !== card.id && !x.isUser && (x.type === card.type || (['place', 'organization'].includes(x.type) && ['place', 'organization'].includes(card.type)))).slice(0, 40).map((x) => (
                <button key={x.id} className="vault-chip" onClick={() => void mergeFrom(x.id)}>{x.name}</button>
              ))}
            </div>
          </div>
        )}

        <h3 className="ppl-h">Facts</h3>
        <div className="ppl-facts">
          {!card.attributes.length && <div className="ppl-muted">No facts yet.</div>}
          {card.attributes.map((a) => (
            <div key={a.id} className="ppl-fact" data-testid="people-fact">
              <span className="ppl-key">{keyLabel(a.key)}</span>
              <span className="ppl-val">{a.value}</span>
              <span className={`ppl-src ${a.trust}`} title={`${TRUST_HINT[a.trust]}${a.corrected ? ' You set this; learning never changes it.' : ''}`}>{a.corrected ? 'You set' : TRUST_LABEL[a.trust]} · {a.source.label ?? a.source.kind} · {day(a.at)}</span>
              <button className="icon-btn" title="Edit" aria-label={`Edit ${a.key}`} onClick={() => setFact({ key: a.key, value: a.value, id: a.id })}><I.Edit size={13} /></button>
              <button className="icon-btn" title="Remove (it won't be learned again)" aria-label={`Remove ${a.key}`} onClick={() => void patch({ removeAttribute: a.id })}><I.Close size={13} /></button>
            </div>
          ))}
          {fact ? (
            <form className="ppl-row-form" onSubmit={(e) => { e.preventDefault(); if (fact.key.trim() && fact.value.trim()) void patch({ setAttribute: fact }).then(() => setFact(null)) }}>
              <input className="ppl-input key" value={fact.key} onChange={(e) => setFact({ ...fact, key: e.target.value })} placeholder="birthday, likes, role…" aria-label="Fact" />
              <input className="ppl-input" value={fact.value} onChange={(e) => setFact({ ...fact, value: e.target.value })} placeholder="Value" aria-label="Value" autoFocus />
              <button className="mm-btn" type="submit" data-testid="people-fact-save">Save</button>
              <button className="mm-btn" type="button" onClick={() => setFact(null)}>Cancel</button>
            </form>
          ) : <button className="link-btn ppl-add" onClick={() => setFact({ key: '', value: '' })} data-testid="people-fact-add"><I.Plus size={13} />Add a fact</button>}
        </div>

        {!!card.relations.length && <>
          <h3 className="ppl-h">Connections</h3>
          <div className="ppl-facts">
            {card.relations.map((r) => (
              <div key={r.id} className="ppl-fact">
                <span className="ppl-key">{keyLabel(r.outgoing ? r.rel : `${r.rel} (from)`)}</span>
                <span className="ppl-val">{r.otherName}{r.note ? ` (${r.note})` : ''}</span>
                <span className={`ppl-src ${r.trust}`} title={TRUST_HINT[r.trust]}>{TRUST_LABEL[r.trust]} · {r.source.label ?? r.source.kind} · {day(r.at)}</span>
                <button className="icon-btn" title="Remove" aria-label="Remove connection" onClick={() => void patch({ removeRelation: r.id })}><I.Close size={13} /></button>
              </div>
            ))}
          </div>
        </>}

        <h3 className="ppl-h">Names and contacts</h3>
        <div className="ppl-aliases">
          {card.aliasDetails.map((a) => (
            <span key={`${a.kind}:${a.value}`} className="vault-tag">{a.value}{a.kind !== 'name' && <i> · {a.kind}</i>}
              {a.value !== card.name && <button className="ppl-x" aria-label={`Remove ${a.value}`} onClick={() => void patch({ removeAlias: a })}>×</button>}
            </span>
          ))}
          <AliasAdd onAdd={(v) => void patch({ addAlias: { kind: /@/.test(v) && !v.startsWith('@') ? 'email' : /^\+?[\d\s().-]{7,}$/.test(v) ? 'phone' : v.startsWith('@') ? 'handle' : 'nickname', value: v } })} />
        </div>

        {!!card.mentions.length && <>
          <h3 className="ppl-h">Recent</h3>
          <div className="ppl-mentions">
            {card.mentions.map((m, i) => (
              <div key={i} className="ppl-mention"><time>{day(m.at)}</time><span>{m.snippet}</span><span className={`ppl-src ${m.trust}`}>{m.source.label ?? m.source.kind}</span></div>
            ))}
          </div>
        </>}
      </div>
    </div>
  )
}

function AliasAdd({ onAdd }: { onAdd: (v: string) => void }) {
  const [v, setV] = useState<string | null>(null)
  if (v === null) return <button className="link-btn" onClick={() => setV('')}><I.Plus size={13} />Add</button>
  return (
    <form className="ppl-row-form inline" onSubmit={(e) => { e.preventDefault(); if (v.trim()) onAdd(v.trim()); setV(null) }}>
      <input className="ppl-input" value={v} onChange={(e) => setV(e.target.value)} placeholder="Nickname, email, phone or @handle" aria-label="Add a name or contact" autoFocus />
      <button className="mm-btn" type="submit">Add</button>
    </form>
  )
}

function PrivacyPanel({ status, onChange, onUndo }: { status: ContextEngineStatus; onChange: (s: ContextEngineStatus) => void; onUndo: (trashId: string) => void }) {
  const s = status.settings
  const set = async (patch: Parameters<typeof api.people.setSettings>[0]): Promise<void> => {
    try { onChange(await api.people.setSettings(patch)) } catch (e) { toast(clean(e), 'error') }
  }
  const exportData = async (): Promise<void> => {
    try { const f = await api.people.exportData(); toast(`Exported to ${f}`, 'ok') } catch (e) { toast(clean(e), 'error') }
  }
  const row = (title: string, sub: string, on: boolean, change: (v: boolean) => void, testId: string, disabled?: boolean) => (
    <div className={`set-row${disabled ? ' off' : ''}`}>
      <div className="set-row-text"><div className="set-row-title">{title}</div><ClampText>{sub}</ClampText></div>
      <div className="set-row-ctl"><Toggle on={on} onChange={change} label={title} testId={testId} /></div>
    </div>
  )
  return (
    <div className="vault-doc" data-testid="people-privacy">
      <div className="vault-doc-inner ppl-privacy">
        <section className="set-section">
          <div className="set-label">People &amp; Places</div>
          <div className="set-card">
            {row('Learn about people, places and things', 'Builds cards from your chats, files and the apps you allow, and gives each bot the cards a request is about. Off: nothing is learned and no cards are shown.', s.enabled, (v) => void set({ enabled: v }), 'people-enabled')}
            {row('Pause learning', 'Keeps what\'s saved (bots still see it) but learns nothing new until you turn this off.', s.paused, (v) => void set({ paused: v }), 'people-paused')}
          </div>
        </section>
        <section className="set-section">
          <div className="set-label">Learn from</div>
          <div className="set-card">
            {row('Chats', 'What you tell your bots. Only your own words count as yours; what a bot reads elsewhere is kept as quoted.', s.sources.chats, (v) => void set({ sources: { chats: v } }), 'people-src-chats')}
            {row('Files', 'Documents in your knowledge base and files you attach (kept as quoted: someone else wrote them).', s.sources.files, (v) => void set({ sources: { files: v } }), 'people-src-files')}
            {row('Connected apps in chats', 'Results from Gmail, Calendar and other apps that showed up in a chat: senders, attendees and meetings.', s.sources.connectorsInChats, (v) => void set({ sources: { connectorsInChats: v } }), 'people-src-connectors')}
            {row('Activity', status.activityAllowed ? 'Which apps you use most (from "Know what I\'m working on"). Never sent to cloud models.' : 'Needs "Know what I\'m working on" and "Let SahilBot learn from my activity" on (Settings → Activity). Never sent to cloud models.', s.sources.activity, (v) => void set({ sources: { activity: v } }), 'people-src-activity', !status.activityAllowed)}
          </div>
        </section>
        <section className="set-section">
          <div className="set-label">Read connected apps on a schedule</div>
          <div className="set-sub">Off unless you turn one on. Only metadata (who, when, where), never message text, and never sent to a model.</div>
          <div className="set-card">
            {status.connectors.map((c) => row(c.name, `${c.what}${c.connected ? '' : ' (not connected)'}`, c.on, (v) => void set({ connectors: { [c.id]: v } }), `people-conn-${c.id}`, !c.connected))}
          </div>
        </section>
        <section className="set-section">
          <div className="set-label">Sensitive details</div>
          <div className="set-sub">Left out unless you allow a category. Passwords, codes, keys, card, account and ID numbers are never kept.</div>
          <div className="set-card">
            {SENSITIVE_CATEGORIES.map((c) => row(c.label, c.hint || `Keep ${c.label.toLowerCase()} details.`, s.sensitive[c.id], (v) => void set({ sensitive: { [c.id]: v } }), `people-sens-${c.id}`))}
          </div>
        </section>
        <section className="set-section">
          <div className="set-label">Your data</div>
          <div className="set-card">
            <div className="set-row">
              <div className="set-row-text"><div className="set-row-title">Export my data</div><ClampText>Everything here (entries, facts, connections and their sources) as a JSON file in your workspace's exports folder.</ClampText></div>
              <div className="set-row-ctl"><button className="mm-btn" onClick={() => void exportData()} data-testid="people-export">Export</button></div>
            </div>
            {status.lastSummary && <div className="set-row"><div className="set-row-text"><div className="set-row-title">Last learned</div><ClampText>{status.lastRunAt ? `${day(status.lastRunAt)}: ` : ''}{status.lastSummary}</ClampText></div></div>}
          </div>
        </section>
        {!!status.trash.length && (
          <section className="set-section">
            <div className="set-label">Recently removed</div>
            <div className="set-sub">Kept 30 days so you can undo, then gone for good.</div>
            <div className="set-card">
              {status.trash.map((t) => (
                <div key={t.id} className="set-row" data-testid="people-trash">
                  <div className="set-row-text"><div className="set-row-title">{t.label}</div><ClampText>{day(t.at)}</ClampText></div>
                  <div className="set-row-ctl"><button className="mm-btn" onClick={() => onUndo(t.id)} data-testid="people-undo">Undo</button></div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
