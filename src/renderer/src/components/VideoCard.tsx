import { useEffect, useRef, useState } from 'react'
import type { Message, ToolCall, VideoCardData } from '@shared/types'
import { api } from '../api'
import { toast } from '../lib/toast'
import * as I from '../icons'
import { Card, CardHead, Pill } from './ui'

// The chat's video card (src/main/agent/tools/video.ts): a render-progress card while HeyGen works (it checks
// its job in main every few seconds), then the finished MP4 playing inline over the app's foreman-file:
// scheme, with its file row (Open, Show in Finder). The same card rides on the "Video ready" note.

/** The card data a message carries (tool result meta.video, or a notice's), or null. */
export function asVideoCard(raw: unknown): VideoCardData | null {
  const d = raw as Partial<VideoCardData> | null
  if (!d || typeof d !== 'object' || typeof d.id !== 'string' || typeof d.title !== 'string' || typeof d.status !== 'string') return null
  return d as VideoCardData
}

/** Video cards from a run's tool results, one per job (the latest wins). */
export function videosFromSteps(steps: Array<{ call: Pick<ToolCall, 'id' | 'name'>; result?: Pick<Message, 'meta'> }>): Array<{ key: string; data: VideoCardData }> {
  const out = new Map<string, { key: string; data: VideoCardData }>()
  for (const s of steps) {
    if (s.call.name !== 'video') continue
    const data = asVideoCard(s.result?.meta?.video)
    if (!data) continue
    out.delete(data.id)
    out.set(data.id, { key: `video-${s.call.id}`, data })
  }
  return [...out.values()]
}

/** A notice's video card ("Video ready · …"). */
export const videoOf = (m: Pick<Message, 'kind' | 'meta'>): VideoCardData | null => (m.kind === 'notice' ? asVideoCard(m.meta?.video) : null)

const KIND: Record<VideoCardData['kind'], string> = { avatar: 'Avatar video', translate: 'Translated video', motion: 'Motion video' }
const active = (s: VideoCardData['status']): boolean => s === 'processing' || s === 'downloading'

const clock = (sec: number): string => {
  const s = Math.max(0, Math.round(sec))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}
const mb = (n?: number): string => (n ? `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB` : '')

/**
 * `progress`: a card on the tool step that started the job. Once the finished video has its own note in the
 * chat (announced), it stays a compact done line there instead of a second player.
 */
export function VideoCard({ data, progress }: { data: VideoCardData; progress?: boolean }) {
  const [v, setV] = useState<VideoCardData>(data)
  const [now, setNow] = useState(() => Date.now())
  const alive = useRef(true)
  useEffect(() => { setV((old) => (old.id === data.id && rank(old) > rank(data) ? old : data)) }, [data])
  useEffect(() => {
    alive.current = true
    if (!active(v.status) && v.status !== 'needs_input') return
    const tick = setInterval(() => setNow(Date.now()), 1000)
    const poll = setInterval(() => {
      void api.video?.get(v.id).then((x) => { if (alive.current && x) setV(x) }).catch(() => undefined)
    }, 4000)
    void api.video?.get(v.id).then((x) => { if (alive.current && x) setV(x) }).catch(() => undefined)
    return () => { alive.current = false; clearInterval(tick); clearInterval(poll) }
  }, [v.id, v.status])

  const name = v.path?.split('/').pop() ?? ''
  const elapsed = (now - v.createdAt) / 1000
  const pct = v.progress ?? (v.etaSec ? Math.min(95, Math.round((elapsed / v.etaSec) * 100)) : undefined)
  const status = v.status === 'ready' ? <Pill tone="ok">Ready</Pill>
    : v.status === 'failed' ? <Pill tone="danger">Failed</Pill>
      : v.status === 'needs_input' ? <Pill tone="warn">Needs your answer</Pill>
        : v.status === 'downloading' ? 'Saving…' : `Rendering · ${clock(elapsed)}`

  return (
    <Card className="video-card" testId="video-card" live={active(v.status)} data-status={v.status} data-video={v.id}>
      <CardHead icon={<I.Video size={15} />} title={v.title} meta={`${KIND[v.kind] ?? 'Video'}${v.aspect ? ` · ${v.aspect}` : ''}${v.credits ? ` · ~${v.credits} credits` : ''}`} status={status} />
      <div className="ui-card-body">
        {active(v.status) && (
          <div className="video-progress" data-testid="video-progress">
            <div className="video-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><i style={{ width: `${pct ?? 8}%` }} /></div>
            <div className="ui-meta">
              {v.status === 'downloading' ? 'Saving the MP4 to your workspace…'
                : `HeyGen is rendering${v.etaSec ? `, usually about ${clock(v.etaSec)}` : ''}. It plays here when it's done; you can keep working.`}
            </div>
          </div>
        )}
        {v.status === 'needs_input' && <div className="ui-meta">HyperFrames asked a question before it can finish. Ask SahilBot to check this video's status.</div>}
        {v.status === 'failed' && <div className="ui-meta ui-text-danger">{v.error ?? 'HeyGen couldn\'t make this video.'}</div>}
        {v.status === 'ready' && v.url && (progress && v.announced ? (
          <div className="video-done ui-meta" data-testid="video-done"><I.Check size={13} /> Saved as {name}. It plays in the note below.</div>
        ) : (
          <>
            <video className="video-player" data-testid="video-player" src={v.url} controls preload="metadata" playsInline />
            <div className="video-file">
              <I.File size={14} />
              <span className="video-file-name" title={v.path}>{name}</span>
              {v.size ? <span className="ui-meta">{mb(v.size)}</span> : null}
              <span className="video-file-actions">
                <button className="btn" onClick={() => void api.files.open(v.path!).catch((e) => toast((e as Error).message, 'error'))}><I.External size={13} /> Open</button>
                <button className="btn" data-testid="video-reveal" onClick={() => void api.files.reveal(v.path!).catch((e) => toast((e as Error).message, 'error'))}><I.Folder size={13} /> Show in Finder</button>
              </span>
            </div>
          </>
        ))}
      </div>
    </Card>
  )
}

/** Later states win over earlier ones (a re-render with the tool result's old data doesn't go back). */
function rank(v: VideoCardData): number {
  return v.status === 'ready' || v.status === 'failed' ? 3 : v.status === 'downloading' ? 2 : 1
}
