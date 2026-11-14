import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react'
import type { Attachment, Effort, ModelList, PermissionMode } from '@shared/types'
import { api } from '../api'
import * as I from '../icons'
import { Mic } from '../lib/audio'
import { Popover } from './Popover'
import { modeFlags } from '../lib/swarm-view'
import { AUTO_ENTRIES, autoLabel, autoUnavailableReason, pickerModels, toDownload } from '@shared/model-picker'

const THINKING: Array<{ id: Effort; label: string; sub: string }> = [
  { id: 'low', label: 'Low', sub: 'Fastest. Quick answers, little thinking' },
  { id: 'medium', label: 'Medium', sub: 'Balanced (recommended). Thinks harder when the problem needs it' },
  { id: 'high', label: 'High', sub: 'Thinks things through more carefully' },
  { id: 'xhigh', label: 'Extra', sub: 'Deep thinking for hard problems and long tasks' },
  { id: 'max', label: 'Max', sub: 'Thinks as long as it needs. Slowest; uses the most tokens' }
]

/** Autonomy levels, least to most on its own. Bypass shows only when Settings → Advanced allows it. */
export const MODES: Array<{ id: PermissionMode; label: string; sub: string }> = [
  { id: 'ask', label: 'Ask first', sub: 'Approve every action that changes something' },
  { id: 'auto', label: 'Auto', sub: 'Routine steps run on their own. Asks before installing, sending, buying, posting or deleting' },
  { id: 'autonomous', label: 'Autonomous', sub: 'Also runs builds, tests, installs from the project\'s lockfile, git and file changes in your folders. Still asks before deleting, sending, buying, or going outside your folders' },
  { id: 'bypass', label: 'Bypass', sub: 'Everything runs except hard stops. Resets on restart.' }
]

export interface ComposerHandle {
  insert(text: string): void
  /** Replace the box's text (starter ideas). */
  replace(text: string): void
  /** Text from a sahilbot:// link: shown with a "review before sending" banner, marked if sent unedited. */
  prefillFromLink(text: string): void
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
  /** Plan first: questions and a plan to approve before anything changes. */
  planFirst?: boolean
  /** The text came from a sahilbot:// link and was sent as it was (not edited): it isn't the user's own words. */
  fromLink?: boolean
  /** Heavy: several independent attempts, then a judge compares them and writes the answer. */
  heavy?: boolean
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
  /** Offer Bypass in the picker (Settings → Advanced). */
  allowBypass?: boolean
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
  const [planFirst, setPlanFirst] = useState(false)
  const [heavy, setHeavy] = useState(false)
  /** Text a sahilbot:// link put in the box (null: none). Cleared when the box is emptied or sent. */
  const [linkText, setLinkText] = useState<string | null>(null)
  const ta = useRef<HTMLTextAreaElement>(null)

  useImperativeHandle(ref, () => ({
    replace(t: string) {
      setLinkText(null)
      setText(t)
      requestAnimationFrame(() => { const el = ta.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length) } })
    },
    prefillFromLink(t: string) {
      setLinkText(t)
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
  // Leaving this chat (or the app) ends dictation.
  useEffect(() => () => {
    if (!mic.current) return
    mic.current.stop()
    mic.current = null
    void api.voice.dictateStop()
  }, [])
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
    if (mic.current) {
      mic.current.stop()
      mic.current = null
      setDictating(false)
      void api.voice.dictateStop()
    }
    // Sent exactly as the link had it: not the user's own words (the agent treats it as relayed text).
    const fromLink = linkText !== null && text.trim() === linkText.trim()
    // Heavy replaces Team, Deep Research and Plan first for this message (see modeFlags).
    p.onSend({ text: text.trim(), images, attachments: atts, ...modeFlags({ team: p.team?.on, deep, planFirst, heavy }), queue, ...(fromLink ? { fromLink } : {}) })
    setDeep(false)
    setHeavy(false)
    setLinkText(null)
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
  const modelLabel = (p.model ? autoLabel(p.model) : undefined) ?? (current?.label || p.model || 'Choose model')
  const mode = MODES.find((m) => m.id === p.mode) ?? MODES[1]
  const modes = MODES.filter((m) => m.id !== 'bypass' || p.allowBypass || p.mode === 'bypass')

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
          <Popover label={<I.Plus size={19} />} className="plus-pop" title="Attach files or a folder">
            {(close) => (
              <>
                <button className="menu-item" onClick={() => { close(); void api.files.pick('files').then(addAtts) }} data-testid="attach-files"><I.Paperclip size={15} />Upload files or photos</button>
                <button className="menu-item" onClick={() => { close(); void api.files.pick('folder').then(addAtts) }} data-testid="attach-folder"><I.Folder size={15} />Attach a folder<span className="sub">SahilBot can read and edit files inside it</span></button>
              </>
            )}
          </Popover>
          {p.team && !heavy && (
            <button className={`team-chip${planFirst ? ' on' : ''}`} onClick={() => setPlanFirst((x) => !x)} data-testid="plan-toggle"
              title="Plan first: SahilBot asks what it needs to know, shows you its plan, and starts only when you approve">
              <I.ListIcon size={15} /><span className="chip-label">Plan first</span>
            </button>
          )}
          {p.team && !heavy && (
            <button className={`team-chip${deep ? ' on' : ''}`} onClick={() => setDeep((d) => !d)} data-testid="deep-toggle"
              title="Deep Research: a team of helper agents researches in parallel, then SahilBot writes a cited report and saves it as a PDF">
              <I.Search size={15} /><span className="chip-label">Deep Research</span>
            </button>
          )}
          {p.team && p.onTeam && !deep && !heavy && (
            <button className={`team-chip${p.team.on ? ' on' : ''}`} onClick={() => p.onTeam!(!p.team!.on)} data-testid="team-toggle"
              title={p.team.on ? `Team of Experts is on: ${Math.min(10, p.team.maxAgents)} to ${p.team.maxAgents} helper agents research in parallel, then SahilBot puts it together (${p.team.why})` : `Team of Experts: at least ${Math.min(10, p.team.maxAgents)} helper agents research in parallel, then SahilBot puts it together (${p.team.why})`}>
              <I.Users size={15} /><span className="chip-label">Team of Experts</span>
            </button>
          )}
          {p.team && (
            <button className={`team-chip heavy-chip${heavy ? ' on' : ''}`} onClick={() => setHeavy((h) => !h)} data-testid="heavy-toggle" aria-pressed={heavy}
              title={heavy ? 'Heavy is on: several independent attempts work on this, then a judge compares them and writes the answer (you OK the cost first when it is more than a little)' : 'Heavy: several independent attempts, then a judge compares them, checks what they disagree on and writes the final answer'}>
              <I.Sparkle size={15} /><span className="chip-label">Heavy</span>
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
            <button className="c-btn primary stop" title="Stop (Esc)" onClick={p.onStop} data-testid="stop"><I.Stop /></button>
          ) : canSend ? (
            <button className="c-btn primary send" title={p.running && !p.answering ? 'Steer: SahilBot takes this into account right away (⌘Enter queues it instead)' : 'Send'} onClick={() => send(false)} data-testid="send" style={p.accent ? { background: p.accent } : undefined}><I.Up /></button>
          ) : (
            <button className="c-btn voice" title="Voice chat (⌘⇧V)" aria-label="Voice chat" onClick={p.onVoice} data-testid="voice-btn"><I.Wave size={17} /></button>
          )}
        </div>
      </div>
      <div className="under">
        {p.context}
        <span className="spacer" />
        <Popover label={<><I.Cpu size={14} />{modelLabel}</>} className="under-pick" title="Model" testId="model-picker" menuClass="right">
          {(close) => <ModelMenu list={p.models} model={p.model} onPick={(id) => { p.onModel(id); close() }} onRefresh={p.onRefreshModels} onManage={p.onManageModels ? () => { close(); p.onManageModels!() } : undefined} />}
        </Popover>
        {p.thinking && p.onThinking && (
          <Popover label={<><I.Sparkle size={14} /><span className="dim">{THINKING.find((t) => t.id === p.thinking)?.label}</span></>} className="under-pick" title="Thinking (adapts to each problem)" testId="thinking-picker" menuClass="right">
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
        {p.mode === 'autonomous' && p.running && (
          <span className="autonomy-chip" role="status" data-testid="autonomous-chip"
            title="Working on its own: builds, tests, installs from the lockfile, git and file changes in your folders run without asking. Deleting, sending, buying and anything outside your folders still ask.">
            <span className="autonomy-dot" aria-hidden />Working on its own
          </span>
        )}
        <Popover label={<>{p.mode === 'bypass' ? <span className="dot red" /> : p.mode === 'autonomous' ? <I.Play size={13} /> : <I.Shield size={14} />}{mode.label}</>}
          className={`under-pick${p.mode === 'bypass' ? ' bypass' : ''}${p.mode === 'autonomous' ? ' autonomous' : ''}`} menuClass="right" title="Autonomy: how much SahilBot does without asking" testId="mode-picker">
          {(close) => (
            <div className="autonomy-menu">
              <div className="menu-head">Autonomy · this chat</div>
              {modes.map((m) => (
                <button key={m.id} className="menu-item" onClick={() => { p.onMode(m.id); close() }} data-testid={`mode-${m.id}`} aria-checked={m.id === p.mode} role="menuitemradio">
                  <span className="check">{m.id === p.mode && <I.Check size={14} />}</span>
                  <span>{m.id === 'bypass' ? <span style={{ color: 'var(--danger)' }}>{m.label}</span> : m.label}<span className="sub">{m.sub}</span></span>
                </button>
              ))}
              <div className="menu-foot">Passwords are never shared, and purchases always ask, at every level.</div>
            </div>
          )}
        </Popover>
      </div>
      {p.running && !p.answering && <div className="steer-hint" data-testid="steer-hint"><kbd>Enter</kbd> steers SahilBot now · <kbd>⌘Enter</kbd> queues for when it's done{p.steering ? <span className="steering"> · <span className="spin" /> steering at its next step…</span> : null}</div>}
      {dictError && <div className="bypass-banner">{dictError}</div>}
      {linkText !== null && text.trim() !== '' && (
        <div className="bypass-banner" data-testid="link-prefill-banner">
          {text.trim() === linkText.trim()
            ? 'Text from a link — review before sending. Sent as is, SahilBot treats it as coming from the link, not from you.'
            : 'Text from a link, edited by you — review before sending.'}
        </div>
      )}
      {p.mode === 'bypass' && <div className="bypass-banner">Bypass is on for this chat: actions run without asking, except hard stops.</div>}
    </div>
  )
})

const TIER = ['Instant', 'Light', 'Standard', 'Heavy']

function ModelMenu({ list, model, onPick, onRefresh, onManage }: { list: ModelList | null; model: string; onPick: (id: string) => void; onRefresh: () => void; onManage?: () => void }) {
  if (!list) return <div className="menu-head">Loading models…</div>
  // Only models that can run now: downloaded local ones and cloud ones with a key. Downloads live in Settings.
  const shown = pickerModels(list)
  const groups = [...new Set(shown.map((m) => m.providerName))]
  const more = toDownload(list).length
  return (
    <div className="model-menu">
      {AUTO_ENTRIES.map((e) => {
        // A variant with nothing to route to says why (and stays pickable: models may come back).
        const why = autoUnavailableReason(e.id, list)
        return (
          <button key={e.id} className="menu-item" onClick={() => onPick(e.id)} data-testid="model-option" data-auto={e.id}>
            <span className="check">{model === e.id && <I.Check size={14} />}</span>
            <span>{e.label}<span className="sub">{why ?? e.sub}</span></span>
          </button>
        )
      })}
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
      {onManage && (
        <button className="menu-item" onClick={onManage} data-testid="manage-models">
          <span>Manage models…{more > 0 && <span className="sub">{more} recommended for this Mac to download</span>}</span>
        </button>
      )}
      <button className="menu-item" onClick={onRefresh}>Refresh list</button>
    </div>
  )
}
