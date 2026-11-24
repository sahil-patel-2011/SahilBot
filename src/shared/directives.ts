// Internal markup some model backends leave in their text (Codex: ":codex-file-citation[codex-file-citation]{path=…
// line_range_start=…}", "【F:src/app.ts†L10-L20】"): never shown to the user. Code blocks and inline code are left
// exactly as written.

// A name, an optional [label], then {attributes}; it may be glued to punctuation ("Saved it.:codex-file-citation{…}").
const DIRECTIVE = /(^|[\s(>.,;:!?)\]])::?[a-z][\w-]*(?:\[[^\]\n]{0,200}\])?\{[^}\n]{0,600}\}/gi
// A Codex citation with only its label (":codex-file-citation[codex-file-citation]").
const BARE = /(^|[\s(>.,;:!?])::?codex-[\w-]+\[[^\]\n]{0,200}\]/gi
const BRACKET_CITE = /【[^】\n]{1,200}】/g
const CUT = '\u0000'

/** The text without internal directives and citation markers (outside code). */
export function stripDirectives(text: string): string {
  if (!text || (!text.includes('{') && !text.includes('【') && !text.includes(':codex-'))) return text
  return text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g).map((part, i) => (i % 2 === 1 ? part : part.replace(DIRECTIVE, `$1${CUT}`).replace(BARE, `$1${CUT}`).replace(BRACKET_CITE, CUT)
    // (Where markup came out right before punctuation, no space is left before it: "Saved it to Downloads.")
    .replace(/[ \t]*\u0000+(?=[.,;:!?])/g, '').replace(/\u0000/g, '').replace(/[ \t]+\n/g, '\n').replace(/ {2,}/g, ' '))).join('')
}
