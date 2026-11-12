import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { BrowserState, ChatEvent, SahilBotApi, VoiceUiEvent } from '@shared/types'

const call = (ch: string) => (...args: unknown[]) => ipcRenderer.invoke(ch, ...args)

const api: SahilBotApi = {
  system: { info: call('system:info') as SahilBotApi['system']['info'] },
  settings: { get: call('settings:get') as never, set: call('settings:set') as never },
  models: {
    list: call('models:list') as never,
    test: call('models:test') as never,
    pull: call('models:pull') as never,
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
    promptPath: call('spaces:promptPath') as never
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
    reveal: call('files:reveal') as never
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
  budget: call('budget') as never,
  detectProviders: call('detectProviders') as never,
  pickFolder: call('pickFolder') as never,
  schedules: {
    list: call('schedules:list') as never,
    create: call('schedules:create') as never,
    update: call('schedules:update') as never,
    remove: call('schedules:remove') as never,
    runNow: call('schedules:runNow') as never,
    onChange(cb) {
      const fn = (): void => cb()
      ipcRenderer.on('schedules:changed', fn)
      return () => ipcRenderer.removeListener('schedules:changed', fn)
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
    onChange(cb) {
      const fn = (): void => cb()
      ipcRenderer.on('connectors:changed', fn)
      return () => ipcRenderer.removeListener('connectors:changed', fn)
    }
  },
  vault: { list: call('vault:list') as never, set: call('vault:set') as never, remove: call('vault:remove') as never },
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
  memory: { list: call('memory:list') as never, remove: call('memory:remove') as never, add: call('memory:add') as never, update: call('memory:update') as never },
  rules: { list: call('rules:list') as never, save: call('rules:save') as never, setEnabled: call('rules:setEnabled') as never, remove: call('rules:remove') as never },
  skills: { list: call('skills:list') as never, save: call('skills:save') as never, remove: call('skills:remove') as never },
  chat: {
    send: call('chat:send') as never,
    stop: call('chat:stop') as never,
    respond: call('chat:respond') as never,
    retry: call('chat:retry') as never,
    editLast: call('chat:editLast') as never,
    exportThread: call('chat:export') as never,
    pending: call('chat:pending') as never,
    onEvent(cb) {
      const fn = (_e: unknown, ev: ChatEvent): void => cb(ev)
      ipcRenderer.on('chat:event', fn)
      return () => ipcRenderer.removeListener('chat:event', fn)
    }
  }
}

contextBridge.exposeInMainWorld('foreman', api)
