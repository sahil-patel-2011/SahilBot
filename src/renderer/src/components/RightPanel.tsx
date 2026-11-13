import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import type { BrowserState, FilePreview, Message, TeamMember } from '@shared/types'
import { prettyName } from '../lib/steps'
import { Markdown, SANITIZE } from './Markdown'
import { api } from '../api'
import * as I from '../icons'
import { TeachBar } from './TeachBar'
import { isPageCandidate, PageView } from './PageView'

export type PanelTab = 'progress' | 'browser' | 'file'

export function RightPanel({ tab, onTab, hidden, messages, file, onOpenFile, browserState, onClose, running, progress, threadId }: {
  tab: PanelTab
  onTab: (t: PanelTab) => void
  hidden: boolean
  messages: Message[]
  file: string | null
  onOpenFile: (p: string) => void
  browserState: BrowserState | null
  onClose: () => void
  running?: boolean
  progress?: { used: number; window: number; model?: string; actions?: number }
  /** The open chat: a recording made with Teach goes there. */
  threadId?: string | null
}) {
  return (
    <aside className="right" data-testid="right-panel">
      <div className="right-tabs drag">
        <div className="seg-tabs nodrag">
          <button className={tab === 'progress' ? 'on' : ''} onClick={() => onTab('progress')} data-testid="tab-progress"><I.ListIcon size={14} />Overview</button>
          <button className={tab === 'browser' ? 'on' : ''} onClick={() => onTab('browser')}><I.Globe size={14} />Browser</button>
          <button className={tab === 'file' ? 'on' : ''} onClick={() => onTab('file')} data-testid="tab-file"><I.File size={14} />File</button>
        </div>
        <span style={{ flex: 1 }} />
        <button className="icon-btn nodrag" onClick={onClose} title="Close panel (⌘\\)"><I.Close size={15} /></button>
      </div>
      {tab === 'browser' && <BrowserPane hidden={hidden} threadId={threadId} />}
      {tab === 'progress' && <ProgressPane messages={messages} onOpenFile={onOpenFile} browserState={browserState} onBrowser={() => onTab('browser')} running={!!running} progress={progress} />}
      {tab === 'file' && (isPageCandidate(file) ? <PageView key={file} path={file} fallback={<FilePane path={file} />} /> : <FilePane path={file} />)}
    </aside>
  )
}

// ---------------------------------------------------------------- overview

function hostOf(u: string): string { try { return new URL(u).hostname.replace(/^www\./, '') } catch { return u } }

function ProgressPane({ messages, onOpenFile, browserState, onBrowser, running, progress }: {
  messages: Message[]; onOpenFile: (p: string) => void; browserState: BrowserState | null; onBrowser: () => void
  running: boolean; progress?: { used: number; window: number; model?: string; actions?: number }
}) {
  const steps = messages.flatMap((m) => m.toolCalls ?? [])
  const results = new Map(messages.filter((m) => m.role === 'tool').map((m) => [m.toolCallId, m]))
  // The latest plan: a todo update, or a plan the user approved.
  const lastTodo = [...steps].reverse().find((c) => c.name === 'todo' || (c.name === 'propose_plan' && /approved the plan/.test(results.get(c.id)?.content ?? '')))
  let plan: Array<{ text: string; status: string }> = []
  try {
    const a = lastTodo ? JSON.parse(lastTodo.arguments) : null
    plan = !a ? [] : lastTodo!.name === 'todo' ? a.items ?? [] : (a.steps ?? []).map((t: string, i: number) => ({ text: t, status: i === 0 ? 'in_progress' : 'pending' }))
  } catch { plan = [] }
  const outputs = [...new Map(messages.filter((m) => m.role === 'tool' && m.meta?.status === 'ok' && typeof m.meta?.path === 'string' && ['file_write', 'create_document', 'create_page', 'update_page'].includes(m.toolName ?? ''))
    .map((m) => [m.meta!.path as string, m])).values()].reverse()
  const attached = messages.flatMap((m) => [
    ...((m.meta?.files ?? []) as Array<{ name: string; path: string }>).map((f) => ({ ...f, folder: false })),
    ...((m.meta?.folders ?? []) as string[]).map((f) => ({ name: f.split('/').pop()!, path: f, folder: true }))
  ])
  const sources = [...new Map(messages.flatMap((m) => ((m.meta?.sources ?? []) as Array<{ title: string; url: string }>)).map((s) => [s.url, s])).values()]
  const team = messages.flatMap((m) => (m.meta?.team ?? []) as TeamMember[])
  const used = new Map<string, number>()
  for (const c of steps) {
    const label = (results.get(c.id)?.meta?.label as string | undefined) ?? prettyName(c.name)
    used.set(label, (used.get(label) ?? 0) + 1)
  }
  const done = plan.filter((t) => t.status === 'done').length
  const current = plan.find((t) => t.status === 'in_progress')
  const pct = progress ? Math.min(100, Math.round((progress.used / progress.window) * 100)) : null
  const lastAi = [...messages].reverse().find((m) => m.role === 'assistant' && m.kind === 'normal')
  const status = running ? 'Working' : lastAi?.status === 'error' ? 'Stopped with an error' : messages.length ? 'Done' : 'Ready'

  return (
    <div className="progress-pane" data-testid="progress-pane">
      <section className="ov-card ov-status">
        <div className="ov-status-row">
          <span className={`ov-dot${running ? ' live' : ''}`} />
          <b>{status}</b>
          <span className="spacer" />
          {pct !== null && <span className="hint">{pct}% memory used</span>}
        </div>
        {running && current && <div className="ov-now">Now: {current.text}</div>}
        <div className="ov-facts">
          {progress?.model && <span><I.Cpu size={12} />{progress.model}</span>}
          <span><I.ListIcon size={12} />{steps.length} action{steps.length === 1 ? '' : 's'}</span>
          {outputs.length > 0 && <span><I.File size={12} />{outputs.length} file{outputs.length === 1 ? '' : 's'}</span>}
          {sources.length > 0 && <span><I.Globe size={12} />{sources.length} source{sources.length === 1 ? '' : 's'}</span>}
        </div>
        {pct !== null && <div className="ov-meter"><i style={{ width: `${pct}%` }} className={pct > 85 ? 'hot' : ''} /></div>}
      </section>

      <section className="ov-card">
        <div className="ov-head"><span>Plan</span>{plan.length > 0 && <span className="hint">{done} of {plan.length}</span>}</div>
        {plan.length === 0 ? <div className="ov-empty">For tasks with several steps, SahilBot writes its plan here and ticks it off as it works.</div> : (
          <>
            <div className="ov-meter"><i style={{ width: `${(done / plan.length) * 100}%` }} /></div>
            <ol className="ov-plan">
              {plan.map((t, i) => (
                <li key={i} className={`ps-${t.status}${running && t.status === 'in_progress' ? ' live' : ''}`}>
                  <span className="ps-mark">{t.status === 'done' ? <I.Check size={11} /> : null}</span><span>{t.text}</span>
                </li>
              ))}
            </ol>
          </>
        )}
      </section>

      {team.length > 0 && (
        <section className="ov-card">
          <div className="ov-head"><span>Team of Experts</span><span className="hint">{team.filter((x) => x.status === 'done').length} of {team.length} done</span></div>
          <div className="ov-team">{team.map((x) => <span key={x.id} className={`ov-member tm-${x.status}`} title={x.detail}><span className="tm-dot" />{x.title}</span>)}</div>
        </section>
      )}

      <section className="ov-card">
        <div className="ov-head"><span>Files made</span></div>
        {outputs.length === 0 ? <div className="ov-empty">Documents and files SahilBot creates show up here.</div> : (
          <div className="ov-files">
            {outputs.map((m) => {
              const path = m.meta!.path as string
              const ext = path.split('.').pop()?.toLowerCase() ?? ''
              return (
                <button key={path} className="ov-file" onClick={() => onOpenFile(path)} data-testid="output-card" title={path}>
                  <span className={`ov-ext t-${ext}`}>{ext.toUpperCase()}</span>
                  <span className="ov-file-name">{path.split('/').pop()}</span>
                  <I.Chevron size={12} style={{ transform: 'rotate(-90deg)' }} />
                </button>
              )
            })}
          </div>
        )}
      </section>

      {sources.length > 0 && (
        <section className="ov-card">
          <div className="ov-head"><span>Sources</span><span className="hint">{sources.length}</span></div>
          <div className="ov-sources">
            {sources.slice(0, 12).map((s, i) => (
              <a key={s.url} className="ov-source" href={s.url} target="_blank" rel="noreferrer" title={s.url}>
                <span className="ov-n">{i + 1}</span>
                <span className="ov-source-text"><span className="ov-source-title">{s.title || hostOf(s.url)}</span><span className="hint">{hostOf(s.url)}</span></span>
              </a>
            ))}
          </div>
        </section>
      )}

      <section className="ov-card ov-click" onClick={onBrowser} role="button">
        <div className="ov-head"><span><I.Globe size={14} /> Browser</span>
          <span className="hint">{browserState?.tabs.length ? `${browserState.tabs.length} tab${browserState.tabs.length > 1 ? 's' : ''}${browserState.controlling ? ' · in use' : ''}` : 'idle'} ›</span></div>
        {browserState?.tabs[browserState.active] && <div className="ov-empty">{browserState.tabs[browserState.active].title}</div>}
      </section>

      {(used.size > 0 || attached.length > 0) && (
        <section className="ov-card">
          <div className="ov-head"><span>Used in this chat</span></div>
          <div className="ov-chips">
            {attached.map((a) => <span key={a.path} className="ov-chip" title={a.path} onClick={() => !a.folder && onOpenFile(a.path)}
              {...(a.folder ? {} : { role: 'button', tabIndex: 0, onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenFile(a.path) } } })}>{a.folder ? <I.Folder size={12} /> : <I.Paperclip size={12} />}{a.name}</span>)}
            {[...used.entries()].map(([label, n]) => <span key={label} className="ov-chip">{label}<span className="hint">{n}</span></span>)}
          </div>
        </section>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- file preview

function FilePane({ path }: { path: string | null }) {
  const [p, setP] = useState<FilePreview | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [sheet, setSheet] = useState(0)
  useEffect(() => {
    setP(null)
    setErr(null)
    setSheet(0)
    let alive = true
    if (path) api.files.preview(path).then((x) => { if (alive) setP(x) }).catch((e: Error) => { if (alive) setErr(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')) })
    return () => { alive = false }
  }, [path])
  if (!path) return <div className="right-body">Open a file from the chat or the Progress tab to preview it here.</div>
  if (err) return <div className="right-body">{err}</div>
  if (!p) return <div className="right-body"><span className="spin" /></div>
  return (
    <div className="file-pane" data-testid="file-pane" data-kind={p.kind}>
      <div className="file-bar">
        <I.File size={15} /><span className="file-title" title={p.path}>{p.name}</span>
        <button className="btn" onClick={() => void api.files.open(p.path)}><I.External size={13} /> Open</button>
        <button className="btn" onClick={() => void api.files.reveal(p.path)}>Show in Finder</button>
      </div>
      <div className="file-body">
        {p.kind === 'pdf' && <iframe className="pdf-frame" src={p.url} title={p.name} />}
        {p.kind === 'image' && <img className="file-img" src={p.url} alt={p.name} />}
        {p.kind === 'html' && <div className="doc-page md" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(p.html ?? '', SANITIZE) }} />}
        {p.kind === 'markdown' && <div className="doc-page"><Markdown text={p.text ?? ''} /></div>}
        {p.kind === 'text' && <pre className="file-text">{p.text}</pre>}
        {p.kind === 'sheets' && p.sheets && (
          <>
            {p.sheets.length > 1 && <div className="sheet-tabs">{p.sheets.map((s, i) => <button key={s.name} className={`tab${i === sheet ? ' on' : ''}`} onClick={() => setSheet(i)}>{s.name}</button>)}</div>}
            <div className="sheet-wrap"><table className="sheet">
              <tbody>{p.sheets[sheet].rows.map((r, i) => <tr key={i}>{r.map((c, j) => i === 0 ? <th key={j}>{String(c ?? '')}</th> : <td key={j}>{String(c ?? '')}</td>)}</tr>)}</tbody>
            </table></div>
          </>
        )}
        {p.kind === 'slides' && p.slides && (
          <div className="slides">
            {p.slides.map((s) => (
              <div key={s.n} className="slide">
                <span className="slide-n">{s.n}</span>
                <div className="slide-title">{s.texts[0]}</div>
                <ul>{s.texts.slice(1).map((t, i) => <li key={i}>{t}</li>)}</ul>
                {s.notes && <div className="hint">Notes: {s.notes}</div>}
              </div>
            ))}
          </div>
        )}
        {p.kind === 'unsupported' && <div className="right-body">{p.note ?? 'No preview for this file type.'} Use Open to view it in its app.</div>}
      </div>
    </div>
  )
}

/** threadId: the chat a "Teach a task" recording is sent to (the bot's current thread). */
function BrowserPane({ hidden, threadId }: { hidden: boolean; threadId?: string | null }) {
  const [s, setS] = useState<BrowserState | null>(null)
  const [url, setUrl] = useState('')
  const [editing, setEditing] = useState(false)
  const view = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void api.browser.state().then(setS)
    return api.browser.onState(setS)
  }, [])

  const current = s?.tabs[s.active]
  useEffect(() => {
    if (!editing) setUrl(current?.url && current.url !== 'about:blank' ? current.url : '')
  }, [current?.url, editing])

  // The page is a native view laid over this div: keep its bounds in sync, and hide it under modals.
  useLayoutEffect(() => {
    const el = view.current
    if (!el) return
    const sync = (): void => {
      const r = el.getBoundingClientRect()
      void api.browser.setBounds(hidden || r.width < 10 ? null : { x: r.left, y: r.top, width: r.width, height: r.height })
    }
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    window.addEventListener('resize', sync)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', sync)
      void api.browser.setBounds(null)
    }
  }, [hidden, s?.controlling, s?.takenOver, s?.tabs.length, s?.teach?.status, !!s?.teach])

  return (
    <div className="browser">
      {s && s.tabs.length > 1 && (
        <div className="btabs">
          {s.tabs.map((t) => (
            <div key={t.index} className={`btab${t.index === s.active ? ' on' : ''}`} onClick={() => void api.browser.switchTab(t.index)}>
              <span>{t.loading ? '…' : ''}{t.title}</span>
              <button onClick={(e) => { e.stopPropagation(); void api.browser.closeTab(t.index) }}>×</button>
            </div>
          ))}
        </div>
      )}
      <div className="bbar">
        <button className="icon-btn" disabled={!s?.canGoBack} onClick={() => void api.browser.back()} title="Back"><I.Chevron size={16} style={{ transform: 'rotate(90deg)' }} /></button>
        <button className="icon-btn" disabled={!s?.canGoForward} onClick={() => void api.browser.forward()} title="Forward"><I.Chevron size={16} style={{ transform: 'rotate(-90deg)' }} /></button>
        <button className="icon-btn" onClick={() => void api.browser.reload()} title="Reload">↻</button>
        <form onSubmit={(e) => { e.preventDefault(); setEditing(false); if (url.trim()) void api.browser.navigate(url.trim()) }} style={{ flex: 1 }}>
          <input className="burl" value={url} placeholder="Search or enter address" onFocus={() => setEditing(true)} onBlur={() => setEditing(false)}
            onChange={(e) => setUrl(e.target.value)} data-testid="browser-url" />
        </form>
        <button className="icon-btn" onClick={() => void api.browser.newTab()} title="New tab"><I.Plus size={16} /></button>
        {!s?.teach && (
          <button className="teach-btn" disabled={!!s?.controlling} onClick={() => void api.browser.teachStart()}
            title="Teach a task: do it once here while SahilBot records, and your bot learns to repeat it" data-testid="teach-start">
            <span className="teach-dot" aria-hidden />Teach
          </button>
        )}
      </div>
      {s?.teach && <TeachBar key={s.teach.startedAt} state={s.teach} threadId={threadId} />}
      {(s?.controlling || s?.takenOver) && (
        <div className={`bcontrol${s.takenOver ? ' you' : ''}`} data-testid="browser-overlay">
          {s.takenOver ? (
            <><span>You're in control. SahilBot's browser actions are paused.</span><button onClick={() => void api.browser.takeOver(false)}>Hand back</button></>
          ) : (
            <><span className="spin" /><span>SahilBot is controlling the browser</span><button onClick={() => void api.browser.takeOver(true)} data-testid="take-over">Take over</button></>
          )}
        </div>
      )}
      <div className="bview" ref={view}>
        {!current && <div className="right-body">SahilBot opens pages here when it browses. You can browse too; logins are kept between sessions.</div>}
      </div>
    </div>
  )
}
