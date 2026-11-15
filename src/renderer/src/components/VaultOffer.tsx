import { useEffect, useState } from 'react'
import type { Message, VaultSaveEdits, VaultSaveOffer } from '@shared/types'
import { api } from '../api'
import * as I from '../icons'
import { toast } from '../lib/toast'
import '../styles-secure-vault.css'

// "Save to Vault?": a sign-in or card the user typed by hand in the browser panel, or a secret they
// typed into the composer. The values never come to this window: only the site, a masked username,
// brand and last 4. Save asks main to store what it holds (Touch ID or the master password first when
// the vault is locked); nothing is saved without that click.

const clean = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

const ICON: Record<VaultSaveOffer['kind'], typeof I.Key> = { login: I.Key, api_key: I.Key, card: I.Shield, id_number: I.Shield }

export function SaveOfferCard({ offer, messageId, compact, onDone }: { offer: VaultSaveOffer; messageId?: string; compact?: boolean; onDone?: (r: { status: 'saved' | 'dismissed'; name?: string }) => void }) {
  const chat = offer.source === 'chat'
  const needs = new Set(offer.needs ?? [])
  const [name, setName] = useState(offer.name)
  const [site, setSite] = useState(offer.origin ? offer.origin.replace(/^https:\/\//, '') : '')
  const [username, setUsername] = useState(offer.username ?? '')
  const [exp, setExp] = useState(offer.expMonth && offer.expYear ? `${String(offer.expMonth).padStart(2, '0')}/${String(offer.expYear).slice(-2)}` : '')
  const [holder, setHolder] = useState(offer.holder ?? '')
  const [cvc, setCvc] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // Editable details: always for chat (main guessed them); for the browser only what the page didn't give.
  const showName = chat || offer.kind === 'card'
  const showSite = (offer.kind === 'login' || offer.kind === 'api_key') && chat
  const showUser = offer.kind === 'login' && chat
  const showCard = offer.kind === 'card' && (chat || needs.has('expiry') || needs.has('holder'))

  const save = async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    const edits: VaultSaveEdits = {}
    if (showName && name.trim() && name.trim() !== offer.name) edits.name = name.trim()
    if (showSite) edits.site = site.trim()
    if (showUser) edits.username = username.trim()
    if (offer.kind === 'card') {
      const m = /^\s*(\d{1,2})\s*[/-]\s*(\d{2,4})\s*$/.exec(exp)
      if (showCard && !m) { setErr('Enter the expiry as MM/YY.'); setBusy(false); return }
      if (m) { edits.expMonth = m[1]; edits.expYear = m[2] }
      if (showCard) edits.holder = holder.trim()
      if (cvc) edits.rememberCvc = true
    }
    try {
      const r = await api.vault.offerSave(offer.id, edits, messageId)
      toast(`Saved to Vault as “${r.name}”`)
      onDone?.({ status: 'saved', name: r.name })
    } catch (e) {
      setErr(clean(e))
    } finally {
      setBusy(false)
    }
  }
  const notNow = async (): Promise<void> => { try { await api.vault.offerDismiss(offer.id, messageId) } catch { /* gone */ } onDone?.({ status: 'dismissed' }) }
  const never = async (): Promise<void> => { try { await api.vault.offerNever(offer.id) } catch { /* gone */ } onDone?.({ status: 'dismissed' }) }
  const Icon = ICON[offer.kind] ?? I.Key
  const sub = offer.kind === 'login'
    ? [offer.username && !chat ? offer.username : '', offer.update ? 'The saved password for this account is different.' : ''].filter(Boolean).join(' · ')
    : offer.kind === 'card' ? [offer.label, offer.expMonth && offer.expYear ? `expires ${String(offer.expMonth).padStart(2, '0')}/${String(offer.expYear).slice(-2)}` : ''].filter(Boolean).join(' · ')
    : ''
  return (
    <div className={`pending vault-offer${compact ? ' compact' : ''}`} data-testid="vault-offer" data-kind={offer.kind} data-source={offer.source}>
      <div className="pending-title"><Icon size={15} /> <span data-testid="vault-offer-title">{offer.title}</span></div>
      {sub && <div className="hint" data-testid="vault-offer-sub">{sub}</div>}
      {chat && <div className="hint">SahilBot hid it from the model{offer.kind === 'login' || offer.kind === 'api_key' ? '' : ' (it sees [redacted])'}. Saved items are typed into the right site's fields by reference, never shown to the model.</div>}
      {(showName || showSite || showUser || showCard) && (
        <div className="vault-offer-fields">
          {showName && <label>Name<input value={name} onChange={(e) => setName(e.target.value)} data-testid="vault-offer-name" /></label>}
          {showSite && <label>Site<input value={site} placeholder="github.com" onChange={(e) => setSite(e.target.value)} data-testid="vault-offer-site" /></label>}
          {showUser && <label>Username<input value={username} placeholder="optional" onChange={(e) => setUsername(e.target.value)} data-testid="vault-offer-username" /></label>}
          {showCard && <label>Expiry<input value={exp} placeholder="MM/YY" inputMode="numeric" onChange={(e) => setExp(e.target.value.slice(0, 7))} data-testid="vault-offer-exp" /></label>}
          {showCard && <label>Name on card<input value={holder} onChange={(e) => setHolder(e.target.value)} data-testid="vault-offer-holder" /></label>}
        </div>
      )}
      {offer.kind === 'card' && offer.hasCvc && (
        <label className="sv-check"><input type="checkbox" checked={cvc} onChange={(e) => setCvc(e.target.checked)} data-testid="vault-offer-cvc" /> Also remember the security code (off: SahilBot asks you for it at checkout)</label>
      )}
      {err && <div className="hint error" data-testid="vault-offer-error">{err}</div>}
      <div className="pending-actions">
        <button className="btn primary" disabled={busy} onClick={() => void save()} data-testid="vault-offer-save">{busy ? 'Saving…' : offer.update ? 'Update' : 'Save'}</button>
        {!chat && <button className="btn" disabled={busy} onClick={() => void never()} data-testid="vault-offer-never">Never for this site</button>}
        <button className="btn" disabled={busy} onClick={() => void notNow()} data-testid="vault-offer-dismiss">Not now</button>
      </div>
    </div>
  )
}

/** Under a chat message: a card per secret found in it (pending), or what happened to each. */
export function ChatVaultOffers({ m }: { m: Message }) {
  const offers = (Array.isArray(m.meta?.vaultOffers) ? m.meta!.vaultOffers : []) as VaultSaveOffer[]
  const pendingIds = offers.filter((o) => o.status !== 'saved' && o.status !== 'dismissed').map((o) => o.id).join(',')
  const [alive, setAlive] = useState<Set<string> | null>(null)
  const [local, setLocal] = useState<Record<string, { status: 'saved' | 'dismissed'; name?: string }>>({})
  useEffect(() => {
    if (!pendingIds) { setAlive(new Set()); return }
    let off = false
    api.vault.offerAlive(pendingIds.split(',')).then((ids) => { if (!off) setAlive(new Set(ids)) }).catch(() => { if (!off) setAlive(new Set()) })
    return () => { off = true }
  }, [pendingIds])
  if (!offers.length) return null
  return (
    <div className="vault-offers" data-testid="vault-offers">
      {offers.map((o) => {
        const st = local[o.id]?.status ?? o.status
        const savedAs = local[o.id]?.name ?? o.savedAs
        if (st === 'saved') return <div key={o.id} className="vault-offer-done" data-testid="vault-offer-saved"><I.Check size={12} /> {o.label} saved to Vault as “{savedAs}”</div>
        if (st === 'dismissed') return null
        if (!alive) return null
        if (!alive.has(o.id)) return <div key={o.id} className="vault-offer-done muted" data-testid="vault-offer-expired"><I.Shield size={12} /> {o.label} hidden from the model (not saved)</div>
        return <SaveOfferCard key={o.id} offer={o} messageId={m.id} onDone={(r) => setLocal((x) => ({ ...x, [o.id]: r }))} />
      })}
    </div>
  )
}
