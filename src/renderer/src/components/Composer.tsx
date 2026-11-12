import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react'
import type { Attachment, Effort, ModelList, PermissionMode } from '@shared/types'
import { api } from '../api'
import * as I from '../icons'
import { Mic } from '../lib/audio'
import { Popover } from './Popover'

const THINKING: Array<{ id: Effort; label: string; sub: string }> = [
  { id: 'low', label: 'Low', sub: 'Fastest. Quick answers, little thinking' },
  { id: 'medium', label: 'Medium', sub: 'Balanced (recommended). Thinks harder when the problem needs it' },
  { id: 'high', label: 'High', sub: 'Thinks things through more carefully' },
  { id: 'xhigh', label: 'Extra', sub: 'Deep thinking for hard problems and long tasks' },
  { id: 'max', label: 'Max', sub: 'Thinks as long as it needs. Slowest; uses the most tokens' }
]

const MODES: Array<{ id: PermissionMode; label: string; sub: string }> = [
  { id: 'ask', label: 'Ask', sub: 'Approve every action that changes something' },
  { id: 'auto', label: 'Auto', sub: 'Runs reads, edits and routine steps; asks before sending, buying, posting or deleting' },
  { id: 'bypass', label: 'Bypass', sub: 'Everything runs except hard stops. Resets on restart.' }
]

export interface ComposerHandle {
  insert(text: string): void
  /** Replace the box's text (starter ideas). */
  replace(text: string): void
  setDeep(on: boolean): void
  focus(): void
  toggleDictation(): void
  attach(items: Attachment[]): void
}

export interface Outgoing {
  text: string
  images: string[]
  attachments: Attachment[]
  /** Team of Experts for this message. */
  team?: boolean
  /** While SahilBot works: true = wait until it finishes (⌘Enter); otherwise it steers the running agent. */
  queue?: boolean
  /** Deep Research: a team researches, then a cited PDF report. */
  deepResearch?: boolean
}

export const Composer = forwardRef<ComposerHandle, {
  running: boolean
  onSend: (o: Outgoing) => void
  onStop: () => void
  models: ModelList | null
  model: string
  onModel: (id: string) => void
  onRefreshModels: () => void
  mode: PermissionMode
  onMode: (m: PermissionMode) => void
  placeholder?: string
  accent?: string
  /** A bot asked a question: typing answers it. */
  answering?: boolean
  onVoice?: () => void
  /** Opens Settings → Models. */
  onManageModels?: () => void
  thinking?: Effort
  onThinking?: (e: Effort) => void
  /** Left side of the row under the box (Home: the project or folder picker). */
  context?: ReactNode
  /** The big Home version of the box. */
  big?: boolean
  /** Steering messages waiting for the agent's next step. */
  steering?: number
  /** Team of Experts capacity for the current model (null = unknown yet). */
  team?: { on: boolean; maxAgents: number; heavy: boolean; why: string } | null
  onTeam?: (on: boolean) => void
}>(function Composer(p, ref) {
  const [dictating, setDictating] = useState(false)
  const [dictError, setDictError] = useState<string | null>(null)
  const mic = useRef<Mic | null>(null)
  const base = useRef('')
  const [text, setText] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [atts, setAtts] = useState<Attachment[]>([])
  const [drag, setDrag] = useState(false)
  const [deep, setDeep] = useState(false)
  const ta = useRef<HTMLTextAreaElement>(null)

  useImperativeHandle(ref, () => ({
    replace(t: string) {
      setText(t)
      requestAnimationFrame(() => { const el = ta.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length) } })
    },
    setDeep(on: boolean) { setDeep(on) },
    insert(t: string) {
      setText((cur) => (cur ? `${cur}\n${t}` : t))
      // Put the caret at the end so the user can just keep typing.
      requestAnimationFrame(() => { const el = ta.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length) } })
    },
    focus() { ta.current?.focus() },
    toggleDictation() { void toggleRef.current() },
    attach(items: Attachment[]) { addRef.current(items) }
  }))
  const addRef = useRef<(xs: Attachment[]) => void>(() => undefined)
  const toggleRef = useRef<() => Promise<void>>(async () => undefined)
  const [dictSince, setDictSince] = useState(0)
  const [, tick] = useState(0)
  useEffect(() => {
    if (!dictating) return
    const t = setInterval(() => tick((n) => n + 1), 200)
    return () => clearInterval(t)
  }, [dictating])

  useEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [text])

  useEffect(() => { ta.current?.focus() }, [p.placeholder])

  // Dictation: live partials appear in the box; stopping inserts the final text.
  useEffect(() => api.voice.onEvent((e) => {
    if (!mic.current) return
    if (e.type === 'partial') setText(base.current + e.text)
  }), [])
  const toggleDictation = async (): Promise<void> => {
    setDictError(null)
    if (dictating) {
      setDictating(false)
      mic.current?.stop()
      const final = await api.voice.dictateStop()
      mic.current = null
      setText(base.current + final)
      ta.current?.focus()
      return
    }
    try {
      base.current = text ? `${text} ` : ''
      await api.voice.dictateStart()
      mic.current = new Mic()
      await mic.current.start()
      setDictating(true)
      setDictSince(Date.now())
    } catch (e) {
      mic.current = null
      setDictError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }

  toggleRef.current = toggleDictation
  /** Esc while dictating: throw the dictated words away and restore what was typed. */
  const cancelDictation = async (): Promise<void> => {
    setDictating(false)
    mic.current?.stop()
    await api.voice.dictateStop()
    mic.current = null
    setText(base.current.trimEnd())
  }

  const canSend = !!(text.trim() || images.length || atts.length)
  const send = (queue = false): void => {
    if (!canSend) return
    p.onSend({ text: text.trim(), images, attachments: atts, team: p.team?.on || deep, deepResearch: deep, queue })
    setDeep(false)
    setText('')
    setImages([])
    setAtts([])
  }

  const addAtts = (xs: Attachment[]): void => setAtts((cur) => [...cur, ...xs.filter((x) => !cur.some((c) => c.path === x.path))])
  addRef.current = addAtts

  const onDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    setDrag(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length) addAtts(await api.files.fromDrop(files))
  }

  const onPaste = (e: React.ClipboardEvent): void => {
    // Screenshots pasted from the clipboard have no path: keep them as inline images.
    for (const f of Array.from(e.clipboardData.files)) {
      if (!f.type.startsWith('image/')) continue
      const r = new FileReader()
      r.onload = () => setImages((xs) => [...xs, r.result as string])
      r.readAsDataURL(f)
    }
  }

  const current = p.models?.models.find((m) => m.id === p.model)
  const modelLabel = p.model === 'auto' ? 'Auto' : current?.label || p.model || 'Choose model'
  const mode = MODES.find((m) => m.id === p.mode)!

  return (
    <div className="composer-inner">
      <div className={`composer${drag ? ' dragging' : ''}${p.big ? ' big' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => void onDrop(e)}>
        {(images.length > 0 || atts.length > 0) && (
          <div className="attachments" data-testid="attachments">
            {images.map((src, i) => (
              <div className="a" key={`i${i}`}><img src={src} alt="" /><button onClick={() => setImages((xs) => xs.filter((_, j) => j !== i))}>×</button></div>
            ))}
            {atts.map((a) => (
              <div className={`a ${a.kind}`} key={a.path} title={a.path}>
                {a.kind === 'image' && a.dataUrl ? <img src={a.dataUrl} alt="" /> : (
                  <span className="att-pill">{a.kind === 'folder' ? <I.Folder size={14} /> : <I.File size={14} />}<span>{a.name}</span></span>
                )}
                <button onClick={() => setAtts((xs) => xs.filter((x) => x.path !== a.path))}>×</button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={ta}
          rows={p.big ? 2 : 1}
          value={text}
          placeholder={p.answering ? 'Type your answer, or talk about something else' : p.placeholder ?? 'Message SahilBot'}
          onChange={(e) => setText(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && dictating) { e.preventDefault(); e.stopPropagation(); void cancelDictation(); return }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              // Enter while dictating: finish dictation first, then send what was said.
              if (dictating) { void toggleDictation().then(() => requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('[data-testid="send"]')?.click())); return }
              // While SahilBot works: Enter steers it, ⌘Enter queues for when it's done.
              send(e.metaKey || e.ctrlKey)
            }
          }}
          data-testid="composer-input"
        />
        <div className="composer-bar">
          <Popover label={<I.Plus />} className="plus-pop" title="Attach files or a folder">
            {(close) => (
              <>
                <button className="menu-item" onClick={() => { close(); void api.files.pick('files').then(addAtts) }} data-testid="attach-files"><I.Paperclip size={15} />Upload files or photos</button>
                <button className="menu-item" onClick={() => { close(); void api.files.pick('folder').then(addAtts) }} data-testid="attach-folder"><I.Folder size={15} />Attach a folder<span className="sub">SahilBot can read and edit files inside it</span></button>
              </>
            )}
          </Popover>
          {p.team && (
            <button className={`team-chip${deep ? ' on' : ''}`} onClick={() => setDeep((d) => !d)} data-testid="deep-toggle"
              title="Deep Research: a team of helper agents researches in parallel, then SahilBot writes a cited report and saves it as a PDF">
              <I.Search size={15} />Deep Research
            </button>
          )}
          {p.team && p.onTeam && !deep && (
            <button className={`team-chip${p.team.on ? ' on' : ''}`} onClick={() => p.onTeam!(!p.team!.on)} data-testid="team-toggle"
              title={p.team.on ? `Team of Experts is on: ${Math.min(10, p.team.maxAgents)} to ${p.team.maxAgents} helper agents research in parallel, then SahilBot puts it together (${p.team.why})` : `Team of Experts: at least ${Math.min(10, p.team.maxAgents)} helper agents research in parallel, then SahilBot puts it together (${p.team.why})`}>
              <I.Users size={15} />Team of Experts
            </button>
          )}
          <span className="spacer" />
          {dictating && (
            <span className="dictating" data-testid="dictating">
              <span className="dict-bars" style={{ ['--lvl' as string]: Math.min(1, (mic.current?.level ?? 0) * 6) }}><i /><i /><i /><i /></span>
              {Math.floor((Date.now() - dictSince) / 1000)}s
            </span>
          )}
          <button className={`c-btn${dictating ? ' recording' : ''}`} title={dictating ? 'Stop dictation (⌘⇧D) · Esc cancels' : 'Dictate (⌘⇧D)'} onClick={() => void toggleDictation()} data-testid="dictate"><I.Mic /></button>
          {p.running && !p.answering && !canSend ? (
            <button className="c-btn primary" title="Stop (Esc)" onClick={p.onStop} data-testid="stop"><I.Stop /></button>
          ) : canSend ? (
            <button className="c-btn primary" title={p.running && !p.answering ? 'Steer: SahilBot takes this into account right away (⌘Enter queues it instead)' : 'Send'} onClick={() => send(false)} data-testid="send" style={p.accent ? { background: p.accent } : undefined}><I.Up /></button>
          ) : (
            <button className="c-btn ghost" title="Talk with SahilBot (⌘⇧V)" onClick={p.onVoice} data-testid="voice-btn"><I.Wave /></button>
          )}
        </div>
      </div>
      <div className="under">
        {p.context}
        <span className="spacer" />
        <Popover label={<>{modelLabel}</>} className="under-pick" title="Model" testId="model-picker" menuClass="right">
          {(close) => <ModelMenu list={p.models} model={p.model} onPick={(id) => { p.onModel(id); close() }} onRefresh={p.onRefreshModels} onManage={p.onManageModels ? () => { close(); p.onManageModels!() } : undefined} />}
        </Popover>
        {p.thinking && p.onThinking && (
          <Popover label={<span className="dim">{THINKING.find((t) => t.id === p.thinking)?.label}</span>} className="under-pick" title="Thinking (adapts to each problem)" testId="thinking-picker" menuClass="right">
            {(close) => (
              <>
                <div className="menu-head">Thinking · adapts to each problem</div>
                {THINKING.map((t) => (
                  <button key={t.id} className="menu-item" onClick={() => { p.onThinking!(t.id); close() }} data-testid={`thinking-${t.id}`}>
                    <span className="check">{t.id === p.thinking && <I.Check size={14} />}</span>
                    <span>{t.label}<span className="sub">{t.sub}</span></span>
                  </button>
                ))}
              </>
            )}
          </Popover>
        )}
        <Popover label={<>{p.mode === 'bypass' ? <span className="dot red" /> : <I.Shield size={14} />}{mode.label}</>}
          className={`under-pick${p.mode === 'bypass' ? ' bypass' : ''}`} menuClass="right" title="Permission mode" testId="mode-picker">
          {(close) => MODES.map((m) => (
            <button key={m.id} className="menu-item" onClick={() => { p.onMode(m.id); close() }}>
              <span className="check">{m.id === p.mode && <I.Check size={14} />}</span>
              <span>{m.id === 'bypass' ? <span style={{ color: 'var(--danger)' }}>{m.label}</span> : m.label}<span className="sub">{m.sub}</span></span>
            </button>
          ))}
        </Popover>
      </div>
      {p.running && !p.answering && <div className="steer-hint" data-testid="steer-hint"><kbd>Enter</kbd> steers SahilBot now · <kbd>⌘Enter</kbd> queues for when it's done{p.steering ? <span className="steering"> · <span className="spin" /> steering at its next step…</span> : null}</div>}
      {dictError && <div className="bypass-banner">{dictError}</div>}
      {p.mode === 'bypass' && <div className="bypass-banner">Bypass is on for this chat: actions run without asking, except hard stops.</div>}
    </div>
  )
})

const TIER = ['Instant', 'Light', 'Standard', 'Heavy']

function ModelMenu({ list, model, onPick, onRefresh, onManage }: { list: ModelList | null; model: string; onPick: (id: string) => void; onRefresh: () => void; onManage?: () => void }) {
  if (!list) return <div className="menu-head">Loading models…</div>
  const shown = list.models.filter((m) => m.installed && m.enabled)
  const groups = [...new Set(shown.map((m) => m.providerName))]
  return (
    <div className="model-menu">
      <button className="menu-item" onClick={() => onPick('auto')} data-testid="model-option">
        <span className="check">{model === 'auto' && <I.Check size={14} />}</span>
        <span>Auto<span className="sub">Picks the right model for each message: fast for chat, strong for real work</span></span>
      </button>
      {!list.ok && (
        <div style={{ padding: '6px 10px', fontSize: 13, maxWidth: 320 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>No model server answered</div>
          <div className="hint">{list.error}</div>
        </div>
      )}
      {groups.map((g) => (
        <div key={g}>
          <div className="menu-sep" />
          <div className="menu-head">{g}{shown.some((m) => m.providerName === g && m.note !== 'remote') ? ` · this Mac: ${list.totalGB} GB` : ''}</div>
          {shown.filter((m) => m.providerName === g).map((m) => (
            <button key={m.id} className="menu-item" disabled={!m.fits && m.maxFittingWindow === 0} onClick={() => onPick(m.id)}
              title={m.fits ? '' : m.note} data-testid="model-option">
              <span className="check">{m.id === model && <I.Check size={14} />}</span>
              <span>
                {m.label || m.id}{m.vision ? ' · 👁' : ''}
                <span className="sub">
                  {TIER[m.tier]}{m.label ? ` · ${m.id}` : ''} · {m.note === 'remote' ? 'cloud' : `${m.requiredGB} GB`}
                  {!m.fits && m.note && m.note !== 'remote' ? ` · ${m.note}` : ''}
                </span>
              </span>
            </button>
          ))}
        </div>
      ))}
      <div className="menu-sep" />
      {onManage && <button className="menu-item" onClick={onManage} data-testid="manage-models">Manage models…</button>}
      <button className="menu-item" onClick={onRefresh}>Refresh list</button>
    </div>
  )
}
