// What a request says about CAD, read from its words (no model call). The intent tool group (agent/intent.ts)
// loads the CAD tools up front with CAD_RE; the chat-or-agent and effort classifiers can use cadSignals() so
// "go build this inside of CAD" runs as agent work at a high effort (an extra-high one for whole assemblies).

/** Words that only come up when the request is about CAD: the tools, file types, features and parts. */
// Ambiguous words are left out on purpose ("shell" scripts, code "brackets", "housing" prices, a drug's
// "mechanism"): they appear here only in phrases that are clearly mechanical.
export const CAD_RE = /\b(cad|onshape|freecad|solidworks|fusion ?360|part ?studios?|feature ?script|3d[- ](model|print|printed|printing|printable|part)s?|stl|step file|stp file|iges|brep|fcstd|sketch (plane|constraints?)|extru(de|ded|sion|sions)|revolve[ds]?|fillets?|chamfer(s|ed)?|shell feature|draft angle|lofts?|mate connectors?|(fastened|revolute|slider) mates?|assembl(y|ies) in cad|enclosures?|(mounting|angle|l-|metal|motor|shelf|wall) brackets?|bracket for|gears?|gearbox(es)?|pulleys?|sprockets?|bushings?|standoffs?|hinges?|press[- ]fit|clearance fit|interference fit|fits and tolerances|tolerance stack|counterbored?|countersunk|countersink|tapped holes?|sheet metal|cnc|laser[- ]cut|machined part|linkage)\b|\.(step|stp|stl|fcstd)\b/i

/** A request to make or change geometry (not just a question about CAD). */
const MAKE_RE = /\b(build|make|model|design|create|draw|sketch|extrude|cad up|cad it|prototype|generate|mock ?up|lay ?out|print|export|modify|change|resize|add|cut)\b/i
/** "in CAD", "inside of CAD", "in Onshape", "as a 3D model": the user names the place to build it. */
const IN_CAD_RE = /\b(in(side)?( of)?|into|with|using|on) (cad|onshape|freecad|a part ?studio)\b|\b(as|into) (a )?(3d model|cad model|step|stl|part)\b|\b(3d[- ]model|cad model)\b/i
/** A whole assembly or mechanism (several parts that fit and move together), not a single part. */
const ASSEMBLY_RE = /\b(assembl(y|ies)|sub-?assembl(y|ies)|mechanism|linkage|gearbox|drivetrain|intake|elevator|arm|robot|several parts|multi-?part|mates?|hinged?|moving parts|whole (robot|machine|thing))\b/i
const ASKS_RE = /^(what|which|why|how|when|who|where|is|are|does|do|did|should|would|explain|describe|define)\b/i
const POLITE_RE = /\b(can you|could you|would you|please|for me|i need you to|help me)\b/i

export interface CadSignals {
  /** The request is about CAD at all (load the CAD tools). */
  cad: boolean
  /** It asks to build or change a model: the full agent with the design workflow (cad_design). */
  build: boolean
  /** A whole assembly or mechanism rather than one part. */
  assembly: boolean
  /** The thinking level to start at: high for a part, xhigh for a whole assembly. */
  effort: 'high' | 'xhigh' | undefined
}

export function cadSignals(text: string): CadSignals {
  const t = (text ?? '').trim()
  const named = IN_CAD_RE.test(t)
  const cad = named || CAD_RE.test(t)
  const question = ASKS_RE.test(t) && !POLITE_RE.test(t)
  const build = cad && MAKE_RE.test(t) && (!question || named)
  const assembly = build && ASSEMBLY_RE.test(t)
  return { cad, build, assembly, effort: build ? (assembly ? 'xhigh' : 'high') : undefined }
}

/** Shorthand: a request to build or change something in CAD (runs as agent work). */
export const isCadBuildRequest = (text: string): boolean => cadSignals(text).build
