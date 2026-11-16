import { lazy, Suspense, type ComponentType, type ReactNode } from 'react'

/**
 * Code splitting: surfaces nobody needs for the first paint (Settings, Connect Apps, the docs editor,
 * onboarding, voice, routines, the bot editor and details panel) load from their own chunks, so the
 * main chunk is just the shell (sidebar, home, composer, thread). Every chunk is fetched in the
 * background once the window is idle (preloadSurfaces), so the first click on Settings opens it as fast
 * as before: the Suspense fallback is only ever seen on a cold, very busy start.
 */

const loaders = {
  settings: () => import('./components/SettingsModal'),
  connect: () => import('./components/ConnectApps'),
  doc: () => import('./components/DocEditor'),
  onboarding: () => import('./components/Onboarding'),
  voice: () => import('./components/VoiceMode'),
  scheduled: () => import('./components/Scheduled'),
  botEditor: () => import('./components/BotEditor'),
  botDetails: () => import('./components/BotDetails'),
  watchlist: () => import('./components/Watchlist')
}

/** A named export as a lazy component (React.lazy wants a default export). */
function named<M, K extends keyof M>(load: () => Promise<M>, key: K): M[K] {
  return lazy(async () => ({ default: (await load())[key] as unknown as ComponentType<unknown> })) as unknown as M[K]
}

export const SettingsModal = named(loaders.settings, 'SettingsModal')
export const ConnectApps = named(loaders.connect, 'ConnectApps')
export const GoogleSetup = named(loaders.connect, 'GoogleSetup')
export const ApiKeyPanel = named(loaders.connect, 'ApiKeyPanel')
export const AppSetup = named(loaders.connect, 'AppSetup')
export const DocPane = named(loaders.doc, 'DocPane')
export const Onboarding = named(loaders.onboarding, 'Onboarding')
export const VoiceMode = named(loaders.voice, 'VoiceMode')
export const Scheduled = named(loaders.scheduled, 'Scheduled')
export const BotEditor = named(loaders.botEditor, 'BotEditor')
export const BotDetails = named(loaders.botDetails, 'BotDetails')
export const Watchlist = named(loaders.watchlist, 'Watchlist')

let preloaded = false
/** Warms every split chunk once the app has painted and the main thread is idle. */
export function preloadSurfaces(): void {
  if (preloaded) return
  preloaded = true
  const idle = (fn: () => void): void => {
    if ('requestIdleCallback' in window) window.requestIdleCallback(fn, { timeout: 3000 })
    else setTimeout(fn, 1200)
  }
  idle(() => { for (const load of Object.values(loaders)) void load().catch(() => undefined) })
}

/** Placeholder shapes while a split chunk loads: a side panel or a centred sheet, never a spinner. */
export function PaneSkeleton({ kind = 'panel' }: { kind?: 'panel' | 'sheet' | 'inline' }): ReactNode {
  return (
    <div className={`lazy-skel lazy-${kind}`} aria-busy="true" aria-label="Loading" data-testid="lazy-skeleton">
      <i className="sk-line w60" /><i className="sk-line w90" /><i className="sk-line w75" /><i className="sk-block" />
    </div>
  )
}

/** Suspense with the skeleton above (or nothing, for overlays that would only flash). */
export function Lazy({ children, fallback = 'none' }: { children: ReactNode; fallback?: 'none' | 'panel' | 'sheet' | 'inline' }): ReactNode {
  return <Suspense fallback={fallback === 'none' ? null : <PaneSkeleton kind={fallback} />}>{children}</Suspense>
}
