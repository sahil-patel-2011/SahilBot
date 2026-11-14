import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { runProcess, toolEnv, which } from '../code/proc'

// FreeCAD's command-line build (freecadcmd / FreeCADCmd) runs generated Python scripts to inspect and
// convert CAD files on this Mac. Every path goes into the script as a JSON string (json.loads), never
// spliced in as Python source, and each script writes one JSON result file in its own temp folder.

export type FreecadOp = 'inspect' | 'measure' | 'convert'

const BUNDLE_BINS = ['freecadcmd', 'FreeCADCmd']
const APP_DIRS = ['/Applications/FreeCAD.app/Contents/Resources/bin', join(homedir(), 'Applications/FreeCAD.app/Contents/Resources/bin')]

/** The FreeCAD command-line binary, or null when FreeCAD isn't installed. */
export function findFreecadCmd(o: { exists?: (p: string) => boolean; onPath?: (n: string) => string | null } = {}): string | null {
  const exists = o.exists ?? existsSync
  for (const dir of APP_DIRS) for (const b of BUNDLE_BINS) { const p = join(dir, b); if (exists(p)) return p }
  const onPath = o.onPath ?? which
  for (const b of BUNDLE_BINS) { const p = onPath(b); if (p) return p }
  return null
}

/** g/cm³ for common FRC and 3D-printing materials. */
export const DENSITIES: Record<string, number> = {
  'aluminum': 2.70, 'aluminum 6061': 2.70, '6061': 2.70, '7075': 2.81, 'steel': 7.85, 'stainless': 8.0, 'brass': 8.5, 'copper': 8.96, 'titanium': 4.43,
  'polycarbonate': 1.20, 'pla': 1.24, 'petg': 1.27, 'abs': 1.04, 'nylon': 1.15, 'pa12': 1.01, 'onyx': 1.2, 'tpu': 1.21, 'delrin': 1.41, 'acetal': 1.41, 'hdpe': 0.95, 'uhmw': 0.93,
  'plywood': 0.6, 'wood': 0.6, 'carbon fiber': 1.6
}

/** A density in g/cm³ from a number or a material name. */
export function densityOf(v: number | string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined
  if (typeof v === 'number') return v > 0 && v < 25 ? v : undefined
  const n = Number(v)
  if (Number.isFinite(n)) return densityOf(n)
  const k = v.trim().toLowerCase().replace(/[-_]/g, ' ').replace(/\s+t6$/, '')
  return DENSITIES[k] ?? DENSITIES[k.replace(/\s+/g, '')]
}

const READ_EXT = /\.(step|stp|iges|igs|brep|brp|stl|obj|fcstd)$/i
export const WRITE_EXT = /\.(step|stp|iges|igs|brep|stl|obj)$/i
export const isReadable = (p: string): boolean => READ_EXT.test(p)

const PY_LOAD = `
import json, os, sys, traceback
import FreeCAD
ARGS = json.loads(ARGS_JSON)
RESULT = {"ok": True}

def load(path):
    low = path.lower()
    if low.endswith((".stl", ".obj")):
        import Mesh
        m = Mesh.Mesh(path)
        return ("mesh", m, None)
    if low.endswith(".fcstd"):
        doc = FreeCAD.openDocument(path)
        shapes, names = [], []
        for o in doc.Objects:
            if hasattr(o, "Shape") and not o.Shape.isNull() and o.Shape.Solids and (not o.InList or all(not hasattr(p, "Shape") for p in o.InList)):
                shapes.append(o.Shape)
                names.append(o.Label)
        import Part
        comp = Part.makeCompound(shapes) if shapes else Part.Shape()
        return ("shape", comp, names)
    import Part
    s = Part.read(path)
    return ("shape", s, None)

def bbox(b):
    return {"x": [b.XMin, b.XMax], "y": [b.YMin, b.YMax], "z": [b.ZMin, b.ZMax], "size": [b.XLength, b.YLength, b.ZLength]}
`

const PY_INSPECT = `
kind, obj, names = load(ARGS["input"])
if kind == "mesh":
    RESULT.update({"kind": "mesh", "facets": obj.CountFacets, "points": obj.CountPoints, "volume_mm3": obj.Volume, "area_mm2": obj.Area, "closed": bool(obj.isSolid()), "bbox_mm": bbox(obj.BoundBox)})
else:
    solids = obj.Solids
    vol = sum(s.Volume for s in solids)
    com = None
    if solids and vol > 0:
        c = [0.0, 0.0, 0.0]
        for s in solids:
            p = s.CenterOfMass
            c = [c[0] + p.x * s.Volume, c[1] + p.y * s.Volume, c[2] + p.z * s.Volume]
        com = [x / vol for x in c]
    RESULT.update({"kind": "shape", "solids": len(solids), "shells": len(obj.Shells), "faces": len(obj.Faces), "volume_mm3": vol, "area_mm2": obj.Area, "valid": bool(obj.isValid()), "center_of_mass_mm": com, "bbox_mm": bbox(obj.BoundBox) if not obj.isNull() else None, "objects": (names or [])[:200]})
`

const PY_MEASURE = `
kind, obj, names = load(ARGS["input"])
rows = []
if kind == "mesh":
    for i, comp in enumerate(obj.getSeparateComponents()[:200]):
        rows.append({"index": i + 1, "facets": comp.CountFacets, "volume_mm3": comp.Volume, "area_mm2": comp.Area, "bbox_mm": bbox(comp.BoundBox)})
else:
    for i, s in enumerate(obj.Solids[:200]):
        p = s.CenterOfMass
        rows.append({"index": i + 1, "volume_mm3": s.Volume, "area_mm2": s.Area, "center_of_mass_mm": [p.x, p.y, p.z], "bbox_mm": bbox(s.BoundBox)})
RESULT.update({"kind": kind, "bodies": rows, "total": len(obj.Solids) if kind == "shape" else len(rows)})
`

const PY_CONVERT = `
kind, obj, names = load(ARGS["input"])
out = ARGS["output"]
if os.path.exists(out):
    raise Exception("the output file already exists; SahilBot never overwrites it")
low = out.lower()
tol = float(ARGS.get("tolerance_mm") or 0.1)
if low.endswith((".stl", ".obj")):
    if kind == "mesh":
        obj.write(out)
    else:
        import MeshPart
        m = MeshPart.meshFromShape(Shape=obj, LinearDeflection=tol, AngularDeflection=0.5, Relative=False)
        m.write(out)
else:
    import Part
    if kind == "mesh":
        sh = Part.Shape()
        sh.makeShapeFromMesh(obj.Topology, tol)
        try:
            sh = Part.makeSolid(Part.Shell(sh.Faces))
        except Exception:
            pass
        obj = sh
    if low.endswith((".step", ".stp")):
        obj.exportStep(out)
    elif low.endswith((".iges", ".igs")):
        obj.exportIges(out)
    elif low.endswith(".brep"):
        obj.exportBrep(out)
    else:
        raise Exception("unsupported output type")
RESULT.update({"output": out, "bytes": os.path.getsize(out) if os.path.exists(out) else 0})
`

/** The Python that FreeCAD runs for one operation. `args` reaches it as JSON only. */
export function freecadScript(op: FreecadOp, args: { input: string; output?: string; tolerance_mm?: number }, resultPath: string): string {
  const body = op === 'inspect' ? PY_INSPECT : op === 'measure' ? PY_MEASURE : PY_CONVERT
  // json.dumps of the JSON text gives a valid Python string literal (both are double-quoted with the same escapes).
  return [
    `ARGS_JSON = ${JSON.stringify(JSON.stringify(args))}`,
    `RESULT_PATH = ${JSON.stringify(resultPath)}`,
    PY_LOAD,
    'try:',
    ...body.trim().split('\n').map((l) => `    ${l}`),
    'except Exception as e:',
    '    RESULT = {"ok": False, "error": str(e)[:2000], "trace": traceback.format_exc()[-2000:]}',
    'with open(RESULT_PATH, "w") as f:',
    '    json.dump(RESULT, f)',
    'sys.stdout.flush()',
    'os._exit(0)',
    ''
  ].join('\n')
}

export interface FreecadRun { ok: boolean; result?: Record<string, any>; error?: string; ms: number }

/** A free name for a converted file: "<name>.<ext>", then "<name>-2.<ext>"… (a conversion never overwrites). */
export function uniqueOutput(p: string, exists: (p: string) => boolean = existsSync): string {
  if (!exists(p)) return p
  const ext = extname(p)
  const stem = join(dirname(p), basename(p, ext))
  for (let i = 2; i < 1000; i++) { const q = `${stem}-${i}${ext}`; if (!exists(q)) return q }
  return `${stem}-${Date.now()}${ext}`
}

/** Runs one generated script with freecadcmd in a fresh temp folder; the folder is removed afterwards. */
export async function runFreecad(bin: string, op: FreecadOp, args: { input: string; output?: string; tolerance_mm?: number }, o: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<FreecadRun> {
  // convert writes a new file next to any existing one (the script refuses to overwrite as well).
  if (op === 'convert' && args.output) args = { ...args, output: uniqueOutput(args.output) }
  const dir = mkdtempSync(join(tmpdir(), 'sahilbot-freecad-'))
  try {
    const resultPath = join(dir, 'result.json')
    const script = join(dir, `${op}.py`)
    writeFileSync(script, freecadScript(op, args, resultPath))
    const r = await runProcess(bin, [script], { cwd: dir, timeoutMs: o.timeoutMs ?? 120_000, signal: o.signal, env: toolEnv({ HOME: process.env.HOME ?? homedir() }), maxChars: 50_000 })
    if (r.timedOut) return { ok: false, error: `FreeCAD took longer than ${Math.round((o.timeoutMs ?? 120_000) / 1000)} s (a very large or complex file?).`, ms: r.ms }
    if (r.stopped) return { ok: false, error: 'Stopped.', ms: r.ms }
    if (!existsSync(resultPath)) return { ok: false, error: `FreeCAD exited (code ${r.code}) without a result.${r.output.trim() ? ` Output: ${r.output.trim().slice(-800)}` : ''}`, ms: r.ms }
    const res = JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, any>
    if (res.ok === false) return { ok: false, error: String(res.error ?? 'FreeCAD failed'), ms: r.ms }
    if (op === 'convert' && args.output) res.output = args.output
    return { ok: true, result: res, ms: r.ms }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
