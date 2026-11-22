import { useEffect, useRef, useState } from 'react'
import type { ChatEvent, PendingRequest, Space, VoiceBarOptions, VoiceTask, VoiceUiEvent } from '@shared/types'
import { api } from '../api'
import { Mascot, SpaceAvatar } from '../brand'
import * as I from '../icons'
import { Mic, Speaker } from '../lib/audio'
import { PendingCard } from './Agent'

type VState = 'starting' | 'idle' | 'listening' | 'hearing' | 'thinking' | 'speaking'
const LABEL: Record<VState, string> = {
  starting: 'Getting ready…', idle: 'Paused', listening: 'Listening', hearing: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking · talk to interrupt'
}
/** Main's setup errors, in plain words with the one thing to do. */
const friendly = (e: string): string => /speech provider|api key|key in|models & keys/i.test(e) ? 'Voice isn\'t set up yet. Add an OpenAI (ChatGPT) or Grok key to talk out loud.' : /microphone|permission|notallowed/i.test(e) ? 'SahilBot can\'t hear you yet. Allow the microphone in System Settings → Privacy & Security.' : e
const TASK_STATE: Record<VoiceTask['status'], string> = { working: 'working', 'needs-you': 'needs you', done: 'done', failed: 'didn\'t finish', stopped: 'stopped' }
const clean = (e: unknown): string => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/**
 * The voice bar: a conversation with the bot at the top of the chat you're in. Real work you ask for runs in the
 * background (start_work) and the bot tells you when it's done; its approvals show under the bar as cards you
 * tap. The transcript button shows what's being said in the chat (folded into one line when you hang up).
 */
export function VoiceMode({ threadId, space, onClose, onThread, onLive }: {
  threadId: string | null
  space: Space | undefined
  onClose: () => void
  onThread: (id: string) => void
  /** The live conversation (when it started, whether its transcript shows in the chat), or null when it ends. */
  onLive?: (live: { since: number; transcript: boolean; threadId?: string } | null) => void
}) {
  const [state, setState] = useState<VState>('starting')
  const [caption, setCaption] = useState('')
  const [update, setUpdate] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** The sound level drives the bars through a CSS variable on this element (no re-render per frame). */
  const waveRef = useRef<HTMLSpanElement | null>(null)
  const [muted, setMuted] = useState(false)
  const [transcript, setTranscript] = useState(false)
  const [panel, setPanel] = useState(false)
  const [opts, setOpts] = useState<VoiceBarOptions | null>(null)
  const [tasks, setTasks] = useState<VoiceTask[]>([])
  const [pending, setPending] = useState<PendingRequest[]>([])
  const since = useRef(Date.now() - 1000)
  const voiceId = useRef<string | null>(threadId)
  const watched = useRef(new Set<string>())
  const mic = useRef<Mic | null>(null)
  const speaker = useRef<Speaker | null>(null)
  const live = useRef(onLive)
  live.current = onLive

  useEffect(() => {
    let alive = true
    speaker.current = new Speaker()
    const off = api.voice.onEvent((e: VoiceUiEvent) => {
      if (e.type === 'state') setState(e.state as VState)
      else if (e.type === 'transcript') { setCaption(`“${e.text}”`); setUpdate(false) }
      else if (e.type === 'reply') setCaption((c) => (c.startsWith('“') ? '' : c) + e.text)
      else if (e.type === 'announce') { setUpdate(true); setCaption(e.text) }
      else if (e.type === 'tasks') setTasks(e.tasks)
      else if (e.type === 'audio') speaker.current?.play(e.audio, e.rate)
      else if (e.type === 'stop-audio') speaker.current?.stop()
      else if (e.type === 'error') setError(e.message)
    })
    void api.voice.options?.().then((o) => { if (alive) setOpts(o) }).catch(() => undefined)
    void (async () => {
      try {
        if (await api.voice.openNative()) { if (alive) onClose(); return }
        if (!alive) return
        const id = await api.voice.start(threadId, space?.id ?? '')
        // Hung up while it was getting ready: end it in main too (no conversation left running unseen).
        if (!alive) { void api.voice.stop(); return }
        voiceId.current = id
        onThread(id)
        live.current?.({ since: since.current, transcript: false, threadId: id })
        void api.voice.tasks?.().then((t) => { if (alive) setTasks(t) }).catch(() => undefined)
        mic.current = new Mic()
        const input = mic.current
        await input.start()
        if (!alive) input.stop()
      } catch (e) {
        if (!alive) return
        mic.current?.stop()
        void api.voice.stop()
        setError(clean(e))
      }
    })()
    // Smooth, frame-synced level: rises quickly, falls gently (no jitter), written straight to a CSS variable.
    let smooth = 0, frame = 0
    const tick = (): void => {
      const raw = Math.min(1, Math.max(mic.current?.level ?? 0, speaker.current?.level ?? 0) * 1.6)
      smooth += (raw - smooth) * (raw > smooth ? 0.35 : 0.12)
      waveRef.current?.style.setProperty('--lvl', smooth.toFixed(3))
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => {
      alive = false
      cancelAnimationFrame(frame)
      off()
      mic.current?.stop()
      speaker.current?.close()
      void api.voice.stop()
      live.current?.(null)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Questions and approvals from this conversation and the work it started: tap to answer (never by voice).
  useEffect(() => {
    watched.current = new Set([voiceId.current, ...tasks.map((t) => t.threadId)].filter((x): x is string => !!x))
    for (const t of watched.current) void api.chat.pending(t).then((list: PendingRequest[]) => setPending((cur) => [...cur.filter((p) => p.threadId !== t), ...list])).catch(() => undefined)
  }, [tasks])
  useEffect(() => api.chat.onEvent((e: ChatEvent) => {
    if (!watched.current.has(e.threadId)) return
    if (e.type === 'pending') setPending((cur) => [...cur.filter((p) => p.id !== e.request.id), e.request])
    else if (e.type === 'resolved') setPending((cur) => cur.filter((p) => p.id !== e.id))
  }), [])

  useEffect(() => {
    // preventDefault: this Esc is spent hanging up (the chat's run and the details panel leave it alone).
    const k = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      if (panel) setPanel(false)
      else onClose()
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose, panel])

  const toggleMute = (): void => {
    const m = !muted
    setMuted(m)
    if (mic.current) mic.current.muted = m
    // Muted mid-sentence: a moment of silence ends what was being heard (the bot can still speak up).
    if (m) for (let i = 0; i < 40; i++) api.voice.frame(new Float32Array(512))
  }
  const toggleTranscript = (): void => {
    const v = !transcript
    setTranscript(v)
    onLive?.({ since: since.current, transcript: v, threadId: voiceId.current ?? undefined })
  }
  const style = (patch: { voice?: string; speed?: number; language?: string; provider?: 'openai' | 'xai' }): void => {
    void api.voice.setStyle?.(patch).then(setOpts).catch((e) => setError(clean(e)))
  }

  const name = space?.name ?? 'SahilBot'
  const status = error ? friendly(error) : (caption && (update || state === 'speaking' || state === 'thinking') ? caption : LABEL[state])
  return (
    <div className="voice-bar-wrap" data-testid="voice-mode" data-state={state}>
      <div className={`voice-bar${panel ? ' open' : ''}${error ? ' err' : ''}`}>
        <div className="vb-row">
          <span className={`vb-avatar ${state}`} aria-hidden="true">{space && !space.isMain ? <SpaceAvatar color={space.color} shape={space.shape} size={34} /> : <Mascot size={34} />}</span>
          <span className="vb-text">
            <b className="vb-name">{name}</b>
            <span key={status} className={`vb-status${error ? ' err' : ''}`} data-testid={error ? 'voice-caption' : update ? 'voice-announce' : 'voice-caption'} aria-live="polite">{status}</span>
          </span>
          {!error && <span ref={waveRef} className={`vb-wave ${state}`} aria-hidden="true">{[0.55, 0.85, 1, 0.8, 0.5].map((f, i) => <span key={i} className="vb-bar" style={{ ['--f' as never]: f, ['--i' as never]: i }} />)}</span>}
          {error && <button className="btn small primary vb-fix" onClick={() => { onClose(); window.dispatchEvent(new CustomEvent('sahilbot:open-settings', { detail: /microphone|permission/i.test(error) ? 'privacy' : 'models' })) }}>Set up voice</button>}
          <button className={`vb-btn${panel ? ' on' : ''}`} onClick={() => setPanel((p) => !p)} title="Voice options and transcript" aria-label="Voice options" aria-expanded={panel} data-testid="voice-settings"><I.More size={18} /></button>
          {!error && <button className={`vb-btn${muted ? ' on muted' : ''}`} onClick={toggleMute} title={muted ? 'Unmute' : 'Mute'} aria-label={muted ? 'Unmute microphone' : 'Mute microphone'} aria-pressed={muted} data-testid="voice-mute"><I.Mic size={18} /></button>}
          <button className="vb-end" onClick={onClose} title="End voice chat (Esc)" aria-label="End voice chat" data-testid="voice-end"><I.HangUp size={19} /></button>
        </div>
        {panel && (
          <div className="vb-panel" data-testid="voice-panel">
            <label className="vb-toggle"><span>Show what's said in the chat</span>
              <button className={`vb-switch${transcript ? ' on' : ''}`} onClick={toggleTranscript} role="switch" aria-checked={transcript} aria-pressed={transcript} aria-label={transcript ? 'Hide transcript' : 'Show transcript'} data-testid="voice-transcript"><span /></button>
            </label>
            <div className="vb-providers" role="radiogroup" aria-label="Whose voice">
              {(opts?.providers ?? []).map((p) => (
                <button key={p.id} role="radio" aria-checked={opts?.provider === p.id} className={`vb-provider${opts?.provider === p.id ? ' on' : ''}`} disabled={!p.ready}
                  title={p.ready ? `${p.label}'s voice` : `Add your ${p.id === 'openai' ? 'OpenAI' : 'xAI'} key in Settings → Models & Keys`}
                  onClick={() => style({ provider: p.id })} data-testid={`voice-provider-${p.id}`}>{p.label}</button>
              ))}
            </div>
            <label className="vb-speed">
              <span>Speed</span>
              <input type="range" min={0.5} max={2} step={0.05} value={opts?.speed ?? 1} disabled={!opts?.speedOk}
                onChange={(e) => setOpts((o) => (o ? { ...o, speed: Number(e.target.value) } : o))}
                onPointerUp={(e) => style({ speed: Number((e.target as HTMLInputElement).value) })}
                onKeyUp={(e) => style({ speed: Number((e.target as HTMLInputElement).value) })}
                aria-label="Speaking speed" data-testid="voice-speed" />
              <span className="vb-speed-val">{(opts?.speed ?? 1).toFixed(1)}x</span>
            </label>
            {opts && !opts.speedOk && <div className="vb-note">{opts.engineLabel} speaks at one speed.</div>}
            <div className="vb-voices" role="radiogroup" aria-label="Voice">
              {(opts?.voices ?? []).map((v) => (
                <div key={v.id} className={`vb-voice${opts?.voice === v.id ? ' on' : ''}`} role="radio" aria-checked={opts?.voice === v.id} tabIndex={0}
                  onClick={() => style({ voice: v.id })} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); style({ voice: v.id }) } }} data-testid={`voice-voice-${v.id}`}>
                  <b>{v.label}</b><small>{v.desc}</small>
                  <button className="vb-play" onClick={(e) => { e.stopPropagation(); void api.voice.preview?.(v.id).catch((err) => setError(clean(err))) }} aria-label={`Hear ${v.label}`} title={`Hear ${v.label}`}><I.Play size={14} /></button>
                </div>
              ))}
            </div>
            <label className="vb-lang">
              <span>Language</span>
              <select value={opts?.language ?? 'auto'} onChange={(e) => style({ language: e.target.value })} data-testid="voice-language">
                {(opts?.languages ?? [{ id: 'auto', label: 'Auto-detect' }]).map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
              </select>
            </label>
          </div>
        )}
      </div>
      {/* Background work's questions and approvals; this chat's own already show in the chat below. */}
      {pending.some((p) => p.threadId !== (voiceId.current ?? threadId)) && (
        <div className="voice-cards" data-testid="voice-cards">
          {pending.filter((p) => p.threadId !== (voiceId.current ?? threadId)).map((p) => <PendingCard key={p.id} req={p} onRespond={(id, answer) => api.chat.respond(p.threadId, id, answer)} />)}
        </div>
      )}
      {!panel && tasks.length > 0 && (
        <div className="voice-tasks" data-testid="voice-tasks">
          {tasks.map((t) => (
            <div key={t.threadId} className={`voice-task ${t.status}`} data-testid="voice-task" data-status={t.status} title={t.summary}>
              <span className="voice-task-dot" />
              <b>{t.title}</b>
              <span>{t.bot} · {TASK_STATE[t.status]}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
