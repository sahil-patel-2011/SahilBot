import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { runFreecadScript, wrapScript, type FreecadRun } from './freecad'
import { evalExpr, UNIT_MM, variableValues, type CadPlan, type Len, type PlanFeature } from './plan'
import { withAxisSketches } from './onshape-features'

// Builds a feature plan with FreeCAD's command-line build (freecadcmd), using its Part workbench (OpenCASCADE
// solids: makeBox, extrude, revolve, makeFillet, makeChamfer, makeThickness, boolean fuse/cut/common, mirror).
// The plan reaches Python as JSON with every dimension already evaluated to mm (no plan text becomes code).
// The script saves an .FCStd (with a Parameters spreadsheet of the plan's variables) plus STEP and STL, and
// returns the measurements and the model's edges as 3D polylines, which wire-png.ts draws as pictures
// (freecadcmd has no GUI to take screenshots).

export type FcOp = Record<string, unknown> & { op: string; id: string }

/** The plan as plain JSON for the script: numbers in mm (angles in degrees), plane frames by name. */
export function compileForFreecad(plan: CadPlan): { ops: FcOp[]; params: Array<{ name: string; value: number; unit: string }>; problems: string[] } {
  const unit = UNIT_MM[plan.units ?? 'mm']
  const problems: string[] = []
  let vars: Record<string, number> = {}
  try { vars = variableValues(plan) } catch (e) { problems.push(`A variable ${(e as Error).message}.`) }
  const mm = (v: Len | undefined, what: string): number => {
    if (v === undefined) return NaN
    try { return Number(evalExpr(v, vars, unit).toFixed(6)) } catch (e) { problems.push(`${what} ${(e as Error).message}.`); return NaN }
  }
  const deg = (v: string | undefined): number => (v === undefined ? 360 : Number(evalExpr(v, vars, 1, true).toFixed(6)))
  const pt = (x: number | undefined): number => (x ?? 0) * unit
  const ops: FcOp[] = []
  const shapes = (list: Extract<PlanFeature, { op: 'sketch' }>['shapes']): unknown[] => list.map((s, i) => {
    const id = s.id || `${s.kind}${i + 1}`
    if (s.kind === 'rect') { const x0 = s.centered === false ? pt(s.x) : pt(s.x) - (s.w * unit) / 2; const y0 = s.centered === false ? pt(s.y) : pt(s.y) - (s.h * unit) / 2; return { kind: 'poly', id, construction: !!s.construction, points: [[x0, y0], [x0 + s.w * unit, y0], [x0 + s.w * unit, y0 + s.h * unit], [x0, y0 + s.h * unit]] } }
    if (s.kind === 'circle') return { kind: 'circle', id, construction: !!s.construction, x: pt(s.x), y: pt(s.y), r: s.r * unit }
    if (s.kind === 'line') return { kind: 'line', id, construction: !!s.construction, p1: [pt(s.x1), pt(s.y1)], p2: [pt(s.x2), pt(s.y2)] }
    return { kind: 'poly', id, construction: !!s.construction, points: s.points.map(([x, y]) => [x * unit, y * unit]) }
  })
  for (const f of withAxisSketches(plan)) {
    const at = `${f.id}:`
    switch (f.op) {
      case 'cube': ops.push({ op: 'cube', id: f.id, side: mm(f.side, `${at} side`) }); break
      case 'sketch': ops.push({ op: 'sketch', id: f.id, frame: f.on ? { of: f.on.of, cap: f.on.cap ?? 'end' } : f.plane ?? 'Top', shapes: shapes(f.shapes) }); break
      case 'extrude': ops.push({ op: 'extrude', id: f.id, sketch: f.sketch, depth: f.through ? null : mm(f.depth, `${at} depth`), operation: f.operation ?? 'new', opposite: !!f.opposite }); break
      case 'revolve': ops.push({ op: 'revolve', id: f.id, sketch: f.sketch, axis: f.axis, angle: deg(f.angle), operation: f.operation ?? 'new' }); break
      case 'fillet': ops.push({ op: 'fillet', id: f.id, of: f.edges?.of ?? null, cap: f.edges?.cap ?? null, radius: mm(f.radius, `${at} radius`) }); break
      case 'chamfer': ops.push({ op: 'chamfer', id: f.id, of: f.edges?.of ?? null, cap: f.edges?.cap ?? null, width: mm(f.width, `${at} width`) }); break
      case 'shell': ops.push({ op: 'shell', id: f.id, of: f.faces.of, cap: f.faces.cap ?? 'end', thickness: mm(f.thickness, `${at} thickness`) }); break
      case 'hole': ops.push({ op: 'hole', id: f.id, frame: typeof f.on === 'string' ? f.on : { of: f.on.of, cap: f.on.cap ?? 'end' }, onFace: typeof f.on !== 'string', at: f.at.map(([x, y]) => [x * unit, y * unit]), diameter: mm(f.diameter, `${at} diameter`), depth: f.depth === undefined ? null : mm(f.depth, `${at} depth`) }); break
      case 'linear_pattern': ops.push({ op: 'linear_pattern', id: f.id, of: f.of, direction: f.direction, distance: mm(f.distance, `${at} distance`), count: f.count, opposite: !!f.opposite }); break
      case 'circular_pattern': ops.push({ op: 'circular_pattern', id: f.id, of: f.of, axis: f.axis, count: f.count, angle: deg(f.angle) }); break
      case 'mirror': ops.push({ op: 'mirror', id: f.id, of: f.of, plane: f.plane }); break
      case 'raw': problems.push(`${at} raw Onshape feature JSON can't be built in FreeCAD; describe it with the other ops.`); break
    }
  }
  const params = (plan.variables ?? []).map((v) => ({ name: v.name, value: Number((vars[v.name] ?? NaN).toFixed(6)), unit: (v.type ?? 'LENGTH') === 'LENGTH' ? 'mm' : v.type === 'ANGLE' ? 'deg' : '' }))
  for (const o of ops) for (const [k, v] of Object.entries(o)) if (typeof v === 'number' && !Number.isFinite(v)) problems.push(`${o.id}: ${k} isn't a number.`)
  return { ops, params, problems }
}

/** The interpreter FreeCAD runs: one op at a time over named solid bodies. */
export const PY_BUILD_HEADER = `
import json, os, sys, math, traceback
import FreeCAD
ARGS = json.loads(ARGS_JSON)
RESULT = {"ok": True}
`

export const PY_BUILD = `
import Part
from FreeCAD import Vector
bodies = {}
order = []
made = {}
sketches = {}
caps = {}
lines = {}
TOL = 1e-6

def frame_of(spec):
    if isinstance(spec, str):
        if spec == "Front":
            return (Vector(0, 0, 0), Vector(1, 0, 0), Vector(0, 0, 1), Vector(0, -1, 0))
        if spec == "Right":
            return (Vector(0, 0, 0), Vector(0, 1, 0), Vector(0, 0, 1), Vector(1, 0, 0))
        return (Vector(0, 0, 0), Vector(1, 0, 0), Vector(0, 1, 0), Vector(0, 0, 1))
    face = cap_faces(spec["of"], spec.get("cap") or "end")[0]
    u0, u1, v0, v1 = face.ParameterRange
    n = face.normalAt((u0 + u1) / 2, (v0 + v1) / 2)
    n.normalize()
    o = n * n.dot(face.CenterOfMass)
    ref = Vector(1, 0, 0) if abs(n.x) < 0.9 else Vector(0, 1, 0)
    x = ref - n * ref.dot(n)
    x.normalize()
    y = n.cross(x)
    return (o, x, y, n)

def at(fr, p):
    return fr[0] + fr[1] * p[0] + fr[2] * p[1]

def body_ids(fid):
    return [b for b in made.get(fid, []) if b in bodies]

def all_shapes():
    return [bodies[b] for b in order if b in bodies]

def cap_faces(fid, which):
    if fid in caps:
        return caps[fid][which]
    raise Exception("feature %s has no %s cap (caps come from extrudes)" % (fid, which))

def on_faces(shape, faces):
    out = []
    for f in shape.Faces:
        for c in faces:
            if f.distToShape(c)[0] < TOL and abs(f.Area - c.Area) <= max(1e-6, 1e-3 * c.Area) and f.CenterOfMass.distanceToPoint(c.CenterOfMass) < 1e-4:
                out.append(f)
                break
    return out

def edges_for(op):
    if not op.get("of"):
        return [(b, bodies[b].Edges) for b in order if b in bodies]
    if op.get("cap"):
        faces = cap_faces(op["of"], op["cap"])
        res = []
        for b in order:
            if b not in bodies:
                continue
            sel = [e for e in bodies[b].Edges if any(e.distToShape(c)[0] < TOL for c in faces)]
            if sel:
                res.append((b, sel))
        return res
    return [(b, bodies[b].Edges) for b in body_ids(op["of"])]

def big():
    shapes = all_shapes()
    if not shapes:
        return 1000.0
    return Part.makeCompound(shapes).BoundBox.DiagonalLength * 2 + 10

def apply(fid, tool, operation):
    touched = []
    if operation == "new" or not order:
        bodies[fid] = tool.removeSplitter() if hasattr(tool, "removeSplitter") else tool
        order.append(fid)
        made[fid] = [fid]
        return
    for b in list(order):
        if b not in bodies:
            continue
        s = bodies[b]
        hit = s.common(tool).Volume > 1e-9 or (operation == "add" and s.distToShape(tool)[0] < TOL)
        if not hit:
            continue
        if operation == "add":
            s = s.fuse(tool)
        elif operation == "remove":
            s = s.cut(tool)
        else:
            s = s.common(tool)
        bodies[b] = s.removeSplitter()
        touched.append(b)
    if operation == "add" and not touched:
        bodies[fid] = tool
        order.append(fid)
        touched = [fid]
    made[fid] = touched

def region(sk):
    faces = [Part.Face(w) for w in sk["wires"]]
    faces.sort(key=lambda f: -f.Area)
    out = []
    for f in faces:
        placed = False
        for i, r in enumerate(out):
            if r.common(f).Area > 0.999 * f.Area:
                out[i] = r.cut(f)
                placed = True
                break
        if not placed:
            out.append(f)
    return out

for op in ARGS["ops"]:
    k = op["op"]
    fid = op["id"]
    if k == "cube":
        apply(fid, Part.makeBox(op["side"], op["side"], op["side"]), "new")
    elif k == "sketch":
        fr = frame_of(op["frame"])
        wires = []
        for s in op["shapes"]:
            if s["kind"] == "line":
                p1, p2 = at(fr, s["p1"]), at(fr, s["p2"])
                lines[s["id"]] = (p1, p2)
                continue
            if s.get("construction"):
                continue
            if s["kind"] == "circle":
                wires.append(Part.Wire(Part.makeCircle(s["r"], at(fr, [s["x"], s["y"]]), fr[3])))
            else:
                pts = [at(fr, p) for p in s["points"]]
                wires.append(Part.makePolygon(pts + [pts[0]]))
        sketches[fid] = {"frame": fr, "wires": wires}
    elif k == "extrude" or k == "hole":
        if k == "hole":
            fr = frame_of(op["frame"])
            n = fr[3] * (-1 if op["onFace"] else 1)
            depth = op["depth"] if op["depth"] is not None else big()
            tool = None
            for p in op["at"]:
                c = Part.makeCylinder(op["diameter"] / 2, depth, at(fr, p), n)
                tool = c if tool is None else tool.fuse(c)
            apply(fid, tool, "remove")
            continue
        sk = sketches[op["sketch"]]
        n = sk["frame"][3] * (-1 if op["opposite"] else 1)
        depth = op["depth"] if op["depth"] is not None else big()
        faces = region(sk)
        if not faces:
            raise Exception("sketch %s has no closed shapes to extrude" % op["sketch"])
        tool = None
        for f in faces:
            s = f.extrude(n * depth)
            tool = s if tool is None else tool.fuse(s)
        caps[fid] = {"start": faces, "end": [f.translated(n * depth) for f in faces]}
        apply(fid, tool, op["operation"])
    elif k == "revolve":
        sk = sketches[op["sketch"]]
        if op["axis"] not in lines:
            raise Exception("revolve %s: no line %s in sketch %s" % (fid, op["axis"], op["sketch"]))
        p1, p2 = lines[op["axis"]]
        tool = None
        for f in region(sk):
            s = f.revolve(p1, p2 - p1, op["angle"])
            tool = s if tool is None else tool.fuse(s)
        apply(fid, tool, op["operation"])
    elif k == "fillet" or k == "chamfer":
        groups = edges_for(op)
        if not groups:
            raise Exception("%s %s: no edges selected" % (k, fid))
        for b, edges in groups:
            bodies[b] = bodies[b].makeFillet(op["radius"], edges) if k == "fillet" else bodies[b].makeChamfer(op["width"], edges)
        made[fid] = [b for b, _ in groups]
    elif k == "shell":
        faces = cap_faces(op["of"], op["cap"])
        done = []
        for b in order:
            if b not in bodies:
                continue
            sel = on_faces(bodies[b], faces)
            if sel:
                bodies[b] = bodies[b].makeThickness(sel, -op["thickness"], 1e-3)
                done.append(b)
        if not done:
            raise Exception("shell %s: the %s face of %s isn't on any body" % (fid, op["cap"], op["of"]))
        made[fid] = done
    elif k in ("linear_pattern", "circular_pattern", "mirror"):
        src = []
        for o in op["of"]:
            src += body_ids(o)
        if not src:
            raise Exception("%s %s: nothing to copy" % (k, fid))
        new = []
        for b in src:
            s = bodies[b]
            copies = []
            if k == "linear_pattern":
                p1, p2 = lines["axis_" + op["direction"]]
                d = p2 - p1
                d.normalize()
                d = d * (-1 if op["opposite"] else 1)
                for i in range(1, op["count"]):
                    copies.append(s.translated(d * op["distance"] * i))
            elif k == "circular_pattern":
                if isinstance(op["axis"], str):
                    p1, p2 = lines["axis_" + op["axis"]]
                else:
                    p1, p2 = lines[op["axis"]["line"]]
                full = abs(op["angle"] - 360) < 1e-9
                step = op["angle"] / (op["count"] if full else op["count"] - 1)
                for i in range(1, op["count"]):
                    c = s.copy()
                    c.rotate(p1, p2 - p1, step * i)
                    copies.append(c)
            else:
                normal = {"Top": Vector(0, 0, 1), "Front": Vector(0, 1, 0), "Right": Vector(1, 0, 0)}[op["plane"]]
                copies.append(s.mirror(Vector(0, 0, 0), normal))
            for i, c in enumerate(copies):
                nid = "%s_%s_%d" % (fid, b, i + 1)
                bodies[nid] = c
                order.append(nid)
                new.append(nid)
        made[fid] = new
    else:
        raise Exception("unknown op " + k)

shapes = all_shapes()
if not shapes:
    raise Exception("the plan made no solid")
comp = Part.makeCompound(shapes)
out = ARGS["out"]
doc = FreeCAD.newDocument("Model")
objs = []
for i, b in enumerate(order):
    if b in bodies:
        o = doc.addObject("Part::Feature", ("Body_%d" % (i + 1)))
        o.Label = b
        o.Shape = bodies[b]
        objs.append(o)
if ARGS["params"]:
    try:
        sheet = doc.addObject("Spreadsheet::Sheet", "Parameters")
        for i, p in enumerate(ARGS["params"]):
            sheet.set("A%d" % (i + 1), p["name"])
            sheet.set("B%d" % (i + 1), ("%s %s" % (p["value"], p["unit"])).strip())
    except Exception:
        pass
doc.recompute()
doc.saveAs(out["fcstd"])
comp.exportStep(out["step"])
import MeshPart
MeshPart.meshFromShape(Shape=comp, LinearDeflection=0.05, AngularDeflection=0.3, Relative=False).write(out["stl"])
b = comp.BoundBox
clash = 0
gap = None
for i in range(len(shapes)):
    for j in range(i + 1, len(shapes)):
        if shapes[i].common(shapes[j]).Volume > 1e-6:
            clash += 1
        d = shapes[i].distToShape(shapes[j])[0]
        gap = d if gap is None or d < gap else gap
polys = []
budget = 20000
for s in shapes:
    for e in s.Edges:
        if budget <= 0:
            break
        n = 24 if e.Curve.__class__.__name__ != "Line" else 2
        pts = e.discretize(n)
        budget -= len(pts)
        polys.append([[round(p.x, 3), round(p.y, 3), round(p.z, 3)] for p in pts])
RESULT.update({
    "bbox_mm": [b.XLength, b.YLength, b.ZLength], "box": [b.XMin, b.YMin, b.ZMin, b.XMax, b.YMax, b.ZMax],
    "volume_mm3": sum(s.Volume for s in shapes), "area_mm2": comp.Area, "solids": len(comp.Solids), "bodies": len(shapes),
    "valid": all(s.isValid() for s in shapes), "interferences": clash, "min_gap_mm": gap, "polylines": polys,
    "files": out
})
`

export interface FreecadBuild { ok: boolean; error?: string; result?: Record<string, any>; files?: { fcstd: string; step: string; stl: string }; ms: number }

/** Runs the plan in FreeCAD; the files go to a new folder under the workspace's exports/freecad. */
export async function buildFreecad(bin: string, plan: CadPlan, o: { workspace: string; signal?: AbortSignal; timeoutMs?: number; run?: typeof runFreecadScript }): Promise<FreecadBuild> {
  const c = compileForFreecad(plan)
  if (c.problems.length) return { ok: false, error: c.problems.join(' '), ms: 0 }
  const safe = plan.name.replace(/[/\\:*?"<>|\u0000-\u001f]+/g, '-').trim().slice(0, 60) || 'model'
  const dir = join(o.workspace, 'exports', 'freecad', `${safe} ${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`)
  mkdirSync(dir, { recursive: true })
  const files = { fcstd: join(dir, `${safe}.FCStd`), step: join(dir, `${safe}.step`), stl: join(dir, `${safe}.stl`) }
  const r: FreecadRun = await (o.run ?? runFreecadScript)(bin, (resultPath) => wrapScript(PY_BUILD_HEADER, PY_BUILD, { ops: c.ops, params: c.params, out: files }, resultPath), { timeoutMs: o.timeoutMs ?? 180_000, signal: o.signal, name: 'build' })
  return { ok: r.ok, error: r.error, result: r.result, files: r.ok ? files : undefined, ms: r.ms }
}
