import { useEffect, useRef, useState } from 'react'
import type { Space, VoiceUiEvent } from '@shared/types'
import { api } from '../api'
import { SpaceAvatar } from '../brand'
import * as I from '../icons'
import { Mic, Speaker } from '../lib/audio'

type VState = 'starting' | 'idle' | 'listening' | 'hearing' | 'thinking' | 'speaking'
const LABEL: Record<VState, string> = {
  starting: 'Getting ready…', idle: 'Paused', listening: 'Listening', hearing: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking — talk any time to interrupt'
}

/** Hands-free conversation: everything stays on the Mac. */
export function VoiceMode({ threadId, space, onClose, onThread }: { threadId: string | null; space: Space | undefined; onClose: () => void; onThread: (id: string) => void }) {
  const [state, setState] = useState<VState>('starting')
  const [you, setYou] = useState('')
  const [reply, setReply] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [level, setLevel] = useState(0)
  const mic = useRef<Mic | null>(null)
  const speaker = useRef<Speaker | null>(null)

  useEffect(() => {
    let alive = true
    speaker.current = new Speaker()
    const off = api.voice.onEvent((e: VoiceUiEvent) => {
      if (e.type === 'state') setState(e.state as VState)
      else if (e.type === 'transcript') { setYou(e.text); setReply('') }
      else if (e.type === 'reply') setReply((r) => r + e.text)
      else if (e.type === 'audio') speaker.current?.play(e.audio, e.rate)
      else if (e.type === 'stop-audio') speaker.current?.stop()
      else if (e.type === 'error') setError(e.message)
    })
    void (async () => {
      try {
        const id = await api.voice.start(threadId, space?.id ?? '')
        if (!alive) return
        onThread(id)
        mic.current = new Mic()
        await mic.current.start()
      } catch (e) {
        setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
      }
    })()
    const t = setInterval(() => setLevel(Math.max(mic.current?.level ?? 0, speaker.current?.level ?? 0)), 60)
    return () => {
      alive = false
      clearInterval(t)
      off()
      mic.current?.stop()
      speaker.current?.close()
      void api.voice.stop()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const k = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])

  const color = space && !space.isMain ? space.color : 'var(--accent)'
  return (
    <div className="voice-mode" data-testid="voice-mode" data-state={state}>
      <div className="voice-top">{space && !space.isMain && <><SpaceAvatar color={space.color} shape={space.shape} size={28} /><b>{space.name}</b></>}</div>
      <div className="orb-wrap">
        <div className={`orb ${state}`} style={{ background: color, transform: `scale(${1 + level * 0.35})` }} />
      </div>
      <div className="voice-state">{error ?? LABEL[state]}</div>
      <div className="voice-lines">
        {you && <div className="voice-you">“{you}”</div>}
        {reply && <div className="voice-reply">{reply}</div>}
      </div>
      <div className="voice-actions">
        <button className="voice-end" onClick={onClose} data-testid="voice-end"><I.Close size={20} /> End</button>
      </div>
      <div className="hint">Voice stays on this Mac: Whisper and Kokoro run locally.</div>
    </div>
  )
}
