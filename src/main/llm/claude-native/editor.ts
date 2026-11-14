// Claude's native text editor (text_editor_20250728, name str_replace_based_edit_tool) on top of
// SahilBot's code and file tools.
//
// Reference: shared/tool-use-concepts.md § Client-Side Tools: Bash and Text Editor — schema-less,
// declared by type and name only (no input_schema), client-executed; input.command is one of
//   view {path, view_range?} · create {path, file_text} · str_replace {path, old_str, new_str} ·
//   insert {path, insert_line, insert_text};
// errors go back as tool_result with is_error so Claude can recover. "path is untrusted model output":
// SahilBot's code/file tools already confine every path to the workspace and the attached folders, so a
// native call only becomes the same call to them (same validation, effect, hard stops and approvals).

export const EDITOR_TYPE = 'text_editor_20250728'
export const EDITOR_NAME = 'str_replace_based_edit_tool'

export const editorDef = (): Record<string, unknown> => ({ type: EDITOR_TYPE, name: EDITOR_NAME })

export type EditorTranslated = { name: string; args: Record<string, unknown> } | { name: string; error: string }

const isAbsolutePath = (p: string): boolean => p.startsWith('/') || p.startsWith('~/')

/** One text editor call → a call to SahilBot's code tool (or file_write for an absolute create). */
export function translateEditor(input: Record<string, unknown>): EditorTranslated {
  const path = typeof input.path === 'string' ? input.path.trim() : ''
  if (!path) return { name: 'code', error: 'The text editor needs a path.' }
  switch (input.command) {
    case 'view': {
      const range = Array.isArray(input.view_range) ? input.view_range : undefined
      const start = range && typeof range[0] === 'number' && range[0] >= 1 ? Math.floor(range[0]) : undefined
      // [start, -1] reads to the end of the file.
      const end = range && typeof range[1] === 'number' && range[1] >= 1 ? Math.floor(range[1]) : undefined
      if (start && end && end < start) return { name: 'code', error: 'view_range is [first, last] with last ≥ first (or -1 for the end of the file).' }
      return { name: 'code', args: { action: 'read', path, ...(start ? { start } : {}), ...(end ? { end } : {}) } }
    }
    case 'create': {
      if (typeof input.file_text !== 'string') return { name: 'code', error: 'create needs file_text (the whole file).' }
      // An absolute path: written as is (an existing file is replaced; a backup is kept).
      if (isAbsolutePath(path)) return { name: 'file_write', args: { path, content: input.file_text, mode: 'overwrite' } }
      // A relative path is relative to the project folder, as for every other code call: a new file.
      const body = input.file_text.replace(/\n$/, '').split('\n').map((l) => `+${l}`).join('\n')
      return { name: 'code', args: { action: 'apply_patch', patch: `*** Begin Patch\n*** Add File: ${path}\n${body}\n*** End Patch` } }
    }
    case 'str_replace': {
      if (typeof input.old_str !== 'string' || !input.old_str) return { name: 'code', error: 'str_replace needs old_str: text that appears exactly once in the file.' }
      const neu = typeof input.new_str === 'string' ? input.new_str : ''
      return { name: 'code', args: { action: 'edit', path, old_string: input.old_str, new_string: neu } }
    }
    case 'insert':
      return { name: 'code', error: 'insert isn\'t available here. Use str_replace: put the line you want to insert after in old_str, and that line followed by the new text in new_str.' }
    default:
      return { name: 'code', error: `Unknown text editor command "${String(input.command)}". Use view, create or str_replace.` }
  }
}
