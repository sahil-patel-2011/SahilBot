import type { DocBlock } from './types'

// Native decks: a live document whose content.kind is 'slides'. The blocks are the deck, so version history,
// the bot's doc tools (doc_edit, doc_read), merging and autosave work unchanged:
//   a heading (h1/h2/h3)  starts a slide (its title)
//   lists and paragraphs  the slide's points (indent = sub-points)
//   a quote               speaker notes
//   an image              the slide's picture
// Shared by the main process (export, import, the doc tools) and the editor.

export interface SlidePoint { id: string; text: string; indent?: number }
export interface Slide {
  /** The heading block's id (stable while editing). */
  id: string
  title: string
  points: SlidePoint[]
  notes: string
  /** Notes block id, when there is one. */
  notesId?: string
  image?: string
  imageId?: string
}

const HEADINGS = new Set(['h1', 'h2', 'h3'])
const POINTS = new Set(['bullet', 'numbered', 'check', 'p', 'callout'])

/** The deck as slides. Content before the first heading becomes an untitled first slide. */
export function blocksToSlides(blocks: DocBlock[]): Slide[] {
  const slides: Slide[] = []
  let cur: Slide | undefined
  const start = (b?: DocBlock): Slide => { const s: Slide = { id: b?.id ?? 'intro', title: b?.text ?? '', points: [], notes: '' }; slides.push(s); return s }
  for (const b of blocks) {
    if (HEADINGS.has(b.type)) { cur = start(b); continue }
    cur ??= start()
    if (POINTS.has(b.type) && (b.text ?? '').trim()) cur.points.push({ id: b.id, text: b.text ?? '', ...(b.indent ? { indent: b.indent } : {}) })
    else if (b.type === 'quote') { cur.notes = cur.notes ? `${cur.notes}\n${b.text ?? ''}` : b.text ?? ''; cur.notesId ??= b.id }
    else if (b.type === 'image' && b.src) { cur.image = b.src; cur.imageId = b.id }
  }
  return slides
}

/** Slides back to blocks, keeping block ids where they exist (new ones from `newId`). */
export function slidesToBlocks(slides: Slide[], newId: () => string): DocBlock[] {
  const out: DocBlock[] = []
  for (const s of slides) {
    out.push({ id: s.id === 'intro' ? newId() : s.id, type: 'h2', text: s.title })
    for (const p of s.points) out.push({ id: p.id || newId(), type: 'bullet', text: p.text, ...(p.indent ? { indent: p.indent } : {}) })
    if (s.image) out.push({ id: s.imageId || newId(), type: 'image', src: s.image })
    if (s.notes.trim()) out.push({ id: s.notesId || newId(), type: 'quote', text: s.notes })
  }
  return out
}

/** The PowerPoint layout that fits a slide (docs/pptx.ts SlideLayout). */
export function slideLayout(s: Slide, index: number): 'title' | 'bullets' | 'image' | 'image_text' | 'section' {
  if (s.image) return s.points.length ? 'image_text' : 'image'
  if (index === 0 && s.points.length <= 1) return 'title'
  if (!s.points.length) return 'section'
  return 'bullets'
}

/** Plain text of inline Markdown (bold, italics, links, code) for thumbnails and exports. */
export const plainInline = (s: string): string => s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_`~]/g, '')
