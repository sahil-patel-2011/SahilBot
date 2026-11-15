import { useEffect, useState } from 'react'

/**
 * Whether you can see this window right now: the page is visible (not minimized, hidden or a background
 * tab) and has focus. In the Mac app that's the window; in SahilBot Server's web UI, the browser tab.
 * Read state only moves while this is true, so a reply that lands while you're in another app stays unread.
 */
export function attending(): boolean {
  if (typeof document === 'undefined') return false
  return document.visibilityState === 'visible' && document.hasFocus()
}

/** attending(), kept up to date (focus, blur and visibility changes; nothing else re-renders). */
export function useAttention(): boolean {
  const [on, setOn] = useState(attending)
  useEffect(() => {
    const check = (): void => setOn(attending())
    window.addEventListener('focus', check)
    window.addEventListener('blur', check)
    document.addEventListener('visibilitychange', check)
    check()
    return () => {
      window.removeEventListener('focus', check)
      window.removeEventListener('blur', check)
      document.removeEventListener('visibilitychange', check)
    }
  }, [])
  return on
}
