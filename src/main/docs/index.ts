// The document toolkit's public API, for the agent tools and the live document editor (export).
// Nothing here needs Electron; PDF rendering through Chromium (renderPdf, markdownToPdf) and the
// createDocument entry point live in ./create.
//
//   Word        renderDocx(markdown | DocBlock[] | ParsedDoc, DocxOptions) → Buffer
//               buildDocx(...) → { buffer, warnings, stats }
//   PowerPoint  renderPptx(SlideSpec[], DeckOptions) → Buffer        buildPptx(...) → { buffer, warnings, slides }
//   Excel       renderXlsx(SheetSpec[], WorkbookOptions) → Buffer    buildXlsx(...) → { buffer, warnings, errors, unverified }
//               loadWorkbook / readSheets / formatSheets / editWorkbook / columnStats / parseCsv / sheetFromCsv
//   PDF         pdfFields / pdfFill / pdfMerge / pdfSplit / pdfExtract / pdfRotate / pdfStamp / pdfPageNumbers / pdfInfo / textToPdf
//   Markdown    parseMarkdown(md) → { blocks, footnotes }, blocksToMarkdown, blocksToHtml, spansOf, plainText
//   Review      reviewDocument(path | { data, name }, { source? }) → Review, formatReview
//   Inspect     inspectDocx(buffer), inspectPptx(buffer)
//   Templates   applyTemplate(kind, parsed, fields), TEMPLATE_KINDS ('memo' | 'report' | 'letter' | 'meeting_notes' | 'proposal')

export { buildDocx, renderDocx, type Citation, type DocxOptions, type DocxStats } from './docx'
export { buildPptx, planSlides, renderPptx, type ChartSpec, type DeckOptions, type SlideLayout, type SlideSpec } from './pptx'
export {
  buildXlsx, columnStats, computeWorkbook, editWorkbook, formatSheets, inferType, loadWorkbook, parseCsv, parseDate, parseNumber, readSheets, renderXlsx, sheetFromCsv, sheetGrid, toCsv,
  type CellEdit, type CellInput, type ColumnSpec, type ColumnType, type ConditionalRule, type SheetRead, type SheetSpec, type SummaryItem, type WorkbookOptions
} from './xlsx'
export { pdfExtract, pdfFields, pdfFill, pdfInfo, pdfMerge, pdfPageNumbers, pdfRotate, pdfSplit, pdfStamp, parsePages, textToPdf, type PdfField } from './pdf'
export { blocksToHtml, blocksToMarkdown, parseMarkdown, plainText, spansOf, type DocBlock, type ListItem, type ParsedDoc, type RichText, type Span } from './markdown'
export { formatReview, reviewDocument, type Review, type ReviewCheck, type ReviewOptions } from './review'
export { inspectDocx, inspectPptx, type DeckInfo, type DocxInfo } from './inspect'
export { applyTemplate, TEMPLATE_KINDS, type TemplateFields, type TemplateKind } from './templates'
export { Engine, portableFormula, type Book } from './formula'
