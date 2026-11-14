/**
 * The visible SahilBot cursor: computer use reports each step here and the overlay (a click-through
 * window over every display) shows where it acts. Contract between computer.ts and the overlay.
 * Points are screen points (global coordinates, origin top-left of the main display).
 */
export type OverlayAction =
  | { kind: 'move'; x: number; y: number; label?: string }
  | { kind: 'click'; x: number; y: number; button?: 'left' | 'right'; count?: number; label?: string }
  | { kind: 'drag'; x: number; y: number; x2: number; y2: number; label?: string }
  | { kind: 'scroll'; x: number; y: number; dy: number; label?: string }
  | { kind: 'type'; x?: number; y?: number; text: string; label?: string }
  | { kind: 'key'; keys: string; label?: string }
  | { kind: 'focus'; x: number; y: number; w: number; h: number; label?: string }
  | { kind: 'status'; label: string }
  | { kind: 'done' }

export interface Overlay {
  /** Shows a step. Resolves when its animation has played far enough for the real event to follow. */
  show(a: OverlayAction): Promise<void>
  /** Hides the cursor (run finished or stopped). */
  hide(): void
}

/** Until the overlay is wired, steps aren't shown. */
export const noOverlay: Overlay = { show: async () => undefined, hide: () => undefined }
