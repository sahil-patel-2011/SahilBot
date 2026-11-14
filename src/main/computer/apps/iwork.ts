import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { cellWrites, formatTable, parseRange } from './cells'
import { clip, expandPath, insideRoots, JXA_GET, JXA_PICK, JXA_PICK_DOC, JXA_POSIX, type ActionScope, type AppAction, type AppAdapter, type Args } from './types'

// Numbers, Pages and Keynote through their JXA dictionaries: open, list documents, read cells / text /
// slides, write cells, add slides, export to PDF, save. Edits change the user's document in place
// (write_local; Edit > Undo works in the app); exporting over an existing file asks.

const HEAD = `${JXA_GET}; ${JXA_PICK_DOC}; ${JXA_PICK}; ${JXA_POSIX}`

export const NUMBERS_SCRIPTS = {
  DOCUMENTS: `(a) => { ${HEAD}
    const N = Application('Numbers')
    return N.documents().map((d) => ({ name: d.name(), path: get(() => posix(d.file()), ''), modified: get(() => d.modified(), false),
      sheets: get(() => d.sheets(), []).map((s) => ({ name: s.name(), tables: get(() => s.tables(), []).map((t) => ({ name: t.name(), rows: get(() => t.rowCount(), 0), columns: get(() => t.columnCount(), 0) })) })) }))
  }`,
  READ: `(a) => { ${HEAD}
    const N = Application('Numbers')
    const d = pickDoc(N, a.doc)
    const s = pick(d.sheets, a.sheet, 'sheet')
    const t = pick(s.tables, a.table, 'table')
    const rows = a.range ? a.rows : get(() => t.rowCount(), 0)
    const cols = a.range ? a.cols : get(() => t.columnCount(), 0)
    const r = a.range ? t.ranges.byName(a.range) : t.cellRange
    let vals = get(() => r.cells.formattedValue(), null)
    if (!vals) vals = get(() => r.cells.value(), [])
    const out = []
    const maxRows = Math.min(rows, Math.floor(a.maxCells / Math.max(1, cols)))
    for (let i = 0; i < maxRows; i++) out.push(vals.slice(i * cols, (i + 1) * cols))
    return { doc: d.name(), sheet: s.name(), table: t.name(), rows: rows, cols: cols, values: out, truncated: maxRows < rows }
  }`,
  WRITE: `(a) => { ${HEAD}
    const N = Application('Numbers')
    const d = pickDoc(N, a.doc)
    const s = pick(d.sheets, a.sheet, 'sheet')
    const t = pick(s.tables, a.table, 'table')
    let n = 0
    for (const c of a.writes) { t.cells.byName(c.cell).value = c.value; n++ }
    return { doc: d.name(), sheet: s.name(), table: t.name(), written: n }
  }`
}

export const PAGES_SCRIPTS = {
  DOCUMENTS: `(a) => { ${HEAD}
    const P = Application('Pages')
    return P.documents().map((d) => ({ name: d.name(), path: get(() => posix(d.file()), ''), modified: get(() => d.modified(), false), words: get(() => d.bodyText.words.length, null) }))
  }`,
  READ: `(a) => { ${HEAD}
    const P = Application('Pages')
    const d = pickDoc(P, a.doc)
    return { doc: d.name(), text: String(get(() => d.bodyText(), '') || '').slice(0, a.max) }
  }`
}

export const KEYNOTE_SCRIPTS = {
  DOCUMENTS: `(a) => { ${HEAD}
    const K = Application('Keynote')
    return K.documents().map((d) => ({ name: d.name(), path: get(() => posix(d.file()), ''), modified: get(() => d.modified(), false), slides: get(() => d.slides.length, 0) }))
  }`,
  READ: `(a) => { ${HEAD}
    const K = Application('Keynote')
    const d = pickDoc(K, a.doc)
    const slides = d.slides()
    return { doc: d.name(), slides: slides.slice(0, a.max).map((s, i) => ({ n: i + 1, skipped: get(() => s.skipped(), false), layout: String(get(() => s.baseLayout().name(), '') || ''),
      title: String(get(() => s.defaultTitleItem().objectText(), '') || ''), body: String(get(() => s.defaultBodyItem().objectText(), '') || ''), notes: String(get(() => s.presenterNotes(), '') || '') })), total: slides.length }
  }`,
  LAYOUTS: `(a) => { ${HEAD}
    const K = Application('Keynote')
    const d = pickDoc(K, a.doc)
    return d.masterSlides().map((m) => m.name())
  }`,
  ADD_SLIDE: `(a) => { ${HEAD}
    const K = Application('Keynote')
    const d = pickDoc(K, a.doc)
    let layout = null
    if (a.layout) layout = pick(d.masterSlides, a.layout, 'layout')
    try { d.slides.push(K.Slide(layout ? { baseLayout: layout } : {})) } catch (e) {
      const last = d.slides.length ? d.slides[d.slides.length - 1].baseLayout() : d.masterSlides[0]
      d.slides.push(K.Slide({ baseLayout: last }))
    }
    const s = d.slides[d.slides.length - 1]
    const done = []
    if (a.title) { try { s.defaultTitleItem.objectText = a.title; done.push('title') } catch (e) {} }
    if (a.body) { try { s.defaultBodyItem.objectText = a.body; done.push('body') } catch (e) {} }
    if (a.notes) { try { s.presenterNotes = a.notes; done.push('notes') } catch (e) {} }
    return { doc: d.name(), index: d.slides.length, layout: String(get(() => s.baseLayout().name(), '') || ''), filled: done }
  }`
}

/** Shared by the three apps. */
export const IWORK_SCRIPTS = {
  OPEN: `(a) => { const A = Application(a.app); A.activate(); const d = A.open(Path(a.path)); return { name: d ? d.name() : '' } }`,
  EXPORT_PDF: `(a) => { ${HEAD}
    const A = Application(a.app)
    const d = pickDoc(A, a.doc)
    A.export(d, { to: Path(a.to), as: 'PDF' })
    return { doc: d.name() }
  }`,
  SAVE: `(a) => { ${HEAD}
    const A = Application(a.app)
    const d = pickDoc(A, a.doc)
    d.save()
    return { doc: d.name() }
  }`
}

/** Exporting to a new file in the chat's folders is routine; replacing a file, or writing elsewhere, asks. */
export function exportEffect(a: Args, s: ActionScope): 'write_local' | 'destructive' {
  if (!a.to) return 'destructive'
  return insideRoots(String(a.to), s) && !existsSync(expandPath(String(a.to), s.workspace)) ? 'write_local' : 'destructive'
}

const docArg = { doc: { type: 'string' as const, description: 'open document: name or number (default: the front one)' } }

/** open, documents, export_pdf and save: the same in Numbers, Pages and Keynote (and Office's export rule). */
export function docActions(app: string, kinds: string, listScript: string, list: (r: any[]) => string): Record<string, AppAction> {
  return {
    open: {
      summary: `Open a ${kinds} file`,
      args: { path: { type: 'string', required: true, description: 'the file' } },
      effect: 'write_local',
      describe: (a) => `Open ${a.path} in ${app}`,
      async run(a, env) {
        const p = expandPath(a.path, env.workspace)
        if (!existsSync(p)) throw new Error(`Not found: ${p}`)
        const r = await env.jxa<{ name: string }>(IWORK_SCRIPTS.OPEN, { app, path: p }, 60_000)
        return { text: `Opened ${p} in ${app}${r?.name ? ` ("${r.name}")` : ''}.`, display: `opened ${basename(p)}`, path: p }
      }
    },
    documents: {
      summary: 'Open documents (and their sheets/tables or slide counts)',
      effect: 'read',
      needsRunning: true,
      describe: () => `List ${app}'s open documents`,
      async run(_a, env) {
        const r = await env.jxa<any[]>(listScript, {})
        return { text: r?.length ? list(r) : `No documents are open in ${app}.`, display: `${r?.length ?? 0} open` }
      }
    },
    export_pdf: {
      summary: 'Export a document to PDF',
      args: { ...docArg, to: { type: 'string', required: true, description: 'the PDF file to write' } },
      effect: exportEffect,
      needsRunning: true,
      describe: (a) => `Export ${a.doc ? `"${a.doc}"` : `the front ${app} document`} to ${a.to}`,
      async run(a, env) {
        const to = expandPath(a.to, env.workspace)
        const r = await env.jxa<{ doc: string }>(IWORK_SCRIPTS.EXPORT_PDF, { app, doc: a.doc, to: /\.pdf$/i.test(to) ? to : `${to}.pdf` }, 180_000)
        const out = /\.pdf$/i.test(to) ? to : `${to}.pdf`
        return { text: `Exported "${r.doc}" to ${out}${existsSync(out) ? '' : ' (the file isn\'t there yet: check again in a moment)'}.`, display: `exported ${basename(out)}`, path: out }
      }
    },
    save: {
      summary: 'Save a document',
      args: docArg,
      effect: 'write_local',
      needsRunning: true,
      describe: (a) => `Save ${a.doc ? `"${a.doc}"` : `the front ${app} document`}`,
      async run(a, env) {
        const r = await env.jxa<{ doc: string }>(IWORK_SCRIPTS.SAVE, { app, doc: a.doc }, 60_000)
        return { text: `Saved "${r.doc}". (A document never saved before shows a Save dialog: finish it with computer use.)`, display: `saved ${r.doc}` }
      }
    }
  }
}

const tableArgs = { ...docArg, sheet: { type: 'string' as const, description: 'sheet name or number (default: the first)' }, table: { type: 'string' as const, description: 'table name or number (default: the first)' } }

export const numbers: AppAdapter = {
  id: 'numbers',
  name: 'Numbers',
  aliases: ['apple numbers'],
  bundleIds: ['com.apple.iWork.Numbers'],
  paths: ['/Applications/Numbers.app'],
  blurb: 'spreadsheets: open, list sheets/tables, read and write cells, export PDF, save',
  skill: 'app-iwork',
  notes: 'Uses Numbers\' scripting dictionary. Values starting with "=" become formulas. For formatting, charts or sorting fall back to computer use (menu, ui refs).',
  actions: {
    ...docActions('Numbers', 'spreadsheet', NUMBERS_SCRIPTS.DOCUMENTS, (r) => r.map((d) => `${d.name}${d.modified ? ' (unsaved changes)' : ''}${d.path ? ` — ${d.path}` : ''}\n${(d.sheets ?? []).map((s: any) => `  sheet "${s.name}": ${(s.tables ?? []).map((t: any) => `table "${t.name}" ${t.rows}×${t.columns}`).join(', ') || 'no tables'}`).join('\n')}`).join('\n')),
    read: {
      summary: 'Cell values of a table (or a range like "A1:D20")',
      args: { ...tableArgs, range: { type: 'string', description: 'e.g. "A1:D20" (default: the whole table)' } },
      effect: 'read',
      needsRunning: true,
      describe: (a) => `Read ${a.range ?? 'a table'} in Numbers`,
      async run(a, env) {
        const r0 = a.range ? parseRange(a.range) : undefined
        const dims = r0 ? { rows: r0.to.row - r0.from.row + 1, cols: r0.to.col - r0.from.col + 1 } : {}
        const r = await env.jxa<{ doc: string; sheet: string; table: string; rows: number; cols: number; values: unknown[][]; truncated: boolean }>(NUMBERS_SCRIPTS.READ, { doc: a.doc, sheet: a.sheet, table: a.table, range: a.range, ...dims, maxCells: 5000 }, 60_000)
        const start = a.range ? String(a.range).split(':')[0] : 'A1'
        return { text: `"${r.doc}" › ${r.sheet} › ${r.table} (${r.rows}×${r.cols}${a.range ? `, ${a.range}` : ''}):\n${formatTable(r.values, start)}${r.truncated ? '\n(Only the first 5000 cells: read a smaller range for the rest.)' : ''}`, display: `read ${r.rows}×${r.cols} cells` }
      }
    },
    write: {
      summary: 'Write cells: cells {"A1": "Name", "B2": 42} or start "A1" + values [["a","b"],[1,2]] ("=..." is a formula)',
      args: { ...tableArgs, cells: { type: 'object', description: '{"A1": value, …}' }, start: { type: 'string', description: 'top-left cell for values' }, values: { type: 'array', description: 'rows of values' } },
      effect: 'write_local',
      needsRunning: true,
      describe: (a) => { try { const w = cellWrites(a); return `Write ${w.length} cell${w.length > 1 ? 's' : ''} in Numbers (${w.slice(0, 4).map((x) => `${x.cell}=${String(x.value).slice(0, 20)}`).join(', ')}${w.length > 4 ? ', …' : ''})` } catch { return 'Write cells in Numbers' } },
      async run(a, env) {
        const writes = cellWrites(a)
        const r = await env.jxa<{ doc: string; sheet: string; table: string; written: number }>(NUMBERS_SCRIPTS.WRITE, { doc: a.doc, sheet: a.sheet, table: a.table, writes }, 120_000)
        return { text: `Wrote ${r.written} cell${r.written > 1 ? 's' : ''} in "${r.doc}" › ${r.sheet} › ${r.table}. Read them back (read with a range) to check the results of formulas.`, display: `wrote ${r.written} cells` }
      }
    }
  }
}

export const pages: AppAdapter = {
  id: 'pages',
  name: 'Pages',
  aliases: ['apple pages'],
  bundleIds: ['com.apple.iWork.Pages'],
  paths: ['/Applications/Pages.app'],
  blurb: 'documents: open, list, read text, export PDF, save',
  skill: 'app-iwork',
  notes: 'Uses Pages\' scripting dictionary to read and export. To add or edit text, click where it goes and use computer paste_text (keeps the document\'s formatting), then read it back.',
  actions: {
    ...docActions('Pages', 'Pages', PAGES_SCRIPTS.DOCUMENTS, (r) => r.map((d) => `${d.name}${d.modified ? ' (unsaved changes)' : ''}${d.words !== null ? `, ${d.words} words` : ''}${d.path ? ` — ${d.path}` : ''}`).join('\n')),
    read: {
      summary: 'The document\'s body text',
      args: { ...docArg, max_chars: { type: 'number', description: 'default 50000' } },
      effect: 'read',
      needsRunning: true,
      describe: () => 'Read a Pages document',
      async run(a, env) {
        const r = await env.jxa<{ doc: string; text: string }>(PAGES_SCRIPTS.READ, { doc: a.doc, max: 400_000 }, 60_000)
        return { text: `"${r.doc}":\n${clip(r.text, Number(a.max_chars) || 50_000)}`, display: `read "${r.doc}"` }
      }
    }
  }
}

export const keynote: AppAdapter = {
  id: 'keynote',
  name: 'Keynote',
  aliases: ['apple keynote'],
  bundleIds: ['com.apple.iWork.Keynote'],
  paths: ['/Applications/Keynote.app'],
  blurb: 'presentations: open, list, read slides and notes, add slides, export PDF, save',
  skill: 'app-iwork',
  notes: 'Uses Keynote\'s scripting dictionary. layouts lists the theme\'s slide layouts for add_slide. Images, builds and fine layout: computer use.',
  actions: {
    ...docActions('Keynote', 'Keynote', KEYNOTE_SCRIPTS.DOCUMENTS, (r) => r.map((d) => `${d.name}${d.modified ? ' (unsaved changes)' : ''}, ${d.slides} slides${d.path ? ` — ${d.path}` : ''}`).join('\n')),
    read: {
      summary: 'Every slide\'s title, body and presenter notes',
      args: docArg,
      effect: 'read',
      needsRunning: true,
      describe: () => 'Read a Keynote presentation',
      async run(a, env) {
        const r = await env.jxa<{ doc: string; total: number; slides: Array<{ n: number; skipped: boolean; layout: string; title: string; body: string; notes: string }> }>(KEYNOTE_SCRIPTS.READ, { doc: a.doc, max: 200 }, 60_000)
        return { text: `"${r.doc}" (${r.total} slides):\n${r.slides.map((s) => `## ${s.n}. ${s.title || '(no title)'}${s.skipped ? ' (skipped)' : ''} [${s.layout}]${s.body ? `\n${s.body}` : ''}${s.notes ? `\nNotes: ${s.notes}` : ''}`).join('\n\n')}`, display: `read ${r.total} slides` }
      }
    },
    layouts: {
      summary: 'The slide layouts the theme has (for add_slide)',
      args: docArg,
      effect: 'read',
      needsRunning: true,
      describe: () => 'List Keynote layouts',
      async run(a, env) {
        const r = await env.jxa<string[]>(KEYNOTE_SCRIPTS.LAYOUTS, { doc: a.doc })
        return { text: r.map((x) => `- ${x}`).join('\n'), display: `${r.length} layouts` }
      }
    },
    add_slide: {
      summary: 'Add a slide at the end with a title, body and notes',
      args: { ...docArg, title: { type: 'string', description: 'slide title' }, body: { type: 'string', description: 'body text (lines become bullets in bullet layouts)' }, notes: { type: 'string', description: 'presenter notes' }, layout: { type: 'string', description: 'layout name from layouts (default: like the last slide)' } },
      effect: 'write_local',
      needsRunning: true,
      describe: (a) => `Add a slide${a.title ? ` "${a.title}"` : ''} to the Keynote presentation`,
      async run(a, env) {
        const r = await env.jxa<{ doc: string; index: number; layout: string; filled: string[] }>(KEYNOTE_SCRIPTS.ADD_SLIDE, { doc: a.doc, title: a.title, body: a.body, notes: a.notes, layout: a.layout }, 60_000)
        const missed = ['title', 'body', 'notes'].filter((k) => a[k] && !r.filled.includes(k))
        return { text: `Added slide ${r.index} (${r.layout}) to "${r.doc}".${missed.length ? ` This layout has no ${missed.join('/')} placeholder, so that text wasn't placed: pick another layout or add a text box with computer use.` : ''}`, display: `added slide ${r.index}` }
      }
    }
  }
}
