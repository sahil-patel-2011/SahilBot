/**
 * The on/off switch used across Settings. Its own module so a page outside Settings (a project's
 * Knowledge card) can use it without pulling the whole Settings chunk into the first paint.
 */
export function Toggle({ on, onChange, label, testId }: { on: boolean; onChange: (v: boolean) => void; label?: string; testId?: string }) {
  return <button role="switch" aria-checked={on} aria-label={label} className={`switch${on ? ' on' : ''}`} onClick={() => onChange(!on)} data-testid={testId}><i /></button>
}
