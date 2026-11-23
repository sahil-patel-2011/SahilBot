import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { Attachment, EffortChoice, ModelList, PermissionMode } from '@shared/types'
import { api } from '../api'
import * as I from '../icons'
import { Mic } from '../lib/audio'
import { clearDraft, loadDraft, saveDraft } from '../lib/drafts'
import { slashMatches, type SlashCommand } from '../lib/slash'
import { Popover } from './Popover'
import { modeFlags } from '../lib/swarm-view'
// Model, thinking and permissions: one picker under the box (components/ComposerPicker.tsx).
import { ComposerPicker, MODES } from './ComposerPicker'
// Attachments: drop, paste, the + menu (files, folder, screenshot) and the working folder (components/Attachments.tsx).
import { AttachmentChips, DropOverlay, WorkFolderChip, useFolderCounts, type FolderProjects } from './Attachments'
import { fromTransfer, mergeAttachments, oversize, rejectedText } from '../lib/attachments'
import { toast } from '../lib/toast'
import { findSecrets } from '@shared/secret-detect'
import { requestStrategy, STRATEGY_LABEL } from '@shared/request-strategy'
import { useDevMode } from '../lib/dev-mode'
import '../styles-agent-experience.css'

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
  /** Dictating now (⌘D: a tap toggles, holding talks until you let go). */
  isDictating(): boolean
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
  /** Resolves false when the message didn't go through: the text comes back into the box. */
  onSend: (o: Outgoing) => void | Promise<boolean | void>
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
  /** Settings → You: ⌘↵ sends and ↵ makes a new line. */
  cmdEnter?: boolean
  /** Settings → You: check spelling while typing. */
  spellCheck?: boolean
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
  /** Model controls are optional in bot and group chats. */
  autoBot?: boolean
  onAuto: () => void
  showModelThinking?: boolean
}>(function Composer(p, ref) {
  const dev = useDevMode()
  // The "Enter adjusts · ⌘Enter waits" hint: the first time you're typing while a bot works, then never again.
  const [firstSteer] = useState(() => { try { return !localStorage.getItem('sb.steerHint') } catch { return false } })
  useEffect(() => { if (firstSteer && p.running) try { localStorage.setItem('sb.steerHint', '1') } catch { /* private */ } }, [firstSteer, p.running])
  const [dictating, setDictating] = useState(false)
  const dictatingRef = useRef(false)
  dictatingRef.current = dictating
  const [dictError, setDictError] = useState<string | null>(null)
  const mic = useRef<Mic | null>(null)
  const base = useRef('')
  const [text, setText] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [atts, setAtts] = useState<Attachment[]>([])
  const [drag, setDrag] = useState(false)
  const [draftFolder, setDraftFolder] = useState<string | null>(null)
  const [deep, setDeep] = useState(false)
  // Max: on for this message (a bot whose Max setting is Always has it on for every request).
  const [maxOn, setMaxOn] = useState(false)
  /** Text a sahilbot:// link put in the box (null: none). Cleared when the box is emptied or sent. */
  const [linkText, setLinkText] = useState<string | null>(null)
  const ta = useRef<HTMLTextAreaElement>(null)
  const [slashAt, setSlashAt] = useState(0)
  const [slashClosed, setSlashClosed] = useState<string | null>(null)
  const slash = slashClosed === text ? [] : slashMatches(text)
  const runSlash = (c: SlashCommand): void => {
    setText('')
    setSlashAt(0)
    if (c.id === 'research') { setDeep(true); toast('Deep research is on for your next message.') }
    else if (c.id === 'max') { setMaxOn(true); toast('Max is on for your next message.') }
    else if (c.id === 'plan') { setText('Plan this first, then ask me before doing it: '); requestAnimationFrame(() => ta.current?.focus()) }
    else window.dispatchEvent(new CustomEvent('sahilbot:command', { detail: c.id }))
  }
  // Unsent text survives switching chats, quitting and updating (lib/drafts.ts). The key changes with the
  // chat before the text does, so one chat's draft is never saved under another's.
  const draftKey = useRef<string | undefined>(p.threadId)
  useEffect(() => {
    draftKey.current = p.threadId
    setText(loadDraft(p.threadId))
  }, [p.threadId])
  // While a send is in flight its draft is kept (the box looks empty): it's dropped only once the send worked.
  const sending = useRef(0)
  useEffect(() => { if (!(sending.current && !text)) saveDraft(draftKey.current, text) }, [text])

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
    toggleMax() { setMaxOn((x) => !x) },
    insert(t: string) {
      setText((cur) => (cur ? `${cur}\n${t}` : t))
      // Put the caret at the end so the user can just keep typing.
      requestAnimationFrame(() => { const el = ta.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length) } })
    },
    focus() { ta.current?.focus() },
    toggleDictation() { void toggleRef.current() },
    isDictating() { return dictatingRef.current },
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
    const sentText = text, sentImages = images, sentAtts = atts, sentKey = draftKey.current
    sending.current++
    const result = p.onSend({ text: text.trim(), images, attachments: atts, ...(draftFolder && !p.threadId ? { workingFolder: draftFolder } : {}), ...modeFlags({ deep: deep || (!fromLink && requestStrategy(text).kind === 'research'), planFirst: !fromLink && requestStrategy(text).kind === 'plan', max: maxOn || (!fromLink && requestStrategy(text).kind === 'swarm') }), queue, ...(fromLink ? { fromLink } : {}) })
    setDeep(false)
    setMaxOn(false)
    setLinkText(null)
    setText('')
    setImages([])
    setAtts([])
    void Promise.resolve(result).then((ok) => {
      sending.current--
      if (ok === false) {
        // Didn't go through: put it back (unless something new was typed meanwhile).
        setText((cur) => (cur ? cur : sentText))
        setImages((cur) => (cur.length ? cur : sentImages))
        setAtts((cur) => (cur.length ? cur : sentAtts))
        saveDraft(sentKey, sentText)
      } else clearDraft(sentKey)
    }, () => { sending.current--; setText((cur) => (cur ? cur : sentText)); saveDraft(sentKey, sentText) })
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

  const strategy = deep ? 'research' : maxOn ? 'swarm' : requestStrategy(text).kind

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
        {slash.length > 0 && (
          <div className="slash-menu" role="listbox" aria-label="Commands" data-testid="slash-menu">
            {slash.map((c, i) => (
              <button key={c.id} role="option" aria-selected={i === Math.min(slashAt, slash.length - 1)} className={`slash-item${i === Math.min(slashAt, slash.length - 1) ? ' on' : ''}`}
                onMouseEnter={() => setSlashAt(i)} onMouseDown={(e) => { e.preventDefault(); runSlash(c) }} data-testid={`slash-${c.id}`}>
                <b>{c.name}</b><span>{c.hint}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={ta}
          rows={p.big ? 2 : 1}
          value={text}
          placeholder={p.answering ? 'Type your answer, or talk about something else' : p.placeholder ?? 'Message SahilBot'}
          onChange={(e) => { setText(e.target.value); setSlashAt(0) }}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && dictating) { e.preventDefault(); e.stopPropagation(); void cancelDictation(); return }
            if (slash.length) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setSlashAt((i) => (i + 1) % slash.length); return }
              if (e.key === 'ArrowUp') { e.preventDefault(); setSlashAt((i) => (i - 1 + slash.length) % slash.length); return }
              if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') { e.preventDefault(); runSlash(slash[Math.min(slashAt, slash.length - 1)]); return }
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setSlashClosed(text); return }
            }
            // ↑ in an empty box: edit your last message (like ChatGPT and Claude).
            if (e.key === 'ArrowUp' && !text && !images.length && !atts.length && !p.running) { e.preventDefault(); window.dispatchEvent(new CustomEvent('sahilbot:edit-last')); return }
            // ⌘↵ to send (Settings → You): a plain ↵ is a new line, ⌘↵ sends (steers while it works).
            if (p.cmdEnter && e.key === 'Enter' && !e.nativeEvent.isComposing) {
              if (!(e.metaKey || e.ctrlKey)) return
              e.preventDefault()
              if (dictating) { void toggleDictation().then(() => requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('[data-testid="send"]')?.click())); return }
              send(false)
              return
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              // Enter while dictating: finish dictation first, then send what was said.
              if (dictating) { void toggleDictation().then(() => requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('[data-testid="send"]')?.click())); return }
              // While SahilBot works: Enter steers it, ⌘Enter queues for when it's done.
              send(e.metaKey || e.ctrlKey)
            }
          }}
          spellCheck={p.spellCheck === true}
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
          <Popover label={<I.Plus size={19} />} className="plus-pop attachment-pop" title="Attach files, a folder or a screenshot">
            {(close) => (
              <>
                <button className="menu-item" onClick={() => { close(); void pick('files') }} data-testid="attach-files"><I.Paperclip size={17} /><span className="attachment-menu-copy"><span>Upload files or photos</span><span className="sub">Drop or paste files · up to 100 MB each</span></span></button>
                <button className="menu-item" onClick={() => { close(); void pick('folder') }} data-testid="attach-folder"><I.Folder size={17} /><span className="attachment-menu-copy"><span>Attach a folder's files</span><span className="sub">Share what's inside with this message</span></span></button>
                <button className="menu-item" onClick={() => { close(); void takeScreenshot() }} data-testid="attach-screenshot"><I.Image size={17} /><span className="attachment-menu-copy"><span>Take a screenshot</span><span className="sub">Select an area of your screen</span></span></button>
              </>
            )}
          </Popover>
          {dev && (
            <span className="agent-strategy" data-testid="agent-strategy" title="Chooses tools and brings in specialist agents when useful. You can ask it to plan first, research, or use an agent swarm.">
              <I.Sparkle size={14} /><span>{STRATEGY_LABEL[strategy]}</span><span className="agent-auto-label">Automatic</span>
            </span>
          )}
          <span className="spacer" />
          {dictating && (
            <span className="dictating" data-testid="dictating">
              <span className="dict-bars" style={{ ['--lvl' as string]: Math.min(1, (mic.current?.level ?? 0) * 6) }}><i /><i /><i /><i /></span>
              {Math.floor((Date.now() - dictSince) / 1000)}s
            </span>
          )}
          <span className="tip-wrap">
            <button className={`c-btn${dictating ? ' recording' : ''}`} aria-label={dictating ? 'Stop dictation' : 'Dictate'} aria-keyshortcuts="Meta+D" onClick={() => void toggleDictation()} data-testid="dictate"><I.Mic /></button>
            <span className="tip" role="tooltip">{dictating ? <>Click or let go of <kbd>⌘</kbd><kbd>D</kbd> to stop · Esc cancels</> : <>Dictate: speak and it types · <kbd>⌘</kbd><kbd>D</kbd></>}</span>
          </span>
          {p.running && !p.answering && !canSend ? (
            <button className="c-btn primary stop" title="Stop (Esc)" aria-label="Stop (Esc)" onClick={p.onStop} data-testid="stop"><I.Stop /></button>
          ) : canSend ? (
            <button className="c-btn primary send" title={p.running && !p.answering ? 'Send now: SahilBot adjusts what it is doing (⌘Enter sends after it finishes)' : 'Send (Enter)'} aria-label={p.running && !p.answering ? 'Send now: SahilBot adjusts what it is doing (⌘Enter sends after it finishes)' : 'Send (Enter)'} onClick={() => send(false)} data-testid="send" style={p.accent ? { background: p.accent } : undefined}><I.Up /></button>
          ) : (
            <button className="c-btn voice" title="Talk with your bot out loud (⇧⌘V)" aria-label="Talk" onClick={p.onVoice} data-testid="voice-btn"><I.Wave size={17} /></button>
          )}
        </div>
      </div>
      <div className="under">
        <WorkFolderChip threadId={p.threadId} inherited={p.inheritedFolder} draft={draftFolder} onDraft={setDraftFolder} projects={p.projects} onlyWhenSet={!dev} />
        <span className="spacer" />
        {p.mode === 'bypass' && (
          <span className="bypass-chip" role="status" data-testid="bypass-chip"
            title="Bypass is on for this chat: everything runs without asking, except purchases, passwords and one-time codes. It resets to Auto when SahilBot restarts.">
            <span className="bypass-dot" aria-hidden />Bypass on
          </span>
        )}
        {/* The model, thinking and Ask/Auto picker is Developer mode only: Auto picks the model for each request, and
            permissions are set once (Settings, or a bot's profile). Grok Bot's box has no picker either. */}
        {dev && <ComposerPicker key={p.showModelThinking === false ? 'permissions' : 'full'} models={p.models} model={p.model} onModel={p.onModel} onAuto={p.onAuto} onRefreshModels={p.onRefreshModels} onManageModels={p.onManageModels}
          thinking={p.thinking} onThinking={p.onThinking} mode={p.mode} onMode={p.onMode} allowBypass={p.allowBypass} autoBot={p.autoBot} showModelThinking={p.showModelThinking} />}
      </div>
      {p.running && !p.answering && (dev || firstSteer || p.steering) && (
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

