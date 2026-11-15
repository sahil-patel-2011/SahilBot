import type { SahilBotApi } from '@shared/types'

declare global {
  interface Window {
    foreman: SahilBotApi
  }
}

export const api = window.foreman

/** True in a browser connected to SahilBot Server (Electron-only features are hidden there). */
export const isServerRuntime = api?.runtime === 'server'
