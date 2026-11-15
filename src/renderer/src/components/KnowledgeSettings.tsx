import { useEffect, useState, type ReactNode } from 'react'
import type { KnowledgeHit, KnowledgeSource, KnowledgeStatus } from '@shared/types'
import { api } from '../api'
import * as I from '../icons'
import { Toggle } from './Toggle'
import { toast } from '../lib/toast'

// Settings → Knowledge: the folders SahilBot can search (with counts), meaning search (an Ollama
// embedding model) or keyword only, add/remove folders, pause and rebuild.

const clean = (e: unknown): string => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

function ago(ms: number | null): string {
  if (!ms) return 'not yet'
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const KIND: Record<KnowledgeSource['kind'], string> = { workspace: 'Workspace', project: 'Project', folder: 'Folder', attached: 'Attached folder' }

/** The live knowledge status, refreshed when main says it changed. */
export function useKnowledgeStatus(): [KnowledgeStatus | null, (s: KnowledgeStatus) => void] {
  const [st, setSt] = useState<KnowledgeStatus | null>(null)
  useEffect(() => {
    let alive = true
    const load = (): void => { void api.knowledge.status().then((s) => { if (alive) setSt(s) }).catch(() => undefined) }
    load()
    const off = api.knowledge.onChanged(load)
    return () => { alive = false; off() }
  }, [])
  return [st, setSt]
}

function Card({ title, sub, children }: { title?: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <section className="set-section">
      {title && <div className="set-label">{title}</div>}
      {sub && <div className="set-sub">{sub}</div>}
      <div className="set-card">{children}</div>
    </section>
  )
}

function Line({ title, sub, children, testId }: { title: ReactNode; sub?: ReactNode; children?: ReactNode; testId?: string }) {
  return (
    <div className="set-row" data-testid={testId}>
      <div className="set-row-text"><div className="set-row-title">{title}</div>{sub && <div className="set-row-sub">{sub}</div>}</div>
      {children && <div className="set-row-ctl">{children}</div>}
    </div>
  )
}

/** One search result: citation, heading and the matching lines. Click opens the file; ⌥-click shows it in Finder. */
export function KnowledgeResult({ h }: { h: KnowledgeHit }) {
  const name = h.path.split('/').pop() ?? h.path
  const where = h.page ? `page ${h.page}` : h.startLine ? `line ${h.startLine}${h.endLine && h.endLine !== h.startLine ? `–${h.endLine}` : ''}` : ''
  return (
    <button className="kb-hit" onClick={(e) => void (e.altKey ? api.knowledge.reveal(h.path) : api.knowledge.open(h.path))} title={`${h.citation}\nClick to open · ⌥-click to show in Finder`}>
      <span className="kb-hit-head"><I.File size={13} /> <b>{name}</b>{where && <span className="hint"> · {where}</span>}{h.heading && <span className="hint"> · {h.heading}</span>}</span>
      <span className="kb-hit-snippet">{h.snippet}</span>
    </button>
  )
}

export function KnowledgeSettings() {
  const [st, setSt] = useKnowledgeStatus()
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<KnowledgeHit[] | null>(null)
  const [openaiEmb, setOpenaiEmb] = useState<boolean | null>(null)
  useEffect(() => { void api.settings.get().then((s) => setOpenaiEmb(!!(s as { openaiEmbeddings?: boolean }).openaiEmbeddings)).catch(() => undefined) }, [])
  const setEmb = (v: boolean): void => {
    setOpenaiEmb(v)
    void api.settings.set({ openaiEmbeddings: v } as never).then(() => api.knowledge.status()).then((s) => { if (s) setSt(s) }).catch((e) => toast(clean(e)))
  }
  const act = (p: Promise<KnowledgeStatus | null>): void => { void p.then((s) => { if (s) setSt(s) }).catch((e) => toast(clean(e))) }
  const search = (): void => {
    if (!q.trim()) { setHits(null); return }
    void api.knowledge.search(q.trim(), { k: 8 }).then((r) => setHits(r.hits)).catch((e) => toast(clean(e)))
  }
  if (!st) return <><h2>Knowledge</h2><div className="hint">Loading…</div></>
  const state = st.paused ? 'Paused' : st.indexing ? `Indexing${st.queued ? ` · ${st.queued} files to go` : ''}…` : `Up to date · checked ${ago(st.lastScan)}`
  return (
    <div data-testid="knowledge-settings">
      <h2>Knowledge</h2>
      <div className="set-sub" style={{ marginTop: -6 }}>
        SahilBot can search your own files: the workspace, every project's folder and any folders you add here. Bots use it when you ask about your documents and cite the file they used. Everything stays on this Mac. Secrets (.env files, keys, keychains), hidden folders, dependencies, build output and anything in .gitignore are never indexed.
      </div>

      <Card title="Search">
        <Line title={<>{st.totals.files.toLocaleString()} files · {st.totals.chunks.toLocaleString()} passages</>} sub={state} testId="knowledge-totals">
          <button className="btn" onClick={() => act(api.knowledge.setPaused(!st.paused))} data-testid="knowledge-pause">{st.paused ? 'Resume' : 'Pause'}</button>
          <button className="btn" onClick={() => { if (confirm('Rebuild the knowledge base? Every folder is read again from scratch; this can take a while for big folders.')) act(api.knowledge.rebuild()) }} data-testid="knowledge-rebuild">Rebuild</button>
        </Line>
        <Line
          title="Meaning search"
          sub={st.embedModel
            ? <>On, with {st.embedModel} ({st.totals.chunks ? Math.min(100, Math.round((st.embedded / st.totals.chunks) * 100)) : 100}% of passages ready). Runs in the background only while no chat is working.</>
            : <>Keyword search only. Install <b>{st.suggestedModel}</b> in Ollama (Settings → Models, or <code>ollama pull {st.suggestedModel}</code>) for smarter search that finds passages by meaning, not just matching words.</>}
          testId="knowledge-embed"
        />
        {openaiEmb !== null && (
          <Line
            title="Use OpenAI for meaning search"
            sub="Uses your OpenAI key (text-embedding-3-small, about 2¢ per million tokens) when cloud models are on. This sends passages from your indexed files to OpenAI. Off: everything stays on this Mac."
            testId="knowledge-openai-embed"
          >
            <Toggle on={openaiEmb} onChange={setEmb} label="Use OpenAI for meaning search" testId="openai-embeddings" />
          </Line>
        )}
        {st.current && !st.paused && <Line title="Reading" sub={st.current} />}
      </Card>

      <Card title="Folders" sub="Changes are picked up as you save files.">
        {st.sources.length === 0 && <div className="set-empty">No folders yet.</div>}
        {st.sources.map((s) => (
          <Line
            key={s.path}
            testId={`knowledge-source-${s.kind}`}
            title={<>{s.label} <span className="tier-badge">{KIND[s.kind]}</span></>}
            sub={<>{s.path}<br />{s.problem ? `Not indexed: ${s.problem}` : `${s.files.toLocaleString()} files${s.skipped ? ` · ${s.skipped} skipped` : ''} · updated ${ago(s.lastIndexed)}${s.truncated ? ' · file limit reached (add smaller sub-folders instead)' : ''}`}</>}
          >
            {s.removable && <button className="icon-btn" title="Remove from knowledge" onClick={() => act(api.knowledge.removeFolder(s.path))}><I.Trash size={14} /></button>}
          </Line>
        ))}
        <Line title="Add a folder" sub="Notes, papers, a Dropbox or iCloud folder, other projects. ~/Library and system folders can't be added.">
          <button className="btn primary" onClick={() => act(api.knowledge.addFolder())} data-testid="knowledge-add"><I.Plus size={13} /> Add folder</button>
        </Line>
      </Card>

      {st.attached.length > 0 && (
        <Card title="Folders you attached to chats" sub="Only searchable in the chat you attached them to. Add one to make it searchable everywhere.">
          {st.attached.map((p) => (
            <Line key={p} title={p.split('/').pop() || p} sub={p}>
              <button className="btn" onClick={() => act(api.knowledge.addAttached(p))}>Add to knowledge</button>
            </Line>
          ))}
        </Card>
      )}

      <Card title="Try it">
        <div className="set-row" style={{ display: 'block' }}>
          <form onSubmit={(e) => { e.preventDefault(); search() }} style={{ display: 'flex', gap: 8 }}>
            <input className="set-input wide" placeholder="Search your files…" value={q} onChange={(e) => setQ(e.target.value)} data-testid="knowledge-query" style={{ flex: 1 }} />
            <button className="btn" type="submit"><I.Search size={13} /> Search</button>
          </form>
          {hits && (hits.length ? <div className="kb-hits">{hits.map((h, i) => <KnowledgeResult key={`${h.citation}-${i}`} h={h} />)}</div> : <div className="hint" style={{ marginTop: 8 }}>No matches.</div>)}
        </div>
      </Card>
      <style>{KB_CSS}</style>
    </div>
  )
}

/** Shared by Settings → Knowledge and the project home. */
export const KB_CSS = `
.kb-hits { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
.kb-hit { display: flex; flex-direction: column; gap: 4px; text-align: left; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border, rgba(127,127,127,.2)); background: transparent; color: inherit; cursor: pointer; font: inherit; }
.kb-hit:hover { background: var(--hover, rgba(127,127,127,.08)); }
.kb-hit-head { display: flex; align-items: center; gap: 4px; font-size: 12.5px; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.kb-hit-snippet { font-size: 12px; opacity: .8; white-space: pre-wrap; max-height: 7.5em; overflow: hidden; font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace); }
.kb-block { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.kb-block input { flex: 1; min-width: 160px; }
`
