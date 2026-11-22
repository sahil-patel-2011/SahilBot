import { useEffect } from 'react'

/** Help → Keyboard Shortcuts (⌘/): every shortcut on one page, grouped by what you're doing. */
const GROUPS: Array<{ title: string; rows: Array<[string, string]> }> = [
  { title: 'Get around', rows: [['⌘N', 'New chat'], ['⌘1 – ⌘9', 'Open a bot (in sidebar order)'], ['⌘K', 'Search chats, bots and settings'], ['⌘F', 'Find in this chat'], ['⌘,', 'Settings'], ['⌘\\', 'Side panel: progress and files'], ['⌘/', 'This list']] },
  { title: 'Write and talk', rows: [['Enter', 'Send'], ['⇧ Enter', 'New line'], ['⌘ Enter', 'While it works: send after it finishes'], ['⌘D', 'Dictate (tap, or hold and let go)'], ['⇧⌘V', 'Talk with your bot'], ['Esc', 'Stop the reply or the voice']] },
  { title: 'Make and manage', rows: [['⇧⌘B', 'New bot'], ['⇧⌘P', 'New project'], ['⇧⌘S', 'Scheduled tasks'], ['⇧⌘E', 'Export this chat'], ['⇧⌘M', 'Max: the strongest answer for the next message']] },
]

const KEY: Record<string, string> = { 'Alt+Space': '⌥ Space', 'Control+Space': '⌃ Space', 'CommandOrControl+Shift+Space': '⇧⌘ Space', 'Alt+Shift+Space': '⌥⇧ Space' }

export function ShortcutsSheet({ quickKey, onClose }: { quickKey?: string; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent): void => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); onClose() } }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal shortcuts-sheet" role="dialog" aria-label="Keyboard shortcuts" data-testid="shortcuts-sheet">
        <h2>Keyboard shortcuts</h2>
        <div className="sc-grid">
          {[...GROUPS, ...(quickKey && KEY[quickKey] ? [{ title: 'Anywhere on your Mac', rows: [[KEY[quickKey], 'Quick Ask: a small SahilBot bar over any app']] as Array<[string, string]> }] : [])].map((g) => (
            <section key={g.title} className="sc-group">
              <h3>{g.title}</h3>
              {g.rows.map(([key, what]) => <div key={key} className="sc-row"><span>{what}</span><kbd>{key}</kbd></div>)}
            </section>
          ))}
        </div>
        <div className="modal-actions"><button className="btn primary" onClick={onClose} autoFocus>Done</button></div>
      </div>
    </div>
  )
}
