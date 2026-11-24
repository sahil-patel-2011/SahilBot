import { useEffect, useState, type CSSProperties } from 'react'
import type { BotTemplate, ConnectorConfig, ConnectorPreset, ConnectorStatus, Space } from '@shared/types'
import { STATE_LABELS, withUnread, type BotStatus } from '@shared/bot-status'
import { api } from '../api'
import { SpaceAvatar } from '../brand'
import * as I from '../icons'
import { AppIcon, useAppIcons } from './ConnectedIcons'
import { useBotStatus } from '../lib/bot-status'
import { sourceInfo } from '../lib/function-bots'
import '../styles-function-bots.css'

// Function bots (Accounting, Marketing, Sales, Contracts): templates with group "function", shown first in the
// New bot dialog with their job, the apps they read and what to ask them first. Plus the status bits for bot
// rows and cards (Working / Pulling context / Done / Idle · runs on Claude).

/** Connected apps, kept fresh while the dialog is open. */
function useConnections(): { presets: ConnectorPreset[]; configs: ConnectorConfig[]; statuses: ConnectorStatus[] } {
  const [presets, setPresets] = useState<ConnectorPreset[]>([])
  const [state, setState] = useState<{ configs: ConnectorConfig[]; statuses: ConnectorStatus[] }>({ configs: [], statuses: [] })
  useEffect(() => {
    void api.connectors.presets().then(setPresets).catch(() => undefined)
    const load = (): void => { void api.connectors.list().then((x) => setState({ configs: x.configs, statuses: x.statuses })).catch(() => undefined) }
    load()
    return api.connectors.onChange(load)
  }, [])
  return { presets, ...state }
}

/** The New bot dialog's first group: one card per function bot. */
export function FunctionBots({ templates, adding, onAdd, onConnect }: {
  templates: BotTemplate[]
  adding: string | null
  onAdd: (t: BotTemplate) => void
  /** Opens Connect apps (the dialog closes first). */
  onConnect: () => void
}) {
  const icons = useAppIcons()
  const { presets, configs, statuses } = useConnections()
  if (!templates.length) return null
  return (
    <div className="fb-group" data-testid="function-bots">
      <div className="fb-head"><span className="fb-title">Function bots</span><span className="fb-sub">· wired to your brain</span></div>
      <div className="fb-grid">
        {templates.map((t) => {
          const src = sourceInfo(t.sources ?? [], presets, configs, statuses)
          return (
            <div key={t.id} className="fb-card" style={{ '--fb': t.color } as CSSProperties} data-testid={`function-bot-${t.id}`}>
              <div className="fb-card-top">
                <SpaceAvatar color={t.color} shape={t.shape} size={30} />
                <div className="fb-card-name"><b>{t.name}</b><span>{t.description}</span></div>
              </div>
              <div className="fb-sources" data-testid="function-bot-sources">
                {src.map((s) => (
                  <span key={s.id} className={`fb-source${s.connected ? ' on' : ''}`} title={s.connected ? `${s.name} is connected` : `${s.name} isn't connected yet`} data-testid={`source-${s.id}`}>
                    <AppIcon src={s.preset ? icons[s.id] : undefined} name={s.name} color={s.color} size={16} />
                    <span>{s.name}</span>
                    {s.connected ? <I.Check size={11} /> : <button className="fb-connect" onClick={onConnect} data-testid={`connect-${s.id}`}>Connect</button>}
                  </span>
                ))}
              </div>
              {!!t.starterTasks?.length && (
                <ul className="fb-tasks">
                  {t.starterTasks.slice(0, 3).map((q) => <li key={q}>“{q}”</li>)}
                </ul>
              )}
              <button className="btn fb-add" disabled={!!adding} onClick={() => onAdd(t)} data-testid={`template-${t.id}`}>
                {adding === t.id ? 'Adding…' : <><I.Plus size={13} /> Add {t.name}</>}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Sidebar: a short word under the bot's name while it's doing something (nothing when Idle). */
export function sidebarStatusText(s: BotStatus | undefined, unread: boolean): string | null {
  const st = withUnread(s, unread).state
  // One plain word while it works (no "Pulling context…"): the details are in the bot's chat when you want them.
  return st === 'context' || st === 'working' ? `${STATE_LABELS.working}…` : null
}

/** The bot card's line: a status dot, the state, and the model its last reply ran on. */
export function BotStatusLine({ space, waiting = false }: { space: Space; /** Its run waits on your answer or OK: not "Working…". */ waiting?: boolean }) {
  const map = useBotStatus()
  const s = withUnread(map[space.id], !!space.unread)
  if (waiting) {
    return (
      <div className="bot-status st-need" data-testid={`bot-status-${space.id}`} data-state="need">
        <span className="bs-dot" aria-hidden="true" />
        <span className="bs-state">Waiting for you</span>
      </div>
    )
  }
  return (
    <div className={`bot-status st-${s.state}`} data-testid={`bot-status-${space.id}`} data-state={s.state}>
      <span className="bs-dot" aria-hidden="true" />
      <span className="bs-state">{STATE_LABELS[s.state]}{s.state === 'working' || s.state === 'context' ? '…' : ''}</span>
      {/* No "runs on <model>": the bot picks the best model for each request itself. */}
    </div>
  )
}
