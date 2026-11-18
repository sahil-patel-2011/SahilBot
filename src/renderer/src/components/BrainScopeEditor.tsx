import { useEffect, useMemo, useState } from 'react'
import { BRAIN_SCOPE_SOURCES, scopeSummary, type BrainScope, type BrainScopeSource } from '@shared/brain-access'
import { SENSITIVE_CATEGORIES, type SensitiveCategory } from '@shared/context-engine'
import { api } from '../api'
import '../styles-brain-access.css'

// "What it can see": the part of the user's brain a connected app (Connected apps) or a teammate (Team
// access) may read: sources, people and clients, topics, sensitive categories, and bots' own knowledge.
// The same picker for both; main enforces it on every fact (brain-access/reader.ts).

export interface ScopeName { id: string; name: string; type: string; role: string }

let namesCache: { at: number; list: ScopeName[] } | null = null
async function brainNames(): Promise<ScopeName[]> {
  if (namesCache && Date.now() - namesCache.at < 30_000) return namesCache.list
  const list = await api.mcp.brainNames().catch(() => [] as ScopeName[])
  namesCache = { at: Date.now(), list }
  return list
}

export function useBrainNames(): ScopeName[] {
  const [names, setNames] = useState<ScopeName[]>(namesCache?.list ?? [])
  useEffect(() => { void brainNames().then(setNames) }, [])
  return names
}

export function scopeLine(s: BrainScope, names: ScopeName[]): string {
  return scopeSummary(s, (id) => names.find((n) => n.id === id)?.name)
}

export function BrainScopeEditor({ scope, onChange, bots, testId = 'scope-editor' }: {
  scope: BrainScope
  onChange: (patch: Partial<BrainScope>) => void
  /** Bots whose own knowledge can be shared too (Team access). */
  bots?: Array<{ id: string; name: string }>
  testId?: string
}) {
  const names = useBrainNames()
  const [q, setQ] = useState('')
  const [topics, setTopics] = useState(scope.topics.join(', '))
  useEffect(() => { setTopics(scope.topics.join(', ')) }, [scope.topics])
  const only = scope.entities !== 'shared'
  const picked = new Set(only ? scope.entities as string[] : [])
  const list = useMemo(() => names.filter((n) => !q.trim() || n.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 60), [names, q])
  const toggleSource = (id: BrainScopeSource): void => onChange({ sources: scope.sources.includes(id) ? scope.sources.filter((x) => x !== id) : [...scope.sources, id] })
  const toggleSensitive = (id: SensitiveCategory): void => onChange({ sensitive: scope.sensitive.includes(id) ? scope.sensitive.filter((x) => x !== id) : [...scope.sensitive, id] })
  const toggleEntity = (id: string): void => onChange({ entities: picked.has(id) ? [...picked].filter((x) => x !== id) : [...picked, id] })
  const toggleBot = (id: string): void => onChange({ bots: scope.bots.includes(id) ? scope.bots.filter((x) => x !== id) : [...scope.bots, id] })
  const saveTopics = (): void => {
    const next = topics.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)
    if (next.join('|') !== scope.topics.join('|')) onChange({ topics: next })
  }
  return (
    <div className="scope" data-testid={testId}>
      <div className="scope-sec">
        <div className="scope-h">Sources</div>
        <div className="scope-chips">
          {BRAIN_SCOPE_SOURCES.map((s) => (
            <button key={s.id} type="button" title={s.hint} aria-pressed={scope.sources.includes(s.id)} data-testid={`${testId}-src-${s.id}`}
              className={`scope-chip${scope.sources.includes(s.id) ? ' on' : ''}${s.private ? ' private' : ''}`} onClick={() => toggleSource(s.id)}>{s.label}</button>
          ))}
        </div>
      </div>
      <div className="scope-sec">
        <div className="scope-h">People, clients and projects</div>
        <div className="scope-seg" role="radiogroup">
          <button type="button" role="radio" aria-checked={!only} className={!only ? 'on' : ''} onClick={() => onChange({ entities: 'shared' })} data-testid={`${testId}-all`}>Everyone shared</button>
          <button type="button" role="radio" aria-checked={only} className={only ? 'on' : ''} onClick={() => onChange({ entities: [] })} data-testid={`${testId}-only`}>Only the ones I pick</button>
        </div>
        {only && (
          <div className="scope-pick">
            <input className="set-input" placeholder="Search names" value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="scope-names">
              {list.length === 0 ? <span className="hint">Nothing in People &amp; Places yet.</span> : list.map((n) => (
                <label key={n.id} className="scope-name"><input type="checkbox" checked={picked.has(n.id)} onChange={() => toggleEntity(n.id)} /> {n.name} <span className="hint">{n.role}</span></label>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="scope-sec">
        <div className="scope-h">Only these topics <span className="hint">(optional, comma-separated)</span></div>
        <input className="set-input" value={topics} placeholder="e.g. invoices, pricing, onboarding" onChange={(e) => setTopics(e.target.value)} onBlur={saveTopics} onKeyDown={(e) => e.key === 'Enter' && saveTopics()} data-testid={`${testId}-topics`} />
      </div>
      {bots && bots.length > 0 && (
        <div className="scope-sec">
          <div className="scope-h">Bots’ own knowledge</div>
          <div className="scope-chips">
            {bots.map((b) => <button key={b.id} type="button" aria-pressed={scope.bots.includes(b.id)} className={`scope-chip${scope.bots.includes(b.id) ? ' on' : ''}`} onClick={() => toggleBot(b.id)}>{b.name}</button>)}
          </div>
        </div>
      )}
      <div className="scope-sec">
        <div className="scope-h">Sensitive <span className="hint">(off: never shared)</span></div>
        <div className="scope-chips">
          {SENSITIVE_CATEGORIES.map((c) => <button key={c.id} type="button" aria-pressed={scope.sensitive.includes(c.id)} className={`scope-chip${scope.sensitive.includes(c.id) ? ' on warn' : ''}`} onClick={() => toggleSensitive(c.id)}>{c.label}</button>)}
        </div>
        <div className="hint scope-never">Never shared, whatever you pick: passwords, codes and keys, card and account numbers, your Vault, other teammates’ questions, and what you do in other apps.</div>
      </div>
    </div>
  )
}
