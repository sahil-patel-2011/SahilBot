import type { LocalSettings } from './types'

// Cloud first, local opt-in. Local models (Ollama, LM Studio, a custom server) run only after the user
// says yes (onboarding's "Also use free local models on this Mac?", or Settings → Models → Turn on).
// While local is off nothing installs Ollama, downloads models, warms them up or asks about them.

/**
 * Local models are switched off. Only an explicit false counts: SettingsStore.get() always fills it in
 * for the app, and partial settings objects (older callers, test fixtures) keep the old behaviour.
 */
export function localOff(s: { local?: Partial<LocalSettings> | null } | null | undefined): boolean {
  return s?.local?.enabled === false
}

export const localOn = (s: { local?: Partial<LocalSettings> | null } | null | undefined): boolean => !localOff(s)

/**
 * The local choice for settings saved before it existed. Returns what to save, or null when there is
 * nothing to decide yet:
 * - a saved choice is kept as is;
 * - first run (not onboarded yet): onboarding asks, and until then local stays off;
 * - an existing install: local stays on when local models are already on this Mac (or a custom server
 *   was set up), otherwise it's off and nothing will offer downloads.
 */
export function migrateLocal(stored: { local?: Partial<LocalSettings>; onboarded?: boolean; providers?: { custom?: { enabled?: boolean } } }, hasLocalModels: () => boolean): LocalSettings | null {
  if (typeof stored.local?.enabled === 'boolean') return null
  if (!stored.onboarded) return null
  let found = false
  try { found = hasLocalModels() } catch { found = false }
  return { enabled: found || stored.providers?.custom?.enabled === true, migrated: true }
}
