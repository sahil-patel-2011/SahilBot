import type { DocBlock } from './types'

// Native decks: a live document whose content.kind is 'slides'. The blocks are the deck, so version history,
// the bot's doc tools (doc_edit, doc_read), merging and autosave work unchanged:
//   a heading (h1/h2/h3)  starts a slide (its title)
//   an h3 right before    the slide's kicker (a small label above the title: "ASSEMBLY GUIDE · NOV 2026")
//     an h1/h2
//   lists and paragraphs  the slide's points (indent = sub-points); "**130** Steps" is a big-number stat;
//                         numbered, checklist, paragraph and callout points keep their type
//   a quote               speaker notes
//   an image              the slide's picture (a second image, a table, code or a divider is kept with the
//                         slide as is, so editing a slide never loses a block the bot or an import put there)
// Shared by the main process (export, import, the doc tools) and the editor.

export interface SlidePoint { id: string; text: string; indent?: number; type?: 'numbered' | 'check' | 'p' | 'callout'; checked?: boolean; tone?: DocBlock['tone'] }
export interface Slide {
  /** The heading block's id (stable while editing). */
  id: string
  title: string
  /** The small label above the title, and its block id. */
  kicker?: string
  kickerId?: string
  points: SlidePoint[]
  notes: string
  /** Notes block id, when there is one. */
  notesId?: string
  image?: string
  imageId?: string
  /** The title's heading level when it isn't h2 (kept as is). */
  level?: 'h1' | 'h3'
  /** Blocks the slide model doesn't edit (tables, code, dividers, a second picture), kept in order. */
  extra?: DocBlock[]
}

const HEADINGS = new Set(['h1', 'h2', 'h3'])
const POINTS = new Set(['bullet', 'numbered', 'check', 'p', 'callout'])

/** The deck as slides. Content before the first heading becomes an untitled first slide. */
export function blocksToSlides(blocks: DocBlock[]): Slide[] {
  const slides: Slide[] = []
  let cur: Slide | undefined
  const start = (b?: DocBlock): Slide => { const s: Slide = { id: b?.id ?? 'intro', title: b?.text ?? '', points: [], notes: '' }; slides.push(s); return s }
  let kicker: DocBlock | undefined
  blocks.forEach((b, i) => {
    const next = blocks[i + 1]
    // An h3 straight before a slide's title is that slide's kicker.
    if (b.type === 'h3' && next && (next.type === 'h1' || next.type === 'h2') && (b.text ?? '').length <= 80) { kicker = b; return }
    if (HEADINGS.has(b.type)) {
      cur = start(b)
      if (b.type === 'h1' || b.type === 'h3') cur.level = b.type
      if (kicker) { cur.kicker = kicker.text ?? ''; cur.kickerId = kicker.id; kicker = undefined }
      return
    }
    cur ??= start()
    // Empty list items stay (the point you just added in the editor); empty paragraphs don't.
    if (POINTS.has(b.type) && ((b.text ?? '').trim() || b.type !== 'p')) {
      cur.points.push({ id: b.id, text: b.text ?? '', ...(b.indent ? { indent: b.indent } : {}), ...(b.type !== 'bullet' ? { type: b.type as SlidePoint['type'] } : {}), ...(b.type === 'check' ? { checked: !!b.checked } : {}), ...(b.type === 'callout' && b.tone ? { tone: b.tone } : {}) })
    } else if (b.type === 'quote') { cur.notes = cur.notes ? `${cur.notes}\n${b.text ?? ''}` : b.text ?? ''; cur.notesId ??= b.id }
    else if (b.type === 'image' && b.src && !cur.image) { cur.image = b.src; cur.imageId = b.id }
    else if (b.type === 'table' || b.type === 'code' || b.type === 'divider' || b.type === 'image') (cur.extra ??= []).push(b)
  })
  return slides
}

/** Slides back to blocks, keeping block ids where they exist (new ones from `newId`). */
export function slidesToBlocks(slides: Slide[], newId: () => string): DocBlock[] {
  const out: DocBlock[] = []
  for (const s of slides) {
    if (s.kicker?.trim()) out.push({ id: s.kickerId || newId(), type: 'h3', text: s.kicker })
    out.push({ id: s.id === 'intro' ? newId() : s.id, type: s.level ?? 'h2', text: s.title })
    for (const p of s.points) {
      const type = p.type ?? 'bullet'
      out.push({ id: p.id || newId(), type, text: p.text, ...(p.indent && type !== 'p' && type !== 'callout' ? { indent: p.indent } : {}), ...(type === 'check' ? { checked: !!p.checked } : {}), ...(type === 'callout' ? { tone: p.tone ?? 'info' } : {}) })
    }
    if (s.image) out.push({ id: s.imageId || newId(), type: 'image', src: s.image })
    for (const b of s.extra ?? []) out.push(b)
    if (s.notes.trim()) out.push({ id: s.notesId || newId(), type: 'quote', text: s.notes })
  }
  return out
}

/** The PowerPoint layout that fits a slide (docs/pptx.ts SlideLayout). */
export function slideLayout(s: Slide, index: number): 'title' | 'bullets' | 'image' | 'image_text' | 'section' {
  const text = textPoints(s)
  if (s.image) return text.length ? 'image_text' : 'image'
  if (index === 0 && text.length <= 3) return 'title'
  if (!s.points.length) return 'section'
  return 'bullets'
}

/** "**130** Steps", "**1,192 g** — Printed parts": a big number and its label. */
export function statOf(text: string): { value: string; label: string } | undefined {
  const m = /^\*\*([^*]{1,16})\*\*\s*(?:[—–:-]\s*)?(.{1,48})$/.exec(text.trim())
  return m && /\d/.test(m[1]) ? { value: m[1].trim(), label: m[2].trim() } : undefined
}
export const statsOf = (s: Slide): Array<{ value: string; label: string }> => s.points.flatMap((p) => { const x = statOf(p.text); return x ? [x] : [] })
export const textPoints = (s: Slide): Slide['points'] => s.points.filter((p) => p.text.trim() && !statOf(p.text))

/** Plain text of inline Markdown (bold, italics, links, code) for thumbnails and exports. */
export const plainInline = (s: string): string => s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_`~]/g, '')

/**
 * What a presenter would fix before sending a deck: overloaded slides, long points, missing or long titles,
 * a title slide with no title. Empty when it's fine. The doc tools hand these back to the agent.
 */
export function deckReview(slides: Slide[]): string[] {
  const out: string[] = []
  if (!slides.length) return ['The deck has no slides.']
  if (slides.length > 30) out.push(`${slides.length} slides is long for a deck: merge or cut to the ones that carry the story.`)
  slides.forEach((s, i) => {
    const n = i + 1
    const text = textPoints(s)
    const title = plainInline(s.title).trim()
    if (!title) out.push(`Slide ${n} has no title.`)
    else if (title.length > 70) out.push(`Slide ${n}'s title is ${title.length} characters: keep it under about 60 (a headline that states the point).`)
    if (text.length > 6) out.push(`Slide ${n} has ${text.length} points: keep 3 to 5 (split it, or move detail to the speaker notes).`)
    const long = text.filter((p) => plainInline(p.text).length > 120)
    if (long.length) out.push(`Slide ${n} has ${long.length} point${long.length > 1 ? 's' : ''} over 120 characters: shorten to one line each, detail in the notes.`)
    if (statsOf(s).length > 5) out.push(`Slide ${n} has ${statsOf(s).length} big numbers: 5 fit on a slide.`)
  })
  return out
}
