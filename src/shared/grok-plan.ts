export const GROK_PLAN_MODEL = 'grok-plan/grok-build'
export const GROK_PLAN_URL = 'grok-plan://subscription'
export const GROK_INSTALL_GUIDE = 'https://docs.x.ai/build/overview'
export const isGrokPlanModel = (model: string): boolean => model.startsWith('grok-plan/')

export interface GrokPlanStatus {
  enabled: boolean
  preferSubscriptions: boolean
  installed: boolean
  connected: boolean
  limited?: boolean
  error?: string
}

export interface GrokPlanApi {
  status(refresh?: boolean): Promise<GrokPlanStatus>
  configure(patch: { enabled?: boolean; preferSubscriptions?: boolean }): Promise<GrokPlanStatus>
  signIn(): Promise<void>
  /** Opens Terminal: xAI's official installer (when Grok Build isn't here), then Grok Build's sign-in. */
  installInTerminal(): Promise<{ ok: boolean; error?: string }>
  /** Sends one real message through the subscription (setup's last check). */
  testChat(): Promise<{ ok: boolean; reply?: string; error?: string }>
  openInstallGuide(): Promise<void>
}
