import { useEffect, useState } from 'react'
import type { GrokPlanStatus } from '@shared/grok-plan'
import { api } from '../api'
import { toast } from '../lib/toast'
import { Toggle } from './Toggle'

export function GrokPlanSettings({ onRefresh }: { onRefresh: () => void }) {
  const [status, setStatus] = useState<GrokPlanStatus | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let mounted = true
    void api.grokPlan.status().then((value) => { if (mounted) setStatus(value) }).catch(() => undefined)
    return () => { mounted = false }
  }, [])

  const run = async (action: () => Promise<GrokPlanStatus | void>): Promise<void> => {
    setBusy(true)
    try {
      const next = await action()
      if (next) { setStatus(next); onRefresh() }
    } catch (error) {
      toast((error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error')
    } finally { setBusy(false) }
  }
  const label = !status ? 'Checking…' : !status.installed ? 'Install Grok Build to connect' : status.connected ? 'Connected' : status.error ?? 'Off'
  return (
    <section className="set-section" data-setting="grok-plan" data-testid="grok-plan">
      <div className="set-label">Grok subscription</div>
      <div className="set-sub">Connect your Grok account through the official Grok Build CLI. The xAI API key has its own switch.</div>
      <div className="set-card">
        <div className="set-row">
          <div className="set-row-text">
            <div className="set-row-title">Use Grok subscription</div>
            <div className="set-row-sub" data-testid="grok-plan-status" role="status">{label}</div>
          </div>
          <div className="set-row-ctl">
            {status?.installed === false && <button className="btn" onClick={() => void run(() => api.grokPlan.openInstallGuide())}>Install guide</button>}
            {status?.installed && !status.connected && !status.limited && <button className="btn" disabled={busy} onClick={() => void run(async () => {
              await api.grokPlan.signIn()
              return api.grokPlan.configure({ enabled: true })
            })}>Sign in</button>}
            <button className="btn" disabled={busy} onClick={() => void run(() => api.grokPlan.status(true))}>Check connection</button>
            {status?.installed && <Toggle on={status.enabled} disabled={busy} label="Use Grok subscription" testId="grok-plan-on" onChange={(enabled) => void run(() => api.grokPlan.configure({ enabled }))} />}
          </div>
        </div>
        {status?.enabled && <div className="set-row">
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
