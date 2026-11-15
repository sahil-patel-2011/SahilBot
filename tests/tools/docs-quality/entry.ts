// Electron entry for the docs quality screenshots: builds every sample document with the real generators
// (Chromium for PDFs) and renders each one to page images with the same code review_document uses.
// Run through harness.ts (it bundles this file and starts Electron hidden).
import { app, BrowserWindow } from 'electron'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDocument } from '../../../src/main/docs/create'
import { pdfToImages, renderDocument } from '../../../src/main/docs/render'
import { formatReview, reviewDocument } from '../../../src/main/docs/review'
import { SAMPLES, SITE_PLAN_SVG } from './samples'

const out = process.env.DOCS_SHOT_OUT!
const only = (process.env.DOCS_SHOT_ONLY ?? '').split(',').filter(Boolean)

async function sitePlan(): Promise<void> {
  // Hidden windows can't be captured: print the SVG to a PDF page and draw that with PDFKit.
  const win = new BrowserWindow({ show: false, webPreferences: { javascript: false } })
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<html><head><style>@page{size:1200px 640px;margin:0}body{margin:0}</style></head><body>${SITE_PLAN_SVG}</body></html>`)}`)
  const pdf = await win.webContents.printToPDF({ preferCSSPageSize: true, printBackground: true, margins: { top: 0, bottom: 0, left: 0, right: 0 } })
  win.destroy()
  writeFileSync(join(out, 'site-plan.pdf'), pdf)
  const r = await pdfToImages(join(out, 'site-plan.pdf'), { outDir: out, width: 1200, pages: [1], sheet: false, prefix: 'site-plan-' })
  renameSync(r.images[0].path, join(out, 'site-plan.png'))
}

app.dock?.hide()
// Windows come and go while rendering; the harness quits by itself.
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  const summary: Record<string, unknown> = {}
  try {
    mkdirSync(out, { recursive: true })
    await sitePlan()
    for (const s of SAMPLES) {
      if (only.length && !only.includes(s.name)) continue
      const path = join(out, s.spec.path as string)
      const started = Date.now()
      try {
        // Older generator code (before/after runs) may not know a template: render without it.
        const r = await createDocument(path, s.spec as never).catch(() => createDocument(path, { ...s.spec, template: undefined } as never))
        const shots = await renderDocument(path, { outDir: join(out, `${s.name}-pages`), width: 1100 })
        // The agent's own check, as review_document runs it (rendered pages included).
        const review = formatReview(await reviewDocument(path, { render: { outDir: join(out, `${s.name}-review`) } }))
        summary[s.name] = { path, ms: Date.now() - started, warnings: r.warnings, notes: (r as { notes?: string[] }).notes, pages: shots.pageCount, method: shots.method, images: shots.images.map((i: { path: string }) => i.path), sheet: shots.sheet, overflow: shots.overflow, lowContrast: shots.lowContrast, checks: shots.checks.map((c: { page: number; ink: number; blank: boolean; bottom: number; edge: unknown }) => ({ page: c.page, ink: +c.ink.toFixed(3), blank: c.blank, bottom: +c.bottom.toFixed(2), edge: c.edge })), renderNotes: shots.notes, review }
      } catch (e) {
        summary[s.name] = { error: (e as Error).stack }
      }
    }
  } catch (e) {
    summary.harness = { error: (e as Error).stack }
  } finally {
    writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2))
    app.exit(0)
  }
})
