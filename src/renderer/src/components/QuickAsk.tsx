import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Message } from '@shared/types'
import { api } from '../api'
import { Mascot } from '../brand'
import * as I from '../icons'
import { Markdown } from './Markdown'

/**
 * Quick Ask: the floating bar you get with ⌥Space over any app. Ask, optionally with a screenshot of
 * your screen or what's on your clipboard, and the answer streams right here. The chat is saved and
 * "Open in SahilBot" continues it in the main window.
 */
export function QuickAsk() {
  const [text, setText] = useState('')
  const [screen, setScreen] = useState(false)
  const [clip, setClip] = useState(false)
  const [threadId, setThreadId] = useState<string | null>(null)
  const [answer, setAnswer] = useState<Message | null>(null)
  const [busy, setBusy] = useState(false)
  const [doing, setDoing] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const tid = useRef<string | null>(null)
  tid.current = threadId

  useEffect(() => api.quick.onShown(() => requestAnimationFrame(() => input.current?.focus())), [])
  useEffect(() => { input.current?.focus() }, [])

  // Grow the window with the answer.
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => void api.quick.resize(el.getBoundingClientRect().height + 2))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => api.chat.onEvent((e) => {
    if (e.threadId !== tid.current) return
    if (e.type === 'message' && e.message.role === 'assistant' && e.message.kind === 'normal' && !e.message.meta?.superseded && !e.message.meta?.provisional) setAnswer(e.message)
    else if (e.type === 'message' && e.message.role === 'tool') setDoing(String(e.message.meta?.display ?? e.message.toolName ?? ''))
    else if (e.type === 'delta') setAnswer((a) => (a && a.id === e.messageId ? { ...a, content: a.content + (e.content ?? '') } : a))
    else if (e.type === 'drafting') setDoing(e.tool ? 'Working…' : null)
    else if (e.type === 'run' && e.status !== 'started') { setBusy(false); setDoing(null); if (e.status === 'error' && e.error) setError(e.error) }
  }), [])

  useEffect(() => {
    const k = (e: KeyboardEvent): void => { if (e.key === 'Escape') void api.quick.hide() }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [])

  const ask = async (): Promise<void> => {
    const q = text.trim()
    if (!q || busy) return
    setBusy(true)
    setError(null)
    setAnswer(null)
    setDoing(screen ? 'Looking at your screen…' : 'Thinking…')
    try {
      setThreadId(await api.quick.ask(q, { screen, clipboard: clip }))
      setText('')
    } catch (e) {
      setBusy(false)
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }

  const reset = (): void => { setThreadId(null); setAnswer(null); setError(null); setDoing(null); input.current?.focus() }

  return (
    <div className="quick" ref={box} data-testid="quick-ask">
      <div className="quick-row">
        <Mascot size={26} />
        <input ref={input} value={text} onChange={(e) => setText(e.target.value)} placeholder={threadId ? 'Ask a follow-up in SahilBot…' : 'Ask SahilBot anything'}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (threadId && !busy) { void api.quick.open(threadId) } else void ask() } }} data-testid="quick-input" />
        {busy ? <span className="spin" /> : null}
      </div>
      <div className="quick-tools">
        <button className={`quick-chip${screen ? ' on' : ''}`} onClick={() => setScreen((x) => !x)} title="Include a screenshot of your screen"><I.Image size={13} />Screen</button>
        <button className={`quick-chip${clip ? ' on' : ''}`} onClick={() => setClip((x) => !x)} title="Include what's on your clipboard"><I.Copy size={13} />Clipboard</button>
        <span className="spacer" />
        {doing && busy && <span className="quick-doing">{doing}</span>}
        <span className="quick-hint">↵ ask · esc close</span>
      </div>
      {(answer || error) && (
        <div className="quick-answer">
          {error ? <div className="quick-error">{error}</div> : answer && <Markdown text={answer.content} streaming={busy} />}
          <div className="quick-foot">
            {threadId && <button className="link-btn" onClick={() => void api.quick.open(threadId)} data-testid="quick-open">Open in SahilBot ↗</button>}
            <button className="link-btn" onClick={reset}>New question</button>
          </div>
        </div>
      )}
    </div>
  )
}
