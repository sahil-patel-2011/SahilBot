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
  spaces: {
    list: call('spaces:list') as never,
    create: call('spaces:create') as never,
    update: call('spaces:update') as never,
    remove: call('spaces:remove') as never,
    markUnread: call('spaces:markUnread') as never,
    getPrompt: call('spaces:getPrompt') as never,
    setPrompt: call('spaces:setPrompt') as never,
    promptPath: call('spaces:promptPath') as never,
    library: call('spaces:library') as never
  },
  threads: {
    list: call('threads:list') as never,
    search: call('threads:search') as never,
    create: call('threads:create') as never,
    update: call('threads:update') as never,
    remove: call('threads:remove') as never,
    messages: call('threads:messages') as never,
    react: call('threads:react') as never
  },
  files: {
    pick: call('files:pick') as never,
    // Paths of dropped files are only knowable here, from real File objects.
    fromDrop: (files: File[]) => ipcRenderer.invoke('files:register', files.map((f) => webUtils.getPathForFile(f)).filter(Boolean)),
    preview: call('files:preview') as never,
    open: call('files:open') as never,
    reveal: call('files:reveal') as never,
    recent: call('files:recent') as never,
    snippet: call('files:snippet') as never
  },
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
    status: call('voice:status') as never,
    download: call('voice:download') as never,
    setVoice: call('voice:setVoice') as never,
    start: call('voice:start') as never,
    stop: call('voice:stop') as never,
    dictateStart: call('voice:dictateStart') as never,
    dictateStop: call('voice:dictateStop') as never,
    speak: call('voice:speak') as never,
    stopSpeaking: call('voice:stopSpeaking') as never,
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
  vault: {
    list: call('vault:list') as never, set: call('vault:set') as never, remove: call('vault:remove') as never,
    totpCode: call('vault:totpCode') as never, otpGrants: call('vault:otpGrants') as never, revokeOtpGrant: call('vault:revokeOtpGrant') as never,
    cards: call('vault:cards') as never, setCard: call('vault:setCard') as never, removeCard: call('vault:removeCard') as never,
    addresses: call('vault:addresses') as never, setAddress: call('vault:setAddress') as never, removeAddress: call('vault:removeAddress') as never
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
    getEnabled: call('memory:getEnabled') as never, setEnabled: call('memory:setEnabled') as never
  },
  rules: { list: call('rules:list') as never, save: call('rules:save') as never, setEnabled: call('rules:setEnabled') as never, remove: call('rules:remove') as never },
  // Settings → Memory → What I learned.
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
  bots: { exportFile: call('bots:export') as never, importPick: call('bots:importPick') as never, importConfirm: call('bots:importConfirm') as never, duplicate: call('bots:duplicate') as never },
  checkin: { get: call('checkin:get') as never, set: call('checkin:set') as never },
  watchlist: { get: call('watchlist:get') as never, set: call('watchlist:set') as never },
  markets: { quotes: call('markets:quotes') as never, card: call('markets:card') as never, search: call('markets:search') as never },
  cad: { onshapeTest: call('onshape:test') as never },
  usage: { report: call('usage:report') as never, exportCsv: call('usage:exportCsv') as never, forRun: call('usage:forRun') as never },
  skills: { list: call('skills:list') as never, save: call('skills:save') as never, remove: call('skills:remove') as never },
  alwaysOn: { status: call('alwaysOn:status') as never, pauseRoutines: call('alwaysOn:pauseRoutines') as never },
  permissions: { status: call('permissions:status') as never, open: call('permissions:open') as never, automation: call('permissions:automation') as never },
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
  // Connected apps (MCP server): Settings → Privacy & Permissions.
  mcp: {
    status: call('mcp:status') as never, setEnabled: call('mcp:setEnabled') as never,
    createClient: call('mcp:createClient') as never, revokeClient: call('mcp:revokeClient') as never,
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
  }
}

contextBridge.exposeInMainWorld('foreman', api)

// Settings changed in main (by any window, a bot or the menu bar): the app reloads its copy.
ipcRenderer.on('settings:changed', () => { window.dispatchEvent(new Event('sahilbot:settings-changed')) })
