import { existsSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { expandPath, JXA_GET, type AppAction, type AppAdapter } from './types'

// Code editors: VS Code and Cursor (open a file at a line with their command-line tools; build and run
// commands through their own shortcuts and command palette, via computer use) and Xcode (open at a line
// with xed; build, test, run, clean and stop through its scripting dictionary, with the errors back).

/** Command-palette commands that throw work away or reach other people: they always ask. */
const RISKY_COMMAND = /\b(delete|remove|discard|revert|reset|force|publish|push|sync|deploy|uninstall|clean|close all|reload window|undo last commit)\b/i

export const XCODE_SCRIPTS = {
  ACTION: `(a) => { ${JXA_GET}
    const X = Application('Xcode')
    const ws = get(() => X.activeWorkspaceDocument(), null)
    if (!ws || !get(() => ws.name(), null)) return { error: 'No Xcode project or workspace is open. Open one with the open action first.' }
    if (a.scheme) {
      const names = get(() => ws.schemes.name(), [])
      const i = names.indexOf(a.scheme)
      if (i < 0) return { error: 'No scheme "' + a.scheme + '". Schemes: ' + names.join(', ') }
      ws.activeScheme = ws.schemes[i]
    }
    const scheme = String(get(() => ws.activeScheme().name(), '') || '')
    if (a.op === 'stop') { ws.stop(); return { workspace: ws.name(), scheme: scheme, stopped: true } }
    if (a.op === 'schemes') return { workspace: ws.name(), scheme: scheme, schemes: get(() => ws.schemes.name(), []) }
    const r = a.op === 'test' ? ws.test() : a.op === 'run' ? ws.run() : a.op === 'clean' ? ws.clean() : ws.build()
    if (a.op === 'run') { delay(2); return { workspace: ws.name(), scheme: scheme, started: true, status: String(get(() => r.status(), '')) } }
    const end = Date.now() + a.timeoutMs
    while (!get(() => r.completed(), true) && Date.now() < end) delay(1)
    const issue = (e) => ({ message: String(get(() => e.message(), '')), file: String(get(() => e.filePath(), '') || ''), line: get(() => e.startingLineNumber(), null) })
    const errors = get(() => r.buildErrors(), []).slice(0, 40).map(issue)
    const warnings = get(() => r.buildWarnings(), [])
    const tests = get(() => r.testFailures(), []).slice(0, 40).map(issue)
    return { workspace: ws.name(), scheme: scheme, completed: get(() => r.completed(), false), status: String(get(() => r.status(), '')), error: undefined, errorMessage: String(get(() => r.errorMessage(), '') || ''),
      errors: errors, warningCount: warnings.length, warnings: warnings.slice(0, 10).map(issue), testFailures: tests, log: a.log ? String(get(() => r.buildLog(), '') || '').slice(-8000) : undefined }
  }`
}

type XResult = { error?: string; workspace: string; scheme: string; completed?: boolean; status?: string; errorMessage?: string; stopped?: boolean; started?: boolean; schemes?: string[]
  errors?: Array<{ message: string; file: string; line: number | null }>; warningCount?: number; warnings?: Array<{ message: string; file: string; line: number | null }>; testFailures?: Array<{ message: string; file: string; line: number | null }>; log?: string }

export function formatXcode(op: string, r: XResult): string {
  if (r.stopped) return `Stopped ${r.workspace} (${r.scheme}).`
  if (r.schemes) return `${r.workspace}: active scheme "${r.scheme}". Schemes: ${r.schemes.join(', ')}`
  if (r.started) return `Started running ${r.workspace} (${r.scheme})${r.status ? `: ${r.status}` : ''}. Stop it with the stop action.`
  const where = (i: { file: string; line: number | null }): string => (i.file ? ` (${basename(i.file)}${i.line ? `:${i.line}` : ''})` : '')
  const lines = [`${op} of ${r.workspace} (${r.scheme}): ${r.completed ? r.status || 'finished' : 'still running (time limit reached; check again later)'}.`]
  if (r.errorMessage) lines.push(r.errorMessage)
  if (r.errors?.length) lines.push(`${r.errors.length} error${r.errors.length > 1 ? 's' : ''}:`, ...r.errors.map((e) => `- ${e.message}${where(e)}${e.file ? ` [${e.file}]` : ''}`))
  if (r.testFailures?.length) lines.push(`${r.testFailures.length} test failure${r.testFailures.length > 1 ? 's' : ''}:`, ...r.testFailures.map((e) => `- ${e.message}${where(e)}`))
  if (r.warningCount) lines.push(`${r.warningCount} warning${r.warningCount > 1 ? 's' : ''}${r.warnings?.length ? `, e.g.:\n${r.warnings.map((w) => `- ${w.message}${where(w)}`).join('\n')}` : ''}`)
  if (r.log) lines.push('Build log (end):', r.log)
  return lines.join('\n')
}

function vscodeLike(o: { id: string; name: string; aliases: string[]; bundleIds: string[]; paths: string[]; cli: string }): AppAdapter {
  const open: AppAction = {
    summary: 'Open a file (at a line and column) or a folder',
    args: { path: { type: 'string', required: true, description: 'file or folder' }, line: { type: 'number', description: 'line to jump to' }, column: { type: 'number', description: 'column' } },
    effect: 'write_local',
    describe: (a) => `Open ${a.path}${a.line ? `:${a.line}` : ''} in ${o.name}`,
    async run(a, env) {
      const p = expandPath(a.path, env.workspace)
      if (!existsSync(p)) throw new Error(`Not found: ${p}`)
      const file = statSync(p).isFile()
      if (existsSync(o.cli)) await env.sh(o.cli, file && a.line ? ['-g', `${p}:${Number(a.line)}${a.column ? `:${Number(a.column)}` : ''}`] : [p], 20_000)
      else await env.sh('open', ['-a', o.name, p])
      return { text: `Opened ${p}${a.line ? ` at line ${a.line}` : ''} in ${o.name}.${!existsSync(o.cli) && a.line ? ' (Its command-line tool wasn\'t found, so it opened at the top: press ctrl+g and type the line number to jump.)' : ''}`, display: `opened ${basename(p)}`, path: p }
    }
  }
  return {
    ...o,
    blurb: 'open a file at a line, run the build task, run any command-palette command',
    skill: 'app-dev-tools',
    notes: `Opens files with its command-line tool (${o.cli}). Builds and commands use ${o.name}'s shortcuts (⌘⇧B, ⌘⇧P) through computer use; read results in its terminal or Problems panel with computer ui or a screenshot. For editing code use the code tool, not the editor's UI.`,
    actions: {
      open,
      build: {
        summary: 'Run the default build task (⌘⇧B)',
        effect: 'write_external',
        drives: true,
        describe: () => `Run the build task in ${o.name}`,
        async run(_a, env) {
          await env.computer({ action: 'activate_app', app: o.name })
          const r = await env.computer({ action: 'key', keys: 'cmd+shift+b' })
          return { text: `Started the build task in ${o.name}. ${r.text} If it asks which task, pick one with computer ui; read the output in its terminal (screenshot or ui).`, display: 'started build' }
        }
      },
      command: {
        summary: 'Run a command-palette command by name, e.g. "Tasks: Run Task", "Format Document"',
        args: { name: { type: 'string', required: true, description: 'the command as the palette shows it' } },
        effect: 'write_external',
        drives: true,
        hardStop: (a) => (RISKY_COMMAND.test(String(a.name ?? '')) ? `running "${a.name}" in ${o.name}` : null),
        describe: (a) => `Run "${a.name}" in ${o.name}'s command palette`,
        async run(a, env) {
          await env.computer({ action: 'activate_app', app: o.name })
          await env.computer({ action: 'key', keys: 'cmd+shift+p' })
          await env.computer({ action: 'wait', seconds: 0.4 })
          await env.computer({ action: 'type', text: String(a.name) })
          await env.computer({ action: 'wait', seconds: 0.5 })
          const r = await env.computer({ action: 'key', keys: 'return' })
          return { text: `Ran "${a.name}" from ${o.name}'s command palette (the top match). ${r.text} Check the result with a screenshot or ui.`, display: `ran "${String(a.name).slice(0, 40)}"` }
        }
      }
    }
  }
}

export const vscode = vscodeLike({ id: 'vscode', name: 'Visual Studio Code', aliases: ['vs code', 'vscode', 'code'], bundleIds: ['com.microsoft.VSCode'], paths: ['/Applications/Visual Studio Code.app'], cli: '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code' })
export const cursorEditor = vscodeLike({ id: 'cursor', name: 'Cursor', aliases: ['cursor editor'], bundleIds: ['com.todesktop.230313mzl4w4u92'], paths: ['/Applications/Cursor.app'], cli: '/Applications/Cursor.app/Contents/Resources/app/bin/cursor' })

const xop = (op: string, summary: string, effect: 'write_local' | 'read', timeoutMin = 15): AppAction => ({
  summary,
  args: op === 'stop' || op === 'schemes' ? undefined : { scheme: { type: 'string', description: 'scheme to use (default: the active one)' }, ...(op === 'run' ? {} : { minutes: { type: 'number', description: `wait at most this long (default ${timeoutMin})` }, log: { type: 'boolean', description: 'include the end of the build log' } }) },
  effect,
  needsRunning: true,
  describe: (a) => `${op[0].toUpperCase()}${op.slice(1)} the Xcode project${a.scheme ? ` (scheme ${a.scheme})` : ''}`,
  async run(a, env) {
    const minutes = Math.min(60, Number(a.minutes) || timeoutMin)
    const r = await env.jxa<XResult>(XCODE_SCRIPTS.ACTION, { op, scheme: a.scheme, timeoutMs: minutes * 60_000, log: !!a.log }, minutes * 60_000 + 60_000)
    if (r.error) throw new Error(r.error)
    const failed = (r.errors?.length ?? 0) + (r.testFailures?.length ?? 0)
    return { text: formatXcode(op, r), display: op === 'schemes' ? `${r.schemes?.length ?? 0} schemes` : `${op}: ${failed ? `${failed} problems` : r.status || 'done'}` }
  }
})

export const xcode: AppAdapter = {
  id: 'xcode',
  name: 'Xcode',
  aliases: [],
  bundleIds: ['com.apple.dt.Xcode'],
  paths: ['/Applications/Xcode.app', '/Applications/Xcode-beta.app'],
  blurb: 'open a file at a line, build/test/run/clean/stop with errors and test failures back, schemes',
  skill: 'app-dev-tools',
  notes: 'Opens files with xed; builds through Xcode\'s scripting dictionary on the front workspace. For command-line builds use run_command with xcodebuild instead (no UI needed).',
  actions: {
    open: {
      summary: 'Open a project, workspace or file (at a line)',
      args: { path: { type: 'string', required: true, description: '.xcodeproj, .xcworkspace, Package.swift or a source file' }, line: { type: 'number', description: 'line to jump to' } },
      effect: 'write_local',
      describe: (a) => `Open ${a.path}${a.line ? `:${a.line}` : ''} in Xcode`,
      async run(a, env) {
        const p = expandPath(a.path, env.workspace)
        if (!existsSync(p)) throw new Error(`Not found: ${p}`)
        await env.sh('/usr/bin/xed', a.line ? ['--line', String(Number(a.line)), p] : [p], 60_000)
        return { text: `Opened ${p}${a.line ? ` at line ${a.line}` : ''} in Xcode.`, display: `opened ${basename(p)}`, path: p }
      }
    },
    schemes: xop('schemes', 'The workspace\'s schemes and the active one', 'read'),
    build: xop('build', 'Build and return errors and warnings', 'write_local'),
    test: xop('test', 'Run the tests and return failures', 'write_local', 30),
    run: xop('run', 'Build and run the app', 'write_local'),
    clean: xop('clean', 'Clean the build folder', 'write_local'),
    stop: xop('stop', 'Stop the running app or build', 'write_local')
  }
}
