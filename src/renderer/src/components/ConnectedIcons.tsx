import { useEffect, useState } from 'react'
import type { ConnectorConfig, ConnectorPreset, ConnectorStatus } from '@shared/types'
import { api } from '../api'
import { letterColor, shortName } from '../lib/connect-catalog'

// App icons come from the main process as data: URLs (fetched once, cached on disk). One shared
// cache for every component; it refreshes when main reports that more icons arrived.
let iconCache: Record<string, string> = {}
let presetCache: ConnectorPreset[] = []
const listeners = new Set<() => void>()
let started = false

function startIcons(): void {
  if (started) return
  started = true
  const refresh = (): void => {
    void api.connectors.icons().then((icons) => { iconCache = icons; listeners.forEach((f) => f()) }).catch(() => undefined)
  }
  refresh()
  api.connectors.onIcons(refresh)
  void api.connectors.presets().then((p) => { presetCache = p; listeners.forEach((f) => f()) }).catch(() => undefined)
}

/** Icons by preset id (data: URLs). Re-renders when new icons arrive. */
export function useAppIcons(): Record<string, string> {
  const [, bump] = useState(0)
  useEffect(() => {
    startIcons()
    const f = (): void => bump((n) => n + 1)
    listeners.add(f)
    return () => { listeners.delete(f) }
  }, [])
  return iconCache
}

/** An app's icon on a rounded plate, or a letter tile in its brand color when there's no icon. */
export function AppIcon({ src, name, color, size = 44 }: { src?: string; name: string; color?: string; size?: number }) {
  const radius = Math.round(size * 0.27)
  if (src) {
    return (
      <span className="ca-icon" style={{ width: size, height: size, borderRadius: radius }}>
        <img src={src} alt="" draggable={false} style={{ width: Math.round(size * 0.66), height: Math.round(size * 0.66) }} />
      </span>
    )
  }
  const bg = color ?? '#7C5CFF'
  return (
    <span className="ca-icon letter" style={{ width: size, height: size, borderRadius: radius, background: bg, color: letterColor(bg), fontSize: Math.round(size * 0.42) }}>
      {shortName(name).charAt(0).toUpperCase()}
    </span>
  )
}

export interface ConnectedApp { id: string; presetId?: string; name: string; color?: string }

/** Connected apps (state "connected"), in the order they were added. */
export function connectedApps(configs: ConnectorConfig[], statuses: ConnectorStatus[], presets: ConnectorPreset[]): ConnectedApp[] {
  return configs
    .filter((c) => statuses.find((s) => s.id === c.id)?.state === 'connected')
    .map((c) => {
      const p = presets.find((x) => x.id === c.preset)
      return { id: c.id, presetId: p?.id, name: c.name, color: p?.color }
    })
}

/** Overlapping stack of icons (used by the header of Connect Apps). */
export function IconStack({ apps, icons, max = 3, size = 18 }: { apps: ConnectedApp[]; icons: Record<string, string>; max?: number; size?: number }) {
  if (!apps.length) return null
  return (
    <span className="connected-icons" data-count={apps.length}>
      {apps.slice(0, max).map((a) => (
        <span className="connected-icon" key={a.id} title={a.name}>
          <AppIcon src={a.presetId ? icons[a.presetId] : undefined} name={a.name} color={a.color} size={size} />
        </span>
      ))}
    </span>
  )
}

/** Up to `max` icons of connected apps, overlapping (for the sidebar's Connect apps pill). Spec: design/bot-ui.md. */
export function ConnectedIcons({ max = 3 }: { max?: number }) {
  const icons = useAppIcons()
  const [state, setState] = useState<{ configs: ConnectorConfig[]; statuses: ConnectorStatus[] }>({ configs: [], statuses: [] })
  useEffect(() => {
    const load = (): void => { void api.connectors.list().then(setState).catch(() => undefined) }
    load()
    return api.connectors.onChange(load)
  }, [])
  const apps = connectedApps(state.configs, state.statuses, presetCache)
  if (!apps.length) return <span className="connected-icons" data-count={0} />
  return <IconStack apps={apps} icons={icons} max={max} />
}
