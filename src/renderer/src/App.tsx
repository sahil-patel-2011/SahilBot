import { useCallback, useEffect, useRef, useState } from 'react'
import type { BrowserState, ChatEvent, Message, ModelList, PendingRequest, PermissionMode, Settings, Space, SystemInfo, Thread } from '@shared/types'
import { api } from './api'
import { SpaceAvatar } from './brand'
import { BotEditor } from './components/BotEditor'
import { CommandPalette, type PaletteAction } from './components/CommandPalette'
import { Composer, type ComposerHandle, type Outgoing } from './components/Composer'
import { ConnectApps } from './components/ConnectApps'
import { FilesView, Home, ProjectsView } from './components/Home'
import { Onboarding } from './components/Onboarding'
import { RightPanel, type PanelTab } from './components/RightPanel'
import { SettingsModal } from './components/SettingsModal'
import { Sidebar, type MainView } from './components/Sidebar'
import { ThreadView } from './components/ThreadView'
import { VoiceMode } from './components/VoiceMode'
import { ProjectHome } from './components/ProjectHome'
import { Scheduled } from './components/Scheduled'
import * as I from './icons'
import { Popover } from './components/Popover'
import { toast, Toasts } from './lib/toast'
import { Speaker } from './lib/audio'

type Editor = { space: Space | null; mode: 'bot' | 'group' | 'project' } | null

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [sys, setSys] = useState<SystemInfo | null>(null)
  const [models, setModels] = useState<ModelList | null>(null)
  const [spaces, setSpaces] = useState<Space[]>([])
  const [chats, setChats] = useState<Thread[]>([])
  const [spaceId, setSpaceId] = useState<string | null>(null)
  const [thread, setThread] = useState<Thread | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [running, setRunning] = useState<Set<string>>(new Set())
  const [pending, setPending] = useState<PendingRequest[]>([])
  const [progress, setProgress] = useState<Record<string, Extract<ChatEvent, { type: 'progress' }>>>({})
  const [panel, setPanel] = useState<PanelTab | null>(null)
  const [file, setFile] = useState<string | null>(null)
  const [browser, setBrowser] = useState<BrowserState | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [view, setView] = useState<MainView>('home')
  const [settingsPage, setSettingsPage] = useState<'general' | 'models' | 'keys' | undefined>(undefined)
  const [showConnect, setShowConnect] = useState(false)
  const [editor, setEditor] = useState<Editor>(null)
  const [palette, setPalette] = useState(false)
  const [voiceOn, setVoiceOn] = useState(false)
  const [showScheduled, setShowScheduled] = useState(false)
  // Model and mode picked on the home screen before a chat exists.
  const [draft, setDraft] = useState<{ model: string | null; mode: PermissionMode }>({ model: null, mode: 'auto' })
  const [drafting, setDrafting] = useState<Record<string, string | null>>({})
  const [runSince, setRunSince] = useState<Record<string, number>>({})
  // Messages typed while SahilBot is working wait here and go out when the run ends.
  const [queue, setQueue] = useState<Record<string, Outgoing[]>>({})
  const [renamingTitle, setRenamingTitle] = useState(false)
  const [teams, setTeams] = useState<Record<string, import('@shared/types').TeamMember[]>>({})
  const [teamOn, setTeamOn] = useState(false)
  const [steering, setSteering] = useState<Record<string, number>>({})
  const [mini, setMini] = useState<{ on: boolean; threadId?: string }>({ on: false })
  const [teamCap, setTeamCap] = useState<{ maxAgents: number; heavy: boolean; why: string } | null>(null)
  const composer = useRef<ComposerHandle>(null)

  const newChatRef = useRef<() => void>(() => undefined)
  const openAnyChatRef = useRef<(id: string) => void>(() => undefined)
  const threadRef = useRef<string | null>(null)
  threadRef.current = thread?.id ?? null
  // Read-aloud plays here (voice mode has its own player).
  const speaker = useRef<Speaker | null>(null)
  const live = useRef({ speak: false, voiceOn: false })
  live.current = { speak: !!settings?.speakReplies, voiceOn }

  const main = spaces.find((s) => s.isMain)
  const space = spaces.find((s) => s.id === spaceId) ?? main

  const refreshSpaces = useCallback(async () => {
    const sp = await api.spaces.list()
    setSpaces(sp)
    const m = sp.find((s) => s.isMain)
    if (m) setChats(await api.threads.list(m.id))
    return sp
  }, [])
  const refreshModels = useCallback(async () => {
    setModels(null)
    setModels(await api.models.list())
  }, [])

  useEffect(() => {
    void (async () => {
      const [s, info] = await Promise.all([api.settings.get(), api.system.info()])
      setSettings(s)
      setSys(info)
      const sp = await refreshSpaces()
      setSpaceId(sp.find((x) => x.isMain)?.id ?? null)
      void refreshModels()
      setBrowser(await api.browser.state())
    })()
    return api.browser.onState(setBrowser)
  }, [refreshSpaces, refreshModels])

  // Load a thread's messages; merge with live events that may arrive before the fetch returns.
  useEffect(() => {
    setPending([])
    if (!thread) return setMessages([])
    const id = thread.id
    void api.chat.pending(id).then(setPending)
    void api.threads.messages(id).then((fetched) => setMessages((cur) => {
      const ids = new Set(fetched.map((m) => m.id))
      const live = cur.filter((m) => m.threadId === id && !ids.has(m.id))
      const merged = fetched.map((m) => cur.find((c) => c.id === m.id && c.content.length > m.content.length) ?? m)
      return [...merged, ...live].sort((a, b) => a.createdAt - b.createdAt)
    }))
    if (thread.unread) void api.threads.update(id, { unread: false }).then(() => refreshSpaces())
  }, [thread?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => api.chat.onEvent((e: ChatEvent) => {
    if (e.type === 'spaces') { void refreshSpaces(); return }
    if (e.type === 'drafting') { setDrafting((d) => ({ ...d, [e.threadId]: e.tool })); return }
    if (e.type === 'run') {
      if (e.status === 'started') setRunSince((r) => ({ ...r, [e.threadId]: Date.now() }))
      else {
        setDrafting((d) => ({ ...d, [e.threadId]: null }))
        if (e.status === 'error' && e.error) toast(e.error, 'error')
      }
      setRunning((r) => {
        const n = new Set(r)
        if (e.status === 'started') n.add(e.threadId)
        else n.delete(e.threadId)
        return n
      })
      if (e.status !== 'started') void refreshSpaces()
      // Deep Research: open the finished report.
      if (e.status === 'finished' && e.threadId === threadRef.current) {
        void api.threads.messages(e.threadId).then((ms) => {
          const lastUser = [...ms].reverse().find((m) => m.role === 'user' && !m.meta?.hidden)
          if (!lastUser?.meta?.deepResearch) return
          const doc = [...ms].reverse().find((m) => m.role === 'tool' && m.toolName === 'create_document' && m.meta?.path && m.createdAt > lastUser.createdAt)
          if (doc) window.dispatchEvent(new CustomEvent('sahilbot:open-file', { detail: doc.meta!.path as string }))
        })
      }
      // Read the finished reply aloud when that's switched on.
      if (e.status === 'finished' && live.current.speak && !live.current.voiceOn && e.threadId === threadRef.current) {
        void api.threads.messages(e.threadId).then((ms) => {
          const last = [...ms].reverse().find((m) => m.role === 'assistant' && m.kind === 'normal' && m.content && !m.meta?.superseded)
          if (last) void api.voice.speak(last.content)
        })
      }
      return
    }
    if (e.type === 'progress') {
      setProgress((p) => ({ ...p, [e.threadId]: e }))
      return
    }
    if (e.type === 'steer') {
      setSteering((s) => ({ ...s, [e.threadId]: e.pending }))
      return
    }
    if (e.type === 'team') {
      setTeams((t) => ({ ...t, [e.callId]: e.members }))
      return
    }
    if (e.type === 'thread') {
      if (e.thread.id === threadRef.current) {
        setThread({ ...e.thread, unread: false })
        if (e.thread.unread) void api.threads.update(e.thread.id, { unread: false })
      }
      void refreshSpaces()
      return
    }
    if (e.threadId !== threadRef.current) return
    if (e.type === 'pending') setPending((ps) => [...ps.filter((p) => p.id !== e.request.id), e.request])
    else if (e.type === 'resolved') setPending((ps) => ps.filter((p) => p.id !== e.id))
    else if (e.type === 'message') {
      setMessages((ms) => {
        const i = ms.findIndex((m) => m.id === e.message.id)
        if (i < 0) return [...ms, e.message]
        const next = ms.slice()
        next[i] = e.message
        return next
      })
    } else if (e.type === 'delta') {
      setMessages((ms) => ms.map((m) => m.id !== e.messageId ? m : {
        ...m,
        content: m.content + (e.content ?? ''),
        reasoning: e.reasoning ? (m.reasoning ?? '') + e.reasoning : m.reasoning
      }))
    }
  }), [refreshSpaces])

  // Menu bar commands.
  useEffect(() => api.onMenu((a) => {
    if (a === 'new-chat') { setSpaceId(null); setThread(null) }
    else if (a === 'new-bot') setEditor({ space: null, mode: 'bot' })
    else if (a === 'new-project') setEditor({ space: null, mode: 'project' })
    else if (a === 'settings') setShowSettings(true)
    else if (a === 'scheduled') setShowScheduled(true)
    else if (a === 'connect') setShowConnect(true)
    else if (a === 'toggle-panel') setPanel((p) => (p ? null : 'progress'))
    else if (a === 'search') setPalette(true)
    else if (a === 'export' && threadRef.current) void api.chat.exportThread(threadRef.current).then((p) => p && toast(`Saved to ${p.split('/').pop()}`, 'ok'))
  }), [])

  useEffect(() => api.onMini(setMini), [])
  // "Open in SahilBot" from Quick Ask.
  useEffect(() => api.onOpenThread((id) => { void refreshSpaces().then(() => openAnyChatRef.current(id)) }), [refreshSpaces])

  useEffect(() => api.voice.onEvent((e) => {
    if (live.current.voiceOn) return
    if (e.type === 'audio') { speaker.current ??= new Speaker(); speaker.current.play(e.audio, e.rate) }
    else if (e.type === 'stop-audio') speaker.current?.stop()
  }), [])

  // Appearance: width, font size, tint, density and wrapping as CSS variables and classes.
  useEffect(() => {
    const a = settings?.appearance
    if (!a) return
    const r = document.documentElement
    r.style.setProperty('--chat-width', `${a.chatWidth}px`)
    r.style.setProperty('--ui-font', `${a.fontSize}px`)
    r.style.setProperty('--tint', a.tint ? `hsl(${a.hue} 70% 50% / ${(a.tint / 100) * 0.14})` : 'transparent')
    r.style.setProperty('--tint-strong', `hsl(${a.hue} 75% 52%)`)
    r.classList.toggle('code-wrap', a.codeWrap)
    r.classList.toggle('solid', a.reduceTransparency)
    r.classList.toggle('detailed', a.density === 'detailed')
    r.classList.toggle('tinted', a.tint > 0)
  }, [settings?.appearance])

  useEffect(() => {
    const open = (e: Event): void => { setFile((e as CustomEvent<string>).detail); setPanel('file') }
    window.addEventListener('sahilbot:open-file', open)
    return () => window.removeEventListener('sahilbot:open-file', open)
  }, [])

  // The browser comes forward only when you're needed (e.g. a human check to complete).
  useEffect(() => api.browser.onOpenRequest(() => setPanel('browser')), [])

  // The browser works in the background; "Watch" (or the globe) shows it.
  useEffect(() => {
    const watch = (): void => setPanel('browser')
    window.addEventListener('foreman:watch-browser', watch)
    return () => window.removeEventListener('foreman:watch-browser', watch)
  }, [])

  // Links in answers open in SahilBot's browser panel.
  useEffect(() => {
    const open = (e: Event): void => {
      setPanel('browser')
      void api.browser.navigate((e as CustomEvent<string>).detail)
    }
    window.addEventListener('foreman:open-link', open)
    return () => window.removeEventListener('foreman:open-link', open)
  }, [])

  useEffect(() => {
    const k = (e: KeyboardEvent): void => {
      if (e.metaKey && e.key === 'n') { e.preventDefault(); newChatRef.current() }
      if (e.metaKey && e.key === 'k') { e.preventDefault(); setPalette(true) }
      if (e.metaKey && e.key === ',') { e.preventDefault(); setShowSettings(true) }
      if (e.metaKey && e.key === '\\') { e.preventDefault(); setPanel((p) => (p ? null : 'progress')) }
      if (e.metaKey && e.shiftKey && e.key.toLowerCase() === 'd') { e.preventDefault(); composer.current?.toggleDictation() }
      if (e.metaKey && e.shiftKey && e.key.toLowerCase() === 'v') { e.preventDefault(); setVoiceOn(true) }
      // Esc stops speaking, and the current run (when no dialog is open).
      if (e.key === 'Escape') void api.voice.stopSpeaking()
      if (e.key === 'Escape' && !document.querySelector('.scrim, .palette-wrap, .voice-mode') && threadRef.current) void api.chat.stop(threadRef.current)
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [])

  const openMain = (): void => { setSpaceId(main?.id ?? null); setThread(null); setView('home') }
  newChatRef.current = openMain
  const openChat = async (id: string): Promise<void> => {
    const t = chats.find((x) => x.id === id) ?? (await api.threads.list(main?.id)).find((x) => x.id === id)
    if (!t) return
    setSpaceId(t.spaceId)
    setThread(t)
    setView('home')
  }
  /** A bot has one ongoing conversation (created on first open). */
  const openBot = async (id: string): Promise<void> => {
    setView('home')
    const sp = await api.spaces.list()
    const s = sp.find((x) => x.id === id)
    if (s?.isMain) return openMain()
    if (s?.hidden) await api.spaces.update(id, { hidden: false })
    // Projects open on their home (folder, instructions, chats).
    if (s?.kind === 'project') {
      setSpaceId(id)
      setThread(null)
      void refreshSpaces()
      return
    }
    let ts = await api.threads.list(id)
    if (!ts.length) {
      const t = await api.threads.create(id)
      ts = [await api.threads.update(t.id, { title: s?.name ?? 'Chat' })]
    }
    setSpaceId(id)
    setThread(ts[0])
    void refreshSpaces()
  }

  const onPalette = (a: PaletteAction): void => {
    setPalette(false)
    if (a.kind === 'new-chat') openMain()
    else if (a.kind === 'new-bot') setEditor({ space: null, mode: 'bot' })
    else if (a.kind === 'new-group') setEditor({ space: null, mode: 'group' })
    else if (a.kind === 'new-project') setEditor({ space: null, mode: 'project' })
    else if (a.kind === 'scheduled') setShowScheduled(true)
    else void openBot(a.id)
  }

  // Send the next queued message as soon as the thread is free.
  useEffect(() => {
    for (const [tid, items] of Object.entries(queue)) {
      if (!items.length || running.has(tid)) continue
      const [first, ...rest] = items
      setQueue((q) => ({ ...q, [tid]: rest }))
      void api.chat.send({ threadId: tid, text: first.text, images: first.images, attachments: first.attachments, team: first.team, deepResearch: first.deepResearch }).catch((e: Error) => toast(e.message, 'error'))
    }
  }, [queue, running])

  // How many helper agents this Mac can run with the model in use.
  const capModel = thread?.model ?? draft.model ?? settings?.defaultModel ?? 'auto'
  useEffect(() => { void api.models.teamCapacity(capModel).then(setTeamCap) }, [capModel, models])

  // All hooks above this line: the early return below must not change the hook count.
  if (!settings) return null

  const model = thread?.model ?? space?.model ?? draft.model ?? settings.defaultModel
  const mode = thread?.permissionMode ?? draft.mode
  const isRunning = !!thread && running.has(thread.id)
  const question = pending.find((p) => p.kind === 'question')
  const isBot = !!space && !space.isMain && space.kind !== 'project'
  const isProject = space?.kind === 'project'

  const patchThread = async (patch: Parameters<typeof api.threads.update>[1]): Promise<void> => {
    if (!thread) return
    setThread(await api.threads.update(thread.id, patch))
  }

  const send = async (o: Outgoing): Promise<void> => {
    // A bot asked a question: what you type is the answer.
    if (question && thread) {
      await api.chat.respond(thread.id, question.id, o.text)
      return
    }
    if (thread && running.has(thread.id)) {
      // ⌘Enter (or attachments): wait until it's done. Enter: steer the agent now.
      if (o.queue || o.attachments.length || o.images.length) setQueue((q) => ({ ...q, [thread.id]: [...(q[thread.id] ?? []), o] }))
      else await api.chat.steer(thread.id, o.text).catch((e: Error) => toast(e.message, 'error'))
      return
    }
    let t = thread
    if (!t) {
      const sid = space?.id ?? main?.id
      if (!sid) return
      const created = await api.threads.create(sid)
      t = await api.threads.update(created.id, { model: draft.model, permissionMode: draft.mode })
      threadRef.current = t.id
      setMessages([])
      setThread(t)
    }
    try {
      await api.chat.send({ threadId: t.id, text: o.text, images: o.images, attachments: o.attachments, team: o.team, deepResearch: o.deepResearch })
      void refreshSpaces()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }


  const openFile = (p: string): void => { setFile(p); setPanel('file') }
  /** Any chat, in any bot or project (e.g. the one a file came from). */
  const openAnyChat = async (id: string): Promise<void> => {
    for (const sp of spaces) {
      const t = (await api.threads.list(sp.id)).find((x) => x.id === id)
      if (t) { setSpaceId(sp.id); setThread(t); setView('home'); return }
    }
  }
  openAnyChatRef.current = (id) => void openAnyChat(id)

  const composerEl = (
    <Composer
      ref={composer}
      running={isRunning}
      answering={!!question}
      onSend={(o) => void send(o)}
      onStop={() => thread && void api.chat.stop(thread.id)}
      models={models}
      model={model}
      onModel={(id) => (thread ? void patchThread({ model: id }) : setDraft((d) => ({ ...d, model: id })))}
      onRefreshModels={() => void refreshModels()}
      onManageModels={() => { setSettingsPage('models'); setShowSettings(true) }}
      team={teamCap ? { on: teamOn, ...teamCap } : null}
      onTeam={setTeamOn}
      thinking={settings.thinking}
      onThinking={(e) => void api.settings.set({ thinking: e }).then(setSettings)}
      mode={mode}
      onMode={(m) => (thread ? void patchThread({ permissionMode: m }) : setDraft((d) => ({ ...d, mode: m })))}
      accent={isBot ? space?.color : undefined}
      onVoice={() => setVoiceOn(true)}
      placeholder={isBot ? `Message ${space?.name}` : isProject && !thread ? `Start a chat in ${space?.name}` : thread ? 'Reply to SahilBot' : 'How can I help you today?'}
      big={!thread}
      steering={thread ? steering[thread.id] : 0}
      context={!thread && !isBot ? (
        <Popover label={<><I.Folder size={14} />{isProject ? space?.name : 'Project or folder'} <I.Chevron size={13} /></>} className="under-pick" title="Work in a project or a folder" testId="context-picker">
          {(close) => (
            <>
              <div className="menu-head">Work in</div>
              <button className="menu-item" onClick={() => { close(); openMain() }}><span className="check">{!isProject && <I.Check size={14} />}</span>No project</button>
              {spaces.filter((x) => x.kind === 'project' && !x.hidden).map((x) => (
                <button key={x.id} className="menu-item" onClick={() => { close(); void openBot(x.id) }}><span className="check">{x.id === space?.id && <I.Check size={14} />}</span>{x.name}</button>
              ))}
              <div className="menu-sep" />
              <button className="menu-item" onClick={() => { close(); void api.files.pick('folder').then((xs) => composer.current?.attach(xs)) }}><I.Folder size={15} />Attach a folder…</button>
              <button className="menu-item" onClick={() => { close(); setEditor({ space: null, mode: 'project' }) }}><I.Plus size={15} />New project…</button>
            </>
          )}
        </Popover>
      ) : undefined}
    />
  )

  const prog = thread ? progress[thread.id] : undefined
  const plan = (() => {
    const call = [...messages].reverse().flatMap((m) => [...(m.toolCalls ?? [])].reverse()).find((c) => c.name === 'todo')
    try { return call ? (JSON.parse(call.arguments).items as Array<{ status: string }>) : [] } catch { return [] }
  })()
  // Computer use: a small always-on-top window that shows what SahilBot is doing, with Stop.
  if (mini.on) {
    const last = [...messages].reverse().find((m) => m.role === 'tool' || (m.role === 'assistant' && m.content))
    const doing = last?.role === 'tool' ? String(last.meta?.display ?? last.toolName ?? 'Working') : last?.content.replace(/\s+/g, ' ').slice(0, 120) ?? 'Starting…'
    return (
      <div className="mini drag" data-testid="mini">
        <div className="mini-head"><span className="spin" /><b>SahilBot is using your Mac</b></div>
        <div className="mini-doing">{doing}</div>
        <div className="mini-actions nodrag">
          <button className="btn danger" onClick={() => { if (mini.threadId) void api.chat.stop(mini.threadId); void api.exitMini() }} data-testid="mini-stop">Stop</button>
          <button className="btn" onClick={() => void api.exitMini()}>Show SahilBot</button>
        </div>
        <div className="mini-hint">Ctrl ⌥ Esc stops from anywhere</div>
      </div>
    )
  }

  const memberColors = space?.kind === 'group' ? space.members.map((id) => spaces.find((s) => s.id === id)?.color ?? '#999') : undefined
  const modal = showSettings || !!editor || palette || showConnect || showScheduled || !settings.onboarded

  return (
    <div className="app">
      <Toasts />
      <Sidebar
        spaces={spaces}
        chats={chats}
        activeSpaceId={space?.id ?? null}
        activeThreadId={thread?.id ?? null}
        userName={settings.userName}
        onOpenMain={openMain}
        onOpenBot={(id) => void openBot(id)}
        onOpenChat={(id) => void openChat(id)}
        onNew={openMain}
        onNewBot={() => setEditor({ space: null, mode: 'bot' })}
        onSearch={() => setPalette(true)}
        view={view}
        onView={(v) => { setView(v); setThread(null) }}
        modelLabel={`${settings.defaultModel === 'auto' ? 'Auto' : models?.models.find((m) => m.id === settings.defaultModel)?.label ?? settings.defaultModel} · ${({ low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra', max: 'Max' } as Record<string, string>)[settings.thinking]}`}
        onCustomize={(s) => setEditor({ space: s, mode: s.kind })}
        onChanged={() => void refreshSpaces().then((sp) => {
          if (thread && !sp.some((s) => s.id === thread.spaceId)) openMain()
          else if (thread) void api.threads.list(thread.spaceId).then((ts) => { if (!ts.some((t) => t.id === thread.id)) openMain() })
        })}
        onSettings={() => setShowSettings(true)}
        onConnect={() => setShowConnect(true)}
        onScheduled={() => setShowScheduled(true)}
        onNewProject={() => setEditor({ space: null, mode: 'project' })}
        pinned={settings.pinnedBots}
        onPinned={(ids) => void api.settings.set({ pinnedBots: ids }).then(setSettings)}
      />
      <main className="main">
        <header className="main-header drag">
          <div className="header-title">
            {isProject && space && <button className="hint" style={{ fontWeight: 600 }} onClick={() => setThread(null)}>{space.name}{thread ? ' /' : ''}</button>}
            {thread && !isBot && (renamingTitle ? (
              <input className="title-edit" autoFocus defaultValue={thread.title}
                onBlur={(e) => { setRenamingTitle(false); const v = e.target.value.trim(); if (v && v !== thread.title) void patchThread({ title: v }).then(() => refreshSpaces()) }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenamingTitle(false) }} />
            ) : (
              <span data-testid="thread-title" onDoubleClick={() => setRenamingTitle(true)} title="Double-click to rename">{thread.title}</span>
            ))}
            {thread && (
              <Popover label={<I.Chevron size={14} />} className="title-menu" menuClass="down" title="Chat options">
                {(close) => (
                  <>
                    <button className="menu-item" onClick={() => { close(); setRenamingTitle(true) }}><I.Edit size={15} />Rename</button>
                    <button className="menu-item" onClick={() => { close(); void patchThread({ pinned: !thread.pinned }).then(() => refreshSpaces()) }}><I.Pin size={15} />{thread.pinned ? 'Unpin' : 'Pin'}</button>
                    <button className="menu-item" onClick={() => { close(); void api.chat.exportThread(thread.id).then((p) => p && toast(`Saved to ${p.split('/').pop()}`, 'ok')) }}><I.Share size={15} />Export as Markdown</button>
                    <div className="menu-sep" />
                    <button className="menu-item danger" onClick={() => { close(); if (confirm(`Delete "${thread.title}"?`)) void api.threads.remove(thread.id).then(() => { openMain(); void refreshSpaces() }) }}><I.Trash size={15} />Delete chat</button>
                  </>
                )}
              </Popover>
            )}
          </div>
          {isBot && space && (
            <button className="bot-pill" onClick={() => setEditor({ space, mode: space.kind })} data-testid="bot-pill" title="Customize">
              <SpaceAvatar color={space.color} shape={space.shape} size={26} group={memberColors} />
              <span>{space.name}</span>
            </button>
          )}
          <div className="header-actions">
            {((isRunning && (prog?.plan || (prog?.actions ?? 0) > 0)) || plan.length > 0) && (
              <button className={`progress-chip${panel === 'progress' ? ' on' : ''}`} onClick={() => setPanel((p) => (p === 'progress' ? null : 'progress'))} data-testid="progress-chip">
                {isRunning && <span className="spin" />}
                <I.ListIcon size={15} />
                {/* Steps come from the agent's own plan; without one, just how much it has done. */}
                {isRunning && prog?.plan ? `Step ${prog.plan.at} of ${prog.plan.of}` : isRunning && prog ? `${prog.actions} action${prog.actions === 1 ? '' : 's'}` : `${plan.filter((t) => t.status === 'done').length} of ${plan.length} done`}
              </button>
            )}
            {prog && (
              <span className="working" title={`Context: ${prog.used.toLocaleString()} of ${prog.window.toLocaleString()} tokens. Older turns are summarized only when it's nearly full.`}>
                <span className={`meter${prog.used / prog.window > 0.6 ? ' hot' : ''}`}><i style={{ width: `${Math.min(100, (prog.used / prog.window) * 100)}%` }} /></span>
              </span>
            )}
            <button className={`icon-btn globe${panel === 'browser' ? ' on' : ''}`} title="Browser" onClick={() => setPanel((p) => (p === 'browser' ? null : 'browser'))} data-testid="toggle-browser">
              <I.Globe size={17} />
              {!!browser?.tabs.length && <span className={`globe-dot${browser.controlling ? ' live' : ''}`} />}
            </button>
            <button className={`icon-btn${panel ? ' on' : ''}`} title="Side panel (⌘\)" onClick={() => setPanel((p) => (p ? null : 'progress'))} data-testid="toggle-panel"><I.Panel size={17} /></button>
            <button className="icon-btn" title="Settings (⌘,)" onClick={() => setShowSettings(true)}><I.Gear size={17} /></button>
          </div>
        </header>
        {models && !models.ok && (
          <div className="banner">
            No model is available yet. Start Ollama or LM Studio, or add an API key, then
            <button onClick={() => void refreshModels()}>retry</button>or<button onClick={() => { setSettingsPage('keys'); setShowSettings(true) }}>open Settings</button>.
          </div>
        )}

        {view === 'files' && !thread ? (
          <FilesView onOpenFile={openFile} onOpenChat={(id) => void openAnyChat(id)} />
        ) : view === 'projects' && !thread ? (
          <ProjectsView spaces={spaces} onOpen={(id) => void openBot(id)} onNew={() => setEditor({ space: null, mode: 'project' })} />
        ) : thread ? (
          <>
            <ThreadView messages={messages} running={isRunning} pending={pending} teams={teams}
              drafting={drafting[thread.id] ?? null} since={runSince[thread.id]}
              actions={{
                onRetry: () => void api.chat.retry(thread.id).catch((e: Error) => toast(e.message, 'error')),
                onEditLast: (text) => void api.chat.editLast(thread.id, text).catch((e: Error) => toast(e.message, 'error')),
                onRespond: (id, answer) => void api.chat.respond(thread.id, id, answer),
                onReact: (id, emoji) => void api.threads.react(id, emoji),
                onReply: (text) => composer.current?.insert(`> ${text.replace(/\s+/g, ' ').slice(0, 220)}\n`),
                onOpenFile: openFile
              }} />
            <div className="composer-wrap">
              {(queue[thread.id] ?? []).length > 0 && (
                <div className="queued" data-testid="queued">
                  {(queue[thread.id] ?? []).map((q, i) => (
                    <span key={i} className="queued-item"><I.Clock size={12} />{q.text.slice(0, 60) || 'Attachment'}<button onClick={() => setQueue((x) => ({ ...x, [thread.id]: x[thread.id].filter((_, j) => j !== i) }))}>×</button></span>
                  ))}
                  <span className="hint">Sends when SahilBot finishes</span>
                </div>
              )}
              {composerEl}
            </div>
          </>
        ) : isProject && space ? (
          <ProjectHome project={space} onOpen={(t) => setThread(t)} onEdit={() => setEditor({ space, mode: 'project' })} composer={composerEl} />
        ) : (
          <Home userName={settings.userName} onOpenFile={openFile} onViewFiles={() => setView('files')} composer={composerEl} refreshKey={running.size}
            onIdea={(text, deep) => { composer.current?.replace(text); composer.current?.setDeep(!!deep) }} />
        )}
      </main>
      {panel && (
        <RightPanel tab={panel} onTab={setPanel} hidden={modal} messages={messages} file={file}
          onOpenFile={openFile} browserState={browser} onClose={() => setPanel(null)} />
      )}
      {!settings.onboarded && <Onboarding settings={settings} onDone={(s) => { setSettings(s); void refreshModels() }} />}
      {voiceOn && (
        <VoiceMode threadId={thread?.id ?? null} space={space} onClose={() => setVoiceOn(false)}
          onThread={(id) => { if (thread?.id !== id) void api.threads.list(space?.id).then((ts) => { const t = ts.find((x) => x.id === id); if (t) setThread(t) }) }} />
      )}
      {palette && <CommandPalette spaces={spaces} onPick={onPalette} onClose={() => setPalette(false)} />}
      {showSettings && (
        <SettingsModal settings={settings} models={models} sys={sys} spaces={spaces} initialPage={settingsPage}
          onClose={() => { setShowSettings(false); setSettingsPage(undefined) }}
          onSaved={setSettings} onRefreshModels={() => void refreshModels()} />
      )}
      {showConnect && <ConnectApps onClose={() => setShowConnect(false)} onBrowse={(url) => { setPanel('browser'); void api.browser.navigate(url) }} />}
      {showScheduled && (
        <Scheduled spaces={spaces.filter((x) => x.kind !== 'group')} onClose={() => setShowScheduled(false)}
          onOpen={(t) => { setShowScheduled(false); void api.threads.list(t.spaceId).then((ts) => { const th = ts.find((x) => x.id === t.threadId); if (th) { setSpaceId(t.spaceId); setThread(th) } }) }} />
      )}
      {editor && (
        <BotEditor space={editor.space} spaces={spaces} models={models} mode={editor.mode} onClose={() => setEditor(null)}
          onSaved={(id) => void refreshSpaces().then(() => openBot(id))} />
      )}
    </div>
  )
}
