import { contextBridge, ipcRenderer } from 'electron'

// The SahilBot cursor overlay's page gets exactly this: steps to draw (one channel in), and the pill's
// Stop button (one message out). Nothing else from Electron or Node reaches it.
contextBridge.exposeInMainWorld('sahilbotOverlay', {
  onAction: (cb: (msg: unknown) => void): void => {
    ipcRenderer.removeAllListeners('overlay:action')
    ipcRenderer.on('overlay:action', (_e, msg: unknown) => cb(msg))
  },
  stop: (): void => ipcRenderer.send('overlay:stop')
})
