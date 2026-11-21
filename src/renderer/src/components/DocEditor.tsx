import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { DOC_FONTS, type DocBlock, type DocBlockType, type DocContent, type DocDiff, type DocExportFormat, type DocInfo, type DocSnapshot, type DocStyle, type DocVersionInfo } from '@shared/types'
import { api } from '../api'
import { toast } from '../lib/toast'
import * as I from '../icons'
import { listNumbers, markdownToBlocks, newId } from '../../../main/docspace/markdown'
import { inlinePlain } from '../../../main/docspace/inline'
import { merge3 } from '../../../main/docspace/merge'
import { BlockBody, BlockStatic, TYPE_LABEL, type BlockCtx } from './doc/Blocks'
import { SheetView } from './doc/SheetView'
import { SlidesView } from './doc/SlidesView'
import { ago, DocIcon, useThreadDocs } from './doc/DocCard'
import { caretOffset, caretOnEdgeLine, deleteLeading, htmlToInline, isCollapsed, selectionTextIn, setCaret, splitAtCaret, textLength } from './doc/dom'

// Docs: the Document tab. A block editor (headings, lists, checklists, quotes, callouts, code, tables,
// dividers, images) or a sheet, shared with the bot: its edits land live and flash in the bot's color,
// yours autosave as versions, and the history shows every version with a diff and restore.

const LIST = new Set<DocBlockType>(['bullet', 'numbered', 'check'])
const TEXTY = new Set<DocBlockType>(['p', 'h1', 'h2', 'h3', 'bullet', 'numbered', 'check', 'quote', 'callout'])
const SAVE_MS = 700

type Mode = 'type' | 'struct'

/** A block turned into another type, keeping its text where that makes sense. */
function convert(b: DocBlock, type: DocBlockType): DocBlock {
  const text = b.type === 'table' ? (b.rows ?? []).map((r) => r.join(' ')).join(' ') : b.type === 'code' ? (b.text ?? '').replace(/\n/g, ' ') : b.text ?? ''
  const out: DocBlock = { id: b.id, type }
  if (type === 'table') { out.rows = [[inlinePlain(text) || '', ''], ['', '']]; out.header = true; return out }
  if (type === 'divider') return out
  if (type === 'image') { out.src = b.src ?? ''; return out }
  out.text = type === 'code' ? inlinePlain(text) : text
  if (LIST.has(type) && LIST.has(b.type) && b.indent) out.indent = b.indent
  if (type === 'check') out.checked = false
  if (type === 'callout') out.tone = b.tone ?? 'info'
  if (type === 'code' && b.lang) out.lang = b.lang
  return out
}

const tidy = (b: DocBlock): DocBlock => Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) as unknown as DocBlock

const SLASH: Array<{ type: DocBlockType; hint: string; keys: string }> = [
  { type: 'p', hint: 'Plain text', keys: 'text paragraph' },
  { type: 'h1', hint: 'Big section heading', keys: 'heading title h1' },
  { type: 'h2', hint: 'Medium heading', keys: 'heading subtitle h2' },
  { type: 'h3', hint: 'Small heading', keys: 'heading h3' },
  { type: 'bullet', hint: 'A simple list', keys: 'bullet list ul' },
  { type: 'numbered', hint: 'A list with numbers', keys: 'numbered list ol' },
  { type: 'check', hint: 'Track tasks', keys: 'todo checklist task checkbox' },
  { type: 'quote', hint: 'A quotation', keys: 'quote blockquote' },
  { type: 'callout', hint: 'Make it stand out', keys: 'callout note tip warning' },
  { type: 'code', hint: 'Code with a language', keys: 'code snippet' },
  { type: 'table', hint: 'Rows and columns', keys: 'table grid' },
  { type: 'divider', hint: 'A line between sections', keys: 'divider line hr separator' },
  { type: 'image', hint: 'A picture from your Mac', keys: 'image picture photo' }
]

const EXPORTS: Record<'doc' | 'sheet' | 'slides', Array<{ f: DocExportFormat; label: string }>> = {
  slides: [{ f: 'pptx', label: 'PowerPoint (.pptx)' }, { f: 'pdf', label: 'PDF' }, { f: 'md', label: 'Markdown (.md)' }],
  doc: [{ f: 'docx', label: 'Word (.docx)' }, { f: 'pdf', label: 'PDF' }, { f: 'md', label: 'Markdown (.md)' }, { f: 'html', label: 'Web page (.html)' }],
  sheet: [{ f: 'xlsx', label: 'Excel (.xlsx)' }, { f: 'csv', label: 'CSV' }, { f: 'pdf', label: 'PDF' }, { f: 'md', label: 'Markdown table' }]
}

/** The Document tab: the chat's documents (a switcher when there are several) and the editor. */
export function DocPane({ threadId, docId, onDocId, onAsk, botColor, botName }: {
  threadId: string | null
  docId: string | null
  onDocId: (id: string) => void
  /** Prefills the composer with a quote from the document. */
  onAsk: (text: string, title: string) => void
  botColor?: string | null
  botName?: string
}) {
  const docs = useThreadDocs(threadId)
  const current = docId ?? docs[0]?.id ?? null
  const create = async (type: 'doc' | 'sheet' | 'slides'): Promise<void> => {
    if (!threadId) return
    try { onDocId((await api.docs.create(threadId, type === 'sheet' ? 'Untitled sheet' : type === 'slides' ? 'Untitled deck' : 'Untitled', type)).id) } catch (e) { toast((e as Error).message, 'error') }
  }
  if (!threadId) return <div className="right-body">Open a chat to work on documents with SahilBot.</div>
  if (!current) {
    return (
      <div className="doc-empty" data-testid="doc-empty">
        <DocIcon size={30} />
        <b>No documents in this chat yet</b>
        <span>Ask {botName ?? 'SahilBot'} to draft one (“write a project plan we can edit together”), or start one yourself. You both edit the same document, live.</span>
        <div className="row">
          <button className="btn primary" onClick={() => void create('doc')} data-testid="doc-new">New document</button>
          <button className="btn" onClick={() => void create('slides')} data-testid="doc-new-slides">New deck</button>
          <button className="btn" onClick={() => void create('sheet')}>New sheet</button>
        </div>
      </div>
    )
  }
  return <DocEditor key={current} id={current} docs={docs} onDocId={onDocId} onNew={create} onAsk={onAsk} botColor={botColor} botName={botName ?? 'SahilBot'} />
}

function DocEditor({ id, docs, onDocId, onNew, onAsk, botColor, botName }: {
  id: string
  docs: DocInfo[]
  onDocId: (id: string) => void
  onNew: (type: 'doc' | 'sheet' | 'slides') => Promise<void>
  onAsk: (text: string, title: string) => void
  botColor?: string | null
  botName: string
}) {
  const [snap, setSnap] = useState<DocSnapshot | null>(null)
  const [content, setContent] = useState<DocContent | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [status, setStatus] = useState<'saved' | 'saving' | 'unsaved' | 'error'>('saved')
  const [flash, setFlash] = useState<Record<string, number>>({})
  const [ghosts, setGhosts] = useState<Array<{ block: DocBlock; after: string | null; key: number }>>([])
  const [botNote, setBotNote] = useState<{ summary: string; at: number } | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [viewing, setViewing] = useState<{ n: number; against: 'prev' | 'current' } | null>(null)
  const [menu, setMenu] = useState<'export' | 'new' | null>(null)
  const [blockMenu, setBlockMenu] = useState<string | null>(null)
  const [slash, setSlash] = useState<{ id: string; query: string; index: number } | null>(null)
  const [link, setLink] = useState<{ url: string } | null>(null)
  const [ask, setAsk] = useState<{ text: string; top: number; left: number } | null>(null)
  const [fmt, setFmt] = useState({ bold: false, italic: false, strike: false })
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [drop, setDrop] = useState<{ id: string; pos: 'before' | 'after' } | null>(null)
  const [imgs, setImgs] = useState<Record<string, string | null>>({})
  const [exported, setExported] = useState<string | null>(null)
  // The file this document was opened from (Artifacts → Edit), if any: Save to file writes it back.
  const [source, setSource] = useState<string | null>(null)
  useEffect(() => { let alive = true; void api.docs.source?.(id).then((p) => { if (alive) setSource(p) }).catch(() => undefined); return () => { alive = false } }, [id])

  const contentRef = useRef<DocContent | null>(null)
  const snapRef = useRef<DocSnapshot | null>(null)
  /** The content of snapRef's version: the base the editor's changes are made on. */
  const baseRef = useRef<DocContent | null>(null)
  const dirtyRef = useRef(false)
  const savingRef = useRef<Promise<void> | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const els = useRef(new Map<string, HTMLElement>())
  const focusReq = useRef<{ id: string; at: 'start' | 'end' | number } | null>(null)
  const past = useRef<DocContent[]>([])
  const future = useRef<DocContent[]>([])
  const lastPush = useRef(0)
  const linkRange = useRef<{ range: Range; el: HTMLElement } | null>(null)
  const dragId = useRef<string | null>(null)
  const body = useRef<HTMLDivElement>(null)
  const ghostKey = useRef(0)

  const setC = (next: DocContent): void => { contentRef.current = next; setContent(next) }

  // ------------------------------------------------------------ load, save, live updates

  useEffect(() => {
    let alive = true
    api.docs.get(id).then((s) => {
      if (!alive) return
      snapRef.current = s
      baseRef.current = s.content
      setSnap(s)
      setC(s.content)
    }).catch((e: Error) => { if (alive) setErr(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')) })
    return () => { alive = false }
  }, [id])

  const save = useCallback(async (): Promise<void> => {
    clearTimeout(timer.current)
    if (savingRef.current) await savingRef.current
    if (!dirtyRef.current || !snapRef.current || !contentRef.current) return
    const sent = contentRef.current
    const base = snapRef.current.version
    setStatus('saving')
    const run = (async () => {
      try {
        const res = await api.docs.save(id, base, sent)
        snapRef.current = res
        baseRef.current = res.content
        setSnap(res)
        if (contentRef.current === sent) {
          dirtyRef.current = false
          setC(res.content)
          setStatus('saved')
        } else {
          // Typed while saving: keep that typing on top of what was saved.
          setC(merge3(sent, res.content, contentRef.current!))
          timer.current = setTimeout(() => void save(), SAVE_MS)
        }
      } catch (e) {
        setStatus('error')
        toast(`Couldn't save the document: ${(e as Error).message}`, 'error')
      }
    })()
    savingRef.current = run
    await run
    savingRef.current = null
  }, [id])

  const markDirty = (): void => {
    if (!dirtyRef.current) { dirtyRef.current = true; void api.docs.dirty(id, true) }
    setStatus('unsaved')
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void save(), SAVE_MS)
  }

  // Unsaved edits are saved when the editor closes or switches documents.
  useEffect(() => () => { if (dirtyRef.current) void save() }, [save])

  // The bot is about to read or edit: save now.
  useEffect(() => api.docs.onFlush((docId) => {
    if (docId !== id) return
    void save().finally(() => void api.docs.flushed(id))
  }), [id, save])

  // The bot's edits land live: merged with anything unsaved, changed blocks flash, deleted ones fade out.
  useEffect(() => api.docs.onEvent((e) => {
    if (e.docId !== id || e.author !== 'bot') return
    void api.docs.get(id).then((s) => {
      if (s.version <= (snapRef.current?.version ?? 0)) return
      const prev = contentRef.current
      const next = dirtyRef.current && baseRef.current && prev ? merge3(baseRef.current, s.content, prev) : s.content
      snapRef.current = s
      baseRef.current = s.content
      setSnap(s)
      setC(next)
      setFlash((f) => { const g = { ...f }; for (const k of e.changed) g[k] = (g[k] ?? 0) + 1; return g })
      setTimeout(() => setFlash((f) => { const g = { ...f }; for (const k of e.changed) delete g[k]; return g }), 2200)
      if (prev && e.removed.length) {
        const keep = new Set(next.blocks.map((b) => b.id))
        const add = e.removed.map((rid) => {
          const k = prev.blocks.findIndex((b) => b.id === rid)
          let after: string | null = null
          for (let j = k - 1; j >= 0; j--) if (keep.has(prev.blocks[j].id)) { after = prev.blocks[j].id; break }
          return k === -1 ? null : { block: prev.blocks[k], after, key: ++ghostKey.current }
        }).filter((g): g is { block: DocBlock; after: string | null; key: number } => !!g)
        setGhosts((gs) => [...gs, ...add])
        const keys = new Set(add.map((g) => g.key))
        setTimeout(() => setGhosts((gs) => gs.filter((g) => !keys.has(g.key))), 900)
      }
      setBotNote({ summary: e.summary, at: Date.now() })
      // Bring the first change into view if it's off screen.
      requestAnimationFrame(() => {
        const first = e.changed.find((k) => els.current.has(k) || k.startsWith('cell:'))
        const el = first ? (first.startsWith('cell:') ? document.querySelector(`[data-addr="${first.slice(5)}"]`) : els.current.get(first)) : null
        el?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
      })
    }).catch(() => undefined)
  }), [id])

  useEffect(() => {
    if (!botNote) return
    const t = setTimeout(() => setBotNote(null), 6000)
    return () => clearTimeout(t)
  }, [botNote])

  // ------------------------------------------------------------ changes

  const readOnly = !!viewing
  const change = (next: DocContent, mode: Mode): void => {
    const cur = contentRef.current
    if (!cur || readOnly) return
    const now = Date.now()
    if (mode === 'struct' || now - lastPush.current > 1200) {
      past.current.push(cur)
      if (past.current.length > 200) past.current.shift()
      future.current = []
    }
    lastPush.current = mode === 'type' ? now : 0
    setC(next)
    markDirty()
  }
  const blocksNow = (): DocBlock[] => contentRef.current?.blocks ?? []
  const setBlocks = (bs: DocBlock[], mode: Mode): void => { if (contentRef.current) change({ ...contentRef.current, blocks: bs }, mode) }
  const taken = (): Set<string> => new Set(blocksNow().map((b) => b.id))
  const [, bump] = useState(0)
  /** Focuses a block (or "<table>:<row>:<col>" cell) once it has rendered. */
  const focusBlock = (bid: string, at: 'start' | 'end' | number = 'end'): void => { focusReq.current = { id: bid, at }; bump((n) => n + 1) }

  const undo = (redo = false): void => {
    const from = redo ? future.current : past.current
    const to = redo ? past.current : future.current
    const cur = contentRef.current
    const prev = from.pop()
    if (!prev || !cur) return
    to.push(cur)
    lastPush.current = 0
    setC(prev)
    markDirty()
  }

  // Focus requests are applied once the blocks they name have rendered.
  useLayoutEffect(() => {
    const req = focusReq.current
    if (!req) return
    const el = els.current.get(req.id) ?? els.current.get(`${req.id}:0:0`)
    if (!el) return
    focusReq.current = null
    el.focus()
    if (el instanceof HTMLTextAreaElement) { const at = req.at === 'start' ? 0 : req.at === 'end' ? el.value.length : req.at; el.selectionStart = el.selectionEnd = at } else if (el.isContentEditable) setCaret(el, req.at)
  })

  // Selection: the floating "Ask" button and the toolbar's bold/italic state.
  useEffect(() => {
    const onSel = (): void => {
      const root = body.current
      if (!root) return
      const s = selectionTextIn(root)
      if (s && s.text.length > 1) {
        const box = root.getBoundingClientRect()
        setAsk({ text: s.text.slice(0, 2000), top: s.rect.top - box.top + root.scrollTop - 40, left: Math.max(8, Math.min(box.width - 170, s.rect.left - box.left + s.rect.width / 2 - 70)) })
      } else setAsk(null)
      try { setFmt({ bold: document.queryCommandState('bold'), italic: document.queryCommandState('italic'), strike: document.queryCommandState('strikeThrough') }) } catch { /* not in an editor */ }
    }
    document.addEventListener('selectionchange', onSel)
    return () => document.removeEventListener('selectionchange', onSel)
  }, [])

  // Images are shown through the app's file preview (workspace files and ones you attached).
  const imageUrl = (path: string): string | null | undefined => (/^data:image\//.test(path) ? path : imgs[path])
  const imagePaths = (content?.blocks ?? []).filter((b) => b.type === 'image' && b.src).map((b) => b.src!).join('\n')
  const asked = useRef(new Set<string>())
  useEffect(() => {
    for (const p of imagePaths.split('\n').filter(Boolean)) {
      if (asked.current.has(p) || /^data:/.test(p)) continue
      asked.current.add(p)
      void api.files.preview(p).then((x) => setImgs((m) => ({ ...m, [p]: x.kind === 'image' ? x.url : null }))).catch(() => setImgs((m) => ({ ...m, [p]: null })))
    }
  }, [imagePaths])

  // ------------------------------------------------------------ block editing

  const patch = (bid: string, p: Partial<DocBlock>, structural = false): void => {
    setBlocks(blocksNow().map((b) => (b.id === bid ? tidy({ ...b, ...p }) : b)), structural ? 'struct' : 'type')
  }

  const setType = (bid: string, type: DocBlockType): void => {
    const bs = blocksNow()
    const k = bs.findIndex((b) => b.id === bid)
    if (k === -1) return
    const b = bs[k]
    if (type === 'divider' || type === 'image' || type === 'table') {
      void insertSpecial(type, bid)
      return
    }
    const out = [...bs]
    out[k] = convert(b, type === b.type && type !== 'p' ? 'p' : type)
    setBlocks(out, 'struct')
    focusBlock(bid, 'end')
  }

  /** Divider, table or image: replaces an empty paragraph, else goes after the block. */
  const insertSpecial = async (type: 'divider' | 'image' | 'table', afterId: string | null): Promise<void> => {
    let src = ''
    if (type === 'image') {
      const p = await api.docs.addImage().catch((e: Error) => { toast(e.message, 'error'); return null })
      if (!p) return
      src = p
    }
    const bs = blocksNow()
    const t = taken()
    const k = afterId ? bs.findIndex((b) => b.id === afterId) : bs.length - 1
    const at = bs[k]
    const replace = at && at.type === 'p' && !(at.text ?? '').trim()
    const nb: DocBlock = type === 'table' ? { id: replace ? at.id : newId(t), type, rows: [['', '', ''], ['', '', ''], ['', '', '']], header: true }
      : type === 'image' ? { id: replace ? at.id : newId(t), type, src } : { id: replace ? at.id : newId(t), type }
    const out = [...bs]
    const tail: DocBlock[] = []
    // A divider or image at the end gets a paragraph after it to keep typing in.
    if (type !== 'table' && (k === bs.length - 1 || k === -1)) tail.push({ id: newId(t), type: 'p', text: '' })
    if (replace) out.splice(k, 1, nb, ...tail)
    else out.splice(k + 1, 0, nb, ...tail)
    setBlocks(out, 'struct')
    focusBlock(type === 'table' ? nb.id : tail[0]?.id ?? nb.id, 'start')
  }

  const removeBlock = (bid: string): void => {
    const bs = blocksNow()
    const k = bs.findIndex((b) => b.id === bid)
    if (k === -1) return
    const out = bs.filter((b) => b.id !== bid)
    if (!out.length) out.push({ id: newId(taken()), type: 'p', text: '' })
    setBlocks(out, 'struct')
    const near = out[Math.max(0, k - 1)]
    if (near) focusBlock(near.id, 'end')
  }

  const addAfter = (bid: string): void => {
    const bs = blocksNow()
    const k = bs.findIndex((b) => b.id === bid)
    const nb: DocBlock = { id: newId(taken()), type: 'p', text: '' }
    const out = [...bs]
    out.splice(k + 1, 0, nb)
    setBlocks(out, 'struct')
    focusBlock(nb.id, 'start')
  }

  const nav = (bid: string, dir: 'up' | 'down'): void => {
    const bs = blocksNow()
    const k = bs.findIndex((b) => b.id === bid)
    const to = bs[dir === 'up' ? k - 1 : k + 1]
    if (to) {
      if (to.type === 'table') {
        const rows = to.rows ?? [['']]
        focusBlock(dir === 'up' ? `${to.id}:${rows.length - 1}:0` : `${to.id}:0:0`, dir === 'up' ? 'end' : 'start')
      } else focusBlock(to.id, dir === 'up' ? 'end' : 'start')
      setCurrentId(to.id)
    } else if (dir === 'down' && bs[k] && bs[k].type !== 'p') addAfter(bid)
  }

  const move = (ids: string[], anchor: string, pos: 'before' | 'after'): void => {
    if (ids.includes(anchor)) return
    const bs = blocksNow()
    const set = new Set(ids)
    const moving = bs.filter((b) => set.has(b.id))
    const rest = bs.filter((b) => !set.has(b.id))
    const k = rest.findIndex((b) => b.id === anchor)
    rest.splice(pos === 'after' ? k + 1 : k, 0, ...moving)
    setBlocks(rest, 'struct')
  }

  const exec = (cmd: string, value?: string): void => { document.execCommand(cmd, false, value) }

  const toggleCode = (): void => {
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount) return
    const r = sel.getRangeAt(0)
    const host = (r.commonAncestorContainer instanceof HTMLElement ? r.commonAncestorContainer : r.commonAncestorContainer.parentElement)?.closest('[contenteditable="true"]') as HTMLElement | null
    if (!host) return
    const inCode = (r.startContainer.parentElement?.closest('code') ?? null) as HTMLElement | null
    if (inCode && host.contains(inCode)) {
      inCode.replaceWith(document.createTextNode(inCode.textContent ?? ''))
    } else {
      if (r.collapsed) return
      const code = document.createElement('code')
      code.appendChild(r.extractContents())
      r.insertNode(code)
      sel.removeAllRanges()
      const after = document.createRange()
      after.setStartAfter(code)
      after.collapse(true)
      sel.addRange(after)
    }
    host.dispatchEvent(new Event('input', { bubbles: true }))
  }

  const openLink = (): void => {
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount) return
    const r = sel.getRangeAt(0)
    const el = (r.startContainer instanceof HTMLElement ? r.startContainer : r.startContainer.parentElement)?.closest('[contenteditable="true"]') as HTMLElement | null
    if (!el) { toast('Put the cursor in the text first (select words to turn them into a link).'); return }
    linkRange.current = { range: r.cloneRange(), el }
    const a = r.startContainer.parentElement?.closest('a')
    setLink({ url: a?.getAttribute('href') ?? '' })
  }

  const applyLink = (url: string): void => {
    const saved = linkRange.current
    setLink(null)
    if (!saved) return
    saved.el.focus()
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(saved.range)
    const u = url.trim()
    if (!u) { exec('unlink'); return }
    const href = /^(https?:|mailto:)/i.test(u) ? u : /^[\w.+-]+@[\w-]+\.[\w.]+$/.test(u) ? `mailto:${u}` : `https://${u}`
    if (saved.range.collapsed) {
      const esc = href.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
      exec('insertHTML', `<a href="${esc}">${esc}</a>`)
    } else exec('createLink', href)
  }

  const enter = (b: DocBlock, el: HTMLElement): void => {
    const bs = blocksNow()
    const k = bs.findIndex((x) => x.id === b.id)
    const md = htmlToInline(el)
    const empty = md === ''
    if (empty && LIST.has(b.type)) {
      const out = [...bs]
      out[k] = b.indent ? { ...b, indent: b.indent - 1 || undefined } : convert(b, 'p')
      setBlocks(out.map(tidy), 'struct')
      focusBlock(b.id, 'start')
      return
    }
    if (empty && (b.type === 'quote' || b.type === 'callout')) {
      const out = [...bs]
      out[k] = convert(b, 'p')
      setBlocks(out, 'struct')
      focusBlock(b.id, 'start')
      return
    }
    const nextType: DocBlockType = LIST.has(b.type) ? b.type : 'p'
    const t = taken()
    const fresh = (text: string): DocBlock => tidy({ id: newId(t), type: nextType, text, ...(LIST.has(b.type) && b.indent ? { indent: b.indent } : {}), ...(b.type === 'check' ? { checked: false } : {}) })
    if (!empty && caretOffset(el) === 0 && isCollapsed()) {
      const out = [...bs]
      out.splice(k, 0, fresh(''))
      setBlocks(out, 'struct')
      focusBlock(b.id, 'start')
      return
    }
    const { before, after } = splitAtCaret(el)
    const nb = fresh(after)
    const out = [...bs]
    out[k] = { ...b, text: before }
    out.splice(k + 1, 0, nb)
    setBlocks(out, 'struct')
    focusBlock(nb.id, 'start')
  }

  const backspaceAtStart = (b: DocBlock, el: HTMLElement): boolean => {
    const bs = blocksNow()
    const k = bs.findIndex((x) => x.id === b.id)
    if (b.type !== 'p') {
      const out = [...bs]
      out[k] = LIST.has(b.type) && b.indent ? tidy({ ...b, indent: b.indent - 1 || undefined }) : convert(b, 'p')
      setBlocks(out, 'struct')
      focusBlock(b.id, 'start')
      return true
    }
    const prev = bs[k - 1]
    if (!prev) return false
    const md = htmlToInline(el)
    if (TEXTY.has(prev.type)) {
      const at = inlinePlain(prev.text ?? '').length
      const out = bs.filter((x) => x.id !== b.id).map((x) => (x.id === prev.id ? { ...x, text: `${x.text ?? ''}${md}` } : x))
      setBlocks(out, 'struct')
      focusBlock(prev.id, at)
      return true
    }
    if (!md) { removeBlock(b.id); if (prev.type === 'table') focusBlock(`${prev.id}:${(prev.rows?.length ?? 1) - 1}:0`, 'end'); return true }
    if (prev.type === 'divider' || prev.type === 'image') { setBlocks(bs.filter((x) => x.id !== prev.id), 'struct'); focusBlock(b.id, 'start'); return true }
    focusBlock(prev.id, 'end')
    return true
  }

  const mergeNext = (b: DocBlock, el: HTMLElement): boolean => {
    const bs = blocksNow()
    const k = bs.findIndex((x) => x.id === b.id)
    const next = bs[k + 1]
    if (!next || !TEXTY.has(next.type)) return false
    const md = htmlToInline(el)
    const at = inlinePlain(md).length
    setBlocks(bs.filter((x) => x.id !== next.id).map((x) => (x.id === b.id ? { ...x, text: `${md}${next.text ?? ''}` } : x)), 'struct')
    focusBlock(b.id, at)
    return true
  }

  const slashItems = useMemo(() => {
    const q = slash?.query.toLowerCase().trim() ?? ''
    return SLASH.filter((s) => !q || TYPE_LABEL[s.type].toLowerCase().includes(q) || s.keys.includes(q))
  }, [slash?.query])

  const pickSlash = (type: DocBlockType): void => {
    if (!slash) return
    const bid = slash.id
    setSlash(null)
    const bs = blocksNow()
    const k = bs.findIndex((b) => b.id === bid)
    if (k === -1) return
    const out = [...bs]
    out[k] = { ...out[k], text: '' }
    if (type === 'divider' || type === 'image' || type === 'table') {
      contentRef.current = { ...contentRef.current!, blocks: out }
      void insertSpecial(type, bid)
      return
    }
    out[k] = convert({ ...out[k], text: '' }, type)
    setBlocks(out, 'struct')
    focusBlock(bid, 'start')
  }

  const onText = (bid: string, md: string, el: HTMLElement): void => {
    const b = blocksNow().find((x) => x.id === bid)
    if (!b) return
    const plain = (el.textContent ?? '').replace(/ /g, ' ')
    // Markdown shortcuts, typed at the start of a paragraph: "# ", "- ", "1. ", "[] ", "> ", "```", "---".
    if (b.type === 'p' || (LIST.has(b.type) && /^\[( |x)?\] /i.test(plain))) {
      const off = caretOffset(el)
      const rules: Array<[RegExp, (m: RegExpMatchArray) => Partial<DocBlock>]> = [
        [/^(#{1,3}) /, (m) => ({ type: `h${m[1].length}` as DocBlockType })],
        [/^[-*+] /, () => ({ type: 'bullet' })],
        [/^1[.)] /, () => ({ type: 'numbered' })],
        [/^\[( |x)?\] /i, (m) => ({ type: 'check', checked: /x/i.test(m[1] ?? '') })],
        [/^> /, () => ({ type: 'quote' })],
        [/^!! /, () => ({ type: 'callout', tone: 'info' })],
        [/^```$/, () => ({ type: 'code', text: '' })]
      ]
      for (const [re, fn] of rules) {
        const m = plain.match(re)
        if (!m || off !== m[0].length) continue
        deleteLeading(el, m[0].length)
        const rest = htmlToInline(el)
        const p = fn(m)
        const conv = { ...convert({ ...b, text: rest }, p.type as DocBlockType), ...p, ...(p.type === 'code' ? { text: inlinePlain(rest) } : {}) }
        setBlocks(blocksNow().map((x) => (x.id === bid ? tidy(conv) : x)), 'struct')
        focusBlock(bid, 'start')
        return
      }
      if (b.type === 'p' && plain === '---') {
        const bs = blocksNow()
        const k = bs.findIndex((x) => x.id === bid)
        const t = taken()
        const nb: DocBlock = { id: newId(t), type: 'p', text: '' }
        const out = [...bs]
        out.splice(k, 1, { id: bid, type: 'divider' }, nb)
        setBlocks(out, 'struct')
        focusBlock(nb.id, 'start')
        return
      }
    }
    if (b.type === 'p' && /^\/[\w ]{0,20}$/.test(plain)) setSlash({ id: bid, query: plain.slice(1), index: 0 })
    else if (slash?.id === bid) setSlash(null)
    setBlocks(blocksNow().map((x) => (x.id === bid ? { ...x, text: md } : x)), 'type')
  }

  const onKey = (e: React.KeyboardEvent, b: DocBlock, el: HTMLElement): void => {
    const mod = e.metaKey || e.ctrlKey
    const k = e.key.toLowerCase()
    if (slash?.id === b.id && slashItems.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const n = slashItems.length
        setSlash({ ...slash, index: (slash.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n })
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickSlash(slashItems[Math.min(slash.index, slashItems.length - 1)].type); return }
      if (e.key === 'Escape') { e.preventDefault(); setSlash(null); return }
    }
    if (mod && !e.shiftKey && k === 'b') { e.preventDefault(); exec('bold'); return }
    if (mod && !e.shiftKey && k === 'i') { e.preventDefault(); exec('italic'); return }
    if (mod && !e.shiftKey && k === 'e') { e.preventDefault(); toggleCode(); return }
    if (mod && e.shiftKey && k === 'x') { e.preventDefault(); exec('strikeThrough'); return }
    if (mod && !e.shiftKey && k === 'k') { e.preventDefault(); openLink(); return }
    if (mod && e.altKey && /^[0-3]$/.test(e.key)) { e.preventDefault(); setType(b.id, e.key === '0' ? 'p' : (`h${e.key}` as DocBlockType)); return }
    if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); exec('insertLineBreak'); return }
    if (e.key === 'Enter' && !e.nativeEvent.isComposing && !mod) { e.preventDefault(); enter(b, el); return }
    if (e.key === 'Backspace' && isCollapsed() && caretOffset(el) === 0) { if (backspaceAtStart(b, el)) e.preventDefault(); return }
    if (e.key === 'Delete' && isCollapsed() && caretOffset(el) === textLength(el)) { if (mergeNext(b, el)) e.preventDefault(); return }
    if (e.key === 'Tab' && LIST.has(b.type)) {
      e.preventDefault()
      const ind = Math.max(0, Math.min(5, (b.indent ?? 0) + (e.shiftKey ? -1 : 1)))
      patch(b.id, { indent: ind || undefined }, true)
      focusBlock(b.id, caretOffset(el) ?? 'end')
      return
    }
    if (e.key === 'ArrowUp' && !e.shiftKey && !mod && caretOnEdgeLine(el, 'first')) {
      const bs = blocksNow()
      const i = bs.findIndex((x) => x.id === b.id)
      if (i > 0) { e.preventDefault(); nav(b.id, 'up') }
      return
    }
    if (e.key === 'ArrowDown' && !e.shiftKey && !mod && caretOnEdgeLine(el, 'last')) {
      const bs = blocksNow()
      const i = bs.findIndex((x) => x.id === b.id)
      if (i < bs.length - 1) { e.preventDefault(); nav(b.id, 'down') }
    }
  }

  const onPaste = (e: React.ClipboardEvent, b: DocBlock, el: HTMLElement): void => {
    const text = e.clipboardData.getData('text/plain')
    e.preventDefault()
    if (!text) return
    if (!text.includes('\n')) { exec('insertText', text); return }
    const parsed = markdownToBlocks(text, { taken: taken() })
    if (!parsed.length) return
    const bs = blocksNow()
    const k = bs.findIndex((x) => x.id === b.id)
    const { before, after } = splitAtCaret(el)
    const out = [...bs]
    out[k] = { ...b, text: before }
    let at = k + 1
    if (!before && b.type === 'p') { out.splice(k, 1); at = k }
    const t = taken()
    parsed.forEach((p) => t.add(p.id))
    const tail: DocBlock[] = after ? [{ id: newId(t), type: LIST.has(b.type) ? b.type : 'p', text: after }] : []
    out.splice(at, 0, ...parsed, ...tail)
    setBlocks(out, 'struct')
    const last = parsed[parsed.length - 1]
    focusBlock(last.type === 'table' ? `${last.id}:0:0` : last.id, 'end')
  }

  const ctx: BlockCtx = {
    readOnly,
    numbers: useMemo(() => listNumbers(content?.blocks ?? []), [content?.blocks]),
    register: (key, el) => { if (el) els.current.set(key, el); else els.current.delete(key) },
    text: onText,
    key: onKey,
    paste: onPaste,
    focus: (bid) => setCurrentId(bid),
    patch,
    remove: removeBlock,
    after: addAfter,
    nav,
    imageUrl
  }

  // ------------------------------------------------------------ toolbar actions

  const target = (): string | null => {
    const bs = blocksNow()
    if (currentId && bs.some((b) => b.id === currentId)) return currentId
    return bs[bs.length - 1]?.id ?? null
  }
  const curBlock = content?.blocks.find((b) => b.id === currentId)

  const setStyle = (patch: Partial<DocStyle>): void => {
    const cur = contentRef.current
    if (!cur) return
    const next: DocStyle = { ...(cur.style ?? {}), ...patch }
    for (const k of Object.keys(next) as Array<keyof DocStyle>) if (next[k] === undefined || next[k] === '') delete next[k]
    change({ ...cur, style: Object.keys(next).length ? next : undefined }, 'struct')
  }
  const saveBack = async (mode: 'replace' | 'copy'): Promise<void> => {
    setMenu(null)
    try {
      await save()
      const { path, replaced } = await api.docs.saveBack(id, mode)
      setExported(path)
      // Slides and plain text can't be written back in their own format: say where it went instead.
      toast(replaced ? 'Saved to the original file (a backup of the old version was kept).' : `Saved as ${path.split('/').pop()} (the original ${source?.split('.').pop() ?? ''} file is unchanged).`)
      setTimeout(() => setExported((p) => (p === path ? null : p)), 10_000)
    } catch (e) { toast((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error') }
  }

  const doExport = async (f: DocExportFormat): Promise<void> => {
    setMenu(null)
    try {
      await save()
      const path = await api.docs.export(id, f)
      setExported(path)
      setTimeout(() => setExported((p) => (p === path ? null : p)), 10_000)
    } catch (e) { toast((e as Error).message, 'error') }
  }

  const restore = async (n: number): Promise<void> => {
    try {
      await save()
      const s = await api.docs.restore(id, n)
      snapRef.current = s
      baseRef.current = s.content
      past.current.push(contentRef.current!)
      setSnap(s)
      setC(s.content)
      setViewing(null)
      toast(`Restored version ${n} (saved as version ${s.version}).`)
    } catch (e) { toast((e as Error).message, 'error') }
  }

  if (err) return <div className="right-body">{err}</div>
  if (!snap || !content) return <div className="right-body"><span className="spin" /></div>

  const isSheet = snap.type === 'sheet'
  const isSlides = !isSheet && content.kind === 'slides'
  const untitled = isSheet ? 'Untitled sheet' : isSlides ? 'Untitled deck' : 'Untitled'
  const statusText = status === 'saving' ? 'Saving…' : status === 'unsaved' ? 'Editing…' : status === 'error' ? "Couldn't save" : 'Saved'
  const style = { '--doc-bot': botColor || 'var(--accent)' } as React.CSSProperties

  // Blocks with the deleted ones fading out where they were.
  const rows: Array<{ ghost: false; b: DocBlock } | { ghost: true; b: DocBlock; key: number }> = []
  const ghostsAfter = (after: string | null): void => { for (const g of ghosts) if (g.after === after) rows.push({ ghost: true, b: g.block, key: g.key }) }
  ghostsAfter(null)
  for (const b of content.blocks) { rows.push({ ghost: false, b }); ghostsAfter(b.id) }

  const tb = (label: string, icon: React.ReactNode, onClick: () => void, o: { pressed?: boolean; testid?: string; disabled?: boolean } = {}): React.ReactNode => (
    <button className={`doc-tb${o.pressed ? ' on' : ''}`} title={label} aria-label={label} aria-pressed={o.pressed} disabled={readOnly || o.disabled}
      onMouseDown={(e) => e.preventDefault()} onClick={onClick} data-testid={o.testid}>{icon}</button>
  )
  const blockType = (t: DocBlockType): void => { const bid = target(); if (bid) setType(bid, t); else void insertSpecial(t as 'divider', null) }

  return (
    <div className="doc-editor" data-testid="doc-editor" data-doc={id} data-version={snap.version} style={style}
      onKeyDownCapture={(e) => {
        const mod = e.metaKey || e.ctrlKey
        const tag = (e.target as HTMLElement).tagName
        if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); void save() } else if (mod && e.key.toLowerCase() === 'z' && tag !== 'INPUT' && tag !== 'TEXTAREA') { e.preventDefault(); undo(e.shiftKey) } else if (e.key === 'Escape' && (menu || blockMenu || link)) { setMenu(null); setBlockMenu(null); setLink(null) }
      }}>
      <div className="doc-top">
        <span className={`doc-top-icon${isSheet ? ' sheet' : ''}`}><DocIcon size={15} sheet={isSheet} /></span>
        {docs.length > 1 ? (
          <select className="doc-switch" value={id} onChange={(e) => onDocId(e.target.value)} aria-label="Document">
            {docs.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
          </select>
        ) : <span className="doc-top-title" title={content.title}>{content.title}</span>}
        <span className={`doc-status s-${status}`} data-testid="doc-status" aria-live="polite">
          {botNote ? <><span className="doc-presence" />{botName} edited · {botNote.summary}</> : <>{statusText} · v{snap.version}</>}
        </span>
        <div className="doc-top-actions">
          <div className="doc-menu-wrap">
            <button className="icon-btn" title="New document" aria-label="New document" onClick={() => setMenu(menu === 'new' ? null : 'new')} aria-expanded={menu === 'new'}><I.Plus size={15} /></button>
            {menu === 'new' && (
              <div className="doc-menu" role="menu">
                <button role="menuitem" onClick={() => { setMenu(null); void onNew('doc') }}><DocIcon size={14} /> New document</button>
                <button role="menuitem" onClick={() => { setMenu(null); void onNew('slides') }}><SlidesIcon /> New deck</button>
                <button role="menuitem" onClick={() => { setMenu(null); void onNew('sheet') }}><DocIcon size={14} sheet /> New sheet</button>
              </div>
            )}
          </div>
          <button className={`icon-btn${historyOpen ? ' on' : ''}`} title="Version history" aria-label="Version history" aria-pressed={historyOpen}
            onClick={() => { setHistoryOpen(!historyOpen); if (historyOpen) setViewing(null) }} data-testid="doc-history-toggle"><I.Clock size={15} /></button>
          {source && (
            <button className="btn primary doc-save-back" onClick={() => void saveBack('replace')} title={`Save your edits back to ${source.split('/').pop()} (the old version is kept in .sahilbot-backups)`} data-testid="doc-save-back">Save to file</button>
          )}
          <div className="doc-menu-wrap">
            <button className="btn doc-export-btn" onClick={() => setMenu(menu === 'export' ? null : 'export')} aria-expanded={menu === 'export'} aria-haspopup="menu" data-testid="doc-export">
              <I.Share size={13} /> Export
            </button>
            {menu === 'export' && (
              <div className="doc-menu right" role="menu">
                {EXPORTS[isSheet ? 'sheet' : isSlides ? 'slides' : 'doc'].map((x) => <button key={x.f} role="menuitem" onClick={() => void doExport(x.f)} data-testid={`doc-export-${x.f}`}>{x.label}</button>)}
                {source && <button role="menuitem" onClick={() => void saveBack('copy')} data-testid="doc-save-copy">Save a copy next to the original</button>}
              </div>
            )}
          </div>
        </div>
      </div>

      {isSlides && !viewing && (
        <div className="doc-toolbar" role="toolbar" aria-label="Deck style">
          <select className="doc-style doc-font" aria-label="Font" title="Font for the slides and the PowerPoint file" value={content.style?.font ?? ''} disabled={readOnly} onChange={(e) => setStyle({ font: e.target.value || undefined })} data-testid="doc-font">
            <option value="">Theme font</option>
            {DOC_FONTS.map((f) => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
          </select>
          <select className="doc-style doc-theme" aria-label="Theme" title="Colors and type for the slides and the PowerPoint file" value={content.style?.theme ?? ''} disabled={readOnly} onChange={(e) => setStyle({ theme: (e.target.value || undefined) as DocStyle['theme'] })} data-testid="doc-theme">
            <option value="">Theme: Modern</option><option value="classic">Classic</option><option value="minimal">Minimal</option>
          </select>
          <span className="muted small" title="Ask SahilBot in the chat to draft, rework or add slides">Type on a slide to edit it</span>
        </div>
      )}

      {!isSheet && !isSlides && !viewing && (
        <div className="doc-toolbar" role="toolbar" aria-label="Formatting">
          <select className="doc-style" aria-label="Text style" value={curBlock && ['p', 'h1', 'h2', 'h3'].includes(curBlock.type) ? curBlock.type : ''}
            onChange={(e) => { const bid = target(); if (bid && e.target.value) setType(bid, e.target.value as DocBlockType) }}>
            <option value="" disabled>Style</option>
            <option value="p">Text</option><option value="h1">Heading 1</option><option value="h2">Heading 2</option><option value="h3">Heading 3</option>
          </select>
          <select className="doc-style doc-font" aria-label="Font" title="Font (the editor and Word / PDF exports)" value={content.style?.font ?? ''} disabled={readOnly} onChange={(e) => setStyle({ font: e.target.value || undefined })} data-testid="doc-font">
            <option value="">Default font</option>
            {DOC_FONTS.map((f) => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
          </select>
          <select className="doc-style doc-size" aria-label="Text size" title="Text size in points" value={content.style?.size ?? ''} disabled={readOnly} onChange={(e) => setStyle({ size: e.target.value ? Number(e.target.value) : undefined })} data-testid="doc-size">
            <option value="">Size</option>
            {[9, 10, 10.5, 11, 12, 13, 14, 16].map((n) => <option key={n} value={n}>{n} pt</option>)}
          </select>
          <select className="doc-style doc-theme" aria-label="Theme" title="Theme for exports: headings, tables and accents" value={content.style?.theme ?? ''} disabled={readOnly} onChange={(e) => setStyle({ theme: (e.target.value || undefined) as DocStyle['theme'] })} data-testid="doc-theme">
            <option value="">Theme</option><option value="modern">Modern</option><option value="classic">Classic</option><option value="minimal">Minimal</option>
          </select>
          <span className="doc-sep" />
          {tb('Bold (⌘B)', <b>B</b>, () => exec('bold'), { pressed: fmt.bold })}
          {tb('Italic (⌘I)', <i>I</i>, () => exec('italic'), { pressed: fmt.italic })}
          {tb('Strikethrough (⌘⇧X)', <s>S</s>, () => exec('strikeThrough'), { pressed: fmt.strike })}
          {tb('Inline code (⌘E)', <span className="mono">{'</>'}</span>, toggleCode)}
          {tb('Link (⌘K)', <LinkIcon />, openLink)}
          <span className="doc-sep" />
          {tb('Bulleted list ("- ")', <I.ListIcon size={15} />, () => blockType('bullet'), { pressed: curBlock?.type === 'bullet' })}
          {tb('Numbered list ("1. ")', <span className="mono small">1.</span>, () => blockType('numbered'), { pressed: curBlock?.type === 'numbered' })}
          {tb('Checklist ("[] ")', <I.Check size={15} />, () => blockType('check'), { pressed: curBlock?.type === 'check' })}
          {tb('Quote ("> ")', <span className="big">”</span>, () => blockType('quote'), { pressed: curBlock?.type === 'quote' })}
          {tb('Callout', <span className="small">ℹ︎</span>, () => blockType('callout'), { pressed: curBlock?.type === 'callout' })}
          {tb('Code block ("```")', <span className="mono small">{'{ }'}</span>, () => blockType('code'), { pressed: curBlock?.type === 'code' })}
          <span className="doc-sep" />
          {tb('Table', <TableIcon />, () => void insertSpecial('table', target()), { testid: 'doc-insert-table' })}
          {tb('Divider ("---")', <span className="small">—</span>, () => void insertSpecial('divider', target()))}
          {tb('Image', <I.Image size={15} />, () => void insertSpecial('image', target()))}
          {link && (
            <form className="doc-link-form" onSubmit={(e) => { e.preventDefault(); applyLink(link.url) }}>
              <input autoFocus value={link.url} placeholder="Paste a link, then Enter" onChange={(e) => setLink({ url: e.target.value })} aria-label="Link address"
                onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setLink(null); linkRange.current?.el.focus() } }} />
              <button type="submit" className="btn primary">{link.url ? 'Apply' : 'Remove'}</button>
            </form>
          )}
        </div>
      )}

      {exported && (
        <div className="doc-exported" role="status">
          <I.Check size={13} /> Saved <b title={exported}>{exported.split('/').pop()}</b>
          <span className="spacer" />
          <button className="btn" onClick={() => void api.files.open(exported)}>Open</button>
          <button className="btn" onClick={() => void api.files.reveal(exported)}>Show in Finder</button>
        </div>
      )}

      <div className="doc-main">
        <div className="doc-scroll" ref={body} onMouseDown={(e) => { if (e.target === e.currentTarget && !isSlides && content.blocks.length) { e.preventDefault(); const last = content.blocks[content.blocks.length - 1]; if (TEXTY.has(last.type)) focusBlock(last.id, 'end'); else addAfter(last.id) } }}>
          {viewing ? (
            <VersionView id={id} n={viewing.n} current={snap.version} against={viewing.against} onAgainst={(a) => setViewing({ ...viewing, against: a })}
              onRestore={() => void restore(viewing.n)} onClose={() => setViewing(null)} isSheet={isSheet} />
          ) : (
            <div className={`doc-paper${isSlides ? ' deck' : ''}`}>
              <input className={`doc-title${flash.title ? ` doc-flash-${flash.title % 2}` : ''}`} value={content.title === untitled || content.title === 'Untitled' ? '' : content.title} placeholder={untitled}
                aria-label="Title" data-testid="doc-title"
                onChange={(e) => change({ ...content, title: e.target.value || untitled }, 'type')}
                onKeyDown={(e) => { if (e.key === 'Enter' || (e.key === 'ArrowDown' && !isSheet && !isSlides)) { e.preventDefault(); const first = content.blocks[0]; if (first && !isSlides) focusBlock(first.id, 'start') } }} />
              {isSlides ? (
                <SlidesView blocks={content.blocks} style={content.style} flash={flash} readOnly={readOnly} imageUrl={imageUrl}
                  onChange={(bs, mode) => setBlocks(bs, mode)}
                  addImage={() => api.docs.addImage().catch((e: Error) => { toast(e.message, 'error'); return null })} />
              ) : isSheet ? (
                <SheetView sheet={content.sheet ?? { rows: 20, cols: 6, cells: {}, header: true }} flash={flash} readOnly={readOnly}
                  onChange={(next, structural) => change({ ...content, sheet: next }, structural ? 'struct' : 'type')} />
              ) : (
                <div className="doc-blocks" role="document" aria-label={content.title} style={{ ...(content.style?.font ? { fontFamily: `"${content.style.font}", var(--font)` } : {}), ...(content.style?.size ? { fontSize: `${Math.round(content.style.size * 4 / 3)}px` } : {}) }}>
                  {rows.map((r) => r.ghost ? (
                    <div key={`ghost-${r.key}`} className="doc-row doc-ghost" aria-hidden><BlockStatic b={r.b} /></div>
                  ) : (
                    <div key={r.b.id} data-testid="doc-block" data-id={r.b.id} data-type={r.b.type}
                      className={[
                        'doc-row', `k-${r.b.type}`, LIST.has(r.b.type) ? 'k-list' : '',
                        flash[r.b.id] ? `doc-flash-${flash[r.b.id] % 2}` : '',
                        drop?.id === r.b.id ? `drop-${drop.pos}` : '', currentId === r.b.id ? 'cur' : ''
                      ].filter(Boolean).join(' ')}
                      style={LIST.has(r.b.type) && r.b.indent ? { paddingLeft: `${r.b.indent * 24}px` } : undefined}
                      onDragOver={(e) => {
                        if (!dragId.current) return
                        e.preventDefault()
                        const box = e.currentTarget.getBoundingClientRect()
                        setDrop({ id: r.b.id, pos: e.clientY < box.top + box.height / 2 ? 'before' : 'after' })
                      }}
                      onDrop={(e) => { e.preventDefault(); if (dragId.current && drop) move([dragId.current], drop.id, drop.pos); dragId.current = null; setDrop(null) }}>
                      <div className="doc-gutter">
                        <button className="doc-handle" draggable aria-label={`${TYPE_LABEL[r.b.type]} block menu (drag to move)`} title="Drag to move · click for options"
                          onDragStart={(e) => { dragId.current = r.b.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', '') }}
                          onDragEnd={() => { dragId.current = null; setDrop(null) }}
                          onClick={() => setBlockMenu(blockMenu === r.b.id ? null : r.b.id)}>⋮⋮</button>
                        {blockMenu === r.b.id && (
                          <BlockMenu b={r.b} onClose={() => setBlockMenu(null)}
                            onType={(t) => { setBlockMenu(null); setType(r.b.id, t) }}
                            onDuplicate={() => { setBlockMenu(null); const bs = blocksNow(); const k = bs.findIndex((x) => x.id === r.b.id); const out = [...bs]; out.splice(k + 1, 0, { ...JSON.parse(JSON.stringify(r.b)) as DocBlock, id: newId(taken()) }); setBlocks(out, 'struct') }}
                            onMove={(d) => { setBlockMenu(null); const bs = blocksNow(); const k = bs.findIndex((x) => x.id === r.b.id); const to = bs[k + d]; if (to) move([r.b.id], to.id, d < 0 ? 'before' : 'after') }}
                            onDelete={() => { setBlockMenu(null); removeBlock(r.b.id) }} />
                        )}
                      </div>
                      <div className="doc-body"><BlockBody b={r.b} ctx={ctx} /></div>
                      {slash?.id === r.b.id && slashItems.length > 0 && (
                        <div className="doc-slash" role="listbox" aria-label="Turn into">
                          {slashItems.map((s, i) => (
                            <button key={s.type} role="option" aria-selected={i === slash.index} className={i === slash.index ? 'on' : ''}
                              onMouseDown={(e) => { e.preventDefault(); pickSlash(s.type) }}>
                              <b>{TYPE_LABEL[s.type]}</b><span>{s.hint}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                  {content.blocks.length === 0 && (
                    <button className="doc-add-first" onClick={() => { const nb: DocBlock = { id: newId(taken()), type: 'p', text: '' }; setBlocks([nb], 'struct'); focusBlock(nb.id) }}>Start writing…</button>
                  )}
                </div>
              )}
            </div>
          )}
          {ask && !viewing && (
            <button className="doc-ask" style={{ top: ask.top, left: ask.left }} data-testid="doc-ask"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { onAsk(ask.text, content.title); setAsk(null); window.getSelection()?.removeAllRanges() }}>
              <I.Sparkle size={13} /> Ask {botName}
            </button>
          )}
        </div>
        {historyOpen && (
          <History id={id} version={snap.version} viewing={viewing?.n ?? null} botName={botName}
            onPick={(n) => setViewing({ n, against: 'prev' })} onClose={() => { setHistoryOpen(false); setViewing(null) }} />
        )}
      </div>
    </div>
  )
}

function BlockMenu({ b, onType, onDuplicate, onMove, onDelete, onClose }: {
  b: DocBlock; onType: (t: DocBlockType) => void; onDuplicate: () => void; onMove: (d: -1 | 1) => void; onDelete: () => void; onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const off = (e: MouseEvent): void => { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    setTimeout(() => document.addEventListener('mousedown', off))
    return () => document.removeEventListener('mousedown', off)
  }, [onClose])
  const turn: DocBlockType[] = ['p', 'h1', 'h2', 'h3', 'bullet', 'numbered', 'check', 'quote', 'callout', 'code']
  return (
    <div className="doc-menu doc-block-menu" role="menu" ref={ref}>
      <div className="doc-menu-label">Turn into</div>
      <div className="doc-turn">
        {turn.map((t) => <button key={t} role="menuitem" className={b.type === t ? 'on' : ''} onClick={() => onType(t)}>{TYPE_LABEL[t]}</button>)}
      </div>
      <hr />
      <button role="menuitem" onClick={() => onMove(-1)}>Move up</button>
      <button role="menuitem" onClick={() => onMove(1)}>Move down</button>
      <button role="menuitem" onClick={onDuplicate}>Duplicate</button>
      <button role="menuitem" className="danger" onClick={onDelete}>Delete</button>
    </div>
  )
}

function History({ id, version, viewing, botName, onPick, onClose }: { id: string; version: number; viewing: number | null; botName: string; onPick: (n: number) => void; onClose: () => void }) {
  const [vs, setVs] = useState<DocVersionInfo[] | null>(null)
  useEffect(() => {
    let alive = true
    api.docs.versions(id).then((x) => { if (alive) setVs(x) }).catch(() => { if (alive) setVs([]) })
    return () => { alive = false }
  }, [id, version])
  return (
    <aside className="doc-history" data-testid="doc-history" aria-label="Version history">
      <div className="doc-history-head"><b>Version history</b><span className="spacer" /><button className="icon-btn" onClick={onClose} aria-label="Close history"><I.Close size={14} /></button></div>
      {!vs && <div className="hint" style={{ padding: 12 }}>Loading…</div>}
      <ol className="doc-versions">
        {vs?.map((v) => (
          <li key={v.n}>
            <button className={`doc-version${viewing === v.n ? ' on' : ''}`} onClick={() => onPick(v.n)} data-testid="doc-version" data-n={v.n}>
              <span className={`doc-who ${v.author}`} aria-hidden />
              <span className="doc-version-text">
                <span className="doc-version-top"><b>v{v.n}</b> {v.author === 'bot' ? botName : 'You'}{v.n === version && <span className="doc-badge">Current</span>}</span>
                <span className="doc-version-sum">{v.summary}</span>
                <span className="hint">{ago(v.at)}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>
    </aside>
  )
}

function VersionView({ id, n, current, against, onAgainst, onRestore, onClose, isSheet }: {
  id: string; n: number; current: number; against: 'prev' | 'current'; onAgainst: (a: 'prev' | 'current') => void; onRestore: () => void; onClose: () => void; isSheet: boolean
}) {
  const [diff, setDiff] = useState<DocDiff | null>(null)
  useEffect(() => {
    let alive = true
    setDiff(null)
    const [a, b] = against === 'current' ? [n, current] : [Math.max(1, n - 1), n]
    api.docs.diff(id, a, b).then((d) => { if (alive) setDiff(d) }).catch(() => undefined)
    return () => { alive = false }
  }, [id, n, current, against])
  const nums = useMemo(() => listNumbers((diff?.rows ?? []).filter((r) => r.status !== 'removed').map((r) => r.block)), [diff])
  return (
    <div className="doc-version-view" data-testid="doc-diff">
      <div className="doc-version-bar">
        <span><b>Version {n}</b> · {against === 'current' ? `compared with now (v${current})` : n === 1 ? 'as first created' : `changes from v${n - 1}`}</span>
        <span className="spacer" />
        <div className="seg-mini" role="group" aria-label="Compare">
          <button className={against === 'prev' ? 'on' : ''} onClick={() => onAgainst('prev')}>Its changes</button>
          <button className={against === 'current' ? 'on' : ''} onClick={() => onAgainst('current')} disabled={n === current}>Vs. now</button>
        </div>
        {n !== current && <button className="btn primary" onClick={onRestore} data-testid="doc-restore">Restore</button>}
        <button className="btn" onClick={onClose}>Back to editing</button>
      </div>
      {!diff ? <span className="spin" /> : (
        <div className="doc-paper doc-diff">
          {diff.title && <div className="doc-diff-title"><del>{diff.title.before}</del> → <ins>{diff.title.after}</ins></div>}
          {isSheet ? (
            diff.cells?.length ? (
              <table className="doc-diff-cells"><thead><tr><th>Cell</th><th>Before</th><th>After</th></tr></thead>
                <tbody>{diff.cells.map((c) => <tr key={c.addr}><td>{c.addr}</td><td><del>{c.before}</del></td><td><ins>{c.after}</ins></td></tr>)}</tbody></table>
            ) : <div className="hint">No cell changes.</div>
          ) : diff.rows.map((r) => (
            <div key={`${r.status}-${r.block.id}`} className={`doc-row diff-${r.status}`}>
              <span className="doc-diff-mark" aria-label={r.status}>{r.status === 'added' ? '+' : r.status === 'removed' ? '−' : r.status === 'changed' ? '~' : ''}</span>
              <div className="doc-body"><BlockStatic b={r.block} num={nums.get(r.block.id)} words={r.status === 'changed' ? r.words : undefined} /></div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const LinkIcon = () => (
  <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden>
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  </svg>
)

const TableIcon = () => (
  <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M3.5 9.5h17M3.5 14.5h17M9.5 4.5v15M15 4.5v15" />
  </svg>
)

function SlidesIcon() {
  return <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M12 17v3M8 21h8" /></svg>
}
