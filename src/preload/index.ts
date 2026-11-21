import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { BrowserState, ChatEvent, JobEvent, SahilBotApi, VoiceUiEvent } from '@shared/types'

const call = (ch: string) => (...args: unknown[]) => ipcRenderer.invoke(ch, ...args)

const api: SahilBotApi = {
  system: { info: call('system:info') as SahilBotApi['system']['info'] },
  settings: { get: call('settings:get') as never, set: call('settings:set') as never },
  models: {
    list: call('models:list') as never,
    test: call('models:test') as never,
    pull: call('models:pull') as never,
    remove: call('models:delete') as never,
    teamCapacity: call('agents:capacity') as never,
    gpu: call('gpu:status') as never,
    setupPicks: call('models:setupPicks') as never,
    setGpuLimit: call('gpu:setLimit') as never,
    onPull: (cb) => {
      const h = (_e: unknown, ev: Parameters<typeof cb>[0]): void => cb(ev)
      ipcRenderer.on('models:pull', h)
      return () => { ipcRenderer.removeListener('models:pull', h) }
    }
  },
  // ChatGPT plan (via Codex): Settings → Models (src/main/llm/codex).
  chatgptPlan: {
    status: call('chatgptPlan:status') as never,
    connect: call('chatgptPlan:connect') as never,
    loginInTerminal: call('chatgptPlan:loginInTerminal') as never,
    installInTerminal: call('chatgptPlan:installInTerminal') as never,
    testChat: call('chatgptPlan:testChat') as never,
    disconnect: call('chatgptPlan:disconnect') as never,
    setPrefs: call('chatgptPlan:setPrefs') as never,
    openInstallGuide: call('chatgptPlan:openInstallGuide') as never,
    onChanged: (cb) => {
      const h = (): void => cb()
      ipcRenderer.on('chatgptPlan:changed', h)
      return () => { ipcRenderer.removeListener('chatgptPlan:changed', h) }
    }
  },
  privacy: {
    status: call('privacy:status') as never,
    install: call('privacy:install') as never,
    setEnabled: call('privacy:setEnabled') as never,
    remove: call('privacy:remove') as never,
    selfTest: call('privacy:selfTest') as never,
    setMode: call('privacy:setMode') as never,
    forgetNotPersonal: call('privacy:forgetNotPersonal') as never,
    onInstall: (cb) => {
      const h = (_e: unknown, ev: import('@shared/privacy').PrivacyInstallEvent): void => cb(ev)
      ipcRenderer.on('privacy:install', h)
      return () => { ipcRenderer.removeListener('privacy:install', h) }
    }
  },
  grokPlan: {
    status: call('grokPlan:status') as never,
    configure: call('grokPlan:configure') as never,
    signIn: call('grokPlan:signIn') as never,
    installInTerminal: call('grokPlan:installInTerminal') as never,
    testChat: call('grokPlan:testChat') as never,
    openInstallGuide: call('grokPlan:openInstallGuide') as never
  },
  spaces: {
    list: call('spaces:list') as never,
    create: call('spaces:create') as never,
    update: call('spaces:update') as never,
    remove: call('spaces:remove') as never,
    markUnread: call('spaces:markUnread') as never,
    getPrompt: call('spaces:getPrompt') as never,
    setPrompt: call('spaces:setPrompt') as never,
    promptPath: call('spaces:promptPath') as never,
    library: call('spaces:library') as never,
    startSetup: call('spaces:startSetup') as never
  },
  threads: {
    list: call('threads:list') as never,
    search: call('threads:search') as never,
    create: call('threads:create') as never,
    update: call('threads:update') as never,
    markRead: call('threads:markRead') as never,
    remove: call('threads:remove') as never,
    messages: call('threads:messages') as never,
    react: call('threads:react') as never
  },
  // The chat's video card checks its render here (agent/tools/video.ts).
  video: { get: call('video:get') as never },
  files: {
    pick: call('files:pick') as never,
    // Paths of dropped files are only knowable here, from real File objects.
    fromDrop: (files: File[]) => ipcRenderer.invoke('files:register', files.map((f) => webUtils.getPathForFile(f)).filter(Boolean)),
    preview: call('files:preview') as never,
    open: call('files:open') as never,
    reveal: call('files:reveal') as never,
    recent: call('files:recent') as never,
    artifacts: call('files:artifacts') as never,
    ideas: call('ideas:home') as never,
    snippet: call('files:snippet') as never
  },
  // Attachments (main: attachments.ts): dropped or pasted File objects resolve to paths here; ones with no
  // file behind them (a pasted screenshot, an image dragged from a web page) are sent as bytes and saved
  // to a temp file by main.
  attach: {
    fromFiles: async (files: File[]) => {
      const paths: string[] = []
      const blobs: Array<{ name: string; type: string; data: Uint8Array }> = []
      const rejected: Array<{ name: string; reason: string }> = []
      for (const f of files) {
        const p = webUtils.getPathForFile(f)
        if (p) { paths.push(p); continue }
        if (f.size > 100 * 1024 * 1024) { rejected.push({ name: f.name || 'Pasted item', reason: 'Files up to 100 MB can be attached.' }); continue }
        blobs.push({ name: f.name, type: f.type, data: new Uint8Array(await f.arrayBuffer()) })
      }
      const r = await ipcRenderer.invoke('attach:add', { paths, blobs }) as { added: unknown[]; rejected: Array<{ name: string; reason: string }> }
      return { added: r.added, rejected: [...rejected, ...r.rejected] }
    },
    screenshot: call('attach:screenshot') as never,
    scanFolder: call('attach:scanFolder') as never,
    onScan: (cb: (e: unknown) => void) => {
      const h = (_: unknown, e: unknown): void => cb(e)
      ipcRenderer.on('attach:scan', h)
      return () => { ipcRenderer.removeListener('attach:scan', h) }
    },
    folder: call('attach:folder') as never,
    pickFolder: call('attach:pickFolder') as never,
    clearFolder: call('attach:clearFolder') as never,
    useFolder: call('attach:useFolder') as never,
    pickBotFolder: call('attach:pickBotFolder') as never,
    clearBotFolder: call('attach:clearBotFolder') as never,
    pick: call('attach:pick') as never
  } as never,
  local: { status: call('local:status') as never, set: call('local:set') as never },
  pages: { info: call('pages:info') as never, openWindow: call('pages:openWindow') as never, exportPdf: call('pages:exportPdf') as never, show: call('pages:show') as never, thumbnail: call('pages:thumbnail') as never },
  // Docs: live documents beside the chat (src/main/docspace).
  docs: {
    list: call('docs:list') as never,
    get: call('docs:get') as never,
    create: call('docs:create') as never,
    save: call('docs:save') as never,
    versions: call('docs:versions') as never,
    version: call('docs:version') as never,
    diff: call('docs:diff') as never,
    restore: call('docs:restore') as never,
    export: call('docs:export') as never,
    importFile: call('docs:importFile') as never,
    source: call('docs:source') as never,
    createNew: call('docs:createNew') as never,
    recent: call('docs:recent') as never,
    saveBack: call('docs:saveBack') as never,
    addImage: call('docs:addImage') as never,
    dirty: call('docs:dirty') as never,
    flushed: call('docs:flushed') as never,
    onEvent(cb) {
      const fn = (_e: unknown, ev: Parameters<typeof cb>[0]): void => cb(ev)
      ipcRenderer.on('docs:event', fn)
      return () => { ipcRenderer.removeListener('docs:event', fn) }
    },
    onFlush(cb) {
      const fn = (_e: unknown, id: string): void => cb(id)
      ipcRenderer.on('docs:flush', fn)
      return () => { ipcRenderer.removeListener('docs:flush', fn) }
    }
  },
  providers: call('providers') as never,
  onMenu(cb) {
    const fn = (_e: unknown, a: string): void => cb(a)
    ipcRenderer.on('menu', fn)
    return () => ipcRenderer.removeListener('menu', fn)
  },
  onMini(cb) {
    const fn = (_e: unknown, m: { on: boolean; threadId?: string }): void => cb(m)
    ipcRenderer.on('mini', fn)
    return () => ipcRenderer.removeListener('mini', fn)
  },
  exitMini: call('mini:exit') as never,
  quick: {
    ask: call('quick:ask') as never,
    hide: call('quick:hide') as never,
    resize: call('quick:resize') as never,
    open: call('quick:open') as never,
    onShown(cb) {
      const fn = (): void => cb()
      ipcRenderer.on('quick:shown', fn)
      return () => ipcRenderer.removeListener('quick:shown', fn)
    }
  },
  onOpenThread(cb) {
    const fn = (_e: unknown, id: string): void => cb(id)
    ipcRenderer.on('open-thread', fn)
    return () => ipcRenderer.removeListener('open-thread', fn)
  },
  budget: call('budget') as never,
  onBudgetChanged(cb) {
    const fn = (): void => cb()
    ipcRenderer.on('budget:changed', fn)
    return () => ipcRenderer.removeListener('budget:changed', fn)
  },
  detectProviders: call('detectProviders') as never,
  ollama: {
    setup: call('ollama:setup') as never,
    installed: call('ollama:installed') as never,
    onSetup: (cb) => {
      const h = (_e: unknown, ev: Parameters<typeof cb>[0]): void => cb(ev)
      ipcRenderer.on('ollama:setup', h)
      return () => { ipcRenderer.removeListener('ollama:setup', h) }
    }
  },
  pickFolder: call('pickFolder') as never,
  schedules: {
    list: call('schedules:list') as never,
    create: call('schedules:create') as never,
    update: call('schedules:update') as never,
    remove: call('schedules:remove') as never,
    runNow: call('schedules:runNow') as never,
    runs: call('schedules:runs') as never,
    onChange(cb) {
      const fn = (): void => cb()
      ipcRenderer.on('schedules:changed', fn)
      return () => ipcRenderer.removeListener('schedules:changed', fn)
    }
  },
  // Long-running goals (Tasks board, bot details).
  goals: {
    list: call('goals:list') as never,
    update: call('goals:update') as never,
    runNow: call('goals:runNow') as never,
    onChange(cb) {
      const fn = (): void => cb()
      ipcRenderer.on('goals:changed', fn)
      return () => ipcRenderer.removeListener('goals:changed', fn)
    }
  },
  voice: {
    openNative: call('voice:openNative') as never,
    status: call('voice:status') as never,
    download: call('voice:download') as never,
    setVoice: call('voice:setVoice') as never,
    start: call('voice:start') as never,
    stop: call('voice:stop') as never,
    dictateStart: call('voice:dictateStart') as never,
    dictateStop: call('voice:dictateStop') as never,
    speak: call('voice:speak') as never,
    stopSpeaking: call('voice:stopSpeaking') as never,
    tasks: call('voice:tasks') as never,
    options: call('voice:options') as never,
    setStyle: call('voice:setStyle') as never,
    preview: call('voice:preview') as never,
    frame: (samples: Float32Array) => ipcRenderer.send('voice:frame', samples),
    onEvent(cb) {
      const fn = (_e: unknown, ev: VoiceUiEvent): void => cb(ev)
      ipcRenderer.on('voice:event', fn)
      return () => ipcRenderer.removeListener('voice:event', fn)
    }
  },
  connectors: {
    presets: call('connectors:presets') as never,
    list: call('connectors:list') as never,
    save: call('connectors:save') as never,
    remove: call('connectors:remove') as never,
    connect: call('connectors:connect') as never,
    connectPreset: call('connectors:connectPreset') as never,
    disconnect: call('connectors:disconnect') as never,
    icons: call('connectors:icons') as never,
    setToolEnabled: call('connectors:setToolEnabled') as never,
    test: call('connectors:test') as never,
    googleClient: call('connectors:googleClient') as never,
    setGoogleClient: call('connectors:setGoogleClient') as never,
    clearGoogleClient: call('connectors:clearGoogleClient') as never,
    setApiKey: call('connectors:setApiKey') as never,
    checkAll: call('connectors:checkAll') as never,
    useBuiltinClient: call('connectors:useBuiltinClient') as never,
    clearApiKey: call('connectors:clearApiKey') as never,
    pasteApiKey: call('connectors:pasteApiKey') as never,
    onIcons(cb) {
      const fn = (): void => cb()
      ipcRenderer.on('connectors:icons', fn)
      return () => ipcRenderer.removeListener('connectors:icons', fn)
    },
    onChange(cb) {
      const fn = (): void => cb()
      ipcRenderer.on('connectors:changed', fn)
      return () => ipcRenderer.removeListener('connectors:changed', fn)
    }
  },
  google: {
    status: call('google:status') as never, useMail: call('google:useMail') as never, useAppPassword: call('google:useAppPassword') as never,
    useOauth: call('google:useOauth') as never, disconnect: call('google:disconnect') as never
  },
  vault: {
    list: call('vault:list') as never, set: call('vault:set') as never, remove: call('vault:remove') as never,
    totpCode: call('vault:totpCode') as never, otpGrants: call('vault:otpGrants') as never, revokeOtpGrant: call('vault:revokeOtpGrant') as never,
    cards: call('vault:cards') as never, setCard: call('vault:setCard') as never, removeCard: call('vault:removeCard') as never,
    addresses: call('vault:addresses') as never, setAddress: call('vault:setAddress') as never, removeAddress: call('vault:removeAddress') as never,
    status: call('vault:status') as never, items: call('vault:items') as never, saveItem: call('vault:saveItem') as never, removeItem: call('vault:removeItem') as never,
    unlock: call('vault:unlock') as never, lock: call('vault:lock') as never, reveal: call('vault:reveal') as never, setPrefs: call('vault:setPrefs') as never,
    setMasterPassword: call('vault:setMasterPassword') as never, removeMasterPassword: call('vault:removeMasterPassword') as never, setTouchIdUnlock: call('vault:setTouchIdUnlock') as never,
    audit: call('vault:audit') as never, exportBackup: call('vault:exportBackup') as never, importBackup: call('vault:importBackup') as never, importCsv: call('vault:importCsv') as never,
    purgeLegacy: call('vault:purgeLegacy') as never, rollback: call('vault:rollback') as never, resign: call('vault:resign') as never,
    authPending: call('vault:authPending') as never, authRespond: call('vault:authRespond') as never,
    offerSave: call('vault:offerSave') as never, offerDismiss: call('vault:offerDismiss') as never, offerNever: call('vault:offerNever') as never,
    offerAlive: call('vault:offerAlive') as never, neverSave: call('vault:neverSave') as never, removeNeverSave: call('vault:removeNeverSave') as never,
    onAuth(cb) {
      const fn = (_e: unknown, ev: Parameters<typeof cb>[0]): void => cb(ev)
      ipcRenderer.on('vault:auth', fn)
      return () => { ipcRenderer.removeListener('vault:auth', fn) }
    },
    onChanged(cb) {
      const fn = (): void => cb()
      ipcRenderer.on('vault:changed', fn)
      return () => { ipcRenderer.removeListener('vault:changed', fn) }
    }
  },
  purchase: { respond: call('purchase:respond') as never },
  browser: {
    state: call('browser:state') as never,
    setBounds: call('browser:setBounds') as never,
    navigate: call('browser:navigate') as never,
    back: call('browser:back') as never,
    forward: call('browser:forward') as never,
    reload: call('browser:reload') as never,
    newTab: call('browser:newTab') as never,
    switchTab: call('browser:switchTab') as never,
    closeTab: call('browser:closeTab') as never,
    takeOver: call('browser:takeOver') as never,
    teachStart: call('browser:teachStart') as never,
    teachStop: call('browser:teachStop') as never,
    teachCancel: call('browser:teachCancel') as never,
    teachCompose: call('browser:teachCompose') as never,
    onState(cb) {
      const fn = (_e: unknown, s: BrowserState): void => cb(s)
      ipcRenderer.on('browser:state', fn)
      return () => ipcRenderer.removeListener('browser:state', fn)
    },
    onOpenRequest(cb) {
      const fn = (): void => cb()
      ipcRenderer.on('browser:open', fn)
      return () => ipcRenderer.removeListener('browser:open', fn)
    }
  },
  sites: { list: call('sites:list') as never, get: call('sites:get') as never, forget: call('sites:forget') as never },
  memory: {
    list: call('memory:list') as never, remove: call('memory:remove') as never, add: call('memory:add') as never, update: call('memory:update') as never,
    importPreview: call('memory:importPreview') as never, importCommit: call('memory:importCommit') as never,
    importSave: call('memory:importSave') as never, copyImportPrompt: call('memory:copyImportPrompt') as never,
    getEnabled: call('memory:getEnabled') as never, setEnabled: call('memory:setEnabled') as never,
    restore: call('memory:restore') as never
  },
  rules: { list: call('rules:list') as never, save: call('rules:save') as never, setEnabled: call('rules:setEnabled') as never, remove: call('rules:remove') as never },
  // The knowledge vault (src/main/vault): notes your bots keep, Obsidian-compatible.
  notesVault: {
    status: call('notesVault:status') as never, setSettings: call('notesVault:setSettings') as never, setBot: call('notesVault:setBot') as never,
    list: call('notesVault:list') as never, read: call('notesVault:read') as never, resolve: call('notesVault:resolve') as never,
    search: call('notesVault:search') as never, save: call('notesVault:save') as never, create: call('notesVault:create') as never,
    trash: call('notesVault:trash') as never, graph: call('notesVault:graph') as never, changes: call('notesVault:changes') as never,
    undo: call('notesVault:undo') as never, openInObsidian: call('notesVault:openInObsidian') as never, reveal: call('notesVault:reveal') as never,
    exportZip: call('notesVault:exportZip') as never, compileNow: call('notesVault:compileNow') as never,
    obsidianDetect: call('notesVault:obsidianDetect') as never, obsidianPick: call('notesVault:obsidianPick') as never,
    obsidianNotes: call('notesVault:obsidianNotes') as never, obsidianCopyExisting: call('notesVault:obsidianCopyExisting') as never,
    obsidianRescan: call('notesVault:obsidianRescan') as never,
    onChanged(cb) {
      const fn = (): void => cb()
      ipcRenderer.on('notesVault:changed', fn)
      return () => ipcRenderer.removeListener('notesVault:changed', fn)
    }
  },
  // Vault → People & Places (src/main/context-engine).
  people: {
    status: call('people:status') as never, setSettings: call('people:setSettings') as never, list: call('people:list') as never,
    card: call('people:card') as never, update: call('people:update') as never, merge: call('people:merge') as never,
    forget: call('people:forget') as never, undo: call('people:undo') as never, exportData: call('people:exportData') as never,
    learnNow: call('people:learnNow') as never,
    onChanged(cb) {
      const fn = (): void => cb()
      ipcRenderer.on('people:changed', fn)
      return () => { ipcRenderer.removeListener('people:changed', fn) }
    }
  },
  // Your brain (src/main/brain): the Brain page, Agent mode's prompts, the brain's settings.
  brain: {
    status: call('brain:status') as never, setSettings: call('brain:setSettings') as never, refresh: call('brain:refresh') as never,
    briefs: call('brain:briefs') as never, correct: call('brain:correct') as never, forget: call('brain:forget') as never, undo: call('brain:undo') as never,
    backfill: call('brain:backfill') as never, forgetSource: call('brain:forgetSource') as never, openChip: call('brain:openChip') as never,
    prompts: call('brain:prompts') as never,
    onChanged(cb) {
      const fn = (): void => cb()
      ipcRenderer.on('brain:changed', fn)
      return () => { ipcRenderer.removeListener('brain:changed', fn) }
    }
  },
  // Settings → Memory → Learned.
  learning: {
    status: call('learning:status') as never, list: call('learning:list') as never, undo: call('learning:undo') as never,
    approve: call('learning:approve') as never, dismiss: call('learning:dismiss') as never,
    runNow: call('learning:runNow') as never, openChat: call('learning:openChat') as never,
    onChanged(cb) {
      const fn = (): void => cb()
      ipcRenderer.on('learning:changed', fn)
      return () => { ipcRenderer.removeListener('learning:changed', fn) }
    }
  },
  templates: { list: call('templates:list') as never, add: call('templates:add') as never },
  bots: { exportFile: call('bots:export') as never, importPick: call('bots:importPick') as never, importConfirm: call('bots:importConfirm') as never, duplicate: call('bots:duplicate') as never, status: call('bots:status') as never },
  // Always-on bots: the Needs-you inbox (questions and approvals across all bots) and each bot's autonomy level.
  needsYou: {
    list: call('needsYou:list') as never,
    answer: call('needsYou:answer') as never,
    reviewed: call('needsYou:reviewed') as never,
    onChange(cb) {
      const fn = (): void => cb()
      ipcRenderer.on('needsYou:changed', fn)
      return () => ipcRenderer.removeListener('needsYou:changed', fn)
    }
  },
  botAutonomy: { setLevel: call('botAutonomy:setLevel') as never },
  checkin: { get: call('checkin:get') as never, set: call('checkin:set') as never },
  watchlist: { get: call('watchlist:get') as never, set: call('watchlist:set') as never },
  markets: { quotes: call('markets:quotes') as never, card: call('markets:card') as never, search: call('markets:search') as never },
  cad: { onshapeTest: call('onshape:test') as never },
  fast: { catalog: call('fast:catalog') as never },
  usage: { report: call('usage:report') as never, exportCsv: call('usage:exportCsv') as never, forRun: call('usage:forRun') as never, dashboard: call('usage:dashboard') as never, glance: call('usage:glance') as never },
  skills: { list: call('skills:list') as never, save: call('skills:save') as never, remove: call('skills:remove') as never },
  alwaysOn: { status: call('alwaysOn:status') as never, pauseRoutines: call('alwaysOn:pauseRoutines') as never, setLidAwake: call('alwaysOn:setLidAwake') as never },
  update: {
    status: call('update:status') as never, check: call('update:check') as never, install: call('update:install') as never, history: call('update:history') as never, upgradedFrom: call('update:upgradedFrom') as never,
    onStatus: (cb) => {
      const h = (_e: unknown, st: Parameters<typeof cb>[0]): void => cb(st)
      ipcRenderer.on('update:status', h)
      return () => { ipcRenderer.removeListener('update:status', h) }
    }
  },
  backups: {
    status: call('backups:status') as never, now: call('backups:now') as never, setRecoveryPassword: call('backups:setRecoveryPassword') as never,
    clearRecovery: call('backups:clearRecovery') as never, restoreKeys: call('backups:restoreKeys') as never,
    chooseExtraFolder: call('backups:chooseExtraFolder') as never, clearExtraFolder: call('backups:clearExtraFolder') as never, open: call('backups:open') as never
  },
  permissions: { status: call('permissions:status') as never, open: call('permissions:open') as never, request: call('permissions:request') as never, automation: call('permissions:automation') as never },
  activity: {
    status: call('activity:status') as never, set: call('activity:set') as never, pause: call('activity:pause') as never,
    clear: call('activity:clear') as never, checkPermissions: call('activity:checkPermissions') as never,
    onChange(cb) {
      const fn = (): void => cb()
      ipcRenderer.on('activity:changed', fn)
      return () => ipcRenderer.removeListener('activity:changed', fn)
    }
  },
  knowledge: {
    status: call('knowledge:status') as never,
    addFolder: call('knowledge:addFolder') as never,
    addAttached: call('knowledge:addAttached') as never,
    removeFolder: call('knowledge:removeFolder') as never,
    setPaused: call('knowledge:setPaused') as never,
    rebuild: call('knowledge:rebuild') as never,
    search: call('knowledge:search') as never,
    reveal: call('knowledge:reveal') as never,
    open: call('knowledge:open') as never,
    onChanged(cb) {
      const fn = (): void => cb()
      ipcRenderer.on('knowledge:changed', fn)
      return () => { ipcRenderer.removeListener('knowledge:changed', fn) }
    }
  },
  // Connected apps (MCP server): Settings → Privacy & Security.
  mcp: {
    status: call('mcp:status') as never, setEnabled: call('mcp:setEnabled') as never,
    createClient: call('mcp:createClient') as never, revokeClient: call('mcp:revokeClient') as never,
    setScope: call('mcp:setScope') as never, brainNames: call('mcp:brainNames') as never,
    onChange(cb) {
      const fn = (): void => cb()
      ipcRenderer.on('mcp:changed', fn)
      return () => ipcRenderer.removeListener('mcp:changed', fn)
    }
  },
  // Background jobs (Jobs tab).
  jobs: {
    list: call('jobs:list') as never, output: call('jobs:output') as never, stop: call('jobs:stop') as never,
    restart: call('jobs:restart') as never, remove: call('jobs:remove') as never,
    onEvent(cb) {
      const fn = (_e: unknown, ev: JobEvent): void => cb(ev)
      ipcRenderer.on('jobs:event', fn)
      return () => ipcRenderer.removeListener('jobs:event', fn)
    }
  },
  chat: {
    resume: call('chat:resume') as never,
    interrupted: call('chat:interrupted') as never,
    send: call('chat:send') as never,
    stop: call('chat:stop') as never,
    steer: call('chat:steer') as never,
    respond: call('chat:respond') as never,
    retry: call('chat:retry') as never,
    editLast: call('chat:editLast') as never,
    exportThread: call('chat:export') as never,
    pending: call('chat:pending') as never,
    allPending: call('chat:allPending') as never,
    running: call('chat:running') as never,
    onEvent(cb) {
      const fn = (_e: unknown, ev: ChatEvent): void => cb(ev)
      ipcRenderer.on('chat:event', fn)
      return () => ipcRenderer.removeListener('chat:event', fn)
    }
  },
  // Team boards and Heavy cards: cancel one helper, or stop the ones that haven't finished.
  swarm: {
    cancel: call('agents:cancelHelper') as never,
    stopRemaining: call('agents:stopRemaining') as never
  },
  // The Mac app (the browser build of this file reports 'server'). Settings → Always-on server.
  runtime: 'electron',
  remoteServer: {
    status: call('remoteServer:status') as never,
    connect: call('remoteServer:connect') as never,
    disconnect: call('remoteServer:disconnect') as never,
    openUi: call('remoteServer:openUi') as never,
    macLink: call('macLink:status') as never,
    setMacLink: call('macLink:set') as never
  },
  workers: {
    list: call('workers:list') as never,
    pair: call('workers:pair') as never,
    capacity: call('workers:capacity') as never,
    assign: call('workers:assign') as never,
    open: call('workers:open') as never
  },
  // Settings → General → Phone access: this Mac serves SahilBot to paired phones (src/main/phone).
  phoneAccess: {
    status: call('phoneAccess:status') as never,
    setEnabled: call('phoneAccess:setEnabled') as never,
    setOptions: call('phoneAccess:setOptions') as never,
    newCode: call('phoneAccess:newCode') as never,
    revoke: call('phoneAccess:revoke') as never,
    rename: call('phoneAccess:rename') as never,
    audit: call('phoneAccess:audit') as never,
    onChange(cb) {
      const fn = (): void => cb()
      ipcRenderer.on('phoneAccess:changed', fn)
      return () => ipcRenderer.removeListener('phoneAccess:changed', fn)
    }
  },
  // Team access: teammates ask the owner's brain within the scope the owner set (src/server/team.ts).
  team: {
    status: call('team:status') as never, invite: call('team:invite') as never, reinvite: call('team:reinvite') as never,
    setScope: call('team:setScope') as never, revoke: call('team:revoke') as never,
    onChanged(cb) {
      const fn = (): void => cb()
      ipcRenderer.on('team:changed', fn)
      return () => ipcRenderer.removeListener('team:changed', fn)
    }
  }
}

contextBridge.exposeInMainWorld('foreman', api)

// Settings changed in main (by any window, a bot or the menu bar): the app reloads its copy.
ipcRenderer.on('settings:changed', () => { window.dispatchEvent(new Event('sahilbot:settings-changed')) })
