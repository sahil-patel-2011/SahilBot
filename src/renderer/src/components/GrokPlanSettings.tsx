import { useEffect, useState } from 'react'
import type { GrokPlanStatus } from '@shared/grok-plan'
import { api } from '../api'
import { toast } from '../lib/toast'
import { Toggle } from './Toggle'
import { SubscriptionTestChat, usePollWhile } from './SubscriptionTest'

/** embedded: inside first-run setup, whose own row already names the subscription (no repeated heading); sends the test chat on its own. */
export function GrokPlanSettings({ onRefresh, embedded }: { onRefresh?: () => void; embedded?: boolean }) {
  const [status, setStatus] = useState<GrokPlanStatus | null>(null)
  const [busy, setBusy] = useState(false)
  // Terminal is installing Grok Build and signing in: check until it's connected.
  const [waiting, setWaiting] = useState(false)
  useEffect(() => {
    let mounted = true
    void api.grokPlan.status().then((value) => { if (mounted) setStatus(value) }).catch(() => undefined)
    return () => { mounted = false }
  }, [])
  useEffect(() => { if (status?.connected) setWaiting(false) }, [status?.connected])
  // Checked again on its own whenever you come back to SahilBot (after signing in in Terminal or the browser).
  useEffect(() => { const f = (): void => { void api.grokPlan.status(true).then(setStatus).catch(() => undefined) }; window.addEventListener('focus', f); return () => window.removeEventListener('focus', f) }, [])
  usePollWhile(waiting, () => { void api.grokPlan.status(true).then((value) => { setStatus(value); if (value.connected) onRefresh?.() }).catch(() => undefined) })

  const run = async (action: () => Promise<GrokPlanStatus | void>): Promise<void> => {
    setBusy(true)
    try {
      const next = await action()
      if (next) { setStatus(next); onRefresh?.() }
    } catch (error) {
      toast((error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error')
    } finally { setBusy(false) }
  }
  const install = (): Promise<void> => run(async () => {
    const opened = await api.grokPlan.installInTerminal()
    if (!opened.ok) throw new Error(opened.error ?? 'Couldn\'t open Terminal.')
    setWaiting(true)
  })
  const label = !status ? 'Checking…'
    : status.connected ? 'Connected'
    : waiting ? 'Finish the install and sign-in in Terminal. SahilBot checks again on its own…'
    : !status.installed ? 'Grok Build isn\'t installed on this Mac'
    : status.error ?? 'Off'
  return (
    <section className="set-section" data-setting="grok-plan" data-testid="grok-plan">
      {!embedded && <>
        <div className="set-label">Grok subscription</div>
        <div className="set-sub">Connect your Grok account through the official Grok Build CLI. The xAI API key has its own switch.</div>
      </>}
      <div className="set-card">
        <div className="set-row">
          <div className="set-row-text">
            <div className="set-row-title">Use Grok subscription</div>
            <div className="set-row-sub" data-testid="grok-plan-status" role="status">{label}</div>
          </div>
          <div className="set-row-ctl">
            {status?.installed === false && <>
              <button className="btn primary" disabled={busy} onClick={() => void install()} data-testid="grok-plan-install" title="Opens Terminal and runs xAI's official installer, then Grok Build's sign-in">Install in Terminal</button>
            </>}
            {status?.installed && !status.connected && !status.limited && <button className="btn" disabled={busy} onClick={() => void run(async () => {
              await api.grokPlan.signIn()
              setWaiting(true)
              return api.grokPlan.configure({ enabled: true })
            })} data-testid="grok-plan-sign-in">Sign in</button>}
            {status?.installed && <Toggle on={status.enabled} disabled={busy} label="Use Grok subscription" testId="grok-plan-on" onChange={(enabled) => void run(() => api.grokPlan.configure({ enabled }))} />}
          </div>
        </div>
        {status?.connected && <SubscriptionTestChat run={() => api.grokPlan.testChat()} auto={embedded} testId="grok-plan-test" />}
        {status?.enabled && !embedded && <div className="set-row">
          <div className="set-row-text">
            <div className="set-row-title">Use subscriptions first</div>
            <div className="set-row-sub">Auto prefers connected plans that fit the task. API fallback follows your spending limit.</div>
          </div>
          <div className="set-row-ctl"><Toggle on={status.preferSubscriptions} disabled={busy} label="Use subscriptions first" testId="grok-plan-prefer" onChange={(preferSubscriptions) => void run(() => api.grokPlan.configure({ preferSubscriptions }))} /></div>
        </div>}
      </div>
    </section>
  )
}
