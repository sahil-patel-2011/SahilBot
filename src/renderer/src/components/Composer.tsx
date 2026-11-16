import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react'
import type { Attachment, EffortChoice, ModelList, PermissionMode } from '@shared/types'
import { api } from '../api'
import * as I from '../icons'
import { Mic } from '../lib/audio'
import { Popover } from './Popover'
import { modeFlags } from '../lib/swarm-view'
// Model, thinking and permissions: one picker under the box (components/ComposerPicker.tsx).
import { ComposerPicker, MODES } from './ComposerPicker'
// Attachments: drop, paste, the + menu (files, folder, screenshot) and the working folder (components/Attachments.tsx).
import { AttachmentChips, DropOverlay, WorkFolderChip, useFolderCounts, type FolderProjects } from './Attachments'
import { fromTransfer, mergeAttachments, oversize, rejectedText } from '../lib/attachments'
import { toast } from '../lib/toast'
import { findSecrets } from '@shared/secret-detect'

/** Autonomy levels (defined with the picker). */
export { MODES }

export interface ComposerHandle {
  insert(text: string): void
  /** Replace the box's text (starter ideas). */
  replace(text: string): void
  /** Text from a sahilbot:// link: shown with a "review before sending" banner, marked if sent unedited. */
  prefillFromLink(text: string): void
  setDeep(on: boolean): void
  /** ⌘⇧M and the command palette: Max on or off for the next message. */
  toggleMax(): void
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
  /** Heavy (older clients): several independent attempts, then a judge. Max covers it now. */
  heavy?: boolean
  /** Max: many agents at once; SahilBot picks a team, a swarm, judged attempts or a mix. */
  max?: true
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
  /** Home, before the chat exists: projects the Folder chip offers ("Use a project…"). */
  projects?: FolderProjects
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
  /** A bot or group chat: the picker shows model and thinking as chosen automatically (permissions stay editable). */
  autoBot?: boolean
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
  // Max: on for this message (a bot whose Max setting is Always has it on for every request).
  const maxAlways = p.swarm?.mode === 'always'
  const [maxOn, setMaxOn] = useState(false)
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
    toggleMax() { setMaxOn((x) => !x); setCouncil(null) },
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
    // Council replaces the other modes for this message (see modeFlags); Max goes with Plan first and Deep Research.
    p.onSend({ text: text.trim(), images, attachments: atts, ...(draftFolder && !p.threadId ? { workingFolder: draftFolder } : {}), ...modeFlags({ deep, planFirst, max: maxOn || maxAlways, council }), queue, ...(fromLink ? { fromLink } : {}) })
    setDeep(false)
    setMaxOn(false)
    setCouncil(null)
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

  // Modes (one menu; the ones that are on show as removable chips): Plan first, Max, Deep Research, Council.
  // Max is one mode for many agents (a research team, an idea swarm, competing attempts with a judge, or a mix:
  // SahilBot picks per request). Council excludes Max (see modeFlags): those show as unavailable.
  const modeList: ModeItem[] = []
  if (p.team) {
    modeList.push({ id: 'plan', testId: 'plan-toggle', label: 'Plan first', sub: 'Questions and a plan to approve first', icon: <I.ListIcon size={15} />,
      on: planFirst && !council, toggle: () => setPlanFirst((x) => !x), blocked: council ? 'Off while Council is on' : undefined,
      title: 'Plan first: SahilBot asks what it needs to know, shows you its plan, and starts only when you approve' })
    const helpers = p.team.maxAgents
    modeList.push({ id: 'max', testId: 'max-toggle', label: 'Max', keys: '⌘⇧M', sub: 'Many agents at once: SahilBot picks a research team, an idea swarm, competing attempts with a judge, or a mix.', icon: <I.Bolt size={15} />,
      on: (maxOn || maxAlways) && !council, toggle: () => { if (!maxAlways) setMaxOn((x) => !x) },
      blocked: council ? 'Off while Council is on' : maxAlways ? 'Always on for this bot (its Max setting)' : undefined,
      title: `Max: many agents at once. SahilBot picks a research team, an idea swarm, competing attempts with a judge, or a mix, sized to the task (up to ${helpers} helpers on this model), and shows its plan on one live card (⌘⇧M)` })
    modeList.push({ id: 'deep', testId: 'deep-toggle', label: 'Deep Research', sub: 'A team researches; you get a cited PDF', icon: <I.Search size={15} />,
      on: deep && !council, toggle: () => setDeep((d) => !d), blocked: council ? 'Off while Council is on' : undefined,
      title: 'Deep Research: a team of helper agents researches in parallel, then SahilBot writes a cited report and saves it as a PDF' })
  }
  if (p.council) {
    const names = Array.isArray(council) ? council.map((id) => p.council!.find((m) => m.id === id)?.label ?? id).join(' + ') : 'the best Claude + the best GPT'
    modeList.push({ id: 'council', testId: 'council-toggle', label: 'Council', chipLabel: `Council${Array.isArray(council) ? ` (${council.length})` : ''}`, sub: 'Several providers plan and review', icon: <I.Shield size={15} />,
      on: !!council && !maxOn, toggle: () => setCouncil((c) => (c ? null : true)), blocked: maxOn ? 'Off while Max is on' : undefined,
      title: council ? `Council is on: ${names} plan, critique each other, merge one plan, carry it out and review each other (you OK the cost first)` : 'Council: frontier models from different providers plan together, critique each other, then carry it out and review each other' })
  }
  const activeModes = modeList.filter((m) => m.on)

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
        {(() => {
          // A password, key, card or ID number in the message: say it stays out of the model's sight.
          const found = text.length > 3 && text.length < 20_000 ? findSecrets(text) : []
          if (!found.length) return null
          const what = [...new Set(found.map((f) => (f.kind === 'card' ? 'card number' : f.kind === 'api_key' ? 'API key' : f.kind === 'id_number' ? 'ID number' : 'password')))].join(' and ')
          return <div className="composer-secret-hint" data-testid="composer-secret-hint"><I.Shield size={12} />That looks like a {what}. SahilBot hides it from the model and offers to save it to your Vault.</div>
        })()}
        <div className="composer-bar">
          <Popover label={<I.Plus size={19} />} className="plus-pop" title="Attach files, a folder or a screenshot">
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
              className={`modes-pop${activeModes.length ? ' on' : ''}`} menuClass="modes-wrap" title="Modes: Plan first, Max, Deep Research, Council" testId="modes-menu">
              {(close) => (
                <div className="modes-menu" role="menu" aria-label="Modes">
                  {modeList.map((m) => (
                    <button key={m.id} className={`menu-item${m.on ? ' on' : ''}`} role="menuitemcheckbox" aria-checked={m.on} disabled={!!m.blocked}
                      onClick={() => { m.toggle(); close() }} data-testid={m.testId} title={m.title}>
                      <span className="mode-ico" aria-hidden>{m.icon}</span>
                      <span className="mode-text">{m.label}<span className="sub">{m.blocked ?? m.sub}</span></span>
                      {m.keys && <kbd className="mode-keys" aria-label={`Shortcut ${m.keys}`}>{m.keys}</kbd>}
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
                  {!m.blocked && <button className="mode-chip-x" onClick={m.toggle} aria-label={`Turn off ${m.label}`} title={`Turn off ${m.label}`}><I.Close size={12} /></button>}
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
            <button className="c-btn primary send" title={p.running && !p.answering ? 'Send now: SahilBot adjusts what it is doing (⌘Enter sends after it finishes)' : 'Send (Enter)'} onClick={() => send(false)} data-testid="send" style={p.accent ? { background: p.accent } : undefined}><I.Up /></button>
          ) : (
            <button className="c-btn voice" title="Voice chat (⌘⇧V)" aria-label="Voice chat" onClick={p.onVoice} data-testid="voice-btn"><I.Wave size={17} /></button>
          )}
        </div>
      </div>
      <div className="under">
        <WorkFolderChip threadId={p.threadId} inherited={p.inheritedFolder} draft={draftFolder} onDraft={setDraftFolder} projects={p.projects} />
        <span className="spacer" />
        {p.mode === 'bypass' && (
          <span className="bypass-chip" role="status" data-testid="bypass-chip"
            title="Bypass is on for this chat: everything runs without asking, except purchases, passwords and one-time codes. It resets to Auto when SahilBot restarts.">
            <span className="bypass-dot" aria-hidden />Bypass on
          </span>
        )}
        <ComposerPicker models={p.models} model={p.model} onModel={p.onModel} onRefreshModels={p.onRefreshModels} onManageModels={p.onManageModels}
          thinking={p.thinking} onThinking={p.onThinking} mode={p.mode} onMode={p.onMode} allowBypass={p.allowBypass} autoBot={p.autoBot} />
      </div>
      {p.running && !p.answering && (
        <div className="steer-hint" data-testid="steer-hint">
          <kbd>Enter</kbd> send now (SahilBot adjusts) · <kbd>⌘Enter</kbd> send after it finishes
          {p.steering ? <span className="steering"> · <span className="spin" /> adjusting at its next step…</span> : null}
        </div>
      )}
      {dictError && <div className="bypass-banner">{dictError}</div>}
      {linkText !== null && text.trim() !== '' && (
        <div className="bypass-banner" data-testid="link-prefill-banner">
          {text.trim() === linkText.trim()
            ? 'Text from a link — review before sending. Sent as is, SahilBot treats it as coming from the link, not from you.'
            : 'Text from a link, edited by you — review before sending.'}
        </div>
      )}
    </div>
  )
})

/** One entry in the composer's Modes menu. */
type ModeItem = { id: string; testId: string; label: string; keys?: string; chipLabel?: string; sub: string; icon: ReactNode; on: boolean; toggle: () => void; blocked?: string; title: string }
