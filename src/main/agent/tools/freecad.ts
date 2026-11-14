import { existsSync, mkdirSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { densityOf, findFreecadCmd, isReadable, runFreecad, WRITE_EXT, type FreecadOp } from '../../cad/freecad'
import type { ToolContext, ToolDef } from '../types'
import { resolvePath } from './files'

// Local CAD files through FreeCAD's command-line build (registered only when FreeCAD is installed):
// inspect (size, volume, mass with a density, part count), measure (per body) and convert between
// STEP / IGES / BREP / STL / OBJ (and from FCStd). Reads the user's files; writes only the converted
// file, inside the workspace.

export interface FreecadArgs {
  action: FreecadOp
  path: string
  output?: string
  format?: 'step' | 'iges' | 'brep' | 'stl' | 'obj'
  density?: number | string
  tolerance_mm?: number
  timeout_s?: number
}

const MM_TO_IN = 1 / 25.4
const f = (x: unknown, d = 3): string => (typeof x === 'number' && Number.isFinite(x) ? String(Number(x.toFixed(d))) : '?')
const box = (b: { size?: number[] } | null | undefined): string => (b?.size ? `${b.size.map((x) => f(x, 2)).join(' × ')} mm (${b.size.map((x) => f(x * MM_TO_IN, 3)).join(' × ')} in)` : '?')

/** Plain-text report of an inspect / measure / convert result. */
export function formatFreecad(op: FreecadOp, file: string, r: Record<string, any>, density?: number): string {
  const lines: string[] = []
  if (op === 'inspect') {
    const vol = Number(r.volume_mm3) || 0
    lines.push(`${file}: ${r.kind === 'mesh' ? `mesh with ${r.facets} triangles${r.closed ? ' (closed)' : ' (NOT closed: volume is unreliable)'}` : `${r.solids} solid${r.solids === 1 ? '' : 's'}, ${r.faces} faces${r.valid === false ? ' (geometry has errors)' : ''}`}`)
    lines.push(`- Bounding box: ${box(r.bbox_mm)}`)
    lines.push(`- Volume: ${f(vol / 1000, 3)} cm³ (${f(vol * MM_TO_IN ** 3, 3)} in³); surface area ${f((Number(r.area_mm2) || 0) / 100, 2)} cm²`)
    if (density) lines.push(`- Mass at ${density} g/cm³: ${f((vol / 1000) * density, 1)} g (${f(((vol / 1000) * density) / 453.592, 3)} lb)`)
    else lines.push('- Mass: pass density (g/cm³ or a material like "aluminum", "steel", "PLA") to get it.')
    if (r.center_of_mass_mm) lines.push(`- Center of volume: (${r.center_of_mass_mm.map((x: number) => f(x, 2)).join(', ')}) mm`)
    if (r.objects?.length) lines.push(`- Objects: ${r.objects.slice(0, 40).map((x: string) => String(x).slice(0, 60)).join(', ')}${r.objects.length > 40 ? ', …' : ''}`)
  } else if (op === 'measure') {
    lines.push(`${file}: ${r.total} bod${r.total === 1 ? 'y' : 'ies'}${(r.bodies?.length ?? 0) < r.total ? ` (first ${r.bodies.length})` : ''}:`)
    for (const b of r.bodies ?? []) lines.push(`${b.index}. ${box(b.bbox_mm)}; volume ${f(b.volume_mm3 / 1000, 3)} cm³${density ? ` → ${f((b.volume_mm3 / 1000) * density, 1)} g` : ''}${b.center_of_mass_mm ? `; center (${b.center_of_mass_mm.map((x: number) => f(x, 1)).join(', ')}) mm` : ''}`)
  } else {
    lines.push(`Converted ${file} → ${r.output} (${f((Number(r.bytes) || 0) / 1024, 0)} KB).`)
  }
  return lines.join('\n')
}

export function freecadTool(d: { workspace: () => string; bin?: () => string | null }): ToolDef<FreecadArgs> {
  const bin = d.bin ?? (() => findFreecadCmd())
  const input = (a: FreecadArgs, ctx: ToolContext): string => {
    const full = resolvePath(a.path, d.workspace(), ctx.state.roots ?? [])
    if (!existsSync(full)) throw new Error(`No such file: ${a.path}`)
    if (statSync(full).isDirectory()) throw new Error(`${a.path} is a folder; pass one CAD file.`)
    if (!isReadable(full)) throw new Error(`${basename(full)}: FreeCAD here reads STEP, IGES, BREP, STL, OBJ and FCStd files.`)
    if (statSync(full).size > 500 * 1024 * 1024) throw new Error(`${basename(full)} is over 500 MB; too large to open here.`)
    return full
  }
  const output = (a: FreecadArgs, src: string, ctx: ToolContext): string => {
    const ext = a.format ? `.${a.format}` : a.output ? extname(a.output) : ''
    if (!a.output && !a.format) throw new Error('convert needs format (step, iges, brep, stl, obj) or output (a file path in the workspace).')
    const rel = a.output ?? join('exports', 'freecad', `${basename(src, extname(src))}${ext}`)
    const full = resolvePath(rel, d.workspace(), ctx.state.roots ?? [])
    if (!WRITE_EXT.test(full)) throw new Error('Output must end in .step, .stp, .iges, .igs, .brep, .stl or .obj.')
    if (full === src) throw new Error('Output would overwrite the input; choose another name.')
    mkdirSync(join(full, '..'), { recursive: true })
    return full
  }
  return {
    name: 'freecad',
    label: 'FreeCAD',
    group: 'CAD',
    untrusted: true,
    effect: (a) => (a.action === 'convert' ? 'write_local' : 'read'),
    describe: (a) => (a.action === 'convert' ? `Convert ${basename(a.path ?? '')} to ${a.format ?? extname(a.output ?? '')} with FreeCAD` : `FreeCAD ${a.action} ${basename(a.path ?? '')}`),
    description: 'Local CAD files with FreeCAD (cad, step, stl): inspect (bounding box, volume, surface area, mass with density in g/cm³ or a material name like "aluminum"/"steel"/"PLA", solid/part count, objects), measure (each body: size, volume, center), convert (format step/iges/brep/stl/obj or output path; tolerance_mm for meshing, default 0.1). Reads STEP, IGES, BREP, STL, OBJ, FCStd; paths in the workspace or attached folders; converted files go to exports/freecad in the workspace.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['inspect', 'measure', 'convert'] },
        path: { type: 'string', description: 'The CAD file' },
        output: { type: 'string', description: 'convert: output file (workspace-relative)' },
        format: { type: 'string', enum: ['step', 'iges', 'brep', 'stl', 'obj'] },
        density: { type: ['number', 'string'], description: 'g/cm³, or a material name' },
        tolerance_mm: { type: 'number', minimum: 0.001, maximum: 10 },
        timeout_s: { type: 'integer', minimum: 10, maximum: 600 }
      },
      required: ['action', 'path'],
      additionalProperties: false
    },
    async run(a, ctx) {
      const b = bin()
      if (!b) throw new Error('FreeCAD is not installed (no freecadcmd). Install it from https://www.freecad.org/downloads.php, or use the onshape tool for Onshape documents.')
      const src = input(a, ctx)
      const density = densityOf(a.density)
      if (a.density !== undefined && density === undefined) throw new Error(`Unknown density "${String(a.density).slice(0, 40)}": give g/cm³ (aluminum 2.70, steel 7.85, polycarbonate 1.20, PLA 1.24) or one of those names.`)
      const out = a.action === 'convert' ? output(a, src, ctx) : undefined
      ctx.progress?.(`FreeCAD ${a.action} ${basename(src)}…`)
      const r = await runFreecad(b, a.action, { input: src, output: out, tolerance_mm: a.tolerance_mm }, { timeoutMs: (a.timeout_s ?? 120) * 1000, signal: ctx.signal })
      if (!r.ok) throw new Error(`FreeCAD could not ${a.action} ${basename(src)}: ${r.error}`)
      return { text: formatFreecad(a.action, basename(src), r.result!, density), display: `FreeCAD ${a.action}: ${basename(src)}`, path: out }
    }
  }
}
