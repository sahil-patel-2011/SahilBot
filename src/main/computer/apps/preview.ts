import { existsSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { exportEffect } from './iwork'
import { expandPath, JXA_GET, JXA_POSIX, type AppAdapter } from './types'

// Preview: open files, list what's open, and convert images (and a PDF's first page) with sips, the
// image tool built into macOS, so exporting needs no clicking. Preview's own export dialog (for
// multi-page PDF tricks like reducing file size) is computer use: File > Export….

export const PREVIEW_SCRIPTS = {
  DOCUMENTS: `(a) => { ${JXA_GET}; ${JXA_POSIX}
    const P = Application('Preview')
    return get(() => P.documents(), []).map((d) => ({ name: String(get(() => d.name(), '')), path: get(() => posix(d.path()), '') }))
  }`
}

export const SIPS_FORMATS: Record<string, string> = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', heic: 'heic', tiff: 'tiff', tif: 'tiff', gif: 'gif', bmp: 'bmp', pdf: 'pdf' }

/** The sips arguments for a conversion (format from `format` or the output's extension; optional longest side). */
export function sipsArgs(from: string, to: string, o: { format?: string; max_size?: number } = {}): string[] {
  const fmt = SIPS_FORMATS[String(o.format ?? extname(to).slice(1)).toLowerCase()]
  if (!fmt) throw new Error(`Can't convert to "${o.format ?? extname(to)}". Formats: ${[...new Set(Object.values(SIPS_FORMATS))].join(', ')}.`)
  const size = o.max_size ? ['-Z', String(Math.max(16, Math.min(20000, Math.round(Number(o.max_size)))))] : []
  return ['-s', 'format', fmt, ...size, from, '--out', to]
}

export const preview: AppAdapter = {
  id: 'preview',
  name: 'Preview',
  aliases: [],
  bundleIds: ['com.apple.Preview'],
  paths: ['/System/Applications/Preview.app', '/Applications/Preview.app'],
  blurb: 'open files, list open documents, convert/resize images and export as PDF, image info',
  skill: 'app-iwork',
  notes: 'Opens with open -a Preview; converts with sips (no clicking). For annotating, signing or Preview\'s own Export dialog, use computer use (menu File > Export…).',
  actions: {
    open: {
      summary: 'Open a file in Preview',
      args: { path: { type: 'string', required: true, description: 'image or PDF' } },
      effect: 'write_local',
      describe: (a) => `Open ${a.path} in Preview`,
      async run(a, env) {
        const p = expandPath(a.path, env.workspace)
        if (!existsSync(p)) throw new Error(`Not found: ${p}`)
        await env.sh('open', ['-a', 'Preview', p])
        return { text: `Opened ${p} in Preview.`, display: `opened ${basename(p)}`, path: p }
      }
    },
    documents: {
      summary: 'Files open in Preview',
      effect: 'read',
      needsRunning: true,
      describe: () => 'List files open in Preview',
      async run(_a, env) {
        const r = await env.jxa<Array<{ name: string; path: string }>>(PREVIEW_SCRIPTS.DOCUMENTS, {})
        return { text: r.length ? r.map((d) => `- ${d.name}${d.path ? ` — ${d.path}` : ''}`).join('\n') : 'Nothing is open in Preview.', display: `${r.length} open` }
      }
    },
    export: {
      summary: 'Convert an image (or a PDF\'s first page) to another format, optionally resized; images can become PDFs',
      args: { path: { type: 'string', required: true, description: 'the source file' }, to: { type: 'string', required: true, description: 'the new file (its extension picks the format)' }, format: { type: 'string', description: 'jpeg, png, heic, tiff, gif, bmp or pdf', enum: ['jpeg', 'jpg', 'png', 'heic', 'tiff', 'gif', 'bmp', 'pdf'] }, max_size: { type: 'number', description: 'longest side in pixels' } },
      effect: exportEffect,
      describe: (a) => `Convert ${a.path} to ${a.to}${a.max_size ? ` (at most ${a.max_size} px)` : ''}`,
      async run(a, env) {
        const from = expandPath(a.path, env.workspace)
        const to = expandPath(a.to, env.workspace)
        if (!existsSync(from)) throw new Error(`Not found: ${from}`)
        if (existsSync(to)) throw new Error(`${to} already exists. Pick a new name (or ask the user before replacing it).`)
        await env.sh('/usr/bin/sips', sipsArgs(from, to, a), 120_000)
        return { text: `Wrote ${to}.`, display: `exported ${basename(to)}`, path: to }
      }
    },
    info: {
      summary: 'An image\'s size, format and resolution',
      args: { path: { type: 'string', required: true, description: 'the image' } },
      effect: 'read',
      describe: (a) => `Read ${a.path}'s image info`,
      async run(a, env) {
        const p = expandPath(a.path, env.workspace)
        if (!existsSync(p)) throw new Error(`Not found: ${p}`)
        const out = await env.sh('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', '-g', 'format', '-g', 'dpiWidth', p], 30_000)
        return { text: out.trim(), display: `info ${basename(p)}` }
      }
    }
  }
}
