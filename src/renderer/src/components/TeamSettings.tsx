import { useEffect, useState } from 'react'
import { DEFAULT_BRAIN_SCOPE, type BrainScope, type TeamStatus } from '@shared/brain-access'
import type { Space } from '@shared/types'
import { api } from '../api'
import { toast } from '../lib/toast'
import { BrainScopeEditor, scopeLine, useBrainNames } from './BrainScopeEditor'
import '../styles-brain-access.css'

// Settings → General → Phone access → Team: teammates ask your brain instead of asking you. Invite one
// (name, role, what they may ask about), they join with a QR code or link on the same Wi-Fi or tailnet,
// and get a simple Ask page; answers come only from what you shared, with sources. Every question shows
// in Team questions; what the brain can't answer comes to you in Needs you. Remove a teammate any time.

const clean = (e: unknown): string => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const ROLES = ['Sales', 'Ops', 'Assistant', 'Finance', 'Support', 'Marketing']
const when = (t?: number): string => (t ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never')

export function TeamSection() {
  const team = api.team
  const [st, setSt] = useState<TeamStatus | null>(null)
  const [name, setName] = useState('')
  const [role, setRole] = useState('Sales')
  const [scope, setScope] = useState<BrainScope>(DEFAULT_BRAIN_SCOPE)
  const [inviting, setInviting] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [showQs, setShowQs] = useState(8)
  const [bots, setBots] = useState<Array<{ id: string; name: string }>>([])
  const names = useBrainNames()
  const load = (): void => { void team?.status().then(setSt).catch(() => undefined) }
  useEffect(() => {
    if (!team) return
    load()
    void api.spaces.list().then((xs: Space[]) => setBots(xs.filter((x) => x.kind === 'bot' && !x.isMain && !x.hidden).map((x) => ({ id: x.id, name: x.name })))).catch(() => undefined)
    return team.onChanged(load)
  }, [])
  if (!team || !st) return null
  const run = async (fn: () => Promise<TeamStatus>): Promise<void> => {
    try { setSt(await fn()) } catch (e) { toast(clean(e), 'error') }
  }
  const invite = st.invite && st.invite.expires > Date.now() ? st.invite : undefined
  return (
    <section className="set-section team" data-testid="team-section">
      <div className="set-label">Team</div>
      <div className="set-sub">Teammates ask your brain (“What did we promise Partner B?”) instead of asking you. They see only what you share with each of them, read-only, with sources. Questions it can’t answer come to you in Needs you.</div>
      <div className="set-card">
        {!st.available && <div className="set-row"><div className="set-row-text"><div className="set-row-sub" data-testid="team-unavailable">{st.why}</div></div></div>}
        {st.available && !inviting && !invite && (
          <div className="set-row">
            <div className="set-row-text"><div className="set-row-title">Invite a teammate</div><div className="set-row-sub">They join on your Wi-Fi or Tailscale with a one-time code. No account, nothing leaves your Mac.</div></div>
            <div className="set-row-ctl"><button className="btn primary" onClick={() => { setInviting(true); setScope(DEFAULT_BRAIN_SCOPE) }} data-testid="team-invite-open">Invite</button></div>
          </div>
        )}
        {inviting && (
          <div data-testid="team-invite-form">
            <div className="set-row">
              <div className="set-row-text" style={{ flex: 1 }}>
                <div className="team-form">
                  <input className="set-input" placeholder="Name" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} data-testid="team-name" />
                  <input className="set-input" placeholder="Role" maxLength={40} value={role} onChange={(e) => setRole(e.target.value)} data-testid="team-role" />
                </div>
                <div className="team-roles">{ROLES.map((r) => <button key={r} type="button" className={`scope-chip${role === r ? ' on' : ''}`} onClick={() => setRole(r)}>{r}</button>)}</div>
              </div>
            </div>
            <BrainScopeEditor scope={scope} bots={bots} onChange={(p) => setScope({ ...scope, ...p })} testId="team-scope" />
            <div className="set-row">
              <div className="set-row-text"><div className="set-row-sub">{name.trim() || 'They'} will see: {scopeLine(scope, names)}</div></div>
              <div className="set-row-ctl">
                <button className="link-btn" onClick={() => setInviting(false)}>Cancel</button>
                <button className="btn primary" disabled={!name.trim()} onClick={() => void run(async () => { const r = await team.invite({ name: name.trim(), role: role.trim(), scope }); setInviting(false); setName(''); return r })} data-testid="team-invite-send">Create invite</button>
              </div>
            </div>
          </div>
        )}
        {invite && (
          <div className="team-invite" data-testid="team-invite">
            <svg viewBox={`0 0 ${invite.qr.size} ${invite.qr.size}`} role="img" aria-label="QR code with the invite link" shapeRendering="crispEdges"><rect width={invite.qr.size} height={invite.qr.size} fill="#fff" /><path d={invite.qr.d} fill="#000" /></svg>
            <div>
              <div className="set-row-title">Send this to {invite.member.name}</div>
              <div className="set-row-sub">They scan it with their phone’s camera (on your Wi-Fi or Tailscale), or open the link and enter</div>
              <div className="code" data-testid="team-code">{invite.code}</div>
              <div className="url" data-testid="team-url">{invite.url.replace(/#.*/, '')}</div>
              <div className="set-row-sub">Works once, until {new Date(invite.expires).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. Their browser warns about the certificate the first time, like your phone did.</div>
              <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                <button className="btn" onClick={() => { void navigator.clipboard.writeText(invite.url); toast('Link copied') }}>Copy link</button>
              </div>
            </div>
          </div>
        )}
        {st.members.map((m) => (
          <div key={m.id}>
            <div className="set-row" data-testid={`team-member-${m.name}`}>
              <div className="set-row-text">
                <div className="set-row-title">{m.name} <span className="hint">· {m.role}</span>{m.pairedAt ? <span className="conn ok" style={{ marginLeft: 8 }}>Joined</span> : <span className="hint" style={{ marginLeft: 8 }}>Invited</span>}</div>
                <div className="set-row-sub">Sees: {scopeLine(m.scope, names)}<br />{m.questions} {m.questions === 1 ? 'question' : 'questions'} · last seen {when(m.lastSeenAt)}</div>
              </div>
              <div className="set-row-ctl">
                <button className="link-btn" onClick={() => setEditing(editing === m.id ? null : m.id)} data-testid={`team-scope-${m.name}`}>{editing === m.id ? 'Done' : 'What they can see'}</button>
                <button className="link-btn" onClick={() => void run(() => team.reinvite(m.id))}>New code</button>
                <button className="link-btn danger" onClick={() => { if (window.confirm(`Remove ${m.name}? They are signed out at once and can't ask anything more.`)) void run(() => team.revoke(m.id)) }} data-testid={`team-revoke-${m.name}`}>Remove</button>
              </div>
            </div>
            {editing === m.id && <BrainScopeEditor scope={m.scope} bots={bots} onChange={(p) => void run(() => team.setScope(m.id, p))} testId="team-member-scope" />}
          </div>
        ))}
      </div>
      {st.questions.length > 0 && (
        <>
          <div className="set-label" style={{ marginTop: 16 }}>Team questions</div>
          <div className="set-sub">Who asked what, and what they were told. Questions marked “asked you” are waiting in Needs you.</div>
          <div className="set-card" data-testid="team-questions">
            {st.questions.slice(0, showQs).map((q) => (
              <div className="team-q" key={q.id}>
                <div className="team-q-head"><b>{q.member}</b><span>{q.role}</span><span>{when(q.at)}</span>
                  <span className={`team-q-status ${q.status}`}>{q.status === 'answered' ? 'Answered' : q.status === 'routed' ? 'Asked you' : q.status === 'owner' ? 'You answered' : 'Not answered'}</span></div>
                <div className="team-q-text">{q.question}</div>
                <div className="team-q-ans">{q.ownerAnswer ?? q.answer}</div>
                {q.chips.length > 0 && <div className="team-chips">{q.chips.map((c, i) => <span key={i} className="team-chip" title={c.title}>{c.label}</span>)}</div>}
              </div>
            ))}
            {st.questions.length > showQs && <button className="link-btn" style={{ margin: '8px 16px' }} onClick={() => setShowQs(showQs + 20)}>Show more</button>}
          </div>
        </>
      )}
    </section>
  )
}
