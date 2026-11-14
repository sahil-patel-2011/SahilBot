import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { densityOf, findFreecadCmd, freecadScript, runFreecad } from '../../src/main/cad/freecad'
import { which } from '../../src/main/code/proc'
import { formatFreecad, freecadTool } from '../../src/main/agent/tools/freecad'
import { emptyState, type ToolContext } from '../../src/main/agent/types'

const ctx = (ws: string): ToolContext => ({ threadId: 't', signal: new AbortController().signal, workspaceDir: ws, docsDir: ws, askUser: async () => '', state: emptyState(), loadTools: () => [], searchTools: () => [], readResult: () => undefined })

/** A stand-in for freecadcmd: reads RESULT_PATH out of the generated script and writes a canned result. */
function fakeBin(dir: string, result: string): string {
  const bin = join(dir, 'freecadcmd')
  writeFileSync(bin, `#!/bin/sh\nRP=$(sed -n 's/^RESULT_PATH = "\\(.*\\)"$/\\1/p' "$1")\ncat > "$RP" <<'JSON'\n${result}\nJSON\n`)
  chmodSync(bin, 0o755)
  return bin
}

describe('freecad scripts', () => {
  test('paths reach Python only as JSON (quotes, newlines and backslashes cannot break out)', () => {
    const evil = '/tmp/a"; import os; os.system("rm -rf ~") #\n\\b.step'
    const s = freecadScript('inspect', { input: evil }, '/tmp/r.json')
    expect(s.split('\n')[0]).toBe(`ARGS_JSON = ${JSON.stringify(JSON.stringify({ input: evil }))}`)
    expect(s).not.toContain('os.system("rm')
    expect(s).toContain('ARGS = json.loads(ARGS_JSON)')
    expect(s).toContain('RESULT_PATH = "/tmp/r.json"')
    expect(s).toContain('os._exit(0)')
    expect(freecadScript('convert', { input: '/a.stl', output: '/b.step', tolerance_mm: 0.05 }, '/r.json')).toContain('obj.exportStep(out)')
    expect(freecadScript('measure', { input: '/a.step' }, '/r.json')).toContain('obj.Solids[:200]')
  })
  test('generated scripts are valid Python (checked when python3 is on this Mac)', () => {
    const py = which('python3')
    if (!py) return
    const dir = mkdtempSync(join(tmpdir(), 'fc-py-'))
    for (const op of ['inspect', 'measure', 'convert'] as const) {
      const f = join(dir, `${op}.py`)
      writeFileSync(f, freecadScript(op, { input: '/x/"q".step', output: '/x/o.stl' }, '/x/r.json'))
      expect(() => execFileSync(py, ['-I', '-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read())', f], { stdio: 'pipe' }), op).not.toThrow()
    }
  })
  test('finds the app bundle first, then PATH; null when FreeCAD is missing', () => {
    expect(findFreecadCmd({ exists: (p) => p === '/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd', onPath: () => null })).toBe('/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd')
    expect(findFreecadCmd({ exists: () => false, onPath: (n) => (n === 'FreeCADCmd' ? '/opt/homebrew/bin/FreeCADCmd' : null) })).toBe('/opt/homebrew/bin/FreeCADCmd')
    expect(findFreecadCmd({ exists: () => false, onPath: () => null })).toBeNull()
  })
  test('densities by number or material name', () => {
    expect(densityOf('Aluminum')).toBe(2.7)
    expect(densityOf('6061-T6')).toBe(2.7)
    expect(densityOf('PLA')).toBe(1.24)
    expect(densityOf(7.85)).toBe(7.85)
    expect(densityOf('1.2')).toBe(1.2)
    expect(densityOf('unobtainium')).toBeUndefined()
    expect(densityOf(-1)).toBeUndefined()
  })
})

describe('freecad tool', () => {
  const RESULT = JSON.stringify({ ok: true, kind: 'shape', solids: 2, shells: 2, faces: 40, volume_mm3: 100000, area_mm2: 25000, valid: true, center_of_mass_mm: [1, 2, 3], bbox_mm: { size: [254, 50.8, 6.35] }, objects: ['Plate', 'Spacer'] })
  test('inspect runs the script with freecadcmd in a temp folder and reports size, volume and mass', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'fc-ws-'))
    writeFileSync(join(ws, 'plate.step'), 'ISO-10303-21;')
    const bin = fakeBin(mkdtempSync(join(tmpdir(), 'fc-bin-')), RESULT)
    const t = freecadTool({ workspace: () => ws, bin: () => bin })
    expect(t.group).toBe('CAD')
    expect((t.effect as (a: unknown) => string)({ action: 'inspect' })).toBe('read')
    expect((t.effect as (a: unknown) => string)({ action: 'convert' })).toBe('write_local')
    const out = await t.run({ action: 'inspect', path: 'plate.step', density: 'aluminum' }, ctx(ws))
    expect(out.text).toContain('plate.step: 2 solids, 40 faces')
    expect(out.text).toContain('Bounding box: 254 × 50.8 × 6.35 mm (10 × 2 × 0.25 in)')
    expect(out.text).toContain('Mass at 2.7 g/cm³: 270 g (0.595 lb)')
  })
  test('convert writes into the workspace exports folder; bad inputs are explained', async () => {
    const ws = realpathSync(mkdtempSync(join(tmpdir(), 'fc-ws-')))
    writeFileSync(join(ws, 'part.stl'), 'solid x')
    const bin = fakeBin(mkdtempSync(join(tmpdir(), 'fc-bin-')), JSON.stringify({ ok: true, output: join(ws, 'exports/freecad/part.step'), bytes: 2048 }))
    const t = freecadTool({ workspace: () => ws, bin: () => bin })
    const out = await t.run({ action: 'convert', path: 'part.stl', format: 'step' }, ctx(ws))
    expect(out.path).toBe(join(ws, 'exports', 'freecad', 'part.step'))
    expect(existsSync(join(ws, 'exports', 'freecad'))).toBe(true)
    await expect(t.run({ action: 'convert', path: 'part.stl' }, ctx(ws))).rejects.toThrow(/needs format/)
    await expect(t.run({ action: 'inspect', path: '/etc/hosts' }, ctx(ws))).rejects.toThrow(/outside the workspace/)
    writeFileSync(join(ws, 'notes.txt'), 'x')
    await expect(t.run({ action: 'inspect', path: 'notes.txt' }, ctx(ws))).rejects.toThrow(/reads STEP, IGES/)
    await expect(t.run({ action: 'inspect', path: 'part.stl', density: 'unobtainium' }, ctx(ws))).rejects.toThrow(/Unknown density/)
    const none = freecadTool({ workspace: () => ws, bin: () => null })
    await expect(none.run({ action: 'inspect', path: 'part.stl' }, ctx(ws))).rejects.toThrow(/FreeCAD is not installed/)
  })
  test('a FreeCAD error comes back as a plain message', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fc-bin-'))
    const bin = fakeBin(dir, JSON.stringify({ ok: false, error: 'Cannot read file' }))
    const r = await runFreecad(bin, 'inspect', { input: '/x.step' })
    expect(r).toMatchObject({ ok: false, error: 'Cannot read file' })
    expect(formatFreecad('measure', 'a.step', { total: 1, bodies: [{ index: 1, volume_mm3: 1000, bbox_mm: { size: [10, 10, 10] }, center_of_mass_mm: [0, 0, 5] }] }, 1.24)).toContain('1. 10 × 10 × 10 mm (0.394 × 0.394 × 0.394 in); volume 1 cm³ → 1.2 g; center (0, 0, 5) mm')
  })
})
