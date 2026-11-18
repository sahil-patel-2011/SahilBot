import { useEffect, useState } from 'react'
import type { ChatEvent } from '@shared/types'
import type { BotStatusMap } from '@shared/bot-status'
import { api } from '../api'

// Every bot's status (bots:status in main), shared by the sidebar rows and the bot card. One fetch for all
// components, refreshed (debounced) on the chat events that change it: runs starting and finishing, new
// messages and tool calls, read/unread.
let cache: BotStatusMap = {}
const listeners = new Set<() => void>()
let started = false
let timer: ReturnType<typeof setTimeout> | null = null

function refresh(): void {
  void api.bots.status().then((m) => { cache = m; listeners.forEach((f) => f()) }).catch(() => undefined)
}

function schedule(delay = 350): void {
  if (timer) return
  timer = setTimeout(() => { timer = null; refresh() }, delay)
}

function start(): void {
  if (started) return
  started = true
  refresh()
  api.chat.onEvent((e: ChatEvent) => {
    if (e.type === 'run' || e.type === 'thread' || e.type === 'spaces') schedule(150)
    else if (e.type === 'drafting' || (e.type === 'message' && e.message.role !== 'user')) schedule()
  })
}

/** Status by bot id; re-renders when it changes. */
export function useBotStatus(): BotStatusMap {
  const [, bump] = useState(0)
  useEffect(() => {
    start()
    const f = (): void => bump((n) => n + 1)
    listeners.add(f)
    return () => { listeners.delete(f) }
  }, [])
  return cache
}
