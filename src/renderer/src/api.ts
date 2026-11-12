import type { SahilBotApi } from '@shared/types'

declare global {
  interface Window {
    foreman: SahilBotApi
  }
}

export const api = window.foreman
