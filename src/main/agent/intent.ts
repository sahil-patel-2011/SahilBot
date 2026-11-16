import { CAD_RE } from '../cad/cad-intent'
import { VIDEO_RE } from './video-intent'
import { classifyTask as classifyRequest, type TaskCategory as RouteCategory, type TaskClass as RouteClass } from '../llm/task-classifier'

/**
 * Which on-demand tools a request needs, read from the request itself. Heavy tools (computer use, code,
 * pages…) aren't sent with every request: that keeps the prompt small and fast on local models. A
 * request that clearly needs them gets them loaded before the first step; anything else is one
 * find_tools call away, and a tool a chat has used stays loaded for that chat.
 */


export { VIDEO_RE }

const GROUPS: Array<{ tools: string[]; when: RegExp }> = [
  {
    tools: ['code', 'git', 'jobs'],
    when: /\b(code|coding|bug|bugs|debug|tests?|unit test|repo|repository|git|commit|branch|pull request|\bPR\b|merge|function|class|compile|build|lint|typecheck|npm|pnpm|yarn|pip|python|typescript|javascript|java|kotlin|swift|rust|golang|c\+\+|refactor|stack ?trace|exception|deploy|dev server|localhost|api endpoint|wpilib|gradle|robot code)\b/i
  },
  {
    tools: ['computer', 'app', 'app_help'],
    when: /\b(click|double[- ]click|screen|screenshot|desktop|mouse|cursor on|type (it )?in(to)?|on my mac|open (the )?app|finder|safari|chrome|numbers|keynote|pages app|excel|word doc|powerpoint|slack|imessage|messages app|spotify|apple music|xcode|vs ?code|system settings|preview app|menu bar|window)\b/i
  },
  {
    tools: ['create_page', 'update_page'],
    when: /\b(dashboard|chart|graph|plot|visuali[sz]e|interactive|calculator|planner|tracker|timeline|comparison table|infographic|web page|landing page|slide-?style)\b/i
  },
  {
    tools: ['doc_create', 'doc_read', 'doc_edit', 'doc_export'],
    when: /\b(docs?|document|draft|write( up)?|rewrite|edit|paragraph|section|heading|report|memo|letter|essay|notes|outline|proposal|resume|cv|spreadsheet|sheet|rows?|columns?|checklist|agenda|minutes|brief|article|blog post|cover letter)\b/i
  },
  {
    tools: ['research'],
    when: /\b(stud(y|ies)|pubmed|clinical( trial)?s?|paper|papers|arxiv|doi|journal|peer[- ]reviewed|drug|dosage|fda|side effects?|medical|diagnos|symptom|research)\b/i
  },
  {
    tools: ['mail'],
    when: /\b(e-?mails?|inbox|gmail|mail app|apple mail|unread|reply to|draft (a|an|the)? ?(reply|email)|newsletter|unsubscribe)\b/i
  },
  // CAD (src/main/cad/cad-intent.ts owns the words): the design workflow, Onshape, and FreeCAD when installed.
  { tools: ['cad_design', 'onshape', 'freecad'], when: CAD_RE },
  // Videos through the user's HeyGen connectors (tools/video.ts): avatar videos, dubbing, motion graphics.
  { tools: ['video'], when: VIDEO_RE }
]

/** Tools to load for a request (only names that exist in `known`). */
export function intentTools(text: string, known: Set<string>, extra: { codeProject?: boolean } = {}): string[] {
  const out = new Set<string>()
  for (const g of GROUPS) if (g.when.test(text)) for (const t of g.tools) out.add(t)
  // A chat about a code project (a project folder with a repo or package file) gets the coding tools.
  if (extra.codeProject) for (const t of GROUPS[0].tools) out.add(t)
  return [...out].filter((t) => known.has(t))
}

/**
 * Every on-demand tool a request might load, except the screen and app tools, plus read_result (the call an
 * offloaded result points to): what a Claude chat on a big window loads up front (loop.ts), so the cached
 * tool list stays the same for the whole chat. Only names that exist in `known`.
 */
export function likelyTools(known: Set<string>): string[] {
  // The CAD tools stay on demand too (big schemas most chats never use).
  // So do the video tools (credits, and most chats never make a video).
  const out = GROUPS.filter((g) => !g.tools.includes('computer') && !g.tools.includes('cad_design') && !g.tools.includes('video')).flatMap((g) => g.tools)
  return ['read_result', ...out].filter((t) => known.has(t))
}

// ---------------------------------------------------------------------------------------------------
// Chat or agent: does this request need the full agent (plan, work tools, self-check), or is it a chat
// (conversation, a question, advice, a short piece of writing) that answers right away with a lean prompt?
// A chat can still search the web, read a page, use memory and connected apps, and call find_tools, which
// turns it into agent work from the next step on (loop.ts). Instant and local: no model call.
// This is the same decision as the router's (llm/task-classifier.ts classifyTask: category, difficulty, kind
// and effort come out of one function), so "coding" never runs as a chat and a chat is never routed as agent
// work. loop.ts passes the routed decision in (`route`); called alone, it decides the same way.
// ---------------------------------------------------------------------------------------------------

export type TaskKind = 'chat' | 'agent'

export interface TaskContext {
  /** The user message's flags: Plan first, Team of Experts, Deep Research, Heavy, Council. */
  flags?: Record<string, unknown>
  /** Attached files that aren't images (read with file tools), and attached folders. */
  files?: number
  folders?: number
  /** The chat has an unfinished plan (a task in progress). */
  openPlan?: boolean
  /** How the previous request in this chat ran (a follow-up like "yes, do it" keeps it). */
  previous?: TaskKind
  /** The previous request's category (follow-ups keep it), when known. */
  previousCategory?: RouteCategory
  /** A helper agent, a routine, a goal wake-up or a group chat: always the full agent. */
  helper?: boolean
  unattended?: boolean
  group?: boolean
  /** The chat's folder is a code project; the bot's role (instructions). */
  codeProject?: boolean
  role?: string
  /** The decision the router already made for this request (loop.ts chooseModel): its kind is used as is. */
  route?: Pick<RouteClass, 'kind' | 'kindWhy'>
}

export interface TaskClass {
  kind: TaskKind
  why: string
}

/**
 * Chat or agent for one request. Agent when a mode toggle is on, files or folders are attached, a plan is in
 * progress, it runs as a helper, a routine or in a group, or the request is agent work (code, the screen, the
 * user's files, mail and calendar, documents, CAD, deep research). Everything else (conversation, questions,
 * advice, explanations, short writing, live facts) is a chat. Follow-ups keep the previous request's kind.
 */
export function classifyTask(text: string, ctx: TaskContext = {}): TaskClass {
  const f = ctx.flags ?? {}
  if (ctx.helper || ctx.unattended || ctx.group) return { kind: 'agent', why: ctx.helper ? 'helper agent' : ctx.unattended ? 'runs unattended' : 'group chat' }
  if (f.planFirst || f.team || f.deepResearch || f.heavy || f.council) return { kind: 'agent', why: f.planFirst ? 'Plan first is on' : f.team ? 'Team of Experts is on' : f.deepResearch ? 'Deep Research is on' : f.heavy ? 'Heavy is on' : 'Council is on' }
  if (ctx.folders) return { kind: 'agent', why: 'works with an attached folder' }
  if (ctx.files) return { kind: 'agent', why: 'reads attached files' }
  if (ctx.openPlan) return { kind: 'agent', why: 'a task is in progress' }
  if (!text.trim()) return { kind: ctx.previous ?? 'chat', why: 'no text' }
  if (ctx.route) return { kind: ctx.route.kind, why: ctx.route.kindWhy }
  const d = classifyRequest(text, {
    previousKind: ctx.previous,
    // Only the kind of the last request is known here: a follow-up keeps it (the category stands in for it).
    previousCategory: ctx.previousCategory ?? (ctx.previous === 'agent' ? 'agent-tools' : ctx.previous === 'chat' ? 'chat' : undefined),
    codeProject: ctx.codeProject, role: ctx.role
  })
  return { kind: d.kind, why: d.kindWhy }
}
