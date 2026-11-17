// The browser side of SahilBot Server's web UI: loaded before the app's own script. It builds the Mac
// app's preload against a WebSocket transport (./electron-web.ts), so window.foreman is the same API, then
// adjusts the few things a browser does differently: file choosers, links, notifications.

import { emitLocal, ipcRenderer } from './electron-web'
import '../../preload/index'
import { layoutFor } from '../layout'
import type { SahilBotApi, ServerApi } from '@shared/types'

const api = (window as unknown as { foreman: SahilBotApi & Record<string, any> }).foreman
const call = (ch: string) => (...args: unknown[]) => ipcRenderer.invoke(ch, ...args)

api.runtime = 'server'
api.remoteServer = undefined
api.phoneAccess = undefined
/** Who serves this page: SahilBot Server, or a Mac running SahilBot with Phone access on (http.ts puts it in a meta tag). */
const serverHost: 'mac' | 'server' = document.querySelector('meta[name="sahilbot-host"]')?.getAttribute('content') === 'mac' ? 'mac' : 'server'
api.serverHost = serverHost

/** Signs this device out: the server forgets it and the cookie is cleared. */
async function signOut(): Promise<void> {
  const s = (await (await fetch('/api/session', { credentials: 'same-origin' })).json()) as { csrf?: string }
  await fetch('/api/logout', { method: 'POST', credentials: 'same-origin', headers: { 'X-SahilBot-CSRF': s.csrf ?? '' } })
  location.replace('/pair')
}

const server: ServerApi = {
  info: call('server:info') as never,
  devices: call('server:devices') as never,
  revokeDevice: call('server:revokeDevice') as never,
  renameDevice: call('server:renameDevice') as never,
  pairingCode: call('server:pairingCode') as never,
  audit: call('server:audit') as never,
  pushKey: call('server:pushKey') as never,
  pushSubscribe: call('server:pushSubscribe') as never,
  pushUnsubscribe: call('server:pushUnsubscribe') as never,
  pushTest: call('server:pushTest') as never,
  ...(serverHost === 'mac' ? { phoneInfo: call('server:phoneInfo') as never } : {}),
  signOut
}
api.server = server
document.documentElement.dataset.runtime = 'server'
document.documentElement.dataset.host = serverHost

// The layout the stylesheet is in (phone, tablet, desktop), for the app and tests.
const setLayout = (): void => { document.documentElement.dataset.layout = layoutFor(window.innerWidth) }
setLayout()
window.addEventListener('resize', setLayout)

// ------------------------------------------------------------------ files: the browser's own chooser

function choose(multiple: boolean): Promise<File[]> {
  return new Promise((done) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = multiple
    input.style.display = 'none'
    input.addEventListener('change', () => { done([...(input.files ?? [])]); input.remove() }, { once: true })
    // Closing the chooser fires no event everywhere; focus coming back without files counts as a cancel.
    window.addEventListener('focus', () => setTimeout(() => { if (!input.files?.length) { done([]); input.remove() } }, 800), { once: true })
    document.body.appendChild(input)
    input.click()
  })
}

const noFolders = { name: 'Folder', reason: 'Folders on your device can’t be attached from a browser. Put them in the server’s workspace instead.' }
api.attach.pick = async (kind: 'files' | 'folder') => {
  if (kind === 'folder') return { added: [], rejected: [noFolders] }
  const files = await choose(true)
  return files.length ? api.attach.fromFiles(files) : { added: [], rejected: [] }
}
api.files.pick = async (kind: 'files' | 'folder') => (kind === 'folder' ? [] : (await api.attach.pick('files')).added)

// ------------------------------------------------------------------ links and notifications

ipcRenderer.on('server:open-url', (_e, url) => {
  if (typeof url === 'string' && /^(https?:|mailto:)/i.test(url)) window.open(url, '_blank', 'noopener,noreferrer')
})

// A phone using the Mac: links in answers open in the phone's own browser, not the Mac's browser panel.
// (Registered before the app's own listener, which then never sees the event.)
if (serverHost === 'mac') {
  window.addEventListener('foreman:open-link', (e) => {
    const url = (e as CustomEvent<string>).detail
    e.stopImmediatePropagation()
    if (typeof url === 'string' && /^(https?:|mailto:)/i.test(url)) window.open(url, '_blank', 'noopener,noreferrer')
  })
}

interface Note { title: string; body?: string; threadId?: string; tag?: string; missed?: boolean }

/** Toasts stack in one corner (newest at the bottom) instead of covering each other. */
function toasts(): HTMLElement {
  let box = document.getElementById('sb-server-toasts')
  if (!box) {
    box = document.createElement('div')
    box.id = 'sb-server-toasts'
    box.className = 'sb-server-toasts'
    box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483646;display:flex;flex-direction:column;align-items:flex-end;gap:8px;max-width:min(360px,calc(100vw - 32px))'
    document.body.appendChild(box)
  }
  return box
}

function toast(n: Note): void {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = 'sb-server-toast'
  el.style.cssText = 'max-width:100%;text-align:left;background:#1f1f1f;color:#fff;border:0;border-radius:14px;padding:12px 14px;font:13px/1.35 -apple-system,system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.28);cursor:pointer'
  const t = document.createElement('div')
  t.style.fontWeight = '600'
  t.textContent = n.title
  el.appendChild(t)
  if (n.body) { const b = document.createElement('div'); b.style.opacity = '.85'; b.textContent = n.body; el.appendChild(b) }
  el.addEventListener('click', () => { if (n.threadId) emitLocal('open-thread', n.threadId); el.remove() })
  const box = toasts()
  box.appendChild(el)
  while (box.children.length > 3) box.firstElementChild?.remove()
  setTimeout(() => el.remove(), 8000)
}

ipcRenderer.on('server:notify', (_e, raw) => {
  const n = raw as Note
  if (!n || typeof n.title !== 'string') return
  const away = document.visibilityState !== 'visible' || !document.hasFocus()
  if (away && 'Notification' in window && Notification.permission === 'granted') {
    try {
      const sys = new Notification(n.title, { body: n.body, tag: n.tag })
      sys.onclick = () => { window.focus(); if (n.threadId) emitLocal('open-thread', n.threadId); sys.close() }
      return
    } catch { /* some mobile browsers only notify from a service worker */ }
  }
  if (!away || n.missed) toast(n)
})

// A Web Push notification tapped while a SahilBot tab was open: the service worker hands over the chat.
navigator.serviceWorker?.addEventListener('message', (e) => {
  const d = e.data as { type?: string; threadId?: string } | null
  if (d?.type === 'open-thread' && d.threadId) emitLocal('open-thread', d.threadId)
})

// A notification tapped while the app was closed opens with ?thread=…
const opened = new URLSearchParams(location.search).get('thread')
if (opened) {
  history.replaceState(null, '', location.pathname)
  setTimeout(() => emitLocal('open-thread', opened), 1500)
}

// ------------------------------------------------------------------ phones: the sidebar as a drawer

function setupDrawer(): void {
  const root = document.documentElement
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'sb-menu-btn'
  btn.setAttribute('aria-label', 'Show bots and chats')
  btn.dataset.testid = 'mobile-menu'
  btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>'
  const scrim = document.createElement('div')
  scrim.className = 'sb-scrim'
  const open = (on: boolean): void => { root.classList.toggle('sb-drawer', on); btn.setAttribute('aria-expanded', String(on)) }
  btn.addEventListener('click', () => open(true))
  scrim.addEventListener('click', () => open(false))
  document.body.append(btn, scrim)
  // Opening something from the drawer (a bot, a chat, Settings) closes it; its own small toggles don't.
  document.addEventListener('click', (e) => {
    if (!root.classList.contains('sb-drawer')) return
    const t = e.target as HTMLElement | null
    const hit = t?.closest('.sidebar button, .sidebar [role="button"], .sidebar a')
    if (hit && !/collapse|chevron|toggle/i.test(hit.className + (hit.getAttribute('aria-label') ?? ''))) setTimeout(() => open(false), 120)
  }, true)
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') open(false) })
  ipcRenderer.on('open-thread', () => open(false))
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setupDrawer, { once: true })
else setupDrawer()
