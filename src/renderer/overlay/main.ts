import type { OverlayFrame } from '../../main/computer/overlay'

// Draws the SahilBot cursor for one display. The main process sends every step to every display's
// window with that window's origin; this page converts global points to its own and draws what falls
// on it (a glide to another display simply leaves the edge). All text goes in with textContent.

type Pt = { x: number; y: number }
type Msg = { type: 'frame'; frame: OverlayFrame; origin: Pt; displayId: number } | { type: 'hide' }

declare global {
  interface Window { sahilbotOverlay?: { onAction(cb: (msg: unknown) => void): void; stop(): void } }
}

const $ = <T extends Element = HTMLElement>(id: string): T => document.getElementById(id) as unknown as T
const body = document.body
const cursor = $('cursor')
const chip = $('chip')
const box = $('box')
const fx = $('fx')
const trail = $<SVGSVGElement>('trail')
const trailPath = $<SVGPathElement>('trail-path')
const trailStart = $<SVGCircleElement>('trail-start')
const trailEnd = $<SVGCircleElement>('trail-end')
const pill = $('pill')
const pillLabel = $('pill-label')
const pillHint = $('pill-hint')
const stopBtn = $<HTMLButtonElement>('stop')

const EASE = 'cubic-bezier(.22,.8,.26,1)'
/** The arrow's tip inside the cursor graphic. */
const HOT = { x: 3, y: 2 }
const place = (p: Pt): string => `translate(${Math.round(p.x - HOT.x)}px, ${Math.round(p.y - HOT.y)}px)`
const local = (p: Pt, o: Pt): Pt => ({ x: p.x - o.x, y: p.y - o.y })

let lastSeq = 0
let here: Pt | null = null
let move: Animation | null = null
let effectTimer: number | undefined
let idleTimer: number | undefined
let chipTimer: number | undefined
let boxTimer: number | undefined
let trailTimer: number | undefined
let leaveTimer: number | undefined
let reduce = false

function glide(from: Pt, to: Pt, ms: number, easing = EASE): void {
  move?.cancel()
  move = null
  cursor.style.transform = place(to)
  here = to
  if (ms > 0 && (from.x !== to.x || from.y !== to.y)) {
    move = cursor.animate([{ transform: place(from) }, { transform: place(to) }], { duration: ms, easing })
  }
}

function press(): void {
  cursor.classList.add('pressing')
  window.setTimeout(() => cursor.classList.remove('pressing'), 90)
}

function ripple(p: Pt, right: boolean, count: number): void {
  for (let i = 0; i < count; i++) {
    const r = document.createElement('div')
    r.className = right ? 'ring right' : 'ring'
    r.style.left = `${p.x}px`
    r.style.top = `${p.y}px`
    fx.appendChild(r)
    const frames = reduce
      ? [{ opacity: 0.9 }, { opacity: 0 }]
      : [{ transform: 'scale(0.35)', opacity: 0.95 }, { transform: `scale(${right ? 1.5 : 1.9})`, opacity: 0 }]
    const a = r.animate(frames, { duration: reduce ? 300 : 250, delay: i * 110, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'both' })
    a.onfinish = (): void => r.remove()
    a.oncancel = (): void => r.remove()
  }
  if (!reduce) press()
}

function dragTrail(a: Pt, b: Pt, ms: number): void {
  window.clearTimeout(trailTimer)
  trailPath.setAttribute('d', `M${a.x} ${a.y} L${b.x} ${b.y}`)
  trailStart.setAttribute('cx', String(a.x)); trailStart.setAttribute('cy', String(a.y))
  trailEnd.setAttribute('cx', String(b.x)); trailEnd.setAttribute('cy', String(b.y))
  trail.classList.add('show')
  if (!reduce && ms > 0) {
    const len = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y))
    trailPath.animate([{ strokeDashoffset: `${len}`, strokeDasharray: `${len} ${len}` }, { strokeDashoffset: '0', strokeDasharray: `${len} ${len}` }], { duration: ms, easing: 'ease-in-out' })
    trailEnd.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms, easing: 'steps(1, end)' })
    glide(a, b, ms, 'ease-in-out')
  } else {
    glide(a, b, 0)
  }
  trailTimer = window.setTimeout(() => trail.classList.remove('show'), ms + 700)
}

function scrollMarks(p: Pt, dy: number): void {
  const s = document.createElement('div')
  s.className = dy < 0 ? 'scroll' : 'scroll up'
  s.style.left = `${p.x}px`
  s.style.top = `${p.y}px`
  s.append(document.createElement('i'), document.createElement('i'))
  fx.appendChild(s)
  const dir = dy < 0 ? 1 : -1
  const a = reduce
    ? s.animate([{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }], { duration: 700 })
    : s.animate([
      { opacity: 0, transform: 'translateY(0)' },
      { opacity: 1, transform: `translateY(${4 * dir}px)`, offset: 0.25 },
      { opacity: 1, transform: `translateY(${-2 * dir}px)`, offset: 0.55 },
      { opacity: 1, transform: `translateY(${4 * dir}px)`, offset: 0.8 },
      { opacity: 0, transform: `translateY(${8 * dir}px)` }
    ], { duration: 750, easing: 'ease-in-out' })
  a.onfinish = (): void => s.remove()
  a.oncancel = (): void => s.remove()
}

function showChip(text: string, kind: 'typing' | 'key', ms?: number): void {
  window.clearTimeout(chipTimer)
  chip.textContent = text
  chip.className = `chip ${kind} show`
  if (ms) chipTimer = window.setTimeout(hideChip, ms)
}

function hideChip(): void {
  window.clearTimeout(chipTimer)
  chip.classList.remove('show')
}

function showBox(r: { x: number; y: number; width: number; height: number }, ms: number): void {
  window.clearTimeout(boxTimer)
  box.style.left = `${r.x - 3}px`
  box.style.top = `${r.y - 3}px`
  box.style.width = `${Math.max(6, r.width + 6)}px`
  box.style.height = `${Math.max(6, r.height + 6)}px`
  box.classList.add('show')
  boxTimer = window.setTimeout(() => box.classList.remove('show'), ms)
}

function updatePill(f: OverlayFrame, origin: Pt, displayId: number): void {
  const mine = f.pill.displayId === displayId
  pill.classList.toggle('here', mine)
  if (!mine) { pill.classList.remove('ready'); return }
  const r = f.pill.rect
  pill.style.left = `${r.x - origin.x}px`
  pill.style.top = `${r.y - origin.y}px`
  pill.style.maxWidth = `${r.width}px`
  pill.classList.toggle('narrow', r.width < 330)
  pillLabel.textContent = f.label
  pillHint.textContent = f.hint
  stopBtn.disabled = false
  stopBtn.textContent = 'Stop'
  requestAnimationFrame(() => pill.classList.add('ready'))
}

function onFrame(m: Extract<Msg, { type: 'frame' }>): void {
  const f = m.frame
  if (f.seq <= lastSeq) return
  lastSeq = f.seq
  window.clearTimeout(leaveTimer)
  window.clearTimeout(effectTimer)
  window.clearTimeout(idleTimer)
  reduce = f.reduceMotion || matchMedia('(prefers-reduced-motion: reduce)').matches
  body.classList.toggle('reduce', reduce)
  body.classList.remove('leaving', 'idle')
  body.classList.add('on')
  updatePill(f, m.origin, m.displayId)

  const to = f.to ? local(f.to, m.origin) : null
  if (to) {
    body.classList.add('has-cursor')
    glide(f.from ? local(f.from, m.origin) : here ?? to, to, f.moveMs)
  }
  // The typing chip stays through focus and status updates; the pointer acting elsewhere clears it.
  if (f.kind === 'click' || f.kind === 'drag' || f.kind === 'scroll' || f.kind === 'move') hideChip()

  const after = (fn: () => void): void => { if (f.moveMs > 0) effectTimer = window.setTimeout(fn, f.moveMs); else fn() }
  switch (f.kind) {
    case 'click': if (to) after(() => ripple(to, f.button === 'right', f.count ?? 1)); break
    case 'drag': if (to && f.to2) { const end = local(f.to2, m.origin); after(() => dragTrail(to, end, f.tailMs)) } break
    case 'scroll': if (to) after(() => scrollMarks(to, f.dy ?? -1)); break
    case 'type': if (f.chip) after(() => showChip(f.chip!, 'typing', 6000)); break
    case 'key': if (f.chip) showChip(f.chip, 'key', f.tailMs); break
    case 'focus': if (f.box) { const o = local({ x: f.box.x, y: f.box.y }, m.origin); showBox({ x: o.x, y: o.y, width: f.box.width, height: f.box.height }, f.tailMs) } break
    default: break
  }
  // Between steps (the model is thinking) the cursor rests, dimmed.
  idleTimer = window.setTimeout(() => body.classList.add('idle'), Math.max(4000, f.moveMs + f.tailMs + 2500))
}

function onHide(): void {
  window.clearTimeout(effectTimer)
  window.clearTimeout(idleTimer)
  body.classList.add('leaving')
  pill.classList.remove('ready')
  leaveTimer = window.setTimeout(() => {
    body.classList.remove('on', 'leaving', 'has-cursor', 'idle')
    pill.classList.remove('here')
    hideChip()
    box.classList.remove('show')
    trail.classList.remove('show')
    fx.replaceChildren()
    move?.cancel()
    move = null
    here = null
  }, 200)
}

stopBtn.addEventListener('click', () => {
  stopBtn.disabled = true
  stopBtn.textContent = 'Stopping…'
  window.sahilbotOverlay?.stop()
})

window.sahilbotOverlay?.onAction((raw) => {
  const m = raw as Msg
  if (!m || typeof m !== 'object') return
  if (m.type === 'hide') onHide()
  else if (m.type === 'frame' && m.frame) onFrame(m)
})
