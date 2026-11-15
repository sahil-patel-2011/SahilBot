import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react'
import type { Attachment, EffortChoice, ModelList, PermissionMode } from '@shared/types'
import { api } from '../api'
import * as I from '../icons'
import { Mic } from '../lib/audio'
import { Popover } from './Popover'
import { modeFlags } from '../lib/swarm-view'
import { AUTO_ENTRIES, autoLabel, autoUnavailableReason, pickerModels, toDownload } from '@shared/model-picker'
// Attachments: drop, paste, the + menu (files, folder, screenshot) and the working folder (components/Attachments.tsx).
import { AttachmentChips, DropOverlay, WorkFolderChip, useFolderCounts } from './Attachments'
import { fromTransfer, mergeAttachments, oversize, rejectedText } from '../lib/attachments'
import { toast } from '../lib/toast'

const THINKING: Array<{ id: EffortChoice; label: string; sub: string }> = [
  { id: 'auto', label: 'Auto', sub: 'Recommended. Picks for each request: more for coding, research and real tasks, less for quick chats' },
  { id: 'low', label: 'Low', sub: 'Fastest. Quick answers, little thinking' },
  { id: 'medium', label: 'Medium', sub: 'Balanced. Some thinking on every request' },
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
  /** Swarm (bot chats): temporary helpers, then the bot compiles. */
  swarm?: true
  /** Council: true = Auto members, or the chosen model ids. */
  council?: true | string[]
  /** A working folder picked before the chat existed (sent with its first message). */
  workingFolder?: string
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
  thinking?: EffortChoice
  onThinking?: (e: EffortChoice) => void
  /** Left side of the row under the box (Home: the project or folder picker). */
  context?: ReactNode
  /** The big Home version of the box. */
  big?: boolean
  /** Steering messages waiting for the agent's next step. */
  steering?: number
  /** Team of Experts capacity for the current model (null = unknown yet). */
  team?: { on: boolean; maxAgents: number; heavy: boolean; why: string } | null
  onTeam?: (on: boolean) => void
  /** A bot chat: its Swarm setting (the Swarm chip shows unless it's off). */
  swarm?: { mode: 'off' | 'auto' | 'always' } | null
  /** Cloud models a Council can use (the Council chip shows with two or more). */
  council?: Array<{ id: string; label: string }> | null
  /** This chat (the Working folder chip); none for a chat that doesn't exist yet. */
  threadId?: string
  /** The bot's or project's folder, the working folder when the chat doesn't pick one. */
  inheritedFolder?: string | null
}>(function Composer(p, ref) {
  const [dictating, setDictating] = useState(false)
  const [dictError, setDictError] = useState<string | null>(null)
  const mic = useRef<Mic | null>(null)
  const base = useRef('')
  const [text, setText] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [atts, setAtts] = useState<Attachment[]>([])
  const [drag, setDrag] = useState(false)
  const [draftFolder, setDraftFolder] = useState<string | null>(null)
  const [deep, setDeep] = useState(false)
  const [planFirst, setPlanFirst] = useState(false)
  const [heavy, setHeavy] = useState(false)
  const [swarmOn, setSwarmOn] = useState(p.swarm?.mode === 'always')
  const [council, setCouncil] = useState<true | string[] | null>(null)
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
    p.onSend({ text: text.trim(), images, attachments: atts, ...(draftFolder && !p.threadId ? { workingFolder: draftFolder } : {}), ...modeFlags({ team: p.team?.on, deep, planFirst, heavy, swarm: swarmOn && !!p.swarm && p.swarm.mode !== 'off', council }), queue, ...(fromLink ? { fromLink } : {}) })
    setDeep(false)
    setHeavy(false)
    setCouncil(null)
    setSwarmOn(p.swarm?.mode === 'always')
    setLinkText(null)
    setText('')
    setImages([])
    setAtts([])
  }

  const addAtts = (xs: Attachment[]): void => setAtts((cur) => mergeAttachments(cur, xs))
  addRef.current = addAtts
  // Attached folders show a live count of what SahilBot can index.
  useFolderCounts(atts, (path, patch) => setAtts((xs) => xs.map((a) => (a.path === path ? { ...a, ...patch } : a))))

  /** Dropped or pasted files (with or without a path: a screenshot on the clipboard, an image from a web page). */
  const addFiles = async (files: File[]): Promise<void> => {
    const { ok, rejected } = oversize(files)
    let r = { added: [] as Attachment[], rejected }
    if (ok.length) {
      try { const x = await api.attach.fromFiles(ok); r = { added: x.added, rejected: [...rejected, ...x.rejected] } } catch (e) { r.rejected.push({ name: ok[0].name || 'Item', reason: (e as Error).message }) }
    }
    if (r.added.length) addAtts(r.added)
    if (r.rejected.length) toast(rejectedText(r.rejected), 'error')
  }

  const onDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    setDrag(false)
    const { files, urls } = fromTransfer(e.dataTransfer)
    if (files.length) return addFiles(files)
    // A link dragged from a browser (no file behind it): it goes in the message as text.
    if (urls.length) setText((cur) => [cur.trim(), ...urls].filter(Boolean).join('\n'))
  }

  const onPaste = (e: React.ClipboardEvent): void => {
    // Pasted screenshots and copied files become attachments (text pastes as usual).
    const files = Array.from(e.clipboardData.files)
    if (!files.length) return
    // Copied text that comes with a picture of itself (cells from Excel or Numbers): paste the text.
    // Files copied in Finder carry their names as text, so they still attach.
    const plain = e.clipboardData.getData('text/plain')
    if (plain.trim() && !files.every((f) => f.name && plain.includes(f.name))) return
    e.preventDefault()
    void addFiles(files)
  }

  const takeScreenshot = async (): Promise<void> => {
    try { const a = await api.attach.screenshot(); if (a) addAtts([a]) } catch (e) { toast((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error') }
  }
  const pick = async (kind: 'files' | 'folder'): Promise<void> => {
    try {
      const r = await api.attach.pick(kind)
      if (r.added.length) addAtts(r.added)
      if (r.rejected.length) toast(rejectedText(r.rejected), 'error')
    } catch (e) { toast((e as Error).message, 'error') }
  }

  // Modes (one menu; the ones that are on show as removable chips). Heavy replaces Team, Deep Research and Plan
  // first for a message, and Council and Heavy exclude each other (see modeFlags): those show as unavailable.
  const swarmAvail = !!p.swarm && p.swarm.mode !== 'off'
  const modeList: ModeItem[] = []
  if (p.team) {
    modeList.push({ id: 'plan', testId: 'plan-toggle', label: 'Plan first', sub: 'Questions and a plan to approve first', icon: <I.ListIcon size={15} />,
      on: planFirst && !heavy, toggle: () => setPlanFirst((x) => !x), blocked: heavy ? 'Off while Heavy is on' : undefined,
      title: 'Plan first: SahilBot asks what it needs to know, shows you its plan, and starts only when you approve' })
    modeList.push({ id: 'deep', testId: 'deep-toggle', label: 'Deep Research', sub: 'A team researches; you get a cited PDF', icon: <I.Search size={15} />,
      on: deep && !heavy, toggle: () => setDeep((d) => !d), blocked: heavy ? 'Off while Heavy is on' : undefined,
      title: 'Deep Research: a team of helper agents researches in parallel, then SahilBot writes a cited report and saves it as a PDF' })
    if (p.onTeam) {
      const t = p.team
      modeList.push({ id: 'team', testId: 'team-toggle', label: 'Team of Experts', chipLabel: 'Team', sub: `${Math.min(10, t.maxAgents)} to ${t.maxAgents} helpers research in parallel`, icon: <I.Users size={15} />,
        on: t.on && !deep && !heavy, toggle: () => p.onTeam!(!t.on), blocked: heavy ? 'Off while Heavy is on' : deep ? 'Deep Research already uses a team' : undefined,
        title: `Team of Experts: helper agents research in parallel, then SahilBot puts it together (${t.why})` })
    }
  }
  if (swarmAvail) {
    modeList.push({ id: 'swarm', testId: 'swarm-toggle', label: 'Swarm', sub: 'Many helpers, then the bot compiles', icon: <I.Layers size={15} />,
      on: swarmOn && !heavy && !council, toggle: () => setSwarmOn((x) => !x), blocked: heavy ? 'Off while Heavy is on' : council ? 'Off while Council is on' : undefined,
      title: 'Swarm: temporary helpers (each with its own angle or slice) work on the job, then the bot compiles their work with credits. On Auto the bot decides on its own' })
  }
  if (p.council) {
    const names = Array.isArray(council) ? council.map((id) => p.council!.find((m) => m.id === id)?.label ?? id).join(' + ') : 'the best Claude + the best GPT'
    modeList.push({ id: 'council', testId: 'council-toggle', label: 'Council', chipLabel: `Council${Array.isArray(council) ? ` (${council.length})` : ''}`, sub: 'Several providers plan and review', icon: <I.Shield size={15} />,
      on: !!council && !heavy, toggle: () => setCouncil((c) => (c ? null : true)), blocked: heavy ? 'Off while Heavy is on' : undefined,
      title: council ? `Council is on: ${names} plan, critique each other, merge one plan, carry it out and review each other (you OK the cost first)` : 'Council: frontier models from different providers plan together, critique each other, then carry it out and review each other' })
  }
  if (p.team) {
    modeList.push({ id: 'heavy', testId: 'heavy-toggle', label: 'Heavy', sub: 'Several attempts, then a judge', icon: <I.Sparkle size={15} />,
      on: heavy && !council, toggle: () => setHeavy((h) => !h), blocked: council ? 'Off while Council is on' : undefined,
      title: 'Heavy: several independent attempts, then a judge compares them, checks what they disagree on and writes the final answer (you OK the cost first when it is more than a little)' })
  }
  const activeModes = modeList.filter((m) => m.on)
  const current = p.models?.models.find((m) => m.id === p.model)
  const modelLabel = (p.model ? autoLabel(p.model) : undefined) ?? (current?.label || p.model || 'Choose model')
  const mode = MODES.find((m) => m.id === p.mode) ?? MODES[1]
  const modes = MODES.filter((m) => m.id !== 'bypass' || p.allowBypass || p.mode === 'bypass')

  return (
    <div className="composer-inner">
      <div className={`composer${drag ? ' dragging' : ''}${p.big ? ' big' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrag(false) }}
        onDrop={(e) => void onDrop(e)}
        data-testid="composer-drop">
        <DropOverlay show={drag} />
        <AttachmentChips images={images} atts={atts}
          onRemoveImage={(i) => setImages((xs) => xs.filter((_, j) => j !== i))}
          onRemove={(path) => setAtts((xs) => xs.filter((x) => x.path !== path))} />
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
                <button className="menu-item" onClick={() => { close(); void pick('files') }} data-testid="attach-files"><I.Paperclip size={15} />Upload files or photos<span className="sub">Any type, up to 100 MB each. You can also drop or paste them</span></button>
                <button className="menu-item" onClick={() => { close(); void pick('folder') }} data-testid="attach-folder"><I.Folder size={15} />Attach a folder<span className="sub">SahilBot can read, search and edit files inside it</span></button>
                <button className="menu-item" onClick={() => { close(); void takeScreenshot() }} data-testid="attach-screenshot"><I.Image size={15} />Take screenshot<span className="sub">Drag over part of the screen (Esc cancels)</span></button>
              </>
            )}
          </Popover>
          {modeList.length > 0 && (
            <Popover
              label={<><I.Sliders size={16} /><span className="modes-label">Modes</span>{activeModes.length > 0 && <span className="modes-count" aria-label={`${activeModes.length} on`}>{activeModes.length}</span>}</>}
              className={`modes-pop${activeModes.length ? ' on' : ''}`} menuClass="modes-wrap" title="Modes: Plan first, Deep Research, Team, Swarm, Council, Heavy" testId="modes-menu">
              {(close) => (
                <div className="modes-menu" role="menu" aria-label="Modes">
                  {modeList.map((m) => (
                    <button key={m.id} className={`menu-item${m.on ? ' on' : ''}`} role="menuitemcheckbox" aria-checked={m.on} disabled={!!m.blocked}
                      onClick={() => { m.toggle(); close() }} data-testid={m.testId} title={m.title}>
                      <span className="mode-ico" aria-hidden>{m.icon}</span>
                      <span className="mode-text">{m.label}<span className="sub">{m.blocked ?? m.sub}</span></span>
                      <span className="mode-state" aria-hidden>{m.on && <I.Check size={15} />}</span>
                    </button>
                  ))}
                </div>
              )}
            </Popover>
          )}
          {activeModes.length > 0 && (
            <span className="mode-chips">
              {activeModes.map((m) => (
                <span key={m.id} className="mode-chip" data-testid={`mode-chip-${m.id}`} title={m.title}>
                  {m.icon}<span className="mode-chip-label">{m.chipLabel ?? m.label}</span>
                  {m.id === 'council' && p.council && (
                    <Popover label={<I.Chevron size={12} />} className="council-pick" title="Choose the council's members" testId="council-pick">
                      {(close) => (
                        <>
                          <button className={`menu-item${council === true ? ' on' : ''}`} onClick={() => { setCouncil(true); close() }}>Auto<span className="sub">The best Claude and the best GPT available</span></button>
                          {p.council!.map((cm) => {
                            const picked = Array.isArray(council) && council.includes(cm.id)
                            return (
                              <button key={cm.id} className={`menu-item${picked ? ' on' : ''}`} data-testid="council-member-pick"
                                onClick={() => setCouncil((c) => { const cur = Array.isArray(c) ? c : []; const next = cur.includes(cm.id) ? cur.filter((x) => x !== cm.id) : [...cur, cm.id].slice(0, 4); return next.length ? next : true })}>
                                {picked ? <I.Check size={13} /> : <span style={{ width: 13 }} />}{cm.label}
                              </button>
                            )
                          })}
                        </>
                      )}
                    </Popover>
                  )}
                  <button className="mode-chip-x" onClick={m.toggle} aria-label={`Turn off ${m.label}`} title={`Turn off ${m.label}`}><I.Close size={12} /></button>
                </span>
              ))}
            </span>
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
        <WorkFolderChip threadId={p.threadId} inherited={p.inheritedFolder} draft={draftFolder} onDraft={setDraftFolder} />
        <span className="spacer" />
        <Popover label={<><I.Cpu size={14} />{modelLabel}</>} className="under-pick" title="Model" testId="model-picker" menuClass="right">
          {(close) => <ModelMenu list={p.models} model={p.model} onPick={(id) => { p.onModel(id); close() }} onRefresh={p.onRefreshModels} onManage={p.onManageModels ? () => { close(); p.onManageModels!() } : undefined} />}
        </Popover>
        {p.thinking && p.onThinking && (
          <Popover label={<><I.Sparkle size={14} /><span className="dim">{THINKING.find((t) => t.id === p.thinking)?.label}</span></>} className="under-pick" title="Thinking for this chat" testId="thinking-picker" menuClass="right">
            {(close) => (
              <>
                <div className="menu-head">Thinking · a level you pick is used as is</div>
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
                  <span>{m.id === 'bypass' ? <span className="ui-text-danger">{m.label}</span> : m.label}<span className="sub">{m.sub}</span></span>
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

/** One entry in the composer's Modes menu. */
type ModeItem = { id: string; testId: string; label: string; chipLabel?: string; sub: string; icon: ReactNode; on: boolean; toggle: () => void; blocked?: string; title: string }

function ModelMenu({ list, model, onPick, onRefresh, onManage }: { list: ModelList | null; model: string; onPick: (id: string) => void; onRefresh: () => void; onManage?: () => void }) {
  if (!list) return <div className="menu-head">Loading models…</div>
  // Only models that can run now: downloaded local ones and cloud ones with a key. Downloads live in Settings.
  const shown = pickerModels(list)
  const groups = [...new Set(shown.map((m) => m.providerName))]
  const more = toDownload(list).length
  return (
    <div className="model-menu">
      {AUTO_ENTRIES.filter((e) => e.id !== 'auto:local' || !list.localOff).map((e) => {
        // A variant with nothing to route to says why (and stays pickable: models may come back).
        const why = autoUnavailableReason(e.id, list)
        return (
          <button key={e.id} className={`menu-item${why ? ' unavailable' : ''}`} onClick={() => onPick(e.id)} data-testid="model-option" data-auto={e.id}>
            <span className="check">{model === e.id && <I.Check size={14} />}</span>
            <span>{e.label}<span className="sub">{why ?? e.sub}</span></span>
            {/* Still pickable (models may come back), but it reads as "not right now" at a glance. */}
            {why && <span className="mm-badge" data-testid="auto-unavailable">Unavailable</span>}
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
