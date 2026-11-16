import { useCallback, useEffect, useState } from 'react'
import type { ChatgptPlanStatus } from '@shared/chatgpt-plan'
import { api } from '../api'
import { toast } from '../lib/toast'
import { Toggle } from './Toggle'
import { ClampText } from './ui'

// Settings → Models → "ChatGPT plan (via Codex)": use the user's ChatGPT subscription through their own
// Codex install. Signing in happens in OpenAI's Codex sign-in; SahilBot only asks Codex for its status.

const clean = (e: unknown): string => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

const when = (ms?: number): string => {
  if (!ms) return ''
  const d = new Date(ms)
  const sameDay = d.toDateString() === new Date().toDateString()
  return sameDay ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

/** embedded: inside first-run setup, whose own row already names and explains the plan (no repeated heading). */
export function ChatgptPlanSettings({ onRefresh, embedded }: { onRefresh?: () => void; embedded?: boolean }) {
  const [st, setSt] = useState<ChatgptPlanStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const load = useCallback((refresh = false) => api.chatgptPlan.status(refresh).then(setSt).catch(() => undefined), [])
  useEffect(() => { void load() }, [load])
  useEffect(() => api.chatgptPlan.onChanged(() => { void load() }), [load])
  // While a sign-in waits for the browser, check now and then.
  useEffect(() => {
    if (!st?.signingIn && !(st?.enabled && st.installed && st.login !== 'chatgpt')) return
    const t = setInterval(() => { void load(true) }, 4000)
    return () => clearInterval(t)
  }, [st?.signingIn, st?.enabled, st?.installed, st?.login, load])

  const act = async (name: string, f: () => Promise<unknown>): Promise<void> => {
    setBusy(name)
    try { await f() } catch (e) { toast(clean(e), 'error') } finally { setBusy(null); void load(); onRefresh?.() }
  }

  const status = !st ? 'Checking…'
    : !st.installed ? 'Codex isn\'t installed on this Mac'
    : st.connected ? `Connected${st.planType ? ` · ${st.planType[0].toUpperCase()}${st.planType.slice(1)} plan` : ''}${st.email ? ` · ${st.email}` : ''}`
    : st.signingIn ? 'Waiting for you to finish signing in in the browser…'
    : st.login === 'chatgpt' ? 'Signed in to Codex with ChatGPT · not switched on'
    : st.enabled ? (st.problem ?? 'Not signed in') : 'Off'

  return (
    <section className="set-section" data-testid="chatgpt-plan">
      {!embedded && (
        <>
          <div className="set-label">ChatGPT plan (via Codex)</div>
          <div className="set-sub">
            Your ChatGPT subscription through Codex on this Mac, with no API charges.
          </div>
        </>
      )}
      <div className="set-card">
        <div className="set-row">
          <div className="set-row-text">
            <div className="set-row-title">Status</div>
            <div className="set-row-sub" data-testid="chatgpt-plan-status">
              {status}
              {st?.installed && st.version ? ` · Codex ${st.version}` : ''}
            </div>
            {st?.problem && st.enabled && !st.connected && st.installed && st.login !== 'none' && <div className="set-row-sub ui-text-danger">{st.problem}</div>}
          </div>
          <div className="set-row-ctl" style={{ gap: 6, display: 'flex' }}>
            {!st?.installed && st && <button className="btn" onClick={() => void api.chatgptPlan.openInstallGuide()} data-testid="chatgpt-plan-install">Install guide</button>}
            {st?.installed && !st.connected && (
              <button className="btn primary" disabled={!!busy || st.signingIn} onClick={() => void act('connect', () => api.chatgptPlan.connect({ signIn: st.enabled && st.login !== 'chatgpt' }))} data-testid="chatgpt-plan-connect">
                {busy === 'connect' ? 'Connecting…' : st.login === 'chatgpt' ? 'Connect' : 'Sign in with ChatGPT'}
              </button>
            )}
            {st?.connected && <button className="btn" disabled={!!busy} onClick={() => void act('disconnect', () => api.chatgptPlan.disconnect())} data-testid="chatgpt-plan-disconnect">Turn off</button>}
            <button className="btn" disabled={!!busy} title="Check again" onClick={() => void act('refresh', () => load(true))}>{busy === 'refresh' ? 'Checking…' : 'Check'}</button>
          </div>
        </div>

        {st?.installed && !st.connected && st.login !== 'chatgpt' && (
          <div className="set-row">
            <div className="set-row-text">
              <div className="set-row-title">Sign in in Terminal instead</div>
              <ClampText>Opens Terminal running <code>codex login</code>, OpenAI's own sign-in. Come back here when it says you're logged in.</ClampText>
            </div>
            <div className="set-row-ctl"><button className="btn" onClick={() => void api.chatgptPlan.loginInTerminal().then((r) => { if (!r.ok) toast(r.error ?? 'Couldn\'t open Terminal', 'error') })} data-testid="chatgpt-plan-terminal">Open Terminal</button></div>
          </div>
        )}

        {st?.connected && (
          <>
            <div className="set-row">
              <div className="set-row-text">
                <div className="set-row-title">Use my ChatGPT plan first</div>
                <ClampText>Auto sends GPT work to your plan instead of the pay-per-token OpenAI API while the plan has room. When the plan's limit is reached, Auto uses your other models until it resets.</ClampText>
              </div>
              <div className="set-row-ctl"><Toggle on={st.preferPlan} onChange={(v) => void act('prefer', () => api.chatgptPlan.setPrefs({ preferPlan: v }))} label="Use my ChatGPT plan first" testId="chatgpt-plan-prefer" /></div>
            </div>
            <div className="set-row">
              <div className="set-row-text">
                <div className="set-row-title">Usage</div>
                <div className="set-row-sub" data-testid="chatgpt-plan-usage">
                  {st.limitedUntil ? <span className="ui-text-danger">Limit reached · resets {when(st.limitedUntil)}. </span> : null}
                  {st.limits.length ? st.limits.map((w) => `${w.label}: ${Math.round(w.usedPercent)}% used${w.resetsAt ? ` (resets ${when(w.resetsAt)})` : ''}`).join(' · ') : 'Uses your ChatGPT plan\'s Codex limits. Codex reports them after the first request.'}
                </div>
                {st.limits.map((w) => <div key={w.label} className={`meter${w.usedPercent >= 80 ? ' hot' : ''}`} style={{ width: 160, marginTop: 6 }}><i style={{ width: `${w.usedPercent}%` }} /></div>)}
              </div>
            </div>
            <div className="set-row">
              <div className="set-row-text">
                <div className="set-row-title">Models</div>
                <ClampText>{st.models.map((m) => m.label + (m.isDefault ? ' (Codex default)' : '')).join(', ')}. Pick them in the model menu (they're marked "ChatGPT plan").</ClampText>
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  )
}
