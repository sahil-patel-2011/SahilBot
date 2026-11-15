import { useEffect, useRef, useState } from 'react'
import type { VaultAuthRequest } from '@shared/types'
import { api } from '../api'
import '../styles-secure-vault.css'

/** A padlock (open while unlocking succeeded). */
export function LockGlyph({ open = false, size = 18 }: { open?: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2.5" />
      <path d={open ? 'M8 11V8a4 4 0 0 1 7.6-1.8' : 'M8 11V8a4 4 0 0 1 8 0v3'} />
      <circle cx="12" cy="16" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function FingerprintGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden="true">
      <path d="M6.5 7.5A7 7 0 0 1 19 12v1" /><path d="M5 11a7 7 0 0 0 0 1c0 3 .6 5 1.5 6.5" /><path d="M9 20c-.8-1.6-1.2-3.8-1.2-6.5a4.2 4.2 0 0 1 8.4 0V15" />
      <path d="M12 13.5c0 3 .5 5.2 1.4 7" /><path d="M16.2 18.5c.3-1 .5-2.2.5-3.5" />
    </svg>
  )
}

/**
 * The vault's unlock / confirm dialog. Main asks (a fill, a reveal, an export); this only shows the
 * request and sends back what the user typed. The master password goes straight to main and is
 * cleared from this component as soon as it's sent.
 */
export function VaultAuthDialog() {
  const [queue, setQueue] = useState<VaultAuthRequest[]>([])
  const [pw, setPw] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [wait, setWait] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const req = queue[0]

  useEffect(() => {
    void api.vault.authPending().then((r) => setQueue(r)).catch(() => undefined)
    return api.vault.onAuth((e) => {
      if ('done' in e) setQueue((q) => q.filter((x) => x.id !== e.id))
      else setQueue((q) => (q.some((x) => x.id === e.id) ? q : [...q, e]))
    })
  }, [])
  useEffect(() => { setPw(''); setErr(''); setBusy(false); setWait(0); setTimeout(() => input.current?.focus(), 30) }, [req?.id])
  useEffect(() => {
    if (wait <= 0) return
    const t = setTimeout(() => setWait((w) => Math.max(0, w - 1)), 1000)
    return () => clearTimeout(t)
  }, [wait])

  if (!req) return null
  const send = async (answer: { password?: string; cancel?: boolean; touchId?: boolean }): Promise<void> => {
    setBusy(true)
    setErr('')
    const typed = answer.password
    setPw('')
    try {
      const r = await api.vault.authRespond(req.id, typed !== undefined ? { password: typed } : answer)
      if (r.ok) setQueue((q) => q.filter((x) => x.id !== req.id))
      else {
        setErr(r.error ?? 'That didn\'t work.')
        if (r.retryInMs) setWait(Math.ceil(r.retryInMs / 1000))
        setTimeout(() => input.current?.focus(), 30)
      }
    } catch (e) {
      setErr((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(false)
    }
  }
  const submit = (): void => { if (req.needs === 'password') { if (pw && !wait) void send({ password: pw }) } else void send({}) }

  return (
    <div className="scrim sv-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) void send({ cancel: true }) }}>
      <div className="sv-auth" role="dialog" aria-modal="true" aria-labelledby="sv-auth-title" data-testid="vault-auth" data-kind={req.kind} data-needs={req.needs}
        onKeyDown={(e) => { if (e.key === 'Escape' && !busy) void send({ cancel: true }) }}>
        <div className="sv-auth-icon" aria-hidden="true"><LockGlyph size={26} /></div>
        <h2 id="sv-auth-title">{req.title}</h2>
        <p className="sv-auth-reason" data-testid="vault-auth-reason">SahilBot wants to {req.reason || 'use your vault'}.</p>
        {req.needs === 'password' && (
          <input ref={input} className="sv-auth-input" type="password" autoComplete="off" spellCheck={false} placeholder="Master password" value={pw}
            onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit() }} disabled={busy} data-testid="vault-auth-password" aria-label="Master password" />
        )}
        {req.needs === 'confirm' && <p className="sv-auth-note">This vault is protected by your Mac's Keychain only. Set a master password in Settings → Vault for stronger protection.</p>}
        {(err || wait > 0) && <div className="sv-auth-err" role="alert" data-testid="vault-auth-error">{wait > 0 ? `${err.replace(/ Try again in \d+s\.$/, '')} Try again in ${wait}s.` : err}</div>}
        <div className="sv-auth-actions">
          {req.touchId && <button className="btn sv-touch" disabled={busy} onClick={() => void send({ touchId: true })} data-testid="vault-auth-touchid"><FingerprintGlyph size={16} /> Touch ID</button>}
          <span className="sv-grow" />
          <button className="btn" disabled={busy} onClick={() => void send({ cancel: true })} data-testid="vault-auth-cancel">Cancel</button>
          <button className="btn primary" disabled={busy || (req.needs === 'password' && (!pw || wait > 0))} onClick={submit} data-testid="vault-auth-unlock">{req.kind === 'unlock' ? 'Unlock' : 'Confirm'}</button>
        </div>
        <div className="sv-auth-foot">The assistant never sees what you type here or what's in your vault.</div>
      </div>
    </div>
  )
}
