// SahilBot's mascot: a tilted squircle wearing a hard-hat brim, with two dot eyes.
export function Mascot({ size = 96 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-label="SahilBot">
      <g transform="rotate(-10 50 54)">
        <rect x="14" y="24" width="72" height="66" rx="30" fill="var(--text)" />
        <path d="M22 40c4-16 16-24 28-24s24 8 28 24" fill="var(--accent)" />
        <rect x="12" y="37" width="76" height="8" rx="4" fill="var(--accent)" />
        <rect x="47" y="14" width="6" height="10" rx="3" fill="var(--accent)" />
        <ellipse cx="38" cy="62" rx="5" ry="7.5" fill="var(--bg)" />
        <ellipse cx="62" cy="62" rx="5" ry="7.5" fill="var(--bg)" />
      </g>
      <circle cx="80" cy="82" r="11" fill="var(--accent)" stroke="var(--sidebar)" strokeWidth="4" />
      <path d="m80 76 1.8 3.7 4 .6-2.9 2.8.7 4-3.6-1.9-3.6 1.9.7-4-2.9-2.8 4-.6Z" fill="#fff" />
    </svg>
  )
}

const SHAPE_PATHS: Record<string, string> = {
  // rounded triangle pointing up
  triangle: 'M23 7 Q26 2 29 7 L48 41 Q50 46 45 46 L7 46 Q2 46 4 41 Z',
  circle: 'M26 4 A22 22 0 1 1 25.9 4 Z',
  // hexagon
  hex: 'M26 3 L46 14.5 L46 37.5 L26 49 L6 37.5 L6 14.5 Z',
  // tilted rounded slab
  blob: 'M14 12 Q26 6 40 12 Q48 16 46 30 Q44 42 30 44 Q14 46 8 36 Q4 22 14 12 Z',
  // rounded triangle pointing right
  drop: 'M10 10 Q12 4 20 7 L44 20 Q50 24 44 29 L20 44 Q12 48 10 41 Z',
  // tilted rounded square
  square: 'M12 8 L40 6 Q46 6 46 12 L46 40 Q46 46 40 46 L12 46 Q6 46 6 40 L6 14 Q6 8 12 8 Z',
  // mound / pebble
  pebble: 'M6 40 Q8 14 26 10 Q44 8 47 38 Q48 44 40 44 L12 44 Q5 44 6 40 Z',
  star: 'M26 6 Q44 6 46 26 Q46 46 26 46 Q6 46 6 26 Q6 6 26 6 Z'
}

/** Bot avatar: a shape in the bot's color with two eyes. */
export function SpaceAvatar({ color, shape = 'blob', size = 52, group }: { color: string; shape?: string; size?: number; group?: string[] }) {
  if (shape === 'mascot' && !group?.length) return <Mascot size={size} />
  if (group?.length) {
    // Group chats show up to three member colors overlapping.
    return (
      <svg width={size} height={size} viewBox="0 0 52 52" style={{ flex: 'none' }}>
        {group.slice(0, 3).map((c, i) => (
          <g key={i} transform={`translate(${[2, 16, 9][i]} ${[4, 4, 20][i]}) scale(0.55)`}>
            <path d={SHAPE_PATHS.blob} fill={c} stroke="var(--sidebar)" strokeWidth="3" />
          </g>
        ))}
      </svg>
    )
  }
  const eye = isLight(color) ? '#141414' : '#ffffff'
  return (
    <svg width={size} height={size} viewBox="0 0 52 52" style={{ flex: 'none' }}>
      <path d={SHAPE_PATHS[shape] ?? SHAPE_PATHS.blob} fill={color} />
      <ellipse cx="21" cy="22" rx="2.2" ry="3.8" fill={eye} transform="rotate(18 21 22)" />
      <ellipse cx="30" cy="20" rx="2.2" ry="3.8" fill={eye} transform="rotate(18 30 20)" />
    </svg>
  )
}

export const SHAPES = ['mascot', 'blob', 'triangle', 'circle', 'hex', 'drop', 'square', 'pebble', 'star'] as const
export const COLORS = ['#FF4D4F', '#FF8A1F', '#F59E0B', '#A0612F', '#13A10E', '#14B8A6', '#0EA5E9', '#7C5CFF', '#EC4899', '#9CA3AF', '#1F1F1F']

export function isLight(hex: string): boolean {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return false
  const n = parseInt(hex.slice(1), 16)
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255
  return 0.299 * r + 0.587 * g + 0.114 * b > 170
}
