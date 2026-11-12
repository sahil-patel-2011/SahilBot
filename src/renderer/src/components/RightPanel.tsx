import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import type { BrowserState, FilePreview, Message } from '@shared/types'
import { prettyName } from '../lib/steps'
import { Markdown } from './Markdown'
import { api } from '../api'
import * as I from '../icons'

export type PanelTab = 'progress' | 'browser' | 'file'

export function RightPanel({ tab, onTab, hidden, messages, file, onOpenFile, browserState, onClose }: {
  tab: PanelTab
  onTab: (t: PanelTab) => void
  hidden: boolean
  messages: Message[]
  file: string | null
  onOpenFile: (p: string) => void
  browserState: BrowserState | null
  onClose: () => void
}) {
  return (
    <aside className="right" data-testid="right-panel">
      <div className="right-tabs drag">
        <button className={`tab${tab === 'progress' ? ' on' : ''}`} onClick={() => onTab('progress')} data-testid="tab-progress"><I.ListIcon size={14} /> Progress</button>
        <button className={`tab${tab === 'browser' ? ' on' : ''}`} onClick={() => onTab('browser')}><I.Globe size={14} /> Browser</button>
        <button className={`tab${tab === 'file' ? ' on' : ''}`} onClick={() => onTab('file')} data-testid="tab-file"><I.File size={14} /> File</button>
        <span style={{ flex: 1 }} />
        <button className="icon-btn" onClick={onClose} title="Close panel"><I.Close size={15} /></button>
      </div>
      {tab === 'browser' && <BrowserPane hidden={hidden} />}
      {tab === 'progress' && <ProgressPane messages={messages} onOpenFile={onOpenFile} browserState={browserState} onBrowser={() => onTab('browser')} />}
      {tab === 'file' && <FilePane path={file} />}
    </aside>
  )
}

// ---------------------------------------------------------------- progress

function ProgressPane({ messages, onOpenFile, browserState, onBrowser }: { messages: Message[]; onOpenFile: (p: string) => void; browserState: BrowserState | null; onBrowser: () => void }) {
  const steps = messages.flatMap((m) => m.toolCalls ?? [])
  const results = new Map(messages.filter((m) => m.role === 'tool').map((m) => [m.toolCallId, m]))
  const lastTodo = [...steps].reverse().find((c) => c.name === 'todo')
  let plan: Array<{ text: string; status: string }> = []
  try { plan = lastTodo ? JSON.parse(lastTodo.arguments).items ?? [] : [] } catch { plan = [] }
  const outputs = [...new Map(messages.filter((m) => m.role === 'tool' && m.meta?.status === 'ok' && typeof m.meta?.path === 'string')
    .map((m) => [m.meta!.path as string, m])).values()].reverse()
  const attached = messages.flatMap((m) => [
    ...((m.meta?.files ?? []) as Array<{ name: string; path: string }>).map((f) => ({ ...f, folder: false })),
    ...((m.meta?.folders ?? []) as string[]).map((f) => ({ name: f.split('/').pop()!, path: f, folder: true }))
  ])
  const used = new Map<string, number>()
  for (const c of steps) {
    const label = (results.get(c.id)?.meta?.label as string | undefined) ?? prettyName(c.name)
    used.set(label, (used.get(label) ?? 0) + 1)
  }
  const done = plan.filter((t) => t.status === 'done').length

  return (
    <div className="progress-pane" data-testid="progress-pane">
      <section>
        <h4>Plan {plan.length > 0 && <span className="hint">{done} of {plan.length}</span>}</h4>
        {plan.length === 0 ? <div className="hint">SahilBot writes a plan here for tasks with several steps.</div> : (
          <ol className="plan">
            {plan.map((t, i) => (
              <li key={i} className={`plan-${t.status}`}>
                <span className="plan-dot">{t.status === 'done' ? <I.Check size={12} /> : ''}</span>
                <span>{t.text}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
      <section>
        <h4>Outputs</h4>
        {outputs.length === 0 ? <div className="hint">Files SahilBot creates show up here.</div> : (
          <div className="outputs-grid">
            {outputs.map((m) => {
              const path = m.meta!.path as string
              const ext = path.split('.').pop()?.toUpperCase()
              return (
                <button key={path} className="output-card" onClick={() => onOpenFile(path)} data-testid="output-card">
                  <span className={`ext ext-${ext?.toLowerCase()}`}>{ext}</span>
                  <span className="output-name">{path.split('/').pop()}</span>
                </button>
              )
            })}
          </div>
        )}
      </section>
      <button className="progress-row" onClick={onBrowser}>
        <I.Globe size={15} /><span>Built-in browser</span>
        <span className="hint">{browserState?.tabs.length ? `${browserState.tabs.length} tab${browserState.tabs.length > 1 ? 's' : ''}${browserState.controlling ? ' · in use' : ''}` : 'idle'}</span>
        <I.Chevron size={13} style={{ transform: 'rotate(-90deg)' }} />
      </button>
      <section>
        <h4>Used in this chat</h4>
        {attached.map((a) => (
          <div key={a.path} className="used-row" title={a.path} onClick={() => !a.folder && onOpenFile(a.path)}>
            {a.folder ? <I.Folder size={15} /> : <I.Paperclip size={15} />}<span>{a.folder ? 'Folder' : 'Upload'}</span><span className="hint">{a.name}</span>
          </div>
        ))}
        {[...used.entries()].map(([label, n]) => (
          <div key={label} className="used-row"><I.Cpu size={15} /><span>{label}</span><span className="hint">{n}×</span></div>
        ))}
        {used.size === 0 && attached.length === 0 && <div className="hint">Nothing yet.</div>}
      </section>
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
    if (path) api.files.preview(path).then(setP).catch((e: Error) => setErr(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')))
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
        {p.kind === 'html' && <div className="doc-page md" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(p.html ?? '') }} />}
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

function BrowserPane({ hidden }: { hidden: boolean }) {
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
  }, [hidden, s?.controlling, s?.takenOver, s?.tabs.length])

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
      </div>
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
