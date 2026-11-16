// An approval in plain words for the Needs-you inbox: "Read “Chemistry EP.md”" in "Obsidian Vault › Areas ›
// School", instead of "Read file" and "Hard stop: reading /Users/…/Chemistry EP.md, outside your folders".

const VERB: Record<string, string> = { reading: 'Read', writing: 'Save', copying: 'Copy', 'copying to': 'Copy to', moving: 'Move', 'moving to': 'Move to', 'creating a folder at': 'Make a folder' }
const HOME = /^\/Users\/[^/]+\/(Documents|Desktop|Downloads|Pictures|Music|Movies|Library\/Mobile Documents\/com~apple~CloudDocs)?\/?/

const name = (p: string): string => p.split('/').filter(Boolean).pop() ?? p

/** "/Users/me/Documents/Obsidian Vault/Areas/School/x.md" → "Obsidian Vault › Areas › School". */
export function whereOf(path: string): string {
  const parts = path.replace(HOME, '').split('/').filter(Boolean)
  return parts.slice(0, -1).join(' › ') || 'your home folder'
}

export interface PlainApproval { title: string; where?: string; why?: string }

export function plainApproval(a: { label?: string; summary?: string; reason?: string } | undefined): PlainApproval {
  const reason = (a?.reason ?? '').replace(/^Hard stop:\s*/i, '').trim()
  const outside = reason.match(/^(reading|writing|copying to|copying|moving to|moving|creating a folder at) (\/.+?), outside your folders$/)
  if (outside) {
    return { title: `${VERB[outside[1]] ?? 'Use'} “${name(outside[2])}”`, where: whereOf(outside[2]), why: 'It\'s outside the folders this bot can use.' }
  }
  const title = a?.summary?.trim() || a?.label || 'An action'
  return { title, ...(reason && reason.toLowerCase() !== title.toLowerCase() ? { why: reason.charAt(0).toUpperCase() + reason.slice(1) } : {}) }
}

export const folderName = (path: string): string => name(path)
