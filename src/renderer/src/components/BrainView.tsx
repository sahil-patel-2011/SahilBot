import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { BrainSourceView, BrainStatus, BriefCard, BriefFilter, SourceChip } from '@shared/brain'
import { api } from '../api'
import { Mascot } from '../brand'
import * as I from '../icons'
import { toast } from '../lib/toast'
import { AppIcon, useAppIcons } from './ConnectedIcons'
import { BrainSettings, modelName, useBrainStatus } from './BrainSettings'
import { Popover } from './Popover'

// The Brain page: what SahilBot knows from your connected accounts, kept fresh on a schedule. Header
// (updated N min ago, live while syncing, Refresh now), stat cards, the sources it reads, first-read
// estimates waiting for an OK, and "Written for you" briefs with chips that open their sources. Works in
// light and dark, in a narrow window and on a phone (Phone access serves this same page).

export const BrainIcon = ({ size = 17 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M11.5 5.2a3 3 0 0 0-5.6 1.3 3 3 0 0 0-2.4 4.2 3.2 3.2 0 0 0 1.1 5.2 3.2 3.2 0 0 0 5 2.4c.9-.5 1.5-1.4 1.9-2.3V5.2Z" />
    <path d="M12.5 5.2a3 3 0 0 1 5.6 1.3 3 3 0 0 1 2.4 4.2 3.2 3.2 0 0 1-1.1 5.2 3.2 3.2 0 0 1-5 2.4c-.9-.5-1.5-1.4-1.9-2.3" />
    <path d="M8.6 9.4c.9.2 1.8 1 2 2M15.4 9.4c-.9.2-1.8 1-2 2M8.4 14.3h1.4M14.2 14.3h1.4" />
  </svg>
)

const money = (n: number): string => (n <= 0 ? '$0.00' : n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`)
const count = (n: number): string => n.toLocaleString('en-US')

export function ago(t: number | undefined, now = Date.now()): string {
  if (!t) return 'not yet'
  const m = Math.round((now - t) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} hr ago`
  const d = Math.round(h / 24)
  return `${d} ${d === 1 ? 'day' : 'days'} ago`
}

const ROLE: Record<BriefCard['role'], string> = { client: 'Client', contact: 'Client contact', person: 'Person', project: 'Project', organization: 'Organization' }
const FILTERS: Array<{ id: BriefFilter; label: string }> = [{ id: 'all', label: 'All' }, { id: 'clients', label: 'Clients' }, { id: 'people', label: 'People' }, { id: 'projects', label: 'Projects' }]

function chipIcon(k: SourceChip['kind']): ReactNode {
  switch (k) {
    case 'email': return <I.Inbox size={12} />
    case 'calendar': case 'meetings': return <I.Clock size={12} />
    case 'chat': return <I.Reply size={12} />
    case 'crm': return <I.Users size={12} />
    case 'docs': case 'file': return <I.File size={12} />
    case 'accounting': return <I.Layers size={12} />
    case 'you': return <I.Edit size={12} />
    default: return <I.Sparkle size={12} />
  }
}

export function Chip({ chip }: { chip: SourceChip }) {
  const open = (): void => { void api.brain.openChip(chip).catch((e: Error) => toast(e.message, 'error')) }
  const body = <>{chipIcon(chip.kind)}<span>{chip.label}</span></>
  return chip.link
    ? <button className="brain-chip link" onClick={open} title={chip.title ? `Open “${chip.title}”` : 'Open the source'} data-testid="brain-chip">{body}<I.External size={10} /></button>
    : <span className="brain-chip" title={chip.title} data-testid="brain-chip">{body}</span>
}

function useNow(ms = 30_000): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t) }, [ms])
  return now
}

export function BrainView(p: { onConnect: () => void; onNeedsYou: () => void; onOpenChat: (threadId: string) => void }) {
  const [st, reload, failed] = useBrainStatus()
  const [briefs, setBriefs] = useState<BriefCard[] | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<BriefFilter>('all')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const now = useNow()
  const q = useRef({ query, filter })
  q.current = { query, filter }
  const loadBriefs = (): void => {
    const late = setTimeout(() => setBriefs((b) => b ?? []), 5_000)
    void api.brain.briefs({ query: q.current.query, filter: q.current.filter }).then(setBriefs).catch(() => setBriefs([])).finally(() => clearTimeout(late))
  }
  useEffect(() => { loadBriefs() }, [query, filter])
  useEffect(() => api.brain.onChanged(loadBriefs), [])
  if (!st) return <div className="page brain-page" data-testid="brain-view">{failed ? <div className="hint">Couldn’t load this page. <button className="link" onClick={reload} data-testid="brain-retry">Try again</button></div> : <div className="hint">Loading…</div>}</div>

  const on = st.sources.filter((x) => x.state === 'on')
  const anyConnected = st.sources.some((x) => x.state === 'on' || x.state === 'off')
  const refresh = (): void => { void api.brain.refresh().then(() => reload()).catch((e: Error) => toast(e.message, 'error')) }
  const s = st.settings

  return (
    <div className="page brain-page" data-testid="brain-view">
      <div className="page-head brain-head">
        <div className="brain-title">
          <h1>Memory</h1>
          <span className={`brain-updated${st.syncing ? ' live' : ''}${!st.lastSyncAt && !st.syncing ? ' never' : ''}`} data-testid="brain-updated">
            <i className="brain-dot" aria-hidden="true" />
            {st.syncing ? `${st.job ?? 'Refreshing'}…` : s.paused ? 'Paused' : st.lastSyncAt ? `Updated ${ago(st.lastSyncAt, now)}` : 'Not updated yet'}
          </span>
        </div>
        <div className="brain-actions">
          <button className={`btn${settingsOpen ? ' on' : ''}`} onClick={() => setSettingsOpen((v) => !v)} aria-expanded={settingsOpen} data-testid="brain-settings-btn"><I.Sliders size={15} />Settings</button>
          {/* Until a source is on, "Connect apps" (below) is the one thing to do here. */}
          {on.length > 0 && <button className="btn primary" onClick={refresh} disabled={st.syncing || s.paused} data-testid="brain-refresh">
            {st.syncing ? <span className="spin" /> : <I.Bolt size={15} />}Refresh now
          </button>}
        </div>
      </div>
      <div className="set-sub brain-sub">Everything SahilBot reads from your accounts, kept on this Mac. It refreshes only while SahilBot is open, within a small daily budget.</div>

      {settingsOpen && <div className="brain-drawer"><BrainSettings status={st} onChange={() => reload()} compact /></div>}

      {s.paused && (
        <div className="tk-banner brain-banner" role="status">
          <I.Clock size={15} /><span>The brain is paused: nothing is read, written or suggested until you turn it back on.</span>
          <button className="bd-btn" onClick={() => void api.brain.setSettings({ paused: false }).then(() => reload())} data-testid="brain-resume">Turn it back on</button>
        </div>
      )}

      {st.estimates.map((e) => (
        <div key={e.sourceId} className="tk-banner brain-banner estimate" role="status" data-testid="brain-estimate">
          <I.Inbox size={15} /><span>{e.label}{e.model ? <em> · {modelName(e.model)}</em> : null}</span>
          <button className="bd-btn primary" onClick={() => void api.brain.backfill(e.sourceId, true).then(() => { reload(); toast('Reading it a little at a time, within your daily budget', 'ok') })} data-testid="brain-estimate-ok">OK</button>
          <button className="bd-btn" onClick={() => void api.brain.backfill(e.sourceId, false).then(() => reload())} data-testid="brain-estimate-cancel">Cancel</button>
        </div>
      ))}

      {on.length > 0 && <section className="brain-stats" aria-label="Brain at a glance">
        <Stat value={count(st.stats.memories)} label="memories" sub="facts and memories" testId="brain-stat-memories" />
        <Stat value={String(st.stats.tools)} label={st.stats.tools === 1 ? 'tool connected' : 'tools connected'} sub="sources it reads" testId="brain-stat-tools" />
        <Stat value={st.cadence.everyMs ? st.cadence.label.replace(/ \(idle\)$/, '') : 'Paused'} label="between refreshes" sub={st.cadence.paused ? st.cadence.paused.replace(/^paused:? ?/, '').replace(/^./, (c) => c.toUpperCase()) || 'Paused' : /idle/.test(st.cadence.label) ? 'you’re away, so hourly' : 'while you’re active'} testId="brain-stat-cadence" />
        <Stat value={String(st.stats.notesFiled)} label={st.stats.notesFiled === 1 ? 'note you filed' : 'notes you filed'} sub="in your vault" testId="brain-stat-notes" />
        <Stat value={money(st.stats.todayUsd)} label="today" sub={`of ${money(st.stats.dailyUsd)} a day`} meter={st.stats.dailyUsd > 0 ? Math.min(1, st.stats.todayUsd / st.stats.dailyUsd) : 0} testId="brain-stat-cost" />
      </section>}

      <AgentModeLine st={st} onNeedsYou={p.onNeedsYou} onTurnOn={() => void api.brain.setSettings({ agentMode: true }).then(() => { reload(); toast('Agent mode is on', 'ok') })} />

      <section className="brain-section" aria-label="Sources">
        <div className="brain-h"><h2>Sources</h2><span className="hint">{on.length ? `${on.length} on · tap one to turn it off for the brain` : 'Connect an app and it shows up here'}</span></div>
        {!anyConnected && (
          <div className="brain-empty" data-testid="brain-empty-sources">
            <Mascot size={52} />
            <div>
              <b>Nothing to read yet</b>
              <p>Connect Gmail (or Mail), Google Calendar and the apps you work in (Slack, Zoom, HubSpot, Drive, Notion) and SahilBot starts reading what’s new, every ~15 minutes while it’s open.</p>
            </div>
            <button className="btn primary" onClick={p.onConnect} data-testid="brain-connect">Connect apps</button>
          </div>
        )}
        <div className="brain-sources" data-testid="brain-sources">
          {st.sources.filter((x) => x.state !== 'not-connected' || ['gmail', 'gcal', 'slack', 'hubspot', 'zoom', 'gdrive', 'notion', 'texts'].includes(x.id)).map((x) => (
            <SourceTile key={x.id} src={x} now={now} onConnect={p.onConnect} onChanged={reload} />
          ))}
        </div>
      </section>

      <section className="brain-section" aria-label="Written for you">
        <div className="brain-h briefs">
          <h2>Written for you</h2>
          {(!!briefs?.length || !!query || filter !== FILTERS[0].id) && <div className="brain-tools">
            <span className="brain-search"><I.Search size={14} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search people, clients, projects" aria-label="Search briefs" data-testid="brain-search" /></span>
            <div className="tk-filter" role="tablist" aria-label="Show">
              {FILTERS.map((f) => <button key={f.id} role="tab" aria-selected={filter === f.id} className={filter === f.id ? 'on' : ''} onClick={() => setFilter(f.id)} data-testid={`brain-filter-${f.id}`}>{f.label}</button>)}
            </div>
          </div>}
        </div>
        {briefs === null ? <div className="hint">Loading…</div> : briefs.length === 0 ? (
          <div className="brain-empty small" data-testid="brain-empty-briefs">
            <span className="brain-empty-icon"><BrainIcon size={22} /></span>
            <div>
              <b>{query || filter !== 'all' ? 'Nothing matches' : 'No briefs yet'}</b>
              <p>{query || filter !== 'all' ? 'Try another search or filter.' : on.length ? 'After the next refresh, the clients, people and projects you deal with most get a short brief here, with links to where each fact came from.' : 'Connect a source first: briefs are written from what SahilBot reads there and from your chats.'}</p>
            </div>
          </div>
        ) : (
          <div className="brain-briefs" data-testid="brain-briefs">
            {briefs.map((b) => <BriefCardView key={b.entityId} b={b} now={now} onChanged={() => { loadBriefs(); reload() }} />)}
          </div>
        )}
      </section>

      {st.recent.length > 0 && (
        <details className="brain-ledger" data-testid="brain-ledger">
          <summary>Recent refreshes</summary>
          <ul>
            {st.recent.map((r) => (
              <li key={r.id}>
                <time>{new Date(r.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time>
                <span>{r.note}</span>
                <b>{r.usd > 0 ? money(r.usd) : 'free'}</b>
                {r.jobs.length > 0 && <em>{r.jobs.map((j) => `${j.job === 'extract' ? 'reading' : 'briefs'}: ${modelName(j.model)}`).join(' · ')}</em>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

function Stat({ value, label, sub, meter, testId }: { value: string; label: string; sub: string; meter?: number; testId: string }) {
  return (
    <div className="brain-stat" data-testid={testId}>
      <b>{value}</b>
      <span className="brain-stat-label">{label}</span>
      <span className="brain-stat-sub">{sub}</span>
      {meter !== undefined && <span className="brain-meter" aria-hidden="true"><i style={{ width: `${Math.round(meter * 100)}%` }} className={meter >= 0.9 ? 'full' : ''} /></span>}
    </div>
  )
}

function AgentModeLine({ st, onNeedsYou, onTurnOn }: { st: BrainStatus; onNeedsYou: () => void; onTurnOn: () => void }) {
  const s = st.settings
  if (!s.agentMode) {
    return (
      <div className="brain-agent off" data-testid="brain-agent">
        <span className="brain-agent-icon"><I.Bolt size={15} /></span>
        <span className="brain-agent-text"><b>Agent mode is off.</b> Turn it on and SahilBot reaches out when something needs you, like a request with a deadline, with up to {s.maxPromptsPerDay} prompts a day.</span>
        <button className="bd-btn primary" onClick={onTurnOn} data-testid="brain-agent-on">Turn on</button>
      </div>
    )
  }
  return (
    <div className="brain-agent" data-testid="brain-agent">
      <span className="brain-agent-icon on"><I.Bolt size={15} /></span>
      <span className="brain-agent-text"><b>Agent mode is on.</b> {st.promptsToday} of {s.maxPromptsPerDay} prompts today{s.quietHours.start !== s.quietHours.end ? ` · quiet ${s.quietHours.start}–${s.quietHours.end}` : ''}{s.preApproved.draft ? ' · drafts without asking, never sends' : ''}</span>
      <button className="bd-btn" onClick={onNeedsYou} data-testid="brain-open-needs-you">Needs you</button>
    </div>
  )
}

function SourceTile({ src, now, onConnect, onChanged }: { src: BrainSourceView; now: number; onConnect: () => void; onChanged: () => void }) {
  const icons = useAppIcons()
  const [confirm, setConfirm] = useState(false)
  const toggle = (): void => {
    if (src.state === 'not-connected' || src.state === 'needs-sign-in') { onConnect(); return }
    void api.brain.setSettings({ sources: { [src.id]: !src.on } }).then(() => { onChanged(); toast(src.on ? `${src.name} is off for the brain` : `${src.name} is on for the brain`, 'ok') }).catch((e: Error) => toast(e.message, 'error'))
  }
  const line = src.state === 'on'
    ? src.error ? `Couldn’t read: ${src.error}` : src.backfill === 'running' ? 'Reading back…' : src.lastSyncAt ? `Checked ${ago(src.lastSyncAt, now)} · ${count(src.items)} ${src.items === 1 ? 'item' : 'items'}` : 'Waiting for the first refresh'
    : src.state === 'off' ? (src.optIn ? 'Off unless you turn it on' : 'Off for the brain')
      : src.hint ?? (src.state === 'needs-sign-in' ? 'Needs sign-in' : 'Not connected')
  const badge = src.state === 'on' ? (src.error ? 'warn' : 'ok') : src.state === 'needs-sign-in' ? 'warn' : 'off'
  const presetName = src.name.replace(/ \(.*\)$/, '')
  return (
    <div className={`brain-source ${src.state}${src.error ? ' err' : ''}`} data-testid="brain-source" data-id={src.id} data-state={src.state}>
      <button className="brain-source-main" onClick={toggle} title={src.what} aria-label={`${src.name}: ${line}`}>
        <AppIcon src={icons[src.preset]} name={presetName} size={34} />
        <span className="brain-source-text">
          <span className="brain-source-name">{src.name}</span>
          <span className="brain-source-line">{line}</span>
        </span>
        <span className={`brain-badge ${badge}`} aria-hidden="true">{badge === 'ok' ? <I.Check size={11} /> : badge === 'warn' ? '!' : ''}</span>
      </button>
      {(src.state === 'on' || src.state === 'off') && src.items > 0 && (
        <Popover label={<span aria-hidden="true">⋯</span>} className="brain-source-menu" menuClass="down" title={`${src.name} options`} testId="brain-source-menu">
          {(close) => confirm ? (
            <div className="brain-confirm">
              <p>Forget everything SahilBot learned from {src.name}? Its facts, briefs and prompts go, and it turns off. This can’t be undone.</p>
              <div>
                <button className="menu-item danger" onClick={() => { close(); setConfirm(false); void api.brain.forgetSource(src.id).then(() => { onChanged(); toast(`Forgot everything from ${src.name}`, 'ok') }) }} data-testid="brain-forget-source-confirm"><I.Trash size={14} />Forget it all</button>
                <button className="menu-item" onClick={() => { setConfirm(false); close() }}>Cancel</button>
              </div>
            </div>
          ) : (
            <>
              <button className="menu-item" onClick={() => { close(); toggle() }}>{src.on ? <><I.Close size={14} />Turn off for the brain</> : <><I.Check size={14} />Turn on for the brain</>}</button>
              <button className="menu-item danger" onClick={() => setConfirm(true)} data-testid="brain-forget-source"><I.Trash size={14} />Forget everything from {src.name}…</button>
            </>
          )}
        </Popover>
      )}
    </div>
  )
}

function dueLine(d: BriefCard['due'], now: number): string | null {
  if (!d) return null
  if (!d.at) return d.what
  const days = Math.round((new Date(d.at).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000)
  const when = days < 0 ? 'Past due' : days === 0 ? 'Due today' : days === 1 ? 'Due tomorrow' : days < 7 ? `Due ${new Date(d.at).toLocaleDateString('en-US', { weekday: 'short' })}` : `Due ${new Date(d.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
  return when
}

function BriefCardView({ b, now, onChanged }: { b: BriefCard; now: number; onChanged: () => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(b.text)
  const [confirm, setConfirm] = useState(false)
  const due = useMemo(() => dueLine(b.due, now), [b.due, now])
  const save = (): void => {
    void api.brain.correct(b.entityId, draft).then(() => { setEditing(false); onChanged(); toast('Saved as your own words', 'ok') }).catch((e: Error) => toast(e.message, 'error'))
  }
  const forget = (): void => {
    void api.brain.forget(b.entityId).then((r) => {
      onChanged()
      toast(`Forgot ${b.name}`, 'ok', { action: { label: 'Undo', run: () => void api.brain.undo(r.trashId).then(onChanged) } })
    }).catch((e: Error) => toast(e.message, 'error'))
  }
  return (
    <article className={`brain-card ${b.role}`} data-testid="brain-brief" data-entity={b.entityId}>
      <div className="brain-card-top">
        <span className="brain-eyebrow">{ROLE[b.role]}<i>·</i>{b.edited ? 'In your words' : 'Written for you'}</span>
        {due && <span className={`brain-due${/Past|today/.test(due) ? ' hot' : ''}`} title={b.due?.what}>{due}</span>}
      </div>
      <h3 className="brain-card-name">{b.name}</h3>
      {b.subtitle && <div className="brain-card-sub">{b.subtitle}</div>}
      {editing ? (
        <div className="brain-edit">
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={4} autoFocus aria-label={`What’s right about ${b.name}`} data-testid="brain-edit-text" />
          <div className="brain-edit-actions">
            <span className="hint">Saved as your own fact. SahilBot won’t rewrite it.</span>
            <button className="bd-btn" onClick={() => { setEditing(false); setDraft(b.text) }}>Cancel</button>
            <button className="bd-btn primary" onClick={save} disabled={!draft.trim()} data-testid="brain-edit-save">Save</button>
          </div>
        </div>
      ) : (
        <p className={`brain-card-text${b.text ? '' : ' muted'}`} data-testid="brain-brief-text">{b.text || (b.stale ? 'New facts came in; a fresh brief is written at the next refresh.' : 'A brief is written at the next refresh.')}</p>
      )}
      <div className="brain-card-foot">
        <div className="brain-chips">{b.chips.map((c, i) => <Chip key={`${c.label}-${i}`} chip={c} />)}</div>
        {!editing && (
          <div className="brain-card-actions">
            {confirm ? (
              <>
                <span className="hint">Forget {b.name} everywhere?</span>
                <button className="link-btn danger" onClick={() => { setConfirm(false); forget() }} data-testid="brain-forget-confirm">Forget</button>
                <button className="link-btn" onClick={() => setConfirm(false)}>Keep</button>
              </>
            ) : (
              <>
                <button className="link-btn" onClick={() => { setDraft(b.text); setEditing(true) }} data-testid="brain-wrong">That’s wrong</button>
                <button className="link-btn" onClick={() => setConfirm(true)} data-testid="brain-forget">Forget</button>
              </>
            )}
          </div>
        )}
      </div>
    </article>
  )
}
