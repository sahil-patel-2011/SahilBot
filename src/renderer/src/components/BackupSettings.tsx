import { useCallback, useEffect, useState } from 'react'
import type { BackupStatus } from '@shared/types'
import { api } from '../api'
import { toast } from '../lib/toast'
import { SetRow, SetSection } from './ui'

// Settings → Privacy & Security → Backups (main/backup.ts, docs/backups.md): where copies go, the newest one,
// what's in it, and the recovery password that makes the saved API keys restorable on another Mac.

const KIND_LABEL: Record<BackupStatus['folders'][number]['kind'], string> = { main: 'Main copy', mirror: 'Second copy', extra: 'Extra copy' }
const tilde = (p: string): string => p.replace(/^\/(Users|home)\/[^/]+/, '~')
const size = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`)
const when = (t: number): string => {
  const mins = Math.round((Date.now() - t) / 60_000)
  if (mins < 2) return 'just now'
  if (mins < 60) return `${mins} minutes ago`
  const h = Math.round(mins / 60)
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`
  return new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function BackupSettings() {
  const [st, setSt] = useState<BackupStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [pw, setPw] = useState<{ a: string; b: string } | null>(null)
  const [restore, setRestore] = useState<{ pw: string; replace: boolean } | null>(null)
  const refresh = useCallback(async () => { try { setSt(await api.backups.status()) } catch { /* not available */ } }, [])
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    if (!st?.running) return
    const t = setInterval(() => void refresh(), 1500)
    return () => clearInterval(t)
  }, [st?.running, refresh])
  if (!st) return null

  const run = async (fn: () => Promise<void>): Promise<void> => { setBusy(true); try { await fn() } finally { setBusy(false); await refresh() } }

  return (
    <div data-testid="backup-settings">
      <SetSection title="Backups" sub="Every day SahilBot copies everything to two folders on this Mac, separate from where it runs: chats, settings, memories, your decisions, your knowledge vault notes, and your API keys (encrypted).">
        <SetRow title="Last backup" testId="backup-last"
          sub={st.running ? 'Backing up now…' : st.last ? `${when(st.last.at)} · ${size(st.last.bytes)} · ${st.last.includes.join(', ')}` : 'No backup yet.'}>
          {st.last && <button className="btn" onClick={() => void api.backups.open(st.last!.path)}>Show</button>}
          <button className="btn primary" disabled={busy || st.running} data-testid="backup-now"
            onClick={() => void run(async () => { const r = await api.backups.now(); r.ok ? toast('Backed up.', 'ok') : toast(r.error ?? 'The backup failed.', 'error') })}>
            {st.running ? 'Backing up…' : 'Back up now'}
          </button>
        </SetRow>
        {(st.error || st.note) && <SetRow title={st.error ? 'The last backup had a problem' : 'Note'} sub={st.error ?? st.note} />}
        {st.folders.map((f) => (
          <SetRow key={f.kind} title={KIND_LABEL[f.kind]} sub={tilde(f.path)} testId={`backup-folder-${f.kind}`}>
            <button className="btn" onClick={() => void api.backups.open(f.path)}>Open</button>
            {f.kind === 'extra' && <button className="btn" disabled={busy} onClick={() => void run(async () => { await api.backups.clearExtraFolder() })}>Remove</button>}
          </SetRow>
        ))}
        {!st.folders.some((f) => f.kind === 'extra') && (
          <SetRow title="Extra copy" sub="Also copy every backup to a folder you pick, like an external drive.">
            <button className="btn" disabled={busy} data-testid="backup-extra"
              onClick={() => void run(async () => { const r = await api.backups.chooseExtraFolder(); if (!r.ok && r.error) toast(r.error, 'error') })}>Choose folder…</button>
          </SetRow>
        )}
      </SetSection>

      <SetSection title="API keys" sub={st.recoveryPassword
        ? 'Each backup includes your keys encrypted with your recovery password, so you can restore them on any Mac.'
        : 'Your keys are encrypted with this Mac\'s Keychain. Set a recovery password so a backup can restore them on another Mac too.'}>
        <SetRow title="Recovery password" testId="backup-recovery"
          sub={st.recoveryPassword ? 'Set. SahilBot keeps only a key made from it, never the password. If you forget it, set a new one.' : 'Not set. At least 10 characters; a few random words work well.'}>
          {st.recoveryPassword && <button className="btn" disabled={busy} onClick={() => void run(async () => { if (confirm('Stop adding a password-protected copy of your keys to backups? Earlier backups keep theirs.')) await api.backups.clearRecovery() })}>Turn off</button>}
          <button className="btn" disabled={busy} data-testid="backup-set-recovery" onClick={() => setPw({ a: '', b: '' })}>{st.recoveryPassword ? 'Change…' : 'Set…'}</button>
        </SetRow>
        {pw && (
          <div className="set-row" data-testid="backup-recovery-form">
            <input className="set-input" type="password" autoComplete="new-password" placeholder="Recovery password" value={pw.a} onChange={(e) => setPw({ ...pw, a: e.target.value })} data-testid="backup-recovery-pw" />
            <input className="set-input" type="password" autoComplete="new-password" placeholder="Type it again" value={pw.b} onChange={(e) => setPw({ ...pw, b: e.target.value })} data-testid="backup-recovery-pw2" />
            <button className="btn" onClick={() => setPw(null)}>Cancel</button>
            <button className="btn primary" disabled={busy || pw.a.length < 10 || pw.a !== pw.b} data-testid="backup-recovery-save"
              onClick={() => { const a = pw.a; setPw(null); void run(async () => { const r = await api.backups.setRecoveryPassword(a); r.ok ? toast('Recovery password set. Backing up your keys now.', 'ok') : toast(r.error ?? 'Couldn\'t set it.', 'error') }) }}>Save</button>
          </div>
        )}
        <SetRow title="Restore keys from a backup" sub="Pick a keys.sbrecovery file from a backup folder and type its recovery password. Keys you already have here are kept unless you choose to replace them.">
          <button className="btn" disabled={busy} data-testid="backup-restore" onClick={() => setRestore({ pw: '', replace: false })}>Restore…</button>
        </SetRow>
        {restore && (
          <div className="set-row" data-testid="backup-restore-form">
            <input className="set-input" type="password" autoComplete="off" placeholder="Recovery password" value={restore.pw} onChange={(e) => setRestore({ ...restore, pw: e.target.value })} />
            <label className="backup-check" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}><input type="checkbox" checked={restore.replace} onChange={(e) => setRestore({ ...restore, replace: e.target.checked })} /> Replace keys I already have</label>
            <button className="btn" onClick={() => setRestore(null)}>Cancel</button>
            <button className="btn primary" disabled={busy || !restore.pw}
              onClick={() => {
                const r0 = restore; setRestore(null)
                void run(async () => {
                  const r = await api.backups.restoreKeys(r0.pw, r0.replace)
                  if (r.canceled) return
                  if (!r.ok) toast(r.error ?? 'Couldn\'t restore the keys.', 'error')
                  else toast(`Restored ${r.restored} key${r.restored === 1 ? '' : 's'}${r.kept ? ` (kept ${r.kept} you already had)` : ''}.`, 'ok')
                })
              }}>Choose file…</button>
          </div>
        )}
        <SetRow title="Saved passwords and cards" sub="Not in the key recovery file: they stay tied to this Mac. Make their own encrypted backup under Passwords → Backup." />
      </SetSection>
    </div>
  )
}
