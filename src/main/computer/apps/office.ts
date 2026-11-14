import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { cellWrites, formatTable } from './cells'
import { exportEffect } from './iwork'
import { clip, expandPath, type AppAction, type AppAdapter, type AppEnv } from './types'

// Microsoft Excel, Word and PowerPoint through their AppleScript dictionaries (more complete and more
// reliable than JXA for Office). Every script takes its data as argv (`on run argv`): no user text is
// ever part of a script's source. Office is sandboxed: writing a PDF outside its folders can show a
// "Grant access" prompt, which the user answers.

/** Shared AppleScript handlers: text with tabs/newlines flattened, find-and-replace, POSIX → HFS. */
const AS_HELPERS = `
on flat(v)
  try
    set t to v as text
  on error
    set t to ""
  end try
  set t to my rep(t, tab, " ")
  set t to my rep(t, return, " ")
  set t to my rep(t, linefeed, " ")
  return t
end flat

on rep(t, a, b)
  set AppleScript's text item delimiters to a
  set parts to text items of t
  set AppleScript's text item delimiters to b
  set t to parts as text
  set AppleScript's text item delimiters to ""
  return t
end rep

on hfs(p)
  return (POSIX file p) as text
end hfs
`

export const EXCEL_SCRIPTS = {
  WORKBOOKS: `on run argv
  set acc to ""
  tell application "Microsoft Excel"
    repeat with wb in workbooks
      set acc to acc & "workbook" & tab & (name of wb) & linefeed
      repeat with ws in worksheets of wb
        set addr to ""
        try
          set addr to get address of (used range of ws)
        end try
        set acc to acc & "sheet" & tab & (name of ws) & tab & addr & linefeed
      end repeat
    end repeat
  end tell
  return acc
end run`,
  READ: `on run argv
  set wbName to item 1 of argv
  set wsName to item 2 of argv
  set addr to item 3 of argv
  set maxCells to (item 4 of argv) as integer
  tell application "Microsoft Excel"
    if wbName is "" then
      set wb to active workbook
    else
      set wb to workbook wbName
    end if
    if wsName is "" then
      set ws to active sheet of wb
    else
      set ws to worksheet wsName of wb
    end if
    if addr is "" then
      set r to used range of ws
    else
      set r to range addr of ws
    end if
    set nr to count of rows of r
    set nc to count of columns of r
    if nr * nc > maxCells then error "That range has " & (nr * nc) & " cells; read at most " & maxCells & " at a time (give a smaller range)."
    set v to value of r
    set firstAddr to get address of r
    set sheetName to name of ws
    set bookName to name of wb
  end tell
  if class of v is not list then set v to {{v}}
  if (count of v) > 0 and class of (item 1 of v) is not list then set v to {v}
  set acc to bookName & tab & sheetName & tab & firstAddr & linefeed
  repeat with rw in v
    set rowText to ""
    set i to 0
    repeat with c in rw
      set i to i + 1
      if i > 1 then set rowText to rowText & tab
      set rowText to rowText & my flat(contents of c)
    end repeat
    set acc to acc & rowText & linefeed
  end repeat
  return acc
end run
${AS_HELPERS}`,
  WRITE: `on run argv
  set wbName to item 1 of argv
  set wsName to item 2 of argv
  tell application "Microsoft Excel"
    if wbName is "" then
      set wb to active workbook
    else
      set wb to workbook wbName
    end if
    if wsName is "" then
      set ws to active sheet of wb
    else
      set ws to worksheet wsName of wb
    end if
    set n to count of argv
    set i to 3
    set doneCount to 0
    repeat while i < n
      set formula of range (item i of argv) of ws to (item (i + 1) of argv)
      set doneCount to doneCount + 1
      set i to i + 2
    end repeat
    return (name of wb) & tab & (name of ws) & tab & doneCount
  end tell
end run`,
  EXPORT_PDF: `on run argv
  set wbName to item 1 of argv
  set outPath to my hfs(item 2 of argv)
  tell application "Microsoft Excel"
    if wbName is "" then
      set wb to active workbook
    else
      set wb to workbook wbName
    end if
    save workbook as wb filename outPath file format PDF file format
    return name of wb
  end tell
end run
${AS_HELPERS}`,
  SAVE: `on run argv
  set wbName to item 1 of argv
  tell application "Microsoft Excel"
    if wbName is "" then
      set wb to active workbook
    else
      set wb to workbook wbName
    end if
    save wb
    return name of wb
  end tell
end run`
}

export const WORD_SCRIPTS = {
  DOCUMENTS: `on run argv
  set acc to ""
  tell application "Microsoft Word"
    repeat with d in documents
      set acc to acc & (name of d) & tab & (full name of d) & linefeed
    end repeat
  end tell
  return acc
end run`,
  READ: `on run argv
  set docName to item 1 of argv
  tell application "Microsoft Word"
    if docName is "" then
      set d to active document
    else
      set d to document docName
    end if
    return (name of d) & linefeed & (content of text object of d)
  end tell
end run`,
  APPEND: `on run argv
  set docName to item 1 of argv
  set t to item 2 of argv
  tell application "Microsoft Word"
    if docName is "" then
      set d to active document
    else
      set d to document docName
    end if
    insert text t at end of text object of d
    return name of d
  end tell
end run`,
  EXPORT_PDF: `on run argv
  set docName to item 1 of argv
  set outPath to my hfs(item 2 of argv)
  tell application "Microsoft Word"
    if docName is "" then
      set d to active document
    else
      set d to document docName
    end if
    save as d file name outPath file format format PDF
    return name of d
  end tell
end run
${AS_HELPERS}`,
  SAVE: `on run argv
  set docName to item 1 of argv
  tell application "Microsoft Word"
    if docName is "" then
      set d to active document
    else
      set d to document docName
    end if
    save d
    return name of d
  end tell
end run`
}

export const POWERPOINT_SCRIPTS = {
  PRESENTATIONS: `on run argv
  set acc to ""
  tell application "Microsoft PowerPoint"
    repeat with p in presentations
      set acc to acc & (name of p) & tab & (count of slides of p) & linefeed
    end repeat
  end tell
  return acc
end run`,
  READ: `on run argv
  set pName to item 1 of argv
  set acc to ""
  tell application "Microsoft PowerPoint"
    if pName is "" then
      set p to active presentation
    else
      set p to presentation pName
    end if
    set acc to (name of p) & linefeed
    repeat with i from 1 to count of slides of p
      set s to slide i of p
      set acc to acc & "## Slide " & i & linefeed
      repeat with sh in shapes of s
        try
          if has text frame of sh then
            set t to content of text range of text frame of sh
            if t is not "" then set acc to acc & t & linefeed
          end if
        end try
      end repeat
    end repeat
  end tell
  return acc
end run`,
  ADD_SLIDE: `on run argv
  set pName to item 1 of argv
  set theTitle to item 2 of argv
  set theBody to item 3 of argv
  tell application "Microsoft PowerPoint"
    if pName is "" then
      set p to active presentation
    else
      set p to presentation pName
    end if
    set s to make new slide at end of p with properties {layout:slide layout text slide}
    set filled to ""
    if theTitle is not "" then
      try
        set content of text range of text frame of shape 1 of s to theTitle
        set filled to filled & "title "
      end try
    end if
    if theBody is not "" then
      try
        set content of text range of text frame of shape 2 of s to theBody
        set filled to filled & "body"
      end try
    end if
    return ((count of slides of p) as text) & tab & filled
  end tell
end run`,
  EXPORT_PDF: `on run argv
  set pName to item 1 of argv
  set outPath to item 2 of argv
  tell application "Microsoft PowerPoint"
    if pName is "" then
      set p to active presentation
    else
      set p to presentation pName
    end if
    save p in (POSIX file outPath) as save as PDF
    return name of p
  end tell
end run`,
  SAVE: `on run argv
  set pName to item 1 of argv
  tell application "Microsoft PowerPoint"
    if pName is "" then
      set p to active presentation
    else
      set p to presentation pName
    end if
    save p
    return name of p
  end tell
end run`
}

const docArg = { doc: { type: 'string' as const, description: 'open document by name (default: the active one)' } }
const pdfOut = (to: string, w: string): string => { const p = expandPath(to, w); return /\.pdf$/i.test(p) ? p : `${p}.pdf` }

function officeCommon(app: string, kinds: string, scripts: { EXPORT_PDF: string; SAVE: string }): Record<string, AppAction> {
  return {
    open: {
      summary: `Open a ${kinds} file`,
      args: { path: { type: 'string', required: true, description: 'the file' } },
      effect: 'write_local',
      describe: (a) => `Open ${a.path} in ${app}`,
      async run(a, env) {
        const p = expandPath(a.path, env.workspace)
        if (!existsSync(p)) throw new Error(`Not found: ${p}`)
        await env.sh('open', ['-a', app, p], 60_000)
        return { text: `Opened ${p} in ${app}. It may take a few seconds to load (and may show a "Grant access" or Protected View bar: the user answers those).`, display: `opened ${basename(p)}`, path: p }
      }
    },
    export_pdf: {
      summary: 'Save a copy as PDF',
      args: { ...docArg, to: { type: 'string', required: true, description: 'the PDF file to write' } },
      effect: exportEffect,
      needsRunning: true,
      describe: (a) => `Export ${a.doc ? `"${a.doc}"` : `the active ${app} document`} to ${a.to}`,
      async run(a, env) {
        const out = pdfOut(a.to, env.workspace)
        const name = (await env.applescript(scripts.EXPORT_PDF, [String(a.doc ?? ''), out], 180_000)).trim()
        return { text: `Exported "${name}" to ${out}${existsSync(out) ? '' : `. The file isn't there yet: ${app} may be showing a "Grant access" prompt for that folder (the user clicks it), or still writing.`}`, display: `exported ${basename(out)}`, path: out }
      }
    },
    save: {
      summary: 'Save the document',
      args: docArg,
      effect: 'write_local',
      needsRunning: true,
      describe: (a) => `Save ${a.doc ? `"${a.doc}"` : `the active ${app} document`}`,
      async run(a, env) {
        const name = (await env.applescript(scripts.SAVE, [String(a.doc ?? '')], 60_000)).trim()
        return { text: `Saved "${name}". (A new, never-saved document opens a Save dialog: finish it with computer use.)`, display: `saved ${name}` }
      }
    }
  }
}

/** Excel's read output: first line book⇥sheet⇥address, then tab-separated rows. */
export function parseExcelRead(out: string): { book: string; sheet: string; address: string; rows: string[][] } {
  const lines = out.replace(/\r/g, '').split('\n')
  const [book = '', sheet = '', address = ''] = (lines.shift() ?? '').split('\t')
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  return { book, sheet, address, rows: lines.map((l) => l.split('\t')) }
}

export const excel: AppAdapter = {
  id: 'excel',
  name: 'Microsoft Excel',
  aliases: ['excel', 'ms excel'],
  bundleIds: ['com.microsoft.Excel'],
  paths: ['/Applications/Microsoft Excel.app'],
  blurb: 'workbooks: open, list sheets, read and write cells/ranges (formulas too), export PDF, save',
  skill: 'app-office',
  notes: 'Uses Excel\'s AppleScript dictionary. Writes go in as if typed (numbers, dates and "=formulas" are parsed). Charts, pivots and formatting: computer use (ribbon via ui refs, or menu).',
  actions: {
    ...officeCommon('Microsoft Excel', 'workbook', EXCEL_SCRIPTS),
    workbooks: {
      summary: 'Open workbooks, their sheets and used ranges',
      effect: 'read',
      needsRunning: true,
      describe: () => 'List open Excel workbooks',
      async run(_a, env) {
        const out = (await env.applescript(EXCEL_SCRIPTS.WORKBOOKS, [])).trim()
        return { text: out ? out.split('\n').map((l) => { const [k, n, r] = l.split('\t'); return k === 'workbook' ? n : `  sheet "${n}"${r ? ` (used ${r.replace(/\$/g, '')})` : ''}` }).join('\n') : 'No workbooks are open in Excel.', display: 'listed workbooks' }
      }
    },
    read: {
      summary: 'Values of a range like "A1:D20" (default: the sheet\'s used range)',
      args: { ...docArg, sheet: { type: 'string', description: 'worksheet name (default: the active one)' }, range: { type: 'string', description: 'e.g. "A1:D20"' } },
      effect: 'read',
      needsRunning: true,
      describe: (a) => `Read ${a.range ?? 'the used range'} in Excel`,
      async run(a, env) {
        const r = parseExcelRead(await env.applescript(EXCEL_SCRIPTS.READ, [String(a.doc ?? ''), String(a.sheet ?? ''), String(a.range ?? ''), '5000'], 60_000))
        const start = (r.address.replace(/\$/g, '').split(':')[0]) || 'A1'
        return { text: `"${r.book}" › ${r.sheet} › ${r.address.replace(/\$/g, '')}:\n${formatTable(r.rows, start)}`, display: `read ${r.rows.length} rows` }
      }
    },
    write: {
      summary: 'Write cells: cells {"A1": "Name", "B2": 42} or start "A1" + values [["a","b"],[1,2]] (entered as if typed; "=..." is a formula)',
      args: { ...docArg, sheet: { type: 'string', description: 'worksheet name (default: the active one)' }, cells: { type: 'object', description: '{"A1": value, …}' }, start: { type: 'string', description: 'top-left cell for values' }, values: { type: 'array', description: 'rows of values' } },
      effect: 'write_local',
      needsRunning: true,
      describe: (a) => { try { const w = cellWrites(a); return `Write ${w.length} cell${w.length > 1 ? 's' : ''} in Excel (${w.slice(0, 4).map((x) => `${x.cell}=${String(x.value).slice(0, 20)}`).join(', ')}${w.length > 4 ? ', …' : ''})` } catch { return 'Write cells in Excel' } },
      async run(a, env) {
        const writes = cellWrites(a)
        const out = (await env.applescript(EXCEL_SCRIPTS.WRITE, [String(a.doc ?? ''), String(a.sheet ?? ''), ...writes.flatMap((w) => [w.cell, w.value === true ? 'TRUE' : w.value === false ? 'FALSE' : String(w.value)])], 120_000)).trim()
        const [book, sheet, n] = out.split('\t')
        return { text: `Wrote ${n ?? writes.length} cells in "${book}" › ${sheet}. Read the range back to check formula results.`, display: `wrote ${n ?? writes.length} cells` }
      }
    }
  }
}

export const word: AppAdapter = {
  id: 'word',
  name: 'Microsoft Word',
  aliases: ['word', 'ms word'],
  bundleIds: ['com.microsoft.Word'],
  paths: ['/Applications/Microsoft Word.app'],
  blurb: 'documents: open, list, read text, append text, export PDF, save',
  skill: 'app-office',
  notes: 'Uses Word\'s AppleScript dictionary. To insert text in the middle, click there and use computer paste_text; styles and tables: computer use.',
  actions: {
    ...officeCommon('Microsoft Word', 'Word', WORD_SCRIPTS),
    documents: {
      summary: 'Open documents and their files',
      effect: 'read',
      needsRunning: true,
      describe: () => 'List open Word documents',
      async run(_a, env) {
        const out = (await env.applescript(WORD_SCRIPTS.DOCUMENTS, [])).trim()
        return { text: out ? out.split('\n').map((l) => { const [n, f] = l.split('\t'); return `${n}${f && f !== n ? ` — ${f}` : ''}` }).join('\n') : 'No documents are open in Word.', display: 'listed documents' }
      }
    },
    read: {
      summary: 'The document\'s text',
      args: { ...docArg, max_chars: { type: 'number', description: 'default 50000' } },
      effect: 'read',
      needsRunning: true,
      describe: () => 'Read a Word document',
      async run(a, env) {
        const out = await env.applescript(WORD_SCRIPTS.READ, [String(a.doc ?? '')], 60_000)
        const [name, ...rest] = out.replace(/\r/g, '\n').split('\n')
        return { text: `"${name}":\n${clip(rest.join('\n').trim(), Number(a.max_chars) || 50_000)}`, display: `read "${name}"` }
      }
    },
    append_text: {
      summary: 'Add text at the end of the document',
      args: { ...docArg, text: { type: 'string', required: true, description: 'text to add (start it with a newline for a new paragraph)' } },
      effect: 'write_local',
      needsRunning: true,
      describe: (a) => `Add ${String(a.text ?? '').length} characters to the end of the Word document`,
      async run(a, env) {
        const name = (await env.applescript(WORD_SCRIPTS.APPEND, [String(a.doc ?? ''), String(a.text)], 60_000)).trim()
        return { text: `Added ${String(a.text).length} characters to the end of "${name}".`, display: `added text to ${name}` }
      }
    }
  }
}

export const powerpoint: AppAdapter = {
  id: 'powerpoint',
  name: 'Microsoft PowerPoint',
  aliases: ['powerpoint', 'ppt', 'ms powerpoint'],
  bundleIds: ['com.microsoft.Powerpoint'],
  paths: ['/Applications/Microsoft PowerPoint.app'],
  blurb: 'presentations: open, list, read slide text, add slides, export PDF, save',
  skill: 'app-office',
  notes: 'Uses PowerPoint\'s AppleScript dictionary. New slides use the "Title and Content" layout; images and design: computer use.',
  actions: {
    ...officeCommon('Microsoft PowerPoint', 'PowerPoint', POWERPOINT_SCRIPTS),
    presentations: {
      summary: 'Open presentations and their slide counts',
      effect: 'read',
      needsRunning: true,
      describe: () => 'List open PowerPoint presentations',
      async run(_a, env) {
        const out = (await env.applescript(POWERPOINT_SCRIPTS.PRESENTATIONS, [])).trim()
        return { text: out ? out.split('\n').map((l) => { const [n, c] = l.split('\t'); return `${n}: ${c} slides` }).join('\n') : 'No presentations are open in PowerPoint.', display: 'listed presentations' }
      }
    },
    read: {
      summary: 'The text on every slide',
      args: docArg,
      effect: 'read',
      needsRunning: true,
      describe: () => 'Read a PowerPoint presentation',
      async run(a, env) {
        const out = await env.applescript(POWERPOINT_SCRIPTS.READ, [String(a.doc ?? '')], 90_000)
        return { text: clip(out.replace(/\r/g, '\n').trim(), 50_000), display: 'read slides' }
      }
    },
    add_slide: {
      summary: 'Add a "Title and Content" slide at the end',
      args: { ...docArg, title: { type: 'string', description: 'slide title' }, body: { type: 'string', description: 'body text (one bullet per line)' } },
      effect: 'write_local',
      needsRunning: true,
      describe: (a) => `Add a slide${a.title ? ` "${a.title}"` : ''} in PowerPoint`,
      async run(a, env: AppEnv) {
        const out = (await env.applescript(POWERPOINT_SCRIPTS.ADD_SLIDE, [String(a.doc ?? ''), String(a.title ?? ''), String(a.body ?? '').replace(/\n/g, '\r')], 60_000)).trim()
        const [n, filled = ''] = out.split('\t')
        const missed = [a.title && !filled.includes('title') ? 'title' : '', a.body && !filled.includes('body') ? 'body' : ''].filter(Boolean)
        return { text: `Added slide ${n}.${missed.length ? ` Couldn't place the ${missed.join(' and ')} (the layout differs): add it with computer use.` : ''}`, display: `added slide ${n}` }
      }
    }
  }
}
