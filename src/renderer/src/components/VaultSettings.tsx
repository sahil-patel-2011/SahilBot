import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { VaultAuditEntry, VaultItemInput, VaultItemSummary, VaultItemType, VaultReveal, VaultStatus } from '@shared/types'
import { BRAND_NAME, type CardBrand } from '@shared/cards'
import { api } from '../api'
import * as I from '../icons'
import { toast } from '../lib/toast'
import { Toggle } from './Toggle'
import { FingerprintGlyph, LockGlyph } from './VaultAuthDialog'
import '../styles-secure-vault.css'
import { ClampText } from './ui'

// Settings → Privacy & Security → Passwords. Everything here is metadata (names, sites, brand, last 4, expiry) except a Reveal,
// which main sends only after Touch ID or the master password and this page hides again after 20 s.
// Values typed into a form go straight to main and are cleared from the page once saved.

const clean = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

type Tab = 'logins' | 'cards' | 'ids' | 'notes' | 'addresses' | 'security' | 'activity'
const TABS: Array<{ id: Tab; label: string; type?: VaultItemType }> = [
  { id: 'logins', label: 'Logins', type: 'login' },
  { id: 'cards', label: 'Cards', type: 'card' },
  { id: 'ids', label: 'IDs', type: 'identity' },
  { id: 'notes', label: 'Notes', type: 'note' },
  { id: 'addresses', label: 'Addresses', type: 'address' },
  { id: 'security', label: 'Security' },
  { id: 'activity', label: 'Activity' }
]
const NOUN: Record<VaultItemType, string> = { login: 'login', card: 'card', identity: 'ID', note: 'secure note', address: 'address' }
const ID_KINDS = [['passport', 'Passport'], ['driver_license', "Driver's license"], ['national_id', 'National ID'], ['other', 'Other']] as const
const AUTOLOCK = [1, 5, 15, 30, 60, 240, 0]

function Section({ title, sub, children, right }: { title?: string; sub?: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="set-section">
      {(title || right) && <div className="sv-sec-head">{title && <div className="set-label">{title}</div>}{right}</div>}
      {sub && <div className="set-sub">{sub}</div>}
      <div className="set-card">{children}</div>
    </section>
  )
}

function Row({ title, sub, children, testId }: { title: ReactNode; sub?: ReactNode; children?: ReactNode; testId?: string }) {
  return (
    <div className="set-row" data-testid={testId}>
      <div className="set-row-text"><div className="set-row-title">{title}</div>{sub && <ClampText>{sub}</ClampText>}</div>
      {children && <div className="set-row-ctl">{children}</div>}
    </div>
  )
}

/** One-line description of what protects the vault right now. */
function protection(st: VaultStatus): string {
  if (st.masterPassword) return `Keychain + master password${st.bio ? ' (Touch ID can unlock)' : ''}`
  if (st.touchIdAvailable && st.prefs.touchId) return 'Keychain + Touch ID'
  return 'Keychain only'
}

export function SecretVaultSettings({ embedded }: { embedded?: boolean } = {}) {
  const [st, setSt] = useState<VaultStatus | null>(null)
  const [items, setItems] = useState<VaultItemSummary[]>([])
  const [tab, setTab] = useState<Tab>('logins')
  const [busy, setBusy] = useState(false)
  const refresh = useCallback(async () => {
    const [s, i] = await Promise.all([api.vault.status(), api.vault.items()])
    setSt(s)
    setItems(i)
  }, [])
  useEffect(() => {
    void refresh().catch(() => undefined)
    return api.vault.onChanged(() => void refresh().catch(() => undefined))
  }, [refresh])
  const act = async (fn: () => Promise<unknown>, ok?: string): Promise<void> => {
    setBusy(true)
    try { await fn(); await refresh(); if (ok) toast(ok, 'ok') } catch (e) { toast(clean(e), 'error') } finally { setBusy(false) }
  }
  if (!st) return <>{!embedded && <h2>Vault</h2>}<div className="set-sub">Loading…</div></>
  const t = TABS.find((x) => x.id === tab)!
  return (
    <>
      {!embedded && <h2>Vault</h2>}
      <div className="set-sub">{embedded ? 'Passwords, cards and IDs SahilBot types into websites for you without ever seeing them. Encrypted on this Mac.' : 'Passwords, cards, IDs and notes SahilBot can type into a website for you, without the assistant ever seeing them. Encrypted on this Mac; every purchase still waits for your click on a Purchase card.'}</div>

      <div className={`sv-status${st.locked ? ' locked' : ' open'}`} data-testid="vault-status" data-locked={st.locked ? '1' : '0'}>
        <div className="sv-status-icon"><LockGlyph open={!st.locked} size={22} /></div>
        <div className="sv-status-text">
          <div className="sv-status-title">{st.locked ? 'Locked' : 'Unlocked'}</div>
          <div className="sv-status-sub">{protection(st)} · {st.prefs.autoLockMinutes ? `locks after ${st.prefs.autoLockMinutes} min idle` : 'locks on sleep and quit'}</div>
        </div>
        {st.locked
          ? <button className="btn primary sv-status-btn" disabled={busy || !st.exists} onClick={() => void act(() => api.vault.unlock())} data-testid="vault-unlock">{st.touchIdAvailable && st.prefs.touchId && (!st.masterPassword || st.bio) ? <><FingerprintGlyph size={15} /> Unlock</> : 'Unlock'}</button>
          : <button className="btn sv-status-btn" disabled={busy} onClick={() => void act(() => api.vault.lock())} data-testid="vault-lock">Lock now</button>}
      </div>

      {!st.keychain && <div className="sv-banner danger">The macOS Keychain isn't available, so nothing can be saved in the vault right now.</div>}
      {st.tampered && (
        <div className="sv-banner danger" data-testid="vault-tampered">
          The vault's signed index doesn't match its items: something changed them outside SahilBot. Nothing is filled until you review it.
          <button className="link-btn" disabled={busy} onClick={() => void act(() => api.vault.resign(), 'Vault accepted as it is now')}>I changed it (accept)</button>
        </div>
      )}
      {st.presenceOnly && !st.locked && <div className="sv-banner">Anyone using your Mac account can open this vault with a click. <button className="link-btn" onClick={() => setTab('security')}>Set a master password</button></div>}
      {st.legacy.present && st.legacy.migrated > 0 && !st.legacy.rolledBack && (
        <div className="sv-banner" data-testid="vault-legacy">
          {st.legacy.migrated} item{st.legacy.migrated === 1 ? '' : 's'} moved into the encrypted vault. The old Keychain-only copies are still on this Mac (they're the rollback copy).
          <button className="link-btn" disabled={busy || st.locked} onClick={() => void act(() => api.vault.purgeLegacy(), 'Old copies removed')} data-testid="vault-purge-legacy">Remove old copies</button>
        </div>
      )}
      {st.legacy.unreadable.length > 0 && <div className="sv-banner">Couldn't read {st.legacy.unreadable.join(', ')} from the old format (the Keychain no longer opens it). Add {st.legacy.unreadable.length === 1 ? 'it' : 'them'} again.</div>}

      <div className="pw-tabs sv-tabs" role="tablist">
        {TABS.map((x) => (
          <button key={x.id} role="tab" aria-selected={tab === x.id} className={`pw-tab${tab === x.id ? ' on' : ''}`} onClick={() => setTab(x.id)} data-testid={`vault-tab-${x.id}`}>
            {x.label}{x.type && st.counts[x.type] ? <span className="sv-count">{st.counts[x.type]}</span> : null}
          </button>
        ))}
      </div>

      {t.type && <ItemsTab key={t.type} type={t.type} items={items.filter((i) => i.type === t.type)} addresses={items.filter((i) => i.type === 'address')} st={st} onChange={refresh} />}
      {tab === 'logins' && <OtpGrants />}
      {tab === 'logins' && <NeverSave />}
      {tab === 'security' && <SecurityTab st={st} act={act} busy={busy} />}
      {tab === 'activity' && <Activity />}
    </>
  )
}

// ------------------------------------------------------------------ items

function subline(i: VaultItemSummary): string {
  const host = (s?: string): string => { try { return s ? new URL(s).host : '' } catch { return s ?? '' } }
  const exp = i.expMonth ? `expires ${String(i.expMonth).padStart(2, '0')}/${String(i.expYear).slice(-2)}` : ''
  switch (i.type) {
    case 'login': return [i.usernameHint, host(i.sites?.[0]), i.subdomains ? '+ subdomains' : '', i.hasTotp ? `authenticator${i.totpIssuer ? ` (${i.totpIssuer})` : ''}` : '', i.autoFill ? 'signs in without asking' : ''].filter(Boolean).join(' · ')
    case 'card': return [`${BRAND_NAME[(i.brand ?? 'card') as CardBrand] ?? 'Card'} •••• ${i.last4}`, exp, i.hasCvc ? 'security code saved' : 'asks for the security code'].filter(Boolean).join(' · ')
    case 'identity': return [ID_KINDS.find((k) => k[0] === i.kind)?.[1] ?? 'ID', i.last4 ? `•••• ${i.last4}` : '', exp, i.sites?.length ? `fills on ${i.sites.map(host).join(', ')}` : 'reveal only'].filter(Boolean).join(' · ')
    case 'note': return `Updated ${new Date(i.updated).toLocaleDateString()}`
    case 'address': return i.summary ?? ''
  }
}

function initial(i: VaultItemSummary): string {
  if (i.type === 'card') return (BRAND_NAME[(i.brand ?? 'card') as CardBrand] ?? 'C').slice(0, 1)
  return (i.name || '?').slice(0, 1).toUpperCase()
}

function ItemsTab({ type, items, addresses, st, onChange }: { type: VaultItemType; items: VaultItemSummary[]; addresses: VaultItemSummary[]; st: VaultStatus; onChange: () => Promise<void> }) {
  const [editing, setEditing] = useState<{ item?: VaultItemSummary; prefill?: Record<string, string> } | null>(null)
  const [reveal, setReveal] = useState<VaultReveal | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  const show = async (id: string): Promise<void> => {
    try { const r = await api.vault.reveal(id); if (r) setReveal(r) } catch (e) { toast(clean(e), 'error') }
  }
  const edit = async (item: VaultItemSummary): Promise<void> => {
    // Addresses are edited with their current values (shown after Touch ID / the master password).
    if (type === 'address') {
      try {
        const r = await api.vault.reveal(item.id)
        if (!r) return
        const m = Object.fromEntries(r.fields.map((f) => [f.key, f.value]))
        // The form keeps the nickname in "name" and the person's name in "name_full".
        setEditing({ item, prefill: { ...m, name_full: m.name ?? '', name: item.name } })
      } catch (e) { toast(clean(e), 'error') }
      return
    }
    setEditing({ item })
  }
  const remove = async (id: string): Promise<void> => {
    try { await api.vault.removeItem(id); setConfirm(null); if (reveal?.id === id) setReveal(null); await onChange() } catch (e) { toast(clean(e), 'error') }
  }
  const noun = NOUN[type]
  return (
    <>
      <Section title={`Saved ${noun === 'ID' ? 'IDs' : `${noun}s`}`} sub={type === 'identity' ? 'Passports, licenses and other IDs. Typed into a form only on the sites you list, after you approve and confirm with Touch ID or your master password.' : type === 'note' ? 'Encrypted notes for you only: never typed anywhere and never shown to the assistant.' : type === 'card' ? 'The assistant sees a card\'s nickname and last four digits only. The full number goes into the merchant\'s checkout after you approve the Purchase card and confirm it\'s you.' : undefined}
        right={!editing ? <button className="btn primary sv-add" onClick={() => setEditing({})} data-testid={`vault-add-${type}`}><I.Plus size={13} /> Add {noun}</button> : undefined}>
        {items.length === 0 && <div className="set-empty">No saved {noun === 'ID' ? 'IDs' : `${noun}s`} yet.</div>}
        {items.map((i) => (
          <div key={i.id} className="sv-item" data-testid="vault-item" data-type={i.type}>
            <div className="set-row">
              <span className={`vault-row-icon sv-icon t-${i.type}`} aria-hidden="true">{initial(i)}</span>
              <div className="set-row-text"><div className="set-row-title">{i.name}</div><div className="set-row-sub" title={subline(i)}>{subline(i)}</div></div>
              {confirm === i.id ? (
                <span className="sv-confirm">Remove?
                  <button className="link-btn danger" onClick={() => void remove(i.id)} data-testid="vault-remove-yes">Remove</button>
                  <button className="link-btn" onClick={() => setConfirm(null)}>Keep</button>
                </span>
              ) : (
                <>
                  <button className="link-btn" onClick={() => void (reveal?.id === i.id ? setReveal(null) : show(i.id))} data-testid="vault-reveal">{reveal?.id === i.id ? 'Hide' : 'Reveal'}</button>
                  <button className="link-btn" onClick={() => void edit(i)} data-testid="vault-edit">Edit</button>
                  <button className="icon-btn" title="Remove" aria-label={`Remove ${i.name}`} onClick={() => setConfirm(i.id)}><I.Trash size={14} /></button>
                </>
              )}
            </div>
            {reveal?.id === i.id && <RevealPanel r={reveal} onHide={() => setReveal(null)} />}
          </div>
        ))}
      </Section>
      {editing && (
        <ItemForm key={editing.item?.id ?? 'new'} type={type} item={editing.item} prefill={editing.prefill} addresses={addresses} locked={st.locked}
          onCancel={() => setEditing(null)} onSaved={async () => { setEditing(null); await onChange() }} />
      )}
    </>
  )
}

/** Values shown to the user only: hidden again after 20 seconds, not selectable (nothing lands in clipboard history). */
function RevealPanel({ r, onHide }: { r: VaultReveal; onHide: () => void }) {
  const [left, setLeft] = useState(Math.round(r.hideAfterMs / 1000))
  useEffect(() => {
    const t = setInterval(() => setLeft((x) => x - 1), 1000)
    const h = setTimeout(onHide, r.hideAfterMs)
    // Hidden as soon as the window loses focus too.
    const blur = (): void => onHide()
    window.addEventListener('blur', blur)
    return () => { clearInterval(t); clearTimeout(h); window.removeEventListener('blur', blur) }
  }, [r, onHide])
  return (
    <div className="sv-reveal" data-testid="vault-reveal-panel" onCopy={(e) => e.preventDefault()}>
      {r.fields.length === 0 && <div className="set-empty">Nothing saved.</div>}
      {r.fields.map((f) => (
        <div key={f.key} className="sv-reveal-row">
          <span className="sv-reveal-label">{f.label}</span>
          <span className={`sv-reveal-value${f.secret ? ' secret' : ''}${f.key === 'body' ? ' body' : ''}`}>{f.value}</span>
        </div>
      ))}
      <div className="sv-reveal-foot"><span>Hides in {Math.max(0, left)}s · shown to you only, never to the assistant</span><button className="link-btn" onClick={onHide}>Hide now</button></div>
    </div>
  )
}

/** A field for a secret: typed once, never echoed back, sent straight to main. */
function SecretInput({ value, onChange, placeholder, testId, numeric, wide = true }: { value: string; onChange: (v: string) => void; placeholder: string; testId?: string; numeric?: boolean; wide?: boolean }) {
  return <input className={`set-input${wide ? ' wide' : ''} sv-secret`} type="password" autoComplete="new-password" spellCheck={false} autoCorrect="off" autoCapitalize="off" inputMode={numeric ? 'numeric' : undefined}
    placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId} />
}

function ItemForm({ type, item, prefill, addresses, locked, onCancel, onSaved }: { type: VaultItemType; item?: VaultItemSummary; prefill?: Record<string, string>; addresses: VaultItemSummary[]; locked: boolean; onCancel: () => void; onSaved: () => Promise<void> }) {
  const editing = !!item
  const [f, setF] = useState<Record<string, string>>(() => ({
    name: item?.name ?? '', site: item?.sites?.[0] ?? '', sites: item?.sites?.join(', ') ?? '', kind: item?.kind ?? 'passport',
    month: item?.expMonth ? String(item.expMonth).padStart(2, '0') : '', year: item?.expYear ? String(item.expYear) : '', billing: item?.billing ?? '',
    ...(prefill ?? {})
  }))
  const [flags, setFlags] = useState({ subdomains: !!item?.subdomains, autoFill: !!item?.autoFill, keepCvc: !!item?.hasCvc, clearTotp: false })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (k: string) => (v: string): void => setF((x) => ({ ...x, [k]: v }))
  const text = (k: string, placeholder: string, wide = false, testId?: string) => (
    <input className={`set-input${wide ? ' wide' : ''}`} placeholder={placeholder} value={f[k] ?? ''} onChange={(e) => set(k)(e.target.value)} spellCheck={false} data-testid={testId ?? `vault-f-${k}`} />
  )
  const keep = editing ? ' (leave empty to keep)' : ''
  const save = async (): Promise<void> => {
    setErr('')
    setBusy(true)
    const v = (k: string): string | undefined => (f[k] ? f[k] : undefined)
    const input: VaultItemInput = { id: item?.id, type, name: f.name ?? '' }
    if (type === 'login') Object.assign(input, { site: f.site, username: v('username'), password: v('password'), totp: v('totp'), clearTotp: flags.clearTotp || undefined, notes: f.notes !== undefined && f.notes !== '' ? f.notes : undefined, subdomains: flags.subdomains, autoFill: flags.autoFill })
    if (type === 'card') Object.assign(input, { number: v('number'), cvc: flags.keepCvc ? v('cvc') : undefined, clearCvc: !flags.keepCvc || undefined, expMonth: f.month, expYear: f.year, holder: f.holder, billing: f.billing || undefined })
    if (type === 'identity') Object.assign(input, { kind: f.kind, number: v('number'), fullName: v('fullName'), issuer: v('issuer'), country: v('country'), expMonth: v('month'), expYear: v('year'), sites: f.sites ?? '', notes: v('notes') })
    if (type === 'note') Object.assign(input, { body: f.body !== undefined && (f.body !== '' || !editing) ? f.body : undefined })
    if (type === 'address') Object.assign(input, { address: { name: f.name_full ?? '', line1: f.line1 ?? '', line2: f.line2, city: f.city ?? '', region: f.region, postal: f.postal ?? '', country: f.country ?? '', phone: f.phone, email: f.email } })
    try {
      await api.vault.saveItem(input)
      // Typed values leave the page as soon as they're saved.
      setF({})
      await onSaved()
      toast(`${editing ? 'Updated' : 'Saved'} ${f.name || NOUN[type]}`, 'ok')
    } catch (e) {
      setErr(clean(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section title={editing ? `Edit ${item!.name}` : `Add ${NOUN[type] === 'ID' ? 'an ID' : NOUN[type] === 'address' ? 'an address' : `a ${NOUN[type]}`}`}>
      <div className="pw-form sv-form" data-testid="vault-form">
        {type === 'login' && <>
          {text('name', 'Name (e.g. github)')}
          {text('site', 'Site (github.com)')}
          <input className="set-input" placeholder={`Username${keep}`} value={f.username ?? ''} onChange={(e) => set('username')(e.target.value)} autoComplete="off" spellCheck={false} data-testid="vault-f-username" />
          <SecretInput wide={false} value={f.password ?? ''} onChange={set('password')} placeholder={`Password${keep}`} testId="vault-f-password" />
          <SecretInput value={f.totp ?? ''} onChange={set('totp')} placeholder={`Authenticator key or otpauth:// link (optional)${item?.hasTotp ? keep : ''}`} testId="vault-f-totp" />
          <textarea className="set-input wide sv-notes" placeholder={`Notes (optional, encrypted)${keep}`} value={f.notes ?? ''} onChange={(e) => set('notes')(e.target.value)} rows={2} />
          <label className="sv-check wide"><input type="checkbox" checked={flags.subdomains} onChange={(e) => setFlags({ ...flags, subdomains: e.target.checked })} /> Also on its subdomains (login.site.com)</label>
          <label className="sv-check wide"><input type="checkbox" checked={flags.autoFill} onChange={(e) => setFlags({ ...flags, autoFill: e.target.checked })} data-testid="vault-f-autofill" /> Sign in on this site without asking each time (only this site, only its username and password)</label>
          {item?.hasTotp && <label className="sv-check wide"><input type="checkbox" checked={flags.clearTotp} onChange={(e) => setFlags({ ...flags, clearTotp: e.target.checked })} /> Remove the authenticator key</label>}
        </>}
        {type === 'card' && <>
          {text('name', 'Nickname (e.g. Personal Visa)', true)}
          <SecretInput value={f.number ?? ''} onChange={(x) => set('number')(x.replace(/[^\d ]/g, '').slice(0, 23))} placeholder={editing ? `•••• ${item!.last4}${keep}` : 'Card number'} testId="vault-f-number" numeric />
          <div className="row">
            <input className="set-input" inputMode="numeric" placeholder="MM" maxLength={2} value={f.month ?? ''} onChange={(e) => set('month')(e.target.value.replace(/\D/g, ''))} data-testid="vault-f-month" />
            <input className="set-input" inputMode="numeric" placeholder="YYYY" maxLength={4} value={f.year ?? ''} onChange={(e) => set('year')(e.target.value.replace(/\D/g, ''))} data-testid="vault-f-year" />
          </div>
          {text('holder', 'Name on card', false, 'vault-f-holder')}
          <label className="sv-check wide"><input type="checkbox" checked={flags.keepCvc} onChange={(e) => setFlags({ ...flags, keepCvc: e.target.checked })} data-testid="vault-f-keepcvc" /> Remember the security code (off: SahilBot asks you to type it at checkout)</label>
          {flags.keepCvc && <SecretInput wide={false} value={f.cvc ?? ''} onChange={(x) => set('cvc')(x.replace(/\D/g, '').slice(0, 4))} placeholder={item?.hasCvc ? `Security code${keep}` : 'Security code'} testId="vault-f-cvc" numeric />}
          <select className="set-select" value={f.billing ?? ''} onChange={(e) => set('billing')(e.target.value)}>
            <option value="">No billing address</option>
            {addresses.map((a) => <option key={a.id} value={a.id}>Billing: {a.name}</option>)}
          </select>
        </>}
        {type === 'identity' && <>
          {text('name', 'Name (e.g. My passport)')}
          <select className="set-select" value={f.kind} onChange={(e) => set('kind')(e.target.value)}>{ID_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <SecretInput value={f.number ?? ''} onChange={set('number')} placeholder={`Document number${keep}`} testId="vault-f-number" />
          {text('fullName', `Name on the document${keep}`)}
          {text('issuer', `Issued by${keep}`)}
          {text('country', `Country${keep}`)}
          <div className="row">
            <input className="set-input" inputMode="numeric" placeholder="Exp. MM" maxLength={2} value={f.month ?? ''} onChange={(e) => set('month')(e.target.value.replace(/\D/g, ''))} />
            <input className="set-input" inputMode="numeric" placeholder="YYYY" maxLength={4} value={f.year ?? ''} onChange={(e) => set('year')(e.target.value.replace(/\D/g, ''))} />
          </div>
          {text('sites', 'Sites it may be typed on (comma-separated; empty = reveal only)', true)}
        </>}
        {type === 'note' && <>
          {text('name', 'Title', true)}
          <textarea className="set-input wide sv-notes" rows={6} placeholder={editing ? 'Type to replace the note (leave empty to keep)' : 'Note (encrypted)'} value={f.body ?? ''} onChange={(e) => set('body')(e.target.value)} spellCheck={false} data-testid="vault-f-body" />
        </>}
        {type === 'address' && <>
          {text('name', 'Nickname (e.g. Home)', true)}
          {text('name_full', 'Full name', true)}
          {text('line1', 'Street address', true)}
          {text('line2', 'Apartment, suite (optional)', true)}
          {text('city', 'City')}
          {text('region', 'State / region')}
          {text('postal', 'ZIP / postal code')}
          {text('country', 'Country')}
          {text('phone', 'Phone (optional)')}
          {text('email', 'Email (optional)')}
        </>}
        {locked && editing && type !== 'address' && <div className="sv-hint wide">The vault is locked: you may be asked to unlock it to keep fields you leave empty.</div>}
        {err && <div className="pw-err wide" role="alert">{err}</div>}
        <div className="pw-form-actions wide">
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn primary" disabled={busy || !(f.name ?? '').trim()} onClick={() => void save()} data-testid="vault-save">{editing ? 'Save changes' : `Save ${NOUN[type]}`}</button>
        </div>
      </div>
    </Section>
  )
}

// ------------------------------------------------------------------ one-time code grants (logins tab)

function OtpGrants() {
  const [grants, setGrants] = useState<string[]>([])
  useEffect(() => void api.vault.otpGrants().then(setGrants).catch(() => undefined), [])
  if (!grants.length) return null
  return (
    <Section title="One-time codes allowed without asking" sub="Sites where you chose “Always” for sign-in codes. Removing one makes SahilBot ask again.">
      {grants.map((g) => (
        <div className="set-row" key={g}>
          <div className="set-row-text"><div className="set-row-title">{g}</div></div>
          <button className="icon-btn" title="Remove" aria-label={`Stop allowing ${g}`} onClick={() => void api.vault.revokeOtpGrant(g).then(setGrants)}><I.Trash size={14} /></button>
        </div>
      ))}
    </Section>
  )
}

// ------------------------------------------------------------------ "Never for this site" (logins tab)

function NeverSave() {
  const [sites, setSites] = useState<string[]>([])
  useEffect(() => void api.vault.neverSave().then(setSites).catch(() => undefined), [])
  return (
    <Section title="Offers to save" sub="When you sign in or pay by hand in SahilBot's browser, or type a password, key, card or ID number into a chat, SahilBot offers to save it here. Nothing is saved unless you click Save.">
      {!sites.length && <Row title="Asks on every site" sub="Choose “Never for this site” on an offer to stop asking there." testId="vault-never-empty" />}
      {sites.map((o) => (
        <div className="set-row" key={o} data-testid="vault-never-row">
          <div className="set-row-text"><div className="set-row-title">Never for {o.replace(/^https:\/\//, '')}</div></div>
          <button className="icon-btn" title="Ask again" aria-label={`Ask again on ${o}`} onClick={() => void api.vault.removeNeverSave(o).then(setSites)}><I.Trash size={14} /></button>
        </div>
      ))}
    </Section>
  )
}

// ------------------------------------------------------------------ security

function SecurityTab({ st, act, busy }: { st: VaultStatus; act: (fn: () => Promise<unknown>, ok?: string) => Promise<void>; busy: boolean }) {
  const [mp, setMp] = useState<{ cur: string; next: string; again: string } | null>(null)
  const [removePw, setRemovePw] = useState<string | null>(null)
  const [backup, setBackup] = useState<{ mode: 'export' | 'import'; pw: string; again: string } | null>(null)
  const [csvNote, setCsvNote] = useState('')
  const strength = (p: string): string => (p.length >= 16 ? 'strong' : p.length >= 12 ? 'good' : p.length >= 10 ? 'ok' : 'short')
  const kdfText = st.kdf ? `${st.kdf.alg === 'scrypt' ? 'scrypt' : 'Argon2id'} (${st.kdf.cost}${st.kdf.ms ? `, about ${(st.kdf.ms / 1000).toFixed(1)} s per guess on this Mac` : ''})` : ''
  return (
    <>
      <Section title="What protects your vault" sub="Exactly what's in place right now. No security is perfect; this is what it does and doesn't cover.">
        <div className="sv-summary" data-testid="vault-summary">
          <p><b>Each item</b> is encrypted with AES-256-GCM under its own random 256-bit key, with a fresh nonce every time it's saved. The item's id, type, version and sites are bound in, so encrypted data can't be swapped between items or sites without being detected.</p>
          <p><b>Those item keys</b> are encrypted with your vault key, which is only in memory while the vault is unlocked.</p>
          <p><b>The vault key</b> is protected by a random key in your Mac's Keychain (usable only by SahilBot){st.masterPassword ? <> <b>and</b> your master password, stretched with {kdfText}. Both are needed: a copy of SahilBot's data alone, without your Mac's Keychain, can't be opened, and with it an attacker still has to guess your master password.</> : <>. <b>No master password is set</b>, so anyone who can use your Mac account and open SahilBot can unlock it{st.touchIdAvailable && st.prefs.touchId ? ' after Touch ID' : ' with a click'}.</>}</p>
          {st.touchIdAvailable && <p><b>Touch ID</b> {st.prefs.touchId ? 'confirms it\'s you before unlocking and before cards and IDs are filled.' : 'is off.'} It's a check by macOS, not a separate encryption key{st.bio ? ': with Touch ID unlock on, a second copy of the vault key is protected by the Keychain instead of your master password.' : '.'}</p>}
          <p><b>Locks</b> {st.prefs.autoLockMinutes ? `after ${st.prefs.autoLockMinutes} minutes without use or with the Mac idle, ` : ''}{st.prefs.lockOnSleep ? 'when the Mac sleeps or the screen locks, ' : ''}and when you quit. Wrong master passwords wait longer each time.</p>
          <p><b>The assistant</b> only ever sees names, sites, card brand and last four digits. SahilBot types values into the page itself: only on the item's own site, only over HTTPS, only into a real, visible field of the right kind, only after your approval; cards only after the Purchase card and {st.masterPassword || st.touchIdAvailable ? 'Touch ID or your master password' : 'your click'}. If a saved value ever shows up in page text, it's masked before the assistant reads it.</p>
          <p className="sv-limits"><b>It can't protect against:</b> malware running as you while the vault is unlocked (it could read SahilBot's memory or the pages it fills), someone who has your Mac login and your master password, a website that is itself compromised, or a forgotten master password together with a lost Keychain (keep an encrypted backup).</p>
        </div>
      </Section>

      <Section title="Unlocking">
        <Row title="Master password" sub={st.masterPassword ? `Set. ${kdfText}.` : 'Not set. Recommended: the vault then needs both your Mac\'s Keychain and this password.'}>
          {!mp && removePw === null && <>
            {st.masterPassword && <button className="btn danger" disabled={busy} onClick={() => setRemovePw('')}>Remove</button>}
            <button className="btn" disabled={busy} onClick={() => setMp({ cur: '', next: '', again: '' })} data-testid="vault-set-master">{st.masterPassword ? 'Change…' : 'Set…'}</button>
          </>}
        </Row>
        {mp && (
          <div className="pw-form sv-form">
            {st.masterPassword && <SecretInput value={mp.cur} onChange={(v) => setMp({ ...mp, cur: v })} placeholder="Current master password" />}
            <SecretInput wide={false} value={mp.next} onChange={(v) => setMp({ ...mp, next: v })} placeholder="New master password (10+ characters)" testId="vault-master-new" />
            <SecretInput wide={false} value={mp.again} onChange={(v) => setMp({ ...mp, again: v })} placeholder="Type it again" testId="vault-master-again" />
            <div className="sv-hint wide">Strength: {strength(mp.next)}. A few random words make a strong, memorable one. If you forget it, the vault can't be opened (keep a backup).</div>
            <div className="pw-form-actions wide">
              <button className="btn" onClick={() => setMp(null)}>Cancel</button>
              <button className="btn primary" disabled={busy || mp.next.length < 10 || mp.next !== mp.again} onClick={() => { const m = mp; setMp(null); void act(() => api.vault.setMasterPassword(m.next, m.cur || undefined), 'Master password set') }} data-testid="vault-master-save">Save (takes a second)</button>
            </div>
          </div>
        )}
        {removePw !== null && (
          <div className="pw-form sv-form">
            <SecretInput value={removePw} onChange={setRemovePw} placeholder="Current master password" />
            <div className="sv-hint wide">Without a master password, the vault is protected by your Mac's Keychain only.</div>
            <div className="pw-form-actions wide">
              <button className="btn" onClick={() => setRemovePw(null)}>Cancel</button>
              <button className="btn danger" disabled={busy || !removePw} onClick={() => { const p = removePw; setRemovePw(null); void act(() => api.vault.removeMasterPassword(p), 'Master password removed') }}>Remove master password</button>
            </div>
          </div>
        )}
        {st.touchIdAvailable && (
          <Row title="Touch ID" sub={st.masterPassword ? 'Unlock with Touch ID instead of typing the master password (convenient; the Touch ID copy of the key is protected by the Keychain only).' : 'Ask for Touch ID to unlock and before cards and IDs are filled.'}>
            <Toggle on={st.masterPassword ? st.bio : st.prefs.touchId} onChange={(v) => void act(() => api.vault.setTouchIdUnlock(v))} label="Touch ID" testId="vault-touchid" />
          </Row>
        )}
        <Row title="Auto-lock" sub="Locks after this long without use, or with the Mac idle.">
          <select className="set-select" value={st.prefs.autoLockMinutes} onChange={(e) => void act(() => api.vault.setPrefs({ autoLockMinutes: Number(e.target.value) }))} data-testid="vault-autolock" aria-label="Auto-lock">
            {AUTOLOCK.map((m) => <option key={m} value={m}>{m === 0 ? 'Only on sleep and quit' : m < 60 ? `${m} minute${m === 1 ? '' : 's'}` : `${m / 60} hour${m === 60 ? '' : 's'}`}</option>)}
          </select>
        </Row>
        <Row title="Lock when the Mac sleeps or the screen locks"><Toggle on={st.prefs.lockOnSleep} onChange={(v) => void act(() => api.vault.setPrefs({ lockOnSleep: v }))} label="Lock on sleep" /></Row>
        <Row title="Confirm before typing passwords too" sub="Cards and IDs always ask for Touch ID or your master password right before they're filled. With this on, passwords do as well."><Toggle on={st.prefs.reauthPasswords} onChange={(v) => void act(() => api.vault.setPrefs({ reauthPasswords: v }))} label="Confirm passwords" testId="vault-reauth-passwords" /></Row>
      </Section>

      <Section title="Backup" sub="An encrypted file (same encryption, protected by a backup password you choose) that you can restore on any Mac.">
        <Row title="Export encrypted backup"><button className="btn" disabled={busy || st.locked} onClick={() => setBackup({ mode: 'export', pw: '', again: '' })}>Export…</button></Row>
        <Row title="Import a backup"><button className="btn" disabled={busy} onClick={() => setBackup({ mode: 'import', pw: '', again: '' })}>Import…</button></Row>
        {backup && (
          <div className="pw-form sv-form">
            <SecretInput wide={false} value={backup.pw} onChange={(v) => setBackup({ ...backup, pw: v })} placeholder={backup.mode === 'export' ? 'Backup password (10+ characters)' : 'The backup\'s password'} />
            {backup.mode === 'export' ? <SecretInput wide={false} value={backup.again} onChange={(v) => setBackup({ ...backup, again: v })} placeholder="Type it again" /> : <span />}
            <div className="pw-form-actions wide">
              <button className="btn" onClick={() => setBackup(null)}>Cancel</button>
              <button className="btn primary" disabled={busy || (backup.mode === 'export' ? backup.pw.length < 10 || backup.pw !== backup.again : !backup.pw)}
                onClick={() => {
                  const b = backup
                  setBackup(null)
                  void act(async () => {
                    if (b.mode === 'export') { const r = await api.vault.exportBackup(b.pw); if (r.ok) toast(`Saved ${r.count} items to ${r.path?.split('/').pop()}`, 'ok') }
                    else { const r = await api.vault.importBackup(b.pw); if (r.ok) toast(`Imported ${r.added} items${r.skipped ? ` (${r.skipped} already saved)` : ''}`, 'ok') }
                  })
                }}>{backup.mode === 'export' ? 'Choose where to save' : 'Choose the file'}</button>
            </div>
          </div>
        )}
        <Row title="Import from a password manager" sub="A CSV export from Chrome, Safari, 1Password, Bitwarden, LastPass or Firefox.">
          <button className="btn" disabled={busy} onClick={() => void act(async () => { const r = await api.vault.importCsv(); if (r.ok) setCsvNote(`Imported ${r.added} logins${r.skipped ? `, skipped ${r.skipped}` : ''}. Now delete ${r.path?.split('/').pop() ?? 'the CSV file'} (and empty the Trash): it holds your passwords in plain text.`) })}>Import CSV…</button>
        </Row>
        {csvNote && <div className="sv-banner warn" role="alert">{csvNote}</div>}
      </Section>

      {(st.legacy.present || st.legacy.migrated > 0) && (
        <Section title="Upgrade from the old format" sub="Before this version, each item was stored with Keychain protection only. They were copied into the encrypted vault and checked one by one.">
          <Row title="Old copies" sub={st.legacy.present ? 'Still on this Mac (the rollback copy).' : 'Removed.'}>
            {st.legacy.present && <button className="btn danger" disabled={busy || st.locked} onClick={() => void act(() => api.vault.purgeLegacy(), 'Old copies removed')}>Remove old copies</button>}
          </Row>
          <Row title="Write a rollback copy" sub="Writes your logins, cards and addresses back in the old format, for going back to an older SahilBot. Keychain protection only.">
            <button className="btn" disabled={busy || st.locked} onClick={() => void act(() => api.vault.rollback(), 'Rollback copy written')}>Write copy</button>
          </Row>
        </Section>
      )}
    </>
  )
}

// ------------------------------------------------------------------ activity

const EVENT: Record<string, string> = {
  unlock: 'Unlocked', unlock_failed: 'Unlock failed', lock: 'Locked', fill: 'Filled', fill_blocked: 'Fill blocked', reveal: 'Revealed', reauth: 'Confirmed', reauth_failed: 'Not confirmed',
  export: 'Exported', import: 'Imported', item_added: 'Added', item_changed: 'Changed', item_removed: 'Removed', master_password: 'Master password', migration: 'Upgrade', tamper: 'Tamper check'
}

function Activity() {
  const [rows, setRows] = useState<VaultAuditEntry[] | null>(null)
  useEffect(() => {
    const load = (): void => void api.vault.audit(300).then(setRows).catch(() => setRows([]))
    load()
    return api.vault.onChanged(load)
  }, [])
  return (
    <Section title="Activity" sub="Every unlock, fill, reveal, export and failed attempt. Values are never recorded.">
      {!rows ? <div className="set-empty">Loading…</div> : rows.length === 0 ? <div className="set-empty">Nothing yet.</div> : (
        <div className="sv-audit" data-testid="vault-audit">
          {rows.map((r) => (
            <div key={r.id} className={`sv-audit-row o-${r.outcome}`} data-testid="vault-audit-row">
              <span className="sv-audit-time">{new Date(r.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
              <span className="sv-audit-event">{EVENT[r.event] ?? r.event}</span>
              <span className="sv-audit-what">{[r.item, r.site].filter(Boolean).join(' · ')}{r.detail ? <span className="sv-audit-detail"> {r.detail}</span> : null}</span>
              <span className={`sv-badge o-${r.outcome}`}>{r.outcome}</span>
            </div>
          ))}
        </div>
      )}
    </Section>
  )
}
