import { existsSync, renameSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { CLIP } from '../clipboard'
import { expandPath, insideRoots, JXA_GET, JXA_POSIX, listOf, type ActionScope, type AppAdapter, type Args } from './types'

// Finder through its scripting dictionary: open, reveal, the selection, new folders, move, rename, copy
// and the Trash. Changes inside the workspace or the chat's attached folders are routine; anything
// outside them, or that would replace an existing item, asks. The Trash always asks.

/** Opening these runs something (apps, scripts, installers). */
const RUNS = /\.(app|command|tool|sh|bash|zsh|csh|terminal|workflow|action|pkg|mpkg|prefpane|jar|py|rb|pl|scpt|scptd|applescript|osascript|shortcut)\/?$/i

export const FINDER_SCRIPTS = {
  SELECTION: `(a) => { ${JXA_GET}; ${JXA_POSIX}
    const F = Application('Finder')
    return get(() => F.selection(), []).slice(0, 500).map((x) => get(() => posix(x.url()), null)).filter(Boolean).map((p) => p.length > 1 ? p.replace(/\\/$/, '') : p)
  }`,
  FRONT_FOLDER: `(a) => { ${JXA_GET}; ${JXA_POSIX}
    const F = Application('Finder')
    const u = get(() => F.finderWindows[0].target().url(), null) || get(() => F.insertionLocation().url(), null)
    return u ? posix(u).replace(/(.)\\/$/, '$1') : null
  }`,
  REVEAL: `(a) => { const F = Application('Finder'); F.reveal(a.paths.map((p) => Path(p))); F.activate(); return true }`,
  NEW_FOLDER: `(a) => { ${JXA_POSIX}
    const F = Application('Finder')
    const f = F.make({ new: 'folder', at: Path(a.dir), withProperties: { name: a.name } })
    return posix(f.url())
  }`,
  MOVE: `(a) => { const F = Application('Finder'); F.move(a.paths.map((p) => Path(p)), { to: Path(a.to), replacing: false }); return true }`,
  DUPLICATE: `(a) => { const F = Application('Finder'); F.duplicate(a.paths.map((p) => Path(p)), { to: Path(a.to), replacing: false }); return true }`,
  TRASH: `(a) => { const F = Application('Finder'); F.delete(a.paths.map((p) => Path(p))); return true }`
}

/** Moving or copying items into a folder: routine when everything is inside the chat's folders and nothing is replaced. */
export function transferEffect(a: Args, s: ActionScope): 'write_local' | 'destructive' {
  const paths = listOf(a.paths ?? a.path)
  const to = a.to ? expandPath(String(a.to), s.workspace) : ''
  if (!paths.length || !to) return 'destructive'
  if (!insideRoots(to, s) || !paths.every((p) => insideRoots(p, s))) return 'destructive'
  return paths.some((p) => existsSync(join(to, basename(expandPath(p, s.workspace))))) ? 'destructive' : 'write_local'
}

export function renameEffect(a: Args, s: ActionScope): 'write_local' | 'destructive' {
  if (!a.path || !a.name) return 'destructive'
  const from = expandPath(String(a.path), s.workspace)
  const to = join(dirname(from), String(a.name))
  return insideRoots(from, s) && !existsSync(to) ? 'write_local' : 'destructive'
}

const pathsOf = (a: Args, w: string): string[] => listOf(a.paths ?? a.path).map((p) => expandPath(p, w))
const mustExist = (ps: string[]): void => { const gone = ps.filter((p) => !existsSync(p)); if (gone.length) throw new Error(`Not found: ${gone.join(', ')}`) }

export const finder: AppAdapter = {
  id: 'finder',
  name: 'Finder',
  aliases: ['files', 'file manager'],
  bundleIds: ['com.apple.finder'],
  paths: ['/System/Library/CoreServices/Finder.app'],
  blurb: 'files and folders: open, reveal, selection, new folder, move, rename, copy, Trash',
  skill: 'app-finder',
  notes: 'Uses Finder\'s scripting dictionary (macOS asks once to allow SahilBot to control Finder). For reading or writing file contents use the file tools; for drag-and-drop or sidebar tasks fall back to computer use (computer ui {app:"Finder"}).',
  actions: {
    open: {
      summary: 'Open a file or folder (in its default app, or the app given)',
      args: { path: { type: 'string', required: true, description: 'file or folder' }, with: { type: 'string', description: 'app to open it with, e.g. "Preview"' } },
      effect: (a) => (RUNS.test(String(a.path ?? '')) ? 'destructive' : 'write_local'),
      hardStop: (a) => (RUNS.test(String(a.path ?? '')) ? `opening ${basename(String(a.path ?? 'it'))} runs it (an app, script or installer)` : null),
      describe: (a) => `Open ${a.path}${a.with ? ` with ${a.with}` : ''}`,
      async run(a, env) {
        const p = expandPath(a.path, env.workspace)
        mustExist([p])
        await env.sh('open', a.with ? ['-a', String(a.with), p] : [p])
        return { text: `Opened ${p}${a.with ? ` with ${a.with}` : ''}.`, display: `opened ${basename(p)}`, path: p }
      }
    },
    reveal: {
      summary: 'Show items selected in a Finder window',
      args: { paths: { type: 'array', required: true, description: 'files or folders (or one path)' } },
      effect: 'write_local',
      describe: (a) => `Show ${listOf(a.paths).join(', ')} in Finder`,
      async run(a, env) {
        const ps = pathsOf(a, env.workspace)
        mustExist(ps)
        await env.jxa(FINDER_SCRIPTS.REVEAL, { paths: ps })
        return { text: `Revealed ${ps.length} item${ps.length > 1 ? 's' : ''} in Finder.`, display: 'revealed in Finder' }
      }
    },
    selection: {
      summary: 'The paths of the items selected in Finder',
      effect: 'read',
      needsRunning: true,
      describe: () => 'Read the Finder selection',
      async run(_a, env) {
        const ps = await env.jxa<string[]>(FINDER_SCRIPTS.SELECTION, {})
        return { text: ps.length ? ps.join('\n') : 'Nothing is selected in Finder.', display: `${ps.length} selected` }
      }
    },
    front_folder: {
      summary: 'The folder shown in the front Finder window (or the Desktop)',
      effect: 'read',
      needsRunning: true,
      describe: () => 'Read the front Finder folder',
      async run(_a, env) {
        const p = await env.jxa<string | null>(FINDER_SCRIPTS.FRONT_FOLDER, {})
        return { text: p ?? 'No Finder window is open.', display: p ? basename(p) : 'no Finder window' }
      }
    },
    copy_paths: {
      summary: 'Put file paths (default: the Finder selection) on the clipboard, one per line, and return them',
      args: { paths: { type: 'array', description: 'paths to copy instead of the selection' } },
      effect: 'write_local',
      describe: (a) => `Copy ${a.paths ? listOf(a.paths).length : 'the selected items\''} path(s) to the clipboard`,
      async run(a, env) {
        const ps = a.paths ? pathsOf(a, env.workspace) : await env.jxa<string[]>(FINDER_SCRIPTS.SELECTION, {})
        if (!ps.length) return { text: 'Nothing is selected in Finder, so no paths were copied.', display: 'nothing selected' }
        const r = await env.jxa<{ error?: string }>(CLIP, { op: 'write', text: ps.join('\n') })
        if (r?.error) throw new Error(r.error)
        return { text: `Copied ${ps.length} path${ps.length > 1 ? 's' : ''} to the clipboard:\n${ps.join('\n')}`, display: `copied ${ps.length} paths` }
      }
    },
    new_folder: {
      summary: 'Create a folder',
      args: { in: { type: 'string', required: true, description: 'the folder to create it in' }, name: { type: 'string', required: true, description: 'its name' } },
      effect: (a, s) => (a.in && insideRoots(String(a.in), s) ? 'write_local' : 'destructive'),
      describe: (a) => `Create the folder "${a.name}" in ${a.in}`,
      async run(a, env) {
        const dir = expandPath(a.in, env.workspace)
        if (/[/:]/.test(String(a.name))) throw new Error('A folder name can\'t contain "/" or ":".')
        mustExist([dir])
        if (existsSync(join(dir, a.name))) throw new Error(`${join(dir, a.name)} already exists.`)
        const made = await env.jxa<string>(FINDER_SCRIPTS.NEW_FOLDER, { dir, name: String(a.name) })
        return { text: `Created ${made || join(dir, a.name)}.`, display: `created ${a.name}`, path: made || join(dir, a.name) }
      }
    },
    move: {
      summary: 'Move items into a folder (never replaces an item with the same name)',
      args: { paths: { type: 'array', required: true, description: 'files or folders to move' }, to: { type: 'string', required: true, description: 'destination folder' } },
      effect: transferEffect,
      describe: (a) => `Move ${listOf(a.paths).join(', ')} to ${a.to}`,
      async run(a, env) {
        const ps = pathsOf(a, env.workspace)
        const to = expandPath(a.to, env.workspace)
        mustExist([...ps, to])
        if (!statSync(to).isDirectory()) throw new Error(`${to} is not a folder.`)
        const clash = ps.filter((p) => existsSync(join(to, basename(p))))
        if (clash.length) throw new Error(`${to} already has ${clash.map((p) => basename(p)).join(', ')}. Rename first, or ask the user what to do.`)
        await env.jxa(FINDER_SCRIPTS.MOVE, { paths: ps, to })
        return { text: `Moved ${ps.length} item${ps.length > 1 ? 's' : ''} to ${to}: ${ps.map((p) => basename(p)).join(', ')}.`, display: `moved ${ps.length} item${ps.length > 1 ? 's' : ''}` }
      }
    },
    copy: {
      summary: 'Copy (duplicate) items into a folder (never replaces)',
      args: { paths: { type: 'array', required: true, description: 'files or folders to copy' }, to: { type: 'string', required: true, description: 'destination folder' } },
      effect: transferEffect,
      describe: (a) => `Copy ${listOf(a.paths).join(', ')} to ${a.to}`,
      async run(a, env) {
        const ps = pathsOf(a, env.workspace)
        const to = expandPath(a.to, env.workspace)
        mustExist([...ps, to])
        const clash = ps.filter((p) => existsSync(join(to, basename(p))))
        if (clash.length) throw new Error(`${to} already has ${clash.map((p) => basename(p)).join(', ')}.`)
        await env.jxa(FINDER_SCRIPTS.DUPLICATE, { paths: ps, to }, 120_000)
        return { text: `Copied ${ps.length} item${ps.length > 1 ? 's' : ''} to ${to}.`, display: `copied ${ps.length} item${ps.length > 1 ? 's' : ''}` }
      }
    },
    rename: {
      summary: 'Rename a file or folder (in place)',
      args: { path: { type: 'string', required: true, description: 'the item' }, name: { type: 'string', required: true, description: 'new name, with extension' } },
      effect: renameEffect,
      describe: (a) => `Rename ${a.path} to "${a.name}"`,
      async run(a, env) {
        const from = expandPath(a.path, env.workspace)
        if (/[/:]/.test(String(a.name))) throw new Error('A name can\'t contain "/" or ":".')
        mustExist([from])
        const to = join(dirname(from), String(a.name))
        if (existsSync(to) && to.toLowerCase() !== from.toLowerCase()) throw new Error(`${to} already exists.`)
        renameSync(from, to)
        return { text: `Renamed ${basename(from)} to ${basename(to)} (in ${dirname(to)}).`, display: `renamed to ${basename(to)}`, path: to }
      }
    },
    trash: {
      summary: 'Move items to the Trash (always asks; the user can put them back)',
      args: { paths: { type: 'array', required: true, description: 'files or folders' } },
      effect: 'destructive',
      hardStop: (a) => `moving ${listOf(a.paths).length || 'some'} item(s) to the Trash`,
      describe: (a) => `Move to the Trash: ${listOf(a.paths).join(', ')}`,
      async run(a, env) {
        const ps = pathsOf(a, env.workspace)
        mustExist(ps)
        await env.jxa(FINDER_SCRIPTS.TRASH, { paths: ps }, 60_000)
        return { text: `Moved ${ps.length} item${ps.length > 1 ? 's' : ''} to the Trash (the user can put them back from there): ${ps.map((p) => basename(p)).join(', ')}.`, display: `trashed ${ps.length}` }
      }
    }
  }
}
