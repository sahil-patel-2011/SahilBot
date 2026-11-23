// Internal markup some model backends leave in their text (Codex: ":codex-file-citation{path=… line_range_start=…}",
// "【F:src/app.ts†L10-L20】"): never shown to the user. Code blocks and inline code are left exactly as written.

const DIRECTIVE = /(^|[\s(>])::?[a-z][\w-]*(?:-[\w-]+)*\{[^}\n]{0,400}\}/gi
const BRACKET_CITE = /【[^】\n]{1,200}】/g

/** The text without internal directives and citation markers (outside code). */
export function stripDirectives(text: string): string {
  if (!text || (!text.includes('{') && !text.includes('【'))) return text
  return text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g).map((part, i) => (i % 2 === 1 ? part : part.replace(DIRECTIVE, '$1').replace(BRACKET_CITE, '').replace(/[ \t]+\n/g, '\n').replace(/ {2,}/g, ' '))).join('')
}
