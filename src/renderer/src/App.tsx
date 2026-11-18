import { lazy, useCallback, useEffect, useRef, useState } from 'react'
import { autoLabel, isAutoModel } from '@shared/model-picker'
import type { BrowserState, ChatEvent, EffortChoice, Message, ModelList, PendingRequest, PermissionMode, Settings, Space, SystemInfo, Thread } from '@shared/types'
import { api } from './api'
import { readableOn, SpaceAvatar } from './brand'
import { CommandPalette, type PaletteAction } from './components/CommandPalette'
import { Composer, type ComposerHandle, type Outgoing } from './components/Composer'
import { FilesView, Home, ProjectsView } from './components/Home'
import { TasksView } from './components/TasksView'
import { BrainView } from './components/BrainView'
import { RightPanel, type PanelTab } from './components/RightPanel'
import { JobsChip, RunSummary } from './components/JobsPanel'
import { Sidebar, type MainView } from './components/Sidebar'
import { ThreadView } from './components/ThreadView'
import { ProjectHome } from './components/ProjectHome'
import * as I from './icons'
import { Popover } from './components/Popover'
import { ConfirmDialog } from './components/ui'
import { toast, Toasts } from './lib/toast'
import { VaultAuthDialog } from './components/VaultAuthDialog'
import { Speaker } from './lib/audio'
import { useAttention } from './lib/attention'
import { DevMode } from './lib/dev-mode'
import { dividerKind, newestAt, newestReplyAt } from '@shared/read-state'
// Split chunks (src/renderer/src/lazy.tsx): loaded on idle after the first paint, opened from there.
import { BotDetails, BotEditor, ConnectApps, Lazy, Onboarding, preloadSurfaces, Scheduled, SettingsModal, VoiceMode } from './lazy'

type Editor = { space: Space | null; mode: 'bot' | 'group' | 'project' } | null

// The knowledge vault view and the "Import memory" dialog (their own chunks; opened by events, see below).
const VaultView = lazy(async () => ({ default: (await import('./components/VaultView')).VaultView }))
const ImportMemoryDialog = lazy(async () => ({ default: (await import('./components/ImportMemoryDialog')).ImportMemoryDialog }))

/** Models a council can sit with (the Council chip shows with two or more). */
function councilChoices(models: ModelList | null): Array<{ id: string; label: string }> | null {
  // Cloud models first (Auto picks among those); a user may also seat local models by name.
  const all = (models?.models ?? []).filter((m) => m.enabled !== false && m.installed !== false && m.tools !== false)
  const cloud = (m: (typeof all)[number]): boolean => m.note === 'remote' || m.note === 'added by you' || ['anthropic', 'openai', 'openrouter', 'xai'].includes(m.provider as string)
  const ok = [...all.filter(cloud), ...all.filter((m) => !cloud(m))]
  return ok.length >= 2 ? ok.map((m) => ({ id: m.id, label: m.label || m.id })) : null
}

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [sys, setSys] = useState<SystemInfo | null>(null)
  const [models, setModels] = useState<ModelList | null>(null)
  const [spaces, setSpaces] = useState<Space[]>([])
  const [chats, setChats] = useState<Thread[]>([])
  const [spaceId, setSpaceId] = useState<string | null>(null)
  const [thread, setThread] = useState<Thread | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  /** The open chat once its messages are fetched, with your read mark from when you opened it (the NEW divider). */
  const [opened, setOpened] = useState<{ id: string; readAt: number } | null>(null)
  const [running, setRunning] = useState<Set<string>>(new Set())
  const [pending, setPending] = useState<PendingRequest[]>([])
  const [progress, setProgress] = useState<Record<string, Extract<ChatEvent, { type: 'progress' }>>>({})
  /** The right side: a RightPanel tab, or the bot details panel (opened from the header pill). */
  const [panel, setPanel] = useState<PanelTab | 'details' | null>(null)
  /** Open questions/approvals/plans per chat, for the sidebar's "needs you" dot. */
  const [needs, setNeeds] = useState<Record<string, string[]>>({})
  // A reopened window picks up chats that were already waiting on you.
  useEffect(() => void api.chat.allPending().then((all) => setNeeds((x) => ({ ...all, ...x }))), [])
  /** Which bot/project each waiting chat belongs to, for chats the sidebar doesn't otherwise know (e.g. a bot's chat after a reopen). */
  const [needSpaceOf, setNeedSpaceOf] = useState<Record<string, string>>({})
  const [file, setFile] = useState<string | null>(null)
  /** Docs: the live document open in the Document tab (null = the chat's latest). */
  const [docId, setDocId] = useState<string | null>(null)
  const [browser, setBrowser] = useState<BrowserState | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [view, setView] = useState<MainView>('home')
  // A page id (new or legacy: see lib/settings-index.ts LEGACY_PAGES), optionally 'page:tab'.
  const [settingsPage, setSettingsPage] = useState<string | undefined>(undefined)
  // The compact usage card's "Details" opens Settings → Usage.
  useEffect(() => {
    const open = (e: Event): void => { setSettingsPage(((e as CustomEvent).detail as string | undefined) ?? undefined); setShowSettings(true) }
    // Settings → Connected apps → "Connect apps".
    const connect = (): void => { setShowSettings(false); setShowConnect(true) }
    window.addEventListener('sahilbot:open-settings', open)
    window.addEventListener('sahilbot:open-connect', connect)
    return () => { window.removeEventListener('sahilbot:open-settings', open); window.removeEventListener('sahilbot:open-connect', connect) }
  }, [])
  const [showConnect, setShowConnect] = useState(false)
  const [editor, setEditor] = useState<Editor>(null)
  const [palette, setPalette] = useState(false)
  /** Bypass picked for the first time: what to do once the user confirms (null: no dialog). */
  const [bypassAsk, setBypassAsk] = useState<(() => void) | null>(null)
  // The Vault view (in the main area) and the memory import dialog: opened from the palette, Settings
  // or a bot's details through window events, so those surfaces don't need props from here.
  const [vaultOpen, setVaultOpen] = useState<{ path: string | null; tab?: 'people' } | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  useEffect(() => {
    const openVault = (e: Event): void => { const d = (e as CustomEvent).detail as { path?: string | null; tab?: 'people' } | undefined; setVaultOpen({ path: d?.path ?? null, tab: d?.tab }); setShowSettings(false) }
    const openImport = (): void => setImportOpen(true)
    window.addEventListener('sahilbot:open-vault', openVault)
    window.addEventListener('sahilbot:import-memory', openImport)
    return () => { window.removeEventListener('sahilbot:open-vault', openVault); window.removeEventListener('sahilbot:import-memory', openImport) }
  }, [])
  // Opening a chat, a bot or another view leaves the vault.
  useEffect(() => { setVaultOpen(null) }, [thread?.id, spaceId, view])
  const [voiceOn, setVoiceOn] = useState(false)
  const [showScheduled, setShowScheduled] = useState(false)
  // Model and mode picked on the home screen before a chat exists.
  // mode null: the bot's own autonomy level (BotDetails), else the app default (Settings → Advanced).
  const [draft, setDraft] = useState<{ model: string | null; mode: PermissionMode | null; effort?: EffortChoice | null }>({ model: null, mode: null })
  const [drafting, setDrafting] = useState<Record<string, string | null>>({})
  // Settings changed outside the Settings window (a bot's autonomy level in its details panel).
  useEffect(() => {
    const fn = (): void => void api.settings.get().then(setSettings)
    window.addEventListener('sahilbot:settings-changed', fn)
    return () => window.removeEventListener('sahilbot:settings-changed', fn)
  }, [])
  const [toolProgress, setToolProgress] = useState<Record<string, string | null>>({})
  const [runSince, setRunSince] = useState<Record<string, number>>({})
  // Bots with an open question or approval waiting in Needs you (the bot kept working): their sidebar row shows
  // the accent "needs you" dot like a card open in a running chat does.
  const [queuedBots, setQueuedBots] = useState<Set<string>>(new Set())
  useEffect(() => {
    let alive = true
    const load = (): void => {
      void api.needsYou.list().then((items) => { if (alive) setQueuedBots(new Set(items.filter((i) => i.status === 'open' && i.source === 'queue').map((i) => i.botId))) }).catch(() => undefined)
    }
    load()
    const off = api.needsYou.onChange(load)
    return () => { alive = false; off() }
  }, [])
  // Messages typed while SahilBot is working wait here and go out when the run ends.
  const [queue, setQueue] = useState<Record<string, Outgoing[]>>({})
  const [renamingTitle, setRenamingTitle] = useState(false)
  const [teams, setTeams] = useState<Record<string, import('@shared/types').TeamMember[]>>({})
  const [teamOn, setTeamOn] = useState(false)
  const [steering, setSteering] = useState<Record<string, number>>({})
  /** Which bot/project each running chat belongs to (for the sidebar's working dots). */
  const [runSpaces, setRunSpaces] = useState<Record<string, string>>({})
  const [mini, setMini] = useState<{ on: boolean; threadId?: string }>({ on: false })
  const [teamCap, setTeamCap] = useState<{ maxAgents: number; heavy: boolean; why: string } | null>(null)
  const composer = useRef<ComposerHandle>(null)
  // Resolve the bot/project of every chat that needs you but isn't one we already know about.
  const needKey = Object.keys(needs).sort().join(',')
  useEffect(() => {
    const unknown = Object.keys(needs).filter((t) => !needSpaceOf[t] && !runSpaces[t] && !chats.some((c) => c.id === t))
    if (!unknown.length) return
    let alive = true
    void (async () => {
      const found: Record<string, string> = {}
      // All recent chats in one call; then each bot/project for anything older.
      for (const t of await api.threads.list().catch(() => [] as Thread[])) if (unknown.includes(t.id)) found[t.id] = t.spaceId
      if (unknown.some((id) => !found[id])) {
        for (const sp of await api.spaces.list().catch(() => [] as Space[])) {
          for (const t of await api.threads.list(sp.id).catch(() => [] as Thread[])) if (unknown.includes(t.id)) found[t.id] = t.spaceId
          if (unknown.every((id) => found[id])) break
        }
      }
      if (alive && Object.keys(found).length) setNeedSpaceOf((m) => ({ ...m, ...found }))
    })()
    return () => { alive = false }
  }, [needKey]) // eslint-disable-line react-hooks/exhaustive-deps
  /** Threads whose queued message is on its way (until that thread's next run event). */
  const sendingRef = useRef<Set<string>>(new Set())
  const [miniMsgs, setMiniMsgs] = useState<Message[]>([])

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
    setOpened(null)
    if (!thread) return setMessages([])
    const id = thread.id
    // Where you'd read to when you opened it: the NEW divider goes after this (bots and agent chats).
    const readAt = thread.lastReadAt ?? thread.createdAt
    let alive = true
    setMessages((cur) => cur.filter((m) => m.threadId === id))
    void api.chat.pending(id).then((ps) => { if (alive) setPending(ps) })
    void api.threads.messages(id).then((fetched) => { if (alive) setMessages((cur) => {
      const ids = new Set(fetched.map((m) => m.id))
      const live = cur.filter((m) => m.threadId === id && !ids.has(m.id))
      const merged = fetched.map((m) => cur.find((c) => c.id === m.id && c.content.length > m.content.length) ?? m)
      return [...merged, ...live].sort((a, b) => a.createdAt - b.createdAt)
    }); if (alive) setOpened({ id, readAt }) })
    // Opening a chat no longer reads it by itself: see the read-state effect below (visible, focused, at the bottom).
    return () => { alive = false }
  }, [thread?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Stream deltas arrive per token; applying each one re-rendered the whole app dozens of times a second.
  // They collect here and go in together once per frame (or within 50 ms when frames are throttled, e.g. a
  // hidden window). Any other event for the chat flushes them first, so the order of updates is kept.
  const deltaBuf = useRef(new Map<string, { content: string; reasoning: string }>())
  const deltaTimer = useRef<{ raf: number; to: ReturnType<typeof setTimeout> } | null>(null)
  const flushDeltas = useCallback(() => {
    if (deltaTimer.current) { cancelAnimationFrame(deltaTimer.current.raf); clearTimeout(deltaTimer.current.to); deltaTimer.current = null }
    const buf = deltaBuf.current
    if (!buf.size) return
    deltaBuf.current = new Map()
    setMessages((ms) => ms.map((m) => {
      const d = buf.get(m.id)
      return d ? { ...m, content: m.content + d.content, reasoning: d.reasoning ? (m.reasoning ?? '') + d.reasoning : m.reasoning } : m
    }))
  }, [])
  // A chat switch drops what was buffered for the old one (its messages are reloaded anyway).
  useEffect(() => { deltaBuf.current = new Map() }, [thread?.id])

  useEffect(() => api.chat.onEvent((e: ChatEvent) => {
    if (e.type !== 'delta') flushDeltas()
    if (e.type === 'spaces') { void refreshSpaces(); return }
    if (e.type === 'drafting') { setDrafting((d) => ({ ...d, [e.threadId]: e.tool })); return }
    if (e.type === 'tool_progress') { setToolProgress((p) => ({ ...p, [e.threadId]: e.text })); return }
    // A tool finished or the run ended: its progress line goes.
    if ((e.type === 'message' && e.message.role === 'tool') || (e.type === 'run' && e.status !== 'started')) setToolProgress((p) => (p[e.threadId] ? { ...p, [e.threadId]: null } : p))
    if (e.type === 'run') {
      sendingRef.current.delete(e.threadId)
      if (e.status === 'started') setRunSince((r) => ({ ...r, [e.threadId]: Date.now() }))
      else {
        setDrafting((d) => ({ ...d, [e.threadId]: null }))
        setSteering((s) => ({ ...s, [e.threadId]: 0 }))
        // A problem in a chat you're not looking at says where, with a way there (that chat has Retry).
        const elsewhere = e.threadId !== threadRef.current
        if (e.status === 'error' && e.error) toast(e.error, 'error', elsewhere ? { action: { label: 'Open chat', run: () => openAnyChatRef.current(e.threadId) } } : {})
      }
      setRunning((r) => {
        const n = new Set(r)
        if (e.status === 'started') n.add(e.threadId)
        else n.delete(e.threadId)
        return n
      })
      if (e.status !== 'started') void refreshSpaces()
      setRunSpaces((m) => { const n = { ...m }; if (e.status === 'started' && e.spaceId) n[e.threadId] = e.spaceId; else delete n[e.threadId]; return n })
      if (e.status !== 'started') setNeeds((x) => { if (!x[e.threadId]) return x; const n = { ...x }; delete n[e.threadId]; return n })
      // A chat you're not looking at finished: say so.
      if (e.status === 'finished' && e.threadId !== threadRef.current && e.title) toast(`Done: ${e.title.replace(/^⏰ /, '').slice(0, 60)}`, 'ok', { action: { label: 'Open', run: () => openAnyChatRef.current(e.threadId) } })
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
      // Read state included: the read-state effect clears it again if you're watching the bottom of this chat.
      if (e.thread.id === threadRef.current) setThread(e.thread)
      void refreshSpaces()
      return
    }
    // Every chat's open requests, so the sidebar can show which bots need you.
    if (e.type === 'pending') setNeeds((x) => ({ ...x, [e.threadId]: [...(x[e.threadId] ?? []).filter((id) => id !== e.request.id), e.request.id] }))
    else if (e.type === 'resolved') setNeeds((x) => {
      const left = (x[e.threadId] ?? []).filter((id) => id !== e.id)
      const n = { ...x }
      if (left.length) n[e.threadId] = left
      else delete n[e.threadId]
      return n
    })
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
      const d = deltaBuf.current.get(e.messageId) ?? { content: '', reasoning: '' }
      d.content += e.content ?? ''
      if (e.reasoning) d.reasoning += e.reasoning
      deltaBuf.current.set(e.messageId, d)
      if (!deltaTimer.current) deltaTimer.current = { raf: requestAnimationFrame(flushDeltas), to: setTimeout(flushDeltas, 50) }
    }
  }), [refreshSpaces, flushDeltas])

  // Menu bar commands.
  useEffect(() => api.onMenu((a) => {
    if (a === 'new-chat') { setSpaceId(null); setThread(null) }
    else if (a === 'new-bot') setEditor({ space: null, mode: 'bot' })
    else if (a === 'new-project') setEditor({ space: null, mode: 'project' })
    else if (a === 'settings') setShowSettings(true)
    else if (a === 'scheduled') setShowScheduled(true)
    else if (a === 'connect') setShowConnect(true)
    else if (a === 'toggle-panel') setPanel((p) => (p && p !== 'details' ? null : 'progress'))
    else if (a === 'search') setPalette(true)
    else if (a === 'needs-you') { setVaultOpen(null); setThread(null); setView('tasks') }
    else if (a === 'brain') { setVaultOpen(null); setThread(null); setView('brain') }
    else if (a === 'export' && threadRef.current) void api.chat.exportThread(threadRef.current).then((p) => p && toast(`Saved to ${p.split('/').pop()}`, 'ok'))
  }), [])

  useEffect(() => api.onMini(setMini), [])
  // A reopened window (or a web tab that joins mid-run) picks up chats that are already working.
  useEffect(() => {
    void api.chat.running?.().then((list) => {
      if (!list.length) return
      setRunning((r) => new Set([...r, ...list.map((x) => x.threadId)]))
      setRunSpaces((m) => ({ ...Object.fromEntries(list.map((x) => [x.threadId, x.spaceId])), ...m }))
    }).catch(() => undefined)
  }, [])
  // "Open in SahilBot" from Quick Ask.
  useEffect(() => api.onOpenThread((id) => { void refreshSpaces().then(() => openAnyChatRef.current(id)) }), [refreshSpaces])

  useEffect(() => api.voice.onEvent((e) => {
    // Speech recognition finished its background download (Settings → Voice shows the progress).
    if (e.type === 'download' && e.kind === 'whisper' && e.done && e.auto) toast(`Voice input is ready: ${e.label ?? 'Whisper'} runs on this Mac.`, 'ok')
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

  // Stock cards and the watchlist hand the next step to you: prefill the composer, or show the watchlist.
  useEffect(() => {
    const fill = (e: Event): void => { composer.current?.replace((e as CustomEvent<string>).detail); requestAnimationFrame(() => composer.current?.focus()) }
    // sahilbot:// links: the composer shows where the text came from (main/mcp-server/url-scheme.ts).
    const fillLink = (e: Event): void => { const t = (e as CustomEvent<unknown>).detail; if (typeof t === 'string') composer.current?.prefillFromLink(t); requestAnimationFrame(() => composer.current?.focus()) }
    const watch = (): void => setPanel('watchlist')
    window.addEventListener('sahilbot:compose', fill)
    window.addEventListener('sahilbot:compose-link', fillLink)
    window.addEventListener('sahilbot:open-watchlist', watch)
    return () => { window.removeEventListener('sahilbot:compose', fill); window.removeEventListener('sahilbot:compose-link', fillLink); window.removeEventListener('sahilbot:open-watchlist', watch) }
  }, [])

  useEffect(() => {
    const k = (e: KeyboardEvent): void => {
      if (e.metaKey && e.key === 'n') { e.preventDefault(); newChatRef.current() }
      if (e.metaKey && e.key === 'k') { e.preventDefault(); setPalette(true) }
      if (e.metaKey && e.key === ',') { e.preventDefault(); setShowSettings(true) }
      if (e.metaKey && e.key === '\\') { e.preventDefault(); setPanel((p) => (p && p !== 'details' ? null : 'progress')) }
      if (e.metaKey && e.shiftKey && e.key.toLowerCase() === 'd') { e.preventDefault(); composer.current?.toggleDictation() }
      if (e.metaKey && e.shiftKey && e.key.toLowerCase() === 'v') { e.preventDefault(); setVoiceOn(true) }
      // Max for the next message (the composer's Modes menu has it too).
      if (e.metaKey && e.shiftKey && e.key.toLowerCase() === 'm') { e.preventDefault(); composer.current?.toggleMax() }
      // Esc stops speaking, and the current run (when no dialog is open and Esc wasn't closing something else).
      if (e.key === 'Escape') void api.voice.stopSpeaking()
      if (e.key !== 'Escape' || e.defaultPrevented || !threadRef.current) return
      if (document.querySelector('.scrim, .palette-wrap, .voice-mode, .settings-page')) return
      // The bot details panel is open: Esc closes it (BotDetails' own listener, registered after this one), not the run.
      if (document.querySelector('[data-testid="bot-details"]')) return
      const el = document.activeElement
      if (el && el !== document.body && !el.matches('[data-testid="composer-input"]')) return
      void api.chat.stop(threadRef.current)
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [])

  const openMain = (): void => { setVaultOpen(null); setSpaceId(main?.id ?? null); setThread(null); setView('home') }
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
    // Chats other apps opened with this bot ("From Cursor") aren't the user's own conversation.
    setThread(ts.find((t) => !/^From .+/.test(t.title)) ?? ts[0])
    void refreshSpaces()
  }

  const onPalette = (a: PaletteAction): void => {
    setPalette(false)
    if (a.kind === 'new-chat') openMain()
    else if (a.kind === 'new-bot') setEditor({ space: null, mode: 'bot' })
    else if (a.kind === 'new-group') setEditor({ space: null, mode: 'group' })
    else if (a.kind === 'new-project') setEditor({ space: null, mode: 'project' })
    else if (a.kind === 'scheduled') setShowScheduled(true)
    else if (a.kind === 'projects' || a.kind === 'files' || a.kind === 'tasks' || a.kind === 'brain') { setView(a.kind); setThread(null) }
    else if (a.kind === 'connect') setShowConnect(true)
    else if (a.kind === 'settings') setShowSettings(true)
    else if (a.kind === 'panel') setPanel((p) => (p && p !== 'details' ? null : 'progress'))
    else if (a.kind === 'voice') setVoiceOn(true)
    else if (a.kind === 'dictate') requestAnimationFrame(() => composer.current?.toggleDictation())
    else if (a.kind === 'max') requestAnimationFrame(() => composer.current?.toggleMax())
    else if (a.kind === 'vault') setVaultOpen({ path: null })
    else if (a.kind === 'import-memory') setImportOpen(true)
    else if (a.kind === 'chat') void openAnyChat(a.id)
    else if (a.kind === 'usage') { setSettingsPage('usage'); setShowSettings(true) }
    else if (a.kind === 'setting') { setSettingsPage(`#${a.anchor}`); setShowSettings(true) }
    else void openBot(a.id)
  }

  // Send the next queued message as soon as the thread is free.
  useEffect(() => {
    for (const [tid, items] of Object.entries(queue)) {
      if (!items.length || running.has(tid) || sendingRef.current.has(tid)) continue
      const first = items[0]
      sendingRef.current.add(tid)
      setQueue((q) => ({ ...q, [tid]: (q[tid] ?? []).filter((x) => x !== first) }))
      // On failure it goes back to the front and is retried after this thread's next run event (no hot retry loop).
      void api.chat.send({ threadId: tid, text: first.text, images: first.images, attachments: first.attachments, team: first.team, deepResearch: first.deepResearch, planFirst: first.planFirst, ...(first.heavy ? { heavy: true } : {}), ...(first.max ? { max: true } : {}), ...(first.swarm ? { swarm: true } : {}), ...(first.council ? { council: first.council } : {}), ...(first.fromLink ? { meta: { fromLink: true } } : {}), ...(first.workingFolder ? { workingFolder: first.workingFolder } : {}) }).catch((e: Error) => {
        setQueue((q) => ({ ...q, [tid]: [first, ...(q[tid] ?? [])] }))
        toast(e.message, 'error')
      })
    }
  }, [queue, running])

  // The mini window follows the chat it was opened for, even when another chat is open here.
  const miniOther = mini.on && mini.threadId && mini.threadId !== thread?.id ? mini.threadId : null
  useEffect(() => {
    setMiniMsgs([])
    if (!miniOther) return
    let alive = true
    void api.threads.messages(miniOther).then((ms) => { if (alive) setMiniMsgs((cur) => [...ms, ...cur.filter((c) => !ms.some((m) => m.id === c.id))]) })
    const off = api.chat.onEvent((e: ChatEvent) => {
      if (e.type === 'message' && e.message.threadId === miniOther) {
        setMiniMsgs((ms) => { const i = ms.findIndex((m) => m.id === e.message.id); if (i < 0) return [...ms, e.message]; const n = ms.slice(); n[i] = e.message; return n })
      } else if (e.type === 'delta' && e.threadId === miniOther && e.content) {
        setMiniMsgs((ms) => ms.map((m) => (m.id === e.messageId ? { ...m, content: m.content + e.content } : m)))
      }
    })
    return () => { alive = false; off() }
  }, [miniOther])

  // How many helper agents this Mac can run with the model in use.
  const capModel = thread?.model ?? draft.model ?? settings?.defaultModel ?? 'auto'
  useEffect(() => { void api.models.teamCapacity(capModel).then(setTeamCap) }, [capModel, models])

  // Read state (shared/read-state.ts). The open chat is read while you can see it (window or tab visible and
  // focused) and you're at or near the bottom; a reply that lands while you watch is read too. The mark is
  // "up to the newest message on screen", kept in the database so the Mac app and the web UI agree.
  const attention = useAttention()
  const atBottomRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const onAtBottom = useCallback((b: boolean) => { atBottomRef.current = b; setAtBottom(b) }, [])
  useEffect(() => { atBottomRef.current = true; setAtBottom(true) }, [thread?.id])
  const readTo = useRef<Record<string, number>>({})
  const marking = useRef(new Set<string>())
  const [markTick, setMarkTick] = useState(0)
  const ready = !!thread && opened?.id === thread.id
  const latestReply = newestReplyAt(messages)
  const latestReplyRef = useRef(0)
  latestReplyRef.current = latestReply
  useEffect(() => {
    if (!thread || !ready || !attention || !atBottomRef.current) return
    const id = thread.id
    const readAt = Math.max(readTo.current[id] ?? 0, thread.lastReadAt ?? 0)
    if ((!thread.unread && latestReply <= readAt) || marking.current.has(id)) return
    marking.current.add(id)
    void api.threads.markRead(id, Math.max(newestAt(messages), latestReply)).then((t) => {
      readTo.current[id] = Math.max(readTo.current[id] ?? 0, t.lastReadAt ?? 0)
      setThread((cur) => (cur?.id === id ? { ...cur, unread: t.unread, lastReadAt: t.lastReadAt, unreadCount: t.unreadCount } : cur))
      // A reply that came in while this was on its way: once more.
      if (latestReplyRef.current > (t.lastReadAt ?? 0)) setMarkTick((x) => x + 1)
    }).catch(() => undefined).finally(() => marking.current.delete(id))
  }, [thread?.id, thread?.unread, thread?.lastReadAt, ready, attention, atBottom, latestReply, markTick]) // eslint-disable-line react-hooks/exhaustive-deps

  // A first message waiting for the chat that's about to open (a new bot's job, "Try it" on a connected app).
  const pendingCompose = useRef<string | null>(null)
  useEffect(() => {
    const t = pendingCompose.current
    if (!t || !thread) return
    pendingCompose.current = null
    requestAnimationFrame(() => composer.current?.replace(t))
  }, [thread?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // All hooks above this line: the early return below must not change the hook count.
  // Docs: a chat's documents are its own, so switching chats shows the new chat's latest (or the one asked for).
  const pendingDoc = useRef<string | null>(null)
  useEffect(() => {
    const p = pendingDoc.current
    pendingDoc.current = null
    setDocId(p)
    if (p) setPanel('doc')
  }, [thread?.id])
  const openDocRef = useRef<(d: { docId: string; threadId: string }) => void>(() => undefined)
  useEffect(() => {
    const on = (e: Event): void => { const d = (e as CustomEvent<{ docId: string; threadId: string }>).detail; if (d?.docId) openDocRef.current(d) }
    window.addEventListener('sahilbot:open-doc', on)
    return () => window.removeEventListener('sahilbot:open-doc', on)
  }, [])

  // First real paint (settings loaded, shell on screen): log it for SAHILBOT_TIMING (main reads console
  // lines starting [sb-timing]), then fetch the split chunks in the background.
  const painted = !!settings
  useEffect(() => {
    if (!painted) return
    requestAnimationFrame(() => setTimeout(() => {
      console.debug(`[sb-timing] first paint of the app at ${Math.round(performance.now())}ms after page start`)
      preloadSurfaces()
    }, 0))
  }, [painted])

  if (!settings) return null

  // A bot chat with nothing picked routes as Auto (the app default only when that is an Auto variant).
  const model = thread?.model ?? draft.model ?? (space && !space.isMain && space.kind !== 'project' && !isAutoModel(settings.defaultModel) ? 'auto' : settings.defaultModel)
  const mode: PermissionMode = thread?.permissionMode ?? draft.mode ?? (space && settings.botModes?.[space.id]) ?? settings.defaultMode ?? 'auto'
  const isRunning = !!thread && running.has(thread.id)
  const question = pending.find((p) => p.kind === 'question' || p.kind === 'questions' || p.kind === 'plan')
  const isBot = !!space && !space.isMain && space.kind !== 'project'
  const isProject = space?.kind === 'project'
  /** Whose chat this is: the bot, group or project; plain chats belong to SahilBot itself. */
  const chatBot = isBot || isProject ? space : main

  const patchThread = async (patch: Parameters<typeof api.threads.update>[1]): Promise<void> => {
    if (!thread) return
    setThread(await api.threads.update(thread.id, patch))
  }

  const send = async (o: Outgoing): Promise<void> => {
    // A bot asked a question: what you type is the answer (but never unedited text from a link).
    if (question && thread && o.fromLink) { toast('Text from a link can\'t answer this. Edit it, or answer the card above.', 'error'); return }
    if (question && thread) {
      // Typing answers the card: one answer for every question, or approval / changes for a plan.
      const answer = question.kind === 'questions' ? JSON.stringify((question.questions ?? []).map(() => o.text))
        : question.kind === 'plan' ? (/^(yes|yep|ok|okay|approve|approved|go|go ahead|start|looks good|lgtm|do it)\b/i.test(o.text.trim()) ? 'approve' : `revise: ${o.text}`)
          : o.text
      await api.chat.respond(thread.id, question.id, answer)
      return
    }
    if (thread && running.has(thread.id)) {
      // ⌘Enter (or attachments): wait until it's done. Enter: steer the agent now.
      // Link text waits too: a steer can't carry its "from a link" mark.
      if (o.queue || o.fromLink || o.attachments.length || o.images.length) setQueue((q) => ({ ...q, [thread.id]: [...(q[thread.id] ?? []), o] }))
      else await api.chat.steer(thread.id, o.text).catch((e: Error) => toast(e.message, 'error'))
      return
    }
    let t = thread
    if (!t) {
      const sid = space?.id ?? main?.id
      if (!sid) return
      const created = await api.threads.create(sid)
      // Without a pick here, main already started it at the bot's (or the app's) autonomy level.
      t = await api.threads.update(created.id, { model: draft.model, ...(draft.mode ? { permissionMode: draft.mode } : {}), ...(draft.effort ? { effort: draft.effort } : {}) })
      threadRef.current = t.id
      setMessages([])
      setThread(t)
    }
    try {
      await api.chat.send({ threadId: t.id, text: o.text, images: o.images, attachments: o.attachments, team: o.team, deepResearch: o.deepResearch, planFirst: o.planFirst, ...(o.heavy ? { heavy: true } : {}), ...(o.max ? { max: true } : {}), ...(o.swarm ? { swarm: true } : {}), ...(o.council ? { council: o.council } : {}), ...(o.fromLink ? { meta: { fromLink: true } } : {}), ...(o.workingFolder ? { workingFolder: o.workingFolder } : {}) })
      void refreshSpaces()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }


  const openFile = (p: string): void => { setFile(p); setPanel('file') }
  const openDoc = (id: string): void => { setDocId(id); setPanel('doc') }
  // The bot's Library opens a document in its chat (hooks are above, before the early return).
  openDocRef.current = (d) => {
    if (thread?.id === d.threadId) openDoc(d.docId)
    else { pendingDoc.current = d.docId; void openAnyChat(d.threadId) }
  }
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
      key={thread?.id ?? 'new'}
      ref={composer}
      threadId={thread?.id}
      inheritedFolder={space?.kind === 'group' ? null : space?.folder ?? null}
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
      swarm={space?.kind === 'bot' ? { mode: settings.botMax?.[space.id]?.mode ?? settings.botSwarm?.[space.id]?.mode ?? 'auto' } : null}
      council={councilChoices(models)}
      thinking={thread?.effort ?? draft.effort ?? (isBot ? 'auto' : settings.thinking)}
      onThinking={(e) => (thread ? void patchThread({ effort: e }) : setDraft((d) => ({ ...d, effort: e })))}
      mode={mode}
      allowBypass={!!settings.advanced.allowBypass}
      autoBot={isBot}
      onMode={(m) => {
        const apply = (): void => { if (thread) void patchThread({ permissionMode: m }).catch((e: Error) => toast(e.message, 'error')); else setDraft((d) => ({ ...d, mode: m })) }
        // Bypass asks once (the dialog below saves the answer); after that it's one click like the others.
        if (m === 'bypass' && !settings.advanced.allowBypass) setBypassAsk(() => apply)
        else apply()
      }}
      onVoice={() => setVoiceOn(true)}
      placeholder={isRunning ? `Add to what ${chatBot?.name ?? 'SahilBot'} is doing…` : isBot ? `Message ${space?.name}` : isProject && !thread ? `Start a chat in ${space?.name}` : thread ? `Message ${chatBot?.name ?? 'SahilBot'}` : 'How can I help you today?'}
      big={!thread}
      steering={thread ? steering[thread.id] : 0}
      projects={!thread && !isBot ? {
        list: spaces.filter((x) => x.kind === 'project' && !x.hidden).map((x) => ({ id: x.id, name: x.name, color: x.color, folder: x.folder })),
        current: isProject ? space?.id ?? null : null,
        onPick: (id) => { if (id) void openBot(id); else openMain() },
        onNew: () => setEditor({ space: null, mode: 'project' })
      } : undefined}
    />
  )

  const prog = thread ? progress[thread.id] : undefined
  const plan = (() => {
    const call = [...messages].reverse().flatMap((m) => [...(m.toolCalls ?? [])].reverse()).find((c) => c.name === 'todo')
    try { return call ? (JSON.parse(call.arguments).items as Array<{ status: string }>) : [] } catch { return [] }
  })()
  // Computer use: a small always-on-top window that shows what SahilBot is doing, with Stop.
  if (mini.on) {
    const last = [...(miniOther ? miniMsgs : messages)].reverse().find((m) => m.role === 'tool' || (m.role === 'assistant' && m.content))
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
  const modal = showSettings || !!editor || palette || showConnect || showScheduled || voiceOn || !settings.onboarded
  // The chat's colour: your bubbles, the voice and send buttons. SahilBot itself uses the accent.
  const botColor = chatBot && !chatBot.isMain ? chatBot.color : null
  // Text and icons on it: near-black or white, whichever has the higher WCAG contrast (#ff6a1a is --accent).
  const chatStyle = { '--bot': botColor ?? 'var(--accent)', '--bot-text': readableOn(botColor ?? '#ff6a1a') } as React.CSSProperties
  const detailsSpace = chatBot ?? main
  const needThreads = new Set(Object.keys(needs))
  const needSpaces = new Set([...Object.keys(needs).map((t) => runSpaces[t] ?? (t === thread?.id ? thread.spaceId : chats.find((c) => c.id === t)?.spaceId ?? needSpaceOf[t] ?? '')).filter(Boolean), ...queuedBots])

  const dev = !!settings.advanced.devMode
  return (
    <DevMode.Provider value={dev}>
    <div className={`app${dev ? ' dev' : ''}`}>
      <Toasts />
      {/* The secrets vault's unlock / confirm dialog: main asks, this only shows it. */}
      <VaultAuthDialog />
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
        modelLabel={`${autoLabel(settings.defaultModel) ?? models?.models.find((m) => m.id === settings.defaultModel)?.label ?? settings.defaultModel} · ${({ auto: 'Auto', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra', max: 'Max' } as Record<string, string>)[settings.thinking]}`}
        onCustomize={(s) => setEditor({ space: s, mode: s.kind })}
        onChanged={() => void refreshSpaces().then((sp) => {
          if (thread && !sp.some((s) => s.id === thread.spaceId)) openMain()
          else if (thread) void api.threads.list(thread.spaceId).then((ts) => { if (!ts.some((t) => t.id === thread.id)) openMain() })
        })}
        onSettings={() => setShowSettings(true)}
        onConnect={() => setShowConnect(true)}
        onScheduled={() => setShowScheduled(true)}
        onNewProject={() => setEditor({ space: null, mode: 'project' })}
        runningThreads={running}
        runningSpaces={new Set(Object.values(runSpaces))}
        needThreads={needThreads}
        needSpaces={needSpaces}
        pinned={settings.pinnedBots}
        onPinned={(ids) => void api.settings.set({ pinnedBots: ids }).then(setSettings)}
      />
      <main className="main chat-root" style={chatStyle}>
        <header className="main-header drag">
          <div className="header-title">
            {isProject && space && <button className="crumb" onClick={() => setThread(null)} title="Project home"><I.Folder size={14} />{space.name}</button>}
          </div>
          {chatBot && (thread || (isBot && view === 'home')) && (
            <div className={`chat-pill${panel === 'details' ? ' on' : ''}`}>
              {renamingTitle && thread ? (
                <input className="title-edit" autoFocus defaultValue={thread.title}
                  onBlur={(e) => { setRenamingTitle(false); const v = e.target.value.trim(); if (v && v !== thread.title) void patchThread({ title: v }).then(() => refreshSpaces()) }}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { e.preventDefault(); setRenamingTitle(false) } }} />
              ) : (
                <button className="bot-pill" onClick={() => setPanel((p) => (p === 'details' ? null : 'details'))} data-testid="bot-pill" title={`About ${chatBot.name}`}>
                  {chatBot.kind === 'project'
                    ? <span className="proj-tile" style={{ background: chatBot.color, width: 22, height: 22, borderRadius: 7 }}><I.Folder size={12} /></span>
                    : <SpaceAvatar color={chatBot.color} shape={chatBot.shape} size={22} group={chatBot.kind === 'group' ? memberColors : undefined} />}
                  <span className="pill-name">{chatBot.name}</span>
                  {thread && !isBot && <span className="pill-title" data-testid="thread-title">{thread.title}</span>}
                </button>
              )}
              {thread && (
                <Popover label={<I.Chevron size={14} />} className="title-menu" menuClass="down" title="Chat options">
                  {(close) => (
                    <>
                      <button className="menu-item" onClick={() => { close(); setPanel('details') }}><I.Users size={15} />About {chatBot.name}</button>
                      <button className="menu-item" onClick={() => { close(); setRenamingTitle(true) }}><I.Edit size={15} />Rename chat</button>
                      <button className="menu-item" onClick={() => { close(); void patchThread({ pinned: !thread.pinned }).then(() => refreshSpaces()) }}><I.Pin size={15} />{thread.pinned ? 'Unpin' : 'Pin'}</button>
                      <button className="menu-item" onClick={() => { close(); void api.chat.exportThread(thread.id).then((p) => p && toast(`Saved to ${p.split('/').pop()}`, 'ok')) }}><I.Share size={15} />Export as Markdown</button>
                      <div className="menu-sep" />
                      <button className="menu-item danger" onClick={() => { close(); if (confirm(`Delete "${thread.title}"?`)) void api.threads.remove(thread.id).then(() => { openMain(); void refreshSpaces() }) }}><I.Trash size={15} />Delete chat</button>
                    </>
                  )}
                </Popover>
              )}
            </div>
          )}
          <div className="header-actions">
            {thread && <JobsChip threadId={thread.id} on={panel === 'jobs'} onOpen={() => setPanel((p) => (p === 'jobs' ? null : 'jobs'))} />}
            {dev && ((isRunning && (prog?.plan || (prog?.actions ?? 0) > 0)) || plan.length > 0) && (
              <button className={`progress-chip${panel === 'progress' ? ' on' : ''}`} onClick={() => setPanel((p) => (p === 'progress' ? null : 'progress'))} data-testid="progress-chip">
                {isRunning && <span className="spin" />}
                <I.ListIcon size={15} />
                {/* Steps come from the agent's own plan; without one, just how much it has done. */}
                {isRunning && prog?.plan ? `Step ${prog.plan.at} of ${prog.plan.of}` : isRunning && prog ? `${prog.actions} action${prog.actions === 1 ? '' : 's'}` : `${plan.filter((t) => t.status === 'done').length} of ${plan.length} done`}
              </button>
            )}
            {dev && prog && prog.used / prog.window > 0.6 && (() => {
              // Shown only once it matters: a gauge of how full the chat's memory is, explained in words.
              const pct = Math.round(Math.min(1, prog.used / prog.window) * 100)
              const cost = prog.cost ? ` Each step costs about $${prog.cost.usd < 0.01 ? prog.cost.usd.toFixed(4) : prog.cost.usd.toFixed(2)} at this size${prog.cost.estimated ? ' (estimated)' : ''}.` : ''
              const tip = `Chat memory ${pct}% full: older parts will be summarized automatically, so you can keep going.${cost}`
              return (
                <span className={`ctx-ring${prog.used / prog.window > 0.85 ? ' full' : ''}`} role="img" tabIndex={0} aria-label={tip} title={tip} data-testid="ctx-ring">
                  <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.5" fill="none" stroke="var(--ctx-track)" strokeWidth="3" />
                    <circle cx="10" cy="10" r="7.5" fill="none" stroke={prog.used / prog.window > 0.85 ? 'var(--accent)' : 'var(--text-2)'} strokeWidth="3"
                      strokeDasharray={`${Math.max(2, Math.min(1, prog.used / prog.window) * 47.1)} 47.1`} transform="rotate(-90 10 10)" /></svg>
                  <span className="ctx-pct">{pct}%</span>
                </span>
              )
            })()}
            <button className={`icon-btn globe${panel === 'browser' ? ' on' : ''}`} title={browser?.controlling ? 'Browser: SahilBot is using it now (click to watch)' : 'Browser: the web pages SahilBot opens'} aria-label="Browser" onClick={() => setPanel((p) => (p === 'browser' ? null : 'browser'))} data-testid="toggle-browser">
              <I.Globe size={17} />
              {!!browser?.tabs.length && <span className={`globe-dot${browser.controlling ? ' live' : ''}`} />}
            </button>
            <button className={`icon-btn${panel && panel !== 'details' ? ' on' : ''}`} title="Side panel: progress, files and documents (⌘\)" aria-label="Side panel" onClick={() => setPanel((p) => (p && p !== 'details' ? null : 'progress'))} data-testid="toggle-panel"><I.Panel size={17} /></button>
            <button className="icon-btn" title="Settings (⌘,)" aria-label="Settings" onClick={() => setShowSettings(true)} data-testid="header-settings"><I.Gear size={17} /></button>
          </div>
        </header>
        {models && !models.ok && (
          <div className="banner">
            No model is available yet. Add a Claude, OpenAI or Grok key or your ChatGPT plan{models.localOff ? '' : ', or start a local model server'}, then
            <button onClick={() => void refreshModels()}>retry</button>or<button onClick={() => { setSettingsPage('keys'); setShowSettings(true) }}>open Settings</button>.
          </div>
        )}

        {vaultOpen ? (
          <Lazy><VaultView initialPath={vaultOpen.path} initialTab={vaultOpen.tab} onClose={() => setVaultOpen(null)} /></Lazy>
        ) : view === 'tasks' && !thread ? (
          <TasksView spaces={spaces} onOpenChat={(threadId) => void openAnyChat(threadId)} />
        ) : view === 'brain' && !thread ? (
          <BrainView onConnect={() => setShowConnect(true)} onNeedsYou={() => setView('tasks')} onOpenChat={(threadId) => void openAnyChat(threadId)} />
        ) : view === 'files' && !thread ? (
          <FilesView onOpenFile={openFile} onOpenChat={(id) => void openAnyChat(id)} />
        ) : view === 'projects' && !thread ? (
          <ProjectsView spaces={spaces} onOpen={(id) => void openBot(id)} onNew={() => setEditor({ space: null, mode: 'project' })} />
        ) : thread ? (
          <>
            <ThreadView key={thread.id} messages={messages} running={isRunning} pending={pending} teams={teams}
              ready={ready} onAtBottom={onAtBottom}
              unreadAfter={opened?.id === thread.id && dividerKind({ space: spaces.find((s) => s.id === thread.spaceId), thread, messages }) ? opened.readAt : null}
              drafting={drafting[thread.id] ?? null} since={runSince[thread.id]} progress={toolProgress[thread.id] ?? null}
              actions={{
                onRetry: () => void api.chat.retry(thread.id).catch((e: Error) => toast(e.message, 'error')),
                onEditLast: (text) => void api.chat.editLast(thread.id, text).catch((e: Error) => toast(e.message, 'error')),
                onRespond: (id, answer) => api.chat.respond(thread.id, id, answer),
                onReact: (id, emoji) => void api.threads.react(id, emoji),
                onReply: (text) => composer.current?.insert(`> ${text.replace(/\s+/g, ' ').slice(0, 220)}\n`),
                onOpenFile: openFile,
                onOpenDoc: openDoc
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
              {dev && !isRunning && <RunSummary threadId={thread.id} messages={messages} mode={mode} />}
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
      {panel === 'details' && detailsSpace ? (
        <Lazy fallback="panel">
          <BotDetails space={detailsSpace} threadId={thread?.id ?? null} onClose={() => setPanel(null)}
            onCustomize={() => setEditor({ space: detailsSpace, mode: detailsSpace.kind })}
            onChanged={() => void refreshSpaces()}
            onEditRoutine={(text) => { composer.current?.replace(text); requestAnimationFrame(() => composer.current?.focus()) }} />
        </Lazy>
      ) : panel && panel !== 'details' && (
        <RightPanel tab={panel} onTab={setPanel} hidden={modal} messages={messages} file={file}
          onOpenFile={openFile} browserState={browser} onClose={() => setPanel(null)} threadId={thread?.id ?? null}
          running={isRunning} progress={prog ? { used: prog.used, window: prog.window, model: (prog.routed as { label?: string } | undefined)?.label ?? prog.model, actions: prog.actions } : undefined}
          stocks={!!chatBot && !chatBot.isMain && /stock|market|invest|portfolio/i.test(chatBot.name)}
          docId={docId} onDocId={setDocId} botColor={botColor} botName={chatBot?.name}
          onAsk={(text, title) => { composer.current?.insert(`About this part of “${title}”:\n> ${text.replace(/\s+/g, ' ').slice(0, 800)}\n`); composer.current?.focus() }} />
      )}
      {!settings.onboarded && <Lazy><Onboarding settings={settings} onDone={(s) => { setSettings(s); void refreshModels() }} /></Lazy>}
      {voiceOn && (
        <Lazy>
          <VoiceMode threadId={thread?.id ?? null} space={space} onClose={() => setVoiceOn(false)}
            onThread={(id) => { if (thread?.id !== id) void api.threads.list(space?.id).then((ts) => { const t = ts.find((x) => x.id === id); if (t) setThread(t) }) }} />
        </Lazy>
      )}
      {bypassAsk && (
        <ConfirmDialog title="Turn on Bypass?" confirm="Turn on Bypass" danger testId="bypass-confirm"
          onCancel={() => setBypassAsk(null)}
          onConfirm={() => {
            const go = bypassAsk
            setBypassAsk(null)
            void api.settings.set({ advanced: { ...settings.advanced, allowBypass: true } }).then((s) => { setSettings(s); go() }).catch((e: Error) => toast(e.message, 'error'))
          }}>
          <p>Bypass runs everything without asking, except purchases, passwords and one-time codes, which always need you.</p>
          <p className="hint">Use it only for work you're watching. It applies to this chat and goes back to Auto when SahilBot restarts. You won't be asked again.</p>
        </ConfirmDialog>
      )}
      {palette && <CommandPalette spaces={spaces} chats={chats} onPick={onPalette} onClose={() => setPalette(false)} />}
      {importOpen && <Lazy><ImportMemoryDialog onClose={() => setImportOpen(false)} onDone={() => setImportOpen(false)} /></Lazy>}
      {showSettings && (
        <Lazy>
          <SettingsModal settings={settings} models={models} sys={sys} spaces={spaces} initialPage={settingsPage}
            onClose={() => { setShowSettings(false); setSettingsPage(undefined) }}
            onSaved={setSettings} onRefreshModels={() => void refreshModels()} />
        </Lazy>
      )}
      {showConnect && <Lazy><ConnectApps onClose={() => setShowConnect(false)} onBrowse={(url) => { setPanel('browser'); void api.browser.navigate(url) }}
        onTry={(text) => { setShowConnect(false); openMain(); setTimeout(() => composer.current?.replace(text), 60) }}
        onOpenBot={(id) => { setShowConnect(false); void refreshSpaces().then(() => openBot(id)) }}
        onOpenSettings={(page) => { setShowConnect(false); setSettingsPage(page); setShowSettings(true) }} /></Lazy>}
      {showScheduled && (
        <Lazy>
          <Scheduled spaces={spaces.filter((x) => x.kind !== 'group')} onClose={() => setShowScheduled(false)}
            onOpen={(t) => { setShowScheduled(false); void api.threads.list(t.spaceId).then((ts) => { const th = ts.find((x) => x.id === t.threadId); if (th) { setSpaceId(t.spaceId); setThread(th) } }) }} />
        </Lazy>
      )}
      {editor && (
        <Lazy>
          <BotEditor space={editor.space} spaces={spaces} models={models} mode={editor.mode} onClose={() => setEditor(null)}
            onSaved={(id, _t, suggestion) => { pendingCompose.current = suggestion ?? null; void refreshSpaces().then(() => openBot(id)) }} />
        </Lazy>
      )}
    </div>
    </DevMode.Provider>
  )
}
