// One focus trap for every dialog in the app: while a [role="dialog"] is open, Tab and Shift-Tab stay inside
// the topmost one; when it opens, focus moves into it (unless something inside already has it); when it
// closes, focus goes back to what had it before. Installed once (App.tsx), so new dialogs get it for free.

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"], [contenteditable="plaintext-only"]'

const visible = (el: Element): boolean => { const r = (el as HTMLElement).getBoundingClientRect(); return r.width > 0 && r.height > 0 }
const dialogs = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')].filter(visible)
const focusables = (root: HTMLElement): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(visible)

export function installFocusTrap(doc: Document = document): () => void {
  const before = new WeakMap<Element, Element | null>()
  const seen = new Set<HTMLElement>()
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Tab') return
    const top = dialogs().at(-1)
    if (!top) return
    const list = focusables(top)
    if (!list.length) { e.preventDefault(); top.focus(); return }
    const first = list[0], last = list[list.length - 1]
    const active = doc.activeElement
    if (!top.contains(active)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); return }
    if (!e.shiftKey && active === last) { e.preventDefault(); first.focus() }
    else if (e.shiftKey && active === first) { e.preventDefault(); last.focus() }
  }
  const sync = (): void => {
    const open = new Set(dialogs())
    for (const d of open) {
      if (seen.has(d)) continue
      seen.add(d)
      before.set(d, doc.activeElement)
      if (!d.contains(doc.activeElement)) {
        if (!d.hasAttribute('tabindex')) d.setAttribute('tabindex', '-1')
        ;(d.querySelector<HTMLElement>('[autofocus]') ?? focusables(d)[0] ?? d).focus({ preventScroll: true })
      }
    }
    for (const d of [...seen]) {
      if (open.has(d) && d.isConnected) continue
      seen.delete(d)
      const back = before.get(d) as HTMLElement | null | undefined
      if (back?.isConnected && (doc.activeElement === doc.body || !doc.activeElement || !doc.activeElement.isConnected)) back.focus({ preventScroll: true })
    }
  }
  const mo = new MutationObserver(() => sync())
  mo.observe(doc.body, { childList: true, subtree: true })
  doc.addEventListener('keydown', onKey, true)
  return () => { mo.disconnect(); doc.removeEventListener('keydown', onKey, true) }
}
