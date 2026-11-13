import type { Space } from '@shared/types'

/** Bot details panel (right side): profile, routines, library. Spec: design/bot-ui.md. */
export function BotDetails(p: { space: Space; threadId: string | null; onClose: () => void; onCustomize: () => void; onChanged: () => void; onEditRoutine: (text: string) => void }) {
  return (
    <aside className="bot-details" data-testid="bot-details">
      <button className="icon-btn" onClick={p.onClose}>×</button>
      <h3>{p.space.name}</h3>
    </aside>
  )
}
