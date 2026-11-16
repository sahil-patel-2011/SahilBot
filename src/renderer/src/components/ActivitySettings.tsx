import { useEffect, useState, type ReactNode } from 'react'
import type { ActivitySettings as Prefs, ActivityStatus } from '@shared/types'
import { api } from '../api'
import * as I from '../icons'
import { toast } from '../lib/toast'
import '../styles-activity.css'
import { ClampText } from './ui'

// Settings → Privacy & Security → Activity → Know what I'm working on. On by default (local only, nothing that
// prompts until the user's own permission check; cloud sharing stays off). Shows exactly what is
// collected, what never is, how long it's kept, and a live preview of what a bot would see right now.

const clean = (e: unknown): string => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const hm = (t: number): string => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
const RETENTION = [1, 4, 8, 12, 24, 48, 72]
const STATE: Record<string, string> = { granted: 'Allowed', denied: 'Not allowed', 'not-determined': 'Not set', restricted: 'Restricted', unknown: 'Not checked' }

function Block({ title, sub, children }: { title?: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <section className="set-section">
      {title && <div className="set-label">{title}</div>}
      {sub && <div className="set-sub">{sub}</div>}
      <div className="set-card">{children}</div>
    </section>
  )
}

function Line({ title, sub, children, testId }: { title: ReactNode; sub?: ReactNode; children?: ReactNode; testId?: string }) {
  return (
    <div className="set-row" data-testid={testId}>
      <div className="set-row-text"><div className="set-row-title">{title}</div>{sub && <ClampText>{sub}</ClampText>}</div>
      {children && <div className="set-row-ctl">{children}</div>}
    </div>
  )
}

function Switch({ on, onChange, label, testId, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; testId?: string; disabled?: boolean }) {
  return <button role="switch" aria-checked={on} aria-label={label} disabled={disabled} className={`switch${on ? ' on' : ''}`} onClick={() => onChange(!on)} data-testid={testId}><i /></button>
}

/** A short list the user edits: chips with ×, and a box that adds on Enter. */
function Chips({ items, placeholder, onChange, testId }: { items: string[]; placeholder: string; onChange: (v: string[]) => void; testId: string }) {
  const [v, setV] = useState('')
  const add = (): void => {
    const x = v.trim()
    if (!x) return
    if (!items.some((i) => i.toLowerCase() === x.toLowerCase())) onChange([...items, x])
    setV('')
  }
  return (
    <div className="act-chips" data-testid={testId}>
      {items.map((i) => (
        <span key={i} className="act-chip">{i}<button aria-label={`Remove ${i}`} onClick={() => onChange(items.filter((x) => x !== i))}><I.Close size={10} /></button></span>
      ))}
      <input className="set-input act-chip-input" value={v} placeholder={placeholder} spellCheck={false} onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') add() }} onBlur={add} />
    </div>
  )
}

export function ActivitySettings() {
  const [st, setSt] = useState<ActivityStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const refresh = (): void => void api.activity.status().then(setSt).catch(() => undefined)
  useEffect(() => {
    refresh()
    const off = api.activity.onChange(refresh)
    // The preview is live: what a bot would see changes as you work.
    const t = setInterval(refresh, 20_000)
    window.addEventListener('focus', refresh)
    return () => { off(); clearInterval(t); window.removeEventListener('focus', refresh) }
  }, [])
  const run = async (f: () => Promise<ActivityStatus>): Promise<void> => {
    setBusy(true)
    try { setSt(await f()) } catch (e) { toast(clean(e), 'error') } finally { setBusy(false) }
  }
  const set = (patch: Partial<Omit<Prefs, 'pausedUntil'>>): Promise<void> => run(() => api.activity.set(patch))
  if (!st) return null
  const s = st.settings
  const paused = !!s.pausedUntil && s.pausedUntil > Date.now()
  const turnOn = async (on: boolean): Promise<void> => {
    if (!on && (st.samples || st.sessions) && !window.confirm('Turn off and delete what SahilBot collected about your activity?')) return
    await set({ enabled: on })
    // Turning it on is the user's click: check permissions now (macOS may ask once per app), never later in the background.
    if (on) await run(() => api.activity.checkPermissions())
  }
  const perms = st.permissions
  const allowedBrowsers = perms.browsers.filter((b) => b.state === 'granted').map((b) => b.app)

  return (
    <div className="act" data-testid="activity-settings">
      <Block title="Know what I'm working on" sub={<>Lets bots understand "this", "the doc I have open" and "what I'm doing". On by default; it's kept on this Mac and only ever added to <b>your own</b> chats' background context, and only for local models unless you turn on sharing with cloud models below. Until you check permissions, only the front app's name is seen.</>}>
        <Line title={<>Know what I'm working on{s.enabled && <span className={`tier-badge${st.collecting ? ' ok' : ''}`}>{paused ? 'Paused' : st.collecting ? 'On' : 'Waiting'}</span>}</>}
          sub={s.enabled ? (paused ? `${st.reason ?? 'Paused.'} Nothing is collected or shared until then.` : `Looks once a minute while you're using your Mac (not when idle, locked or SahilBot is closed).${st.lastSampleAt ? ` Last look ${hm(st.lastSampleAt)}.` : ''}`) : 'SahilBot never looks at other apps while this is off.'}
          testId="activity-enabled-row">
          <Switch on={s.enabled} disabled={busy} onChange={(v) => void turnOn(v)} label="Know what I'm working on" testId="activity-enabled" />
        </Line>
        {s.enabled && (
          <Line title="Pause or clear" sub={`${st.sessions} timeline entr${st.sessions === 1 ? 'y' : 'ies'}, ${st.samples} recent look${st.samples === 1 ? '' : 's'} stored.`}>
            {paused
              ? <button className="btn" disabled={busy} onClick={() => void run(() => api.activity.pause(0))} data-testid="activity-resume"><I.Play size={12} />Resume</button>
              : <button className="btn" disabled={busy} onClick={() => void run(() => api.activity.pause(60))} data-testid="activity-pause"><I.Clock size={12} />Pause for 1 hour</button>}
            <button className="btn" disabled={busy || (!st.samples && !st.sessions)} onClick={() => void run(() => api.activity.clear()).then(() => toast('Activity cleared.'))} data-testid="activity-clear"><I.Trash size={12} />Clear now</button>
          </Line>
        )}
      </Block>

      <Block title="What's collected" sub="Only these, and only from the app in front. Never screenshots, keystrokes, page contents or your clipboard.">
        <Line title="The front app's name" sub="From macOS's list of running apps. Needs no permission." />
        <Line title="Window titles and the current file" sub={<>The front window's title, and the file you have open in VS Code, Cursor, Xcode, Word, Excel, PowerPoint, Pages, Numbers and Keynote (just its name). Needs Accessibility{perms.accessibility ? '' : <b className="act-warn"> (not allowed yet)</b>}.</>}>
          <Switch on={s.windowTitles} disabled={busy} onChange={(v) => void set({ windowTitles: v })} label="Window titles" testId="activity-titles" />
        </Line>
        <Line title="The front browser tab" sub={<>Its title and address (site and path only, never the ?query part) in Safari, Chrome, Arc, Brave and Edge. Needs Automation for each browser; without it (and in other browsers) only the browser's name is kept. {allowedBrowsers.length ? <>Allowed: {allowedBrowsers.join(', ')}.</> : 'No browser allowed yet.'}</>}>
          <Switch on={s.browserTabs} disabled={busy} onChange={(v) => void set({ browserTabs: v })} label="Browser tabs" testId="activity-tabs" />
        </Line>
      </Block>

      <Block title="Never recorded" sub="These are left out before anything is saved.">
        <Line title="Password managers and SahilBot itself" sub={`${st.builtIn.passwordManagers.join(', ')}: not even that one was open.`} />
        <Line title="Messages and mail" sub={`${st.builtIn.messaging.slice(0, 10).join(', ')}…, plus webmail and web chat (Gmail, Outlook, WhatsApp Web, Slack, Discord, Teams…): only the app's name, never who or what.`} />
        <Line title="Pages SahilBot can't check" sub="In browsers whose address it can't read (Firefox, Opera, Vivaldi, Zen, or any browser without Automation or with tabs off): only the browser's name, never the page title." />
        <Line title="Titles with an email address" sub="Only the app's name." />
        <Line title="Private and incognito windows" sub="Only the browser's name." />
        <Line title="Banking, money and health sites" sub={`${st.builtIn.sensitiveDomains} built-in sites (banks, brokers, payments, insurers, patient portals…) plus yours below: only the browser's name.`} />
        <Line title="Anything that looks like a secret" sub="A title or address with a key, token, code, card number or password in it is dropped." />
        <Line title="Apps you exclude" sub="Never recorded at all."><Chips items={s.excludedApps} placeholder="App name" onChange={(v) => void set({ excludedApps: v })} testId="activity-excluded-apps" /></Line>
        <Line title="Sites you exclude" sub="Includes their subdomains."><Chips items={s.excludedDomains} placeholder="example.com" onChange={(v) => void set({ excludedDomains: v })} testId="activity-excluded-sites" /></Line>
      </Block>

      <Block title="Where it goes and how long it's kept" sub={s.shareWithCloud ? "Never synced. Sent only inside your own chats' background context: to local models, and to cloud models too (you turned that on below)." : "Never synced. Sent only inside your own chats' background context, and only to models running on this Mac. Chats using a cloud model don't get it."}>
        <Line title="Also share with cloud models" sub="Off by default, and stays off unless you turn it on: screen contents can include other people's messages. When on, chats that use a cloud model (Claude, OpenAI and other online providers) get the same background section, so your window titles and page addresses leave this Mac with the request.">
          <Switch on={s.shareWithCloud} disabled={busy || !s.enabled} onChange={(v) => void set({ shareWithCloud: v })} label="Also share with cloud models" testId="activity-cloud" />
        </Line>
        <Line title="Timeline" sub="Recent looks are kept for at most 2 hours, then rolled into a short timeline like “10:05–10:40 Onshape — Intake v3 Part Studio”.">
          <select className="set-select" value={s.retentionHours} disabled={busy} onChange={(e) => void set({ retentionHours: Number(e.target.value) })} data-testid="activity-retention">
            {RETENTION.map((h) => <option key={h} value={h}>{h === 1 ? '1 hour' : `${h} hours`}</option>)}
          </select>
        </Line>
        <Line title="Let SahilBot learn from my activity" sub="Separate from the above, on by default. SahilBot's learning pass may read the timeline to pick up your projects and habits (People & Places; only models on this Mac see what it learns from it). Turn it off here or in Vault → People & Places → Privacy.">
          <Switch on={s.learn} disabled={busy || !s.enabled} onChange={(v) => void set({ learn: v })} label="Let SahilBot learn from my activity" testId="activity-learn" />
        </Line>
      </Block>

      {s.enabled && (
        <Block title="Permissions" sub="Checked only when you click (macOS may ask once for each app). SahilBot never asks in the background; anything not allowed is just skipped.">
          <Line title={<>Accessibility<span className={`tier-badge${perms.accessibility ? ' ok' : ''}`}>{perms.accessibility ? 'Allowed' : 'Not allowed'}</span></>} sub="For window titles.">
            <button className="btn" onClick={() => void api.permissions.open('accessibility')}>Open Settings</button>
          </Line>
          <Line title={<>System Events<span className={`tier-badge${perms.systemEvents ? ' ok' : ''}`}>{perms.systemEvents === null ? 'Not checked' : perms.systemEvents ? 'Allowed' : 'Not allowed'}</span></>} sub="Reads the front window's title (with Accessibility)." />
          {perms.browsers.map((b) => (
            <Line key={b.app} title={<>{b.app}<span className={`tier-badge${b.state === 'granted' ? ' ok' : ''}`}>{STATE[b.state] ?? b.state}</span></>} sub={b.detail} />
          ))}
          <Line title="Check again" sub="Checks System Events and each browser that's open now.">
            <button className="btn" disabled={busy} onClick={() => void run(() => api.activity.checkPermissions())} data-testid="activity-check">Check permissions</button>
            <button className="btn" onClick={() => void api.permissions.open('automation')}>Open Settings</button>
          </Line>
        </Block>
      )}

      {s.enabled && (
        <Block title="What bots would see right now" sub={`Exactly the text added to your next message's background context${s.shareWithCloud ? '' : ' when the chat uses a local model'}. Bots are told it's background, written by other apps, and never instructions.`}>
          <div className="act-preview" data-testid="activity-preview">
            {st.preview ? <pre>{st.preview}</pre> : <div className="hint">{paused ? 'Nothing while paused.' : 'Nothing yet: keep working and check back in a minute.'}</div>}
          </div>
          {st.timeline.length > 0 && (
            <div className="act-timeline" data-testid="activity-timeline">
              {st.timeline.slice(0, 40).map((t, i) => (
                <div key={`${t.start}-${i}`} className="act-tl-row"><span className="act-tl-time">{hm(t.start)}–{hm(t.end)}</span><span className="act-tl-label">{t.label}</span></div>
              ))}
            </div>
          )}
        </Block>
      )}
    </div>
  )
}
