import { useEffect, useState } from 'react'
import type { UpdateStatus } from '@shared/types'
import { api, isServerRuntime } from '../api'
import * as I from '../icons'
import { toast } from '../lib/toast'

/**
 * The sidebar's "Update SahilBot" button, shown once a newer version is downloaded and checked. One click
 * backs up your data, quits, swaps in the new app and reopens it (main/updater.ts); nothing is deleted.
 */
export function UpdateButton({ busy = 0 }: { busy?: number }) {
  const [st, setSt] = useState<UpdateStatus | null>(null)
  useEffect(() => {
    if (isServerRuntime || !api.update) return
    void api.update.status().then(setSt).catch(() => undefined)
    return api.update.onStatus((s) => {
      setSt(s)
      if (s.state === 'error' && s.detail && s.version) toast(s.detail, 'error')
    })
  }, [])
  // Shown as soon as a new build is found: downloading (with progress), then ready to install.
  if (st?.state === 'downloading') return (
    <button className="sb-update" disabled data-testid="sidebar-update-downloading" title={`Downloading ${st.version ?? 'the new version'}. The Update button appears when it's ready.`}>
      <span className="spin" /><span>Downloading update</span><span className="sb-update-v">{Math.round(st.progress ?? 0)}%</span>
    </button>
  )
  if (!st || (st.state !== 'ready' && st.state !== 'installing')) return null
  const installing = st.state === 'installing'
  return (
    <button className="sb-update" disabled={installing} data-testid="sidebar-update"
      title={`${st.version ?? 'A new version'} is ready. Your chats, bots, connected apps and settings stay, and a copy of your data is saved first.`}
      onClick={() => {
        if (busy && !confirm(`${busy === 1 ? 'A chat is' : `${busy} chats are`} still working. Updating restarts SahilBot and stops ${busy === 1 ? 'it' : 'them'} (you can continue them afterwards). Update now?`)) return
        void api.update.install().then((next) => {
          setSt(next)
          if (next.state !== 'installing' && next.detail) toast(next.detail, 'error')
        }).catch((e: Error) => toast(e.message, 'error'))
      }}>
      {installing ? <span className="spin" /> : <I.Down size={15} />}
      <span>{installing ? 'Updating…' : 'Update SahilBot'}</span>
      {!installing && st.version && <span className="sb-update-v">{st.version.replace(/ \(build (\d+)\)/, ' · $1')}</span>}
    </button>
  )
}
